#!/usr/bin/env python3
"""Root-only B02 controller installed separately from the application release.

No effects without an explicit action and the exact sealed private plan digest.
Canonical scripts and key remain on the VM; only ciphertext/public receipts export.
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import hmac
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import urllib.parse
import uuid
from b02_backup_contract import (BACKUP_TIMEOUT, DAILY, MAX_BYTES, ORIGINAL_MINIMUM, ORIGINAL_MINIMUM_UID, PRIVATE, SOURCE_FILES,
    TERMINAL, VM_ID, check_run_budget, hash_identity, need, projection_digest, reference,
    run_identity, backup_run_identity, gcp_run_identity, canonical, utc_time, gcp_binding, gcp_job_guard, gcp_scheduler_guard, gcp_execution_guard, gcp_task_name, GCP_JOB, GCP_SCHEDULER, GCP_EXECUTOR, GCP_BINDING_FIELDS, TARGET, sha256, unique_json, validate_custody, plan_version, PORTAL_HELPER,
    PORTAL_BASE, PORTAL_FIELDS, PORTAL_MAX_BYTES, PDF_NAMES, export_names, ciphertext_header, validate_portal_backup)


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def identity(info):
    return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_uid', 'st_mode', 'st_nlink'))


def protected_parents(path, uid=0):
    need(path.is_absolute(), 'BACKUP_ABSOLUTE_PATH_REQUIRED')
    for parent in path.parents:
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, uid)
             and not stat.S_IMODE(info.st_mode) & 0o022, 'BACKUP_PARENT_CUSTODY_INVALID')


def read_file(path, *, uid=0, private=True, limit=1048576):
    path = Path(path); protected_parents(path, uid)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source:
        before = os.fstat(source.fileno())
        need(stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1
             and (stat.S_IMODE(before.st_mode) == 0o600 if private else not stat.S_IMODE(before.st_mode) & 0o022)
             and 0 < before.st_size <= limit, 'BACKUP_FILE_CUSTODY_INVALID')
        value = source.read(limit + 1)
        need(len(value) == before.st_size and identity(before) == identity(os.fstat(source.fileno()))
             == identity(path.lstat()), 'BACKUP_FILE_CHANGED')
    return value


def ref_read(ref, *, private=True, uid=0):
    reference(ref); value = read_file(ref['path'], private=private, uid=uid)
    need((len(value), sha256(value)) == (ref['bytes'], ref['sha256']), 'BACKUP_SEALED_REFERENCE_DRIFT')
    return value


def original_minimum_read(ref):
    reference(ref)
    need(ref['path'] == str(ORIGINAL_MINIMUM) and ref['bytes'] == 87, 'BACKUP_ORIGINAL_MINIMUM_SCOPE_INVALID')
    return ref_read(ref, uid=ORIGINAL_MINIMUM_UID)


def source_storage(plan):
    promotion = unique_json(ref_read(plan['promotion_ref']))
    applied_ref = reference(plan['applied_plan_ref'])
    need(promotion['admin_plan'] == applied_ref, 'BACKUP_APPLIED_PLAN_BINDING_INVALID')
    applied = unique_json(ref_read(applied_ref))
    foundation_ref = reference(plan['foundation_ref'])
    need(applied['foundation_receipt'] == {key: foundation_ref[key] for key in ('path', 'sha256')}
         and applied['source_sha'] == plan['source_sha'] and applied['maintenance_image'] == plan['maintenance_image'],
         'BACKUP_APPLIED_FOUNDATION_BINDING_INVALID')
    need(promotion['storage'] == applied['planned_private_storage_dir'] == plan['storage_path'],
         'BACKUP_SOURCE_STORAGE_BINDING_INVALID')
    return Path(plan['storage_path'])


def storage_custody(storage):
    need(storage.is_absolute() and storage.is_relative_to(PRIVATE) and storage.resolve() == storage,
         'BACKUP_STORAGE_SCOPE_INVALID')
    protected_parents(storage / 'assets' / 'unused', uid=1000)
    for directory in (storage, storage / 'assets'):
        info = directory.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == 1000 and stat.S_IMODE(info.st_mode) == 0o700,
             'BACKUP_STORAGE_DIRECTORY_CUSTODY_INVALID')


def write_private(path, value, *, replace=False):
    path = Path(path); temporary = path.with_name('.' + path.name + '-' + uuid.uuid4().hex) if replace else path
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as output:
        output.write(value); output.flush(); os.fsync(output.fileno())
    if replace:
        os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def json_write(path, value, *, replace=False):
    write_private(path, (json.dumps(value, sort_keys=True) + '\n').encode(), replace=replace)


def file_reference(path, *, uid=0, ciphertext=False, header=b'COMOSB02'):
    import hashlib
    path = Path(path); protected_parents(path, uid)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source:
        info = os.fstat(source.fileno())
        need(stat.S_ISREG(info.st_mode) and info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o600
             and info.st_nlink == 1 and 0 < info.st_size <= MAX_BYTES, 'BACKUP_EXPORT_CUSTODY_INVALID')
        if ciphertext:
            need(info.st_size > 36 and source.read(8) == header, 'BACKUP_CIPHERTEXT_HEADER_INVALID')
            source.seek(0)
        digest = hashlib.sha256()
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
        need(identity(info) == identity(os.fstat(source.fileno())) == identity(path.lstat()), 'BACKUP_EXPORT_CHANGED')
    return {'path': str(path), 'bytes': info.st_size, 'sha256': digest.hexdigest()}


def parse_env(raw):
    need(len(raw) <= 16384 and b'\r' not in raw, 'BACKUP_PRIVATE_ENV_INVALID')
    result = {}
    for line in raw.decode('ascii').splitlines():
        if not line or line.startswith('#'):
            continue
        found = re.fullmatch(r'([A-Z][A-Z0-9_]*)=([ -~]*)', line)
        need(found is not None and found[1] not in result, 'BACKUP_PRIVATE_ENV_INVALID')
        result[found[1]] = found[2]
    return result


def original_key(raw):
    value = parse_env(raw).get('BACKUP_ENCRYPTION_KEY', '')
    need(re.fullmatch(r'[a-fA-F0-9]{64}', value), 'BACKUP_ORIGINAL_KEY_REQUIRED')
    return bytes.fromhex(value)


@contextlib.contextmanager
def lock(path):
    with os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), 'a+') as target:
        info = os.fstat(target.fileno())
        need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600
             and info.st_nlink == 1, 'BACKUP_LOCK_CUSTODY_INVALID')
        try:
            fcntl.flock(target, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('BACKUP_LOCK_BUSY') from None
        yield


def bounded(args, log_path, *, input=None, timeout=BACKUP_TIMEOUT):
    need(timeout > 0, 'BACKUP_GLOBAL_DEADLINE_EXCEEDED')
    with os.fdopen(os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w') as log:
        child = subprocess.Popen(args, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
            stdout=log, stderr=log, start_new_session=True)
        try:
            if input is not None:
                child.communicate(input=input, timeout=timeout)
                return child.returncode
            return child.wait(timeout=timeout)
        finally:
            # Docker's daemon task is reconciled separately, after this local PGID.
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=5)
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


# Imported into the Root controller; this fragment is public and carries no credentials.
LOCK_NAMES = ('daily-b02-controller.lock', 'ci-deploy.lock', 'backup-schedule.lock', 'maintenance-backup.lock')
CONTROLLER_NAMES = ('b02-backup-root.py', 'b02_backup_contract.py', PORTAL_HELPER)


@contextlib.contextmanager
def controller_update_locks(held_locks=None):
    if held_locks is None:
        with contextlib.ExitStack() as stack:
            for name in LOCK_NAMES:
                stack.enter_context(lock(PRIVATE / name))
            yield
        return
    need(isinstance(held_locks, dict) and set(held_locks) == set(LOCK_NAMES), 'BACKUP_TOOL_LOCKS_REQUIRED')
    for name in LOCK_NAMES:
        stream = held_locks[name]
        info = os.fstat(stream.fileno()); path = PRIVATE / name
        need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600
             and info.st_nlink == 1 and identity(info) == identity(path.lstat()), 'BACKUP_TOOL_LOCK_CUSTODY_INVALID')
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('BACKUP_TOOL_LOCK_NOT_HELD') from None
    # Do not close, unlock, or replace locks owned by the caller.
    yield


def prepare_reviewed_controllers(manifest_ref, candidate_root, expected_sha, before_plan_sha,
                                 before_adoption_sha, candidate_adoption, runtime_rows, held_locks=None):
    """Install only explicitly sealed tools; caller journals and CAS-publishes returned pair.

    held_locks is {exact LOCK_NAMES: open locked file object}. The caller keeps those
    four descriptors through its journal and atomic pair CAS. No current plan/adoption
    is written here. An interrupted install leaves the old plan rejecting new tools.
    """
    need(os.geteuid() == 0 and sys.platform == 'linux', 'BACKUP_LINUX_ROOT_REQUIRED')
    need(isinstance(expected_sha, str) and re.fullmatch(r'[a-f0-9]{40}', expected_sha), 'BACKUP_TOOL_CANDIDATE_SHA_INVALID')
    hash_identity(before_plan_sha); hash_identity(before_adoption_sha); reference(manifest_ref)
    candidate_root = Path(candidate_root)
    need(candidate_root.parent == PRIVATE.parent / 'releases' and candidate_root.resolve() == candidate_root,
         'BACKUP_TOOL_CANDIDATE_SCOPE_INVALID')
    with controller_update_locks(held_locks):
        old_plan_raw = read_file(DAILY / 'plan.json'); old_adoption_raw = read_file(PRIVATE / 'api-web-adoption.json')
        need(sha256(old_plan_raw) == before_plan_sha and sha256(old_adoption_raw) == before_adoption_sha,
             'BACKUP_TOOL_CAS_CONFLICT')
        old = unique_json(old_plan_raw); adoption_before = unique_json(old_adoption_raw); plan_version(old)
        need(unique_json(read_file(candidate_root / 'RELEASE.json', private=False)).get('source_sha') == expected_sha,
             'BACKUP_TOOL_RELEASE_DRIFT')
        approved_raw = ref_read(manifest_ref); approved = unique_json(approved_raw)
        need(isinstance(approved, dict) and set(approved) == {'schema_version', 'source_sha', 'before_plan_sha256',
             'before_adoption_sha256', 'runtime_stage', 'tools'} and approved['schema_version'] == 1
             and approved['source_sha'] == expected_sha and approved['before_plan_sha256'] == before_plan_sha
             and approved['before_adoption_sha256'] == before_adoption_sha
             and approved['runtime_stage'] in (None, 'CORE_PREPARED', 'OPERATING')
             and isinstance(approved['tools'], dict) and set(approved['tools']) == set(CONTROLLER_NAMES),
             'BACKUP_TOOL_APPROVAL_MANIFEST_INVALID')
        need(Path(manifest_ref['path']).parent == PRIVATE / 'controller-approvals', 'BACKUP_TOOL_APPROVAL_SCOPE_INVALID')
        incoming = {}
        for name in CONTROLLER_NAMES:
            ref = reference(approved['tools'][name])
            need(ref['path'] == str(candidate_root / 'scripts' / name), 'BACKUP_TOOL_APPROVAL_SOURCE_SCOPE_INVALID')
            incoming[name] = ref_read(ref, private=False)
        need(isinstance(candidate_adoption, dict) and candidate_adoption.get('portal') is not None,
             'BACKUP_TOOL_CANDIDATE_ADOPTION_INVALID')
        portal = dict(candidate_adoption['portal'], state_path=str(PORTAL_BASE / 'state'), state_uid=1000)
        validate_portal_backup(portal)
        stage = approved['runtime_stage']; version = 2 if stage is None else 3
        need(candidate_adoption.get('schema_version') == version
             and (stage is None or candidate_adoption.get('runtime_stage') == stage)
             and isinstance(runtime_rows, dict), 'BACKUP_TOOL_RUNTIME_STAGE_INVALID')
        expected = {cid: projection_digest(row, 2 if version == 3 else 1) for cid, row in runtime_rows.items()}
        need(all(cid == row.get('Id') and re.fullmatch(r'[a-f0-9]{64}', cid) for cid, row in runtime_rows.items())
             and candidate_adoption.get('preserved_runtime') == expected and old['postgres']['container_id'] in expected
             and portal['container_id'] in expected,
             'BACKUP_TOOL_RUNTIME_PROJECTION_INVALID')
        result_plan = dict(old, schema_version=version, controller_sources={name: approved['tools'][name]['sha256'] for name in CONTROLLER_NAMES},
                           portal_backup=portal, preserved_runtime=expected)
        if version == 3:
            result_plan.update(runtime_projection_version=2, runtime_stage=stage)
        else:
            result_plan.pop('runtime_projection_version', None); result_plan.pop('runtime_stage', None)
        plan_version(result_plan)
        # Immutable source/key/storage identities are read before and after installation.
        custody_refs = [old[name] for name in ('foundation_ref', 'promotion_ref', 'applied_plan_ref', 'admin_env_ref', 'restore_env_ref')]
        custody_refs += list(old['canonical_sources'].values())
        before_custody = [sha256(ref_read(ref, private=(ref not in old['canonical_sources'].values()))) for ref in custody_refs]
        before_key = sha256(original_minimum_read(old['original_minimum_ref']))
        storage = source_storage(old); storage_custody(storage)
        docker_config = Path(old['docker_config_path'])
        need(docker_config.is_relative_to(PRIVATE) and unique_json(read_file(docker_config)) == {}, 'BACKUP_EMPTY_DOCKER_CONFIG_REQUIRED')
        docker = ['/usr/bin/docker', '--config', str(docker_config.parent), '--host', 'unix:///var/run/docker.sock']
        def full_snapshot():
            inventory = subprocess.run(docker + ['ps', '-aq', '--no-trunc'], text=True, capture_output=True, timeout=40)
            need(inventory.returncode == 0 and set(inventory.stdout.split()) == set(runtime_rows), 'BACKUP_TOOL_RUNTIME_INVENTORY_DRIFT')
            observed = subprocess.run(docker + ['inspect', *sorted(runtime_rows)], text=True, capture_output=True, timeout=40)
            need(observed.returncode == 0 and len(observed.stdout) <= 1048576, 'BACKUP_TOOL_RUNTIME_READBACK_FAILED')
            rows = unique_json(observed.stdout)
            need(isinstance(rows, list) and len(rows) == len(runtime_rows) and {row['Id'] for row in rows} == set(runtime_rows),
                 'BACKUP_TOOL_RUNTIME_READBACK_FAILED')
            return {row['Id']: projection_digest(row) for row in rows}
        before_runtime = full_snapshot()
        need(before_runtime == {cid: projection_digest(row) for cid, row in runtime_rows.items()}, 'BACKUP_TOOL_RUNTIME_INPUT_DRIFT')
        old_tools = {name: read_file(DAILY / name, private=False) for name in old['controller_sources']}
        need(all(sha256(raw) == old['controller_sources'][name] for name, raw in old_tools.items()), 'BACKUP_TOOL_OLD_SOURCE_DRIFT')
        base = DAILY / 'controller-updates'; base.mkdir(mode=0o700, exist_ok=True); protected_parents(base / 'unused')
        info = base.lstat(); need(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'BACKUP_TOOL_HISTORY_CUSTODY_INVALID')
        history = base / (expected_sha + '-' + manifest_ref['sha256']); history.mkdir(mode=0o700)
        write_private(history / 'plan.before.json', old_plan_raw); write_private(history / 'adoption.before.json', old_adoption_raw)
        write_private(history / 'approval.json', approved_raw)
        for name, raw in old_tools.items():
            write_private(history / (name + '.before'), raw)
        journal = {'schema_version': 1, 'status': 'TOOLS_INSTALLING_PAIR_CAS_PENDING', 'candidate_source_sha': expected_sha,
                   'approval_ref': manifest_ref, 'before_plan_sha256': before_plan_sha, 'before_adoption_sha256': before_adoption_sha,
                   'runtime_full_before': before_runtime, 'installed_tools': []}
        json_write(history / 'journal.json', journal)
        for name in CONTROLLER_NAMES:
            destination = DAILY / name
            if destination.exists():
                need(name in old_tools and read_file(destination, private=False) == old_tools[name], 'BACKUP_TOOL_TARGET_DRIFT')
                write_private(destination, incoming[name], replace=True)
            else:
                need(name == PORTAL_HELPER and not destination.is_symlink(), 'BACKUP_TOOL_TARGET_SCOPE_INVALID')
                write_private(destination, incoming[name])
            need(sha256(read_file(destination, private=False)) == approved['tools'][name]['sha256'], 'BACKUP_TOOL_INSTALL_READBACK_INVALID')
            journal['installed_tools'].append(name); json_write(history / 'journal.json', journal, replace=True)
        need(read_file(DAILY / 'plan.json') == old_plan_raw and read_file(PRIVATE / 'api-web-adoption.json') == old_adoption_raw,
             'BACKUP_TOOL_CAS_CONFLICT_PRESERVE')
        after_custody = [sha256(ref_read(ref, private=(ref not in old['canonical_sources'].values()))) for ref in custody_refs]
        need(after_custody == before_custody and sha256(original_minimum_read(old['original_minimum_ref'])) == before_key,
             'BACKUP_TOOL_SOURCE_CUSTODY_CHANGED_PRESERVE')
        need(source_storage(old) == storage, 'BACKUP_TOOL_STORAGE_CHANGED_PRESERVE'); storage_custody(storage)
        need(full_snapshot() == before_runtime, 'BACKUP_TOOL_RUNTIME_CHANGED_PRESERVE')
        result_raw = (json.dumps(result_plan, sort_keys=True) + '\n').encode(); result_sha = sha256(result_raw)
        result_adoption = dict(candidate_adoption, b02_plan_sha256=result_sha)
        if 'b02_plan_ref' in candidate_adoption:
            result_adoption['b02_plan_ref'] = {'path': str(DAILY / 'plan.json'), 'bytes': len(result_raw), 'sha256': result_sha}
        adoption_raw = (json.dumps(result_adoption, sort_keys=True) + '\n').encode()
        journal.update(status='TOOLS_INSTALLED_PAIR_CAS_PENDING', plan_after_sha256=result_sha,
                       adoption_after_sha256=sha256(adoption_raw), source_custody_preserved=True)
        json_write(history / 'journal.json', journal, replace=True)
        return {'plan': result_plan, 'adoption': result_adoption, 'plan_bytes': result_raw, 'adoption_bytes': adoption_raw,
                'plan_sha256': result_sha, 'adoption_sha256': sha256(adoption_raw), 'history_path': str(history),
                'runtime_full_before': before_runtime, 'pair_written': False}


def mark_pair_applied(history_path, plan_sha256, adoption_sha256, held_locks):
    """Confirm the exact caller-published bytes after the four-lock pair CAS."""
    need(os.geteuid() == 0 and sys.platform == 'linux', 'BACKUP_LINUX_ROOT_REQUIRED')
    hash_identity(plan_sha256); hash_identity(adoption_sha256)
    history = Path(history_path)
    need(history.parent == DAILY / 'controller-updates' and history.resolve() == history,
         'BACKUP_TOOL_HISTORY_SCOPE_INVALID')
    with controller_update_locks(held_locks):
        path = history / 'journal.json'; journal_raw = read_file(path); journal = unique_json(journal_raw)
        need(journal.get('status') in ('TOOLS_INSTALLED_PAIR_CAS_PENDING', 'TOOLS_INSTALLED_PAIR_APPLIED')
             and journal.get('installed_tools') == list(CONTROLLER_NAMES)
             and journal.get('plan_after_sha256') == plan_sha256 and journal.get('adoption_after_sha256') == adoption_sha256,
             'BACKUP_TOOL_PAIR_CONFIRMATION_INVALID')
        plan_raw = read_file(DAILY / 'plan.json'); adoption_raw = read_file(PRIVATE / 'api-web-adoption.json')
        need(sha256(plan_raw) == plan_sha256 and sha256(adoption_raw) == adoption_sha256, 'BACKUP_TOOL_PAIR_NOT_APPLIED')
        plan = unique_json(plan_raw); adoption = unique_json(adoption_raw); plan_version(plan)
        approved = unique_json(ref_read(journal['approval_ref']))
        need(approved['source_sha'] == journal['candidate_source_sha']
             and plan['controller_sources'] == {name: approved['tools'][name]['sha256'] for name in CONTROLLER_NAMES}
             and adoption.get('b02_plan_sha256') == plan_sha256
             and adoption.get('preserved_runtime') == plan['preserved_runtime']
             and adoption.get('portal') == {key: plan['portal_backup'][key] for key in PORTAL_FIELDS},
             'BACKUP_TOOL_PAIR_BINDING_INVALID')
        for name in CONTROLLER_NAMES:
            need(sha256(read_file(DAILY / name, private=False)) == plan['controller_sources'][name], 'BACKUP_TOOL_PAIR_SOURCE_DRIFT')
        old = unique_json(read_file(history / 'plan.before.json'))
        mutable = {'schema_version', 'controller_sources', 'portal_backup', 'preserved_runtime', 'runtime_stage', 'runtime_projection_version'}
        need({key: value for key, value in plan.items() if key not in mutable}
             == {key: value for key, value in old.items() if key not in mutable}, 'BACKUP_TOOL_PAIR_CANONICAL_DRIFT')
        if journal['status'] == 'TOOLS_INSTALLED_PAIR_CAS_PENDING':
            need(read_file(path) == journal_raw, 'BACKUP_TOOL_HISTORY_CAS_CONFLICT')
            journal.update(status='TOOLS_INSTALLED_PAIR_APPLIED', pair_confirmed_at=utc())
            json_write(path, journal, replace=True)
        return {'status': 'TOOLS_INSTALLED_PAIR_APPLIED', 'pair_written': True, 'history_path': str(history)}


# Kept as a descriptive alias for consumers using the installation call name.
install_reviewed_controllers = prepare_reviewed_controllers


class BackupRunner:
    def __init__(self, expected_plan):
        hash_identity(expected_plan)
        raw = read_file(DAILY / 'plan.json')
        need(sha256(raw) == expected_plan, 'BACKUP_PLAN_DRIFT')
        self.plan_sha256 = expected_plan; self.plan = unique_json(raw); self.runs = DAILY / 'runs'
        p = self.plan
        self.version = plan_version(p)
        need(p.get('enabled') is True, 'BACKUP_PLAN_NOT_ENABLED')
        controller_names = ('b02-backup-root.py', 'b02_backup_contract.py') + ((PORTAL_HELPER,) if self.version >= 2 else ())
        need(set(p['controller_sources']) == set(controller_names), 'BACKUP_CONTROLLER_SOURCE_SET_INVALID')
        for name in controller_names:
            need(sha256(read_file(DAILY / name, private=False)) == p['controller_sources'][name], 'BACKUP_CONTROLLER_DRIFT')
        foundation = unique_json(ref_read(p['foundation_ref']))
        need(foundation['source_sha'] == p['source_sha'] and foundation['release_path'] == p['release_path']
             and str(foundation['vm_id']) == VM_ID
             and foundation['loaded_release_image_ids']['commerce-os-maintenance:release'] == p['maintenance_image'], 'BACKUP_FOUNDATION_DRIFT')
        need(re.fullmatch(r'[a-f0-9]{40}', p['source_sha']) and re.fullmatch(r'sha256:[a-f0-9]{64}', p['maintenance_image']), 'BACKUP_RELEASE_IDENTITY_INVALID')
        release = Path(p['release_path']); protected_parents(release / 'RELEASE.json')
        need(unique_json(read_file(release / 'RELEASE.json', private=False))['source_sha'] == p['source_sha'], 'BACKUP_RELEASE_DRIFT')
        need(set(p['canonical_sources']) == set(SOURCE_FILES), 'BACKUP_CANONICAL_SOURCES_REQUIRED')
        for name, ref in p['canonical_sources'].items():
            need(ref['path'] == str(release / 'scripts' / name), 'BACKUP_CANONICAL_SOURCE_SCOPE_INVALID')
            ref_read(ref, private=False)
        config = Path(p['docker_config_path'])
        need(config.is_relative_to(PRIVATE) and unique_json(read_file(config)) == {}, 'BACKUP_EMPTY_DOCKER_CONFIG_REQUIRED')
        self.docker = ['/usr/bin/docker', '--config', str(config.parent), '--host', 'unix:///var/run/docker.sock']
        pg = p['postgres']
        need(pg['database'] == 'commerce' and pg['user'] == 'commerce_owner'
             and re.fullmatch(r'[a-f0-9]{64}', pg['container_id']) and re.fullmatch(r'sha256:[a-f0-9]{64}', pg['image'])
             and pg['network'] == 'commerce-os_core', 'BACKUP_POSTGRES_SCOPE_INVALID')
        need(isinstance(p['preserved_runtime'], dict) and pg['container_id'] in p['preserved_runtime'], 'BACKUP_RUNTIME_BASELINE_REQUIRED')
        for cid, digest in p['preserved_runtime'].items():
            need(re.fullmatch(r'[a-f0-9]{64}', cid), 'BACKUP_CONTAINER_ID_INVALID'); hash_identity(digest)
        storage_custody(source_storage(p))
        self.runs.mkdir(mode=0o700, exist_ok=True)
        need(self.runs.lstat().st_uid == 0 and stat.S_IMODE(self.runs.lstat().st_mode) == 0o700, 'BACKUP_RUNS_CUSTODY_INVALID')

    def portal_guard(self):
        portal = self.plan['portal_backup']
        expected = {name: portal[name] for name in PORTAL_FIELDS}
        adoption = unique_json(read_file(PRIVATE / 'api-web-adoption.json'))
        need(adoption.get('schema_version') == self.plan.get('schema_version') and adoption.get('portal') == expected
             and (self.plan.get('schema_version') != 3 or adoption.get('runtime_stage') == self.plan.get('runtime_stage'))
             and adoption.get('b02_plan_sha256') == self.plan_sha256
             and adoption.get('preserved_runtime') == self.plan['preserved_runtime'], 'BACKUP_PORTAL_ADOPTION_DRIFT')
        raw = {name: ref_read(portal[name]) for name in ('report_ref', 'runtime_env_ref', 'manifest_ref')}
        report = unique_json(raw['report_ref']); manifest = unique_json(raw['manifest_ref'])
        need(report.get('status') == 'ORIGIN_READY' and report.get('run_id') == portal['run_id']
             and report.get('source_sha') == portal['source_sha'] and report.get('image') == portal['image']
             and report.get('container') == 'mcl-portal-' + portal['run_id']
             and report.get('proxy_network') == portal['proxy_network']
             and report.get('private_pdfs_verified') == 10
             and report.get('portal_manifest_sha256') == sha256(raw['manifest_ref'])
             and manifest.get('source_sha') == portal['source_sha']
             and manifest.get('origin') == 'https://ciclo.inovaris.online'
             and isinstance(manifest.get('pdfs'), dict) and set(manifest['pdfs']) == set(PDF_NAMES)
             and all(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) for value in manifest['pdfs'].values()), 'BACKUP_PORTAL_REPORT_DRIFT')
        row = self.inspect(portal['container_id'])
        need(row.get('Name') == '/mcl-portal-' + portal['run_id'] and row.get('Image') == portal['image']
             and row['State']['Running'] is True and set(row['NetworkSettings']['Networks']) == {portal['proxy_network']}
             and row['Config']['Labels'].get('com.inovaris.product') == 'mi-ciclo-listo-portal'
             and row['Config']['Labels'].get('com.inovaris.source-sha') == portal['source_sha'], 'BACKUP_PORTAL_RUNTIME_DRIFT')
        values = dict(line.split('=', 1) for line in raw['runtime_env_ref'].decode('utf-8').splitlines() if line)
        observed = dict(line.split('=', 1) for line in row['Config']['Env'])
        need(all(observed.get(key) == value for key, value in values.items()), 'BACKUP_PORTAL_ENV_DRIFT')
        mounts = [item for item in row['Mounts'] if item['Destination'] == '/data']
        need(len(mounts) == 1 and mounts[0]['Type'] == 'bind' and mounts[0]['Source'] == portal['state_path']
             and mounts[0]['RW'] is True, 'BACKUP_PORTAL_STATE_BINDING_DRIFT')
        state = Path(portal['state_path']); protected_parents(state / 'unused', uid=portal['state_uid'])
        info = state.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == portal['state_uid']
             and stat.S_IMODE(info.st_mode) == 0o700, 'BACKUP_PORTAL_STATE_CUSTODY_INVALID')
        return manifest

    def portal_preparation_token(self, root, names):
        expected_dirs = {'pdfs', 'scratch', 'output'}
        expected_files = {'control.json'} | {'pdfs/' + name for name in names}
        dirs = {}; files = {}; observed = set()
        for entry in [root, *root.rglob('*')]:
            info = entry.lstat(); relative = str(entry.relative_to(root))
            need(not entry.is_symlink() and info.st_uid == 0, 'BACKUP_PORTAL_PREPARATION_CUSTODY_INVALID')
            if stat.S_ISDIR(info.st_mode):
                need(stat.S_IMODE(info.st_mode) == 0o700 and (relative == '.' or relative in expected_dirs),
                     'BACKUP_PORTAL_PREPARATION_DIRECTORY_INVALID')
                dirs[relative] = [info.st_dev, info.st_ino, info.st_uid, info.st_mode]
            else:
                need(relative in expected_files, 'BACKUP_PORTAL_PREPARATION_FILE_INVALID')
                ref = file_reference(entry); files[relative] = dict(ref, identity=list(identity(entry.lstat())))
            if relative != '.': observed.add(relative)
        need(observed == expected_dirs | expected_files, 'BACKUP_PORTAL_PREPARATION_SET_INVALID')
        return {'root': str(root), 'directories': dirs, 'files': files}

    def cleanup_portal_preparation(self, report):
        root = self.runs / report['run_id'] / 'portal-preparation'
        if not root.exists():
            need('portal_preparation_ref' not in report, 'BACKUP_PORTAL_PREPARATION_MISSING_PRESERVE')
            return
        need('portal_preparation_ref' in report, 'BACKUP_PORTAL_PREPARATION_UNKNOWN_PRESERVE')
        ref = report['portal_preparation_ref']
        need(ref['path'] == str(root.parent / 'portal-preparation.private.json'), 'BACKUP_PORTAL_PREPARATION_SCOPE_INVALID')
        token = unique_json(ref_read(ref)); token_identity = identity(Path(ref['path']).lstat())
        need(token.get('root') == str(root), 'BACKUP_PORTAL_PREPARATION_SCOPE_INVALID')
        names = [name.removeprefix('pdfs/') for name in token['files'] if name.startswith('pdfs/')]
        observed = self.portal_preparation_token(root, names)
        need(observed == token, 'BACKUP_PORTAL_PREPARATION_CHANGED_PRESERVE')
        for name, item in token['files'].items():
            need(identity(Path(ref['path']).lstat()) == token_identity, 'BACKUP_PORTAL_PREPARATION_CHANGED_PRESERVE')
            need(list(identity((root / name).lstat())) == item['identity'], 'BACKUP_PORTAL_PREPARATION_CHANGED_PRESERVE')
            (root / name).unlink()
        for name in sorted(token['directories'], key=len, reverse=True):
            directory = root if name == '.' else root / name
            info = directory.lstat()
            need([info.st_dev, info.st_ino, info.st_uid, info.st_mode] == token['directories'][name],
                 'BACKUP_PORTAL_PREPARATION_CHANGED_PRESERVE')
            directory.rmdir()
        ref_read(ref); need(identity(Path(ref['path']).lstat()) == token_identity, 'BACKUP_PORTAL_PREPARATION_CHANGED_PRESERVE'); Path(ref['path']).unlink()
        report.pop('portal_preparation_ref'); self.save(report)

    def create_portal_capsule(self, report, minimum, deadline_at):
        portal = self.plan['portal_backup']; manifest = self.portal_guard()
        directory = self.runs / report['run_id']; root = directory / 'portal-preparation'
        root.mkdir(mode=0o700)
        for name in ('pdfs', 'scratch', 'output'):
            (root / name).mkdir(mode=0o700)
        # Immutable image readback bounds the copy before any PDF bytes are copied.
        probe = "const f=require('fs'),c=require('crypto'),d='/app/private/pdfs';console.log(JSON.stringify(Object.fromEntries(f.readdirSync(d).map(n=>{const p=d+'/'+n,s=f.lstatSync(p);if(!s.isFile()||s.nlink!==1||s.size<=0||s.size>8388608)throw Error('PDF_CUSTODY');return[n,{bytes:s.size,sha256:c.createHash('sha256').update(f.readFileSync(p)).digest('hex')}]}))))"
        rows = unique_json(self.command(['exec', portal['container_id'], 'node', '-e', probe]))
        need(set(rows) == set(manifest['pdfs']) and sum(item['bytes'] for item in rows.values()) <= 32 * 1024 ** 2
             and all(rows[name]['sha256'] == value for name, value in manifest['pdfs'].items()), 'BACKUP_PORTAL_IMAGE_PDF_DRIFT')
        self.command(['cp', portal['container_id'] + ':/app/private/pdfs/.', str(root / 'pdfs')])
        need({item.name for item in (root / 'pdfs').iterdir()} == set(manifest['pdfs']), 'BACKUP_PORTAL_COPY_SET_INVALID')
        for name, digest in manifest['pdfs'].items():
            target = root / 'pdfs' / name
            raw = read_file(target, private=False, limit=8 * 1024 ** 2)
            need(len(raw) == rows[name]['bytes'] and sha256(raw) == digest, 'BACKUP_PORTAL_COPY_DRIFT')
            target.chmod(0o600)
        remaining = deadline_at - time.monotonic()
        need(remaining > 0, 'BACKUP_GLOBAL_DEADLINE_EXCEEDED')
        control = {'schema_version': 1, 'run_id': report['run_id'], 'plan_sha256': self.plan_sha256,
            'deadline_epoch_ms': int((time.time() + min(120, remaining)) * 1000), 'custody_root': '/opt',
            'scratch_parent': str(root / 'scratch'), 'output_parent': str(root / 'output'),
            'portal': {key: portal[key] for key in ('source_sha', 'run_id', 'image', 'proxy_network',
                'report_ref', 'runtime_env_ref', 'manifest_ref')}, 'pdf_directory': str(root / 'pdfs'),
            'state_directory': portal['state_path'], 'state_uid': portal['state_uid']}
        json_write(root / 'control.json', control)
        token_path = directory / 'portal-preparation.private.json'
        json_write(token_path, self.portal_preparation_token(root, manifest['pdfs']))
        report['portal_preparation_ref'] = file_reference(token_path); self.save(report)
        helper = DAILY / PORTAL_HELPER
        need(sha256(read_file(helper, private=False)) == self.plan['controller_sources'][PORTAL_HELPER], 'BACKUP_PORTAL_HELPER_DRIFT')
        args = self.docker + ['run', '-i', '--rm', '--pull', 'never', '--name', 'commerce-b02-portal-' + report['run_id'],
            '--label', 'com.commerce-os.daily-backup=' + report['run_id'], '--network', 'none', '--read-only',
            '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH', '--security-opt', 'no-new-privileges:true', '--memory', '256m',
            '--pids-limit', '32', '--mount', 'type=bind,source=' + str(root) + ',target=' + str(root),
            '--mount', 'type=bind,source=' + str(helper) + ',target=/opt/b02-portal-capsule.mjs,readonly',
            '--mount', 'type=bind,source=' + portal['state_path'] + ',target=' + portal['state_path'] + ',readonly']
        for name in ('report_ref', 'runtime_env_ref', 'manifest_ref'):
            source = portal[name]['path']; args += ['--mount', 'type=bind,source=' + source + ',target=' + source + ',readonly']
        args += [self.plan['maintenance_image'], 'node', '--disable-warning=ExperimentalWarning', '/opt/b02-portal-capsule.mjs', 'create', str(root / 'control.json')]
        need(bounded(args, directory / 'portal-operation.log', input=minimum,
             timeout=deadline_at - time.monotonic()) == 0, 'BACKUP_PORTAL_COMMAND_FAILED')
        result = unique_json(read_file(directory / 'portal-operation.log', limit=16384))
        need(result.get('status') == 'PORTAL_CAPSULE_CREATED' and result.get('run_id') == report['run_id']
             and result.get('private_files') in (13, 14) and result.get('sqlite_snapshot_consistent') is True
             and result.get('backup_decryption_key_exported') is False and result.get('plaintext_exported') is False
             and result.get('portal_credentials_archived_encrypted') is True, 'BACKUP_PORTAL_RECEIPT_INVALID')
        artifact = root / 'output' / 'portal.backup.aes'
        ref = file_reference(artifact, ciphertext=True, header=b'COMOSP01')
        need(ref['bytes'] <= PORTAL_MAX_BYTES and result.get('ciphertext') == ref, 'BACKUP_PORTAL_CIPHERTEXT_DRIFT')
        target = directory / 'backups' / 'portal.backup.aes'
        need(not target.exists() and not target.is_symlink(), 'BACKUP_PORTAL_TARGET_EXISTS')
        os.rename(artifact, target)
        actual = file_reference(target, ciphertext=True, header=b'COMOSP01')
        need((actual['bytes'], actual['sha256']) == (ref['bytes'], ref['sha256']), 'BACKUP_PORTAL_CIPHERTEXT_DRIFT')
        self.portal_guard(); self.runtime_guard()
        report['portal_capsule'] = {key: portal[key] for key in ('source_sha', 'run_id', 'image', 'proxy_network')}
        report['portal_capsule'].update(format='COMOSP01', private_files=result['private_files'], sqlite_snapshot_consistent=True)
        self.save(report)
        return actual

    def command(self, args, *, input=None):
        timeout = min(40, self.deadline_at - time.monotonic()) if hasattr(self, 'deadline_at') else 40
        need(timeout > 0, 'BACKUP_GLOBAL_DEADLINE_EXCEEDED')
        result = subprocess.run(self.docker + args, input=input, text=True, capture_output=True, timeout=timeout)
        need(result.returncode == 0 and len(result.stdout) <= 1048576, 'BACKUP_DOCKER_COMMAND_FAILED')
        return result.stdout.strip()

    def inspect(self, cid):
        value = unique_json(self.command(['inspect', cid]))
        need(isinstance(value, list) and len(value) == 1 and value[0]['Id'] == cid, 'BACKUP_CONTAINER_READBACK_INVALID')
        return value[0]

    def runtime_guard(self):
        need(set(self.command(['ps', '-aq', '--no-trunc']).split()) == set(self.plan['preserved_runtime']), 'BACKUP_RUNTIME_INVENTORY_DRIFT')
        for cid, expected in self.plan['preserved_runtime'].items():
            need(projection_digest(self.inspect(cid), self.plan.get('runtime_projection_version', 1)) == expected, 'BACKUP_RUNTIME_PROJECTION_DRIFT')
        pg = self.inspect(self.plan['postgres']['container_id'])
        need(pg['Image'] == self.plan['postgres']['image'] and pg['State']['Running'] is True
             and self.plan['postgres']['network'] in pg['NetworkSettings']['Networks'], 'BACKUP_POSTGRES_DRIFT')

    def sql(self, run_id, query):
        pg = self.plan['postgres']
        return self.command(['exec', '-i', '--env', 'PGAPPNAME=b02-' + run_id,
            '--env', 'PGOPTIONS=-c statement_timeout=10000 -c lock_timeout=1000', pg['container_id'],
            'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', pg['user'], '-d', pg['database']], input=query)

    def report(self, run_id):
        try:
            value = unique_json(read_file(self.runs / backup_run_identity(run_id) / 'journal.json'))
            need(value.get('kind') == 'DAILY_B02' and value.get('run_id') == run_id, 'BACKUP_JOURNAL_IDENTITY_INVALID')
            return value
        except FileNotFoundError:
            raise RuntimeError('BACKUP_RUN_NOT_FOUND') from None

    def save(self, report):
        json_write(self.runs / report['run_id'] / 'journal.json', report, replace=True)

    def cleanup(self, report):
        run_id = report['run_id']; label = 'com.commerce-os.daily-backup=' + run_id
        ids = self.command(['ps', '-aq', '--no-trunc', '--filter', 'label=' + label]).split()
        for cid in ids:
            need(re.fullmatch(r'[a-f0-9]{64}', cid) and cid not in self.plan['preserved_runtime'], 'BACKUP_CLEANUP_TARGET_INVALID')
            value = self.inspect(cid)
            need(value['Name'] in ('/commerce-b02-' + run_id, '/commerce-b02-source-' + run_id, '/commerce-b02-portal-' + run_id)
                 and value['Image'] == self.plan['maintenance_image']
                 and value['Config']['Labels'].get('com.commerce-os.daily-backup') == run_id, 'BACKUP_CLEANUP_OWNERSHIP_INVALID')
        report['cleanup_observation'] = {'container_ids': ids}; self.save(report)
        if ids:
            result = subprocess.run(self.docker + ['rm', '-f', *ids], capture_output=True, timeout=40)
            # Auto-remove can race this command; only a successful empty re-read proves absence.
            need(not self.command(['ps', '-aq', '--no-trunc', '--filter', 'label=' + label]), 'BACKUP_TASK_STILL_ACTIVE')
        predicate = "application_name='b02-" + run_id + "' AND pid<>pg_backend_pid()"
        self.sql(run_id, 'SELECT count(*) FROM (SELECT pg_terminate_backend(pid) stopped FROM pg_stat_activity WHERE ' + predicate + ') task WHERE stopped;')
        need(self.sql(run_id, 'SELECT count(*) FROM pg_stat_activity WHERE ' + predicate + ';') == '0', 'BACKUP_DATABASE_TASK_STILL_ACTIVE')
        directory = self.runs / run_id
        backups = directory / 'backups'
        if backups.exists():
            for item in backups.iterdir():
                if item.name.startswith('bundle-'):
                    # The run directory was created with O_EXCL before its child.
                    for entry in (item, *item.rglob('*')):
                        info = entry.lstat()
                        need(info.st_uid == 0 and not entry.is_symlink() and (stat.S_ISDIR(info.st_mode)
                             or stat.S_ISREG(info.st_mode)) and not stat.S_IMODE(info.st_mode) & 0o077, 'BACKUP_PLAINTEXT_CUSTODY_UNKNOWN')
                    shutil.rmtree(item)
                elif item.name.endswith('.backup.aes.partial'):
                    info = item.lstat()
                    need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600
                         and info.st_nlink == 1, 'BACKUP_PARTIAL_CUSTODY_UNKNOWN')
                    item.unlink()
        env = directory / 'backup.env'
        if env.exists():
            read_file(env); env.unlink()
        self.cleanup_portal_preparation(report)
        self.runtime_guard()
        if 'operation_runtime_before' in report:
            need({cid: projection_digest(self.inspect(cid)) for cid in self.plan['preserved_runtime']} == report['operation_runtime_before'],
                 'BACKUP_OPERATION_RUNTIME_CHANGED_PRESERVE')
        report['cleanup'] = {'owned_containers_absent': True, 'owned_postgres_sessions_absent': True,
                             'owned_plaintext_removed': True, 'runtime_preserved': True, 'ciphertext_preserved': True}

    def execute(self, run_id, source_sha, scheduled=False, *, trigger=None):
        backup_run_identity(run_id)
        deadline_at = time.monotonic() + BACKUP_TIMEOUT; self.deadline_at = deadline_at
        need(re.fullmatch(r'[a-f0-9]{40}', source_sha), 'BACKUP_WORKFLOW_SOURCE_REQUIRED')
        with lock(PRIVATE / 'daily-b02-controller.lock'), lock(PRIVATE / 'ci-deploy.lock'), \
             lock(PRIVATE / 'backup-schedule.lock'), lock(PRIVATE / 'maintenance-backup.lock'):
            if run_id.startswith('gcp-'):
                gcp_start_guard(self, run_id, source_sha, scheduled, trigger)
            else:
                need(trigger is None, 'B02_LEGACY_TRIGGER_INVALID')
                need(not GCP_BINDING_PATH.exists() and not GCP_BINDING_PATH.is_symlink(), 'B02_GCP_PROVIDER_SELECTED')
            journals = [self.report(item.name) for item in self.runs.iterdir()]
            existing = next((item for item in journals if item['run_id'] == run_id), None)
            if existing:
                need(existing['source_sha'] == source_sha and existing['plan_sha256'] == self.plan_sha256, 'BACKUP_RUN_IDENTITY_CONFLICT')
                return existing
            need(all(item['status'] in TERMINAL for item in journals), 'BACKUP_PREVIOUS_TASK_REQUIRES_RECONCILIATION')
            if scheduled:
                need(self.plan.get('schedule_enabled') is True and any(item['status'] == 'SUCCEEDED' for item in journals), 'BACKUP_FIRST_CUSTODY_REQUIRED')
            check_run_budget(journals, dt.datetime.now(dt.timezone.utc)); self.runtime_guard()
            directory = self.runs / run_id; directory.mkdir(mode=0o700)
            report = {'kind': 'DAILY_B02', 'run_id': run_id, 'source_sha': source_sha, 'plan_sha256': self.plan_sha256,
                'backup_source_sha': self.plan['source_sha'], 'status': 'RUNNING', 'started_at': utc(),
                'external_copy_verified': False, 'restore_verified': False, 'automatic_retry': False}
            if trigger is not None: report['trigger'] = trigger
            if self.plan.get('schema_version') == 3:
                report['operation_runtime_before'] = {cid: projection_digest(self.inspect(cid)) for cid in self.plan['preserved_runtime']}
            json_write(directory / 'journal.json', report)
            if self.plan.get('schema_version', 1) >= 2:
                report['backup_contract_version'] = 2; self.save(report)
            try:
                admin = parse_env(ref_read(self.plan['admin_env_ref']))
                restore = ref_read(self.plan['restore_env_ref']); minimum = original_minimum_read(self.plan['original_minimum_ref'])
                need(len(minimum) == 87 and re.fullmatch(rb'BACKUP_ENCRYPTION_KEY=[a-fA-F0-9]{64}\n', minimum), 'BACKUP_ORIGINAL_MINIMUM_REQUIRED')
                key = original_key(minimum)
                need(hmac.compare_digest(key, original_key(restore)), 'BACKUP_ORIGINAL_KEYS_DIFFER')
                url = urllib.parse.urlsplit(admin['DATABASE_URL'])
                need(url.scheme in ('postgres', 'postgresql') and url.hostname == 'postgres'
                     and urllib.parse.unquote(url.username or '') == 'commerce_owner' and url.path == '/commerce'
                     and admin.get('DISPATCH_FROZEN') == 'true', 'BACKUP_OWNER_PROFILE_REQUIRED')
                total = 0; count = 0
                for item in (Path(self.plan['storage_path']) / 'assets').iterdir():
                    info = item.lstat()
                    need(re.fullmatch(r'[a-f0-9-]{36}(-[a-f0-9]{64})?\.enc', item.name) and stat.S_ISREG(info.st_mode)
                         and info.st_uid == 1000 and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1, 'BACKUP_ASSET_CUSTODY_INVALID')
                    total += info.st_size; count += 1
                database_bytes = self.sql(run_id, 'BEGIN READ ONLY; SELECT pg_database_size(current_database()); ROLLBACK;')
                need(re.fullmatch(r'[0-9]+', database_bytes), 'BACKUP_DATABASE_SIZE_INVALID')
                required = max(8 * 1024 ** 3, 2 * (int(database_bytes) + total) + 4 * 1024 ** 3)
                need(shutil.disk_usage(directory).free >= required, 'BACKUP_INSUFFICIENT_FREE_DISK')
                pins = {name: [ref['bytes'], ref['sha256']] for name, ref in self.plan['canonical_sources'].items()}
                probe = "import fs from 'node:fs';import c from 'node:crypto';console.log(JSON.stringify(Object.fromEntries(" + json.dumps(list(SOURCE_FILES)) + ".map(n=>{const b=fs.readFileSync('/app/scripts/'+n);return[n,[b.length,c.createHash('sha256').update(b).digest('hex')]]}))))"
                output = self.command(['run', '--rm', '--pull', 'never', '--name', 'commerce-b02-source-' + run_id,
                    '--label', 'com.commerce-os.daily-backup=' + run_id, '--network', 'none', '--read-only',
                    '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                    '--pids-limit', '32', '--memory', '128m', self.plan['maintenance_image'], 'node', '--input-type=module', '-e', probe])
                need(unique_json(output) == pins, 'BACKUP_MAINTENANCE_SOURCES_DRIFT')
                source = {'status': 'B02_SOURCE_VERIFIED', 'run_id': run_id, 'plan_sha256': self.plan_sha256,
                    'backup_source_sha': self.plan['source_sha'], 'maintenance_image': self.plan['maintenance_image'],
                    'canonical_sources': pins, 'database_bytes_before': int(database_bytes), 'physical_assets_before': count,
                    'asset_bytes_before': total, 'original_key_compared_in_RAM': True, 'keys_exported': False}
                json_write(directory / 'source.json', source)
                values = {'COMMERCE_CONFIG_DIR': str(directory), 'PRIVATE_STORAGE_DIR': self.plan['storage_path'],
                    'BACKUP_DIR': str(directory / 'backups'), 'DATABASE_URL': admin['DATABASE_URL'],
                    'POSTGRES_USER': 'commerce_owner', 'POSTGRES_DB': 'commerce',
                    'PG_CONTAINER': self.plan['postgres']['container_id'], 'PG_NETWORK': self.plan['postgres']['network'],
                    'PGAPPNAME': 'b02-' + run_id, 'BACKUP_ENCRYPTION_KEY': key.hex(), 'DISPATCH_FROZEN': 'true'}
                write_private(directory / 'backup.env', ''.join(name + '=' + value + '\n' for name, value in values.items()).encode('ascii'))
                self.runtime_guard()
                args = self.docker + ['run', '--rm', '--pull', 'never', '--name', 'commerce-b02-' + run_id,
                    '--label', 'com.commerce-os.daily-backup=' + run_id, '--network', self.plan['postgres']['network'],
                    '--restart', 'no', '--user', '0:0', '--security-opt', 'no-new-privileges:true',
                    '--env-file', str(directory / 'backup.env'), '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
                    '--mount', 'type=bind,source=' + str(directory) + ',target=' + str(directory),
                    '--mount', 'type=bind,source=' + self.plan['storage_path'] + ',target=' + self.plan['storage_path'] + ',readonly',
                    self.plan['maintenance_image'], 'node', 'scripts/backup.mjs']
                need(bounded(args, directory / 'operation.log', timeout=deadline_at - time.monotonic()) == 0, 'BACKUP_CANONICAL_COMMAND_FAILED')
                result = unique_json(read_file(directory / 'operation.log', limit=16384))
                need(result.get('encrypted') is True and result.get('format') == 2 and result.get('snapshot_consistent') is True
                     and type(result.get('private_assets')) is int and result['private_assets'] >= 0, 'BACKUP_CANONICAL_RECEIPT_INVALID')
                artifact = Path(result['backup'])
                need(artifact.parent == directory / 'backups' and re.fullmatch(r'commerce-[0-9TZ.\-]+\.backup\.aes', artifact.name), 'BACKUP_ARTIFACT_SCOPE_INVALID')
                ref = file_reference(artifact, ciphertext=True)
                portal_ref = self.create_portal_capsule(report, minimum, deadline_at) if self.plan.get('schema_version', 1) >= 2 else None
                need(ref['bytes'] + (portal_ref['bytes'] if portal_ref else 0) + (directory / 'source.json').stat().st_size + 16384 <= MAX_BYTES, 'BACKUP_COST_SIZE_LIMIT')
                self.cleanup(report)
                receipt = {'status': 'B02_LOCAL_CIPHERTEXT_VERIFIED', 'run_id': run_id, 'plan_sha256': self.plan_sha256,
                    'backup_source_sha': self.plan['source_sha'], 'completed_at': utc(), 'artifact': {'bytes': ref['bytes'], 'sha256': ref['sha256']},
                    'encrypted': True, 'format': 2, 'snapshot_consistent': True, 'private_assets': result['private_assets'],
                    'cleanup': report['cleanup'], 'external_copy_verified': False, 'restore_verified': False, 'keys_exported': False}
                json_write(directory / 'backup.json', receipt)
                if portal_ref:
                    receipt.update(backup_contract_version=2, portal_capsule=report['portal_capsule'],
                        backup_decryption_key_exported=False, portal_credentials_archived_encrypted=True)
                    json_write(directory / 'backup.json', receipt, replace=True)
                    source.update(backup_contract_version=2, portal_capsule=report['portal_capsule'])
                    json_write(directory / 'source.json', source, replace=True)
                report.update(status='LOCAL_CUSTODY_PENDING', finished_at=utc(), exports={
                    'ciphertext.backup.aes': ref, 'source.json': file_reference(directory / 'source.json'),
                    'backup.json': file_reference(directory / 'backup.json')})
                if portal_ref:
                    report['exports']['portal.backup.aes'] = portal_ref
                    export_names(report)
                self.save(report); return report
            except BaseException as error:
                report['error'] = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'[A-Z0-9_]{1,100}', str(error)) else type(error).__name__
                try:
                    self.cleanup(report); report['status'] = 'FAILED'
                except BaseException:
                    report['status'] = 'CLEANUP_UNKNOWN'
                report['finished_at'] = utc(); self.save(report)
                return report

    def reconcile(self, run_id):
        # Explicit recovery only; never called automatically by the next backup.
        with lock(PRIVATE / 'daily-b02-controller.lock'), lock(PRIVATE / 'ci-deploy.lock'), \
             lock(PRIVATE / 'backup-schedule.lock'), lock(PRIVATE / 'maintenance-backup.lock'):
            report = self.report(run_id)
            need(report['status'] in ('RUNNING', 'CLEANUP_UNKNOWN'), 'BACKUP_RECONCILE_UNKNOWN_TASK_REQUIRED')
            state = subprocess.run(['systemctl', 'show', 'commerce-b02-' + run_id + '.service',
                '--property=LoadState', '--property=ActiveState', '--property=MainPID', '--no-pager'],
                text=True, capture_output=True, timeout=40)
            values = dict(line.split('=', 1) for line in state.stdout.splitlines() if '=' in line)
            need(state.returncode == 0 and values.get('MainPID') == '0'
                 and values.get('ActiveState') in ('inactive', 'failed')
                 and values.get('LoadState') in ('loaded', 'not-found'), 'BACKUP_RECONCILE_UNIT_NOT_TERMINAL')
            self.cleanup(report)
            report.update(status='FAILED_RECONCILED', finished_at=utc()); self.save(report)
            return report

    def export_path(self, run_id):
        uid = int(os.environ.get('SUDO_UID', '-1'))
        need(uid > 0, 'BACKUP_EXPORT_CALLER_REQUIRED')
        home = Path(pwd.getpwuid(uid).pw_dir); protected_parents(home / 'unused', uid)
        return home / ('commerce-b02-' + backup_run_identity(run_id)), uid

    def export(self, run_id):
        report = self.report(run_id)
        need(report['status'] in ('LOCAL_CUSTODY_PENDING', 'SUCCEEDED'), 'BACKUP_EXPORT_LOCAL_SUCCESS_REQUIRED')
        export_names(report)
        target, uid = self.export_path(run_id)
        target.mkdir(mode=0o700)
        try:
            for name, ref in report['exports'].items():
                options = {'ciphertext': True, 'header': b'COMOSP01'} if name == 'portal.backup.aes' else {'ciphertext': name == 'ciphertext.backup.aes'}
                need(file_reference(ref['path'], **options) == ref, 'BACKUP_EXPORT_SOURCE_DRIFT')
                with os.fdopen(os.open(ref['path'], os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source, \
                     os.fdopen(os.open(target / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as destination:
                    shutil.copyfileobj(source, destination, 8 * 1024 * 1024); destination.flush(); os.fsync(destination.fileno())
                os.chown(target / name, uid, pwd.getpwuid(uid).pw_gid)
                actual = file_reference(target / name, uid=uid, **options)
                need((actual['bytes'], actual['sha256']) == (ref['bytes'], ref['sha256']), 'BACKUP_EXPORT_COPY_DRIFT')
                need(file_reference(ref['path'], **options) == ref, 'BACKUP_EXPORT_SOURCE_DRIFT')
            os.chown(target, uid, pwd.getpwuid(uid).pw_gid)
        except BaseException:
            # An uncertain/partial export remains for exact inspection, never reused blindly.
            raise RuntimeError('BACKUP_EXPORT_INCOMPLETE_PRESERVE') from None
        return report

    def acknowledge(self, run_id, receipt_sha):
        report = self.report(run_id); target, uid = self.export_path(run_id)
        raw = read_file(target / 'custody.json', uid=uid)
        need(sha256(raw) == hash_identity(receipt_sha), 'BACKUP_CUSTODY_RECEIPT_DRIFT')
        validate_custody(unique_json(raw), report, self.plan['bucket'])
        with lock(PRIVATE / 'daily-b02-controller.lock'):
            fresh = self.report(run_id)
            need(fresh == report and report['status'] == 'LOCAL_CUSTODY_PENDING', 'BACKUP_CUSTODY_STATE_CONFLICT')
            write_private(self.runs / run_id / 'custody.json', raw)
            report.update(status='SUCCEEDED', external_copy_verified=True, custody_receipt_sha256=receipt_sha)
            self.save(report)
        return report

    def discard_export(self, run_id):
        report = self.report(run_id); target, uid = self.export_path(run_id)
        export_names(report)
        need(report['status'] == 'SUCCEEDED' and report['external_copy_verified'] is True, 'BACKUP_EXPORT_CUSTODY_REQUIRED')
        info = target.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700,
             'BACKUP_EXPORT_DIRECTORY_DRIFT')
        need({item.name for item in target.iterdir()} == {*report['exports'], 'custody.json'}, 'BACKUP_EXPORT_CONTENTS_DRIFT')
        for name, ref in report['exports'].items():
            options = {'ciphertext': True, 'header': b'COMOSP01'} if name == 'portal.backup.aes' else {'ciphertext': name == 'ciphertext.backup.aes'}
            actual = file_reference(target / name, uid=uid, **options)
            need((actual['bytes'], actual['sha256']) == (ref['bytes'], ref['sha256']), 'BACKUP_EXPORT_COPY_DRIFT')
        need(sha256(read_file(target / 'custody.json', uid=uid)) == report['custody_receipt_sha256'], 'BACKUP_EXPORT_RECEIPT_DRIFT')
        for name in (*report['exports'], 'custody.json'):
            (target / name).unlink()
        target.rmdir()
        return report


# Google is read directly by Root. No caller-authored response is accepted.
GCP_BINDING_PATH = DAILY / 'gcp-binding.json'
GCP_UPDATES = DAILY / 'scheduler-updates'
GCP_PERMITS = DAILY / 'gcp-authorizations'
GCP_CLAIMS = DAILY / 'schedule-claims'
GCP_RESOLUTIONS = DAILY / 'gcp-authorization-reconciliations'


def private_directory(path):
    path = Path(path)
    if not path.exists():
        protected_parents(path); path.mkdir(mode=0o700)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)
    info = path.lstat(); protected_parents(path / 'unused')
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
         'B02_GCP_DIRECTORY_CUSTODY_INVALID')
    return path



def resumable_target(uri, bucket, object_name):
    """Validate the GCS capability without persisting or displaying it."""
    need(isinstance(uri,str) and 0<len(uri)<=8192 and not any(ord(x)<33 or ord(x)==127 for x in uri),
         'B02_SESSION_URI_INVALID')
    parsed=urllib.parse.urlsplit(uri)
    need(parsed.scheme=='https' and parsed.netloc=='storage.googleapis.com' and not parsed.fragment
         and parsed.path=='/upload/storage/v1/b/'+bucket+'/o','B02_SESSION_HOST_PATH_INVALID')
    pairs=urllib.parse.parse_qsl(parsed.query,keep_blank_values=True);query=dict(pairs)
    need(len(query)==len(pairs) and set(query)<={'uploadType','name','ifGenerationMatch','upload_id'}
         and query.get('uploadType')=='resumable' and re.fullmatch(r'[A-Za-z0-9_-]{8,4096}',query.get('upload_id','')),
         'B02_SESSION_QUERY_INVALID')
    need(query.get('name')==object_name and query.get('ifGenerationMatch','0')=='0','B02_SESSION_OBJECT_INVALID')
    return parsed.path+'?'+parsed.query


def stream_resumable(path, expected, uri, bucket, object_name, *, timeout=900, clock=time.monotonic, connection_factory=None):
    """One bounded HTTPS PUT of an already authenticated Root export descriptor."""
    import hashlib,http.client,ssl
    need(type(timeout) in (int,float) and 0<timeout<=900,'B02_UPLOAD_DEADLINE_INVALID')
    need(type(expected) is dict and set(expected)=={'bytes','sha256'} and type(expected['bytes']) is int
         and 0<expected['bytes']<=MAX_BYTES,'B02_UPLOAD_EXPECTED_INVALID');hash_identity(expected['sha256'])
    target=resumable_target(uri,bucket,object_name);path=Path(path);protected_parents(path)
    deadline=clock()+timeout;connection=None
    # A socket read can receive tiny fragments indefinitely; the wall-clock fuse
    # bounds the whole hash/upload/readback even when each socket read progresses.
    need(signal.getitimer(signal.ITIMER_REAL)==(0.0,0.0),'B02_UPLOAD_TIMER_BUSY')
    previous_handler=signal.getsignal(signal.SIGALRM)
    def expired(*_):raise RuntimeError('B02_UPLOAD_TIMEOUT_PRESERVE')
    signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,timeout)
    def remaining():
        seconds=deadline-clock();need(seconds>0,'B02_UPLOAD_TIMEOUT_PRESERVE');return min(30,seconds)
    def digest_file(stream):
        digest=hashlib.sha256()
        for block in iter(lambda:stream.read(8*1024**2),b''):
            remaining();digest.update(block)
        return digest.hexdigest()
    try:
        with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as source:
            info=os.fstat(source.fileno())
            need(stat.S_ISREG(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o600
                 and info.st_nlink==1 and info.st_size==expected['bytes'],'B02_UPLOAD_SOURCE_CUSTODY_INVALID')
            need(digest_file(source)==expected['sha256'] and identity(info)==identity(os.fstat(source.fileno()))==identity(path.lstat()),
                 'B02_UPLOAD_SOURCE_BEFORE_CHANGED');source.seek(0)
            factory=connection_factory or http.client.HTTPSConnection
            connection=factory('storage.googleapis.com',443,timeout=remaining(),context=ssl.create_default_context())
            connection.putrequest('PUT',target);connection.putheader('Content-Length',str(expected['bytes']))
            connection.putheader('Content-Type','application/octet-stream');connection.endheaders()
            sent=0;digest=hashlib.sha256()
            for block in iter(lambda:source.read(8*1024**2),b''):
                sent+=len(block);need(sent<=expected['bytes'],'B02_UPLOAD_SOURCE_LENGTH_CHANGED');digest.update(block)
                seconds=remaining()
                if connection.sock is not None:connection.sock.settimeout(seconds)
                connection.send(block)
            need(sent==expected['bytes'] and digest.hexdigest()==expected['sha256'],'B02_UPLOAD_SOURCE_STREAM_CHANGED')
            seconds=remaining()
            if connection.sock is not None:connection.sock.settimeout(seconds)
            response=connection.getresponse();raw=response.read(1024*1024+1);remaining()
            need(response.status in (200,201) and len(raw)<=1024*1024,'B02_UPLOAD_RESPONSE_UNKNOWN')
            value=unique_json(raw);generation=str(value.get('generation',''))
            need(value.get('bucket')==bucket and value.get('name')==object_name and str(value.get('size'))==str(sent)
                 and re.fullmatch(r'[1-9][0-9]*',generation),'B02_UPLOAD_METADATA_INVALID')
            source.seek(0)
            need(digest_file(source)==expected['sha256'] and identity(info)==identity(os.fstat(source.fileno()))==identity(path.lstat()),
                 'B02_UPLOAD_SOURCE_AFTER_CHANGED')
            return expected|{'generation':generation}
    except RuntimeError:raise
    except Exception:raise RuntimeError('B02_UPLOAD_UNKNOWN_PRESERVE') from None
    finally:
        try:
            if connection is not None:connection.close()
        finally:
            signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous_handler)


def gcp_upload_object(runner, run_id, request):
    """Only the original executor may stream a closed member of its pending run."""
    need(type(request) is dict and set(request)=={'name','session_uri','timeout_seconds'}
         and type(request['timeout_seconds']) is int and 0<request['timeout_seconds']<=900,'B02_UPLOAD_REQUEST_INVALID')
    run_id=backup_run_identity(run_id)
    with controller_update_locks():
        binding=read_gcp_binding(runner);report=runner.report(run_id)
        need(report['status']=='LOCAL_CUSTODY_PENDING' and report['source_sha']==binding['source_sha']
             and report['plan_sha256']==binding['plan_sha256'],'B02_UPLOAD_PENDING_RUN_REQUIRED')
        saved=verify_trigger_journal(report)
        need(saved['binding']==binding and saved['context']['run_id']==run_id
             and os.environ.get('SUDO_UID')==str(binding['oslogin_uid'])
             and pwd.getpwuid(binding['oslogin_uid']).pw_name==binding['oslogin_username'],'B02_UPLOAD_CALLER_CHANGED')
        name=request['name'];need(type(name) is str and name in export_names(report),'B02_UPLOAD_EXACT_EXPORT_REQUIRED')
        ref=report['exports'][name];path=Path(ref['path'])
        need(path.is_relative_to(runner.runs/run_id) and path.resolve()==path,'B02_UPLOAD_SOURCE_SCOPE_INVALID')
        header=ciphertext_header(name);options={'ciphertext':header is not None,'header':header or b'COMOSB02'}
        need(file_reference(path,**options)==ref,'B02_UPLOAD_SOURCE_CHANGED')
        object_name='b02/daily/'+run_id+'/'+name;resumable_target(request['session_uri'],binding['bucket'],object_name)
        intent=runner.runs/run_id/('upload-'+name+'.intent.json')
        # O_EXCL makes an unknown upload non-replayable. No capability is recorded.
        json_write(intent,{'at':utc(),'run_id':run_id,'name':name,'source_ref':ref,'object':object_name,'single_dispatch':True})
        uploaded=stream_resumable(path,{k:ref[k] for k in ('bytes','sha256')},request['session_uri'],binding['bucket'],object_name,timeout=request['timeout_seconds'])
        need(runner.report(run_id)==report and read_gcp_binding(runner)==binding,'B02_UPLOAD_RUNTIME_DRIFT')
        json_write(runner.runs/run_id/('upload-'+name+'.result.json'),{'status':'UPLOADED_REQUIRES_OFFHOST_READBACK','object':object_name,**uploaded})
        return {'status':'B02_CIPHERTEXT_OBJECT_UPLOADED','run_id':run_id,'name':name,'bytes':ref['bytes'],'sha256':ref['sha256']}


def google_get(resource, token):
    """GET only, TLS, no proxy/redirect, bounded bytes, no token in URLs/logs."""
    import urllib.request
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise RuntimeError('B02_GOOGLE_REDIRECT_REJECTED')
    need(isinstance(token, str) and re.fullmatch(r'[A-Za-z0-9._~-]{20,4096}', token), 'B02_GOOGLE_TOKEN_INVALID')
    need(isinstance(resource, str) and (
        re.fullmatch(r'https://run\.googleapis\.com/v2/' + re.escape(GCP_JOB) + r'(?:/executions/(?P<execution>commerce-b02-daily-[a-z0-9]{1,30})(?:/tasks/(?P=execution)-task0)?)?', resource)
        or resource == 'https://cloudscheduler.googleapis.com/v1/' + GCP_SCHEDULER
        or resource == 'https://oslogin.googleapis.com/v1/users/' + GCP_EXECUTOR + '/loginProfile?projectId=' + TARGET[0]),
        'B02_GOOGLE_ENDPOINT_INVALID')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(resource, headers={'Authorization': 'Bearer ' + token}, method='GET')
    try:
        with opener.open(request, timeout=20) as response:
            need(response.status == 200 and response.geturl() == resource, 'B02_GOOGLE_RESPONSE_INVALID')
            raw = response.read(1048577)
            need(0 < len(raw) <= 1048576, 'B02_GOOGLE_RESPONSE_BOUND')
            value = unique_json(raw)
            need(type(value) is dict, 'B02_GOOGLE_RESPONSE_INVALID')
            return value
    except Exception:
        # Never propagate URL/request/response/body/credentials from urllib.
        raise RuntimeError('B02_GOOGLE_READ_FAILED') from None


def gcp_pair(runner, binding):
    raw = read_file(PRIVATE / 'api-web-adoption.json'); state = unique_json(raw)
    need(state.get('schema_version') == 3 and state.get('runtime_stage') == 'OPERATING'
         and state.get('scope') == 'copy-runtime' and state.get('b02_plan_sha256') == runner.plan_sha256
         and state.get('preserved_runtime') == runner.plan['preserved_runtime'], 'B02_GCP_ROOT_PAIR_CHANGED')
    current = PRIVATE.parent / 'current'
    need(current.is_symlink() and str(current.resolve(strict=True)) == state.get('current_release'), 'B02_GCP_CURRENT_CHANGED')
    root = current.resolve(strict=True)
    release = unique_json(read_file(root / 'RELEASE.json', private=False))
    need(release.get('source_sha') == binding['source_sha']
         and binding['bucket'] == runner.plan['bucket'], 'B02_GCP_CURRENT_SOURCE_CHANGED')
    receipt = unique_json(ref_read(state['last_release_receipt_ref']))
    directory = Path(state['last_release_receipt_ref']['path']).parent
    transition = unique_json(read_file(directory/'copy-runtime-transition.json'))
    report = unique_json(read_file(directory/'report.json'))
    need(receipt.get('status') == 'VALIDATED_FOR_PAIR_CAS' and transition.get('status') == 'APPLIED'
         and report.get('status') == 'SUCCEEDED' and report.get('source_sha') == binding['source_sha']
         and receipt.get('source_sha') == report.get('source_sha')
         and receipt.get('preserved_runtime') == state['preserved_runtime'], 'B02_GCP_RUNTIME_NOT_ADOPTED')
    runner.runtime_guard()
    return raw


def read_gcp_binding(runner):
    schedule_terminal_guard()
    raw = read_file(GCP_BINDING_PATH); value = gcp_binding(unique_json(raw))
    need(value['plan_sha256'] == runner.plan_sha256, 'B02_GCP_BINDING_PLAN_CHANGED')
    journal = unique_json(read_file(GCP_UPDATES / value['activation_id'] / 'journal.json'))
    need(journal.get('status') == 'APPLIED' and journal.get('binding_sha256') == sha256(raw)
         and journal.get('plan_after_sha256') == runner.plan_sha256, 'B02_GCP_ACTIVATION_INCOMPLETE')
    gcp_pair(runner, value)
    need(runner.plan.get('schedule_enabled') is (value['mode'] == 'SCHEDULED'), 'B02_GCP_SCHEDULE_GATE_CHANGED')
    return value


def google_observation(binding, token, *, execution=None, require_login=False, paused=True):
    gcp_binding(binding)
    job = google_get('https://run.googleapis.com/v2/' + GCP_JOB, token)
    scheduler = google_get('https://cloudscheduler.googleapis.com/v1/' + GCP_SCHEDULER, token)
    gcp_job_guard(binding, job); gcp_scheduler_guard(binding, scheduler, paused=paused)
    result = {'job':job,'scheduler':scheduler}
    profile = google_get('https://oslogin.googleapis.com/v1/users/' + binding['executor']
        + '/loginProfile?projectId=' + TARGET[0], token)
    need(profile.get('name') == binding['executor_id'], 'B02_GCP_OSLOGIN_PROFILE_CHANGED')
    uid = str(binding['oslogin_uid'])
    matches = [row for row in profile.get('posixAccounts', []) if str(row.get('uid')) == uid
        and row.get('username') == binding['oslogin_username'] and row.get('operatingSystemType') in (None,'LINUX')]
    need(len(matches) == 1, 'B02_GCP_OSLOGIN_PROFILE_CHANGED')
    if require_login:
        need(os.environ.get('SUDO_UID') == uid and pwd.getpwuid(int(uid)).pw_name == binding['oslogin_username'],
             'B02_GCP_CALLER_IDENTITY_INVALID')
    result['oslogin'] = {'name':profile['name'],'uid':int(uid),'username':matches[0]['username']}
    if execution is not None:
        need(isinstance(execution,str) and re.fullmatch(re.escape(GCP_JOB)+r'/executions/commerce-b02-daily-[a-z0-9]{1,30}',execution), 'B02_GCP_EXECUTION_NAME_INVALID')
        result['execution'] = google_get('https://run.googleapis.com/v2/' + execution, token)
        result['task'] = google_get('https://run.googleapis.com/v2/' + gcp_task_name(execution), token)
    return result


def gcp_authorize(runner, request):
    need(type(request) is dict and set(request) == {'access_token','execution'}, 'B02_GCP_REQUEST_INVALID')
    with controller_update_locks():
        binding = read_gcp_binding(runner)
        observed = google_observation(binding, request['access_token'], execution=request['execution'],
            require_login=True, paused=binding['mode']=='MANUAL')
        context = gcp_execution_guard(binding, observed['job'], observed['execution'], observed['task'], dt.datetime.now(dt.timezone.utc))
        journals = [runner.report(item.name) for item in runner.runs.iterdir()]
        need(all(item['status'] in TERMINAL for item in journals), 'BACKUP_PREVIOUS_TASK_REQUIRES_RECONCILIATION')
        check_run_budget(journals, dt.datetime.now(dt.timezone.utc))
        permits, claims = private_directory(GCP_PERMITS), private_directory(GCP_CLAIMS)
        # A lost dispatch authorization remains blocking even without a run journal.
        for previous in permits.iterdir():
            saved = unique_json(read_file(previous))
            authorization_terminal(previous,saved,journals)
        slot_key = binding['scheduler'] + ':' + context['slot'] if context['slot'] else 'manual:' + context['execution_uid']
        claim_path = claims / (sha256(slot_key.encode()) + '.json')
        need(not claim_path.exists() and not claim_path.is_symlink(), 'B02_GCP_SLOT_ALREADY_CLAIMED')
        now = dt.datetime.now(dt.timezone.utc)
        permit = {'schema_version':1,'kind':'B02_GCP_AUTHORIZATION','context':context,
            'issued_at':now.isoformat(),'expires_at':(now+dt.timedelta(seconds=120)).isoformat(),
            'binding_ref':file_reference(GCP_BINDING_PATH),'binding':binding,
            'google_observation_sha256':sha256(canonical(observed)), 'caller':observed['oslogin']}
        path = permits / (context['run_id'] + '.json')
        json_write(path, permit)
        claim = {'schema_version':1,'slot_key':slot_key,'authorization_ref':file_reference(path),'run_id':context['run_id']}
        json_write(claim_path, claim)
        return {'status':'B02_GCP_AUTHORIZED','run_id':context['run_id'],'source_sha':binding['source_sha'],
            'plan_sha256':runner.plan_sha256,'scheduled':binding['mode']=='SCHEDULED',
            'trigger_ref':file_reference(path),'claim_ref':file_reference(claim_path)}


def authorization_terminal(path, saved, journals):
    run_id=backup_run_identity(saved['context']['run_id'])
    if any(j['run_id']==run_id and j['status'] in TERMINAL for j in journals):return
    resolution=GCP_RESOLUTIONS/(run_id+'.json')
    need(resolution.exists() and not resolution.is_symlink(), 'B02_GCP_PRIOR_AUTHORIZATION_UNCONFIRMED')
    value=unique_json(read_file(resolution))
    need(value.get('status')=='NO_BACKUP_STARTED' and value.get('authorization_ref')==file_reference(path)
         and value.get('run_id')==run_id and value.get('execution_uid')==saved['context']['execution_uid']
         and value.get('run_directory_absent') is True and value.get('unit_terminal') is True
         and value.get('execution_terminal') is True and value.get('task_terminal') is True,
         'B02_GCP_AUTHORIZATION_RECONCILIATION_CHANGED')
    verify_trigger_journal({'run_id':run_id,'source_sha':saved['binding']['source_sha'],
        'plan_sha256':saved['binding']['plan_sha256'],'trigger':{'authorization_ref':value['authorization_ref'],'claim_ref':value['claim_ref']}})


def reconcile_authorization(runner, request):
    """Explicit closure of a never-started dump; keep its slot consumed forever."""
    need(type(request) is dict and set(request)=={'access_token','run_id'},'B02_GCP_REQUEST_INVALID')
    run_id=backup_run_identity(request['run_id']);need(run_id.startswith('gcp-'),'B02_GCP_AUTHORIZATION_SCOPE_INVALID')
    with controller_update_locks():
        binding=read_gcp_binding(runner);path=GCP_PERMITS/(run_id+'.json');saved=unique_json(read_file(path))
        need(saved.get('binding')==binding and saved.get('context',{}).get('run_id')==run_id
             and saved.get('binding_ref')==file_reference(GCP_BINDING_PATH),'B02_GCP_TRIGGER_BINDING_CHANGED')
        need(dt.datetime.now(dt.timezone.utc)>utc_time(saved['expires_at']),'B02_GCP_AUTHORIZATION_STILL_VALID')
        observed=google_observation(binding,request['access_token'],execution=saved['context']['execution'],
            paused=binding['mode']=='MANUAL')
        execution=observed['execution'];task=observed['task'];context=saved['context']
        need(execution.get('uid')==context['execution_uid'] and execution.get('name')==context['execution']
             and execution.get('job')==binding['job'].rsplit('/',1)[1] and execution.get('creator')==context['creator']
             and execution.get('template')==observed['job']['template']['template']
             and execution.get('taskCount')==1 and execution.get('parallelism')==1
             and execution.get('completionTime') and task.get('completionTime')
             and task.get('name')==gcp_task_name(context['execution'])
             and task.get('execution')==context['execution'].rsplit('/',1)[1] and task.get('job')==binding['job'].rsplit('/',1)[1]
             and task.get('index',0)==0 and task.get('containers')==execution['template']['containers'],
             'B02_GCP_AUTHORIZATION_EXECUTION_NOT_TERMINAL')
        now=dt.datetime.now(dt.timezone.utc)
        for row in (execution,task):
            need(utc_time(context['created_at'])<=utc_time(row['completionTime'])<=now,'B02_GCP_AUTHORIZATION_TERMINAL_TIME_INVALID')
        directory=runner.runs/run_id
        need(not directory.exists() and not directory.is_symlink(),'B02_GCP_RUN_RECONCILIATION_REQUIRED')
        state=subprocess.run(['systemctl','show','commerce-b02-'+run_id+'.service',
            '--property=LoadState','--property=ActiveState','--property=MainPID','--no-pager'],text=True,capture_output=True,timeout=40)
        values=dict(line.split('=',1) for line in state.stdout.splitlines() if '=' in line)
        need(state.returncode==0 and values.get('MainPID')=='0' and values.get('ActiveState') in ('inactive','failed')
             and values.get('LoadState') in ('loaded','not-found'),'BACKUP_RECONCILE_UNIT_NOT_TERMINAL')
        runner.runtime_guard()
        # A crash between permit and claim is closed by preserving that very slot.
        slot_key=binding['scheduler']+':'+context['slot'] if context['slot'] else 'manual:'+context['execution_uid']
        claim_path=private_directory(GCP_CLAIMS)/(sha256(slot_key.encode())+'.json')
        expected={'schema_version':1,'slot_key':slot_key,'authorization_ref':file_reference(path),'run_id':run_id}
        if claim_path.exists() or claim_path.is_symlink():need(unique_json(read_file(claim_path))==expected,'B02_GCP_CLAIM_CHANGED')
        else:json_write(claim_path,expected)
        trigger={'authorization_ref':file_reference(path),'claim_ref':file_reference(claim_path)}
        verify_trigger_journal({'run_id':run_id,'source_sha':binding['source_sha'],'plan_sha256':binding['plan_sha256'],'trigger':trigger})
        # Repeat absence immediately before writing the terminal resolution. A late
        # execute is also blocked by the expired permit under these same locks.
        need(not directory.exists() and not directory.is_symlink(),'B02_GCP_RUN_RECONCILIATION_REQUIRED')
        result={'status':'NO_BACKUP_STARTED','run_id':run_id,'execution_uid':context['execution_uid'],
            **trigger,'run_directory_absent':True,'unit_terminal':True,'execution_terminal':True,'task_terminal':True,
            'google_observation_sha256':sha256(canonical(observed)),'finished_at':utc(),
            'google_observation':observed,'slot_preserved':True,'backup_started':False,'automatic_retry':False}
        target=private_directory(GCP_RESOLUTIONS)/(run_id+'.json');json_write(target,result)
        return {'status':'NO_BACKUP_STARTED','run_id':run_id,'ref':file_reference(target),'slot_preserved':True}


def verify_trigger_journal(report):
    run_id = backup_run_identity(report.get('run_id'))
    if not run_id.startswith('gcp-'):
        need('trigger' not in report, 'B02_LEGACY_TRIGGER_INVALID'); return None
    trigger = report.get('trigger')
    need(type(trigger) is dict and set(trigger) == {'authorization_ref','claim_ref'}, 'B02_GCP_TRIGGER_REQUIRED')
    ref = trigger['authorization_ref']; reference(ref)
    need(ref['path'] == str(GCP_PERMITS/(run_id+'.json')), 'B02_GCP_AUTHORIZATION_SCOPE_INVALID')
    saved = unique_json(ref_read(ref)); context = saved.get('context', {})
    claim_ref = trigger['claim_ref']; reference(claim_ref)
    need(Path(claim_ref['path']).parent == GCP_CLAIMS and re.fullmatch(r'[a-f0-9]{64}\.json',Path(claim_ref['path']).name), 'B02_GCP_CLAIM_SCOPE_INVALID')
    claim = unique_json(ref_read(claim_ref))
    need(type(saved) is dict and set(saved) == {'schema_version','kind','context','issued_at','expires_at',
        'binding_ref','binding','google_observation_sha256','caller'} and type(saved['schema_version']) is int
        and saved['schema_version'] == 1, 'B02_GCP_AUTHORIZATION_INVALID')
    binding=gcp_binding(saved['binding']); binding_raw=canonical(binding)
    need(sha256(binding_raw) == context.get('binding_sha256'), 'B02_GCP_BINDING_ARCHIVE_CHANGED')
    need(saved['binding_ref'] == {'path':str(GCP_BINDING_PATH),'bytes':len(binding_raw),'sha256':sha256(binding_raw)}
        and type(saved['caller']) is dict and saved['caller'] == {'name':binding['executor_id'],
            'uid':binding['oslogin_uid'],'username':binding['oslogin_username']}, 'B02_GCP_CALLER_ARCHIVE_CHANGED')
    need(saved.get('kind') == 'B02_GCP_AUTHORIZATION' and context.get('kind') == 'GCP_CLOUD_RUN'
         and context.get('run_id') == run_id and gcp_run_identity(context.get('execution_uid')) == run_id
         and context.get('source_sha') == report.get('source_sha') == binding['source_sha']
         and context.get('plan_sha256') == report.get('plan_sha256') == binding['plan_sha256']
         and context.get('mode') == binding['mode'] and context.get('scheduled_delivery_proven') is False,
         'B02_GCP_TRIGGER_CHANGED')
    created=utc_time(context.get('created_at'));issued=utc_time(saved['issued_at']);expires=utc_time(saved['expires_at'])
    need(dt.timedelta(0) <= issued-created <= dt.timedelta(minutes=5) and expires-issued == dt.timedelta(seconds=120),
         'B02_GCP_AUTHORIZATION_TIME_CHANGED')
    if binding['mode']=='SCHEDULED':
        hour,minute=map(int,binding['schedule_utc'].split(':'))
        slot=created.replace(hour=hour,minute=minute,second=0,microsecond=0)
        need(context.get('slot')==slot.isoformat() and dt.timedelta(0)<=created-slot<dt.timedelta(minutes=30), 'B02_GCP_SLOT_CHANGED')
        slot_key=binding['scheduler']+':'+slot.isoformat()
    else:
        need(context.get('slot') is None, 'B02_GCP_SLOT_CHANGED');slot_key='manual:'+context['execution_uid']
    need(type(claim) is dict and set(claim)=={'schema_version','slot_key','authorization_ref','run_id'}
         and type(claim['schema_version']) is int and claim['schema_version']==1
         and claim['slot_key']==slot_key and claim['authorization_ref']==ref and claim['run_id']==run_id
         and Path(claim_ref['path']).name==sha256(slot_key.encode())+'.json', 'B02_GCP_CLAIM_CHANGED')
    for key in ('job_sha256','task_sha256','execution_sha256'):hash_identity(context.get(key))
    hash_identity(saved['google_observation_sha256'])
    # Immutable original binding is archived by every cutover, so old backup
    # evidence never depends on a later mutable binding pointer.
    return saved


def gcp_start_guard(runner, run_id, source_sha, scheduled, trigger):
    temporary = {'run_id':run_id,'source_sha':source_sha,'plan_sha256':runner.plan_sha256,'trigger':trigger}
    saved = verify_trigger_journal(temporary); binding = read_gcp_binding(runner)
    need(saved is not None and saved['context']['binding_sha256'] == sha256(canonical(binding))
         and saved['context']['mode'] == binding['mode'] and scheduled is (binding['mode']=='SCHEDULED'), 'B02_GCP_TRIGGER_BINDING_CHANGED')
    need(utc_time(saved['issued_at']) <= dt.datetime.now(dt.timezone.utc) < utc_time(saved['expires_at']), 'B02_GCP_AUTHORIZATION_STALE')
    need(file_reference(GCP_BINDING_PATH) == saved['binding_ref'], 'B02_GCP_BINDING_CHANGED')


def schedule_terminal_guard():
    if not GCP_UPDATES.exists(): return
    private_directory(GCP_UPDATES)
    for entry in GCP_UPDATES.iterdir():
        private_directory(entry)
        intent = entry/'journal.json'
        if intent.exists() or intent.is_symlink():
            need(unique_json(read_file(intent)).get('status') == 'APPLIED', 'B02_GCP_CUTOVER_RECONCILIATION_REQUIRED')


def cutover_facts(runner, binding, token):
    gcp_binding(binding); schedule_terminal_guard()
    state_raw = gcp_pair(runner, binding)
    old_binding = read_file(GCP_BINDING_PATH) if GCP_BINDING_PATH.exists() or GCP_BINDING_PATH.is_symlink() else None
    if old_binding:
        previous = gcp_binding(unique_json(old_binding))
        need(binding['valid_from'] == previous['valid_from'] and binding['valid_until'] == previous['valid_until'],
             'B02_GCP_FINANCIAL_RENEWAL_FORBIDDEN')
    now = dt.datetime.now(dt.timezone.utc)
    need(utc_time(binding['valid_from']) <= now < utc_time(binding['valid_until']), 'B02_GCP_AUTHORIZATION_EXPIRED')
    plan = dict(runner.plan, schedule_enabled=binding['mode']=='SCHEDULED')
    plan_raw = (json.dumps(plan, sort_keys=True)+'\n').encode()
    need(binding['plan_sha256'] == sha256(plan_raw), 'B02_GCP_CANDIDATE_PLAN_INVALID')
    if binding['mode'] == 'SCHEDULED':
        need(old_binding is not None and previous['mode'] == 'MANUAL'
             and all(binding[key] == previous[key] for key in GCP_BINDING_FIELDS-{'mode','plan_sha256','activation_id','first_custody_ref'}),
             'B02_GCP_FIRST_MANUAL_BINDING_REQUIRED')
        ref = binding['first_custody_ref']; reference(ref)
        need(Path(ref['path']).parent.parent == runner.runs and Path(ref['path']).name == 'journal.json', 'B02_GCP_FIRST_CUSTODY_SCOPE')
        report = unique_json(ref_read(ref)); verify_trigger_journal(report)
        need(report.get('status') == 'SUCCEEDED' and report.get('external_copy_verified') is True
             and report.get('source_sha') == binding['source_sha'] and report.get('plan_sha256') == runner.plan_sha256
             and report.get('cleanup', {}).get('runtime_preserved') is True
             and report.get('cleanup', {}).get('owned_plaintext_removed') is True
             and report.get('trigger') is not None, 'B02_GCP_FIRST_CUSTODY_REQUIRED')
        saved = verify_trigger_journal(report)
        need(saved['context']['mode'] == 'MANUAL' and saved['context']['binding_sha256'] == sha256(canonical(previous)), 'B02_GCP_FIRST_CUSTODY_BINDING')
        export_names(report)
    journals = [runner.report(item.name) for item in runner.runs.iterdir()]
    need(all(item['status'] in TERMINAL for item in journals), 'BACKUP_PREVIOUS_TASK_REQUIRES_RECONCILIATION')
    if GCP_PERMITS.exists() or GCP_PERMITS.is_symlink():
        private_directory(GCP_PERMITS)
        for path in GCP_PERMITS.iterdir():authorization_terminal(path,unique_json(read_file(path)),journals)
    observed = google_observation(binding, token, paused=True)
    state = unique_json(state_raw)
    after_state = dict(state, b02_plan_sha256=sha256(plan_raw),
        b02_plan_ref={'path':str(DAILY/'plan.json'),'bytes':len(plan_raw),'sha256':sha256(plan_raw)})
    state_after = (json.dumps(after_state,sort_keys=True)+'\n').encode()
    return {'kind':'B02_GCP_CUTOVER_OBSERVATION','schema_version':1,'binding':binding,
        'plan_before_ref':file_reference(DAILY/'plan.json'), 'state_before_ref':file_reference(PRIVATE/'api-web-adoption.json'),
        'binding_before_ref':file_reference(GCP_BINDING_PATH) if old_binding else None,
        'plan_after':plan, 'state_after':after_state,
        'google_sha256':sha256(canonical(observed)), 'google_observation':observed,
        'plan_after_sha256':sha256(plan_raw),'state_after_sha256':sha256(state_after)}


def propose_scheduled_binding(runner, request):
    need(type(request) is dict and set(request)=={'access_token','activation_id','first_custody_ref'},'B02_GCP_CUTOVER_REQUEST_INVALID')
    with controller_update_locks():
        previous=read_gcp_binding(runner);need(previous['mode']=='MANUAL','B02_GCP_FIRST_MANUAL_BINDING_REQUIRED')
        plan=dict(runner.plan,schedule_enabled=True)
        candidate=dict(previous,mode='SCHEDULED',activation_id=request['activation_id'],first_custody_ref=request['first_custody_ref'],
            plan_sha256=sha256((json.dumps(plan,sort_keys=True)+'\n').encode()))
        facts=cutover_facts(runner,candidate,request['access_token'])
        return {'status':'B02_GCP_SCHEDULE_CANDIDATE','binding':candidate,'facts_sha256':sha256(canonical(facts)),
            'cloud_mutations':0,'pair_written':False}


def schedule_cutover(runner, action, request, digest=None):
    need(type(request) is dict and set(request) == {'access_token','binding'}, 'B02_GCP_CUTOVER_REQUEST_INVALID')
    binding = gcp_binding(request['binding'])
    with controller_update_locks():
        facts = cutover_facts(runner, binding, request['access_token'])
        directory = GCP_UPDATES / binding['activation_id']
        if action == 'gcp-observe':
            private_directory(GCP_UPDATES)
            need(not directory.exists() and not directory.is_symlink(), 'B02_GCP_REVIEW_EXISTS')
            private_directory(directory)
            value = {'created_at':utc(),'facts':facts}
            json_write(directory/'observation.json', value)
            return {'status':'OBSERVED','ref':file_reference(directory/'observation.json')}
        hash_identity(digest)
        observed_raw = read_file(directory/'observation.json'); observed = unique_json(observed_raw)
        need(sha256(observed_raw) == digest and observed['facts'] == facts, 'B02_GCP_REVIEW_CHANGED')
        need(dt.timedelta(0) <= dt.datetime.now(dt.timezone.utc)-utc_time(observed['created_at']) <= dt.timedelta(minutes=15), 'B02_GCP_REVIEW_EXPIRED')
        if action == 'gcp-seal':
            json_write(directory/'seal.json', {'status':'SEALED','observation_ref':file_reference(directory/'observation.json'),'sealed_at':utc()})
            return {'status':'SEALED','ref':file_reference(directory/'seal.json')}
        need(action == 'gcp-apply', 'B02_GCP_CUTOVER_ACTION_INVALID')
        seal = unique_json(read_file(directory/'seal.json'))
        need(seal.get('status') == 'SEALED' and seal.get('observation_ref') == file_reference(directory/'observation.json'), 'B02_GCP_SEAL_CHANGED')
        plan_before = ref_read(facts['plan_before_ref']); state_before = ref_read(facts['state_before_ref'])
        binding_before = ref_read(facts['binding_before_ref']) if facts['binding_before_ref'] else None
        plan_after = (json.dumps(facts['plan_after'],sort_keys=True)+'\n').encode()
        state_after = (json.dumps(facts['state_after'],sort_keys=True)+'\n').encode()
        binding_after = canonical(binding)
        json_write(directory/'journal.json', {'status':'PREWRITE','observation_ref':file_reference(directory/'observation.json'),
            'plan_before_sha256':sha256(plan_before),'state_before_sha256':sha256(state_before),
            'plan_after_sha256':sha256(plan_after),'state_after_sha256':sha256(state_after),'binding_sha256':sha256(binding_after)})
        write_private(directory/'plan.before.json',plan_before); write_private(directory/'state.before.json',state_before)
        if binding_before is not None: write_private(directory/'binding.before.json',binding_before)
        need(read_file(DAILY/'plan.json') == plan_before and read_file(PRIVATE/'api-web-adoption.json') == state_before
             and (read_file(GCP_BINDING_PATH) if GCP_BINDING_PATH.exists() else None) == binding_before, 'B02_GCP_CAS_CONFLICT_PRESERVE')
        # A crash after any write leaves PREWRITE, blocking both execution and
        # publication. No failure path guesses rollback or completes the journal.
        write_private(DAILY/'plan.json',plan_after,replace=True)
        write_private(PRIVATE/'api-web-adoption.json',state_after,replace=True)
        write_private(GCP_BINDING_PATH,binding_after,replace=binding_before is not None)
        need(read_file(DAILY/'plan.json') == plan_after and read_file(PRIVATE/'api-web-adoption.json') == state_after
             and read_file(GCP_BINDING_PATH) == binding_after, 'B02_GCP_CAS_READBACK_FAILED')
        runner.runtime_guard()
        journal = unique_json(read_file(directory/'journal.json'))
        journal.update(status='APPLIED',finished_at=utc())
        json_write(directory/'journal.json',journal,replace=True)
        return {'status':'APPLIED','ref':file_reference(directory/'journal.json'),'scheduler_started':False}



def public_report(report):
    return {key: report[key] for key in ('run_id', 'source_sha', 'backup_source_sha', 'plan_sha256', 'status',
        'started_at', 'external_copy_verified', 'restore_verified', 'automatic_retry', 'finished_at', 'exports', 'cleanup', 'error',
        'backup_contract_version', 'portal_capsule', 'trigger') if key in report}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', nargs='?', default='prepared', choices=('prepared', 'execute', 'status', 'export', 'ack', 'discard-export', 'reconcile', 'gcp-binding', 'gcp-authorize', 'gcp-upload-object', 'gcp-observe', 'gcp-seal', 'gcp-apply', 'gcp-reconcile-authorization', 'gcp-propose-scheduled'))
    parser.add_argument('--plan-sha256'); parser.add_argument('--run-id'); parser.add_argument('--source-sha')
    parser.add_argument('--scheduled', action='store_true'); parser.add_argument('--receipt-sha256')
    parser.add_argument('--trigger-json'); parser.add_argument('--observation-sha256')
    args = parser.parse_args()
    if args.action == 'prepared':
        print(json.dumps({'status': 'PREPARED_ONLY', 'Cloud_calls': 0, 'private_inputs_read': False, 'backup_created': False})); return
    need(os.geteuid() == 0 and sys.platform == 'linux', 'BACKUP_LINUX_ROOT_REQUIRED'); os.umask(0o077)
    if args.action == 'gcp-binding' and args.plan_sha256 is None:
        args.plan_sha256 = sha256(read_file(DAILY/'plan.json'))
    runner = BackupRunner(args.plan_sha256)
    if args.action in ('gcp-observe','gcp-seal','gcp-apply'):
        raw = sys.stdin.buffer.read(32769); need(0 < len(raw) <= 32768, 'B02_GCP_REQUEST_BOUND')
        print(json.dumps(schedule_cutover(runner, args.action, unique_json(raw), args.observation_sha256))); return
    if args.action == 'gcp-binding':
        binding = read_gcp_binding(runner)
        print(json.dumps(binding)); return
    if args.action == 'gcp-propose-scheduled':
        raw=sys.stdin.buffer.read(32769);need(0<len(raw)<=32768,'B02_GCP_REQUEST_BOUND')
        print(json.dumps(propose_scheduled_binding(runner,unique_json(raw))));return
    if args.action == 'gcp-reconcile-authorization':
        raw=sys.stdin.buffer.read(16385);need(0<len(raw)<=16384,'B02_GCP_REQUEST_BOUND')
        print(json.dumps(reconcile_authorization(runner,unique_json(raw))));return
    if args.action == 'gcp-authorize':
        raw = sys.stdin.buffer.read(16385); need(0 < len(raw) <= 16384, 'B02_GCP_REQUEST_BOUND')
        print(json.dumps(gcp_authorize(runner, unique_json(raw)))); return
    backup_run_identity(args.run_id)
    def interrupted(_signal, _frame):
        raise RuntimeError('BACKUP_INTERRUPTED')
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, interrupted)
    if args.action == 'gcp-upload-object':
        raw=sys.stdin.buffer.read(16385);need(0<len(raw)<=16384,'B02_UPLOAD_REQUEST_BOUND')
        request=unique_json(raw);raw=None
        try:print(json.dumps(gcp_upload_object(runner,args.run_id,request)))
        finally:request.clear()
        return
    if args.action == 'execute':
        answer = runner.execute(args.run_id, args.source_sha, args.scheduled,
            trigger=unique_json(args.trigger_json) if args.trigger_json else None)
    elif args.action == 'export':
        answer = runner.export(args.run_id)
    elif args.action == 'ack':
        answer = runner.acknowledge(args.run_id, args.receipt_sha256)
    elif args.action == 'discard-export':
        answer = runner.discard_export(args.run_id)
    elif args.action == 'reconcile':
        answer = runner.reconcile(args.run_id)
    else:
        try:
            answer = runner.report(args.run_id)
        except RuntimeError as error:
            if str(error) != 'BACKUP_RUN_NOT_FOUND':
                raise
            print(json.dumps({'status': 'NOT_STARTED', 'run_id': args.run_id, 'plan_sha256': args.plan_sha256})); return
    print(json.dumps(public_report(answer), sort_keys=True))
    if args.action == 'status':
        return
    need(answer['status'] in ('LOCAL_CUSTODY_PENDING', 'SUCCEEDED') or (args.action == 'reconcile'
         and answer['status'] == 'FAILED_RECONCILED'), 'BACKUP_NOT_SUCCEEDED')


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'[A-Z0-9_]{1,100}', str(error)) else type(error).__name__
        print(json.dumps({'status': 'STOP_PRESERVE', 'code': code}), file=sys.stderr); sys.exit(1)
