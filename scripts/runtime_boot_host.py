"""Root host adapter for the fixed, manifest-authenticated boot entrypoint.

Only gateway container start is dispatched. Definition, storage, credentials,
network and commercial state are never repaired or adopted by this adapter.
"""
from contextlib import contextmanager
import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import urllib.request
import uuid

import runtime_boot_policy as policy
import copy_runtime_deployment as runtime
from ci_release import require

PRIVATE = Path('/opt/commerce-os/private')
BASE = PRIVATE / 'runtime-boot'
BOOT_ID = Path('/proc/sys/kernel/random/boot_id')
MAX_OUTPUT = 1024 * 1024
SECONDS = 300
CORE_SECONDS = 120


def protected_parents(path):
    for parent in Path(path).parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'BOOT_PARENT_UNSAFE')


def protected(path, *, maximum=MAX_OUTPUT, private=True):
    path = Path(path)
    protected_parents(path)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
                and (stat.S_IMODE(before.st_mode) == 0o600 if private else not before.st_mode & 0o022)
                and 0 < before.st_size <= maximum,
                'BOOT_FILE_UNSAFE')
        raw = stream.read(maximum + 1)
        fingerprint = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode, s.st_nlink)
        require(len(raw) == before.st_size and fingerprint(before) == fingerprint(os.fstat(stream.fileno()))
                == fingerprint(path.lstat()), 'BOOT_FILE_CHANGED')
    return raw


def durable_write(path, raw, *, previous=None):
    """The caller holds four locks; absent creation and CAS are never resets."""
    path = Path(path)
    protected_parents(path)
    require(stat.S_IMODE(path.parent.lstat().st_mode) == 0o700, 'BOOT_JOURNAL_DIRECTORY_UNSAFE')
    if previous is not None: require(protected(path) == previous, 'BOOT_JOURNAL_CAS_CHANGED')
    target = path if previous is None else path.with_name('.' + path.name + '-' + uuid.uuid4().hex)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    if previous is not None:
        require(protected(path) == previous, 'BOOT_JOURNAL_CAS_CHANGED')
        os.replace(target, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
    require(protected(path) == raw, 'BOOT_JOURNAL_READBACK_CHANGED')


def network_snapshot(command, root, services):
    """Same immutable network projection, with active endpoint membership.

    Stopped containers retain configured network membership in docker inspect
    but have no live endpoint. Never add them to a network's observed endpoints.
    """
    names = set().union(*(set(row['NetworkSettings']['Networks']) for row in services.values()))
    require(3 <= len(names) <= runtime.MAX_NETWORKS, 'BOOT_NETWORK_BOUND')  # V7.1.1: one bridge per gateway
    rows = runtime._parse(command(['docker', 'network', 'inspect', *sorted(names)], root).encode())
    require(type(rows) is list and len(rows) == len(names), 'BOOT_NETWORK_READBACK_INVALID')
    result = {}
    for row in rows:
        name = row.get('Name')
        require(name in names and name not in result and type(row.get('Containers')) is dict,
                'BOOT_NETWORK_READBACK_INVALID')
        expected = {v['Id'] for v in services.values()
                    if v['State']['Running'] is True and name in v['NetworkSettings']['Networks']}
        require(set(row['Containers']) == expected, 'BOOT_NETWORK_ACTIVE_ENDPOINT_CHANGED')
        result[name] = {key: row[key] for key in ('Name', 'Id', 'Driver', 'Internal', 'EnableIPv6', 'IPAM', 'Options', 'Labels')}
    return result


def bounded(argv, seconds):
    require(seconds > 0, 'BOOT_DEADLINE_EXPIRED')
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'HOME': '/root'}, start_new_session=True)
    selector = selectors.DefaultSelector(); selector.register(process.stdout, selectors.EVENT_READ)
    expires = time.monotonic() + seconds; raw = bytearray()
    try:
        while selector.get_map():
            require(time.monotonic() < expires, 'BOOT_COMMAND_TIMEOUT_UNKNOWN')
            for item, _ in selector.select(min(.1, max(.001, expires - time.monotonic()))):
                chunk = os.read(item.fileobj.fileno(), min(65536, MAX_OUTPUT - len(raw) + 1))
                if not chunk: selector.unregister(item.fileobj); continue
                raw.extend(chunk); require(len(raw) <= MAX_OUTPUT, 'BOOT_COMMAND_OUTPUT_BOUND')
        code = process.wait(timeout=max(.001, expires - time.monotonic()))
        require(code == 0, 'BOOT_COMMAND_FAILED_UNKNOWN')
        return raw.decode().strip()
    finally:
        selector.close(); process.stdout.close()
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=5)


def native_host_id():
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args): return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request('http://169.254.169.254/computeMetadata/v1/instance/id',
                                     headers={'Metadata-Flavor': 'Google'})
    with opener.open(request, timeout=3) as response:
        require(response.status == 200 and response.headers.get('Metadata-Flavor') == 'Google'
                and response.geturl() == request.full_url, 'BOOT_METADATA_UNCONFIRMED')
        raw = response.read(33)
    value = raw.decode().strip()
    require(re.fullmatch('[1-9][0-9]{0,19}', value), 'BOOT_HOST_ID_INVALID')
    return value


class HostAdapter:
    def __init__(self):
        require(os.geteuid() == 0, 'BOOT_ROOT_REQUIRED')
        self.deadline = time.monotonic() + SECONDS
        self.locked = False; self.initial = None; self.core_ready = False
        self.dispatched = set(); self.allowed_starts = set(); self.journal_raw = None

    def remaining(self):
        value = self.deadline - time.monotonic(); require(value > 0, 'BOOT_DEADLINE_EXPIRED'); return value

    @contextmanager
    def locks(self):
        require(not self.locked, 'BOOT_LOCK_REENTRY')
        held = []
        try:
            for name in runtime.native.LOCKS:
                path = PRIVATE / name
                # Existing lock inode only; boot cannot invent lock custody.
                fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW); stream = os.fdopen(fd, 'r+b'); held.append(stream)
                info = os.fstat(fd)
                require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                        and stat.S_IMODE(info.st_mode) == 0o600, 'BOOT_LOCK_UNSAFE')
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.locked = True
            yield
        finally:
            self.locked = False
            for stream in reversed(held): stream.close()

    def command(self, argv, root):
        require(self.locked and argv[:1] == ['docker'] and Path(root) == self.release, 'BOOT_COMMAND_SCOPE')
        args = argv[1:]
        allowed = args == ['ps', '-aq', '--no-trunc']
        allowed = allowed or (args[:1] == ['inspect'] and len(args) >= 2 and all(runtime._hash(x) for x in args[1:]))
        allowed = allowed or (args[:2] == ['network', 'inspect'] and len(args) >= 3
                             and all(re.fullmatch('[A-Za-z0-9_.-]{1,128}', x) for x in args[2:]))
        allowed = allowed or (len(args) >= 4 and args[0] == 'exec' and args[1] in self.known_ids and
            args[2:] in (['cat', '/proc/net/route'], ['wget', '-qO-', 'http://127.0.0.1:2019/config/']))
        require(allowed, 'BOOT_READ_COMMAND_REJECTED')
        return bounded(self.docker + args, min(30, self.remaining()))

    def raw_observation(self):
        require(self.locked, 'BOOT_FOUR_LOCKS_REQUIRED'); self.remaining()
        policy_raw = protected(BASE / 'policy.json'); value = runtime._parse(policy_raw)
        adoption = protected(Path(policy.ADOPTION)); plan_raw = protected(Path(policy.PLAN))
        state = runtime._parse(adoption); runtime.validate_state(state); runtime.validate_plan(state, plan_raw)
        self.release = Path(state['current_release'])
        require((PRIVATE.parent / 'current').is_symlink() and
                (PRIVATE.parent / 'current').resolve(strict=True) == self.release, 'BOOT_CURRENT_RELEASE_CHANGED')
        plan = runtime._parse(plan_raw); config = Path(plan['docker_config_path'])
        require(config.is_relative_to(PRIVATE) and config.name == 'config.json' and
                runtime._parse(protected(config)) == {}, 'BOOT_DOCKER_CONFIG_CHANGED')
        self.docker = ['/usr/bin/docker', '--config', str(config.parent), '--host', 'unix:///var/run/docker.sock']
        self.known_ids = set(state['service_inventory'].values())
        ids = self.command(['docker', 'ps', '-aq', '--no-trunc'], self.release).split()
        require(len(ids) == len(set(ids)) and set(ids) == self.known_ids, 'BOOT_CLOSED_INVENTORY_CHANGED')
        rows = runtime._parse(self.command(['docker', 'inspect', *sorted(ids)], self.release).encode())
        require(type(rows) is list and len(rows) == len(ids) and
                {row['Id'] for row in rows} == set(state['preserved_runtime'])
                and all(runtime.definition_digest_matches(row, state['preserved_runtime'][row['Id']]) for row in rows),
                'BOOT_STATIC_INVENTORY_CHANGED')
        core_ids = {state['service_inventory'][name] for name in runtime.CORE}
        require(all(row['HostConfig'].get('RestartPolicy', {}).get('Name') == 'unless-stopped'
                    for row in rows if row['Id'] in core_ids), 'BOOT_CORE_RESTART_POLICY_CHANGED')
        boot = BOOT_ID.read_text().strip(); host = native_host_id()
        # Persisted reference validators also close schema and policy scope.
        identity = (policy_raw, adoption, plan_raw, host, boot)
        require(self.initial is None or identity == self.initial, 'BOOT_AUTHORITY_CHANGED')
        self.initial = identity
        return {'policy': value, 'adoption_raw': adoption, 'plan_raw': plan_raw,
                'host_id': host, 'boot_id': boot, 'rows': rows}, state, plan

    def canonical_guards(self, facts, state, plan):
        # Only the already authenticated plan chooses the existing B02 tool
        # hashes. No minimum-key read or backup operation is invoked.
        daily = PRIVATE / 'daily-b02'; sources = plan['controller_sources']
        require(set(sources) == {'b02-backup-root.py', 'b02_backup_contract.py', 'b02-portal-capsule.mjs'},
                'BOOT_B02_SOURCE_SET_CHANGED')
        for name, checksum in sources.items():
            require(runtime.sha256(protected(daily / name, private=False)) == checksum, 'BOOT_B02_SOURCE_CHANGED')
        runs = daily / 'runs'; info = runs.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
                'BOOT_B02_RUNS_REQUIRED')
        old = sys.modules.get('b02_backup_contract')
        def module(name, filename):
            spec = importlib.util.spec_from_file_location(name, daily / filename)
            result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result); return result
        try:
            sys.modules['b02_backup_contract'] = module('b02_backup_contract', 'b02_backup_contract.py')
            backup = module('boot_canonical_b02', 'b02-backup-root.py')
            adapter = self
            class Guard(backup.BackupRunner):
                def command(self, args, *, input=None):
                    require(input is None, 'BOOT_B02_WRITE_REJECTED')
                    return adapter.command(['docker', *args], adapter.release)
            guard = Guard(runtime.sha256(facts['plan_raw']))
            guard.runtime_guard(); guard.portal_guard()
        finally:
            if old is None: sys.modules.pop('b02_backup_contract', None)
            else: sys.modules['b02_backup_contract'] = old
        # Authenticate canonical files and the completed pair publication.
        for ref in state['canonical_files'].values(): runtime.native.read_reference(ref)
        runtime.native.read_reference(state['smtp_transition_ref']); runtime.native.read_reference(state['caddy_config_ref'])
        runtime.native.read_portal_references(state['portal'])
        receipt = runtime._parse(runtime.native.read_reference(state['last_release_receipt_ref']))
        directory = Path(state['last_release_receipt_ref']['path']).parent
        applied = runtime._parse(protected(directory / 'copy-runtime-transition.json'))
        complete = runtime._parse(protected(directory / 'report.json'))
        require(receipt.get('status') == 'VALIDATED_FOR_PAIR_CAS' and receipt.get('runtime_stage') == 'OPERATING'
                and runtime.pair_confirmed(receipt, state, facts['adoption_raw'], facts['plan_raw'], protected)
                and applied.get('status') == 'APPLIED' and complete.get('status') == 'SUCCEEDED'
                and complete.get('run_id') == receipt.get('run_id')
                and complete.get('source_sha') == receipt.get('source_sha'), 'BOOT_PAIR_NOT_CONFIRMED')
        services = runtime.validate_inventory(state, facts['rows'])
        networks = network_snapshot(self.command, self.release, services)
        require(networks == state['network_baseline'], 'BOOT_NETWORK_BASELINE_CHANGED')
        release = runtime.native.env_values(protected(PRIVATE / 'release.env'))
        require(release.get('COMMERCE_DEPLOY_SCOPE') == state['scope'] and
                release.get('COMMERCE_SECRETS_DIR') == str(PRIVATE), 'BOOT_RELEASE_SCOPE_CHANGED')
        runtime.topology(self.command, self.release, services, networks, release)
        runtime.verify_edge(self, self.release, state, services, release)
        require(runtime.native.active_proxy_digest(self.command, self.release, services) == state['active_proxy_sha256'],
                'BOOT_ACTIVE_PROXY_CHANGED')
        runtime.terminal_journals(PRIVATE, state, None)

    def observe(self):
        limit = min(self.deadline, time.monotonic() + CORE_SECONDS)
        while True:
            facts, state, plan = self.raw_observation()
            try:
                policy.validate_policy(facts['policy'], **{k: facts[k] for k in ('host_id', 'adoption_raw', 'plan_raw', 'rows')})
                break
            except runtime.ReleaseError as error:
                if str(error) not in {'BOOT_PROCESS_NOT_HEALTHY', 'COPY_RUNTIME_CORE_NOT_RUNNING'} or self.core_ready: raise
                require(time.monotonic() + 2 < limit, 'BOOT_CORE_HEALTH_TIMEOUT')
                time.sleep(2)
        self.core_ready = True; self.canonical_guards(facts, state, plan)
        return facts

    def read_journal(self, facts):
        require(self.locked, 'BOOT_FOUR_LOCKS_REQUIRED')
        value = {'schema_version': 1, 'boot_id': facts['boot_id'],
                 'policy_sha256': runtime.sha256(runtime.sealed_bytes(facts['policy'])), 'gateways': {}}
        policy.validate_journal(value, boot_id=facts['boot_id'], policy_sha256=value['policy_sha256'],
                                allowed=facts['policy']['gateway_start_ids'])
        self.journal_path = BASE / 'boots' / (facts['boot_id'] + '.json')
        protected_parents(self.journal_path)
        require(stat.S_IMODE(self.journal_path.parent.lstat().st_mode) == 0o700,
                'BOOT_JOURNAL_DIRECTORY_UNSAFE')
        claim = BASE / 'boots' / (facts['boot_id'] + '.once.json')
        claim_raw = runtime.sealed_bytes({'schema_version': 1, 'boot_id': value['boot_id'],
                                         'policy_sha256': value['policy_sha256']})
        if not os.path.lexists(claim):
            require(not os.path.lexists(self.journal_path), 'BOOT_JOURNAL_WITHOUT_CLAIM')
            durable_write(claim, claim_raw)
            durable_write(self.journal_path, runtime.sealed_bytes(value))
        require(protected(claim) == claim_raw and os.path.lexists(self.journal_path),
                'BOOT_JOURNAL_MISSING_NO_RESET')
        raw = protected(self.journal_path); value = runtime._parse(raw)
        policy.validate_journal(value, boot_id=facts['boot_id'],
            policy_sha256=runtime.sha256(runtime.sealed_bytes(facts['policy'])), allowed=facts['policy']['gateway_start_ids'])
        self.journal_raw = raw
        return value

    def compare_and_swap_journal(self, previous, value):
        require(self.locked and self.journal_raw is not None and
                runtime._parse(self.journal_raw) == previous, 'BOOT_JOURNAL_NOT_OBSERVED')
        durable_write(self.journal_path, runtime.sealed_bytes(value), previous=self.journal_raw)
        self.journal_raw = protected(self.journal_path)
        for name, row in value['gateways'].items():
            if name not in previous['gateways'] and row['status'] == 'START_INTENT':
                self.allowed_starts.add(row['container_id'])

    def start_once(self, cid):
        require(self.locked and cid not in self.dispatched and cid in self.allowed_starts,
                'BOOT_START_ALREADY_DISPATCHED')
        facts = self.observe(); journal = self.read_journal(facts)
        matches = [name for name, value in facts['policy']['gateway_start_ids'].items() if value == cid]
        require(len(matches) == 1 and journal['gateways'].get(matches[0]) ==
                {'container_id': cid, 'status': 'START_INTENT'}, 'BOOT_START_INTENT_REQUIRED')
        row = next(row for row in facts['rows'] if row['Id'] == cid)
        require(row['State']['Running'] is False, 'BOOT_START_ALREADY_RUNNING_RECONCILE_ONLY')
        self.allowed_starts.remove(cid); self.dispatched.add(cid)
        bounded(self.docker + ['start', cid], min(30, self.remaining()))

    def wait_healthy(self, cid):
        deadline = min(self.deadline, time.monotonic() + 60)
        while True:
            facts, state, plan = self.raw_observation()
            self.canonical_guards(facts, state, plan)
            row = next(row for row in facts['rows'] if row['Id'] == cid)
            try: policy.healthy(row); return
            except runtime.ReleaseError:
                require(time.monotonic() + 2 < deadline, 'BOOT_GATEWAY_HEALTH_TIMEOUT')
                time.sleep(2)

    def complete(self, boot_id):
        facts = self.observe(); require(facts['boot_id'] == boot_id, 'BOOT_ID_CHANGED')
        journal = self.read_journal(facts)
        require(all(v['status'] == 'RUNNING' for v in journal['gateways'].values())
                and set(journal['gateways']) == set(facts['policy']['gateway_start_ids']), 'BOOT_INCOMPLETE')
        current = policy.decisions(**facts, journal=journal)
        require(all(item['action'] == 'RECONCILE_RUNNING' for item in current), 'BOOT_GATEWAY_NOT_HEALTHY')
        path = BASE / 'boots' / (boot_id + '.complete.json')
        raw = runtime.sealed_bytes({'schema_version': 1, 'boot_id': boot_id,
            'policy_sha256': journal['policy_sha256'], 'status': 'HOST_GATEWAY_SERVERS_HEALTHY', 'sessions_started': 0})
        if os.path.lexists(path): require(protected(path) == raw, 'BOOT_COMPLETION_CHANGED')
        else: durable_write(path, raw)
