"""Root-only observed approval for adoption of the preserved first pilot.

No business writes, container mutation, source isolation or automatic adoption.
The CLI has no fixture mode; synthetic adapters exist only inside tests.
"""
import datetime as dt
from pathlib import Path
import re
import time

import initial_pilot_approvals as initial
from ci_release import digest, require

review = initial.review
runtime = initial.runtime
native = initial.native
FIELDS = {'schema_version', 'source_sha', 'current_release', 'run_id',
          'before_adoption_sha256', 'before_plan_sha256', 'observed_policy',
          'runtime_before_ref', 'previous_release_env_ref', 'current_release_env_ref',
          'ownership_observation_ref', 'backup_before_provision_ref',
          'gateway_provisioning', 'backup_tools_manifest_ref'}
READERS = (*initial.READERS, 'initial-pilot-adoption-approvals.py', 'initial_pilot_adoption_approvals.py')


def tools_manifest(source, state_sha, plan_sha, tools):
    require(runtime._hash(source, 40) and runtime._hash(state_sha) and runtime._hash(plan_sha)
            and type(tools) is dict and set(tools) == set(review.TOOLS), 'PILOT_ADOPTION_TOOL_MANIFEST_INVALID')
    for ref in tools.values(): runtime.reference(ref)
    return {'schema_version': 1, 'source_sha': source, 'before_adoption_sha256': state_sha,
            'before_plan_sha256': plan_sha, 'runtime_stage': 'OPERATING', 'tools': tools}


def journal_binding(approval_ref, approval, intent, prepared, started, http, services, operation, slot_record, audit, now, *, slot=1):
    require(type(slot) is int and slot in {1,3}, 'PILOT_ADOPTION_TARGET_SLOT_REQUIRED')
    service = 'waha-'+str(slot).zfill(2)
    start_fields = {'approval_ref','container_id'} | ({'requested_at'} if slot == 3 else set())
    require(type(intent) is dict and set(intent) == {'approval_ref', 'ownership', 'previous_release_env_ref', 'runtime_before_ref'}
            and type(prepared) is dict and set(prepared) == {'approval_ref', 'services', 'image', 'volumes', 'networks'}
            and type(started) is dict and set(started) == start_fields
            and type(http) is dict and set(http) == {'observed_at', 'container_id', 'readback'}, 'PILOT_ADOPTION_JOURNALS_REQUIRED')
    require(all(row['approval_ref'] == approval_ref for row in (intent, prepared, started))
            and intent['runtime_before_ref'] == approval['runtime_before_ref'], 'PILOT_ADOPTION_JOURNAL_BINDING_CHANGED')
    require(service in services and type(prepared.get('services')) is dict and service in prepared['services'], 'PILOT_ADOPTION_HTTP_START_BINDING_CHANGED')
    gateway = services[service]; readback = http['readback']
    require(started['container_id'] == http['container_id'] == gateway['Id'] == prepared['services'][service]['Id']
            and prepared['image'] == gateway['Image'] and gateway['State']['Running'] is True
            and type(readback) is dict and readback.get('slot') == slot and readback.get('running') is True
            and readback.get('image_digest') == gateway['Image']
            and readback.get('network_present') is True and readback.get('volumes_preserved') is True
            and type(readback.get('session_count')) is int and readback['session_count'] == 0
            and type(readback.get('connected_sessions')) is int and readback['connected_sessions'] == 0,
            'PILOT_ADOPTION_HTTP_START_BINDING_CHANGED')
    require(type(operation) is dict and operation.get('id') == approval['operation_id']
            and operation.get('environment') == 'REAL' and operation.get('action') == 'PROVISION'
            and operation.get('state') == 'SUCCEEDED' and operation.get('lease_until') is None
            and operation.get('input', {}).get('existing_account') is True
            and type(slot_record) is dict and slot_record.get('id') == operation['input'].get('slot_id')
            and slot_record.get('account_id') == operation['input'].get('account_id')
            and slot_record.get('workspace_id') == operation.get('workspace_id')
            and slot_record.get('environment') == 'REAL' and slot_record.get('slot') == slot
            and slot_record.get('operation_id') == operation['id'], 'PILOT_ADOPTION_CANONICAL_OPERATION_REQUIRED')
    if slot == 3:
        require(initial.timestamp(operation['created_at']) <= initial.timestamp(started['requested_at'])
                <= initial.timestamp(gateway['State']['StartedAt']) <= initial.timestamp(http['observed_at']),
                'PILOT_ADOPTION_START_DISPATCH_ORDER_REQUIRED')
    observed = slot_record.get('readback', {})
    require(type(observed.get('session_count')) is int and observed['session_count'] == 0
            and type(observed.get('connected_sessions')) is int and observed['connected_sessions'] == 0,
            'PILOT_ADOPTION_ZERO_SESSION_READBACK_REQUIRED')
    require(type(audit) is dict and audit.get('aggregate_id') == operation['id']
            and audit.get('workspace_id') == operation['workspace_id'] and audit.get('environment') == 'REAL'
            and audit.get('event_type') == 'capacity.admin_readback'
            and audit.get('payload', {}).get('outcome') == 'VERIFIED'
            and audit.get('actor', {}).get('type') in {'human', 'personal_api', 'service'}
            and runtime._identifier(audit.get('actor', {}).get('id')), 'PILOT_ADOPTION_ADMIN_AUDIT_REQUIRED')
    require(initial.timestamp(operation['created_at']) <= initial.timestamp(gateway['State']['StartedAt'])
            <= initial.timestamp(http['observed_at']) <= initial.timestamp(observed['observed_at'])
            <= now and initial.timestamp(http['observed_at']) <= initial.timestamp(audit['occurred_at']) <= now,
            'PILOT_ADOPTION_READBACK_ORDER_REQUIRED')


class Native(initial.Native):
    def __init__(self):
        super().__init__()
        self.loaded_readers = {name: review.read_private(Path(__file__).with_name(name), mode=None) for name in READERS}

    def package(self):
        current, source, manifest = super().package()
        for name in READERS:
            require(self.loaded_readers[name] == review.read_private(Path(__file__).with_name(name), mode=None)
                    == review.read_private(current/'scripts'/name, mode=None), 'PILOT_ADOPTION_READER_CHANGED')
        return current, source, manifest

    def compare_native(self, before, after):
        runtime.compare_live_snapshot(before['services'], after['services'])
        self.server.compare_owner_auth(before['owner'], after['owner'])
        require({k: v for k, v in before.items() if k not in {'services', 'owner'}}
                == {k: v for k, v in after.items() if k not in {'services', 'owner'}}, 'PILOT_ADOPTION_NATIVE_CHANGED')

    def observe_native(self, folder, params):
        current, source, manifest_sha = self.package()
        initial.read_ref(params['pilot_approval_ref_file_ref'])
        approval_ref, approval = self.pilot.load_approval(params['pilot_approval_ref_file_ref']['path'])
        require(approval['source_sha'] == source and approval['run_id'] != params['run_id'], 'PILOT_ADOPTION_SOURCE_CHANGED')
        report_dir = self.private/'deployments'/params['run_id']
        require(not report_dir.exists() and not report_dir.is_symlink(), 'PILOT_ADOPTION_ATTEMPT_ALREADY_STARTED')
        journal_dir = self.private/'initial-pilot'/approval['run_id']
        journals = {name: initial.file_ref(journal_dir/(name+'.json'))
                    for name in ('intent', 'prepared', 'start-intent', 'http-readback')}
        intent, prepared, started, http = [runtime._parse(initial.read_ref(journals[name]))
                    for name in ('intent', 'prepared', 'start-intent', 'http-readback')]
        state_raw = review.read_private(self.private/'api-web-adoption.json')
        plan_raw = review.read_private(self.private/'daily-b02/plan.json')
        state = runtime._parse(state_raw); runtime.validate_state(state); runtime.validate_plan(state, plan_raw)
        require(state['runtime_stage'] == 'OPERATING' and not state['gateway_provisioning']
                and state['current_release'] == str(current)
                and runtime.sha256(state_raw) == approval['before_adoption_sha256']
                and runtime.sha256(plan_raw) == approval['before_plan_sha256'], 'PILOT_ADOPTION_BASELINE_CAS_CHANGED')
        runtime.terminal_journals(self.private, state, report_dir)
        for name, ref in state['canonical_files'].items():
            if name != 'release.env': native.read_reference(ref)
        native.read_reference(state['smtp_transition_ref']); native.read_reference(state['caddy_config_ref'])
        native.read_portal_references(state['portal'])
        previous_env = initial.read_ref(intent['previous_release_env_ref'])
        old_ref = state['canonical_files']['release.env']
        require(len(previous_env) == old_ref['bytes'] and runtime.sha256(previous_env) == old_ref['sha256'],
                'PILOT_ADOPTION_PREVIOUS_ENV_CHANGED')
        current_env_ref = initial.file_ref(self.private/'release.env')
        current_env = initial.read_ref(current_env_ref)
        require(current_env == initial.read_ref(approval['new_release_env_ref']), 'PILOT_ADOPTION_RELEASE_ENV_CHANGED')
        release = native.env_values(current_env)
        workspace = state['owner_workspace_id']
        require(native.env_values(review.read_private(self.private/'api.env'))['WORKSPACE_ID'] == workspace,
                'PILOT_ADOPTION_WORKSPACE_CHANGED')
        ownership = self.pilot.frozen_guard(current, workspace)
        policy = runtime.current_policy(self.server, current, workspace)
        observed_revision, revisions = runtime.canonical_revision_observation(self.server, current, state, workspace, policy, self.private)
        owner = self.server.owner_auth_snapshot(current)
        services = self.pilot.read_services(current, state)
        require(set(services) == runtime.CORE | {'waha-01'}, 'PILOT_ADOPTION_SINGLE_GATEWAY_REQUIRED')
        self.pilot.gateway_guard(services['waha-01'], prepared['image'])
        require(self.pilot.gateway_identity(services['waha-01']) == self.pilot.gateway_identity(prepared['services']['waha-01']),
                'PILOT_ADOPTION_PREPARED_GATEWAY_CHANGED')
        runtime.compare_live_snapshot({k: v for k, v in prepared['services'].items() if k != 'waha-01'},
                                      {k: v for k, v in services.items() if k != 'waha-01'})
        networks = self.pilot.network_guard(current, state, services, release)
        volumes = self.pilot.volume_snapshot(current)
        require(networks == prepared['networks'] and volumes == prepared['volumes'], 'PILOT_ADOPTION_STORAGE_OR_NETWORK_CHANGED')
        require(native.active_proxy_digest(self.server.command, current, services) == state['active_proxy_sha256'],
                'PILOT_ADOPTION_PROXY_CHANGED')
        runtime.verify_edge(self.server, current, state, services, release)
        config = runtime._parse(initial.read_ref(approval['administrator_config_ref']))
        for ref in approval['credential_refs'].values(): initial.read_ref(ref)
        agent = self.pilot.administrator.Administrator(config)
        agent.credentials(1, create=False)
        http_now = agent.readback(1)
        require(http_now == http['readback'], 'PILOT_ADOPTION_HTTP_READBACK_CHANGED')
        runtime.gateway_rendered_bindings(self.server, current, services, release)
        overlay_bytes = review.read_private(current/'infra/compose/pilot.yaml', mode=None)
        overlay_ref = review.immutable(folder/'pilot-overlay.yaml', overlay_bytes)
        provisioning = {'waha-01': {'operation_id': approval['operation_id'], 'slot': 1,
            'overlay_ref': overlay_ref, 'definition_sha256': runtime.definition_digest(services['waha-01'])}}
        prior_runtime = runtime._parse(initial.read_ref(approval['runtime_before_ref']))
        require(type(prior_runtime) is dict and set(prior_runtime) == {'captured_at', 'services'}, 'PILOT_ADOPTION_PRIOR_RUNTIME_REQUIRED')
        previous_services = runtime.validate_inventory(state, list(prior_runtime['services'].values()))
        require(prior_runtime['services'] == previous_services, 'PILOT_ADOPTION_PRIOR_RUNTIME_CHANGED')
        before = {'state': state, 'state_raw': state_raw, 'plan_raw': plan_raw, 'services': previous_services,
                  'workspace': workspace, 'owner': owner, 'policy': policy, 'policy_observed': observed_revision,
                  'revision_receipts': revisions, 'release': release, 'source_sha': source,
                  'files': {name: previous_env if name == 'release.env' else review.read_private(self.private/name) for name in runtime.FILES},
                  'gateway_provisioning': provisioning}
        candidate = runtime.state_for_stage(before, services, current, state['last_release_receipt_ref'], 'OPERATING', observed_revision, self.private, networks)
        runtime.validate_state(candidate); runtime.validate_inventory(candidate, list(services.values()))
        require(runtime.gateway_continuity(before, services, candidate, owner, self.server, self.private) == {'waha-01'},
                'PILOT_ADOPTION_GATEWAY_SET_CHANGED')
        runtime.verify_gateway_provisioning(self.server, current, candidate, services, workspace)
        query = ("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT json_build_object('operation',"
                 "(SELECT row_to_json(o) FROM number_operations o WHERE o.id="+runtime.sql_literal(approval['operation_id'])+"::uuid),"
                 "'slot',(SELECT row_to_json(s) FROM number_capacity_slots s WHERE s.operation_id="+
                 runtime.sql_literal(approval['operation_id'])+"::uuid AND s.slot=1),"
                 "'audit',(SELECT row_to_json(e) FROM domain_events e WHERE e.workspace_id="+runtime.sql_literal(workspace)+
                 " AND e.environment='REAL' AND e.aggregate_id="+runtime.sql_literal(approval['operation_id'])+
                 " AND e.event_type='capacity.admin_readback' AND e.payload->>'outcome'='VERIFIED' ORDER BY e.occurred_at DESC,e.id LIMIT 1)); ROLLBACK;")
        facts = runtime._parse(self.server.database(current, query).encode())
        journal_binding(approval_ref, approval, intent, prepared, started, http, services,
                        facts.get('operation'), facts.get('slot'), facts.get('audit'), dt.datetime.now(dt.timezone.utc))
        require(facts['operation']['workspace_id'] == workspace
                and initial.timestamp(ownership['hold_at']) > max(initial.timestamp(facts['audit']['occurred_at']),
                    initial.timestamp(facts['slot']['readback']['observed_at'])),
                'PILOT_ADOPTION_NEW_HOLD_REQUIRED')
        with runtime.reviewed_backup_module(approval['backup_tools_manifest_ref'], current, source) as tools:
            finished = runtime.prior_backup_guard(approval['backup_before_provision_ref'], before, tools)
        require(finished <= initial.timestamp(prior_runtime['captured_at']) <= initial.timestamp(facts['operation']['created_at']),
                'PILOT_ADOPTION_BACKUP_ORDER_REQUIRED')
        tool_refs = {name: native.reference(current/'scripts'/name, review.read_private(current/'scripts'/name, mode=None)) for name in review.TOOLS}
        manifest = tools_manifest(source, runtime.sha256(state_raw), runtime.sha256(plan_raw), tool_refs)
        # No hidden data may drift after the authenticated local HTTP read.
        for ref in journals.values(): initial.read_ref(ref)
        for ref in approval['credential_refs'].values(): initial.read_ref(ref)
        require(review.read_private(self.private/'api-web-adoption.json') == state_raw
                and review.read_private(self.private/'daily-b02/plan.json') == plan_raw
                and initial.read_ref(current_env_ref) == current_env, 'PILOT_ADOPTION_FINAL_CAS_CHANGED')
        return {'source_sha': source, 'current_release': str(current), 'package_manifest_sha256': manifest_sha,
                'pilot_approval_ref': approval_ref, 'journals': journals, 'operation': facts['operation'], 'slot': facts['slot'], 'audit': facts['audit'],
                'before_adoption_sha256': runtime.sha256(state_raw), 'before_plan_sha256': runtime.sha256(plan_raw),
                'observed_policy': runtime.policy(policy), 'runtime_before_ref': approval['runtime_before_ref'],
                'previous_release_env_ref': intent['previous_release_env_ref'], 'current_release_env_ref': current_env_ref,
                'backup_before_provision_ref': approval['backup_before_provision_ref'], 'gateway_provisioning': provisioning,
                'ownership': ownership, 'services': services, 'owner': owner, 'http_readback': http_now,
                'tools_manifest': manifest, 'commercial_sha256': runtime.commercial_snapshot(self.server, current)}


def directory(adapter, review_id, create=False):
    initial.identity(review_id)
    base = review.private_directory(adapter.private/'initial-pilot-adoption-reviews', create=create)
    return review.private_directory(base/review_id, create=create)


def approval_value(facts, run_id, ownership_ref, tools_ref):
    keys = FIELDS-{'schema_version', 'run_id', 'ownership_observation_ref', 'backup_tools_manifest_ref'}
    value = {key: facts[key] for key in keys}
    return dict(value, schema_version=1, run_id=run_id, ownership_observation_ref=ownership_ref, backup_tools_manifest_ref=tools_ref)


def summary(value, ref, status):
    return {'status': status, 'review_id': value['review_id'], 'observation_sha256': ref['sha256'],
            'source_sha': value['native']['source_sha'], 'run_id': value['params']['run_id'],
            'gateways_observed': 1, 'sessions_observed': 0, 'adoption_executed': False, 'backup_executed': False,
            'business_mutations': 0, 'source_isolation_issued': False}


def observe(adapter, review_id, run_id, pilot_ref_file):
    require(type(run_id) is str and re.fullmatch(r'[1-9][0-9]*-[1-9][0-9]*', run_id), 'PILOT_ADOPTION_RUN_ID_REQUIRED')
    folder = directory(adapter, review_id, True)
    require(not (folder/'observation.json').exists(), 'PILOT_ADOPTION_OBSERVATION_EXISTS')
    params = {'run_id': run_id, 'pilot_approval_ref_file_ref': initial.file_ref(pilot_ref_file)}
    with adapter.locked():
        first = adapter.observe_native(folder, params); second = adapter.observe_native(folder, params)
        adapter.compare_native(first, second)
        ownership_ref = review.immutable(folder/'ownership.json', review.encoded(second['ownership']))
        tools_path = adapter.private/'controller-approvals'/('initial-pilot-adoption-'+review_id+'-tools.json')
        tools_ref = native.reference(tools_path, review.encoded(second['tools_manifest']))
        approval = approval_value(second, run_id, ownership_ref, tools_ref)
        value = {'schema_version': 1, 'review_id': review_id, 'created_at_epoch': int(time.time()),
                 'params': params, 'native': second, 'approval': approval}
        ref = review.immutable(folder/'observation.json', review.encoded(value))
    return summary(value, ref, 'OBSERVED_REVIEW_REQUIRED')


def seal(adapter, review_id, observation_sha):
    require(runtime._hash(observation_sha), 'PILOT_ADOPTION_OBSERVATION_HASH_REQUIRED')
    folder = directory(adapter, review_id); raw = review.read_private(folder/'observation.json')
    require(runtime.sha256(raw) == observation_sha, 'PILOT_ADOPTION_OBSERVATION_HASH_CHANGED')
    value = runtime._parse(raw)
    require(type(value) is dict and set(value) == {'schema_version', 'review_id', 'created_at_epoch', 'params', 'native', 'approval'}
            and value['schema_version'] == 1 and value['review_id'] == review_id, 'PILOT_ADOPTION_OBSERVATION_INVALID')
    ref = native.reference(folder/'observation.json', raw)
    with adapter.locked():
        receipt = folder/'seal.json'
        if receipt.exists() or receipt.is_symlink():
            saved = runtime._parse(review.read_private(receipt))
            require(saved['observation_ref'] == ref, 'PILOT_ADOPTION_RECEIPT_CHANGED')
            for name in ('approval_ref', 'tools_ref', 'reference_file_ref'): initial.read_ref(saved[name])
            return summary(value, ref, 'SEALED_REPLAY_HISTORICAL')
        require(type(value['created_at_epoch']) is int and 0 <= time.time()-value['created_at_epoch'] <= review.MAX_AGE,
                'PILOT_ADOPTION_OBSERVATION_EXPIRED')
        current = adapter.observe_native(folder, value['params'])
        adapter.compare_native(value['native'], current)
        ownership_ref = value['approval']['ownership_observation_ref']
        require(runtime._parse(initial.read_ref(ownership_ref)) == current['ownership'], 'PILOT_ADOPTION_OWNERSHIP_REFERENCE_CHANGED')
        approvals = review.private_directory(adapter.private/'controller-approvals', create=True)
        tools_path = approvals/('initial-pilot-adoption-'+review_id+'-tools.json')
        tools_raw = review.encoded(current['tools_manifest']); tools_ref = native.reference(tools_path, tools_raw)
        require(approval_value(current, value['params']['run_id'], ownership_ref, tools_ref) == value['approval'],
                'PILOT_ADOPTION_APPROVAL_CHANGED')
        adapter.compare_native(current, adapter.observe_native(folder, value['params']))
        require(review.read_private(folder/'observation.json') == raw, 'PILOT_ADOPTION_OBSERVATION_CHANGED')
        actual_tools = review.immutable(tools_path, tools_raw)
        require(actual_tools == tools_ref, 'PILOT_ADOPTION_TOOL_REFERENCE_CHANGED')
        approved = review.immutable(approvals/('initial-pilot-adoption-'+review_id+'.json'), review.encoded(value['approval']))
        reference = review.immutable(folder/'approval-ref.json', review.encoded(approved))
        review.immutable(receipt, review.encoded({'schema_version': 1, 'observation_ref': ref, 'approval_ref': approved,
                                                'tools_ref': tools_ref, 'reference_file_ref': reference}))
    result = summary(value, ref, 'SEALED'); result['approval_ref_file'] = str(folder/'approval-ref.json')
    return result
