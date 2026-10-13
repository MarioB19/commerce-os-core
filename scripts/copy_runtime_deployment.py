"""Copy-runtime controller: pure guards first, protected adapters below.

Inputs are private observations supplied by Root. Shape/hash validation is not
an attestation that Root read a file, that a canonical operation occurred, or
that a channel is connected. The existing protected readers and owner helpers
remain the authority for those facts. Never print these input objects.
"""
import copy
import datetime as dt
import hashlib
import json
from pathlib import PurePosixPath
import re
from ci_release import ReleaseError, require
import ci_provider_evidence as provider_evidence

PRIVATE = PurePosixPath('/opt/commerce-os/private')
SOURCE_SHA = 'd36c090161eb7b0af0250cd91d466b38dc810813'
CORE = frozenset({'api', 'web', 'postgres', 'caddy', 'portal', 'ingress',
                  'automation-worker', 'channel-worker'})
INITIAL = frozenset({'api', 'web', 'postgres', 'caddy', 'portal'})
GATEWAYS = frozenset({'waha-01', 'waha-02', 'waha-03'})
FILES = frozenset({'release.env', 'api.env', 'ingress.env', 'automation.env',
                   'channel.env', 'postgres.env', 'admin.env', 'backup.env'})
BASE_FIELDS = frozenset({'schema_version', 'status', 'scope', 'backup_source_sha',
    'current_release', 'smtp_transition_ref', 'canonical_files', 'preserved_runtime',
    'b02_plan_sha256', 'network_baseline', 'active_proxy_sha256', 'caddy_config_ref',
    'policy_version', 'firewall_rule_count', 'portal'})
V3_FIELDS = BASE_FIELDS | {'runtime_stage', 'runtime_projection_version', 'service_inventory',
    'b02_plan_ref', 'owner_workspace_id', 'policy_body_sha256',
    'last_release_receipt_ref', 'gateway_provisioning', 'consumer_edge_ref'}
PORTAL_FIELDS = frozenset({'report_ref', 'runtime_env_ref', 'manifest_ref',
                          'container_id', 'image', 'proxy_network', 'source_sha', 'run_id'})
MAX_BYTES = 1024 * 1024


def sealed_bytes(value):
    """Canonical private representation; not a public report serializer."""
    try:
        return json.dumps(value, sort_keys=True, separators=(',', ':'),
                          allow_nan=False).encode()
    except (TypeError, ValueError):
        raise ReleaseError('COPY_RUNTIME_JSON_INVALID') from None


def sha256(raw):
    require(type(raw) is bytes, 'COPY_RUNTIME_BYTES_REQUIRED')
    return hashlib.sha256(raw).hexdigest()


def _hash(value, length=64):
    return type(value) is str and re.fullmatch('[a-f0-9]{'+str(length)+'}', value) is not None


def _identifier(value):
    return type(value) is str and re.fullmatch(r'[A-Za-z0-9_:-]{1,160}', value) is not None


def _path(value):
    if type(value) is not str or not value.startswith('/') or '\\' in value:
        return False
    path = PurePosixPath(value)
    return str(path) == value and '..' not in path.parts and not any(ord(c) < 32 for c in value)


def reference(ref, exact_path=None):
    require(type(ref) is dict and set(ref) == {'path', 'bytes', 'sha256'}
            and _path(ref.get('path')) and type(ref.get('bytes')) is int
            and 0 < ref['bytes'] <= MAX_BYTES and _hash(ref.get('sha256')),
            'COPY_RUNTIME_REFERENCE_INVALID')
    require(exact_path is None or ref['path'] == str(exact_path),
            'COPY_RUNTIME_REFERENCE_PATH_INVALID')
    return ref


def readback(ref, raw):
    reference(ref)
    require(type(raw) is bytes and len(raw) == ref['bytes'] and sha256(raw) == ref['sha256'],
            'COPY_RUNTIME_REFERENCE_READBACK_CHANGED')


def _parse(raw):
    require(type(raw) is bytes and 0 < len(raw) <= MAX_BYTES, 'COPY_RUNTIME_INPUT_BOUND')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'COPY_RUNTIME_DUPLICATE_FIELD')
            result[key] = value
        return result
    def invalid(_):
        raise ReleaseError('COPY_RUNTIME_JSON_INVALID')
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ReleaseError('COPY_RUNTIME_JSON_INVALID') from None


def _portal(portal):
    require(type(portal) is dict and set(portal) == PORTAL_FIELDS,
            'COPY_RUNTIME_PORTAL_INVALID')
    require(_hash(portal['container_id']) and _hash(portal['source_sha'], 40)
            and type(portal['image']) is str and re.fullmatch(r'sha256:[a-f0-9]{64}', portal['image'])
            and type(portal['run_id']) is str and re.fullmatch(r'[0-9]+-[0-9]+', portal['run_id'])
            and type(portal['proxy_network']) is str
            and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', portal['proxy_network']),
            'COPY_RUNTIME_PORTAL_IDENTITY_INVALID')
    reference(portal['report_ref'], '/opt/mcl-portal/current.json')
    reference(portal['runtime_env_ref'], '/opt/mcl-portal/releases/'+portal['run_id']+'/runtime.env')
    reference(portal['manifest_ref'])
    path = PurePosixPath(portal['manifest_ref']['path'])
    require(path.name == 'portal-manifest.json' and path.parent.parent == PRIVATE.parent/'releases',
            'COPY_RUNTIME_PORTAL_MANIFEST_PATH_INVALID')


def _base(state, version):
    require(type(state) is dict and type(state.get('schema_version')) is int
            and state['schema_version'] == version,
            'COPY_RUNTIME_SCHEMA_INVALID')
    require(state['backup_source_sha'] == SOURCE_SHA and type(state['firewall_rule_count']) is int
            and state['firewall_rule_count'] == 9 and type(state['policy_version']) is int
            and state['policy_version'] > 0, 'COPY_RUNTIME_BASELINE_INVALID')
    require(_path(state['current_release'])
            and PurePosixPath(state['current_release']).parent == PRIVATE.parent/'releases',
            'COPY_RUNTIME_RELEASE_INVALID')
    require(type(state['canonical_files']) is dict and set(state['canonical_files']) == FILES,
            'COPY_RUNTIME_PROFILE_SET_INVALID')
    for name, ref in state['canonical_files'].items():
        reference(ref, PRIVATE/name)
    for name in ('smtp_transition_ref', 'caddy_config_ref'):
        reference(state[name])
    require(_hash(state['b02_plan_sha256']) and _hash(state['active_proxy_sha256'])
            and type(state['network_baseline']) is dict and bool(state['network_baseline']),
            'COPY_RUNTIME_BASELINE_INVALID')
    _portal(state['portal'])


def validate_state(state):
    """Closed v3 shape. Root must additionally authenticate every reference."""
    require(type(state) is dict and set(state) == V3_FIELDS,
            'COPY_RUNTIME_STATE_FIELDS_INVALID')
    _base(state, 3)
    require(state['runtime_stage'] in {'CORE_PREPARED', 'OPERATING'}
            and state['status'] == ('PREPARED_ACTION_REQUIRED' if state['runtime_stage'] == 'CORE_PREPARED' else 'ADOPTED_COPY_RUNTIME')
            and state['scope'] == 'copy-runtime'
            and type(state['runtime_projection_version']) is int
            and state['runtime_projection_version'] == 2,
            'COPY_RUNTIME_NOT_APPROVED')
    services = state['service_inventory']
    required = INITIAL if state['runtime_stage'] == 'CORE_PREPARED' else CORE
    allowed = INITIAL if state['runtime_stage'] == 'CORE_PREPARED' else CORE | GATEWAYS
    require(type(services) is dict and required <= set(services)
            and set(services) <= allowed and all(_hash(cid) for cid in services.values())
            and len(set(services.values())) == len(services), 'COPY_RUNTIME_SERVICE_SET_INVALID')
    require(services['portal'] == state['portal']['container_id'], 'COPY_RUNTIME_PORTAL_CONTAINER_CHANGED')
    runtime = state['preserved_runtime']
    require(type(runtime) is dict and set(runtime) == set(services.values())
            and all(_hash(value) for value in runtime.values()), 'COPY_RUNTIME_DEFINITION_SET_INVALID')
    gateways = state['gateway_provisioning']
    require(type(gateways) is dict and set(gateways) == set(services) & GATEWAYS,
            'COPY_RUNTIME_GATEWAY_PROVISIONING_REQUIRED')
    for name, receipt in gateways.items():
        require(type(receipt) is dict
                and set(receipt) == {'operation_id', 'slot', 'overlay_ref', 'definition_sha256'}
                and type(receipt['operation_id']) is str
                and re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', receipt['operation_id'])
                and type(receipt['slot']) is int and receipt['slot'] == int(name[-2:])
                and receipt['definition_sha256'] == runtime[services[name]],
                'COPY_RUNTIME_GATEWAY_PROVISIONING_INVALID')
        reference(receipt['overlay_ref'])
    require(_identifier(state['owner_workspace_id']) and _hash(state['policy_body_sha256']),
            'COPY_RUNTIME_OWNER_POLICY_INVALID')
    reference(state['b02_plan_ref'], PRIVATE/'daily-b02/plan.json')
    require(state['b02_plan_ref']['sha256'] == state['b02_plan_sha256'], 'COPY_RUNTIME_PLAN_REFERENCE_CHANGED')
    reference(state['consumer_edge_ref'])
    edge_path = PurePosixPath(state['consumer_edge_ref']['path'])
    require(edge_path.parent.parent == PRIVATE/'deployments' and edge_path.name == 'consumer-edge.json'
            and provider_evidence.installation_id(edge_path.parent.name), 'COPY_RUNTIME_EDGE_RECEIPT_PATH_INVALID')
    reference(state['last_release_receipt_ref'])
    receipt = PurePosixPath(state['last_release_receipt_ref']['path'])
    require(receipt.parent.parent == PRIVATE/'deployments' and receipt.name in {'report.json', 'adoption-receipt.json'}
            and provider_evidence.installation_id(receipt.parent.name), 'COPY_RUNTIME_RELEASE_RECEIPT_INVALID')
    return state


def static_projection(row):
    """Definition, not PID/start time/health or ephemeral endpoint IDs/addresses.

    Root separately checks network metadata, all endpoints and actual routes.
    Secrets in Config.Env remain private RAM and are represented only by a hash.
    """
    require(type(row) is dict and all(key in row for key in
            ('Id', 'Image', 'Name', 'Config', 'HostConfig', 'Mounts', 'NetworkSettings')),
            'COPY_RUNTIME_INSPECT_INVALID')
    require(_hash(row['Id']) and type(row['Image']) is str
            and re.fullmatch(r'sha256:[a-f0-9]{64}', row['Image'])
            and type(row['Name']) is str and re.fullmatch(r'/[A-Za-z0-9_.-]{1,200}', row['Name'])
            and type(row['Config']) is dict and type(row['HostConfig']) is dict
            and type(row['Mounts']) is list and type(row['NetworkSettings']) is dict,
            'COPY_RUNTIME_INSPECT_INVALID')
    networks = row['NetworkSettings'].get('Networks')
    require(type(networks) is dict and 0 < len(networks) <= 8,
            'COPY_RUNTIME_NETWORKS_INVALID')
    definition = {key: copy.deepcopy(row[key]) for key in
                  ('Id', 'Image', 'Name', 'Config', 'HostConfig', 'Mounts')}
    selected = {}
    for name, endpoint in networks.items():
        require(type(name) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', name)
                and type(endpoint) is dict and _hash(endpoint.get('NetworkID')),
                'COPY_RUNTIME_NETWORKS_INVALID')
        aliases = endpoint.get('Aliases') or []
        require(type(aliases) is list and all(type(alias) is str and 0 < len(alias) <= 253 for alias in aliases)
                and type(endpoint.get('GwPriority', 0)) is int and 0 <= endpoint.get('GwPriority', 0) <= 10,
                'COPY_RUNTIME_NETWORKS_INVALID')
        selected[name] = {'NetworkID': endpoint['NetworkID'], 'Aliases': sorted(aliases),
                          'GwPriority': endpoint.get('GwPriority', 0)}
    definition['NetworkSettings'] = {'Networks': selected}
    return definition


def definition_digest(row):
    return sha256(sealed_bytes(static_projection(row)))


def live_projection(row):
    state = row.get('State') if type(row) is dict else None
    keys = ('Running', 'Paused', 'Restarting', 'Pid', 'StartedAt')
    require(type(state) is dict and all(key in state for key in keys)
            and all(type(state[key]) is bool for key in keys[:3])
            and type(state['Pid']) is int and state['Pid'] >= 0
            and type(state['StartedAt']) is str, 'COPY_RUNTIME_LIVE_STATE_INVALID')
    try:
        started = dt.datetime.fromisoformat(state['StartedAt'].replace('Z', '+00:00'))
    except ValueError:
        raise ReleaseError('COPY_RUNTIME_LIVE_STATE_INVALID') from None
    require(started.tzinfo is not None and started.utcoffset() == dt.timedelta(0)
            and not state['Paused'] and not state['Restarting']
            and (state['Pid'] > 0 if state['Running'] else state['Pid'] == 0),
            'COPY_RUNTIME_LIVE_STATE_INVALID')
    return {key: state[key] for key in keys}


def _gateway(row):
    require(row['HostConfig'].get('PortBindings') in ({}, None)
            and row['HostConfig'].get('RestartPolicy', {}).get('Name') == 'no',
            'COPY_RUNTIME_GATEWAY_PUBLIC_OR_AUTOSTART')
    ports = row['NetworkSettings'].get('Ports', {})
    require(type(ports) is dict and all(value is None for value in ports.values()),
            'COPY_RUNTIME_GATEWAY_PUBLIC_OR_AUTOSTART')
    env = row['Config'].get('Env')
    require(type(env) is list and all(type(item) is str and '=' in item for item in env),
            'COPY_RUNTIME_GATEWAY_ENV_INVALID')
    pairs = [item.split('=', 1) for item in env]
    require(len({key for key, _ in pairs}) == len(pairs), 'COPY_RUNTIME_GATEWAY_ENV_INVALID')
    values = dict(pairs)
    required = {'WHATSAPP_DEFAULT_ENGINE': 'GOWS', 'WAHA_PRINT_QR': 'false',
        'WAHA_DASHBOARD_ENABLED': 'false', 'WHATSAPP_SWAGGER_ENABLED': 'false',
        'WHATSAPP_RESTART_ALL_SESSIONS': 'false', 'WAHA_WORKER_RESTART_SESSIONS': 'false',
        'WHATSAPP_START_SESSION': '', 'WAHA_APPS_ENABLED': 'false'}
    require(all(values.get(key) == value for key, value in required.items()),
            'COPY_RUNTIME_GATEWAY_PUBLIC_OR_AUTOSTART')


def inspect_inventory(rows, *, portal, caddy_id, initial=False):
    required = INITIAL if initial else CORE
    allowed = INITIAL if initial else CORE | GATEWAYS
    require(type(rows) is list and len(required) <= len(rows) <= len(allowed)
            and _hash(caddy_id), 'COPY_RUNTIME_INVENTORY_BOUND')
    _portal(portal)
    services = {}; ids = set()
    for row in rows:
        definition = static_projection(row); live = live_projection(row)
        require(row['Id'] not in ids, 'COPY_RUNTIME_DUPLICATE_CONTAINER')
        ids.add(row['Id'])
        labels = row['Config'].get('Labels') or {}
        require(type(labels) is dict, 'COPY_RUNTIME_LABELS_INVALID')
        if row['Id'] == portal['container_id']:
            require(row['Image'] == portal['image'] and row['Name'] == '/mcl-portal-'+portal['run_id']
                    and labels.get('com.inovaris.product') == 'mi-ciclo-listo-portal'
                    and labels.get('com.inovaris.source-sha') == portal['source_sha']
                    and set(definition['NetworkSettings']['Networks']) == {portal['proxy_network']},
                    'COPY_RUNTIME_PORTAL_IDENTITY_CHANGED')
            service = 'portal'
        elif row['Id'] == caddy_id:
            service = 'caddy'
        else:
            require(labels.get('com.docker.compose.project') == 'commerce-os',
                    'COPY_RUNTIME_FOREIGN_CONTAINER')
            service = labels.get('com.docker.compose.service')
        require(service in allowed and service not in services, 'COPY_RUNTIME_SERVICE_SET_INVALID')
        if service in GATEWAYS:
            _gateway(row)
        else:
            require(live['Running'], 'COPY_RUNTIME_CORE_NOT_RUNNING')
        services[service] = row
    require(required <= set(services), 'COPY_RUNTIME_SERVICE_SET_INVALID')
    return services


def validate_inventory(state, rows):
    validate_state(state)
    services = inspect_inventory(rows, portal=state['portal'], caddy_id=state['service_inventory']['caddy'],
                                 initial=state['runtime_stage'] == 'CORE_PREPARED')
    require({name: row['Id'] for name, row in services.items()} == state['service_inventory'],
            'COPY_RUNTIME_CONTAINER_SET_CHANGED')
    require({row['Id']: definition_digest(row) for row in services.values()} == state['preserved_runtime'],
            'COPY_RUNTIME_STATIC_DEFINITION_CHANGED')
    return services


def compare_live_snapshot(before, after):
    """One operation's captured instances must not restart during that operation.

    A legitimate restart between operations can use a fresh capture after the
    static/identity guards pass; no stored PID is silently 'reconciled'.
    """
    require(type(before) is dict and type(after) is dict and set(before) == set(after),
            'COPY_RUNTIME_LIVE_INVENTORY_CHANGED')
    for name in before:
        require(definition_digest(before[name]) == definition_digest(after[name])
                and live_projection(before[name]) == live_projection(after[name])
                and before[name]['NetworkSettings'] == after[name]['NetworkSettings'],
                'COPY_RUNTIME_OPERATION_INSTANCE_CHANGED')


def validate_plan(state, raw):
    validate_state(state)
    readback(state['b02_plan_ref'], raw)
    plan = _parse(raw)
    require(type(plan) is dict and plan.get('runtime_projection_version') == 2
            and type(plan.get('runtime_projection_version')) is int
            and plan.get('runtime_stage') == state['runtime_stage']
            and plan.get('preserved_runtime') == state['preserved_runtime'],
            'COPY_RUNTIME_B02_DEFINITION_CHANGED')
    return plan  # existing B02 controller must validate every other native field


def canonical_revisions(previous, observed, receipts):
    """Shape of Root-read, audit-bound receipts; never accepts unsigned 'approved'."""
    fields = {'previous_version', 'version', 'before_policy_sha256', 'after_policy_sha256',
              'actor_id', 'operation', 'resource_key', 'receipt_ref'}
    require(type(receipts) is list and len(receipts) <= 100,
            'COPY_RUNTIME_REVISION_RECEIPTS_INVALID')
    require(all(type(value) is dict and set(value) == {'policy_version', 'policy_body_sha256'}
                and type(value['policy_version']) is int and value['policy_version'] > 0
                and _hash(value['policy_body_sha256']) for value in (previous, observed)),
            'COPY_RUNTIME_POLICY_OBSERVATION_INVALID')
    version, digest = previous['policy_version'], previous['policy_body_sha256']
    seen = set()
    for receipt in receipts:
        require(type(receipt) is dict and set(receipt) == fields
                and type(receipt['previous_version']) is int and type(receipt['version']) is int
                and receipt['previous_version'] == version and receipt['version'] == version+1
                and receipt['before_policy_sha256'] == digest and _hash(receipt['after_policy_sha256'])
                and _identifier(receipt['actor_id'])
                and receipt['operation'] in {'integration.settings_updated', 'integration.settings_disabled',
                                        'operational_settings.updated', 'operations.launch_opened'}
                and _identifier(receipt['resource_key']), 'COPY_RUNTIME_CANONICAL_REVISION_INVALID')
        reference(receipt['receipt_ref'])
        require(receipt['receipt_ref']['path'] not in seen, 'COPY_RUNTIME_REVISION_RECEIPT_REUSED')
        seen.add(receipt['receipt_ref']['path'])
        version, digest = receipt['version'], receipt['after_policy_sha256']
    require(observed['policy_version'] == version and observed['policy_body_sha256'] == digest,
            'COPY_RUNTIME_UNEXPLAINED_REVISION')


def compare_owner(before, after, workspace, compare_owner_auth):
    require(callable(compare_owner_auth) and _identifier(workspace), 'COPY_RUNTIME_OWNER_VALIDATOR_REQUIRED')
    facts = compare_owner_auth(before, after)
    require(type(facts) is dict and facts.get('identity_preserved') is True
            and all(token['workspace_id'] == workspace for value in (before, after) for token in value['tokens']),
            'COPY_RUNTIME_OWNER_IDENTITY_CHANGED')
    return facts


def _legacy_digest(row):
    # Exact existing api_web_deployment.projection_digest/b02 contract v1.
    projection = {key: copy.deepcopy(row[key]) for key in
                  ('Id', 'Image', 'Config', 'HostConfig', 'Mounts', 'NetworkSettings')}
    projection['State'] = live_projection(row)
    return sha256(sealed_bytes(projection))


def validate_initial_continuity(previous, candidate, before_rows, after_rows, *,
                                before_owner, after_owner, compare_owner_auth):
    """Preserve the actual five-service v2 boundary while adding consumers.

    Route/kernel/provisioning/revision/queue evidence is still required by Root.
    This pure guard neither proves those observations nor authorizes first start.
    """
    require(type(previous) is dict and set(previous) == BASE_FIELDS
            and previous['status'] == 'ADOPTED_EXISTING_API_WEB' and previous['scope'] == 'api-web'
            and previous['policy_version'] == 93, 'COPY_RUNTIME_V2_BASELINE_INVALID')
    _base(previous, 2)
    legacy = previous['preserved_runtime']
    require(type(legacy) is dict and len(legacy) == 5
            and all(_hash(key) and _hash(value) for key, value in legacy.items())
            and previous['portal']['container_id'] in legacy, 'COPY_RUNTIME_V2_INVENTORY_INVALID')
    candidates = [row for row in before_rows if type(row) is dict
                  and row.get('Id') != previous['portal']['container_id']
                  and (row.get('Config', {}).get('Labels') or {}).get('com.docker.compose.project') != 'commerce-os']
    require(len(candidates) == 1, 'COPY_RUNTIME_CADDY_BASELINE_AMBIGUOUS')
    before = inspect_inventory(before_rows, portal=previous['portal'], caddy_id=candidates[0]['Id'], initial=True)
    require({row['Id']: _legacy_digest(row) for row in before.values()} == legacy,
            'COPY_RUNTIME_V2_ACTUAL_BASELINE_CHANGED')
    after = validate_inventory(candidate, after_rows)
    require(previous['portal'] == candidate['portal']
            and previous['smtp_transition_ref'] == candidate['smtp_transition_ref']
            and previous['caddy_config_ref'] == candidate['caddy_config_ref']
            and previous['active_proxy_sha256'] == candidate['active_proxy_sha256'],
            'COPY_RUNTIME_TRANSITION_BOUNDARY_CHANGED')
    for name in {'postgres', 'caddy', 'portal'}:
        require(definition_digest(before[name]) == definition_digest(after[name])
                and live_projection(before[name]) == live_projection(after[name]),
                'COPY_RUNTIME_PRESERVED_INFRASTRUCTURE_CHANGED')
    for name in ('api', 'web'):
        old, new = static_projection(before[name]), static_projection(after[name])
        require(old['HostConfig'] == new['HostConfig'] and old['Mounts'] == new['Mounts']
                and old['NetworkSettings'] == new['NetworkSettings'],
                'COPY_RUNTIME_APPLICATION_BOUNDARY_CHANGED')
    for name in FILES - {'release.env', 'api.env'}:
        require(previous['canonical_files'][name] == candidate['canonical_files'][name],
                'COPY_RUNTIME_PRIVATE_PROFILE_CHANGED')
    return compare_owner(before_owner, after_owner, candidate['owner_workspace_id'], compare_owner_auth)


def validate_publication(previous, candidate, before_rows, after_rows, *,
                         before_owner, after_owner, compare_owner_auth,
                         observed_policy=None, revision_receipts=None):
    """A subsequent publication preserves infra and ownership without policy93."""
    before = validate_inventory(previous, before_rows)
    after = validate_inventory(candidate, after_rows)
    require(previous['owner_workspace_id'] == candidate['owner_workspace_id']
            and previous['portal'] == candidate['portal']
            and previous['smtp_transition_ref'] == candidate['smtp_transition_ref']
            and previous['caddy_config_ref'] == candidate['caddy_config_ref']
            and previous['active_proxy_sha256'] == candidate['active_proxy_sha256']
            and previous['network_baseline'] == candidate['network_baseline']
            and previous['gateway_provisioning'] == candidate['gateway_provisioning'],
            'COPY_RUNTIME_PRESERVED_BOUNDARY_CHANGED')
    require(set(before) == set(after), 'COPY_RUNTIME_UNPROVISIONED_GATEWAY_CHANGE')
    for name in {'postgres', 'caddy', 'portal'} | (set(before) & GATEWAYS):
        require(definition_digest(before[name]) == definition_digest(after[name])
                and live_projection(before[name]) == live_projection(after[name]),
                'COPY_RUNTIME_PRESERVED_INFRASTRUCTURE_CHANGED')
    for name in CORE - {'postgres', 'caddy', 'portal'}:
        old, new = static_projection(before[name]), static_projection(after[name])
        require(old['HostConfig'] == new['HostConfig'] and old['Mounts'] == new['Mounts']
                and old['NetworkSettings'] == new['NetworkSettings'],
                'COPY_RUNTIME_APPLICATION_BOUNDARY_CHANGED')
    previous_policy = {key: previous[key] for key in ('policy_version', 'policy_body_sha256')}
    observed_policy = previous_policy if observed_policy is None else observed_policy
    canonical_revisions(previous_policy, observed_policy, [] if revision_receipts is None else revision_receipts)
    require((observed_policy['policy_version'], observed_policy['policy_body_sha256'])
            == (candidate['policy_version'], candidate['policy_body_sha256']),
            'COPY_RUNTIME_POLICY_CHANGED_BY_PUBLICATION')
    for name in FILES - {'release.env', 'api.env'}:
        require(previous['canonical_files'][name] == candidate['canonical_files'][name],
                'COPY_RUNTIME_PRIVATE_PROFILE_CHANGED')
    return compare_owner(before_owner, after_owner, previous['owner_workspace_id'], compare_owner_auth)


def validate_cas_transition(before_raw, current_raw, before_plan_raw, current_plan_raw, *,
                            expected_state_sha256, expected_plan_sha256, candidate, candidate_plan_raw):
    """Pre-write CAS only; the caller must journal, atomically write and read back.

    This function does not write, manufacture a v3 state, or issue a SUCCEEDED
    receipt. It deliberately returns no replay/recovery authorization.
    """
    require(before_raw == current_raw and before_plan_raw == current_plan_raw
            and _hash(expected_state_sha256) and sha256(current_raw) == expected_state_sha256
            and _hash(expected_plan_sha256) and sha256(current_plan_raw) == expected_plan_sha256,
            'COPY_RUNTIME_CAS_CHANGED')
    previous = _parse(before_raw)
    require(type(previous) is dict and type(previous.get('schema_version')) is int
            and previous['schema_version'] in (2, 3), 'COPY_RUNTIME_PREVIOUS_SCHEMA_INVALID')
    if previous['schema_version'] == 2:
        require(set(previous) == BASE_FIELDS and previous['status'] == 'ADOPTED_EXISTING_API_WEB'
                and previous['scope'] == 'api-web' and previous['policy_version'] == 93,
                'COPY_RUNTIME_V2_BASELINE_INVALID')
        _base(previous, 2)
        require(type(previous['preserved_runtime']) is dict and len(previous['preserved_runtime']) == 5
                and all(_hash(key) and _hash(value) for key, value in previous['preserved_runtime'].items())
                and previous['portal']['container_id'] in previous['preserved_runtime']
                and len(previous['network_baseline']) == 3, 'COPY_RUNTIME_V2_INVENTORY_INVALID')
    else:
        validate_state(previous)
    validate_plan(candidate, candidate_plan_raw)
    old_plan = _parse(before_plan_raw); new_plan = _parse(candidate_plan_raw)
    require(type(old_plan) is dict and previous['b02_plan_sha256'] == sha256(before_plan_raw),
            'COPY_RUNTIME_PREVIOUS_PLAN_CHANGED')
    allowed = {'preserved_runtime', 'runtime_projection_version', 'runtime_stage', 'schema_version'}
    require({key: value for key, value in old_plan.items() if key not in allowed}
            == {key: value for key, value in new_plan.items() if key not in allowed},
            'COPY_RUNTIME_B02_REBASE_SCOPE')
    require(previous['backup_source_sha'] == candidate['backup_source_sha']
            and previous['portal'] == candidate['portal']
            and previous['smtp_transition_ref'] == candidate['smtp_transition_ref']
            and previous['caddy_config_ref'] == candidate['caddy_config_ref']
            and previous['active_proxy_sha256'] == candidate['active_proxy_sha256'],
            'COPY_RUNTIME_TRANSITION_BOUNDARY_CHANGED')
    return {'prewrite_cas_validated': True, 'state_written': False,
            'consumers_started': False, 'physical_sales_proven': False}


# Protected adapters reuse the existing readers/locks/publisher. No I/O on import.
import os
from pathlib import Path
import shutil
import stat
import time
import api_web_deployment as native
from ci_release import extract_release, verify_migrations, verify_package
import contextlib
import importlib.util
import sys
import signal

MIGRATION_NAMES = frozenset({'0066_pending_channel_cancellation.sql', '0067_copy_source_isolation.sql'})
OPERATING_MIGRATION_NAMES = frozenset({'0068_operational_metric_writer.sql'})
# V7 F2 profile cutover: the exact reviewed 68→104 set, applied as one bounded
# OPERATING publication (docs/adr-v7-isolation-model.md). Names are fixed here;
# hashes come from the private review and must equal the candidate's files.
V7_PROFILE_MIGRATION_NAMES = frozenset({
    '0069_v7_cutover_preflight.sql', '0070_v7_profile_identity.sql', '0071_v7_profile_adoption.sql',
    '0072_v7_profile_tokens_settings.sql', '0073_v7_profile_employees_invitations.sql', '0074_v7_market_variants.sql',
    '0075_v7_profile_token_operations.sql', '0076_v7_continuous_authorization.sql', '0077_v7_invitation_mail.sql',
    '0078_v7_continuous_effects.sql', '0079_v7_profile_quotas.sql', '0080_v7_qr_warmup.sql',
    '0081_v7_results_goals_discovery.sql', '0082_v7_ai_admission.sql', '0083_v7_profile_scope_components.sql',
    '0084_v7_quota_and_budget_authority.sql', '0085_v7_quota_adoption.sql', '0086_v7_number_laboratory.sql',
    '0087_v7_result_projections.sql', '0088_v7_receipt_policies.sql', '0089_v7_result_financial_context.sql',
    '0090_v7_result_closure_receipts.sql', '0091_v7_privacy_writer_fences.sql', '0092_v7_privacy_job_authority.sql',
    '0093_v7_commercial_resolution_financial_retention.sql', '0094_v7_record_minimization.sql',
    '0095_v7_privacy_copies_backups.sql', '0096_v7_isolation_model.sql', '0097_v7_service_token_profile_binding.sql',
    '0098_v7_composed_foreign_keys.sql', '0099_v7_api_environment_guard.sql',
    '0100_v7_platform_admin.sql', '0101_v7_profile_integrations.sql', '0102_v7_platform_tokens.sql', '0103_v7_capacity_agent_tokens.sql', '0104_v7_number_identity_claims.sql'})
V7_PROFILE_MIGRATION_TOTAL = 68 + len(V7_PROFILE_MIGRATION_NAMES)


def reviewed_migration_names(metadata):
    expected = metadata.get('migration_hashes')
    require(type(expected) is dict and MIGRATION_NAMES <= set(expected),
            'COPY_RUNTIME_MIGRATION_SET_INVALID')
    if len(expected) == 67 and not OPERATING_MIGRATION_NAMES & set(expected):
        return MIGRATION_NAMES
    if len(expected) == 68 and OPERATING_MIGRATION_NAMES <= set(expected):
        return OPERATING_MIGRATION_NAMES
    require(len(expected) == V7_PROFILE_MIGRATION_TOTAL and OPERATING_MIGRATION_NAMES <= set(expected)
            and V7_PROFILE_MIGRATION_NAMES <= set(expected), 'COPY_RUNTIME_MIGRATION_SET_INVALID')
    return V7_PROFILE_MIGRATION_NAMES


def migration_stage_guard(applied, metadata, *, initial=False, stage=None):
    """Only the reviewed 65→67 cold copy, the 67→68 OPERATING correction or
    the 68→104 OPERATING V7 profile cutover."""
    names = reviewed_migration_names(metadata); expected = metadata['migration_hashes']
    verify_migrations(applied, expected)
    if initial:
        require(names == MIGRATION_NAMES and len(applied) == 65
                and set(expected)-set(applied) == MIGRATION_NAMES, 'COPY_RUNTIME_65_MIGRATION_BASELINE_REQUIRED')
    elif stage == 'CORE_PREPARED':
        require(names == MIGRATION_NAMES and applied == expected, 'COPY_RUNTIME_CONTINUATION_MIGRATIONS_CHANGED')
    elif names == V7_PROFILE_MIGRATION_NAMES:
        require(stage == 'OPERATING'
                and ((len(applied) == 68 and set(expected)-set(applied) == V7_PROFILE_MIGRATION_NAMES)
                     or applied == expected), 'COPY_RUNTIME_68_MIGRATION_BASELINE_REQUIRED')
    else:
        require(stage == 'OPERATING' and names == OPERATING_MIGRATION_NAMES
                and ((len(applied) == 67 and set(expected)-set(applied) == OPERATING_MIGRATION_NAMES)
                     or applied == expected), 'COPY_RUNTIME_67_MIGRATION_BASELINE_REQUIRED')


def installed_migration_identity(root, release, applied):
    metadata = _parse((Path(root)/'RELEASE.json').read_bytes())
    require(metadata.get('source_sha') == release.get('COMMERCE_RELEASE_SHA')
            and metadata.get('migration_hashes') == applied, 'COPY_RUNTIME_INSTALLED_MIGRATION_IDENTITY_CHANGED')


POLICY_KEYS = frozenset({'dispatch_frozen', 'real_sends_enabled', 'allow_real_operations',
    'allow_channel_onboarding', 'contact_messages_per_minute', 'channel_account_concurrency'})
REVISION_OPERATIONS = {'integration.settings_updated': 'integration.settings.update',
    'integration.settings_disabled': 'integration.settings.disable',
    'operational_settings.updated': 'operations.update', 'operations.launch_opened': 'operations.launch_switch'}


HOLD_CAPABILITY = {'schema_version': 1, 'real_channel_api_mutations_blocked': True,
    'real_integration_updates_blocked': True, 'real_channel_claims_blocked': True,
    'real_channel_lifecycle_remote_rechecked': True, 'real_channel_health_reads_blocked': True,
    'real_qr_reads_blocked': True, 'operational_lock': 'operations:<workspace>:REAL'}


def deadline_check(deadline):
    remaining = int(deadline-time.monotonic())
    require(remaining > 0, 'COPY_RUNTIME_DEADLINE_EXCEEDED')
    return remaining


@contextlib.contextmanager
def deadline_fuse(deadline):
    """One Linux Root wall-clock fuse, including native tools and pair CAS.

    A timeout is reconciled from the durable journal; it never authorizes replay,
    database rollback, disappearance of a created network, or early success.
    """
    require(sys.platform == 'linux' and signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0),
            'COPY_RUNTIME_ROOT_DEADLINE_FUSE_REQUIRED')
    previous = signal.getsignal(signal.SIGALRM)
    def expired(_signal, _frame): raise ReleaseError('COPY_RUNTIME_DEADLINE_EXCEEDED')
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, max(0.001, deadline-time.monotonic()))
    try: yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0); signal.signal(signal.SIGALRM, previous)


def continuation_identity(previous_root, candidate_root, release, source_sha, server=None):
    """Continuation keeps the installed API/web and exact prepared image configs.

    Run IDs can differ. Source SHA alone cannot excuse rebuilt images, a changed
    manifest or different shipped controller/SQL bytes for the continuation.
    """
    previous = _parse((Path(previous_root)/'RELEASE.json').read_bytes())
    require(previous.get('source_sha') == source_sha, 'COPY_RUNTIME_CONTINUATION_REQUIRES_PREPARED_CANDIDATE')
    prior_images = _parse((Path(previous_root)/'images.json').read_bytes())
    candidate_images = _parse((Path(candidate_root)/'images.json').read_bytes())
    mapping = {'commerce-os:release': 'COMMERCE_IMAGE', 'commerce-os-web:release': 'COMMERCE_WEB_IMAGE',
               'commerce-os-maintenance:release': 'COMMERCE_MAINTENANCE_IMAGE'}
    for tag, key in mapping.items():
        require(prior_images.get(tag) == candidate_images.get(tag)
                and type(prior_images.get(tag)) is dict and prior_images[tag].get('source_sha') == source_sha
                and type(release.get(key)) is str and re.fullmatch(r'sha256:[a-f0-9]{64}', release[key]),
                'COPY_RUNTIME_CONTINUATION_IMAGE_CHANGED')
        if server is not None:
            observed = _parse(server.command(['docker', 'image', 'inspect', release[key]], previous_root).encode())
            require(type(observed) is list and len(observed) == 1
                    and observed[0].get('Os') == 'linux' and observed[0].get('Architecture') == 'amd64'
                    and observed[0].get('RootFS', {}).get('Layers') == prior_images[tag]['layers']
                    and observed[0].get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') == source_sha,
                    'COPY_RUNTIME_CONTINUATION_INSTALLED_IMAGE_CHANGED')
    require((Path(previous_root)/'web-manifest.json').read_bytes()
            == (Path(candidate_root)/'web-manifest.json').read_bytes(), 'COPY_RUNTIME_CONTINUATION_WEB_MANIFEST_CHANGED')
    def source_manifest(root):
        selected = {}
        for line in (Path(root)/'PACKAGE.sha256').read_text().splitlines():
            match = re.fullmatch(r'([a-f0-9]{64})  (.+)', line)
            require(match is not None, 'COPY_RUNTIME_CONTINUATION_MANIFEST_INVALID')
            name = match[2]
            if name.startswith(('scripts/', 'infra/', 'packages/db/migrations/')):
                require(name not in selected and sha256((Path(root)/name).read_bytes()) == match[1],
                        'COPY_RUNTIME_CONTINUATION_SOURCE_CHANGED')
                selected[name] = match[1]
        require(bool(selected), 'COPY_RUNTIME_CONTINUATION_SOURCE_REQUIRED')
        return selected
    require(source_manifest(previous_root) == source_manifest(candidate_root), 'COPY_RUNTIME_CONTINUATION_SOURCE_CHANGED')
    return True


def loaded_candidate_image(server, root, source_sha):
    images = _parse((Path(root)/'images.json').read_bytes())
    item = images.get('commerce-os:release')
    require(type(item) is dict and item.get('source_sha') == source_sha and type(item.get('layers')) is list,
            'COPY_RUNTIME_CANDIDATE_IMAGE_METADATA_INVALID')
    rows = _parse(server.command(['docker', 'image', 'inspect', 'commerce-os:release'], root).encode())
    require(type(rows) is list and len(rows) == 1, 'COPY_RUNTIME_CANDIDATE_LOADED_IMAGE_REQUIRED')
    info = rows[0]
    require(info.get('Os') == 'linux' and info.get('Architecture') == 'amd64'
            and info.get('RootFS', {}).get('Layers') == item['layers']
            and info.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') == source_sha
            and type(info.get('Id')) is str and re.fullmatch(r'sha256:[a-f0-9]{64}', info['Id']),
            'COPY_RUNTIME_CANDIDATE_LOADED_IMAGE_CHANGED')
    # OCI stores may expose an index ID. The exact config/layers/source are checked
    # here and install-vps uses this freshly inspected immutable loaded ID.
    return info['Id']


def copy_hold_capability(server, root, current_api_id, candidate_image):
    rows = _parse(server.command(['docker', 'inspect', current_api_id], root).encode())
    require(type(rows) is list and len(rows) == 1, 'COPY_RUNTIME_HOLD_RUNNING_IMAGE_UNKNOWN')
    images = (rows[0]['Image'], candidate_image)
    code = "process.stdout.write(require('node:fs').readFileSync('/app/packages/db/src/copy-runtime-hold-capability.json','utf8'))"
    for image in images:
        require(type(image) is str and re.fullmatch(r'sha256:[a-f0-9]{64}', image), 'COPY_RUNTIME_HOLD_IMAGE_UNKNOWN')
        raw = server.command(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
            image, 'node', '-e', code], root)
        value = _parse(raw.encode())
        require(value == HOLD_CAPABILITY and type(value.get('schema_version')) is int
                and all(type(value[name]) is bool for name in ('real_channel_api_mutations_blocked', 'real_integration_updates_blocked',
                    'real_channel_claims_blocked', 'real_channel_lifecycle_remote_rechecked',
                    'real_channel_health_reads_blocked', 'real_qr_reads_blocked')),
                'COPY_RUNTIME_HOLD_API_AND_WORKER_CAPABILITY_REQUIRED')
    return True


def policy(value):
    require(type(value) is dict and set(value) == {'version', 'body'}
            and type(value['version']) is int and value['version'] > 0
            and type(value['body']) is dict and set(value['body']) == POLICY_KEYS,
            'COPY_RUNTIME_POLICY_INVALID')
    body = value['body']
    require(all(type(body[name]) is bool for name in POLICY_KEYS if name.startswith(('dispatch_', 'real_', 'allow_')))
            and type(body['contact_messages_per_minute']) is int and 1 <= body['contact_messages_per_minute'] <= 60
            and type(body['channel_account_concurrency']) is int and 1 <= body['channel_account_concurrency'] <= 10,
            'COPY_RUNTIME_POLICY_INVALID')
    return {'policy_version': value['version'], 'policy_body_sha256': sha256(sealed_bytes(body))}


def sql_literal(value):
    require(type(value) is str and 0 < len(value) <= 200 and not any(ord(c) < 32 for c in value),
            'COPY_RUNTIME_SQL_LITERAL_INVALID')
    return "'" + value.replace("'", "''") + "'"


def current_policy(server, root, workspace):
    value = _parse(server.raw_policy_snapshot(root).encode())
    require(type(value) is dict and set(value) == {workspace}, 'COPY_RUNTIME_SINGLE_WORKSPACE_REQUIRED')
    policy(value[workspace])
    return value[workspace]


def canonical_revision_observation(server, root, state, workspace, current, private):
    """Authenticate Root receipt files against immutable audit + idempotency DB rows.

    Root must preserve each actual before/after policy and API receipt at the time
    of the canonical call. Missing evidence is a concrete block, never a rebase.
    """
    observed = policy(current)
    if state['policy_version'] == current['version']:
        require(state.get('policy_body_sha256', observed['policy_body_sha256']) == observed['policy_body_sha256'],
                'COPY_RUNTIME_POLICY_BODY_CHANGED_WITHOUT_VERSION')
        return observed, []
    path = Path(private)/'copy-runtime-revisions.json'
    require(path.exists(), 'COPY_RUNTIME_CANONICAL_REVISION_RECEIPTS_REQUIRED')
    document = _parse(native.protected_bytes(path))
    require(type(document) is dict and set(document) == {'schema_version', 'workspace_id', 'initial_policy', 'receipts'}
            and type(document['schema_version']) is int and document['schema_version'] == 1
            and document['workspace_id'] == workspace and type(document['receipts']) is list
            and 0 < len(document['receipts']) <= 100, 'COPY_RUNTIME_REVISION_MANIFEST_INVALID')
    initial = document['initial_policy']; prior = policy(initial)
    require(prior['policy_version'] == state['policy_version']
            and prior['policy_body_sha256'] == state.get('policy_body_sha256', prior['policy_body_sha256']),
            'COPY_RUNTIME_REVISION_INITIAL_POLICY_CHANGED')
    receipts = []; event_ids = set()
    for ref in document['receipts']:
        raw = native.read_reference(ref); entry = _parse(raw)
        require(type(entry) is dict and set(entry) == {'event_id', 'idempotency_actor', 'idempotency_operation',
                'idempotency_key', 'response_sha256', 'before', 'after'}
                and _hash(entry['response_sha256']) and _identifier(entry['idempotency_actor'])
                and _identifier(entry['idempotency_key']) and type(entry['event_id']) is str
                and re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', entry['event_id'])
                and entry['event_id'] not in event_ids, 'COPY_RUNTIME_REVISION_RECEIPT_INVALID')
        event_ids.add(entry['event_id'])
        before, after = entry['before'], entry['after']; before_hash, after_hash = policy(before), policy(after)
        require(before_hash == prior, 'COPY_RUNTIME_REVISION_BEFORE_CHANGED')
        query = ("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT json_build_object('event',"
                 "(SELECT row_to_json(e) FROM domain_events e WHERE e.id="+sql_literal(entry['event_id'])+"::uuid),"
                 "'idempotency',(SELECT row_to_json(i) FROM idempotency i WHERE i.workspace_id="+sql_literal(workspace)+
                 " AND i.actor_id="+sql_literal(entry['idempotency_actor'])+" AND i.operation="+
                 sql_literal(entry['idempotency_operation'])+" AND i.key="+sql_literal(entry['idempotency_key'])+")); ROLLBACK;")
        facts = _parse(server.database(root, query).encode()); event, idem = facts.get('event'), facts.get('idempotency')
        require(type(event) is dict and type(idem) is dict and event['workspace_id'] == workspace
                and event['environment'] == 'REAL' and event['event_type'] in REVISION_OPERATIONS
                and entry['idempotency_operation'] == REVISION_OPERATIONS[event['event_type']]
                and idem['status_code'] == 200 and sha256(sealed_bytes(idem['response'])) == entry['response_sha256']
                and type(event.get('actor')) is dict and _identifier(event['actor'].get('id')),
                'COPY_RUNTIME_CANONICAL_AUDIT_REQUIRED')
        actor = event['actor']; actor_namespace = ('personal:'+str(actor.get('credential_id'))
                if actor.get('type') == 'personal_api' else actor['id'])
        require(actor.get('type') in {'human', 'personal_api'} and actor_namespace == entry['idempotency_actor'],
                'COPY_RUNTIME_CANONICAL_ACTOR_CHANGED')
        payload = event['payload']; operation = event['event_type']; expected_body = copy.deepcopy(before['body'])
        revision = payload.get('configuration_version', payload.get('operational_revision'))
        require(type(revision) is int and revision == after['version'] == before['version']+1,
                'COPY_RUNTIME_CANONICAL_VERSION_CHANGED')
        if operation.startswith('integration.'):
            require(operation != 'integration.settings_disabled' or payload.get('changed') is True,
                    'COPY_RUNTIME_NOOP_REVISION_INVALID')
            expected_body.update(dispatch_frozen=True, real_sends_enabled=False, allow_real_operations=False)
        elif operation == 'operational_settings.updated':
            require(payload.get('previous_version') == before['version'] and type(payload.get('changes')) is dict
                    and set(payload['changes']) <= POLICY_KEYS, 'COPY_RUNTIME_CANONICAL_CHANGES_INVALID')
            expected_body.update(payload['changes'])
        else:
            require(payload.get('previous_version') == before['version'], 'COPY_RUNTIME_CANONICAL_CHANGES_INVALID')
            expected_body.update(dispatch_frozen=False, real_sends_enabled=True, allow_real_operations=True)
        require(expected_body == after['body'], 'COPY_RUNTIME_CANONICAL_POLICY_TRANSITION_INVALID')
        receipts.append({'previous_version': before['version'], 'version': after['version'],
            'before_policy_sha256': before_hash['policy_body_sha256'], 'after_policy_sha256': after_hash['policy_body_sha256'],
            'actor_id': actor['id'], 'operation': operation, 'resource_key': event['aggregate_id'], 'receipt_ref': ref})
        prior = after_hash
    require(entry['after'] == current, 'COPY_RUNTIME_CANONICAL_CURRENT_POLICY_CHANGED')
    canonical_revisions(policy(initial), observed, receipts)
    return observed, receipts


def closed_inventory(command, root, state):
    ids = command(['docker', 'ps', '-aq', '--no-trunc'], root).split()
    require(len(ids) in range(5, 12) and all(_hash(cid) for cid in ids) and len(ids) == len(set(ids)),
            'COPY_RUNTIME_INVENTORY_BOUND')
    rows = _parse(command(['docker', 'inspect', *ids], root).encode())
    if state['schema_version'] == 2:
        observed = native.inventory(command, root, state['portal'])
        require({row['Id']: native.projection_digest(row) for row in observed.values()} == state['preserved_runtime'],
                'COPY_RUNTIME_V2_ACTUAL_BASELINE_CHANGED')
        return observed
    return validate_inventory(state, rows)


def network_snapshot(command, root, services):
    names = set().union(*(set(row['NetworkSettings']['Networks']) for row in services.values()))
    require(3 <= len(names) <= 7, 'COPY_RUNTIME_NETWORK_BOUND')
    rows = _parse(command(['docker', 'network', 'inspect', *sorted(names)], root).encode())
    require(type(rows) is list and len(rows) == len(names), 'COPY_RUNTIME_NETWORK_READBACK_INVALID')
    result = {}
    for row in rows:
        require(row.get('Name') in names and row['Name'] not in result,
                'COPY_RUNTIME_NETWORK_READBACK_INVALID')
        expected = {value['Id'] for value in services.values() if row['Name'] in value['NetworkSettings']['Networks']}
        require(set(row.get('Containers', {})) == expected, 'COPY_RUNTIME_NETWORK_FOREIGN_ENDPOINT')
        result[row['Name']] = {key: row[key] for key in ('Name', 'Id', 'Driver', 'Internal', 'EnableIPv6', 'IPAM', 'Options', 'Labels')}
    return result


def topology(command, root, services, networks, release):
    if set(services) == INITIAL:
        return native.topology_guard(command, root, services, networks, release)
    core, proxy, edge = 'commerce-os_core', release['COMMERCE_PROXY_NETWORK'], release['COMMERCE_API_EDGE_NETWORK']
    consumer = release.get('COMMERCE_CONSUMER_EDGE_NETWORK')
    require(type(consumer) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', consumer)
            and len({core, proxy, edge, consumer}) == 4, 'COPY_RUNTIME_CONSUMER_EDGE_REQUIRED')
    gateway_names = {'commerce-os_gateway-'+name[-2:] for name in set(services) & GATEWAYS}
    require(set(networks) == {core, proxy, edge, consumer} | gateway_names,
            'COPY_RUNTIME_CLOSED_NETWORK_SET_REQUIRED')
    expected = {'postgres': {core}, 'web': {proxy}, 'api': {core, proxy, edge}, 'caddy': {proxy, edge},
                'portal': {proxy}, 'ingress': {core, proxy} | gateway_names,
                'automation-worker': {core, consumer}, 'channel-worker': {core} | gateway_names}
    expected.update({name: {'commerce-os_gateway-'+name[-2:]} for name in set(services) & GATEWAYS})
    for name, membership in expected.items():
        require(set(services[name]['NetworkSettings']['Networks']) == membership,
                'COPY_RUNTIME_NETWORK_MEMBERSHIP_CHANGED')
    require(networks[core]['Internal'] is True and networks[proxy]['Internal'] is True
            and all(networks[name]['Internal'] is False for name in {edge, consumer} | gateway_names)
            and all(row['EnableIPv6'] is False and row['Driver'] == 'bridge' for row in networks.values()),
            'COPY_RUNTIME_NETWORK_ISOLATION_CHANGED')
    for name in {'api', 'ingress', 'automation-worker', 'channel-worker'}:
        flags = services[name]['HostConfig'].get('Sysctls', {})
        require(flags.get('net.ipv4.ip_forward') == '0' and flags.get('net.ipv6.conf.all.forwarding') == '0',
                'COPY_RUNTIME_FORWARDING_ENABLED')
    # Reuse native kernel routing proof for API while closing its original edge.
    subset = {name: services[name] for name in INITIAL}
    native.topology_guard(command, root, subset, {name: networks[name] for name in (core, proxy, edge)}, release)
    import ipaddress
    config = networks[consumer]['IPAM']['Config']
    require(len(config) == 1, 'COPY_RUNTIME_CONSUMER_EDGE_IPV4_REQUIRED')
    expected_gateway = format(int.from_bytes(ipaddress.IPv4Address(config[0]['Gateway']).packed, 'little'), '08X')
    raw = command(['docker', 'exec', services['automation-worker']['Id'], 'cat', '/proc/net/route'], root)
    require(len(raw) <= 8192, 'COPY_RUNTIME_CONSUMER_ROUTE_BOUND')
    defaults = [line.split()[2].upper() for line in raw.splitlines()[1:]
                if len(line.split()) >= 8 and line.split()[1] == '00000000' and line.split()[7] == '00000000']
    require(defaults == [expected_gateway], 'COPY_RUNTIME_CONSUMER_DEFAULT_GATEWAY_CHANGED')
    return True


# A fixed, reviewed technical bridge; it never attaches a container while created.
EDGE_NAME = 'commerce-os_consumer-edge'
EDGE_OPTIONS = {'com.docker.network.bridge.enable_ip_masquerade': 'true',
    'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1',
    'com.docker.network.bridge.enable_icc': 'false',
    'com.docker.network.bridge.gateway_mode_ipv4': 'nat'}
EDGE_FIELDS = ('Name', 'Id', 'Driver', 'Scope', 'Internal', 'Attachable', 'EnableIPv6', 'IPAM', 'Options', 'Labels', 'Containers')


def edge_definition(source_sha):
    require(_hash(source_sha, 40), 'COPY_RUNTIME_EDGE_SOURCE_INVALID')
    return {'name': EDGE_NAME, 'driver': 'bridge', 'scope': 'local', 'internal': False,
        'attachable': False, 'enable_ipv6': False, 'subnet': '172.30.80.0/24', 'gateway': '172.30.80.1',
        'options': dict(EDGE_OPTIONS), 'labels': {'com.inovaris.product': 'commerce-os',
            'com.inovaris.purpose': 'copy-consumer-edge', 'com.inovaris.source-sha': source_sha}}


def edge_preflight(command, root):
    """Read-only, canonical digests for a Root approval made after portal adoption.

    Network rows include every endpoint. Routes are the complete IPv4 main table,
    sorted canonically. Container definitions/live state are private hashes only.
    """
    ids = command(['docker', 'network', 'ls', '-q', '--no-trunc'], root).split()
    require(0 < len(ids) <= 64 and len(set(ids)) == len(ids) and all(_hash(cid) for cid in ids),
            'COPY_RUNTIME_EDGE_NETWORK_INVENTORY_INVALID')
    rows = _parse(command(['docker', 'network', 'inspect', *sorted(ids)], root).encode())
    require(type(rows) is list and len(rows) == len(ids) and {row.get('Id') for row in rows} == set(ids),
            'COPY_RUNTIME_EDGE_NETWORK_READBACK_INVALID')
    networks = []
    for row in rows:
        require(all(key in row for key in EDGE_FIELDS), 'COPY_RUNTIME_EDGE_NETWORK_READBACK_INVALID')
        networks.append({key: row[key] for key in EDGE_FIELDS})
    networks.sort(key=lambda row: row['Id'])
    routes = _parse(command(['ip', '-j', '-4', 'route', 'show', 'table', 'main'], root).encode())
    require(type(routes) is list and len(routes) <= 256 and all(type(row) is dict and type(row.get('dst')) is str for row in routes),
            'COPY_RUNTIME_EDGE_ROUTE_READBACK_INVALID')
    routes.sort(key=lambda row: sealed_bytes(row))
    containers = command(['docker', 'ps', '-aq', '--no-trunc'], root).split()
    require(5 <= len(containers) <= 11 and len(set(containers)) == len(containers) and all(_hash(cid) for cid in containers),
            'COPY_RUNTIME_EDGE_CONTAINER_INVENTORY_INVALID')
    inspected = _parse(command(['docker', 'inspect', *sorted(containers)], root).encode())
    require(type(inspected) is list and len(inspected) == len(containers) and {row.get('Id') for row in inspected} == set(containers),
            'COPY_RUNTIME_EDGE_CONTAINER_READBACK_INVALID')
    digests = {row['Id']: sha256(sealed_bytes({'definition': static_projection(row),
        'live': live_projection(row), 'network': row['NetworkSettings']})) for row in inspected}
    hashes = {'networks_sha256': sha256(sealed_bytes(networks)), 'routes_sha256': sha256(sealed_bytes(routes)),
              'containers_sha256': sha256(sealed_bytes(digests))}
    return {'networks': networks, 'routes': routes, 'container_ids': set(containers), 'hashes': hashes}


def edge_no_overlap(definition, observation):
    import ipaddress
    proposed = ipaddress.ip_network(definition['subnet'])
    require(proposed.version == 4 and ipaddress.ip_address(definition['gateway']) in proposed,
            'COPY_RUNTIME_EDGE_IPV4_INVALID')
    require(all(row['Name'] != definition['name'] for row in observation['networks']),
            'COPY_RUNTIME_EDGE_ALREADY_EXISTS_REQUIRES_RECONCILIATION')
    for row in observation['networks']:
        configs = row.get('IPAM', {}).get('Config') or []
        require(type(configs) is list, 'COPY_RUNTIME_EDGE_IPAM_INVALID')
        for item in configs:
            try: network = ipaddress.ip_network(item['Subnet'], strict=False)
            except (KeyError, TypeError, ValueError): raise ReleaseError('COPY_RUNTIME_EDGE_IPAM_INVALID') from None
            require(network.version != 4 or not proposed.overlaps(network), 'COPY_RUNTIME_EDGE_DOCKER_SUBNET_OVERLAP')
    for row in observation['routes']:
        if row['dst'] == 'default': continue
        try: network = ipaddress.ip_network(row['dst'], strict=False)
        except ValueError: raise ReleaseError('COPY_RUNTIME_EDGE_ROUTE_INVALID') from None
        require(network.version != 4 or not proposed.overlaps(network), 'COPY_RUNTIME_EDGE_HOST_ROUTE_OVERLAP')
    return True


def edge_readback(row, definition, allowed_endpoints):
    require(type(row) is dict and _hash(row.get('Id'))
            and row.get('Name') == definition['name'] and row.get('Driver') == definition['driver']
            and row.get('Scope') == definition['scope'] and row.get('Internal') is False
            and row.get('Attachable') is False and row.get('EnableIPv6') is False
            and row.get('Options') == definition['options'] and row.get('Labels') == definition['labels']
            and type(row.get('Containers')) is dict and set(row['Containers']) == set(allowed_endpoints),
            'COPY_RUNTIME_EDGE_DEFINITION_OR_ENDPOINT_CHANGED')
    ipam = row.get('IPAM')
    require(type(ipam) is dict and ipam.get('Driver') == 'default' and ipam.get('Options') in ({}, None)
            and ipam.get('Config') == [{'Subnet': definition['subnet'], 'Gateway': definition['gateway']}],
            'COPY_RUNTIME_EDGE_IPAM_CHANGED')
    return row['Id']


def prepare_edge(server, root, report_dir, before, review, locks):
    require(before['state']['schema_version'] == 2 and len(locks) == len(native.LOCKS),
            'COPY_RUNTIME_EDGE_PREPARATION_SCOPE_INVALID')
    ref = review['consumer_edge_approval_ref']; approval = _parse(native.read_reference(ref))
    require(Path(ref['path']).parent == server.PRIVATE/'controller-approvals'
            and type(approval) is dict and set(approval) == {'schema_version', 'source_sha',
                'before_adoption_sha256', 'before_plan_sha256', 'definition', 'preflight'}
            and type(approval['schema_version']) is int and approval['schema_version'] == 1
            and approval['source_sha'] == review['source_sha']
            and approval['before_adoption_sha256'] == sha256(before['state_raw'])
            and approval['before_plan_sha256'] == sha256(before['plan_raw'])
            and approval['definition'] == edge_definition(review['source_sha'])
            and type(approval['preflight']) is dict
            and set(approval['preflight']) == {'networks_sha256', 'routes_sha256', 'containers_sha256'}
            and all(_hash(value) for value in approval['preflight'].values()), 'COPY_RUNTIME_EDGE_ROOT_APPROVAL_REQUIRED')
    fresh = edge_preflight(server.command, root)
    require(fresh['hashes'] == approval['preflight'] and fresh['container_ids'] == set(before['state']['preserved_runtime']),
            'COPY_RUNTIME_EDGE_PREFLIGHT_CAS_CHANGED')
    edge_no_overlap(approval['definition'], fresh)
    require(native.protected_bytes(server.PRIVATE/'api-web-adoption.json') == before['state_raw']
            and native.protected_bytes(server.PRIVATE/'daily-b02/plan.json') == before['plan_raw'],
            'COPY_RUNTIME_EDGE_SOURCE_CAS_CHANGED')
    journal_path = report_dir/'consumer-edge-transition.json'
    journal = {'schema_version': 1, 'status': 'CREATE_REQUESTED', 'source_sha': review['source_sha'],
               'run_id': report_dir.name, 'approval_ref': ref, 'preflight': fresh['hashes'], 'attachments_requested': 0}
    server._write_report(journal_path, journal)
    definition = approval['definition']
    args = ['docker', 'network', 'create', '--driver', 'bridge', '--subnet', definition['subnet'], '--gateway', definition['gateway']]
    for key, value in sorted(definition['options'].items()): args += ['--opt', key+'='+value]
    for key, value in sorted(definition['labels'].items()): args += ['--label', key+'='+value]
    try:
        cid = server.command(args+[definition['name']], root).strip()
        require(_hash(cid), 'COPY_RUNTIME_EDGE_CREATE_ID_INVALID')
        rows = _parse(server.command(['docker', 'network', 'inspect', cid], root).encode())
        require(type(rows) is list and len(rows) == 1 and edge_readback(rows[0], definition, set()) == cid,
                'COPY_RUNTIME_EDGE_CREATE_READBACK_FAILED')
        journal.update(status='CREATED_EMPTY', network_id=cid)
        server._write_report(journal_path, journal)
        receipt = {'schema_version': 1, 'status': 'CREATED_EMPTY', 'source_sha': review['source_sha'],
            'run_id': report_dir.name, 'approval_ref': ref, 'network_id': cid, 'definition': definition}
        path = report_dir/'consumer-edge.json'; raw = (json.dumps(receipt, sort_keys=True)+'\n').encode()
        fd = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as target: target.write(raw); target.flush(); os.fsync(target.fileno())
        require(native.protected_bytes(path) == raw, 'COPY_RUNTIME_EDGE_RECEIPT_CHANGED')
        return native.reference(path, raw)
    except Exception:
        journal.update(status='RECONCILIATION_REQUIRED', deletion_attempted=False, attachments_requested=0)
        server._write_report(journal_path, journal)
        raise


def verify_edge(server, root, state, services, release):
    receipt = _parse(native.read_reference(state['consumer_edge_ref']))
    require(type(receipt) is dict and set(receipt) == {'schema_version', 'status', 'source_sha', 'run_id',
            'approval_ref', 'network_id', 'definition'} and type(receipt['schema_version']) is int
            and receipt['schema_version'] == 1 and receipt['status'] == 'CREATED_EMPTY'
            and receipt['definition'] == edge_definition(receipt['source_sha'])
            and _hash(receipt['network_id']) and receipt['definition']['name'] == release.get('COMMERCE_CONSUMER_EDGE_NETWORK'),
            'COPY_RUNTIME_EDGE_ADOPTED_RECEIPT_INVALID')
    approval = _parse(native.read_reference(receipt['approval_ref']))
    require(approval.get('source_sha') == receipt['source_sha'] and approval.get('definition') == receipt['definition'],
            'COPY_RUNTIME_EDGE_APPROVAL_CHANGED')
    rows = _parse(server.command(['docker', 'network', 'inspect', receipt['network_id']], root).encode())
    allowed = {services['automation-worker']['Id']} if state['runtime_stage'] == 'OPERATING' else set()
    require(type(rows) is list and len(rows) == 1
            and edge_readback(rows[0], receipt['definition'], allowed) == receipt['network_id'],
            'COPY_RUNTIME_EDGE_ADOPTED_READBACK_CHANGED')
    return state['consumer_edge_ref']


def terminal_journals(private, state, own_report_dir):
    """The sole durable prepared receipt is terminal preparation, never success."""
    current_ref = state.get('last_release_receipt_ref')
    for directory in (Path(private)/'deployments').iterdir():
        if directory == own_report_dir: continue
        require(directory.is_dir() and not directory.is_symlink(), 'COPY_RUNTIME_DEPLOYMENT_JOURNAL_INVALID')
        report = _parse(native.protected_bytes(directory/'report.json'))
        prepared = report.get('status') == 'PREPARED_ACTION_REQUIRED'
        if prepared:
            require(report.get('deployment_scope') == 'copy-runtime' and report.get('consumers_started') is False
                    and report.get('runtime_stage') == 'CORE_PREPARED', 'COPY_RUNTIME_PREPARED_RECEIPT_INVALID')
            journal = _parse(native.protected_bytes(directory/'copy-runtime-transition.json'))
            require(journal.get('status') == 'APPLIED' and journal.get('runtime_stage') == 'CORE_PREPARED'
                    and journal.get('run_id') == report.get('run_id')
                    and journal.get('source_sha') == report.get('source_sha'),
                    'COPY_RUNTIME_PREPARED_PAIR_UNCONFIRMED')
            sealed = _parse(native.read_reference(journal['applied_adoption_ref']))
            validate_state(sealed); native.read_reference(sealed['last_release_receipt_ref'])
            require(sealed['runtime_stage'] == 'CORE_PREPARED'
                    and Path(sealed['last_release_receipt_ref']['path']).parent == directory
                    and (state.get('runtime_stage') == 'OPERATING' or current_ref == sealed['last_release_receipt_ref']),
                    'COPY_RUNTIME_PREPARED_LINEAGE_INVALID')
        else:
            require(report.get('status') in {'SUCCEEDED', 'FAILED'}, 'COPY_RUNTIME_DEPLOYMENT_NONTERMINAL')
            if report.get('status') == 'FAILED' and 'rollback' in report:
                require(report['rollback'].get('status') == 'SUCCEEDED', 'COPY_RUNTIME_PRIOR_ROLLBACK_UNCONFIRMED')
        for task in directory.glob('task-*.json'):
            require(_parse(native.protected_bytes(task)).get('status') in {'SUCCEEDED', 'FAILED'},
                    'COPY_RUNTIME_PRIOR_TASK_UNCONFIRMED')
    updates = Path(private)/'daily-b02/scheduler-updates'
    if updates.exists() or updates.is_symlink():
        require(updates.is_dir() and not updates.is_symlink(), 'COPY_RUNTIME_SCHEDULE_HISTORY_INVALID')
        for entry in updates.iterdir():
            require(entry.is_dir() and not entry.is_symlink(), 'COPY_RUNTIME_SCHEDULE_HISTORY_INVALID')
            path = entry/'journal.json'
            if path.exists() or path.is_symlink():
                require(_parse(native.protected_bytes(path)).get('status') == 'APPLIED',
                        'COPY_RUNTIME_SCHEDULE_CUTOVER_UNCONFIRMED')
    for directory in (Path(private)/'daily-b02/runs').iterdir():
        require(directory.is_dir() and not directory.is_symlink(), 'COPY_RUNTIME_BACKUP_JOURNAL_INVALID')
        require(_parse(native.protected_bytes(directory/'journal.json')).get('status') in native.TERMINAL,
                'COPY_RUNTIME_BACKUP_NONTERMINAL')

    permits = Path(private)/'daily-b02/gcp-authorizations'
    if permits.exists() or permits.is_symlink():
        require(permits.is_dir() and not permits.is_symlink(), 'COPY_RUNTIME_BACKUP_AUTHORIZATION_INVALID')
        for path in permits.iterdir():
            require(re.fullmatch(r'gcp-[a-f0-9]{32}\.json',path.name), 'COPY_RUNTIME_BACKUP_AUTHORIZATION_INVALID')
            raw=native.protected_bytes(path);permit=_parse(raw);run_id=path.stem
            require(permit.get('context',{}).get('run_id')==run_id, 'COPY_RUNTIME_BACKUP_AUTHORIZATION_INVALID')
            report_path=Path(private)/'daily-b02/runs'/run_id/'journal.json'
            if report_path.exists() or report_path.is_symlink():
                require(_parse(native.protected_bytes(report_path)).get('status') in native.TERMINAL,
                    'COPY_RUNTIME_BACKUP_AUTHORIZATION_UNCONFIRMED')
            else:
                resolution=Path(private)/'daily-b02/gcp-authorization-reconciliations'/(run_id+'.json')
                value=_parse(native.protected_bytes(resolution))
                require(value.get('status')=='NO_BACKUP_STARTED' and value.get('run_id')==run_id
                    and value.get('authorization_ref')=={'path':str(path),'bytes':len(raw),'sha256':sha256(raw)}
                    and value.get('execution_uid')==permit['context'].get('execution_uid')
                    and value.get('slot_preserved') is True and value.get('backup_started') is False,
                    'COPY_RUNTIME_BACKUP_AUTHORIZATION_UNCONFIRMED')


def snapshot(server, private, root, own_report_dir):
    private = Path(private); raw = native.protected_bytes(private/'api-web-adoption.json'); state = _parse(raw)
    if state.get('schema_version') == 2: native.validate_state(state, private)
    else:
        validate_state(state)
        receipt = _parse(native.read_reference(state['last_release_receipt_ref']))
        directory = Path(state['last_release_receipt_ref']['path']).parent
        applied = _parse(native.protected_bytes(directory/'copy-runtime-transition.json'))
        completed = _parse(native.protected_bytes(directory/'report.json'))
        require(receipt.get('status') == 'VALIDATED_FOR_PAIR_CAS'
                and receipt.get('runtime_stage') == state['runtime_stage']
                and receipt.get('service_inventory') == state['service_inventory']
                and receipt.get('preserved_runtime') == state['preserved_runtime']
                and applied.get('status') == 'APPLIED'
                and completed.get('status') == ('PREPARED_ACTION_REQUIRED' if state['runtime_stage'] == 'CORE_PREPARED' else 'SUCCEEDED')
                and completed.get('run_id') == receipt.get('run_id')
                and completed.get('source_sha') == receipt.get('source_sha'),
                'COPY_RUNTIME_CURRENT_PAIR_NOT_CONFIRMED')
    require((private.parent/'current').is_symlink()
            and str((private.parent/'current').resolve(strict=True)) == state['current_release'],
            'COPY_RUNTIME_CURRENT_CHANGED')
    for ref in state['canonical_files'].values(): native.read_reference(ref)
    native.read_reference(state['smtp_transition_ref']); native.read_reference(state['caddy_config_ref'])
    native.read_portal_references(state['portal'])
    release = native.env_values(native.protected_bytes(private/'release.env'))
    require(release.get('COMMERCE_DEPLOY_SCOPE') == state['scope']
            and release.get('COMMERCE_SECRETS_DIR') == str(private), 'COPY_RUNTIME_CANONICAL_SCOPE_CHANGED')
    services = closed_inventory(server.command, root, state)
    networks = network_snapshot(server.command, root, services)
    require(networks == state['network_baseline'], 'COPY_RUNTIME_NETWORK_BASELINE_CHANGED')
    topology(server.command, root, services, networks, release)
    if state['schema_version'] == 3: verify_edge(server, root, state, services, release)
    require(native.active_proxy_digest(server.command, root, services) == state['active_proxy_sha256'],
            'COPY_RUNTIME_ACTIVE_PROXY_CHANGED')
    plan_raw = native.protected_bytes(private/'daily-b02/plan.json')
    require(sha256(plan_raw) == state['b02_plan_sha256'], 'COPY_RUNTIME_B02_PLAN_CHANGED')
    if state['schema_version'] == 3: validate_plan(state, plan_raw)
    else:
        require(_parse(plan_raw).get('preserved_runtime') == state['preserved_runtime'],
                'COPY_RUNTIME_B02_BASELINE_CHANGED')
    terminal_journals(private, state, own_report_dir)
    owner = server.owner_auth_snapshot(root); workspace = native.env_values(native.protected_bytes(private/'api.env'))['WORKSPACE_ID']
    require(state.get('owner_workspace_id', workspace) == workspace, 'COPY_RUNTIME_OWNER_WORKSPACE_CHANGED')
    current = current_policy(server, root, workspace)
    observed, receipts = canonical_revision_observation(server, root, state, workspace, current, private)
    verify_gateway_provisioning(server, root, state, services, workspace)
    return {'state': state, 'state_raw': raw, 'plan_raw': plan_raw, 'services': services,
            'files': {name: native.protected_bytes(private/name) for name in FILES},
            'owner': owner, 'workspace': workspace, 'policy': current, 'policy_observed': observed,
            'revision_receipts': receipts, 'release': release}


def reviewed_migrations(private, root, source_sha, metadata):
    names = reviewed_migration_names(metadata)
    path = Path(private)/'copy-runtime-migrations.json'; raw = native.protected_bytes(path); value = _parse(raw)
    require(type(value) is dict and set(value) == {'schema_version', 'source_sha', 'migration_hashes',
            'consumer_edge_network', 'consumer_edge_approval_ref', 'backup_tools_manifest_ref'}
            and type(value['schema_version']) is int and value['schema_version'] == 1
            and value['source_sha'] == source_sha and type(value['migration_hashes']) is dict
            and set(value['migration_hashes']) == names
            and all(_hash(digest) for digest in value['migration_hashes'].values()),
            'COPY_RUNTIME_REVIEWED_MIGRATIONS_REQUIRED')
    require(type(value['consumer_edge_network']) is str
            and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value['consumer_edge_network']),
            'COPY_RUNTIME_REVIEWED_EDGE_REQUIRED')
    for name, digest in value['migration_hashes'].items():
        require(metadata['migration_hashes'][name] == digest
                and sha256((Path(root)/'packages/db/migrations'/name).read_bytes()) == digest,
                'COPY_RUNTIME_REVIEWED_MIGRATION_HASH_CHANGED')
    require(value['consumer_edge_network'] == EDGE_NAME, 'COPY_RUNTIME_REVIEWED_EDGE_NAME_CHANGED')
    native.read_reference(value['consumer_edge_approval_ref'])
    native.read_reference(value['backup_tools_manifest_ref'])
    return value


BOUNDED_MIGRATION_JS = """import{readFile}from'node:fs/promises';
import{pool,withTransaction,hash}from'/app/packages/db/src/index.ts';
const plan=JSON.parse(await readFile('/copy-plan/migrations.json','utf8'));
const profiles=[{stage:'INITIAL',baseline:65,total:67,names:['0066_pending_channel_cancellation.sql','0067_copy_source_isolation.sql']},{stage:'OPERATING',baseline:67,total:68,names:['0068_operational_metric_writer.sql']},{stage:'OPERATING',baseline:68,total:V7_TOTAL,names:V7_NAMES}];
const profile=profiles.find(p=>p.stage===plan.stage&&Object.keys(plan.additions??{}).sort().join()===p.names.join());
if(!profile||Object.keys(plan).sort().join()!=='additions,baseline,stage'||Object.keys(plan.additions).sort().join()!==profile.names.join()||Object.keys(plan.baseline).length!==profile.baseline)throw Error('COPY_MIGRATION_PLAN');
const names=profile.names;
try{await withTransaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(83947101)');
const applied=Object.fromEntries((await c.query('SELECT name,sha256 FROM schema_migrations')).rows.map(r=>[r.name,r.sha256]));
if(Object.keys(applied).length!==profile.baseline||Object.entries(plan.baseline).some(([k,v])=>applied[k]!==v))throw Error('COPY_MIGRATION_HISTORY_CHANGED');
for(const name of names){const sql=await readFile('/copy-sql/'+name,'utf8');if(hash(sql)!==plan.additions[name])throw Error('COPY_SQL_CHANGED');await c.query(sql);await c.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,hash(sql)]);}
const after=Object.fromEntries((await c.query('SELECT name,sha256 FROM schema_migrations')).rows.map(r=>[r.name,r.sha256]));
if(Object.keys(after).length!==profile.total||Object.entries({...plan.baseline,...plan.additions}).some(([k,v])=>after[k]!==v))throw Error('COPY_MIGRATION_READBACK');});}finally{await pool.end();}""".replace(
    'V7_NAMES', json.dumps(sorted(V7_PROFILE_MIGRATION_NAMES), separators=(',', ':'))).replace('V7_TOTAL', str(V7_PROFILE_MIGRATION_TOTAL))


def apply_reviewed_migrations(server, root, report_dir, metadata, review, timeout=300, *, stage='INITIAL'):
    require(type(timeout) is int and 0 < timeout <= 300, 'COPY_RUNTIME_MIGRATION_DEADLINE_INVALID')
    applied = server.migrations(root); expected = metadata['migration_hashes']
    migration_stage_guard(applied, metadata, initial=stage == 'INITIAL', stage=stage)
    names = reviewed_migration_names(metadata)
    require(review.get('migration_hashes') == {name: expected[name] for name in names},
            'COPY_RUNTIME_REVIEWED_MIGRATION_HASH_CHANGED')
    if applied == expected: return {'status': 'ALREADY_APPLIED', 'migration_count': len(expected)}
    plan = Path(report_dir)/'migrations.json'
    server._write_report(plan, {'stage': stage, 'baseline': applied, 'additions': review['migration_hashes']})
    env = native.env_values(native.protected_bytes(server.PRIVATE/'release.env'))
    args = ['docker', 'run', '--rm', '--user', '0:0', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
            '--tmpfs', '/tmp:size=64m,noexec,nosuid', '--network', 'commerce-os_core',
            '--env-file', str(server.PRIVATE/'admin.env'), '-v', str(plan)+':/copy-plan/migrations.json:ro',
            *[part for name in sorted(names) for part in ('-v', str(Path(root)/'packages/db/migrations'/name)+':/copy-sql/'+name+':ro')],
            env['COMMERCE_IMAGE'],
            'node', '--import', 'tsx', '--input-type=module', '-e', BOUNDED_MIGRATION_JS]
    require(type(timeout) is int and 0 < timeout <= 300, 'COPY_RUNTIME_MIGRATION_DEADLINE_INVALID')
    server.run_deployment_task(root, report_dir, args, 'copy-migrations', timeout)
    verify_migrations(server.migrations(root), expected, complete=True)
    return {'status': 'APPLIED_BOUNDED', 'migration_count': len(expected), 'bootstrap_or_import': False}


def first_start_guard(server, root):
    """Cold-copy barriers only. Routine REAL publications use a transient hold."""
    value = _parse(server.database(root, native.BARRIERS_SQL).encode())
    require(value.get('database') == 'commerce' and value.get('migration_count') == 67,
            'COPY_RUNTIME_FIRST_START_DATABASE_INVALID')
    for name in set(native.BARRIERS)-{'login_sessions', 'personal_tokens_live'}:
        require(type(value.get(name)) is int and value[name] == 0, 'COPY_RUNTIME_FIRST_START_'+name.upper())
    require(type(value.get('login_sessions')) is int and 0 <= value['login_sessions'] <= native.MAX_OWNER_SESSIONS
            and type(value.get('personal_tokens_live')) is int and value['personal_tokens_live'] == 1, 'COPY_RUNTIME_FIRST_START_OWNER_INVALID')
    extra = _parse(server.database(root, "SELECT json_build_object('channel_commands_pending',(SELECT count(*) FROM commands WHERE environment='REAL' AND kind='channel_command' AND status='PENDING'),'channel_profiles_enabled',(SELECT count(*) FROM integration_settings WHERE environment='REAL' AND type IN('waha','cloud','meta') AND enabled));").encode())
    require(type(extra.get('channel_commands_pending')) is int and extra['channel_commands_pending'] == 0, 'COPY_RUNTIME_CANONICAL_CHANNEL_CANCELLATION_REQUIRED')
    require(type(extra.get('channel_profiles_enabled')) is int and extra['channel_profiles_enabled'] == 0, 'COPY_RUNTIME_CANONICAL_CHANNEL_QUARANTINE_REQUIRED')
    frozen = server.database(root, "SELECT count(*)>0 AND bool_and(body @> '{\"dispatch_frozen\":true,\"real_sends_enabled\":false,\"allow_real_operations\":false}'::jsonb) FROM operational_settings WHERE environment='REAL';")
    require(frozen == 't', 'COPY_RUNTIME_FIRST_START_REAL_POLICY_OPEN')
    return {'real_dispatch_frozen': True, 'real_channels_quarantined': True, 'pending_channel_commands': 0}


def profiles(before, private, *, initial=False):
    after = {name: native.protected_bytes(Path(private)/name) for name in FILES}
    for name in FILES-{'api.env', 'release.env'}:
        require(after[name] == before[name], 'COPY_RUNTIME_PRIVATE_PROFILE_CHANGED')
    old, new = native.env_values(before['api.env']), native.env_values(after['api.env'])
    allowed = {'COMMERCE_DEPLOYMENT_STATUS', 'COMMERCE_EXTERNAL_MONITOR_STATUS'}
    require({key: value for key, value in old.items() if key not in allowed}
            == {key: value for key, value in new.items() if key not in allowed},
            'COPY_RUNTIME_API_SECRET_OR_PROFILE_CHANGED')
    old, new = native.env_values(before['release.env']), native.env_values(after['release.env'])
    allowed = {'COMMERCE_IMAGE', 'COMMERCE_WEB_IMAGE', 'COMMERCE_MAINTENANCE_IMAGE',
               'COMMERCE_RELEASE_SHA', 'COMMERCE_RELEASE_ID'}
    if initial: allowed |= {'COMMERCE_DEPLOY_SCOPE', 'COMMERCE_CONSUMER_EDGE_NETWORK'}
    require({key: value for key, value in old.items() if key not in allowed}
            == {key: value for key, value in new.items() if key not in allowed},
            'COPY_RUNTIME_RELEASE_BOUNDARY_CHANGED')
    return after


def commercial_snapshot(server, root):
    # Private stable configuration and reservations. No row bodies are reported.
    tables = ('manual_controls', 'integration_settings', 'commercial_assignments', 'operation_authorizations',
              'creative_budgets', 'creative_global_budgets', 'intelligence_searches')
    query = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT json_build_object('+','.join(
        "'"+name+"',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM "+name+' t)'
        for name in tables)+'); ROLLBACK;'
    real_quotas = {
        'warmup_rate_buckets': "JOIN records a ON a.id=t.account_id AND a.kind='channel_account' WHERE a.environment='REAL'",
        'warmup_rate_reservations': "JOIN outbox e ON e.id=t.effect_id WHERE e.environment='REAL'",
        'warmup_account_reservations': "JOIN records a ON a.id=t.account_id AND a.kind='channel_account' WHERE a.environment='REAL'"}
    query = query.replace('); ROLLBACK;', ','+','.join(
        "'"+name+"',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM "+name+' t '+join+')'
        for name, join in real_quotas.items())+'); ROLLBACK;')
    raw = server.database(root, query).encode()
    require(len(raw) <= MAX_BYTES, 'COPY_RUNTIME_COMMERCIAL_CONFIGURATION_BOUND')
    return sha256(raw)


def atomic_bytes(path, raw):
    """Write the native helper's exact bytes, preserving its sealed references."""
    import tempfile
    require(type(raw) is bytes and 0 < len(raw) <= MAX_BYTES, 'COPY_RUNTIME_ATOMIC_BYTES_INVALID')
    path = Path(path); previous = native.protected_bytes(path)
    descriptor, name = tempfile.mkstemp(prefix='.copy-runtime-', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as target:
            os.fchmod(target.fileno(), 0o600); target.write(raw); target.flush(); os.fsync(target.fileno())
        require(native.protected_bytes(path) == previous, 'COPY_RUNTIME_ATOMIC_TARGET_CHANGED')
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
        require(native.protected_bytes(path) == raw, 'COPY_RUNTIME_ATOMIC_READBACK_FAILED')
    finally:
        temporary.unlink(missing_ok=True)


@contextlib.contextmanager
def reviewed_backup_module(manifest_ref, root, source_sha):
    """Authenticate tool bytes before importing, and avoid stale module cache."""
    manifest = _parse(native.read_reference(manifest_ref))
    names = {'b02-backup-root.py', 'b02_backup_contract.py', 'b02-portal-capsule.mjs'}
    require(type(manifest) is dict and manifest.get('source_sha') == source_sha
            and type(manifest.get('tools')) is dict and set(manifest['tools']) == names,
            'COPY_RUNTIME_REVIEWED_BACKUP_TOOLS_REQUIRED')
    for name, ref in manifest['tools'].items():
        raw = native.read_reference(ref)
        require(ref['path'] == str(Path(root)/'scripts'/name)
                and (Path(root)/'scripts'/name).read_bytes() == raw,
                'COPY_RUNTIME_REVIEWED_BACKUP_TOOL_CHANGED')
    previous = sys.modules.get('b02_backup_contract')
    contract_spec = importlib.util.spec_from_file_location('b02_backup_contract', Path(root)/'scripts/b02_backup_contract.py')
    contract_module = importlib.util.module_from_spec(contract_spec)
    try:
        sys.modules['b02_backup_contract'] = contract_module; contract_spec.loader.exec_module(contract_module)
        root_spec = importlib.util.spec_from_file_location('copy_runtime_reviewed_b02', Path(root)/'scripts/b02-backup-root.py')
        root_module = importlib.util.module_from_spec(root_spec); root_spec.loader.exec_module(root_module)
        yield root_module
    finally:
        if previous is None: sys.modules.pop('b02_backup_contract', None)
        else: sys.modules['b02_backup_contract'] = previous


def in_flight_guard(server, root):
    query = "SELECT json_build_object('sends',(SELECT count(*) FROM outbox WHERE environment='REAL' AND status='SENDING'),'provider',(SELECT count(*) FROM creative_provider_operations WHERE status IN('RESERVED','RUNNING')),'voice',(SELECT count(*) FROM creative_voice_operations WHERE status IN('QUOTED','REQUESTED','RUNNING','PAID_PENDING_STORAGE')),'number',(SELECT count(*) FROM number_operations WHERE environment='REAL' AND state='PREPARING' AND lease_until>now()),'profile',(SELECT count(*) FROM warmup_identities WHERE environment='REAL' AND profile_operation_status='APPLYING'),'lifecycle',(SELECT count(*) FROM commands WHERE environment='REAL' AND kind='channel_command' AND status='PENDING' AND result ? 'processing_owner'));"
    value = _parse(server.database(root, query).encode())
    require(type(value) is dict and set(value) == {'sends', 'provider', 'voice', 'number', 'profile', 'lifecycle'}
            and all(type(count) is int and count == 0 for count in value.values()),
            'COPY_RUNTIME_IN_FLIGHT_OPERATIONS_REQUIRE_RECONCILIATION')


def verify_gateway_provisioning(server, root, state, services, workspace):
    """Authenticate existing adopted gateways; never auto-adopt an extra container.

    Canonical capacity operations attest provisioning, not connection or identity.
    A stopped gateway remains in the inventory and preserves its volumes/overlay.
    """
    for name, receipt in state.get('gateway_provisioning', {}).items():
        overlay_raw = native.read_reference(receipt['overlay_ref'])
        require(receipt['definition_sha256'] == definition_digest(services[name]),
                'COPY_RUNTIME_GATEWAY_DEFINITION_CHANGED')
        operation = sql_literal(receipt['operation_id']); slot = str(receipt['slot'])
        query = ("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT json_build_object('operation',"
            "(SELECT row_to_json(o) FROM number_operations o WHERE o.id="+operation+"::uuid),"
            "'slots',(SELECT COALESCE(json_agg(s),'[]'::json) FROM number_capacity_slots s WHERE s.operation_id="+operation+
            "::uuid AND s.slot="+slot+"), 'audit',(SELECT COALESCE(json_agg(e),'[]'::json) FROM domain_events e WHERE e.workspace_id="+
            sql_literal(workspace)+" AND e.environment='REAL' AND e.aggregate_id="+operation+
            " AND e.event_type='capacity.admin_readback' AND e.payload->>'outcome'='VERIFIED')); ROLLBACK;")
        facts = _parse(server.database(root, query).encode()); op = facts.get('operation'); slots = facts.get('slots')
        require(type(op) is dict and op.get('id') == receipt['operation_id'] and op.get('workspace_id') == workspace
                and op.get('environment') == 'REAL' and op.get('action') in {'PROVISION', 'EXPAND'}
                and (op.get('action') != 'EXPAND' or (type(op.get('input')) is dict and op['input'].get('apply') is True))
                and op.get('state') == 'SUCCEEDED' and type(op.get('result')) is dict
                and op['result'].get('outcome') == 'VERIFIED' and type(op['result'].get('sessions_started')) is int
                and op['result']['sessions_started'] == 0
                and op['result'].get('overlay_sha') == sha256(overlay_raw)
                and type(facts.get('audit')) is list and len(facts['audit']) > 0
                and all(type(event.get('actor')) is dict and event['actor'].get('type') in {'human', 'personal_api', 'service'}
                    and _identifier(event['actor'].get('id')) for event in facts['audit'])
                and type(slots) is list and len(slots) == 1, 'COPY_RUNTIME_CANONICAL_GATEWAY_PROVISION_REQUIRED')
        canonical = slots[0]; readback = canonical.get('readback')
        require(canonical.get('workspace_id') == workspace and canonical.get('environment') == 'REAL'
                and canonical.get('host_ref') == 'primary' and type(canonical.get('slot')) is int
                and canonical['slot'] == receipt['slot'] and canonical.get('gateway_ref') == name
                and canonical.get('operation_id') == receipt['operation_id'] and type(readback) is dict
                and readback.get('source') == 'bounded_administrator' and readback.get('verified') is True
                and (readback.get('overlay_sha') is None or readback['overlay_sha'] == sha256(overlay_raw))
                and readback.get('image_digest') == services[name]['Image']
                and readback.get('network_present') is True and readback.get('volumes_preserved') is True,
                'COPY_RUNTIME_CANONICAL_GATEWAY_BINDING_CHANGED')
        mounts = {item.get('Destination'): item.get('Name') for item in services[name]['Mounts']}
        require(mounts.get('/app/.sessions') == 'commerce-os_'+name+'-sessions'
                and mounts.get('/app/.media') == 'commerce-os_'+name+'-media',
                'COPY_RUNTIME_GATEWAY_STORAGE_CHANGED')
    return True


def state_for_stage(before, services, root, report_ref, stage, observed_policy, private, networks):
    state = copy.deepcopy(before['state'])
    state.update(schema_version=3, scope='copy-runtime', runtime_stage=stage,
        status='PREPARED_ACTION_REQUIRED' if stage == 'CORE_PREPARED' else 'ADOPTED_COPY_RUNTIME',
        runtime_projection_version=2, current_release=str(root),
        canonical_files={name: native.reference(Path(private)/name, native.protected_bytes(Path(private)/name)) for name in FILES},
        service_inventory={name: row['Id'] for name, row in services.items()},
        preserved_runtime={row['Id']: definition_digest(row) for row in services.values()},
        owner_workspace_id=before['workspace'], policy_version=observed_policy['policy_version'],
        policy_body_sha256=observed_policy['policy_body_sha256'], last_release_receipt_ref=report_ref,
        gateway_provisioning=copy.deepcopy(before.get('gateway_provisioning', before['state'].get('gateway_provisioning', {}))),
        consumer_edge_ref=before.get('consumer_edge_ref', before['state'].get('consumer_edge_ref')),
        network_baseline=networks)
    # Filled with exact returned native B02 bytes by the protected helper.
    state['b02_plan_ref'] = native.reference(Path(private)/'daily-b02/plan.json', before['plan_raw'])
    return state


def stage_continuity(before, services, candidate, after_owner, server, private):
    previous = before['state']; initial = previous['schema_version'] == 2
    profiles(before['files'], private, initial=initial)
    compare_owner(before['owner'], after_owner, before['workspace'], server.compare_owner_auth)
    preserved = {'postgres', 'caddy', 'portal'} | (set(before['services']) & GATEWAYS)
    compare_live_snapshot({name: before['services'][name] for name in preserved},
                          {name: services[name] for name in preserved})
    for name in set(before['services'])-preserved:
        old, new = static_projection(before['services'][name]), static_projection(services[name])
        require(old['HostConfig'] == new['HostConfig'] and old['Mounts'] == new['Mounts']
                and old['NetworkSettings'] == new['NetworkSettings'], 'COPY_RUNTIME_APPLICATION_BOUNDARY_CHANGED')
        if previous.get('runtime_stage') == 'CORE_PREPARED' and candidate['runtime_stage'] == 'OPERATING':
            compare_live_snapshot({name: before['services'][name]}, {name: services[name]})
    require(previous['portal'] == candidate['portal'] and previous['smtp_transition_ref'] == candidate['smtp_transition_ref']
            and previous['caddy_config_ref'] == candidate['caddy_config_ref']
            and previous['active_proxy_sha256'] == candidate['active_proxy_sha256'],
            'COPY_RUNTIME_PRESERVED_BOUNDARY_CHANGED')


def commit_stage(server, root, report_dir, before, services, report, stage, review, locks, deadline=None, gateway_extension=False, before_terminal=None):
    """Native B02 tool installation then one journal-bound pair CAS, no SQL rollback."""
    if deadline is not None: deadline_check(deadline)
    if stage == 'OPERATING': provider_evidence.installed_components(report, services)
    metadata = native.env_values(native.protected_bytes(server.PRIVATE/'release.env'))
    network_rows = network_snapshot(server.command, root, services)
    topology(server.command, root, services, network_rows, metadata)
    require(native.active_proxy_digest(server.command, root, services) == before['state']['active_proxy_sha256'],
            'COPY_RUNTIME_PROXY_CHANGED_BY_RELEASE')
    native.read_portal_references(before['state']['portal'])
    require(current_policy(server, root, before['workspace']) == before['policy'],
            'COPY_RUNTIME_POLICY_CHANGED_BY_PUBLICATION')
    completed = dict(report, status='PREPARED_ACTION_REQUIRED' if stage == 'CORE_PREPARED' else 'SUCCEEDED',
        runtime_stage=stage, consumers_started=stage == 'OPERATING', full_runtime_started=stage == 'OPERATING',
        physical_sales_proven=False, release=Path(root).name, stage='complete' if stage == 'OPERATING' else 'prepared-core',
        finished_at=dt.datetime.now(dt.timezone.utc).isoformat())
    receipt = {'schema_version': 1, 'source_sha': report['source_sha'], 'run_id': report['run_id'],
        'status': 'VALIDATED_FOR_PAIR_CAS', 'runtime_stage': stage, 'physical_sales_proven': False,
        'service_inventory': {name: row['Id'] for name, row in services.items()},
        'preserved_runtime': {row['Id']: definition_digest(row) for row in services.values()}}
    receipt_raw = (json.dumps(receipt, sort_keys=True)+'\n').encode()
    receipt_path = report_dir/'adoption-receipt.json'
    fd = os.open(receipt_path, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as target:
        target.write(receipt_raw); target.flush(); os.fsync(target.fileno())
    require(native.protected_bytes(receipt_path) == receipt_raw, 'COPY_RUNTIME_ADOPTION_RECEIPT_CHANGED')
    candidate = state_for_stage(before, services, root, native.reference(receipt_path, receipt_raw),
                                stage, before['policy_observed'], server.PRIVATE, network_rows)
    verify_edge(server, root, candidate, services, metadata)
    verify_gateway_provisioning(server, root, candidate, services, before['workspace'])
    if gateway_extension:
        gateway_continuity(before, services, candidate, server.owner_auth_snapshot(root), server, server.PRIVATE)
    else:
        stage_continuity(before, services, candidate, server.owner_auth_snapshot(root), server, server.PRIVATE)
    gateway_boot = None
    if gateway_extension:
        import runtime_boot_install
        gateway_boot = runtime_boot_install.gateway_admission(server, root, report_dir, before, services, report, locks, deadline)
    with reviewed_backup_module(review['backup_tools_manifest_ref'], root, report['source_sha']) as backup:
        if deadline is not None: deadline_check(deadline)
        if gateway_boot is not None: gateway_boot.fence()
        prepared = backup.prepare_reviewed_controllers(review['backup_tools_manifest_ref'], root,
            report['source_sha'], sha256(before['plan_raw']), sha256(before['state_raw']), candidate,
            {row['Id']: row for row in services.values()}, held_locks=dict(zip(native.LOCKS, locks)))
        candidate, plan_raw = prepared['adoption'], prepared['plan_bytes']
        require(candidate['runtime_stage'] == stage and candidate['last_release_receipt_ref']
                == native.reference(receipt_path, receipt_raw), 'COPY_RUNTIME_B02_ADOPTION_SCOPE_CHANGED')
        if deadline is not None: deadline_check(deadline)
        validate_state(candidate); validate_inventory(candidate, list(services.values())); validate_plan(candidate, plan_raw)
        journal_path = report_dir/'copy-runtime-transition.json'
        journal = {'schema_version': 1, 'source_sha': report['source_sha'], 'run_id': report['run_id'],
            'status': 'PREWRITE', 'expected_state_sha256': sha256(before['state_raw']),
            'expected_plan_sha256': sha256(before['plan_raw']), 'candidate_state_sha256': sha256(sealed_bytes(candidate)),
            'candidate_plan_sha256': sha256(plan_raw), 'runtime_stage': stage, 'database_rollback': False}
        journal['candidate_state_sha256'] = sha256(prepared['adoption_bytes'])
        server._write_report(journal_path, journal)
        if gateway_boot is not None: gateway_boot.fence()
        # Tool-source changes are independently authorized/validated by the native
        # B02 helper. This second CAS protects the two unchanged old files ourselves.
        require(native.protected_bytes(server.PRIVATE/'api-web-adoption.json') == before['state_raw']
                and native.protected_bytes(server.PRIVATE/'daily-b02/plan.json') == before['plan_raw'],
                'COPY_RUNTIME_PAIR_CAS_CHANGED')
        history = server.PRIVATE/'daily-b02/plan-history'; history.mkdir(mode=0o700, exist_ok=True)
        old = history/(sha256(before['plan_raw'])+'.json')
        if not old.exists():
            fd = os.open(old, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as target:
                target.write(before['plan_raw']); target.flush(); os.fsync(target.fileno())
        require(native.protected_bytes(old) == before['plan_raw'], 'COPY_RUNTIME_PLAN_HISTORY_CHANGED')
        if deadline is not None: deadline_check(deadline)
        atomic_bytes(server.PRIVATE/'daily-b02/plan.json', prepared['plan_bytes'])
        actual_plan = native.protected_bytes(server.PRIVATE/'daily-b02/plan.json')
        require(actual_plan == prepared['plan_bytes'], 'COPY_RUNTIME_PLAN_READBACK_FAILED')
        atomic_bytes(server.PRIVATE/'api-web-adoption.json', prepared['adoption_bytes'])
        actual_state = native.protected_bytes(server.PRIVATE/'api-web-adoption.json')
        require(_parse(actual_state) == candidate, 'COPY_RUNTIME_STATE_READBACK_FAILED')
        validate_plan(candidate, actual_plan)
        backup.mark_pair_applied(prepared['history_path'], sha256(actual_plan), sha256(actual_state),
                                 dict(zip(native.LOCKS, locks)))
        archive = report_dir/'adoption-applied.json'
        fd = os.open(archive, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as target:
            target.write(actual_state); target.flush(); os.fsync(target.fileno())
        require(native.protected_bytes(archive) == actual_state, 'COPY_RUNTIME_ADOPTION_ARCHIVE_CHANGED')
        journal.update(status='APPLIED', actual_state_sha256=sha256(actual_state), actual_plan_sha256=sha256(actual_plan),
                       applied_adoption_ref=native.reference(archive, actual_state))
        server._write_report(journal_path, journal)
        # Only a confirmed pair/native mark can publish a terminal report. A
        # SIGKILL before this point leaves RUNNING, never an early SUCCEEDED.
        if deadline is not None: deadline_check(deadline)
        if stage == 'OPERATING':
            # Same native FULL/package admission, source bundle and held locks.
            # Installation errors leave the applied pair without SUCCEEDED.
            # The hook never starts containers or sessions during installation.
            import runtime_boot_install
            completed['host_boot'] = (gateway_boot.apply(actual_state, actual_plan, backup) if gateway_extension else
                runtime_boot_install.install(server, root, report_dir, before, report, actual_state, actual_plan, backup, locks, deadline))
        if before_terminal is not None: before_terminal()
        server._write_report(report_dir/'report.json', completed)
        report.update(completed)
        return candidate


def ownership_projection(server, root, workspace):
    query = ("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT json_build_object('held',"
        "(SELECT count(*)=1 AND bool_and(release_hold) FROM operational_settings WHERE workspace_id="+sql_literal(workspace)+
        " AND environment='REAL'),'hold_at',(SELECT release_hold_at FROM operational_settings WHERE workspace_id="+sql_literal(workspace)+
        " AND environment='REAL'),'ownerships',(SELECT COALESCE(json_agg(o ORDER BY o.account_id),'[]'::json) FROM "
        "(SELECT o.account_id,o.workspace_id,o.owner_id,o.generation,o.frozen,o.release_frozen,o.isolation_evidence FROM session_ownership o JOIN records a ON a.id::text=o.account_id AND a.workspace_id=o.workspace_id AND a.kind='channel_account' AND a.environment='REAL' WHERE o.workspace_id="+
        sql_literal(workspace)+") o),'proofs',(SELECT COALESCE(json_agg(p ORDER BY p.id),'[]'::json) FROM "
        "(SELECT p.id,p.account_id,p.workspace_id,p.previous_owner_id,p.generation,p.method,p.evidence_sha256,p.verified_at,p.consumed_at FROM ownership_isolation_receipts p JOIN records a ON a.id=p.account_id AND a.workspace_id=p.workspace_id AND a.kind='channel_account' AND a.environment='REAL' WHERE p.workspace_id="+
        sql_literal(workspace)+") p),'challenges',(SELECT COALESCE(json_agg(c ORDER BY c.id),'[]'::json) FROM copy_source_isolation_challenges c WHERE c.workspace_id="+sql_literal(workspace)+")); ROLLBACK;")
    facts = _parse(server.database(root, query).encode())
    require(type(facts) is dict and set(facts) == {'held', 'hold_at', 'ownerships', 'proofs', 'challenges'}
            and facts['held'] is True and type(facts['hold_at']) is str
            and type(facts['ownerships']) is list and all(row.get('frozen') is True for row in facts['ownerships'])
            and type(facts['proofs']) is list and type(facts['challenges']) is list, 'COPY_RUNTIME_GATEWAY_CANONICAL_HOLD_AND_FREEZE_REQUIRED')
    return facts


def gateway_continuity(before, services, candidate, after_owner, server, private):
    """Only the canonical added gateway edges may change worker definitions."""
    compare_owner(before['owner'], after_owner, before['workspace'], server.compare_owner_auth)
    previous = before['state']; added = (set(services) & GATEWAYS)-(set(before['services']) & GATEWAYS)
    require(0 < len(added) <= 3 and set(services) == set(before['services']) | added,
            'COPY_RUNTIME_GATEWAY_EXTENSION_SET_INVALID')
    new_networks = {'commerce-os_gateway-'+name[-2:] for name in added}
    for name, old in before['services'].items():
        actual = copy.deepcopy(services[name])
        require(actual['Id'] == old['Id'], 'COPY_RUNTIME_GATEWAY_EXISTING_CONTAINER_REPLACED')
        if name in {'ingress', 'channel-worker'}:
            original = set(old['NetworkSettings']['Networks'])
            require(set(actual['NetworkSettings']['Networks']) == original | new_networks,
                    'COPY_RUNTIME_GATEWAY_WORKER_WIRING_CHANGED')
            for network in new_networks: actual['NetworkSettings']['Networks'].pop(network)
        compare_live_snapshot({name: old}, {name: actual})
    for name in FILES-{'release.env'}:
        require(native.protected_bytes(Path(private)/name) == before['files'][name],
                'COPY_RUNTIME_GATEWAY_PRIVATE_PROFILE_CHANGED')
    old_env, new_env = native.env_values(before['files']['release.env']), native.env_values(native.protected_bytes(Path(private)/'release.env'))
    require({key: value for key, value in old_env.items() if key != 'COMMERCE_PILOT_RELEASE_ENV'}
            == {key: value for key, value in new_env.items() if key != 'COMMERCE_PILOT_RELEASE_ENV'},
            'COPY_RUNTIME_GATEWAY_RELEASE_BOUNDARY_CHANGED')
    require(previous['portal'] == candidate['portal'] and previous['consumer_edge_ref'] == candidate['consumer_edge_ref']
            and previous['smtp_transition_ref'] == candidate['smtp_transition_ref']
            and previous['active_proxy_sha256'] == candidate['active_proxy_sha256']
            and previous['caddy_config_ref'] == candidate['caddy_config_ref'],
            'COPY_RUNTIME_GATEWAY_PRESERVED_BOUNDARY_CHANGED')
    return added


def gateway_rendered_bindings(server, root, services, release):
    rendered = _parse(server.command(['sh', 'scripts/compose-release.sh', str(server.PRIVATE/'release.env'),
                                     'config', '--format', 'json'], root).encode())
    require(type(rendered) is dict and type(rendered.get('services')) is dict,
            'COPY_RUNTIME_GATEWAY_COMPOSE_READBACK_INVALID')
    wanted = rendered['services']
    for name in set(services) & GATEWAYS:
        require(name in wanted and type(wanted[name]) is dict, 'COPY_RUNTIME_GATEWAY_CANONICAL_OVERLAY_REQUIRED')
        definition = wanted[name]; image = definition.get('image')
        require(type(image) is str and re.search(r'@sha256:[a-f0-9]{64}$', image),
                'COPY_RUNTIME_GATEWAY_PINNED_IMAGE_REQUIRED')
        rows = _parse(server.command(['docker', 'image', 'inspect', image], root).encode())
        require(type(rows) is list and len(rows) == 1 and rows[0].get('Id') == services[name]['Image'],
                'COPY_RUNTIME_GATEWAY_CANONICAL_IMAGE_CHANGED')
        actual_env = native.env_values(('\n'.join(services[name]['Config']['Env'])+'\n').encode())
        desired_env = native.env_values(('\n'.join(rows[0].get('Config', {}).get('Env') or [])+'\n').encode())
        configured = definition.get('environment')
        require(type(configured) is dict and all(type(key) is str and type(value) in (str, int, float, bool) for key, value in configured.items()),
                'COPY_RUNTIME_GATEWAY_CANONICAL_ENV_INVALID')
        desired_env.update({key: str(value).lower() if type(value) is bool else str(value) for key, value in configured.items()})
        require(actual_env == desired_env, 'COPY_RUNTIME_GATEWAY_CANONICAL_CREDENTIAL_OR_ENV_CHANGED')
        host = services[name]['HostConfig']
        require(host.get('CapDrop') == ['ALL'] and host.get('Init') is True
                and host.get('PidsLimit') == 100 and host.get('Memory') == 768*1024**2
                and host.get('NanoCpus') == 300000000 and 'no-new-privileges:true' in (host.get('SecurityOpt') or []),
                'COPY_RUNTIME_GATEWAY_CANONICAL_LIMITS_CHANGED')
    return True


def prior_backup_guard(ref, before, backup_tools):
    raw = native.read_reference(ref); value = _parse(raw); path = Path(ref['path'])
    require(path.name == 'journal.json' and path.parent.parent == PRIVATE/'daily-b02/runs'
            and backup_tools.backup_run_identity(path.parent.name) == path.parent.name
            and value.get('kind') == 'DAILY_B02' and value.get('run_id') == path.parent.name
            and value.get('status') == 'SUCCEEDED' and value.get('external_copy_verified') is True
            and value.get('plan_sha256') == sha256(before['plan_raw'])
            and value.get('backup_source_sha') == before['state']['backup_source_sha']
            and value.get('source_sha') == before['source_sha']
            and value.get('cleanup', {}).get('runtime_preserved') is True
            and value.get('cleanup', {}).get('owned_plaintext_removed') is True
            and type(value.get('exports')) is dict
            and set(value['exports']) == {'ciphertext.backup.aes', 'portal.backup.aes', 'source.json', 'backup.json'},
            'COPY_RUNTIME_GATEWAY_PRIOR_BACKUP_REQUIRED')
    try: finished = dt.datetime.fromisoformat(value['finished_at'].replace('Z', '+00:00'))
    except (KeyError, ValueError, TypeError): raise ReleaseError('COPY_RUNTIME_GATEWAY_BACKUP_TIME_INVALID') from None
    require(finished.tzinfo is not None and finished.utcoffset() == dt.timedelta(0) and dt.timedelta(0) <= dt.datetime.now(dt.timezone.utc)-finished <= dt.timedelta(hours=1),
            'COPY_RUNTIME_GATEWAY_PRIOR_BACKUP_STALE')
    backup_tools.verify_trigger_journal(value)
    source = _parse(native.read_reference(value['exports']['source.json']))
    backup = _parse(native.read_reference(value['exports']['backup.json']))
    require(source.get('status') == 'B02_SOURCE_VERIFIED' and source.get('plan_sha256') == value['plan_sha256']
            and backup.get('status') == 'B02_LOCAL_CIPHERTEXT_VERIFIED'
            and backup.get('plan_sha256') == value['plan_sha256'] and backup.get('encrypted') is True
            and backup.get('format') == 2 and backup.get('snapshot_consistent') is True
            and backup.get('keys_exported') is False, 'COPY_RUNTIME_GATEWAY_PRIOR_BACKUP_RECEIPT_CHANGED')
    # Reuse the approved B02 reader: streaming hash, Root custody and identity
    # readback. Limits remain exactly the native aggregate/capsule contract.
    exports=value['exports']
    require(all(type(artifact) is dict and set(artifact) == {'path','bytes','sha256'}
                and type(artifact['bytes']) is int and artifact['bytes'] > 0 for artifact in exports.values())
            and sum(artifact['bytes'] for artifact in exports.values()) <= backup_tools.MAX_BYTES,
            'COPY_RUNTIME_GATEWAY_PRIOR_BACKUP_TOTAL_BOUND')
    for name, header, limit in (('ciphertext.backup.aes', b'COMOSB02', backup_tools.MAX_BYTES),
                                ('portal.backup.aes', b'COMOSP01', backup_tools.PORTAL_MAX_BYTES)):
        artifact=exports[name]
        require(36 < artifact['bytes'] <= limit and _hash(artifact['sha256'])
                and Path(artifact['path']).parent == path.parent/'backups',
                'COPY_RUNTIME_GATEWAY_PRIOR_CIPHERTEXT_INVALID')
        require(backup_tools.file_reference(Path(artifact['path']), ciphertext=True, header=header) == artifact,
                'COPY_RUNTIME_GATEWAY_PRIOR_CIPHERTEXT_CHANGED')
    return finished



def current_source_guard(server, root):
    """The running Root readers/controllers must match the installed package."""
    verify_package(root)
    bindings={'copy_runtime_deployment.py':__file__, 'deploy-ci-vps.py':server.__file__,
              'api_web_deployment.py':native.__file__, 'ci_provider_evidence.py':provider_evidence.__file__}
    for name, loaded_path in bindings.items():
        require(Path(loaded_path).read_bytes() == (Path(root)/'scripts'/name).read_bytes(),
                'COPY_RUNTIME_GATEWAY_RUNNING_CONTROLLER_CHANGED')


def reconcile_gateways(server, manifest_ref_file):
    """Separate Root CAS for already canonical provisioning; zero business writes.

    A prior backup covers only the previous baseline. New backup + restore proof
    are deliberately outstanding after this action. No gateway is started here,
    no hold is taken/released and no ownership proof/transfer is created.
    """
    manifest_ref = _parse(native.protected_bytes(Path(manifest_ref_file)))
    manifest = _parse(native.read_reference(manifest_ref))
    require(Path(manifest_ref['path']).parent == server.PRIVATE/'controller-approvals'
            and type(manifest) is dict and set(manifest) == {'schema_version', 'source_sha', 'current_release', 'run_id',
                'before_adoption_sha256', 'before_plan_sha256', 'observed_policy', 'runtime_before_ref',
                'previous_release_env_ref', 'current_release_env_ref', 'ownership_observation_ref',
                'backup_before_provision_ref', 'gateway_provisioning', 'backup_tools_manifest_ref'}
            and type(manifest['schema_version']) is int and manifest['schema_version'] == 1
            and _hash(manifest['source_sha'], 40) and _hash(manifest['before_adoption_sha256'])
            and _hash(manifest['before_plan_sha256']) and type(manifest['run_id']) is str
            and re.fullmatch(r'[0-9]+-[0-9]+', manifest['run_id']), 'COPY_RUNTIME_GATEWAY_ROOT_APPROVAL_REQUIRED')
    current = (server.BASE/'current').resolve(strict=True)
    require(str(current) == manifest['current_release'] and current.parent == server.BASE/'releases'
            and _parse((current/'RELEASE.json').read_bytes()).get('source_sha') == manifest['source_sha'],
            'COPY_RUNTIME_GATEWAY_SOURCE_SHA_CHANGED')
    current_source_guard(server, current)
    report_dir = server.PRIVATE/'deployments'/manifest['run_id']; locks = []; owns_report = False; replay = None
    deadline = time.monotonic()+1500
    report = {'source_sha': manifest['source_sha'], 'run_id': manifest['run_id'], 'deployment_scope': 'copy-runtime',
        'action': 'RECONCILE_CANONICAL_GATEWAY_INVENTORY', 'status': 'RUNNING', 'stage': 'gateway-adoption',
        'physical_sales_proven': False, 'business_mutations': 0, 'gateways_started': 0, 'hold_released': False,
        'backup_before_coverage': 'PRIOR_BASELINE_ONLY', 'new_backup_required': True, 'new_restore_required': True}
    try:
        with deadline_fuse(deadline):
            locks = native.acquire_locks(server.PRIVATE)
            if report_dir.exists():
                prior = _parse(native.protected_bytes(report_dir/'report.json'))
                require(prior.get('status') in {'SUCCEEDED', 'RUNNING', 'FAILED'} and prior.get('action') == report['action']
                        and prior.get('approval_ref') == manifest_ref and prior.get('source_sha') == manifest['source_sha']
                        and prior.get('run_id') == manifest['run_id'], 'COPY_RUNTIME_GATEWAY_RETRY_REQUIRES_RECONCILIATION')
                actual = snapshot(server, server.PRIVATE, current, report_dir)
                require(Path(actual['state']['last_release_receipt_ref']['path']).parent == report_dir,
                        'COPY_RUNTIME_GATEWAY_IDEMPOTENT_LINEAGE_CHANGED')
                import runtime_boot_install
                if prior['status'] == 'SUCCEEDED':
                    runtime_boot_install.gateway_replay(server, current, report_dir, actual, prior)
                    replay = dict(prior, idempotent_replay=True); return replay
                completion = runtime_boot_install.gateway_recover(server, current, report_dir, actual, prior, locks, deadline, manifest)
                finished = {k: v for k, v in prior.items() if k not in {'error', 'reconciliation_required'}}
                finished.update(status='SUCCEEDED', stage='complete', host_boot=completion,
                    runtime_stage='OPERATING', finished_at=dt.datetime.now(dt.timezone.utc).isoformat(),
                    recovery='POLICY_READBACK_ONLY_NO_REDISPATCH')
                server._write_report(report_dir/'report.json', finished)
                replay = finished; return replay
            report_dir.mkdir(mode=0o700); owns_report = True; report['approval_ref'] = manifest_ref
            server._write_report(report_dir/'report.json', report)
            state_raw = native.protected_bytes(server.PRIVATE/'api-web-adoption.json'); state = _parse(state_raw); validate_state(state)
            plan_raw = native.protected_bytes(server.PRIVATE/'daily-b02/plan.json'); validate_plan(state, plan_raw)
            require(state['runtime_stage'] == 'OPERATING' and state['current_release'] == str(current)
                    and sha256(state_raw) == manifest['before_adoption_sha256']
                    and sha256(plan_raw) == manifest['before_plan_sha256'], 'COPY_RUNTIME_GATEWAY_SOURCE_CAS_CHANGED')
            terminal_journals(server.PRIVATE, state, report_dir)
            for name, ref in state['canonical_files'].items():
                if name != 'release.env': native.read_reference(ref)
            native.read_reference(state['smtp_transition_ref']); native.read_reference(state['caddy_config_ref'])
            native.read_portal_references(state['portal'])
            runtime = _parse(native.read_reference(manifest['runtime_before_ref']))
            require(type(runtime) is dict and set(runtime) == {'captured_at', 'services'} and type(runtime['services']) is dict,
                    'COPY_RUNTIME_GATEWAY_PRIOR_RUNTIME_REQUIRED')
            previous_services = validate_inventory(state, list(runtime['services'].values()))
            require(set(runtime['services']) == set(previous_services) and all(runtime['services'][name] == previous_services[name] for name in previous_services),
                    'COPY_RUNTIME_GATEWAY_PRIOR_ROLES_CHANGED')
            previous_env = native.read_reference(manifest['previous_release_env_ref'])
            require(len(previous_env) == state['canonical_files']['release.env']['bytes']
                    and sha256(previous_env) == state['canonical_files']['release.env']['sha256'],
                    'COPY_RUNTIME_GATEWAY_PRIOR_RELEASE_ENV_CHANGED')
            reference(manifest['current_release_env_ref'], server.PRIVATE/'release.env')
            release = native.env_values(native.read_reference(manifest['current_release_env_ref']))
            require(release.get('COMMERCE_DEPLOY_SCOPE') == 'copy-runtime'
                    and release.get('COMMERCE_RELEASE_SHA') == manifest['source_sha'], 'COPY_RUNTIME_GATEWAY_CANONICAL_SCOPE_CHANGED')
            workspace = state['owner_workspace_id']; observed = current_policy(server, current, workspace)
            require(policy(observed) == manifest['observed_policy']
                    and observed['body']['dispatch_frozen'] is True and observed['body']['real_sends_enabled'] is False
                    and observed['body']['allow_real_operations'] is False, 'COPY_RUNTIME_GATEWAY_POLICY_CHANGED')
            observed_revision, revisions = canonical_revision_observation(server, current, state, workspace, observed, server.PRIVATE)
            owner = server.owner_auth_snapshot(current)
            ownership = ownership_projection(server, current, workspace)
            require(_parse(native.read_reference(manifest['ownership_observation_ref'])) == ownership,
                    'COPY_RUNTIME_GATEWAY_OWNERSHIP_OBSERVATION_CHANGED')
            in_flight_guard(server, current)
            ids = server.command(['docker', 'ps', '-aq', '--no-trunc'], current).split()
            require(8 <= len(ids) <= 11 and len(set(ids)) == len(ids) and all(_hash(cid) for cid in ids),
                    'COPY_RUNTIME_GATEWAY_RUNTIME_INVENTORY_INVALID')
            services = inspect_inventory(_parse(server.command(['docker', 'inspect', *ids], current).encode()),
                portal=state['portal'], caddy_id=state['service_inventory']['caddy'])
            before = {'state': state, 'state_raw': state_raw, 'plan_raw': plan_raw, 'services': previous_services,
                'workspace': workspace, 'owner': owner, 'policy': observed, 'policy_observed': observed_revision,
                'revision_receipts': revisions, 'release': release,
                'files': {name: previous_env if name == 'release.env' else native.protected_bytes(server.PRIVATE/name) for name in FILES},
                'gateway_provisioning': manifest['gateway_provisioning'], 'source_sha': manifest['source_sha']}
            with reviewed_backup_module(manifest['backup_tools_manifest_ref'], current, manifest['source_sha']) as backup_tools:
                finished = prior_backup_guard(manifest['backup_before_provision_ref'], before, backup_tools)
            try: captured = dt.datetime.fromisoformat(runtime['captured_at'].replace('Z', '+00:00'))
            except (ValueError, TypeError): raise ReleaseError('COPY_RUNTIME_GATEWAY_PRIOR_RUNTIME_TIME_INVALID') from None
            require(captured.tzinfo is not None and captured.utcoffset() == dt.timedelta(0)
                    and finished <= captured <= dt.datetime.now(dt.timezone.utc)
                    and dt.datetime.now(dt.timezone.utc)-captured <= dt.timedelta(hours=1),
                    'COPY_RUNTIME_GATEWAY_PRIOR_RUNTIME_STALE')
            candidate = state_for_stage(before, services, current, state['last_release_receipt_ref'], 'OPERATING',
                observed_revision, server.PRIVATE, network_snapshot(server.command, current, services))
            validate_state(candidate); validate_inventory(candidate, list(services.values()))
            added = gateway_continuity(before, services, candidate, owner, server, server.PRIVATE)
            require({name: entry for name, entry in manifest['gateway_provisioning'].items() if name not in added}
                    == state['gateway_provisioning'], 'COPY_RUNTIME_GATEWAY_PREVIOUS_PROVISIONING_CHANGED')
            gateway_rendered_bindings(server, current, services, release)
            verify_gateway_provisioning(server, current, candidate, services, workspace)
            for name in added:
                query = "SELECT row_to_json(o) FROM number_operations o WHERE id="+sql_literal(candidate['gateway_provisioning'][name]['operation_id'])+"::uuid;"
                operation = _parse(server.database(current, query).encode())
                try: created = dt.datetime.fromisoformat(operation['created_at'].replace('Z', '+00:00'))
                except (KeyError, ValueError, TypeError): raise ReleaseError('COPY_RUNTIME_GATEWAY_PROVISION_TIME_INVALID') from None
                require(finished <= captured <= created, 'COPY_RUNTIME_GATEWAY_BACKUP_NOT_BEFORE_PROVISION')
                slot = str(candidate['gateway_provisioning'][name]['slot'])
                query = "SELECT readback FROM number_capacity_slots WHERE operation_id="+sql_literal(operation['id'])+"::uuid AND slot="+slot+';'
                readback = _parse(server.database(current, query).encode())
                require(type(readback.get('session_count')) is int and readback['session_count'] == 0
                        and type(readback.get('connected_sessions')) is int and readback['connected_sessions'] == 0,
                        'COPY_RUNTIME_GATEWAY_NEW_SESSION_ALREADY_STARTED')
            quiet = commercial_snapshot(server, current)
            require(ownership_projection(server, current, workspace) == ownership, 'COPY_RUNTIME_GATEWAY_OWNERSHIP_CHANGED_BEFORE_CAS')
            report.update(added_gateways=len(added), consumers_started=True, full_runtime_started=True,
                migration_count=len(server.migrations(current)), runtime_stage='OPERATING', hold_preserved=True,
                healthy_services=None)
            def final_guard():
                # Before terminal publication, still under all four locks/hold.
                require(commercial_snapshot(server, current) == quiet and ownership_projection(server, current, workspace) == ownership,
                        'COPY_RUNTIME_GATEWAY_BUSINESS_STATE_CHANGED_DURING_CAS')
            commit_stage(server, current, report_dir, before, services, report, 'OPERATING',
                {'backup_tools_manifest_ref': manifest['backup_tools_manifest_ref']}, locks, deadline,
                gateway_extension=True, before_terminal=final_guard)
            return report
    except BaseException as error:
        report.update(status='FAILED', error=server.error_code(error), reconciliation_required=True)
        if owns_report: server._write_report(report_dir/'report.json', report)
        raise
    finally:
        for lock in reversed(locks): lock.close()
        if replay is not None: print(json.dumps(replay, sort_keys=True))
        elif owns_report: print(json.dumps(report, sort_keys=True))


def prepare_ownership_history(private):
    """Prepare attest's private storage before any runtime publication effects.

    The controller's Root-only entrypoint and snapshot authenticate the private
    parent. Never repair permissions or replace an existing unsafe entry.
    """
    private = Path(private)
    require(private.is_absolute(), 'COPY_RUNTIME_HISTORY_PRIVATE_PATH_REQUIRED')
    parent_fd = None; history_fd = None
    try:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        parent_fd = os.open(private, flags)
        parent = os.fstat(parent_fd)
        require(parent.st_uid == os.geteuid() and stat.S_IMODE(parent.st_mode) == 0o700,
                'COPY_RUNTIME_HISTORY_PARENT_UNSAFE')
        try:
            os.mkdir('ownership-attestations', mode=0o700, dir_fd=parent_fd)
            os.fsync(parent_fd)
        except FileExistsError:
            pass
        history_fd = os.open('ownership-attestations', flags, dir_fd=parent_fd)
        info = os.fstat(history_fd)
        require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700,
                'COPY_RUNTIME_HISTORY_DIRECTORY_UNSAFE')
        return private/'ownership-attestations'
    except OSError:
        raise ReleaseError('COPY_RUNTIME_HISTORY_DIRECTORY_UNSAFE') from None
    finally:
        if history_fd is not None: os.close(history_fd)
        if parent_fd is not None: os.close(parent_fd)


def publish(server, archive, archive_hash, source_sha, run_id, portal_private_env):
    """Two actual publications: prepared API/web first, consumers on continuation.

    Preparation is intentionally not a successful complete runtime deployment.
    No provider call, ownership acquisition, source-host proof or SIM is invoked.
    """
    from deployment_scope import NO_PORTAL
    require(portal_private_env == NO_PORTAL, 'COPY_RUNTIME_PORTAL_NOT_SELECTED')
    report_dir = server.PRIVATE/'deployments'/run_id
    require(not report_dir.exists(), 'EXISTING_REPORT_INSPECT_OR_USE_NEW_RUN_ATTEMPT')
    report_dir.mkdir(mode=0o700, parents=True)
    report = {'source_sha': source_sha, 'run_id': run_id, 'deployment_scope': 'copy-runtime',
        'status': 'RUNNING', 'stage': 'validate', 'consumers_started': False, 'full_runtime_started': False,
        'physical_sales_proven': False, 'started_at': dt.datetime.now(dt.timezone.utc).isoformat()}
    lock = None; locks = []; mutation_started = False; committed = False
    old_scope = os.environ.get('COMMERCE_DEPLOY_SCOPE'); old_phase = os.environ.get('COMMERCE_COPY_RUNTIME_PHASE')
    root = None; hold_active = False
    deadline = time.monotonic()+1500
    fuse = deadline_fuse(deadline); fuse_entered = False
    def install_phase(phase):
        remaining = deadline_check(deadline)
        ceiling = server.PREPARE_TIMEOUT_SECONDS if phase == 'prepare' else server.INSTALL_TIMEOUT_SECONDS
        return server.run_deployment_task(root, report_dir, ['sh', 'scripts/install-vps.sh', '@existing-owner'],
                                          phase, min(remaining, ceiling))
    try:
        fuse.__enter__(); fuse_entered = True
        lock = native.acquire_locks_for_prepare(server.PRIVATE)
        previous_root = (server.BASE/'current').resolve(strict=True)
        before = snapshot(server, server.PRIVATE, previous_root, report_dir)
        stage = before['state'].get('runtime_stage'); initial = before['state']['schema_version'] == 2
        require(initial or stage in {'CORE_PREPARED', 'OPERATING'}, 'COPY_RUNTIME_START_STAGE_INVALID')
        if stage == 'OPERATING': prepare_ownership_history(server.PRIVATE)
        root = server.BASE/'releases'/('ci-'+run_id+'-'+source_sha[:12])
        require(shutil.disk_usage(server.BASE).free > max(4*1024**3, Path(archive).stat().st_size*5),
                'INSUFFICIENT_FREE_DISK')
        extract_release(archive, root, archive_hash); metadata = _parse((root/'RELEASE.json').read_bytes())
        context = provider_evidence.release_identity(metadata, source_sha, run_id, 'copy-runtime')
        provider_evidence.installation_enabled(context)
        if metadata.get('schema_version') == 2:
            report.update(provider_evidence.report_binding(metadata, run_id, archive_hash,
                before['state']['portal'], _parse((root/'images.json').read_bytes())))
        review = reviewed_migrations(server.PRIVATE, root, source_sha, metadata)
        applied = server.migrations(previous_root)
        migration_stage_guard(applied, metadata, initial=initial, stage=stage)
        if stage == 'OPERATING': installed_migration_identity(previous_root, before['release'], applied)
        if stage == 'CORE_PREPARED':
            continuation_identity(previous_root, root, before['release'], source_sha, server)
        shutil.copyfile(server.PRIVATE/'release.env', report_dir/'previous-release.env')
        server.snapshot_api_deployment_status(report_dir)
        report.update(stage='prepare', previous_release=previous_root.name)
        server._write_report(report_dir/'report.json', report)
        # Fresh canonical ciphertext backup, not reuse of a daily success.
        os.environ['COMMERCE_DEPLOY_SCOPE'] = 'api-web' if initial else 'copy-runtime'
        install_phase('prepare')
        report['predeploy_backup'] = native.verify_predeploy_backup(server.PRIVATE, report_dir)
        candidate_image = loaded_candidate_image(server, root, source_sha)
        lock.close(); lock = None; locks = native.acquire_locks(server.PRIVATE)
        fresh = snapshot(server, server.PRIVATE, previous_root, report_dir)
        require(fresh['state_raw'] == before['state_raw'] and fresh['plan_raw'] == before['plan_raw']
                and fresh['policy'] == before['policy'], 'COPY_RUNTIME_PREPARE_BASELINE_CHANGED')
        server.compare_owner_auth(before['owner'], fresh['owner']); before = fresh
        before_policy_raw = server.raw_policy_snapshot(previous_root)
        require(_parse(before_policy_raw.encode()) == {before['workspace']: before['policy']},
                'COPY_RUNTIME_POLICY_CHANGED_AFTER_PREPARE')
        require(time.monotonic() < deadline, 'COPY_RUNTIME_DEADLINE_EXCEEDED')
        os.environ['COMMERCE_DEPLOY_SCOPE'] = 'copy-runtime'; os.environ['COMMERCE_COPY_RUNTIME_LOCKS_HELD'] = '1'
        if initial:
            initial_preserved = server.preserved_containers()
            mutation_started = True
            report['stage'] = 'reviewed-migrations'; server._write_report(report_dir/'report.json', report)
            deadline_check(deadline)
            before['consumer_edge_ref'] = prepare_edge(server, root, report_dir, before, review, locks)
            report['consumer_edge_created_empty'] = True
            remaining = int(deadline-time.monotonic())
            report['bounded_migrations'] = apply_reviewed_migrations(server, root, report_dir, metadata, review, min(300, remaining))
            # Only the scope and explicitly reviewed technical edge are added.
            env = native.env_values(native.protected_bytes(server.PRIVATE/'release.env'))
            env.update(COMMERCE_DEPLOY_SCOPE='copy-runtime', COMMERCE_CONSUMER_EDGE_NETWORK=review['consumer_edge_network'])
            raw = ''.join(key+'='+value+'\n' for key, value in env.items()).encode()
            atomic_bytes(server.PRIVATE/'release.env', raw)
            os.environ['COMMERCE_COPY_RUNTIME_PHASE'] = 'core'
            install_phase('activate')
            services = native.inventory(server.command, root, before['state']['portal'])
            verify_migrations(server.migrations(root), metadata['migration_hashes'], complete=True)
            report.update(server.smoke(root, metadata, initial_preserved, before_policy_raw, True, 'api-web'))
            server.verify_ciclo_state(before['state'])
            report.update(required_action='CANONICAL_CHANNEL_CANCELLATION_AND_QUARANTINE_BEFORE_CONTINUATION',
                          migration_count=67, healthy_services=3, core_prepared=True)
            commit_stage(server, root, report_dir, before, services, report, 'CORE_PREPARED', review, locks, deadline)
        else:
            migration_stage_guard(server.migrations(previous_root), metadata, stage=stage)
            if stage == 'CORE_PREPARED':
                report.update(first_start_guard(server, previous_root))
                in_flight_guard(server, previous_root)
            copy_hold_capability(server, previous_root, before['services']['api']['Id'], candidate_image)
            require(server.command(['python3', 'scripts/ownership-isolation-receipts.py', 'supports',
                str(server.PRIVATE/'release.env')], previous_root) == '1', 'COPY_RUNTIME_TRANSIENT_HOLD_REQUIRED')
            capture = None
            if stage == 'OPERATING':
                capture = report_dir/'ownership-before.json'
                server.command(['python3', 'scripts/ownership-isolation-receipts.py', 'capture',
                                str(server.PRIVATE/'release.env'), str(capture)], previous_root)
                os.environ['COMMERCE_OWNERSHIP_RECOVERY_CAPTURE'] = str(capture)
                os.environ['COMMERCE_OWNERSHIP_HISTORY_DIR'] = str(server.PRIVATE/'ownership-attestations')
            deadline_check(deadline); mutation_started = True
            server.command(['python3', 'scripts/ownership-isolation-receipts.py', 'hold',
                            str(server.PRIVATE/'release.env')], previous_root); hold_active = True
            if stage == 'CORE_PREPARED':
                # API gates and worker rechecks enforce this hold atomically. Do
                # not let hold-induced freezing substitute for the prior gate.
                report.update(first_start_guard(server, previous_root))
                in_flight_guard(server, previous_root)
                os.environ['COMMERCE_COPY_RUNTIME_PHASE'] = 'consumers'
            else:
                server.command(['sh', 'scripts/compose-release.sh', str(server.PRIVATE/'release.env'),
                                'stop', 'automation-worker', 'channel-worker'], previous_root)
                in_flight_guard(server, previous_root)
                os.environ['COMMERCE_COPY_RUNTIME_PHASE'] = 'runtime'
            configuration = commercial_snapshot(server, previous_root)
            preserved_before = server.preserved_containers()
            if stage == 'OPERATING':
                report['stage'] = 'reviewed-migrations'; server._write_report(report_dir/'report.json', report)
                remaining = deadline_check(deadline)
                report['bounded_migrations'] = apply_reviewed_migrations(
                    server, root, report_dir, metadata, review, min(300, remaining), stage='OPERATING')
                require(commercial_snapshot(server, previous_root) == configuration,
                        'COPY_RUNTIME_COMMERCIAL_CONFIGURATION_CHANGED')
            mutation_started = True
            report.update(stage='install-consumers', workers_start_invoked=True, consumers_started=None)
            server._write_report(report_dir/'report.json', report)
            install_phase('activate')
            require(commercial_snapshot(server, root) == configuration, 'COPY_RUNTIME_COMMERCIAL_CONFIGURATION_CHANGED')
            if hold_active:
                if capture is not None:
                    server.command(['python3', 'scripts/ownership-isolation-receipts.py', 'attest',
                        str(server.PRIVATE/'release.env'), str(capture)], root)
                deadline_check(deadline)
                server.command(['python3', 'scripts/ownership-isolation-receipts.py', 'release',
                    str(server.PRIVATE/'release.env')], root); hold_active = False
            services = inspect_inventory(_parse(server.command(['docker', 'inspect',
                *server.command(['docker', 'ps', '-aq', '--no-trunc'], root).split()], root).encode()),
                portal=before['state']['portal'], caddy_id=before['services']['caddy']['Id'])
            report['consumers_started'] = True
            report.update(server.smoke(root, metadata, preserved_before,
                                        before_policy_raw, True, 'copy-runtime'))
            commit_stage(server, root, report_dir, before, services, report, 'OPERATING', review, locks, deadline)
        committed = True
    except BaseException as error:
        report.update(status='FAILED', error=server.error_code(error))
        if mutation_started:
            report['rollback'] = {'status': 'BLOCKED', 'error': 'COPY_RUNTIME_DURABLE_RECONCILIATION_REQUIRED',
                'database_restored': False, 'transient_hold_active': hold_active}
        raise
    finally:
        if fuse_entered: fuse.__exit__(None, None, None)
        os.environ.pop('COMMERCE_COPY_RUNTIME_LOCKS_HELD', None)
        os.environ.pop('COMMERCE_OWNERSHIP_RECOVERY_CAPTURE', None)
        os.environ.pop('COMMERCE_OWNERSHIP_HISTORY_DIR', None)
        if old_scope is None: os.environ.pop('COMMERCE_DEPLOY_SCOPE', None)
        else: os.environ['COMMERCE_DEPLOY_SCOPE'] = old_scope
        if old_phase is None: os.environ.pop('COMMERCE_COPY_RUNTIME_PHASE', None)
        else: os.environ['COMMERCE_COPY_RUNTIME_PHASE'] = old_phase
        if lock is not None: lock.close()
        for item in reversed(locks): item.close()
        if not committed:
            report['finished_at'] = dt.datetime.now(dt.timezone.utc).isoformat()
            server._write_report(report_dir/'report.json', report)
        print(json.dumps(report, sort_keys=True))
