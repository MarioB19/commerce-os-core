"""Private admission custody inside the canonical four-lock publisher hook.

No CLI and no systemd/container effect. The transported envelope cannot choose
Root paths, the host identity, or gateway IDs. Journal intents precede all own
writes; existing unknown intents permit exact readback only, never another write.
"""
import base64
import datetime as dt
import os
from pathlib import Path
import stat
import time

from ci_release import require
import copy_runtime_deployment as runtime
import runtime_boot_admission as pure
import runtime_boot_host as host
import runtime_boot_install_gate as gate
import runtime_boot_install_host as files
import runtime_boot_policy as policy


def staged_input(entrypoint, expected_sha256):
    """Same Root-owned staging directory already checked twice by the client."""
    require(runtime._hash(expected_sha256), 'BOOT_INPUT_STAGING_HASH_REQUIRED')
    directory = Path(entrypoint).absolute().parent
    require(directory.name.startswith('commerce-ci-cb-') and not directory.is_symlink(),
            'BOOT_INPUT_STAGING_DIRECTORY_INVALID')
    before = directory.lstat()
    require(stat.S_ISDIR(before.st_mode) and before.st_uid == 0 and stat.S_IMODE(before.st_mode) == 0o700,
            'BOOT_INPUT_STAGING_CUSTODY_REQUIRED')
    # The OS Login home ancestors belong to that user; open the already sealed
    # Root directory by fd and read the fixed basename without following links.
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        root = os.fstat(fd)
        require((root.st_dev, root.st_ino) == (before.st_dev, before.st_ino), 'BOOT_INPUT_STAGING_CHANGED')
        item = os.open(pure.FILENAME, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
        with os.fdopen(item, 'rb') as stream:
            first = os.fstat(stream.fileno())
            require(stat.S_ISREG(first.st_mode) and first.st_uid == 0 and first.st_nlink == 1
                    and stat.S_IMODE(first.st_mode) == 0o600 and 0 < first.st_size <= pure.MAX_WIRE,
                    'BOOT_INPUT_STAGING_FILE_UNSAFE')
            raw = stream.read(pure.MAX_WIRE+1)
            fp = lambda x: (x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns,x.st_ctime_ns,x.st_mode,x.st_nlink)
            require(fp(first) == fp(os.fstat(stream.fileno())) == fp(os.stat(pure.FILENAME, dir_fd=fd, follow_symlinks=False))
                    and len(raw) == first.st_size and pure.checksum(raw) == expected_sha256,
                    'BOOT_INPUT_STAGING_CHANGED')
        require((directory.lstat().st_dev,directory.lstat().st_ino) == (before.st_dev,before.st_ino),
                'BOOT_INPUT_STAGING_CHANGED')
    finally: os.close(fd)
    pure.unpack(raw)
    return raw


class Custody:
    def __init__(self, report_dir, binding, fence):
        files.directory(report_dir)
        self.path = Path(report_dir)/'host-boot-admission.json'; self.binding = binding; self.fence = fence
        self.raw = None
        if os.path.lexists(self.path):
            self.raw = host.protected(self.path); self.value = runtime._parse(self.raw)
            require(type(self.value) is dict and set(self.value) == {'binding','actions'}
                    and self.value['binding'] == binding and type(self.value['actions']) is dict,
                    'BOOT_ADMISSION_JOURNAL_CHANGED')
        else:
            self.value = {'binding': binding, 'actions': {}}
            self.save()

    def save(self):
        self.fence()
        value = pure.sealed(self.value)
        require(len(value) <= host.MAX_OUTPUT, 'BOOT_ADMISSION_JOURNAL_BOUND')
        host.durable_write(self.path, value, previous=self.raw)
        self.raw = value

    def action(self, name, path, raw=None):
        path = Path(path)
        directory = name == 'evidence-directory'
        require((directory and path == gate.EVIDENCE and raw is None) or
                (name == 'approval' and path == gate.APPROVAL and type(raw) is bytes) or
                (name.startswith('original:') and path.parent == gate.EVIDENCE
                 and path.name == pure.checksum(raw)+'.json' and name == 'original:'+pure.checksum(raw)),
                'BOOT_ADMISSION_WRITE_SCOPE_INVALID')
        self.fence()
        require(host.protected(self.path) == self.raw, 'BOOT_ADMISSION_JOURNAL_CAS_CHANGED')
        exists = os.path.lexists(path)
        old = None
        if exists:
            if directory: files.directory(path)
            else: old = host.protected(path, maximum=pure.MAX_RAW)
        target = {'path':str(path),'sha256':None if directory else pure.checksum(raw)}
        previous = self.value['actions'].get(name)
        if previous is not None:
            require(set(previous) == {'target','previous_base64','status'} and previous['target'] == target
                    and previous['status'] in {'INTENT','VERIFIED'}, 'BOOT_ADMISSION_ACTION_CHANGED')
            require(exists and (directory or old == raw), 'BOOT_ADMISSION_UNKNOWN_RECONCILE_ONLY')
            if previous['status'] == 'INTENT': previous['status'] = 'VERIFIED'; self.save()
            return
        if not directory and path != gate.APPROVAL and exists:
            require(old == raw, 'BOOT_ADMISSION_HASH_CUSTODY_CHANGED')
        self.value['actions'][name] = {'target':target,'previous_base64':None if old is None or name != 'approval' else base64.b64encode(old).decode(),
                                      'status':'INTENT'}
        self.save()  # Consumed before native write, including an absent directory.
        self.fence()
        if not exists:
            if directory:
                host.protected_parents(path); path.mkdir(mode=0o700); files.sync_directory(path.parent); files.directory(path)
            else: files.replace_file(path, raw, None, 0o600, maximum=gate.restore.MAX_ORIGINAL_BYTES)
        elif not directory and old != raw:
            files.replace_file(path, raw, old, 0o600, maximum=gate.restore.MAX_ORIGINAL_BYTES)
        # A lost write acknowledgement remains INTENT; the next process cannot
        # infer permission from it. Exact readback alone may complete the row.
        self.value['actions'][name]['status'] = 'VERIFIED'; self.save()


def gateway_ids(before, state):
    result = {}
    for name in sorted(set(before['services']) & runtime.GATEWAYS):
        row = before['services'][name]
        require(type(row.get('State', {}).get('Running')) is bool, 'BOOT_ADMISSION_GATEWAY_STATE_INVALID')
        if row['State']['Running']:
            policy.healthy(row)
            require(state['service_inventory'].get(name) == row['Id'], 'BOOT_ADMISSION_GATEWAY_ID_CHANGED')
            result[name] = row['Id']
    return result


def prepare(server, root, report_dir, before, report, state_raw, plan_raw, backup, locks, deadline):
    require(os.geteuid() == 0 and Path(server.PRIVATE) == host.PRIVATE, 'BOOT_ADMISSION_ROOT_REQUIRED')
    root, report_dir = Path(root), Path(report_dir)
    require(report_dir == host.PRIVATE/'deployments'/report['run_id'], 'BOOT_ADMISSION_REPORT_PATH_CHANGED')
    files.directory(report_dir)
    raw = getattr(server, 'HOST_BOOT_INPUTS_RAW', None)
    value, _, _ = pure.unpack(raw)
    state = runtime._parse(state_raw); runtime.validate_plan(state, plan_raw)
    require(len(locks) == len(runtime.native.LOCKS), 'BOOT_ADMISSION_FOUR_LOCKS_REQUIRED')
    held = dict(zip(runtime.native.LOCKS, locks))
    def fence():
        require(deadline is None or time.monotonic() < deadline, 'BOOT_ADMISSION_DEADLINE')
        with backup.controller_update_locks(held):
            require(host.protected(host.PRIVATE/'api-web-adoption.json') == state_raw
                    and host.protected(host.PRIVATE/'daily-b02/plan.json') == plan_raw,
                    'BOOT_ADMISSION_APPLIED_PAIR_CHANGED')
            require(state['runtime_stage'] == 'OPERATING' and Path(state['current_release']) == root
                    and (host.PRIVATE.parent/'current').resolve(strict=True) == root,
                    'BOOT_ADMISSION_CURRENT_CHANGED')
            applied = runtime._parse(host.protected(report_dir/'copy-runtime-transition.json'))
            require(applied.get('status') == 'APPLIED' and applied.get('source_sha') == report['source_sha']
                    and applied.get('run_id') == report['run_id']
                    and applied.get('actual_state_sha256') == pure.checksum(state_raw)
                    and applied.get('actual_plan_sha256') == pure.checksum(plan_raw), 'BOOT_ADMISSION_PAIR_NOT_CONFIRMED')
        now = dt.datetime.now(dt.timezone.utc)
        require(gate.restore.stamp(value['created_at']) <= now < gate.restore.stamp(value['expires_at']),
                'BOOT_ADMISSION_EXPIRED_AFTER_READS')
    fence()
    gateways = gateway_ids(before, state)
    migrations = {p.name: pure.checksum(host.protected(p)) for p in sorted((root/'packages/db/migrations').glob('*.sql'))}
    sources = {name:pure.checksum(host.protected(root/name)) for name in gate.restore.RUNTIME}
    result = pure.produce(raw, report=report, host_id=host.native_host_id(), gateway_start_ids=gateways,
                          candidate_migrations=migrations, candidate_restore_sources=sources,
                          now=dt.datetime.now(dt.timezone.utc))
    fence()
    binding = {k:report[k] for k in ('source_sha','run_id','archive_sha256')}
    binding.update(input_sha256=result['input_sha256'], approval_sha256=pure.checksum(result['approval_raw']),
                   state_sha256=pure.checksum(state_raw), plan_sha256=pure.checksum(plan_raw))
    journal = Custody(report_dir, binding, fence)
    journal.action('evidence-directory', gate.EVIDENCE)
    for path, body in sorted(result['originals'].items()): journal.action('original:'+pure.checksum(body), path, body)
    journal.action('approval', gate.APPROVAL, result['approval_raw'])
    fence()
    return {'status':'CANONICAL_BOOT_ADMISSION_CUSTODIED', 'input_sha256':result['input_sha256'],
            'approval_sha256':pure.checksum(result['approval_raw']), 'journal_sha256':pure.checksum(journal.raw),
            'installation_verified':False}
