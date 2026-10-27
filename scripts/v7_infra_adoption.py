#!/usr/bin/env python3
"""V7 F1 Root adoption of the window's infrastructure changes.

The canonical installer, B02 and the runtime boot all bind the exact container
inventory, the private profile files and the network baseline recorded in
`api-web-adoption.json` + `daily-b02/plan.json` (+ `runtime-boot/policy.json`).
After the V7 publication the window still changes three things on purpose:

  * the runtime settings V7 adds (`scripts/v7_runtime_env.py`), which recreate
    the application containers that read them;
  * PostgreSQL with pgBackRest (`scripts/v7_pitr.py enable`), which replaces the
    container on the same volume and cluster and joins `commerce-os_pitr-edge`;
  * nothing else.

This tool re-adopts exactly those changes and refuses any other difference, so
the next publication, B02 and the boot keep working from an honest baseline.

V7.1 (25-oct-2026) also adopts:

  * the entry proxy rewritten by `scripts/update-identity-proxy.py` (the /v2/*
    route of 21-oct and /healthz/platform). Accepted only when the private
    backup of the recorded Caddyfile and the current file converge under the
    reviewed rewrite, and Caddy runs exactly that file;
  * a container whose only change is the engine encoding of its unset DNS lists
    (docs/adr-v7-engine-neutral-dns.md).

    v7_infra_adoption.py capture             # before any change (Root, read-only on the platform)
    v7_infra_adoption.py observe             # after the changes; prints the proposal digest
    v7_infra_adoption.py apply <sha256>      # the four locks, one journaled CAS of plan, state and boot policy
    v7_infra_adoption.py rebind-backup-env   # once after PITR: backup.env PG_CONTAINER -> the PITR container

`capture` stores, root-only, the container definitions with every environment
value replaced by its SHA-256 and each profile file as key → SHA-256: never a
secret. Output: service names, setting names and digests only.
"""
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import api_web_deployment as native  # noqa: E402
import copy_runtime_deployment as runtime  # noqa: E402
from ci_release import ReleaseError, require  # noqa: E402

PRIVATE = Path('/opt/commerce-os/private')
ADOPTION = PRIVATE/'api-web-adoption.json'
PLAN = PRIVATE/'daily-b02/plan.json'
BOOT_POLICY = PRIVATE/'runtime-boot/policy.json'
PITR_RECEIPT = PRIVATE/'pitr/enable-receipt.json'
CADDY_BACKUPS = PRIVATE/'caddy-backups'
BASE = PRIVATE/'v7-infra-adoption'
APP = ('api', 'ingress', 'automation-worker', 'channel-worker')
UNCHANGED = ('web', 'caddy', 'portal')
PROFILE_FILES = {'api.env': 'api', 'ingress.env': 'ingress', 'automation.env': 'automation-worker', 'channel.env': 'channel-worker'}
# Exactly the settings V7 adds (docs/adr-v7-f1-infrastructure.md §4f, §3, §4).
V7_SETTINGS = {
    'api': frozenset({'AI_DATABASE_URL'}),
    'ingress': frozenset(),
    'automation-worker': frozenset({'AI_DATABASE_URL', 'RESULTS_DATABASE_URL', 'MAIL_DISPATCH_DATABASE_URL',
                                    'MAIL_SERVICE_ORIGIN', 'MAIL_ENVELOPE_KEY', 'INGRESS_PUBSUB_SUBSCRIPTION',
                                    'INTERNAL_INGRESS_URL', 'LAB_PRIVATE_STORAGE_DIR'}),
    'channel-worker': frozenset({'INGRESS_RELAY_URL'}),
}
V7_PREFIXES = {'automation-worker': ('LAB_',)}
PITR_ENV_PREFIX = 'PGBACKREST_'
PITR_MOUNTS = frozenset({'/etc/pgbackrest/pgbackrest.conf', '/var/spool/pgbackrest'})
PITR_CMD = ['postgres', '-c', 'max_connections=80', '-c', 'shared_buffers=512MB', '-c', 'wal_level=replica',
            '-c', 'archive_mode=on', '-c', 'archive_timeout=60s', '-c', 'archive_command=pgbackrest --stanza=commerce archive-push %p']
PITR_IMAGE_LABELS = frozenset({'org.opencontainers.image.title', 'com.inovaris.commerce.pgbackrest'})
# V7.1: production's PostgreSQL was created on 6-oct by the initial foundation
# (one compose file of its own). `v7_pitr.py enable` recreates it inside the
# release's compose chain (as the application services) plus the PITR overlay.
FOUNDATION_FILES = re.compile(r'/opt/commerce-os/initial-foundation/initial_foundation_[0-9a-f]{32}/postgres-foundation\.json')
CURRENT_LINK = '/opt/commerce-os/current'
COMPOSE_FILES = 'com.docker.compose.project.config_files'
COMPOSE_WORKDIR = 'com.docker.compose.project.working_dir'
COMPOSE_ENV_FILE = 'com.docker.compose.project.environment_file'
# Compose bookkeeping that changes whenever a container is recreated.
COMPOSE_VOLATILE = frozenset({'com.docker.compose.config-hash', 'com.docker.compose.replace',
                              'com.docker.compose.container-number'})


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def encode(value):
    # Same encoding as the B02 controller's pair (json.dumps sorted + newline).
    return (json.dumps(value, sort_keys=True) + '\n').encode()


def env_digests(raw):
    """KEY → sha256(value) of a profile file; values never leave this function."""
    result = {}
    for key, value in native.env_values(raw).items():
        result[key] = digest(value.encode())
    return result


def sanitized(row):
    """A container definition whose Config.Env values are digests."""
    row = copy.deepcopy(row)
    env = row.get('Config', {}).get('Env') or []
    require(type(env) is list and all(type(item) is str for item in env), 'V7_ADOPTION_ENV_INVALID')
    row['Config']['Env'] = sorted(item.split('=', 1)[0] + '=' + digest(item.split('=', 1)[1].encode() if '=' in item else b'')
                                  for item in env)
    return row


def env_map(row):
    return dict(item.split('=', 1) for item in row['Config']['Env'])


def short_alias(endpoint, cid):
    return sorted(alias for alias in endpoint.get('Aliases') or [] if alias != cid[:12])


def foundation_pitr_labels(old_lab, new_lab, chain):
    """The PITR PostgreSQL left the initial foundation's compose project for the release's chain.

    Its files, working directory and environment files must equal those of an
    application service the installer created (chain['labels']), written through
    /opt/commerce-os/current or the release directory, plus the PITR overlay last."""
    ref, release = chain['labels'], chain['current_release']
    require(type(release) is str and release.startswith('/opt/commerce-os/releases/') and type(ref.get(COMPOSE_FILES)) is str
            and type(ref.get(COMPOSE_WORKDIR)) is str and type(ref.get(COMPOSE_ENV_FILE)) is str, 'V7_ADOPTION_COMPOSE_FILES_CHANGED:postgres')
    old_files = old_lab.get(COMPOSE_FILES)
    require(type(old_files) is str and FOUNDATION_FILES.fullmatch(old_files) and old_lab.get(COMPOSE_WORKDIR) == old_files.rsplit('/', 1)[0]
            and COMPOSE_ENV_FILE not in old_lab, 'V7_ADOPTION_COMPOSE_FILES_CHANGED:postgres')
    variants = [(lambda value: value, release), (lambda value: value.replace(release + '/', CURRENT_LINK + '/'), CURRENT_LINK)]
    accepted = False
    for view, base in variants:
        if (new_lab.get(COMPOSE_FILES) == view(ref[COMPOSE_FILES]) + ',' + base + '/infra/compose/postgres-pitr.yaml'
                and new_lab.get(COMPOSE_WORKDIR) == view(ref[COMPOSE_WORKDIR]) and new_lab.get(COMPOSE_ENV_FILE) == ref[COMPOSE_ENV_FILE]):
            accepted = True
    require(accepted, 'V7_ADOPTION_COMPOSE_FILES_CHANGED:postgres')
    for key in (COMPOSE_FILES, COMPOSE_WORKDIR, COMPOSE_ENV_FILE):
        old_lab.pop(key, None); new_lab.pop(key, None)


def compare_recreated(name, old, new, *, allowed_env, allowed_prefixes=(), pitr=None, chain=None):
    """Old is the sanitized captured row, new the live row. Only the listed fields may differ."""
    new_s = sanitized(new)
    changed = []
    o_env, n_env = env_map(old), env_map(new_s)
    require(set(o_env) <= set(n_env), 'V7_ADOPTION_SETTING_REMOVED:'+name)
    for key in sorted(set(n_env)):
        if o_env.get(key) != n_env[key]:
            require(key in allowed_env or key.startswith(tuple(allowed_prefixes)), 'V7_ADOPTION_SETTING_NOT_ALLOWED:'+name+':'+key)
            changed.append(key)
    o_cfg = {k: v for k, v in old['Config'].items() if k not in ('Env', 'Hostname', 'Labels')}
    n_cfg = {k: v for k, v in new_s['Config'].items() if k not in ('Env', 'Hostname', 'Labels')}
    require(new_s['Config'].get('Hostname') in (new['Id'][:12], old['Config'].get('Hostname')), 'V7_ADOPTION_HOSTNAME_CHANGED:'+name)
    o_lab, n_lab = dict(old['Config'].get('Labels') or {}), dict(new_s['Config'].get('Labels') or {})
    files_label = 'com.docker.compose.project.config_files'
    if pitr and chain is not None and FOUNDATION_FILES.fullmatch(str(o_lab.get(files_label))):
        foundation_pitr_labels(o_lab, n_lab, chain)
    elif o_lab.get(files_label) != n_lab.get(files_label):
        # compose-release.sh appends the PITR overlay last once PITR is enabled.
        require(type(o_lab.get(files_label)) is str and type(n_lab.get(files_label)) is str
                and n_lab[files_label].startswith(o_lab[files_label]+',')
                and ('/'+n_lab[files_label][len(o_lab[files_label])+1:]).endswith('/infra/compose/postgres-pitr.yaml')
                and ',' not in n_lab[files_label][len(o_lab[files_label])+1:], 'V7_ADOPTION_COMPOSE_FILES_CHANGED:'+name)
        o_lab.pop(files_label); n_lab.pop(files_label)
    volatile = COMPOSE_VOLATILE | ({'com.docker.compose.image'} | PITR_IMAGE_LABELS if pitr else set())
    require({k: v for k, v in o_lab.items() if k not in volatile} == {k: v for k, v in n_lab.items() if k not in volatile},
            'V7_ADOPTION_LABELS_CHANGED:'+name)
    if pitr:
        require(new['Image'] == pitr['image'] and new_s['Config'].get('Cmd') == PITR_CMD, 'V7_ADOPTION_PITR_IMAGE_OR_COMMAND:'+name)
        o_cfg.pop('Image', None); n_cfg.pop('Image', None); o_cfg.pop('Cmd', None); n_cfg.pop('Cmd', None)
        require(set(n_lab) - set(o_lab) - COMPOSE_VOLATILE <= PITR_IMAGE_LABELS, 'V7_ADOPTION_PITR_LABELS:'+name)
    else:
        require(new['Image'] == old['Image'], 'V7_ADOPTION_IMAGE_CHANGED:'+name)
    require(o_cfg == n_cfg, 'V7_ADOPTION_CONFIG_CHANGED:'+name)
    require(new['Name'] == old['Name'], 'V7_ADOPTION_NAME_CHANGED:'+name)
    # Host configuration and mounts: identical, or exactly the PITR additions.
    o_host, n_host = runtime.engine_neutral_host(old['HostConfig']), runtime.engine_neutral_host(new['HostConfig'])
    mounts_old = {m.get('Destination'): m for m in old['Mounts']}
    mounts_new = {m.get('Destination'): m for m in new['Mounts']}
    if pitr:
        for key in ('Binds', 'Mounts'):
            o_host.pop(key, None); n_host.pop(key, None)
        require(set(mounts_old) <= set(mounts_new) and set(mounts_new) - set(mounts_old) == PITR_MOUNTS
                and all(mounts_new[d] == mounts_old[d] for d in mounts_old), 'V7_ADOPTION_PITR_MOUNTS:'+name)
    else:
        require(mounts_old == mounts_new, 'V7_ADOPTION_MOUNTS_CHANGED:'+name)
    require(o_host == n_host, 'V7_ADOPTION_HOST_CONFIG_CHANGED:'+name)
    o_net, n_net = old['NetworkSettings']['Networks'], new['NetworkSettings']['Networks']
    extra = {native.PITR_NETWORK} if pitr else set()
    require(set(n_net) == set(o_net) | extra and not (set(o_net) & extra), 'V7_ADOPTION_NETWORKS_CHANGED:'+name)
    for net in o_net:
        require(n_net[net].get('NetworkID') == o_net[net].get('NetworkID')
                and short_alias(n_net[net], new['Id']) == short_alias(o_net[net], old['Id'])
                and n_net[net].get('GwPriority', 0) == o_net[net].get('GwPriority', 0), 'V7_ADOPTION_ENDPOINT_CHANGED:'+name+':'+net)
    if pitr:
        # Egress only through the PITR bridge; the internal networks keep priority 0.
        require(n_net[native.PITR_NETWORK].get('GwPriority', 0) == 1
                and all(n_net[net].get('GwPriority', 0) == 0 for net in o_net), 'V7_ADOPTION_PITR_GATEWAY_PRIORITY')
    return changed


def profile_changes(captured, files_now):
    """Only the V7 settings of the four service profiles may be added or changed."""
    result = {}
    for name, before in captured.items():
        now = env_digests(files_now[name])
        require(set(before) <= set(now), 'V7_ADOPTION_PROFILE_KEY_REMOVED:'+name)
        service = PROFILE_FILES[name]
        keys = sorted(k for k in now if before.get(k) != now[k])
        for key in keys:
            require(key in V7_SETTINGS[service] or key.startswith(V7_PREFIXES.get(service, ())), 'V7_ADOPTION_PROFILE_KEY_NOT_ALLOWED:'+name+':'+key)
        if keys:
            result[name] = keys
    return result


def identity_proxy():
    spec = importlib.util.spec_from_file_location('identity_proxy_for_adoption', Path(__file__).resolve().parent/'update-identity-proxy.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def proxy_decision(ref, current, active_digest, recorded_active, originals, adapted, running, rewrite):
    """Pure. None when the proxy is as recorded; otherwise the adopted reference and digest.

    Accepted only when a private backup of the recorded Caddyfile and the current
    file converge under the reviewed identity-proxy rewrite (they differ only in
    the owned headers and API routes), and Caddy runs exactly the current file."""
    if native.reference(ref['path'], current) == ref and active_digest == recorded_active:
        return None
    matching = [name for name, raw in originals if native.reference(ref['path'], raw) == ref]
    require(matching, 'V7_ADOPTION_PROXY_ORIGINAL_REQUIRED')
    target = rewrite(current)
    require(any(rewrite(raw) == target for name, raw in originals if name in matching), 'V7_ADOPTION_PROXY_CHANGED')
    require(isinstance(adapted, dict) and adapted == running
            and hashlib.sha256(json.dumps(running, sort_keys=True, separators=(',', ':')).encode()).hexdigest() == active_digest,
            'V7_ADOPTION_PROXY_NOT_RUNNING_FILE')
    return {'caddy_config_ref': native.reference(ref['path'], current), 'active_proxy_sha256': active_digest,
            'transition': 'IDENTITY_PROXY_REWRITE', 'rewritten_to_target': current == target}


def proxy_transition(host, state, services):
    ref = state['caddy_config_ref']
    current = native.protected_bytes(ref['path'])
    active = native.active_proxy_digest(host.command, host.root, services)
    if native.reference(ref['path'], current) == ref and active == state['active_proxy_sha256']:
        return None
    originals = []
    if CADDY_BACKUPS.exists():
        require(CADDY_BACKUPS.is_dir() and not CADDY_BACKUPS.is_symlink(), 'V7_ADOPTION_PROXY_BACKUP_UNSAFE')
        for entry in sorted(CADDY_BACKUPS.iterdir()):
            original = entry/'original.Caddyfile'
            if entry.is_dir() and not entry.is_symlink() and original.exists():
                originals.append((entry.name, native.protected_bytes(original)))
    caddy = services['caddy']['Id']
    adapted = runtime._parse(host.command(['docker', 'exec', caddy, 'caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']).encode())
    running = runtime._parse(host.command(['docker', 'exec', caddy, 'wget', '-qO-', 'http://127.0.0.1:2019/config/']).encode())
    return proxy_decision(ref, current, active, state['active_proxy_sha256'], originals, adapted, running, identity_proxy().rewrite_policy)


def pg_container_lines(raw):
    return [i for i, line in enumerate(raw.split(b'\n')) if line.startswith(b'PG_CONTAINER=')]


def backup_env_rebound(old_ref, new_raw, pitr_receipt, postgres_id, path):
    """V7.1 (26-oct-2026): `v7_pitr.py enable` replaced PostgreSQL but left
    backup.env's PG_CONTAINER on the old container, so the installer's pre-deploy
    backup failed (POSTGRES_NETWORK_INSPECTION_FAILED). Accept exactly that one
    line moved from the PITR receipt's previous container to the current PITR
    container: the file with the old value restored must hash to the recorded
    reference, so nothing else in it can change."""
    if not (type(pitr_receipt) is dict and pitr_receipt.get('state') == 'PITR_ENABLED'
            and pitr_receipt.get('after', {}).get('container') == postgres_id):
        return False
    old_id = pitr_receipt.get('before', {}).get('container')
    lines = new_raw.split(b'\n'); index = pg_container_lines(new_raw)
    if not (type(old_id) is str and re.fullmatch(r'[a-f0-9]{64}', old_id) and re.fullmatch(r'[a-f0-9]{64}', postgres_id)
            and len(index) == 1 and lines[index[0]] == b'PG_CONTAINER=' + postgres_id.encode()):
        return False
    lines[index[0]] = b'PG_CONTAINER=' + old_id.encode()
    return native.reference(path, b'\n'.join(lines)) == old_ref


def rebind_backup_env(host):
    """Root, once after PITR: point backup.env's PG_CONTAINER at the PITR container
    named by its receipt. Keeps a 0600 copy; the next `observe` adopts only this."""
    receipt = runtime._parse(host.private(PITR_RECEIPT))
    require(receipt.get('schema_version') == 1 and receipt.get('state') == 'PITR_ENABLED', 'V7_ADOPTION_PITR_EVIDENCE_REQUIRED')
    old_id, new_id = receipt['before']['container'], receipt['after']['container']
    require(any(row['Id'] == new_id and row['State'].get('Running') for row in host.rows()), 'V7_ADOPTION_PITR_CONTAINER_ABSENT')
    path = PRIVATE/'backup.env'; raw = host.private(path); lines = raw.split(b'\n'); index = pg_container_lines(raw)
    require(len(index) == 1, 'V7_ADOPTION_BACKUP_ENV_CONTAINER_LINE')
    if lines[index[0]] == b'PG_CONTAINER=' + new_id.encode():
        return {'state': 'BACKUP_ENV_KEPT', 'sha256': digest(raw)}
    require(lines[index[0]] == b'PG_CONTAINER=' + old_id.encode(), 'V7_ADOPTION_BACKUP_ENV_UNEXPECTED_CONTAINER')
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    copy_path = path.with_name('backup.env.before-v7-pitr-' + stamp)
    require(not copy_path.exists(), 'V7_ADOPTION_BACKUP_ENV_COPY_EXISTS')
    write_private(copy_path, raw)
    lines[index[0]] = b'PG_CONTAINER=' + new_id.encode(); new = b'\n'.join(lines)
    write_private(path, new)
    return {'state': 'BACKUP_ENV_REBOUND', 'sha256': digest(new), 'previous_sha256': digest(raw), 'copy': copy_path.name}


def propose(capture, state_raw, plan_raw, policy_raw, rows, networks, files_now, pitr_receipt, release, *, private=PRIVATE, proxy=None):
    """Pure decision. Every input was read by Root; nothing here touches the host."""
    state = runtime._parse(state_raw); plan = runtime._parse(plan_raw)
    runtime.validate_state(state); runtime.validate_plan(state, plan_raw)
    require(state['runtime_stage'] == 'OPERATING', 'V7_ADOPTION_OPERATING_REQUIRED')
    require(capture['state_sha256'] == digest(state_raw) and capture['plan_sha256'] == digest(plan_raw),
            'V7_ADOPTION_BASELINE_MOVED_SINCE_CAPTURE')
    require(state['b02_plan_sha256'] == digest(plan_raw) and plan['postgres']['container_id'] == state['service_inventory']['postgres'],
            'V7_ADOPTION_PAIR_INCONSISTENT')
    services = runtime.inspect_inventory(rows, portal=state['portal'], caddy_id=state['service_inventory']['caddy'])
    require(set(services) == set(state['service_inventory']), 'V7_ADOPTION_SERVICE_SET_CHANGED')
    before = {row['Id']: row for row in capture['rows']}
    require(set(before) == set(capture['sanitized_digests'])
            and all(runtime.definition_digest_matches(before[cid], capture['sanitized_digests'][cid]) for cid in before)
            and set(before) == set(state['service_inventory'].values()), 'V7_ADOPTION_CAPTURE_INVALID')
    summary = {'recreated': {}, 'unchanged': [], 'postgres': None}
    for name, old_id in sorted(state['service_inventory'].items()):
        row = services[name]
        if row['Id'] == old_id:
            require(runtime.definition_digest_matches(row, state['preserved_runtime'][old_id]), 'V7_ADOPTION_DEFINITION_CHANGED:'+name)
            summary['unchanged'].append(name)
            continue
        require(name in APP or name == 'postgres', 'V7_ADOPTION_CONTAINER_REPLACED:'+name)
        if name == 'postgres':
            require(pitr_receipt is not None and pitr_receipt.get('schema_version') == 1 and pitr_receipt.get('state') == 'PITR_ENABLED'
                    and pitr_receipt['before']['container'] == old_id and pitr_receipt['after']['container'] == row['Id']
                    and pitr_receipt['after']['network'] == native.PITR_NETWORK
                    and pitr_receipt['before']['image'] == plan['postgres']['image'],
                    'V7_ADOPTION_PITR_EVIDENCE_REQUIRED')
            data = [m for m in row['Mounts'] if m.get('Destination') == '/var/lib/postgresql/data']
            require(len(data) == 1 and data[0].get('Type') == 'volume' and data[0].get('Name') == pitr_receipt['before']['volume'],
                    'V7_ADOPTION_PITR_VOLUME_CHANGED')
            compare_recreated(name, before[old_id], row, allowed_env=frozenset(), allowed_prefixes=(PITR_ENV_PREFIX,),
                              pitr={'image': pitr_receipt['after']['image']},
                              chain={'labels': services['api']['Config'].get('Labels') or {}, 'current_release': state['current_release']})
            summary['postgres'] = {'transition': 'PITR_ENABLED', 'system_identifier': pitr_receipt['before']['system_identifier']}
        else:
            summary['recreated'][name] = compare_recreated(name, before[old_id], row, allowed_env=V7_SETTINGS[name],
                                                           allowed_prefixes=V7_PREFIXES.get(name, ()))
    for name in UNCHANGED:
        require(name in summary['unchanged'], 'V7_ADOPTION_PRESERVED_SERVICE_CHANGED:'+name)
    # Profiles: the settings in each file are what the recreated container reads.
    canonical = {}
    profile = profile_changes(capture['profiles'], files_now)
    backup_env = None
    for name in runtime.FILES:
        raw = files_now[name]; old = state['canonical_files'][name]
        if name in profile:
            canonical[name] = native.reference(private/name, raw)
        elif (name == 'backup.env' and native.reference(private/name, raw) != old
              and backup_env_rebound(old, raw, pitr_receipt, services['postgres']['Id'], private/name)):
            canonical[name] = native.reference(private/name, raw); backup_env = 'PG_CONTAINER_REBOUND'
        else:
            require(native.reference(private/name, raw) == old, 'V7_ADOPTION_PROFILE_FILE_CHANGED:'+name)
            canonical[name] = old
    for name, keys in profile.items():
        require(set(keys) <= set(summary['recreated'].get(PROFILE_FILES[name], [])), 'V7_ADOPTION_PROFILE_NOT_LOADED:'+name)
    # Networks: the previous baseline, plus the egress-only PITR bridge if PITR was enabled.
    added = set(networks) - set(state['network_baseline'])
    require({k: v for k, v in networks.items() if k in state['network_baseline']} == state['network_baseline']
            and set(state['network_baseline']) <= set(networks)
            and added == ({native.PITR_NETWORK} if summary['postgres'] else set()), 'V7_ADOPTION_NETWORK_BASELINE_CHANGED')
    if added:
        pitr_net = networks[native.PITR_NETWORK]
        require(pitr_net['Internal'] is False and pitr_net['Driver'] == 'bridge' and pitr_net['EnableIPv6'] is False,
                'V7_ADOPTION_PITR_NETWORK_INVALID')
    inventory = {name: row['Id'] for name, row in services.items()}
    preserved = runtime.preserved_definitions(services, state['preserved_runtime'])
    new_plan = copy.deepcopy(plan)
    new_plan['preserved_runtime'] = preserved
    if summary['postgres']:
        new_plan['postgres'] = dict(plan['postgres'], container_id=services['postgres']['Id'], image=services['postgres']['Image'])
    require({k: v for k, v in plan.items() if k not in ('preserved_runtime', 'postgres')}
            == {k: v for k, v in new_plan.items() if k not in ('preserved_runtime', 'postgres')}
            and {k: v for k, v in plan['postgres'].items() if k not in ('container_id', 'image')}
            == {k: v for k, v in new_plan['postgres'].items() if k not in ('container_id', 'image')}, 'V7_ADOPTION_PLAN_SCOPE')
    plan_bytes = encode(new_plan)
    new_state = copy.deepcopy(state)
    new_state.update(service_inventory=inventory, preserved_runtime=preserved, canonical_files=canonical,
                     network_baseline=networks, b02_plan_sha256=digest(plan_bytes),
                     b02_plan_ref=native.reference(PLAN, plan_bytes))
    if proxy is not None:
        new_state.update(caddy_config_ref=proxy['caddy_config_ref'], active_proxy_sha256=proxy['active_proxy_sha256'])
    runtime.validate_state(new_state); runtime.validate_inventory(new_state, rows); runtime.validate_plan(new_state, plan_bytes)
    state_bytes = encode(new_state)
    policy_bytes = None
    if policy_raw is not None:
        policy = runtime._parse(policy_raw)
        require(policy.get('adoption_ref') == native.reference(ADOPTION, state_raw) and policy.get('plan_ref') == native.reference(PLAN, plan_raw)
                and all(services[g]['Id'] == cid for g, cid in policy.get('gateway_start_ids', {}).items()),
                'V7_ADOPTION_BOOT_POLICY_INCONSISTENT')
        policy_bytes = runtime.sealed_bytes(dict(policy, adoption_ref=native.reference(ADOPTION, state_bytes),
                                                 plan_ref=native.reference(PLAN, plan_bytes)))
    proposal = {'schema_version': 1, 'before': {'state_sha256': digest(state_raw), 'plan_sha256': digest(plan_raw),
                                                 'policy_sha256': digest(policy_raw) if policy_raw is not None else None},
                'after': {'state_sha256': digest(state_bytes), 'plan_sha256': digest(plan_bytes),
                          'policy_sha256': digest(policy_bytes) if policy_bytes is not None else None},
                'summary': {'recreated': summary['recreated'], 'unchanged': sorted(summary['unchanged']),
                            'postgres': summary['postgres'], 'profiles': profile, 'networks_added': sorted(added),
                            'backup_env': backup_env,
                            'proxy': None if proxy is None else {'transition': proxy['transition'],
                                                                 'rewritten_to_target': proxy['rewritten_to_target']}}}
    return proposal, {'state': state_bytes, 'plan': plan_bytes, 'policy': policy_bytes}


class Host:
    """Root reads on the VM. Tests replace it."""

    def __init__(self, root):
        self.root = Path(root)

    def command(self, argv, _root=None):
        result = subprocess.run(argv, cwd=self.root, capture_output=True, text=True, timeout=60)
        require(result.returncode == 0, 'V7_ADOPTION_COMMAND_FAILED:'+os.path.basename(argv[0]))
        return result.stdout

    def rows(self):
        ids = self.command(['docker', 'ps', '-aq', '--no-trunc']).split()
        require(5 <= len(ids) <= 11 and len(set(ids)) == len(ids), 'V7_ADOPTION_INVENTORY_BOUND')
        return runtime._parse(self.command(['docker', 'inspect', *ids]).encode())

    def private(self, path, optional=False):
        if optional and not Path(path).exists():
            return None
        return native.protected_bytes(path)


def write_private(path, raw):
    path = Path(path)
    tmp = path.with_name('.'+path.name+'.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as target:
        target.write(raw); target.flush(); os.fsync(target.fileno())
    os.replace(tmp, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    require(native.protected_bytes(path) == raw, 'V7_ADOPTION_WRITE_READBACK_FAILED')


def base_dir():
    if not BASE.exists():
        BASE.mkdir(mode=0o700)
    info = BASE.lstat()
    require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700 and info.st_uid == 0, 'V7_ADOPTION_DIRECTORY_UNSAFE')
    return BASE


def capture(host):
    state_raw, plan_raw = host.private(ADOPTION), host.private(PLAN)
    state = runtime._parse(state_raw); runtime.validate_state(state); runtime.validate_plan(state, plan_raw)
    rows = host.rows()
    services = runtime.validate_inventory(state, rows)
    for ref in state['canonical_files'].values():
        native.read_reference(ref)
    saved = [sanitized(row) for row in services.values()]
    document = {'schema_version': 1, 'captured_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                'state_sha256': digest(state_raw), 'plan_sha256': digest(plan_raw), 'rows': saved,
                'sanitized_digests': {row['Id']: runtime.definition_digest(row) for row in saved},
                'profiles': {name: env_digests(host.private(PRIVATE/name)) for name in PROFILE_FILES}}
    path = base_dir()/'capture.json'
    require(not path.exists(), 'V7_ADOPTION_CAPTURE_EXISTS')
    write_private(path, encode(document))
    return {'state': 'CAPTURED', 'services': sorted(services), 'capture_sha256': digest(encode(document))}


def observe(host):
    capture_doc = runtime._parse(host.private(base_dir()/'capture.json'))
    state_raw, plan_raw = host.private(ADOPTION), host.private(PLAN)
    policy_raw = host.private(BOOT_POLICY, optional=True)
    receipt_raw = host.private(PITR_RECEIPT, optional=True)
    rows = host.rows()
    state = runtime._parse(state_raw)
    services = runtime.inspect_inventory(rows, portal=state['portal'], caddy_id=state['service_inventory']['caddy'])
    networks = runtime.network_snapshot(host.command, host.root, services)
    release = native.env_values(host.private(PRIVATE/'release.env'))
    runtime.topology(host.command, host.root, services, networks, release)
    runtime.verify_edge(host, host.root, state, services, release)
    proxy = proxy_transition(host, state, services)
    files = {name: host.private(PRIVATE/name) for name in runtime.FILES}
    proposal, documents = propose(capture_doc, state_raw, plan_raw, policy_raw, rows, networks, files,
                                  runtime._parse(receipt_raw) if receipt_raw else None, release, proxy=proxy)
    return proposal, documents, {'state': state_raw, 'plan': plan_raw, 'policy': policy_raw}


def apply(host, expected):
    require(re.fullmatch(r'[a-f0-9]{64}', expected or ''), 'V7_ADOPTION_PROPOSAL_DIGEST_REQUIRED')
    locks = native.acquire_locks(PRIVATE)
    try:
        proposal, documents, old = observe(host)
        require(digest(encode(proposal)) == expected, 'V7_ADOPTION_PROPOSAL_CHANGED')
        journal_path = base_dir()/'journal.json'
        require(not journal_path.exists(), 'V7_ADOPTION_PREVIOUS_JOURNAL_PRESENT')
        journal = {'schema_version': 1, 'status': 'PREWRITE', 'proposal_sha256': expected, **proposal['after'],
                   'base_receipt_ref': runtime._parse(old['state'])['last_release_receipt_ref']}
        write_private(journal_path, encode(journal))
        history = PRIVATE/'daily-b02/plan-history'
        history.mkdir(mode=0o700, exist_ok=True)
        kept = history/(digest(old['plan'])+'.json')
        if not kept.exists():
            write_private(kept, old['plan'])
        require(native.protected_bytes(kept) == old['plan'], 'V7_ADOPTION_PLAN_HISTORY_CHANGED')
        require(host.private(ADOPTION) == old['state'] and host.private(PLAN) == old['plan'], 'V7_ADOPTION_PAIR_CAS_CHANGED')
        write_private(PLAN, documents['plan'])
        write_private(ADOPTION, documents['state'])
        if documents['policy'] is not None:
            require(host.private(BOOT_POLICY) == old['policy'], 'V7_ADOPTION_BOOT_POLICY_CAS_CHANGED')
            write_private(BOOT_POLICY, documents['policy'])
        journal.update(status='APPLIED', applied_at=dt.datetime.now(dt.timezone.utc).isoformat())
        write_private(journal_path, encode(journal))
        return {'state': 'ADOPTED', 'proposal_sha256': expected, **proposal['summary']}
    finally:
        for stream in reversed(locks):
            stream.close()


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        require(os.geteuid() == 0, 'V7_ADOPTION_ROOT_REQUIRED')
        host = Host(Path(__file__).resolve().parents[1])
        if argv == ['capture']:
            result = capture(host)
        elif argv == ['observe']:
            proposal, _documents, _old = observe(host)
            result = {'state': 'PROPOSED', 'proposal_sha256': digest(encode(proposal)), **proposal['summary']}
        elif len(argv) == 2 and argv[0] == 'apply':
            result = apply(host, argv[1])
        elif argv == ['rebind-backup-env']:
            result = rebind_backup_env(host)
        else:
            raise ReleaseError('usage: v7_infra_adoption.py capture | observe | apply <sha256> | rebind-backup-env')
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ReleaseError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print(json.dumps({'state': 'V7_ADOPTION_FAILED', 'error': str(error)[:300]}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
