"""Observed Root approvals; a separate seal command records an explicit review.

No installer, business write, provider call or automatic approval is exposed.
The CLI always uses Native; tests may inject a synthetic adapter in process.
"""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import signal
import stat
import subprocess
import sys
import tempfile
import time

import api_web_deployment as native
import copy_runtime_deployment as runtime
from ci_release import ReleaseError, digest, extract_release, require, verify_migrations, verify_package
from ci_provider_evidence import installation_id, release_identity, installation_enabled

BASE = Path('/opt/commerce-os')
PRIVATE = BASE/'private'
TOOLS = ('b02-backup-root.py', 'b02_backup_contract.py', 'b02-portal-capsule.mjs')
READERS = ('copy-runtime-approvals.py', 'copy_runtime_approvals.py', 'ci_release.py',
           'copy_runtime_deployment.py', 'api_web_deployment.py', 'deploy-ci-vps.py',
           'deployment_scope.py', 'mcl_portal_release.py', 'update-identity-proxy.py', 'ci_provider_evidence.py')
MAX_AGE = 1800
MAX_COMMAND_BYTES = 8*1024*1024
MAX_FILE = 1024*1024


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def private_directory(path, *, create=False, uid=0):
    path = Path(path)
    require(path.is_absolute(), 'ROOT_REVIEW_ABSOLUTE_PATH_REQUIRED')
    # Check ancestors before the first write, including when a missing leaf is
    # reached through a symlink. Root ownership makes the remaining mkdir/lstat
    # window inaccessible to unprivileged writers.
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in {0, uid}
                and not info.st_mode & 0o022, 'ROOT_REVIEW_DIRECTORY_CUSTODY')
    if create:
        try: path.mkdir(mode=0o700)
        except FileExistsError: pass
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid in {0, uid}
            and not info.st_mode & 0o022, 'ROOT_REVIEW_DIRECTORY_CUSTODY')
    require(stat.S_IMODE(path.stat().st_mode) == 0o700, 'ROOT_REVIEW_DIRECTORY_MODE')
    return path


def read_private(path, *, uid=0, mode=0o600):
    """Root600, bounded FD read, then FD and pathname identity (TOCTOU)."""
    path = Path(path)
    require(path.is_absolute(), 'ROOT_REVIEW_ABSOLUTE_PATH_REQUIRED')
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in {0, uid}
                and not info.st_mode & 0o022, 'ROOT_REVIEW_DIRECTORY_CUSTODY')
    before = path.lstat()
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as source:
        opened = os.fstat(source.fileno())
        require(stat.S_ISREG(opened.st_mode) and opened.st_uid == uid and opened.st_nlink == 1
                and (not opened.st_mode & 0o022 if mode is None else stat.S_IMODE(opened.st_mode) == mode),
                'ROOT_REVIEW_FILE_CUSTODY')
        require(identity(before) == identity(opened), 'ROOT_REVIEW_PATH_CHANGED')
        raw = source.read(MAX_FILE+1)
        require(0 < len(raw) <= MAX_FILE, 'ROOT_REVIEW_FILE_BOUND')
        require(identity(opened) == identity(os.fstat(source.fileno()))
                and identity(opened) == identity(path.lstat()), 'ROOT_REVIEW_PATH_CHANGED')
    return raw


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def immutable(path, raw):
    path = Path(path)
    private_directory(path.parent)
    try: fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        require(read_private(path) == raw, 'ROOT_REVIEW_IMMUTABLE_CONFLICT')
        return native.reference(path, raw)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    fsync_directory(path.parent)
    require(read_private(path) == raw, 'ROOT_REVIEW_WRITE_READBACK_FAILED')
    return native.reference(path, raw)


def pointer_bytes(path):
    try: return read_private(path)
    except FileNotFoundError: return None


def stage_archive(source, destination, expected_hash, *, uid=0):
    """Copy a stable Root-owned archive before the extractor's separate opens."""
    source, destination = Path(source), Path(destination)
    private_directory(source.parent, uid=uid)
    private_directory(destination.parent, uid=uid)
    before = source.lstat()
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as incoming:
        opened = os.fstat(incoming.fileno())
        require(stat.S_ISREG(opened.st_mode) and opened.st_uid == uid and opened.st_nlink == 1
                and stat.S_IMODE(opened.st_mode) == 0o600 and 0 < opened.st_size <= 3*1024**3,
                'ROOT_REVIEW_ARCHIVE_CUSTODY')
        require(identity(before) == identity(opened), 'ROOT_REVIEW_ARCHIVE_CHANGED')
        outgoing_fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        sha = hashlib.sha256(); count = 0
        with os.fdopen(outgoing_fd, 'wb') as outgoing:
            while chunk := incoming.read(1024*1024):
                count += len(chunk)
                require(count <= opened.st_size, 'ROOT_REVIEW_ARCHIVE_CHANGED')
                sha.update(chunk); outgoing.write(chunk)
            outgoing.flush(); os.fsync(outgoing.fileno())
        require(count == opened.st_size and identity(opened) == identity(os.fstat(incoming.fileno()))
                and identity(opened) == identity(source.lstat()), 'ROOT_REVIEW_ARCHIVE_CHANGED')
        require(sha.hexdigest() == expected_hash, 'ARCHIVE_HASH_MISMATCH')
    fsync_directory(destination.parent)
    require(digest(destination) == expected_hash, 'ROOT_REVIEW_ARCHIVE_READBACK_FAILED')
    return destination


def replace_pointer(path, expected, raw):
    """CAS under the same four file locks used by every canonical publisher."""
    path = Path(path)
    require(pointer_bytes(path) == expected, 'ROOT_REVIEW_POINTER_CAS_CONFLICT')
    before = None if expected is None else identity(path.lstat())
    descriptor, temporary = tempfile.mkstemp(prefix='.runtime-review-', dir=path.parent)
    temporary = Path(temporary)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        require(pointer_bytes(path) == expected and
                (None if expected is None else identity(path.lstat())) == before,
                'ROOT_REVIEW_POINTER_CAS_CONFLICT')
        os.replace(temporary, path); fsync_directory(path.parent)
        require(read_private(path) == raw, 'ROOT_REVIEW_POINTER_READBACK_FAILED')
    finally:
        if temporary.exists(): temporary.unlink()


def bounded_command(args, cwd, input_text=None):
    """Bound stdout and time; exceptions reap only this read's process group."""
    payload = None if input_text is None else input_text.encode()
    require(payload is None or len(payload) <= 65536, 'ROOT_REVIEW_COMMAND_INPUT_BOUND')
    child = subprocess.Popen(args, cwd=cwd, stdin=subprocess.DEVNULL if payload is None else subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    expires = time.monotonic()+60
    raw = bytearray(); offset = 0; writing = payload is not None
    try:
        os.set_blocking(child.stdout.fileno(), False)
        if writing: os.set_blocking(child.stdin.fileno(), False)
        while True:
            remaining = expires-time.monotonic()
            require(remaining > 0, 'ROOT_REVIEW_COMMAND_TIMEOUT')
            readable, writable, _ = select.select([child.stdout], [child.stdin] if writing else [], [], remaining)
            require(readable or writable, 'ROOT_REVIEW_COMMAND_TIMEOUT')
            if writable:
                offset += os.write(child.stdin.fileno(), payload[offset:offset+4096])
                if offset == len(payload): child.stdin.close(); writing = False
            if readable:
                chunk = os.read(child.stdout.fileno(), 65536)
                if not chunk: break
                raw.extend(chunk)
                require(len(raw) <= MAX_COMMAND_BYTES, 'ROOT_REVIEW_COMMAND_OUTPUT_BOUND')
        require(not writing, 'ROOT_REVIEW_COMMAND_INPUT_NOT_CONSUMED')
        require(child.wait(timeout=max(.01, expires-time.monotonic())) == 0, 'ROOT_REVIEW_COMMAND_FAILED')
        return raw.decode().strip()
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=5)
        child.stdout.close()
        if child.stdin is not None and not child.stdin.closed: child.stdin.close()


def review_identity(source_sha, archive_hash, run_id, review_id):
    require(runtime._hash(source_sha, 40) and runtime._hash(archive_hash), 'ROOT_REVIEW_PACKAGE_IDENTITY')
    require(installation_id(run_id) and (run_id.startswith(('cb-','cv-'))
            or re.fullmatch(r'[1-9][0-9]*-[1-9][0-9]*', run_id)), 'ROOT_REVIEW_RUN_ID')
    require(type(review_id) is str and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', review_id), 'ROOT_REVIEW_ID')


def package_metadata(package, source_sha, run_id):
    verify_package(package)
    value = runtime._parse((package/'RELEASE.json').read_bytes())
    try:
        context = release_identity(value, source_sha, run_id, 'copy-runtime')
    except ReleaseError:
        raise ReleaseError('ROOT_REVIEW_RELEASE_IDENTITY') from None
    installation_enabled(context)
    require(value.get('schema_version') in (1,2) and value.get('platform') == 'linux/amd64'
            and type(value.get('migration_hashes')) is dict
            and len(value['migration_hashes']) in {67, 68, runtime.V7_PROFILE_MIGRATION_TOTAL}
            and runtime.MIGRATION_NAMES <= set(value['migration_hashes']), 'ROOT_REVIEW_RELEASE_IDENTITY')
    runtime.reviewed_migration_names(value)
    actual = {p.name: digest(p) for p in (package/'packages/db/migrations').glob('*.sql')}
    require(actual == value['migration_hashes'], 'ROOT_REVIEW_MIGRATION_BYTES_CHANGED')
    images = runtime._parse((package/'images.json').read_bytes())
    require(type(images) is dict and set(images) == {'commerce-os:release', 'commerce-os-web:release',
            'commerce-os-maintenance:release', 'mi-ciclo-listo-portal:release'}
            and all(type(item) is dict and item.get('source_sha') == source_sha for item in images.values()),
            'ROOT_REVIEW_IMAGE_PROVENANCE')
    return value


class Native:
    def __init__(self):
        require(os.geteuid() == 0 and sys.platform == 'linux', 'ROOT_REVIEW_LINUX_ROOT_REQUIRED')
        self.base = BASE; self.private = PRIVATE
        spec = importlib.util.spec_from_file_location('copy_review_server', Path(__file__).with_name('deploy-ci-vps.py'))
        self.server = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.server)
        self.server.command = bounded_command

    @contextlib.contextmanager
    def locked(self):
        locks = native.acquire_locks(self.private)
        try: yield
        finally:
            for lock in reversed(locks): lock.close()

    def package_readers(self, package):
        for name in READERS:
            actual = Path(__file__).with_name(name)
            require(read_private(actual, mode=None) == read_private(package/'scripts'/name),
                    'ROOT_REVIEW_LOADED_READER_MISMATCH')

    def observe_native(self, package, metadata, candidate_root):
        require(not candidate_root.exists() and not candidate_root.is_symlink(), 'ROOT_REVIEW_CANDIDATE_EXISTS')
        current = (self.base/'current').resolve(strict=True)
        # The future report must not exist; no in-flight attempt is excluded from the scan.
        report_dir = self.private/'deployments'/candidate_root.name.split('-', 1)[1].rsplit('-', 1)[0]
        require(not report_dir.exists(), 'ROOT_REVIEW_ATTEMPT_ALREADY_STARTED')
        before = runtime.snapshot(self.server, self.private, current, report_dir)
        initial = before['state']['schema_version'] == 2
        prior_stage = before['state'].get('runtime_stage')
        require(initial or prior_stage in {'CORE_PREPARED', 'OPERATING'}, 'ROOT_REVIEW_STAGE_UNSUPPORTED')
        stage = 'CORE_PREPARED' if initial else 'OPERATING'
        applied = self.server.migrations(current)
        runtime.migration_stage_guard(applied, metadata, initial=initial, stage=prior_stage)
        if initial:
            native.database_guard(self.server.database, current)
        elif prior_stage == 'CORE_PREPARED':
            runtime.continuation_identity(current, package, before['release'], metadata['source_sha'], self.server)
            runtime.first_start_guard(self.server, current)
            runtime.in_flight_guard(self.server, current)
        else:
            runtime.installed_migration_identity(current, before['release'], applied)
        edge = runtime.edge_preflight(self.server.command, current)
        require(edge['container_ids'] == set(before['state']['preserved_runtime']), 'ROOT_REVIEW_EDGE_INVENTORY_DRIFT')
        edge_ref = None
        if initial:
            runtime.edge_no_overlap(runtime.edge_definition(metadata['source_sha']), edge)
        elif prior_stage == 'CORE_PREPARED':
            prior = runtime.reviewed_migrations(self.private, current, metadata['source_sha'], metadata)
            edge_ref = prior['consumer_edge_approval_ref']
            # snapshot() has authenticated the receipt, original approval and actual bridge.
            require(edge_ref == runtime._parse(native.read_reference(before['state']['consumer_edge_ref']))['approval_ref'],
                    'ROOT_REVIEW_CONTINUATION_EDGE_CHANGED')
        else:
            # snapshot authenticated the installed edge and its original approval.
            # A newly sealed candidate pointer must not replace that provenance.
            edge_ref = runtime._parse(native.read_reference(before['state']['consumer_edge_ref']))['approval_ref']
            native.read_reference(edge_ref)
        return {'runtime_stage': stage, 'current_release': str(current),
                'adoption_sha256': runtime.sha256(before['state_raw']),
                'plan_sha256': runtime.sha256(before['plan_raw']), 'edge': edge['hashes'],
                'profile_sha256': {name: runtime.sha256(raw) for name, raw in before['files'].items()},
                'policy': before['policy'], 'owner': before['owner'], 'migrations': applied,
                'service_count': len(before['services']), 'consumer_edge_approval_ref': edge_ref}

    def compare_native(self, before, after):
        self.server.compare_owner_auth(before['owner'], after['owner'])
        require({key: value for key, value in before.items() if key != 'owner'} ==
                {key: value for key, value in after.items() if key != 'owner'}, 'ROOT_REVIEW_NATIVE_CAS_CHANGED')


def encoded(value):
    return runtime.sealed_bytes(value)+b'\n'


def summary(observation, reference, status):
    facts = observation['native']
    return {'status': status, 'source_sha': observation['source_sha'],
            'archive_sha256': observation['archive_sha256'], 'run_id': observation['run_id'],
            'candidate_root': observation['candidate_root'], 'runtime_stage': facts['runtime_stage'],
            'review_id': observation['review_id'], 'observation_sha256': reference['sha256'],
            'migration_count': len(facts['migrations']), 'services_observed': facts['service_count'],
            'before_adoption_sha256': facts['adoption_sha256'], 'before_plan_sha256': facts['plan_sha256'],
            'edge_preflight': facts['edge'], 'installer_executed': False, 'business_mutations': 0,
            'backup_executed': False, 'source_isolation_issued': False}


def observe(adapter, archive, archive_hash, source_sha, run_id, review_id):
    review_identity(source_sha, archive_hash, run_id, review_id)
    base = private_directory(adapter.private/'copy-runtime-reviews', create=True)
    directory = base/review_id
    require(not directory.exists() and not directory.is_symlink(), 'ROOT_REVIEW_ALREADY_EXISTS')
    private_directory(directory, create=True)
    package = directory/'package'
    # Preserve exact archive bytes in Root custody before the extractor's opens.
    staged_archive = stage_archive(archive, directory/'archive.tar', archive_hash)
    extract_release(staged_archive, package, archive_hash)
    metadata = package_metadata(package, source_sha, run_id)
    adapter.package_readers(package)
    candidate_root = adapter.base/'releases'/('ci-'+run_id+'-'+source_sha[:12])
    with adapter.locked():
        facts = adapter.observe_native(package, metadata, candidate_root)
        previous = pointer_bytes(adapter.private/'copy-runtime-migrations.json')
        require(facts['runtime_stage'] != 'CORE_PREPARED' or previous is None,
                'ROOT_REVIEW_EXISTING_INITIAL_APPROVAL_REQUIRES_RECONCILIATION')
        second = adapter.observe_native(package, metadata, candidate_root)
        adapter.compare_native(facts, second)
        require(pointer_bytes(adapter.private/'copy-runtime-migrations.json') == previous, 'ROOT_REVIEW_POINTER_CAS_CONFLICT')
        observation = {'schema_version': 1, 'source_sha': source_sha, 'archive_sha256': archive_hash,
                       'run_id': run_id, 'review_id': review_id, 'candidate_root': str(candidate_root),
                       'created_at_epoch': int(time.time()), 'package_manifest_sha256': digest(package/'PACKAGE.sha256'),
                       'previous_migrations': None if previous is None else
                       native.reference(adapter.private/'copy-runtime-migrations.json', previous), 'native': second}
        raw = encoded(observation)
        ref = immutable(directory/'observation.json', raw)
    return summary(observation, ref, 'OBSERVED_REVIEW_REQUIRED')


def seal(adapter, review_id, observation_sha):
    require(type(review_id) is str and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', review_id)
            and runtime._hash(observation_sha), 'ROOT_REVIEW_SEAL_IDENTITY')
    directory = private_directory(adapter.private/'copy-runtime-reviews'/review_id)
    raw = read_private(directory/'observation.json')
    require(runtime.sha256(raw) == observation_sha, 'ROOT_REVIEW_OBSERVATION_HASH_CHANGED')
    observation = runtime._parse(raw)
    require(type(observation) is dict and set(observation) == {'schema_version', 'source_sha', 'archive_sha256',
            'run_id', 'review_id', 'candidate_root', 'created_at_epoch', 'package_manifest_sha256',
            'previous_migrations', 'native'} and observation['schema_version'] == 1
            and observation['review_id'] == review_id, 'ROOT_REVIEW_OBSERVATION_SHAPE')
    review_identity(observation['source_sha'], observation['archive_sha256'], observation['run_id'], review_id)
    candidate = adapter.base/'releases'/('ci-'+observation['run_id']+'-'+observation['source_sha'][:12])
    require(observation['candidate_root'] == str(candidate), 'ROOT_REVIEW_CANDIDATE_PATH_CHANGED')
    package = directory/'package'
    require(digest(directory/'archive.tar') == observation['archive_sha256'], 'ROOT_REVIEW_ARCHIVE_CHANGED')
    metadata = package_metadata(package, observation['source_sha'], observation['run_id'])
    require(digest(package/'PACKAGE.sha256') == observation['package_manifest_sha256'], 'ROOT_REVIEW_PACKAGE_CHANGED')
    adapter.package_readers(package)
    ref = native.reference(directory/'observation.json', raw)
    with adapter.locked():
        receipt = directory/'seal.json'
        if receipt.exists() or receipt.is_symlink():
            saved = runtime._parse(read_private(receipt))
            require(saved.get('observation_ref') == ref, 'ROOT_REVIEW_RECEIPT_CHANGED')
            for item in saved['approval_refs']: native.read_reference(item)
            require(native.read_reference(saved['migrations_ref']) == encoded(saved['migrations']),
                    'ROOT_REVIEW_SEALED_POINTER_CHANGED')
            return summary(observation, ref, 'SEALED_REPLAY_HISTORICAL')
        require(type(observation['created_at_epoch']) is int
                and 0 <= time.time()-observation['created_at_epoch'] <= MAX_AGE, 'ROOT_REVIEW_OBSERVATION_EXPIRED')
        current = adapter.observe_native(package, metadata, candidate)
        adapter.compare_native(observation['native'], current)
        old = observation['previous_migrations']
        previous = pointer_bytes(adapter.private/'copy-runtime-migrations.json')
        pointer_ref = None if previous is None else native.reference(adapter.private/'copy-runtime-migrations.json', previous)
        pending = directory/'seal-intent.json'
        intent = None if not (pending.exists() or pending.is_symlink()) else runtime._parse(read_private(pending))
        pointer_applied = pointer_ref != old
        if pointer_applied:
            # A lost final receipt is recoverable only from a prior durable intent
            # for this exact review and these already active bytes. No inference
            # from a matching SHA, stage or generic success marker is accepted.
            require(type(intent) is dict and intent.get('status') == 'APPROVED_PENDING_POINTER_CAS'
                    and intent.get('observation_ref') == ref and intent.get('previous_migrations_ref') == old
                    and intent.get('migrations_ref') == pointer_ref and previous == encoded(intent.get('migrations')),
                    'ROOT_REVIEW_POINTER_CAS_CONFLICT')
        approvals = private_directory(adapter.private/'controller-approvals', create=True)
        facts = observation['native']; approval_refs = []
        if facts['runtime_stage'] == 'CORE_PREPARED':
            edge = {'schema_version': 1, 'source_sha': observation['source_sha'],
                    'before_adoption_sha256': facts['adoption_sha256'], 'before_plan_sha256': facts['plan_sha256'],
                    'definition': runtime.edge_definition(observation['source_sha']), 'preflight': facts['edge']}
            edge_ref = immutable(approvals/('copy-runtime-'+review_id+'-edge.json'), encoded(edge))
        else:
            edge_ref = facts['consumer_edge_approval_ref']; native.read_reference(edge_ref)
        approval_refs.append(edge_ref)
        tool_refs = {}
        for name in TOOLS:
            contents = (package/'scripts'/name).read_bytes()
            require(0 < len(contents) <= MAX_FILE, 'ROOT_REVIEW_TOOL_BOUND')
            tool_refs[name] = native.reference(candidate/'scripts'/name, contents)
        manifest = {'schema_version': 1, 'source_sha': observation['source_sha'],
                    'before_adoption_sha256': facts['adoption_sha256'], 'before_plan_sha256': facts['plan_sha256'],
                    'runtime_stage': facts['runtime_stage'], 'tools': tool_refs}
        tool_ref = immutable(approvals/('copy-runtime-'+review_id+'-tools.json'), encoded(manifest))
        approval_refs.append(tool_ref)
        migrations = {'schema_version': 1, 'source_sha': observation['source_sha'],
                      'migration_hashes': {name: metadata['migration_hashes'][name]
                                           for name in sorted(runtime.reviewed_migration_names(metadata))},
                      'consumer_edge_network': runtime.EDGE_NAME, 'consumer_edge_approval_ref': edge_ref,
                      'backup_tools_manifest_ref': tool_ref}
        migrations_raw = encoded(migrations)
        migrations_ref = native.reference(adapter.private/'copy-runtime-migrations.json', migrations_raw)
        expected_intent = {'schema_version': 1, 'status': 'APPROVED_PENDING_POINTER_CAS',
                           'observation_ref': ref, 'previous_migrations_ref': old,
                           'approval_refs': approval_refs, 'migrations_ref': migrations_ref, 'migrations': migrations}
        # Durable before the sole activating write. An existing partial intent is
        # compared byte-for-byte, never amended around changed evidence.
        immutable(pending, encoded(expected_intent))
        adapter.compare_native(current, adapter.observe_native(package, metadata, candidate))
        require(read_private(directory/'observation.json') == raw, 'ROOT_REVIEW_OBSERVATION_CHANGED')
        # Rehash after native reads, before activating the pointer. No auto-approval
        # is inferred from these hashes: the caller selected observation_sha.
        package_metadata(package, observation['source_sha'], observation['run_id'])
        require(digest(package/'PACKAGE.sha256') == observation['package_manifest_sha256'], 'ROOT_REVIEW_PACKAGE_CHANGED')
        adapter.package_readers(package)
        if pointer_applied:
            require(pointer_bytes(adapter.private/'copy-runtime-migrations.json') == migrations_raw,
                    'ROOT_REVIEW_POINTER_CAS_CONFLICT')
        else:
            replace_pointer(adapter.private/'copy-runtime-migrations.json', previous, migrations_raw)
        immutable(receipt, encoded({'schema_version': 1, 'status': 'SEALED', 'observation_ref': ref,
                  'approval_refs': approval_refs, 'migrations': migrations,
                  'migrations_ref': migrations_ref}))
    return summary(observation, ref, 'SEALED')
