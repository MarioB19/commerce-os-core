"""Existing-runtime API/web publication guards. No I/O on import.

The initial incident adoption writes the root-only state AFTER authenticating
the SMTP-disabled transition. This module consumes that state; it never creates
credentials, adopts an unobserved runtime, or grants permission from CI variables.
"""
import copy
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
from ci_release import ReleaseError, require

FILES = ('release.env', 'api.env', 'ingress.env', 'automation.env', 'channel.env',
         'postgres.env', 'admin.env', 'backup.env')
LOCKS = ('daily-b02-controller.lock', 'ci-deploy.lock', 'backup-schedule.lock',
         'maintenance-backup.lock')
TERMINAL = {'SUCCEEDED', 'FAILED', 'FAILED_RECONCILED'}
# V7 F1 PITR: PostgreSQL may join this egress-only bridge (scripts/v7_pitr.py).
PITR_NETWORK = 'commerce-os_pitr-edge'
MAX_PRIVATE = 1024 * 1024
SOURCE_SHA = 'd36c090161eb7b0af0250cd91d466b38dc810813'
PORTAL_BASE = Path('/opt/mcl-portal')
PORTAL_FIELDS = {'report_ref', 'runtime_env_ref', 'manifest_ref', 'container_id',
                 'image', 'proxy_network', 'source_sha', 'run_id'}


def unique_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'COPY_DUPLICATE_JSON_FIELD')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs)


def protected_bytes(path, maximum=MAX_PRIVATE):
    path = Path(path)
    require(path.is_absolute(), 'COPY_PRIVATE_PATH_REQUIRED')
    for parent in (path.parent, *path.parent.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and not info.st_mode & 0o022, 'COPY_PRIVATE_PARENT_UNSAFE')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
                'COPY_PRIVATE_FILE_UNSAFE')
        raw = source.read(maximum + 1)
        require(0 < len(raw) <= maximum, 'COPY_PRIVATE_FILE_BOUND')
        after = os.fstat(source.fileno())
        require((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                == (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns),
                'COPY_PRIVATE_FILE_CHANGED')
        return raw


def reference(path, raw):
    return {'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def read_reference(value):
    require(isinstance(value, dict) and set(value) == {'path', 'bytes', 'sha256'}
            and type(value['bytes']) is int and 0 < value['bytes'] <= MAX_PRIVATE
            and re.fullmatch(r'[a-f0-9]{64}', value['sha256']), 'COPY_REFERENCE_INVALID')
    raw = protected_bytes(value['path'])
    require(reference(value['path'], raw) == value, 'COPY_REFERENCE_CHANGED')
    return raw


def env_values(raw):
    values = {}
    try: lines = raw.decode().splitlines()
    except UnicodeDecodeError: raise ReleaseError('COPY_ENV_INVALID') from None
    for line in lines:
        if not line or line.startswith('#'):
            continue
        require('=' in line, 'COPY_ENV_INVALID')
        key, value = line.split('=', 1)
        require(re.fullmatch(r'[A-Z][A-Z0-9_]*', key) and key not in values,
                'COPY_ENV_INVALID')
        values[key] = value
    return values


def validate_state(state, private):
    fields = {
        'schema_version', 'status', 'scope', 'backup_source_sha', 'current_release',
        'smtp_transition_ref', 'canonical_files', 'preserved_runtime', 'b02_plan_sha256',
        'network_baseline', 'active_proxy_sha256', 'caddy_config_ref', 'policy_version', 'firewall_rule_count'}
    require(isinstance(state, dict) and type(state.get('schema_version')) is int
            and state['schema_version'] in (1, 2), 'COPY_ADOPTION_STATE_INVALID')
    portal = state.get('portal') if state['schema_version'] == 2 else None
    require(set(state) == fields | ({'portal'} if state['schema_version'] == 2 else set()),
            'COPY_ADOPTION_STATE_INVALID')
    if state['schema_version'] == 2:
        validate_portal_state(portal, private)
    require(state['status'] == 'ADOPTED_EXISTING_API_WEB'
            and state['scope'] == 'api-web' and state['backup_source_sha'] == SOURCE_SHA
            and state['policy_version'] == 93 and state['firewall_rule_count'] == 9,
            'COPY_ADOPTION_NOT_APPROVED')
    require(isinstance(state['current_release'], str)
            and Path(state['current_release']).parent == private.parent / 'releases',
            'COPY_ADOPTED_RELEASE_INVALID')
    require(isinstance(state['canonical_files'], dict) and set(state['canonical_files']) == set(FILES),
            'COPY_CANONICAL_FILES_INVALID')
    for name, ref in state['canonical_files'].items():
        require(ref['path'] == str(private / name), 'COPY_CANONICAL_PATH_INVALID')
    runtime = state['preserved_runtime']
    require(isinstance(runtime, dict) and len(runtime) == (5 if portal else 4)
            and all(re.fullmatch(r'[a-f0-9]{64}', key) and re.fullmatch(r'[a-f0-9]{64}', value)
                    for key, value in runtime.items()), 'COPY_FOUR_RUNTIME_REQUIRED')
    require(not portal or portal['container_id'] in runtime, 'COPY_PORTAL_RUNTIME_REQUIRED')
    require(re.fullmatch(r'[a-f0-9]{64}', state['b02_plan_sha256'])
            and re.fullmatch(r'[a-f0-9]{64}', state['active_proxy_sha256'])
            and isinstance(state['network_baseline'], dict) and len(state['network_baseline']) == 3,
            'COPY_BASELINE_INVALID')
    return state


def validate_portal_state(portal, private):
    require(isinstance(portal, dict) and set(portal) == PORTAL_FIELDS,
            'COPY_PORTAL_STATE_INVALID')
    require(isinstance(portal['run_id'], str) and re.fullmatch(r'[0-9]+-[0-9]+', portal['run_id'])
            and isinstance(portal['source_sha'], str) and re.fullmatch(r'[a-f0-9]{40}', portal['source_sha'])
            and isinstance(portal['container_id'], str) and re.fullmatch(r'[a-f0-9]{64}', portal['container_id'])
            and isinstance(portal['image'], str) and re.fullmatch(r'sha256:[a-f0-9]{64}', portal['image']),
            'COPY_PORTAL_IDENTITY_INVALID')
    from mcl_portal_release import portal_network_name
    portal_network_name(portal['proxy_network'], allow_migration_maintenance=True)
    for field in ('report_ref', 'runtime_env_ref', 'manifest_ref'):
        value = portal[field]
        require(isinstance(value, dict) and set(value) == {'path', 'bytes', 'sha256'}
                and type(value['bytes']) is int and 0 < value['bytes'] <= MAX_PRIVATE
                and isinstance(value['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', value['sha256'])
                and isinstance(value['path'], str), 'COPY_PORTAL_REFERENCE_INVALID')
    require(portal['report_ref']['path'] == str(PORTAL_BASE / 'current.json')
            and portal['runtime_env_ref']['path'] == str(PORTAL_BASE / 'releases' / portal['run_id'] / 'runtime.env')
            and Path(portal['manifest_ref']['path']).name == 'portal-manifest.json'
            and Path(portal['manifest_ref']['path']).parent.parent == Path(private).parent / 'releases',
            'COPY_PORTAL_REFERENCE_PATH_INVALID')
    return portal


def read_portal_references(portal):
    report = unique_json(read_reference(portal['report_ref']))
    require(report.get('status') == 'ORIGIN_READY' and report.get('run_id') == portal['run_id']
            and report.get('source_sha') == portal['source_sha']
            and report.get('container') == 'mcl-portal-' + portal['run_id']
            and report.get('image') == portal['image'] and report.get('proxy_network') == portal['proxy_network']
            and report.get('private_pdfs_verified') == 10 and report.get('other_containers_preserved') is True,
            'COPY_PORTAL_REPORT_CHANGED')
    manifest_raw = read_reference(portal['manifest_ref'])
    require(hashlib.sha256(manifest_raw).hexdigest() == report.get('portal_manifest_sha256'),
            'COPY_PORTAL_MANIFEST_CHANGED')
    manifest = unique_json(manifest_raw)
    require(manifest.get('source_sha')==portal['source_sha']
            and manifest.get('origin')=='https://ciclo.inovaris.online'
            and isinstance(manifest.get('pdfs'), dict) and len(manifest['pdfs']) == 10
            and all(isinstance(name,str) and re.fullmatch(r'[A-Za-z0-9_.-]+\.pdf',name)
                    and isinstance(value,str) and re.fullmatch(r'[a-f0-9]{64}',value)
                    for name,value in manifest['pdfs'].items()),
            'COPY_PORTAL_PDF_SET_CHANGED')
    raw = read_reference(portal['runtime_env_ref'])
    values = env_values(raw)
    require(values.get('MCL_RELEASE_SHA') == portal['source_sha']
            and values.get('MCL_ACCESS_DB') == '/data/access-attempts.sqlite',
            'COPY_PORTAL_RUNTIME_ENV_CHANGED')
    from mcl_portal_release import portal_env
    input_raw = ''.join(key + '=' + value + '\n' for key, value in values.items()
                        if key not in {'MCL_RELEASE_SHA', 'MCL_ACCESS_DB'})
    require(portal_env(input_raw, portal['source_sha']).encode() == raw,
            'COPY_PORTAL_RUNTIME_ENV_CHANGED')
    return raw


def load_state(private):
    private = Path(private)
    raw = protected_bytes(private / 'api-web-adoption.json')
    state = validate_state(unique_json(raw), private)
    read_reference(state['smtp_transition_ref'])
    read_reference(state['caddy_config_ref'])
    if state.get('portal'):
        read_portal_references(state['portal'])
    return state, raw


def projection_digest(value):
    projection = {key: value[key] for key in ('Id', 'Image', 'Config', 'HostConfig', 'Mounts', 'NetworkSettings')}
    projection['State'] = {key: value['State'][key] for key in ('Running', 'Paused', 'Restarting', 'Pid', 'StartedAt')}
    return hashlib.sha256(json.dumps(projection, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def inventory(command, root, portal=None):
    ids = command(['docker', 'ps', '-aq', '--no-trunc'], root).split()
    expected_count = 5 if portal else 4
    require(len(ids) == expected_count and len(set(ids)) == expected_count
            and all(re.fullmatch(r'[a-f0-9]{64}', key) for key in ids), 'COPY_FOUR_RUNTIME_REQUIRED')
    rows = unique_json(command(['docker', 'inspect', *ids], root))
    require(isinstance(rows, list) and {row['Id'] for row in rows} == set(ids), 'COPY_RUNTIME_READBACK_INVALID')
    services = {}
    for row in rows:
        require(row['State']['Running'] and not row['State']['Paused']
                and not row['State']['Restarting'], 'COPY_RUNTIME_NOT_RUNNING')
        labels = row['Config'].get('Labels') or {}
        if labels.get('com.inovaris.product') == 'mi-ciclo-listo-portal':
            require(portal is not None and row['Id'] == portal['container_id']
                    and row['Image'] == portal['image'] and row.get('Name') == '/mcl-portal-' + portal['run_id']
                    and labels.get('com.inovaris.source-sha') == portal['source_sha'],
                    'COPY_PORTAL_RUNTIME_IDENTITY_CHANGED')
            service = 'portal'
        else:
            service = labels.get('com.docker.compose.service') if labels.get('com.docker.compose.project') == 'commerce-os' else 'caddy'
        expected = {'api', 'web', 'postgres', 'caddy'} | ({'portal'} if portal else set())
        require(service in expected and service not in services,
                'COPY_CONSUMER_OR_EXTRA_RUNTIME')
        services[service] = row
    require(set(services) == expected, 'COPY_SERVICE_SET_INVALID')
    return services


def networks(command, root, services):
    names = set().union(*(set(row['NetworkSettings']['Networks']) for row in services.values()))
    require(len(names - {PITR_NETWORK}) == 3, 'COPY_NETWORK_SET_INVALID')
    rows = unique_json(command(['docker', 'network', 'inspect', *sorted(names)], root))
    result = {}
    for row in rows:
        # Endpoints change only for the two selected application containers.
        result[row['Name']] = {key: row[key] for key in ('Name', 'Id', 'Driver', 'Internal', 'EnableIPv6', 'IPAM', 'Options', 'Labels')}
        expected = {item['Id'] for item in services.values() if row['Name'] in item['NetworkSettings']['Networks']}
        require(set(row.get('Containers', {})) == expected, 'COPY_NETWORK_FOREIGN_ENDPOINT')
    require(set(result) == names, 'COPY_NETWORK_READBACK_INVALID')
    return result


def active_proxy_digest(command, root, services):
    raw = command(['docker', 'exec', services['caddy']['Id'], 'wget', '-qO-',
                   'http://127.0.0.1:2019/config/'], root)
    require(0 < len(raw) <= 256 * 1024, 'COPY_ACTIVE_PROXY_CONFIG_BOUND')
    value = unique_json(raw)
    require(isinstance(value, dict), 'COPY_ACTIVE_PROXY_CONFIG_INVALID')
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def topology_guard(command, root, services, network_rows, release):
    core, proxy, edge = 'commerce-os_core', release['COMMERCE_PROXY_NETWORK'], release['COMMERCE_API_EDGE_NETWORK']
    pitr = PITR_NETWORK in network_rows
    require(len({core, proxy, edge}) == 3 and set(network_rows) - {PITR_NETWORK} == {core, proxy, edge},
            'COPY_CLOSED_NETWORK_SET_REQUIRED')
    require(not pitr or (network_rows[PITR_NETWORK]['Internal'] is False and network_rows[PITR_NETWORK]['Driver'] == 'bridge'
                         and network_rows[PITR_NETWORK]['EnableIPv6'] is False), 'COPY_PITR_NETWORK_UNSAFE')
    expected = {'postgres': {core} | ({PITR_NETWORK} if pitr else set()), 'web': {proxy},
                'api': {core, proxy, edge}, 'caddy': {proxy, edge}}
    if 'portal' in services:
        expected['portal'] = {proxy}
    for name, names in expected.items():
        require(set(services[name]['NetworkSettings']['Networks']) == names, 'COPY_NETWORK_MEMBERSHIP_CHANGED')
    require(network_rows[core]['Internal'] is True and network_rows[proxy]['Internal'] is True
            and network_rows[edge]['Internal'] is False
            and all(row['EnableIPv6'] is False for row in network_rows.values()), 'COPY_NETWORK_ISOLATION_CHANGED')
    endpoints = services['api']['NetworkSettings']['Networks']
    if any('GwPriority' in row for row in endpoints.values()):
        require(all(row.get('GwPriority') == (1 if name == edge else 0) for name, row in endpoints.items()),
                'COPY_API_GATEWAY_PRIORITY_CHANGED')
    # Read kernel routing too: a rendered compose key is not actual gateway proof.
    raw = command(['docker', 'exec', services['api']['Id'], 'cat', '/proc/net/route'], root)
    require(len(raw) <= 8192, 'COPY_API_ROUTE_BOUND')
    defaults = [line.split()[2].upper() for line in raw.splitlines()[1:]
                if len(line.split()) >= 8 and line.split()[1] == '00000000' and line.split()[7] == '00000000']
    config = network_rows[edge]['IPAM']['Config']
    require(len(config) == 1, 'COPY_EDGE_IPV4_SUBNET_REQUIRED')
    gateway = ipaddress.IPv4Address(config[0]['Gateway'])
    expected_hex = format(int.from_bytes(gateway.packed, 'little'), '08X')
    require(defaults == [expected_hex], 'COPY_API_DEFAULT_GATEWAY_NOT_EDGE')
    return True


def terminal_journals(private, own_report_dir=None):
    runs = private / 'daily-b02' / 'runs'
    require(runs.is_dir() and not runs.is_symlink(), 'COPY_B02_JOURNAL_DIRECTORY_REQUIRED')
    entries = list(runs.iterdir())
    require(len(entries) <= 5000, 'COPY_B02_JOURNAL_BOUND')
    for entry in entries:
        require(entry.is_dir() and not entry.is_symlink() and re.fullmatch(r'[0-9]+-[0-9]+', entry.name),
                'COPY_B02_JOURNAL_DIRECTORY_INVALID')
        path = entry / 'journal.json'
        journal = unique_json(protected_bytes(path))
        require(journal.get('kind') == 'DAILY_B02' and journal.get('run_id') == entry.name
                and journal.get('status') in TERMINAL, 'COPY_B02_NONTERMINAL_JOURNAL')
    deployments = private / 'deployments'
    for directory in deployments.iterdir():
        if directory == own_report_dir: continue
        require(directory.is_dir() and not directory.is_symlink(), 'COPY_DEPLOY_JOURNAL_DIRECTORY_INVALID')
        report = unique_json(protected_bytes(directory / 'report.json'))
        require(report.get('status') in {'SUCCEEDED', 'FAILED'}, 'COPY_DEPLOYMENT_NONTERMINAL')
        if report.get('status') == 'FAILED' and 'rollback' in report:
            require(report['rollback'].get('status') == 'SUCCEEDED', 'COPY_PRIOR_ROLLBACK_UNCONFIRMED')
        tasks=list(directory.glob('task-*.json'))+list(directory.glob('portal-prepare/task-*.json'))
        for task in tasks:
            require(unique_json(protected_bytes(task)).get('status') in {'SUCCEEDED', 'FAILED'},
                    'COPY_PRIOR_TASK_UNCONFIRMED')


def snapshot(private, root, command, own_report_dir=None):
    private = Path(private)
    state, raw = load_state(private)
    require((private.parent / 'current').is_symlink()
            and str((private.parent / 'current').resolve(strict=True)) == state['current_release'],
            'COPY_CURRENT_CHANGED')
    for ref in state['canonical_files'].values():
        read_reference(ref)
    release = env_values(protected_bytes(private / 'release.env'))
    require(release.get('COMMERCE_DEPLOY_SCOPE') == 'api-web'
            and release.get('COMMERCE_SECRETS_DIR') == str(private), 'COPY_CANONICAL_SELECTION_REQUIRED')
    api = env_values(protected_bytes(private / 'api.env'))
    require(api.get('IDENTITY_MAIL_ENABLED', 'false').lower() == 'false', 'COPY_MAIL_CONFIG_CHANGED')
    plan_raw = protected_bytes(private / 'daily-b02' / 'plan.json')
    require(hashlib.sha256(plan_raw).hexdigest() == state['b02_plan_sha256'], 'COPY_B02_PLAN_CHANGED')
    plan = unique_json(plan_raw)
    require(plan.get('enabled') is True and plan.get('source_sha') == SOURCE_SHA and plan.get('preserved_runtime') == state['preserved_runtime']
            and plan.get('schedule_enabled') is False, 'COPY_B02_BASELINE_MISMATCH')
    terminal_journals(private, own_report_dir)
    services = inventory(command, root, state.get('portal'))
    if state.get('portal'):
        portal = state['portal']
        require(portal['proxy_network'] == release['COMMERCE_PROXY_NETWORK'], 'COPY_PORTAL_PROXY_CHANGED')
        runtime_env = env_values(read_reference(portal['runtime_env_ref']))
        observed = env_values(('\n'.join(services['portal']['Config']['Env']) + '\n').encode())
        require(all(observed.get(key) == value for key, value in runtime_env.items()),
                'COPY_PORTAL_RUNTIME_ENV_CHANGED')
    require({row['Id']: projection_digest(row) for row in services.values()} == state['preserved_runtime'],
            'COPY_RUNTIME_BASELINE_CHANGED')
    network_rows = networks(command, root, services)
    require(network_rows == state['network_baseline'], 'COPY_NETWORK_BASELINE_CHANGED')
    topology_guard(command, root, services, network_rows, release)
    require(active_proxy_digest(command, root, services) == state['active_proxy_sha256'], 'COPY_ACTIVE_PROXY_CHANGED')
    return {'state': state, 'state_raw': raw, 'plan_raw': plan_raw, 'services': services,
            'files': {name: protected_bytes(private / name) for name in FILES}}


def acquire_locks(private):
    held = []
    try:
        for name in LOCKS:
            path = Path(private) / name
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            stream = os.fdopen(fd, 'a+b')
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
                    and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
                    'COPY_LOCK_UNSAFE')
            held.append(stream)
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return held
    except BaseException:
        for stream in reversed(held):
            stream.close()
        raise


def acquire_locks_for_prepare(private):
    """Only CI lock here; the canonical backup acquires schedule then maintenance."""
    path = Path(private) / 'ci-deploy.lock'
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    stream = os.fdopen(fd, 'a+b')
    try:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
                'COPY_LOCK_UNSAFE')
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return stream
    except BaseException:
        stream.close()
        raise


def verify_predeploy_backup(private, report_dir):
    """One fresh canonical result, then full bounded ciphertext readback.

    The private path stays local. This is local custody, not an off-host or
    decryption/restore claim, and never substitutes an earlier daily receipt.
    """
    log = protected_bytes(Path(report_dir) / 'prepare.log', maximum=64 * 1024 * 1024)
    results = []
    for line in log.decode(errors='replace').splitlines():
        if not line.startswith('{'):
            continue
        try: value = unique_json(line)
        except (ValueError, TypeError): continue
        if isinstance(value, dict) and 'backup' in value:
            results.append(value)
    require(len(results) == 1, 'COPY_FRESH_BACKUP_RESULT_REQUIRED')
    result = results[0]
    require(set(result) == {'backup', 'encrypted', 'format', 'private_assets',
                           'snapshot_consistent', 'external_copy_verified'}
            and result['encrypted'] is True and result['format'] == 2
            and result['snapshot_consistent'] is True and result['external_copy_verified'] is False,
            'COPY_FRESH_BACKUP_RESULT_INVALID')
    path = Path(result['backup'])
    require(path.parent == Path(private) / 'backups' and path.name.startswith('commerce-')
            and path.name.endswith('.backup.aes'), 'COPY_FRESH_BACKUP_PATH_INVALID')
    backup_env = env_values(protected_bytes(Path(private) / 'backup.env'))
    require(backup_env.get('BACKUP_DIR') == str(path.parent), 'COPY_BACKUP_DIRECTORY_INVALID')
    # Reuse metadata guards without retaining a GiB in process memory.
    for parent in (path.parent, *path.parent.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'COPY_BACKUP_PARENT_UNSAFE')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600
                and info.st_nlink == 1 and 36 < info.st_size <= 1024 ** 3,
                'COPY_BACKUP_CIPHERTEXT_BOUND')
        hasher = hashlib.sha256(); count = 0
        header = source.read(8)
        require(header == b'COMOSB02', 'COPY_BACKUP_CIPHERTEXT_FORMAT')
        hasher.update(header); count += len(header)
        while True:
            block = source.read(1024 * 1024)
            if not block: break
            count += len(block); require(count <= 1024 ** 3, 'COPY_BACKUP_CIPHERTEXT_BOUND'); hasher.update(block)
        after = os.fstat(source.fileno())
        require(count == info.st_size and (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                == (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                'COPY_BACKUP_CIPHERTEXT_CHANGED')
    return {'bytes': count, 'sha256': hasher.hexdigest(), 'format': 2,
            'snapshot_consistent': True, 'local_ciphertext_readback_verified': True,
            'external_copy_verified': False, 'decryption_or_restore_verified': False}


def compare_after(before, after, command, root, private):
    preserved = ('postgres', 'caddy', 'portal') if 'portal' in before['services'] else ('postgres', 'caddy')
    for name in preserved:
        require(projection_digest(after[name]) == projection_digest(before['services'][name]),
                'COPY_PRESERVED_RUNTIME_CHANGED')
    for name in ('api', 'web'):
        old, new = before['services'][name], after[name]
        require(set(old['NetworkSettings']['Networks']) == set(new['NetworkSettings']['Networks'])
                and old['HostConfig'] == new['HostConfig'] and old['Mounts'] == new['Mounts'],
                'COPY_APPLICATION_BOUNDARY_CHANGED')
    network_rows = networks(command, root, after)
    require(network_rows == before['state']['network_baseline'], 'COPY_NETWORK_CHANGED')
    topology_guard(command, root, after, network_rows, env_values(protected_bytes(Path(private) / 'release.env')))
    require(active_proxy_digest(command, root, after) == before['state']['active_proxy_sha256'], 'COPY_ACTIVE_PROXY_CHANGED')
    read_reference(before['state']['caddy_config_ref'])
    if before['state'].get('portal'):
        read_portal_references(before['state']['portal'])
    for name in set(FILES) - {'release.env', 'api.env'}:
        require(protected_bytes(Path(private) / name) == before['files'][name], 'COPY_PRIVATE_PROFILE_CHANGED')
    old = env_values(before['files']['api.env'])
    new = env_values(protected_bytes(Path(private) / 'api.env'))
    allowed = {'COMMERCE_DEPLOYMENT_STATUS', 'COMMERCE_EXTERNAL_MONITOR_STATUS'}
    require({key: value for key, value in old.items() if key not in allowed}
            == {key: value for key, value in new.items() if key not in allowed}, 'COPY_API_SECRET_OR_PROFILE_CHANGED')
    flags = {}
    for line in after['api']['Config']['Env']:
        require('=' in line, 'COPY_API_RUNTIME_ENV_INVALID')
        key, value = line.split('=', 1)
        require(key not in flags, 'COPY_API_RUNTIME_ENV_INVALID')
        flags[key] = value
    overridden = {'COMMERCE_RELEASE_SHA', 'COMMERCE_RELEASE_ID', 'PORT', 'DB_POOL_MAX'}
    require(all(flags.get(key) == value for key, value in new.items() if key not in overridden),
            'COPY_API_RUNTIME_PROFILE_MISMATCH')
    old = env_values(before['files']['release.env'])
    new = env_values(protected_bytes(Path(private) / 'release.env'))
    allowed = {'COMMERCE_IMAGE', 'COMMERCE_WEB_IMAGE', 'COMMERCE_MAINTENANCE_IMAGE',
               'COMMERCE_RELEASE_SHA', 'COMMERCE_RELEASE_ID'}
    require({key: value for key, value in old.items() if key not in allowed}
            == {key: value for key, value in new.items() if key not in allowed}, 'COPY_RELEASE_BOUNDARY_CHANGED')
    require(flags.get('COMMERCE_RELEASE_SHA') == new.get('COMMERCE_RELEASE_SHA')
            and flags.get('COMMERCE_RELEASE_ID') == new.get('COMMERCE_RELEASE_ID')
            and flags.get('PORT') == '3001' and flags.get('DB_POOL_MAX') == '5',
            'COPY_API_RUNTIME_RELEASE_MISMATCH')


def rebase(private, before, after, current_release, write_atomic, own_report_dir=None, *, portal_transition=None):
    """CAS only preserved_runtime; source/tool/storage/credential refs stay byte-bound."""
    private = Path(private)
    state_now = protected_bytes(private / 'api-web-adoption.json')
    plan_path = private / 'daily-b02' / 'plan.json'
    require(state_now == before['state_raw'] and protected_bytes(plan_path) == before['plan_raw'],
            'COPY_REBASE_CAS_FAILED')
    terminal_journals(private, own_report_dir)
    runtime = {row['Id']: projection_digest(row) for row in after.values()}
    old_plan = unique_json(before['plan_raw']); new_plan = copy.deepcopy(old_plan)
    new_plan['preserved_runtime'] = runtime
    require({key: value for key, value in old_plan.items() if key != 'preserved_runtime'}
            == {key: value for key, value in new_plan.items() if key != 'preserved_runtime'}, 'COPY_B02_REBASE_SCOPE')
    state = copy.deepcopy(before['state'])
    state.update(preserved_runtime=runtime, current_release=str(current_release),
                 canonical_files={name: reference(private / name, protected_bytes(private / name)) for name in FILES})
    if portal_transition is not None:
        require(before['state']['schema_version'] == 1 and 'portal' not in before['state']
                and isinstance(portal_transition, dict)
                and set(portal_transition) == {'portal', 'active_proxy_sha256', 'caddy_config_ref'},
                'COPY_PORTAL_TRANSITION_INVALID')
        require(set(after)=={'api','web','postgres','caddy','portal'}, 'COPY_PORTAL_TRANSITION_RUNTIME_INVALID')
        for name in ('api','web','postgres','caddy'):
            require(projection_digest(after[name])==projection_digest(before['services'][name]),
                    'COPY_PORTAL_CORE_RUNTIME_CHANGED')
        state.update(schema_version=2, **portal_transition)
        validate_state(state, private)
        require(state['caddy_config_ref']['path'] == before['state']['caddy_config_ref']['path'],
                'COPY_PORTAL_PROXY_PATH_CHANGED')
        read_reference(state['caddy_config_ref'])
        read_portal_references(state['portal'])
    # Keep the old private plan for existing journals and their custody hashes.
    history = private / 'daily-b02' / 'plan-history'
    history.mkdir(mode=0o700, exist_ok=True)
    info = history.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
            'COPY_B02_HISTORY_UNSAFE')
    old_hash = hashlib.sha256(before['plan_raw']).hexdigest()
    old_path = history / (old_hash + '.json')
    if not old_path.exists():
        fd = os.open(old_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as target:
            target.write(before['plan_raw']); target.flush(); os.fsync(target.fileno())
    require(protected_bytes(old_path) == before['plan_raw'], 'COPY_B02_HISTORY_CHANGED')
    write_atomic(plan_path, new_plan)
    actual = protected_bytes(plan_path)
    require(unique_json(actual) == new_plan, 'COPY_B02_REBASE_READBACK_FAILED')
    state['b02_plan_sha256']=hashlib.sha256(actual).hexdigest()
    write_atomic(private / 'api-web-adoption.json', state)
    require(unique_json(protected_bytes(private / 'api-web-adoption.json')) == state,
            'COPY_ADOPTION_REBASE_READBACK_FAILED')
    # Private hashes stay on the VPS; CI gets an instruction, never these values.
    return {'backup_source_sha': SOURCE_SHA, 'preserved_runtime_rebased': True,
            'backup_schedule_enabled': False, 'transport_configuration_update_required': True}


def _sql_text(value):
    return "'" + value.replace("'", "''") + "'"


def retired_count(table, where):
    """Count rows of a table that V7 migration 0109 may have dropped (exported
    and retired V5 modules): an absent table holds none. The count runs as
    dynamic text (query_to_xml is volatile) only when the table exists."""
    require(re.fullmatch(r'[a-z_]+', table) is not None, 'RETIRED_TABLE_NAME_INVALID')
    query = 'SELECT count(*) AS n FROM public.' + table + ' WHERE ' + where
    return ("(CASE WHEN to_regclass('public." + table + "') IS NULL THEN 0 ELSE (xpath('/row/n/text()',query_to_xml("
            + _sql_text(query) + ",false,true,'')))[1]::text::bigint END)")


def retired_rows(table):
    """Rows of a table 0109 may have dropped, as ordered JSON ('[]' once
    absent). The JSON travels hex encoded so XML never rewrites it."""
    require(re.fullmatch(r'[a-z_]+', table) is not None, 'RETIRED_TABLE_NAME_INVALID')
    query = ("SELECT encode(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8'),'hex')"
             " AS v FROM public." + table + ' t')
    return ("(CASE WHEN to_regclass('public." + table + "') IS NULL THEN '[]'::jsonb ELSE convert_from(decode((xpath('/row/v/text()',"
            "query_to_xml(" + _sql_text(query) + ",false,true,'')))[1]::text,'hex'),'UTF8')::jsonb END)")


# Same closed restore barriers; the legitimate owner sessions/PAT are explicit.
BARRIERS_SQL = "SELECT json_build_object('database',current_database(),'version_num',current_setting('server_version_num'),'migration_count',(SELECT count(*) FROM schema_migrations),'records',(SELECT count(*) FROM records),'effects',(SELECT count(*) FROM outbox),'workspaces_not_paused',(SELECT count(*) FROM (SELECT DISTINCT workspace_id FROM records) r WHERE NOT EXISTS(SELECT 1 FROM manual_controls m WHERE m.workspace_id=r.workspace_id AND m.scope_type='workspace' AND m.scope_id=r.workspace_id AND m.paused)),'ownership_unfrozen',(SELECT count(*) FROM session_ownership WHERE NOT frozen),'sessions_unsafe',(SELECT count(*) FROM channel_sessions WHERE recovery_enabled OR NOT operational_pause OR desired_state<>'STOPPED' OR observed_state<>'UNKNOWN' OR auth_state<>'UNKNOWN' OR health_expires_at IS NOT NULL),'authorizations_live',(SELECT count(*) FROM operation_authorizations WHERE revoked_at IS NULL),'service_tokens_live',(SELECT count(*) FROM service_tokens WHERE revoked_at IS NULL),'personal_tokens_live',(SELECT count(*) FROM personal_access_tokens WHERE revoked_at IS NULL),'login_sessions',(SELECT count(*) FROM session),'sending_effects',(SELECT count(*) FROM outbox WHERE status='SENDING'),'alerts_enabled',(SELECT count(*) FROM integration_settings WHERE type='alerts' AND enabled),'alerts_pending',(SELECT count(*) FROM operational_alerts WHERE status IN ('PENDING','SENDING')),'mail_enabled',(SELECT count(*) FROM identity_mail_settings WHERE enabled),'mail_pending',(SELECT count(*) FROM identity_mail_jobs WHERE status IN ('PENDING','SENDING')),'reset_links',(SELECT count(*) FROM identity_reset_links),'creative_enabled',"+retired_count('creative_settings','enabled')+",'creative_devices_live',"+retired_count('creative_devices',"status<>'REVOKED'")+",'creative_jobs_live',"+retired_count('creative_jobs',"status IN ('QUEUED','RUNNING','RETRY')")+",'provider_operations_live',"+retired_count('creative_provider_operations',"status IN ('RESERVED','RUNNING')")+",'voice_operations_live',"+retired_count('creative_voice_operations',"status IN ('QUOTED','REQUESTED','RUNNING','PAID_PENDING_STORAGE')")+",'warmup_enabled',(SELECT count(*) FROM warmup_pools WHERE enabled OR NOT paused),'programs_live',(SELECT count(*) FROM warmup_programs WHERE status NOT IN ('PAUSED','ARCHIVED','COMPLETED')),'assignment_grants',(SELECT count(*) FROM commercial_assignments WHERE authorization_id IS NOT NULL),'intelligence_tracking',"+retired_count('intelligence_searches','tracking_enabled')+")"
BARRIERS = ['alerts_enabled', 'alerts_pending', 'assignment_grants', 'authorizations_live', 'creative_devices_live', 'creative_enabled', 'creative_jobs_live', 'intelligence_tracking', 'login_sessions', 'mail_enabled', 'mail_pending', 'ownership_unfrozen', 'personal_tokens_live', 'programs_live', 'provider_operations_live', 'reset_links', 'sending_effects', 'service_tokens_live', 'sessions_unsafe', 'voice_operations_live', 'warmup_enabled', 'workspaces_not_paused']
MAX_OWNER_SESSIONS = 32
MAX_OWNER_USERS = 8
MAX_OWNER_TOKENS = 32


def database_guard(database, root):
    value = unique_json(database(root, BARRIERS_SQL))
    require(value.get('database') == 'commerce' and value.get('migration_count') == 65
            and type(value.get('login_sessions')) is int and 0 <= value['login_sessions'] <= MAX_OWNER_SESSIONS
            and type(value.get('personal_tokens_live')) is int
            and 1 <= value['personal_tokens_live'] <= MAX_OWNER_TOKENS
            and all(type(value.get(key)) is int and value[key] == 0
                    for key in BARRIERS if key not in {'login_sessions', 'personal_tokens_live'}),
            'COPY_FROZEN_OWNER_BARRIERS_CHANGED')
    policy = database(root, "SELECT count(*)>0 AND bool_and(version=93 AND NOT release_hold AND body @> '{\"dispatch_frozen\":true,\"real_sends_enabled\":false,\"allow_real_operations\":false}'::jsonb) FROM operational_settings WHERE environment='REAL';")
    require(policy == 't', 'COPY_POLICY_93_FROZEN_REQUIRED')
    return True
