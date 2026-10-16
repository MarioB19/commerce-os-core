"""Installation adapter, invoked with the publisher's existing four locks.

Only exact own files, daemon-reload and enable (without --now) are dispatched.
No Docker start/restart/update, session operation, key read or backup execution.
Every mutation requires a newly committed in-memory permit; restart can only
read back an old intent. Previous installed bytes are retained in the journal.
"""
import base64
import copy
import datetime as dt
import os
from pathlib import Path
import re
import stat
import time

from ci_release import require
import copy_runtime_deployment as runtime
import runtime_boot_host as host
import runtime_boot_policy as policy_tools
import runtime_boot_install as bundle_tools
import runtime_boot_install_gate as gate

UNIT_PATH = Path('/etc/systemd/system') / bundle_tools.UNIT
UNITS = frozenset({'containerd.service', 'docker.service', bundle_tools.UNIT})
SHOW = ('LoadState', 'FragmentPath', 'NeedDaemonReload', 'UnitFileState', 'DropInPaths')


def directory(path):
    host.protected_parents(Path(path))
    info = Path(path).lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
            'BOOT_INSTALL_DIRECTORY_UNSAFE')


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def replace_file(path, raw, previous, mode, *, maximum=host.MAX_OUTPUT):
    """Only after intent; preserve old bytes and reject path/custody races."""
    path = Path(path); host.protected_parents(path)
    if previous is None:
        require(not os.path.lexists(path), 'BOOT_INSTALL_TARGET_APPEARED')
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw); stream.flush(); os.fchmod(stream.fileno(), mode); os.fsync(stream.fileno())
    else:
        require(host.protected(path, private=mode == 0o600, maximum=maximum) == previous, 'BOOT_INSTALL_FILE_CAS_CHANGED')
        # The fixed staging file is deliberately not cleared after ambiguity.
        temporary = path.with_name('.commerce-boot-'+path.name+'.pending')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw); stream.flush(); os.fchmod(stream.fileno(), mode); os.fsync(stream.fileno())
        require(host.protected(path, private=mode == 0o600, maximum=maximum) == previous, 'BOOT_INSTALL_FILE_CAS_CHANGED')
        os.replace(temporary, path)
    sync_directory(path.parent)
    require(host.protected(path, private=mode == 0o600, maximum=maximum) == raw
            and stat.S_IMODE(path.lstat().st_mode) == mode, 'BOOT_INSTALL_FILE_READBACK_CHANGED')


def installed_bundle(before, *, source_sha=None, root=None, historical_policy=None):
    """Read the last confirmed policy and its original installed bundle."""
    directory(host.BASE); directory(host.BASE/'tools'); directory(host.BASE/'boots')
    require({p.name for p in host.BASE.iterdir()} == {'tools', 'boots', 'sources.json', 'policy.json'}
            and {p.name for p in (host.BASE/'tools').iterdir()} == bundle_tools.FILES,
            'BOOT_INSTALL_PREVIOUS_SCOPE_CHANGED')
    files = {name: host.protected(host.BASE/name) for name in {'sources.json', 'policy.json'} | {'tools/'+n for n in bundle_tools.FILES}}
    if historical_policy is not None: files['policy.json'] = historical_policy
    manifest = runtime._parse(files['sources.json'])
    require(set(manifest) == {'schema_version', 'source_sha', 'files'} and manifest['schema_version'] == 1
            and set(manifest['files']) == bundle_tools.FILES
            and all(runtime.sha256(files['tools/'+n]) == v for n, v in manifest['files'].items()),
            'BOOT_INSTALL_PREVIOUS_SOURCES_CHANGED')
    unit = host.protected(UNIT_PATH, private=False)
    require(unit == bundle_tools.service_unit(runtime.sha256(files['sources.json'])), 'BOOT_INSTALL_PREVIOUS_UNIT_CHANGED')
    old_policy = runtime._parse(files['policy.json'])
    require(old_policy['adoption_ref'] == runtime.native.reference(host.PRIVATE/'api-web-adoption.json', before['state_raw'])
            and old_policy['plan_ref'] == runtime.native.reference(host.PRIVATE/'daily-b02/plan.json', before['plan_raw']),
            'BOOT_INSTALL_PREVIOUS_ADOPTION_CHANGED')
    previous_dir = Path(before['state']['last_release_receipt_ref']['path']).parent
    require(previous_dir.parent == host.PRIVATE/'deployments', 'BOOT_INSTALL_PREVIOUS_REPORT_SCOPE')
    completion_path = previous_dir/'host-boot-install.complete.json'
    completion_raw = host.protected(completion_path)
    completion = runtime._parse(completion_raw)
    require(completion.get('status') in {'HOST_BOOT_INSTALLED_REBOOT_NOT_VERIFIED', 'HOST_BOOT_POLICY_RECONCILED_INSTALLATION_PRESERVED'}
            and completion.get('context') == {'manifest_sha256': runtime.sha256(files['sources.json']),
                'policy_sha256': runtime.sha256(files['policy.json']), 'unit_sha256': runtime.sha256(unit)},
            'BOOT_INSTALL_PREVIOUS_NOT_CONFIRMED')
    prior_ref = completion.get('journal_ref')
    require(type(prior_ref) is dict and prior_ref.get('path') == str(previous_dir/'host-boot-install.json'),
            'BOOT_INSTALL_PREVIOUS_JOURNAL_SCOPE')
    previous_journal = runtime._parse(runtime.native.read_reference(prior_ref))
    require(previous_journal.get('context') == completion['context']
            and type(previous_journal.get('actions')) is dict and previous_journal['actions']
            and all(v.get('status') == 'CONFIRMED' for v in previous_journal['actions'].values()),
            'BOOT_INSTALL_PREVIOUS_JOURNAL_UNCONFIRMED')
    current_ref = runtime.native.reference(completion_path, completion_raw)
    origin_ref = current_ref
    if completion['status'] == 'HOST_BOOT_POLICY_RECONCILED_INSTALLATION_PRESERVED':
        origin_ref = completion.get('installation_ref')
        runtime.reference(origin_ref)
        origin_path = Path(origin_ref['path'])
        require(origin_path.name == 'host-boot-install.complete.json'
                and origin_path.parent.parent == host.PRIVATE/'deployments', 'BOOT_INSTALL_ORIGIN_SCOPE')
        origin = runtime._parse(runtime.native.read_reference(origin_ref))
        require(origin.get('status') == 'HOST_BOOT_INSTALLED_REBOOT_NOT_VERIFIED'
                and all(origin.get('context', {}).get(k) == completion['context'][k]
                        for k in ('manifest_sha256', 'unit_sha256')),
                'BOOT_INSTALL_ORIGIN_CHANGED')
        origin_journal_ref = origin.get('journal_ref')
        require(type(origin_journal_ref) is dict
                and origin_journal_ref.get('path') == str(origin_path.parent/'host-boot-install.json'),
                'BOOT_INSTALL_ORIGIN_JOURNAL_SCOPE')
        origin_journal = runtime._parse(runtime.native.read_reference(origin_journal_ref))
        require(origin_journal.get('context') == origin['context'] and origin_journal.get('actions')
                and all(v.get('status') == 'CONFIRMED' for v in origin_journal['actions'].values()),
                'BOOT_INSTALL_ORIGIN_UNCONFIRMED')
        require(set(previous_journal.get('actions', {})) == {'file:policy.json'}
                and previous_journal.get('installation_ref') == origin_ref
                and previous_journal['actions']['file:policy.json'].get('payload') ==
                    {'old_sha256': previous_journal.get('previous_policy_sha256'),
                     'sha256': runtime.sha256(files['policy.json'])},
                'BOOT_INSTALL_POLICY_JOURNAL_CHANGED')
    else:
        origin = completion
    if source_sha is not None:
        require(manifest['source_sha'] == source_sha
                and origin.get('native_gates', {}).get('provider_evidence', {}).get('source_sha') == source_sha,
                'BOOT_GATEWAY_INSTALLED_SOURCE_CHANGED')
        candidate = bundle_tools.prepare(root, source_sha)
        require(candidate['sources.json'] == files['sources.json'] and candidate[bundle_tools.UNIT] == unit
                and all(candidate['tools'][n] == files['tools/'+n] for n in bundle_tools.FILES),
                'BOOT_GATEWAY_INSTALLED_BUNDLE_CHANGED')
    files['@unit'] = unit
    return {'files': files, 'completion': completion, 'completion_ref': current_ref,
            'installation_ref': origin_ref, 'origin': origin, 'manifest': manifest}



class Installer:
    def __init__(self, server, root, report_dir, report, before, state_raw, plan_raw, backup, locks, deadline):
        require(os.geteuid() == 0 and Path(server.PRIVATE) == host.PRIVATE, 'BOOT_INSTALL_ROOT_REQUIRED')
        self.server = server; self.root = Path(root); self.report_dir = Path(report_dir)
        require(self.report_dir == host.PRIVATE/'deployments'/report['run_id'], 'BOOT_INSTALL_REPORT_PATH_CHANGED')
        directory(self.report_dir)
        self.report = copy.deepcopy(report); self.before = before; self.state_raw = state_raw; self.plan_raw = plan_raw
        self.state = runtime._parse(state_raw); self.plan = runtime._parse(plan_raw)
        self.backup = backup; self.locks = dict(zip(runtime.native.LOCKS, locks))
        require(len(locks) == len(runtime.native.LOCKS), 'BOOT_INSTALL_FOUR_LOCKS_REQUIRED')
        self.deadline = min(deadline if deadline is not None else time.monotonic()+300, time.monotonic()+300)
        self.approval_raw = host.protected(gate.APPROVAL); self.approval = runtime._parse(self.approval_raw)
        self.journal_path = self.report_dir/'host-boot-install.json'; self.journal_raw = None
        self.permits = set(); self.backup_evidence = None; self.native_result = None
        self.backup_fingerprints = None
        self.reader = host.HostAdapter()  # Normal constructor; bounded read-only command method only.
        self.reader.locked = True; self.reader.release = self.root; self.reader.deadline = self.deadline
        self.reader.known_ids = set(self.state['service_inventory'].values())
        config = Path(self.plan['docker_config_path'])
        require(config.is_relative_to(host.PRIVATE) and config.name == 'config.json'
                and runtime._parse(host.protected(config)) == {}, 'BOOT_INSTALL_DOCKER_CONFIG_CHANGED')
        self.reader.docker = ['/usr/bin/docker', '--config', str(config.parent), '--host', 'unix:///var/run/docker.sock']
        self.command = self.reader.command
        self.migrations = {p.name: runtime.sha256(host.protected(p)) for p in sorted((self.root/'packages/db/migrations').glob('*.sql'))}
        self.restore_sources = {name: runtime.sha256(host.protected(self.root/name)) for name in gate.restore.RUNTIME}

    def remaining(self):
        value = self.deadline-time.monotonic(); require(value > 0, 'BOOT_INSTALL_DEADLINE_EXPIRED'); return value

    @staticmethod
    def fingerprint(path):
        info = Path(path).lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600, 'BOOT_INSTALL_BACKUP_FILE_UNSAFE')
        return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def show(self, unit):
        require(unit in UNITS, 'BOOT_INSTALL_UNIT_SCOPE')
        raw = host.bounded(['/usr/bin/systemctl', 'show', '--property='+','.join(SHOW), '--', unit], min(10, self.remaining()))
        values = {}
        for line in raw.splitlines():
            key, sep, value = line.partition('=')
            require(sep and key in SHOW and key not in values, 'BOOT_INSTALL_SYSTEMD_READBACK_INVALID'); values[key] = value
        require(set(values) == set(SHOW), 'BOOT_INSTALL_SYSTEMD_READBACK_INVALID')
        return values

    def unit_identity(self, unit):
        view = self.show(unit); path = Path(view['FragmentPath'])
        allowed = {UNIT_PATH} if unit == bundle_tools.UNIT else {Path('/lib/systemd/system')/unit, Path('/usr/lib/systemd/system')/unit}
        require(view['LoadState'] == 'loaded' and path in allowed
                and view['UnitFileState'] in {'enabled', 'disabled'} and view['DropInPaths'] == '',
                'BOOT_INSTALL_UNIT_IDENTITY_CHANGED')
        # /lib can be the distribution's /usr/lib alias. Resolve only this fixed
        # system path; the target and all real parents must be Root-owned.
        raw = host.protected(path.resolve(strict=True), private=False)
        return {'path': str(path), 'sha256': runtime.sha256(raw)}

    def authorize(self, context, policy):
        self.remaining()
        self.context = context; self.policy = policy
        require(host.protected(gate.APPROVAL) == self.approval_raw, 'BOOT_INSTALL_APPROVAL_CHANGED')
        require(host.protected(host.PRIVATE/'api-web-adoption.json') == self.state_raw
                and host.protected(host.PRIVATE/'daily-b02/plan.json') == self.plan_raw,
                'BOOT_INSTALL_APPLIED_PAIR_CHANGED')
        require(self.state['runtime_stage'] == 'OPERATING' and Path(self.state['current_release']) == self.root
                and (host.PRIVATE.parent/'current').resolve(strict=True) == self.root, 'BOOT_INSTALL_CURRENT_CHANGED')
        with self.backup.controller_update_locks(self.locks):
            ids = self.command(['docker', 'ps', '-aq', '--no-trunc'], self.root).split()
            require(len(ids) == len(set(ids)) and set(ids) == self.reader.known_ids, 'BOOT_INSTALL_CLOSED_INVENTORY_CHANGED')
            rows = runtime._parse(self.command(['docker', 'inspect', *sorted(ids)], self.root).encode())
            host_id = host.native_host_id()
            services = policy_tools.validate_policy(policy, host_id=host_id,
                adoption_raw=self.state_raw, plan_raw=self.plan_raw, rows=rows)
            require(policy['gateway_start_ids'] == self.approval['gateway_start_ids'], 'BOOT_INSTALL_GATEWAY_SCOPE_CHANGED')
            require(all(services[name]['HostConfig'].get('RestartPolicy', {}).get('Name') == 'unless-stopped'
                        for name in runtime.CORE), 'BOOT_INSTALL_CORE_POLICY_NOT_ADOPTED')
            for name in policy['gateway_start_ids']: policy_tools.healthy(services[name])
            # The canonical constructor calls mkdir(exist_ok=True). Require
            # its Root-owned directory already present before constructing it,
            # so admission cannot accidentally create a missing B02 directory.
            directory(host.PRIVATE/'daily-b02/runs')
            adapter = self
            class Guard(self.backup.BackupRunner):
                def command(self, args, *, input=None):
                    require(input is None, 'BOOT_INSTALL_B02_WRITE_REJECTED')
                    return adapter.command(['docker', *args], adapter.root)
            guard = Guard(runtime.sha256(self.plan_raw)); guard.runtime_guard(); guard.portal_guard()
            for ref in self.state['canonical_files'].values(): runtime.native.read_reference(ref)
            runtime.native.read_reference(self.state['smtp_transition_ref']); runtime.native.read_reference(self.state['caddy_config_ref'])
            runtime.native.read_portal_references(self.state['portal'])
            applied = runtime._parse(host.protected(self.report_dir/'copy-runtime-transition.json'))
            require(applied.get('status') == 'APPLIED' and applied.get('source_sha') == self.report['source_sha']
                    and applied.get('run_id') == self.report['run_id']
                    and applied.get('actual_state_sha256') == runtime.sha256(self.state_raw)
                    and applied.get('actual_plan_sha256') == runtime.sha256(self.plan_raw), 'BOOT_INSTALL_PAIR_NOT_CONFIRMED')
            networks = host.network_snapshot(self.command, self.root, services)
            require(networks == self.state['network_baseline'], 'BOOT_INSTALL_NETWORK_CHANGED')
            release = runtime.native.env_values(host.protected(host.PRIVATE/'release.env'))
            runtime.topology(self.command, self.root, services, networks, release)
            runtime.verify_edge(self.reader, self.root, self.state, services, release)
            require(runtime.native.active_proxy_digest(self.command, self.root, services) == self.state['active_proxy_sha256'],
                    'BOOT_INSTALL_PROXY_CHANGED')
            runtime.terminal_journals(host.PRIVATE, self.state, self.report_dir)
            self.native_result = gate.validate(self.approval, report=self.report, host_id=host_id,
                candidate_migrations=self.migrations, candidate_restore_sources=self.restore_sources,
                now=dt.datetime.now(dt.timezone.utc))
            if self.backup_evidence is None:
                log_path = self.report_dir/'prepare.log'
                log = runtime.native.protected_bytes(log_path, maximum=64*1024*1024)
                candidates = []
                for line in log.decode(errors='replace').splitlines():
                    if not line.startswith('{'): continue
                    try: item = runtime._parse(line.encode())
                    except (ValueError, TypeError): continue
                    if type(item) is dict and 'backup' in item: candidates.append(item)
                require(len(candidates) == 1, 'BOOT_INSTALL_BACKUP_RESULT_REQUIRED')
                backup_path = Path(candidates[0]['backup'])
                require(backup_path.parent == host.PRIVATE/'backups', 'BOOT_INSTALL_BACKUP_PATH_CHANGED')
                self.backup_fingerprints = {p: self.fingerprint(p) for p in (log_path, backup_path)}
                self.backup_evidence = runtime.native.verify_predeploy_backup(host.PRIVATE, self.report_dir)
            require(self.backup_evidence == self.report.get('predeploy_backup'), 'BOOT_INSTALL_FRESH_BACKUP_CHANGED')
            require(all(self.fingerprint(p) == value for p, value in self.backup_fingerprints.items()),
                    'BOOT_INSTALL_BACKUP_FILE_CHANGED')
            # The journal pins system-owned core unit definitions, too. No
            # adoption of changed systemd units during this transaction.
            if self.journal_raw is not None:
                j = self.read_journal()
                require(all(self.unit_identity(n) == j['core_units'][n] for n in ('containerd.service', 'docker.service')),
                        'BOOT_INSTALL_CORE_UNITS_CHANGED')
        # Native gates, backup hashing and systemd reads above are bounded but
        # can still cross the shorter approval expiry. Fence wall time again
        # after every I/O, including the post-intent authorization path.
        moment = dt.datetime.now(dt.timezone.utc)
        require(gate.restore.stamp(self.approval['created_at']) <= moment
                < gate.restore.stamp(self.approval['expires_at']), 'BOOT_INSTALL_APPROVAL_EXPIRED_AFTER_READS')
        self.remaining()

    def path(self, kind, name):
        if kind == 'directory' and name in {'base', 'tools', 'boots'}:
            return host.BASE if name == 'base' else host.BASE/name
        if kind == 'file' and name in {'sources.json', 'policy.json'} | {'tools/'+n for n in bundle_tools.FILES}:
            return host.BASE/name
        if kind == 'unit-file' and name == bundle_tools.UNIT: return UNIT_PATH
        raise runtime.ReleaseError('BOOT_INSTALL_TARGET_SCOPE')

    def previous(self):
        """Authenticate an earlier completed own bundle, or total absence."""
        if not os.path.lexists(host.BASE):
            require(not os.path.lexists(UNIT_PATH) and self.show(bundle_tools.UNIT)['LoadState'] == 'not-found',
                    'BOOT_INSTALL_FOREIGN_UNIT_PRESENT')
            return {}
        previous = installed_bundle(self.before)
        return {name: base64.b64encode(raw).decode() for name, raw in previous['files'].items()}

    def open_journal(self, context):
        if not os.path.lexists(self.journal_path):
            value = {'schema_version': 1, 'context': context, 'approval_sha256': runtime.sha256(self.approval_raw),
                'previous': self.previous(), 'core_units': {n: self.unit_identity(n) for n in ('containerd.service', 'docker.service')}, 'actions': {}}
            host.durable_write(self.journal_path, runtime.sealed_bytes(value))
        self.journal_raw = host.protected(self.journal_path)
        value = self.read_journal()
        require(value['context'] == context and value['approval_sha256'] == runtime.sha256(self.approval_raw),
                'BOOT_INSTALL_JOURNAL_CHANGED')
        return value

    def read_journal(self):
        require(self.journal_raw is not None and host.protected(self.journal_path) == self.journal_raw,
                'BOOT_INSTALL_JOURNAL_CAS_CHANGED')
        return runtime._parse(self.journal_raw)

    def update(self, value):
        raw = runtime.sealed_bytes(value); host.durable_write(self.journal_path, raw, previous=self.journal_raw); self.journal_raw = raw

    def observe_action(self, action, payload):
        value = self.read_journal(); require(action not in value['actions'], 'BOOT_INSTALL_ACTION_EXISTS')
        value['actions'][action] = {'payload': payload, 'status': 'INTENT', 'dispatched': False}; self.update(value)

    def commit_intent(self, action, payload):
        self.observe_action(action, payload); self.permits.add(action)

    def confirm_action(self, action, payload):
        value = self.read_journal(); require(value['actions'][action]['payload'] == payload, 'BOOT_INSTALL_ACTION_CHANGED')
        value['actions'][action]['status'] = 'CONFIRMED'; self.update(value)

    def unknown(self, action, error_type):
        value = self.read_journal(); value['actions'][action]['error_type'] = error_type; self.update(value)

    def confirm(self, kind, name, raw):
        if kind in {'directory', 'file', 'unit-file'}:
            path = self.path(kind, name)
            if not os.path.lexists(path): return False
            if kind == 'directory': directory(path); return True
            mode = 0o644 if kind == 'unit-file' else 0o600
            return host.protected(path, private=mode == 0o600) == raw and stat.S_IMODE(path.lstat().st_mode) == mode
        if kind == 'reload' and name == 'systemd':
            view = self.show(bundle_tools.UNIT)
            return (view['LoadState'] == 'loaded' and view['FragmentPath'] == str(UNIT_PATH)
                    and view['NeedDaemonReload'] == 'no' and view['DropInPaths'] == '')
        if kind == 'enable' and name in UNITS:
            self.unit_identity(name)
            return self.show(name)['UnitFileState'] == 'enabled'
        raise runtime.ReleaseError('BOOT_INSTALL_EFFECT_SCOPE')

    def dispatch_once(self, kind, name, raw):
        action = kind+':'+name; require(action in self.permits, 'BOOT_INSTALL_NEW_INTENT_REQUIRED')
        self.permits.remove(action); value = self.read_journal()
        require(value['actions'][action]['status'] == 'INTENT', 'BOOT_INSTALL_INTENT_REQUIRED')
        value['actions'][action]['dispatched'] = True; self.update(value)
        self.authorize(self.context, self.policy)
        if kind == 'directory':
            path = self.path(kind, name); host.protected_parents(path)
            require(not os.path.lexists(path), 'BOOT_INSTALL_DIRECTORY_APPEARED')
            path.mkdir(mode=0o700); sync_directory(path.parent); return
        if kind in {'file', 'unit-file'}:
            previous = value['previous'].get('@unit' if kind == 'unit-file' else name)
            previous = None if previous is None else base64.b64decode(previous, validate=True)
            replace_file(self.path(kind, name), raw, previous, 0o644 if kind == 'unit-file' else 0o600); return
        if kind == 'reload' and name == 'systemd':
            host.bounded(['/usr/bin/systemctl', 'daemon-reload'], min(30, self.remaining())); return
        if kind == 'enable' and name in UNITS:
            self.unit_identity(name)
            host.bounded(['/usr/bin/systemctl', 'enable', '--', name], min(30, self.remaining())); return
        raise runtime.ReleaseError('BOOT_INSTALL_EFFECT_SCOPE')

    def complete(self, result):
        value = self.read_journal()
        require(all(v['status'] == 'CONFIRMED' for v in value['actions'].values()), 'BOOT_INSTALL_INCOMPLETE')
        result = {**result, 'journal_ref': runtime.native.reference(self.journal_path, self.journal_raw),
            'approval_ref': runtime.native.reference(gate.APPROVAL, self.approval_raw),
            'native_gates': self.native_result, 'predeploy_backup': self.backup_evidence}
        path = self.report_dir/'host-boot-install.complete.json'; raw = runtime.sealed_bytes(result)
        if os.path.lexists(path): require(host.protected(path) == raw, 'BOOT_INSTALL_COMPLETION_CHANGED')
        else: host.durable_write(path, raw)
        return result


class GatewayPolicy(Installer):
    """Own canonical policy admission; the immutable installation is preserved."""
    def __init__(self, server, root, report_dir, before, services, report, locks, deadline, *, recovery=None):
        require(os.geteuid() == 0 and Path(server.PRIVATE) == host.PRIVATE,
                'BOOT_GATEWAY_ROOT_REQUIRED')
        self.server = server; self.root = Path(root); self.report_dir = Path(report_dir)
        directory(self.report_dir)
        require(self.report_dir == host.PRIVATE/'deployments'/report['run_id']
                and report.get('action') == 'RECONCILE_CANONICAL_GATEWAY_INVENTORY',
                'BOOT_GATEWAY_CANONICAL_ACTION_REQUIRED')
        self.report = copy.deepcopy(report); self.before = before
        self.services = copy.deepcopy(services); self.locks = dict(zip(runtime.native.LOCKS, locks))
        require(len(locks) == len(runtime.native.LOCKS) and all(not x.closed for x in locks),
                'BOOT_GATEWAY_FOUR_LOCKS_REQUIRED')
        self.deadline = min(deadline, time.monotonic()+300)
        self.readback_only = recovery is not None
        self.recovery = recovery
        self.previous_bundle = installed_bundle(before, source_sha=report['source_sha'], root=self.root,
            historical_policy=None if recovery is None else base64.b64decode(recovery['previous_policy'], validate=True))
        self.old_policy_raw = self.previous_bundle['files']['policy.json']
        self.old_policy = runtime._parse(self.old_policy_raw)
        self.host_id = host.native_host_id()
        policy_tools.validate_policy(self.old_policy, host_id=self.host_id,
            adoption_raw=before['state_raw'], plan_raw=before['plan_raw'], rows=list(before['services'].values()))
        require(all(name in services and services[name]['Id'] == cid
                    for name, cid in self.old_policy['gateway_start_ids'].items()), 'BOOT_GATEWAY_PRIOR_CID_CHANGED')
        self.gateways = dict(self.old_policy['gateway_start_ids'])
        for name in set(services) & runtime.GATEWAYS:
            if services[name]['State']['Running']:
                policy_tools.healthy(services[name]); self.gateways[name] = services[name]['Id']
        self.approval_ref = report['approval_ref']
        require(Path(self.approval_ref['path']).parent == host.PRIVATE/'controller-approvals',
                'BOOT_GATEWAY_APPROVAL_SCOPE')
        self.manifest_raw = runtime.native.read_reference(self.approval_ref)
        self.manifest = runtime._parse(self.manifest_raw)
        require(self.manifest['source_sha'] == report['source_sha'] and self.manifest['run_id'] == report['run_id']
                and self.manifest['before_adoption_sha256'] == runtime.sha256(before['state_raw'])
                and self.manifest['before_plan_sha256'] == runtime.sha256(before['plan_raw']),
                'BOOT_GATEWAY_APPROVAL_CHANGED')
        self.runtime_raw = runtime.native.read_reference(self.manifest['runtime_before_ref'])
        captured = gate.restore.stamp(runtime._parse(self.runtime_raw)['captured_at'])
        self.admission_path = self.report_dir/'host-boot-gateway-admission.json'
        saved = None if recovery is None else runtime._parse(runtime.native.read_reference(recovery['admission_ref']))
        self.created_at = dt.datetime.now(dt.timezone.utc) if saved is None else gate.restore.stamp(saved['created_at'])
        self.expires_at = min(self.created_at+dt.timedelta(minutes=15), captured+dt.timedelta(hours=1))
        require(saved is None or gate.restore.stamp(saved['expires_at']) == self.expires_at, 'BOOT_GATEWAY_WINDOW_CHANGED')
        self.reader = host.HostAdapter(); self.reader.locked = True; self.reader.release = self.root
        self.reader.deadline = self.deadline; self.reader.known_ids = {r['Id'] for r in services.values()}
        config = Path(runtime._parse(before['plan_raw'])['docker_config_path'])
        require(config.is_relative_to(host.PRIVATE) and config.name == 'config.json'
                and runtime._parse(host.protected(config)) == {}, 'BOOT_GATEWAY_DOCKER_CONFIG_CHANGED')
        self.reader.docker = ['/usr/bin/docker', '--config', str(config.parent), '--host', 'unix:///var/run/docker.sock']
        self.command = self.reader.command
        self.units = {n: self.unit_identity(n) for n in UNITS} if saved is None else saved['unit_identity']
        origin_journal = runtime._parse(runtime.native.read_reference(self.previous_bundle['origin']['journal_ref']))
        require(origin_journal.get('core_units') == {n: self.units[n] for n in ('containerd.service', 'docker.service')},
                'BOOT_GATEWAY_ORIGINAL_CORE_UNITS_CHANGED')
        self.policy_readback = recovery is not None
        self.state_raw = before['state_raw']; self.plan_raw = before['plan_raw']; self.applied = False
        self.commercial_sha256 = runtime.commercial_snapshot(server, self.root) if saved is None else saved['commercial_sha256']
        if recovery is None: self.fence()
        self.admission = {'schema_version': 1, 'kind': 'CANONICAL_GATEWAY_BOOT_POLICY',
            'source_sha': report['source_sha'], 'run_id': report['run_id'], 'host_id': self.host_id,
            'created_at': self.created_at.isoformat(), 'expires_at': self.expires_at.isoformat(),
            'approval_ref': self.approval_ref, 'runtime_before_ref': self.manifest['runtime_before_ref'],
            'previous_completion_ref': self.previous_bundle['completion_ref'],
            'installation_ref': self.previous_bundle['installation_ref'],
            'before_adoption_sha256': runtime.sha256(before['state_raw']),
            'before_plan_sha256': runtime.sha256(before['plan_raw']),
            'previous_policy_sha256': runtime.sha256(self.old_policy_raw), 'gateway_start_ids': self.gateways,
            'service_inventory': {n: r['Id'] for n, r in services.items()}, 'unit_identity': self.units,
            'manifest_sha256': runtime.sha256(self.previous_bundle['files']['sources.json']),
            'observed_policy_sha256': runtime.sha256(runtime.sealed_bytes(before['policy'])),
            'commercial_sha256': self.commercial_sha256}
        self.admission_raw = runtime.sealed_bytes(self.admission)
        if saved is None: host.durable_write(self.admission_path, self.admission_raw)
        else:
            require(saved == self.admission and recovery['admission_ref'] ==
                runtime.native.reference(self.admission_path, self.admission_raw), 'BOOT_GATEWAY_RECOVERY_ADMISSION_CHANGED')

    def fence(self):
        self.remaining()
        require(all(not x.closed for x in self.locks.values()), 'BOOT_GATEWAY_LOCK_RELEASED')
        require(host.native_host_id() == self.host_id and (host.PRIVATE.parent/'current').resolve(strict=True) == self.root,
                'BOOT_GATEWAY_HOST_OR_RELEASE_CHANGED')
        runtime.current_source_guard(self.server, self.root)
        require(runtime.native.read_reference(self.approval_ref) == self.manifest_raw
                and runtime.native.read_reference(self.manifest['runtime_before_ref']) == self.runtime_raw,
                'BOOT_GATEWAY_APPROVAL_CHANGED')
        require(host.protected(host.PRIVATE/'api-web-adoption.json') == self.state_raw
                and host.protected(host.PRIVATE/'daily-b02/plan.json') == self.plan_raw,
                'BOOT_GATEWAY_PAIR_CHANGED')
        require(host.protected(host.BASE/'policy.json') == (runtime.sealed_bytes(self.policy)
                if self.policy_readback else self.old_policy_raw), 'BOOT_GATEWAY_POLICY_CAS_CHANGED')
        for name, raw in self.previous_bundle['files'].items():
            if name == 'policy.json': continue
            require(host.protected(UNIT_PATH, private=False) == raw if name == '@unit'
                    else host.protected(host.BASE/name) == raw, 'BOOT_GATEWAY_IMMUTABLE_BUNDLE_CHANGED')
        runtime.native.read_reference(self.previous_bundle['completion_ref'])
        for name in UNITS:
            require(self.unit_identity(name) == self.units[name]
                    and self.show(name)['UnitFileState'] == 'enabled'
                    and self.show(name)['NeedDaemonReload'] == 'no', 'BOOT_GATEWAY_UNIT_CHANGED')
        observed = runtime.current_policy(self.server, self.root, self.before['workspace'])
        require(observed == self.before['policy'] and observed['body']['dispatch_frozen'] is True
                and observed['body']['real_sends_enabled'] is False
                and observed['body']['allow_real_operations'] is False, 'BOOT_GATEWAY_PAUSE_CHANGED')
        require(runtime.commercial_snapshot(self.server, self.root) == self.commercial_sha256
                and runtime._parse(runtime.native.read_reference(self.manifest['ownership_observation_ref']))
                == runtime.ownership_projection(self.server, self.root, self.before['workspace']),
                'BOOT_GATEWAY_COMMERCIAL_OR_OWNERSHIP_CHANGED')
        ids = self.command(['docker', 'ps', '-aq', '--no-trunc'], self.root).split()
        require(len(ids) == len(set(ids)) and set(ids) == self.reader.known_ids,
                'BOOT_GATEWAY_INVENTORY_CHANGED')
        rows = runtime._parse(self.command(['docker', 'inspect', *sorted(ids)], self.root).encode())
        current = runtime.inspect_inventory(rows, portal=self.before['state']['portal'],
            caddy_id=self.before['state']['service_inventory']['caddy'])
        runtime.compare_live_snapshot(self.services, current)
        for name in runtime.CORE | set(self.gateways): policy_tools.healthy(current[name])
        require(all(current[n]['HostConfig'].get('RestartPolicy', {}).get('Name') == 'unless-stopped'
                    for n in runtime.CORE), 'BOOT_GATEWAY_CORE_POLICY_CHANGED')
        if self.applied:
            services = policy_tools.validate_policy(self.policy, host_id=self.host_id,
                adoption_raw=self.state_raw, plan_raw=self.plan_raw, rows=rows)
            with self.backup.controller_update_locks(self.locks):
                directory(host.PRIVATE/'daily-b02/runs')
                adapter = self
                class Guard(self.backup.BackupRunner):
                    def command(self, args, *, input=None):
                        require(input is None, 'BOOT_GATEWAY_B02_WRITE_REJECTED')
                        return adapter.command(['docker', *args], adapter.root)
                guard = Guard(runtime.sha256(self.plan_raw)); guard.runtime_guard(); guard.portal_guard()
                state = runtime._parse(self.state_raw)
                for ref in state['canonical_files'].values(): runtime.native.read_reference(ref)
                runtime.native.read_reference(state['smtp_transition_ref']); runtime.native.read_reference(state['caddy_config_ref'])
                runtime.native.read_portal_references(state['portal'])
                networks = host.network_snapshot(self.command, self.root, services)
                require(networks == state['network_baseline'], 'BOOT_GATEWAY_NETWORK_CHANGED')
                release = runtime.native.env_values(host.protected(host.PRIVATE/'release.env'))
                runtime.topology(self.command, self.root, services, networks, release)
                runtime.verify_edge(self.reader, self.root, state, services, release)
                require(runtime.native.active_proxy_digest(self.command, self.root, services) == state['active_proxy_sha256'],
                        'BOOT_GATEWAY_PROXY_CHANGED')
                applied = runtime._parse(host.protected(self.report_dir/'copy-runtime-transition.json'))
                require(applied.get('status') == 'APPLIED' and applied.get('run_id') == self.report['run_id']
                        and applied.get('source_sha') == self.report['source_sha']
                        and applied.get('actual_state_sha256') == runtime.sha256(self.state_raw)
                        and applied.get('actual_plan_sha256') == runtime.sha256(self.plan_raw), 'BOOT_GATEWAY_PAIR_NOT_CONFIRMED')
        now = dt.datetime.now(dt.timezone.utc)
        require(self.created_at <= now and (self.readback_only or now < self.expires_at), 'BOOT_GATEWAY_ADMISSION_EXPIRED')
        self.remaining()

    def apply(self, state_raw, plan_raw, backup):
        self.state_raw = state_raw; self.plan_raw = plan_raw; self.backup = backup; self.applied = True
        self.policy = dict(self.old_policy, adoption_ref=runtime.native.reference(host.PRIVATE/'api-web-adoption.json', state_raw),
            plan_ref=runtime.native.reference(host.PRIVATE/'daily-b02/plan.json', plan_raw), gateway_start_ids=self.gateways)
        raw = runtime.sealed_bytes(self.policy)
        context = {'manifest_sha256': self.admission['manifest_sha256'], 'policy_sha256': runtime.sha256(raw),
            'unit_sha256': runtime.sha256(self.previous_bundle['files']['@unit'])}
        journal_path = self.report_dir/'host-boot-install.json'
        require(host.protected(self.admission_path) == self.admission_raw, 'BOOT_GATEWAY_ADMISSION_CHANGED')
        self.fence()
        payload = {'old_sha256': runtime.sha256(self.old_policy_raw), 'sha256': runtime.sha256(raw)}
        journal = {'schema_version': 1, 'context': context, 'installation_ref': self.previous_bundle['installation_ref'],
            'admission_ref': runtime.native.reference(self.admission_path, self.admission_raw),
            'previous_policy_sha256': runtime.sha256(self.old_policy_raw),
            'before_state': base64.b64encode(self.before['state_raw']).decode(),
            'before_plan': base64.b64encode(self.before['plan_raw']).decode(),
            'previous_policy': base64.b64encode(self.old_policy_raw).decode(),
            'policy': base64.b64encode(raw).decode(),
            'actions': {'file:policy.json': {'status': 'INTENT', 'payload': payload}}}
        journal_raw = runtime.sealed_bytes(journal)
        # An inherited intent is never a permit. This object is created only
        # before the canonical pair CAS; a new process reconciles read-only.
        if self.readback_only:
            require(self.recovery == journal or self.recovery == dict(journal, actions={
                'file:policy.json': {'status': 'CONFIRMED', 'payload': payload}}), 'BOOT_GATEWAY_RECOVERY_JOURNAL_CHANGED')
            journal_raw = host.protected(journal_path)
            require(runtime._parse(journal_raw) == self.recovery, 'BOOT_GATEWAY_RECOVERY_JOURNAL_CHANGED')
            require(host.protected(host.BASE/'policy.json') == raw, 'BOOT_GATEWAY_UNKNOWN_NO_RETRY')
        else:
            host.durable_write(journal_path, journal_raw)
            self.fence()
            replace_file(host.BASE/'policy.json', raw, self.old_policy_raw, 0o600)
            self.policy_readback = True
        self.fence()
        require(host.protected(host.BASE/'policy.json') == raw, 'BOOT_GATEWAY_POLICY_READBACK_CHANGED')
        journal['actions']['file:policy.json']['status'] = 'CONFIRMED'
        confirmed = runtime.sealed_bytes(journal)
        if confirmed != journal_raw: host.durable_write(journal_path, confirmed, previous=journal_raw)
        self.fence()
        result = {'status': 'HOST_BOOT_POLICY_RECONCILED_INSTALLATION_PRESERVED', 'context': context,
            'journal_ref': runtime.native.reference(journal_path, confirmed),
            'admission_ref': runtime.native.reference(self.admission_path, self.admission_raw),
            'installation_ref': self.previous_bundle['installation_ref'],
            'container_starts': 0, 'sessions_started': 0, 'tools_installed': False,
            'reboot_verified': False, 'new_full_proven': False}
        completion_path = self.report_dir/'host-boot-install.complete.json'; completion_raw = runtime.sealed_bytes(result)
        if os.path.lexists(completion_path): require(host.protected(completion_path) == completion_raw, 'BOOT_GATEWAY_COMPLETION_CHANGED')
        else: host.durable_write(completion_path, completion_raw)
        return result
