#!/usr/bin/env python3
"""Root actuator for exactly the preserved initial pilot. Never emits approvals.

prepare REF_FILE creates a stopped gateway; start REF_FILE starts only its server.
readback REF_FILE performs no Docker mutation. API PROVISION and Root/B02 CAS remain
separate steps, and every nonterminal mutation requires explicit reconciliation.
"""
import copy
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT/'scripts'))
import copy_runtime_deployment as runtime
from ci_release import require


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT/'scripts'/filename)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


server = module('initial_pilot_server', 'deploy-ci-vps.py')
administrator = module('initial_pilot_administrator', 'number-capacity-administrator.py')
native = runtime.native
FIELDS = {'schema_version', 'source_sha', 'current_release', 'run_id', 'operation_id',
          'before_adoption_sha256', 'before_plan_sha256', 'pilot_release_env_ref',
          'new_release_env_ref', 'administrator_config_ref', 'backup_before_provision_ref',
          'backup_tools_manifest_ref', 'volume_inventory_ref', 'volume_mode', 'runtime_before_ref', 'credential_refs', 'compose_sha256'}
VOLUMES = ['commerce-os_waha-01-sessions', 'commerce-os_waha-01-media']


def load_approval(ref_file):
    ref = runtime._parse(native.protected_bytes(Path(ref_file)))
    value = runtime._parse(native.read_reference(ref))
    require(Path(ref['path']).parent == server.PRIVATE/'controller-approvals'
            and type(value) is dict and set(value) == FIELDS
            and type(value['schema_version']) is int and value['schema_version'] == 1
            and runtime._hash(value['source_sha'], 40)
            and value['volume_mode'] in {'PRESERVE_EXISTING','CREATE_EMPTY'}
            and all(runtime._hash(value[name]) for name in ('before_adoption_sha256', 'before_plan_sha256', 'compose_sha256'))
            and re.fullmatch(r'[0-9]+-[0-9]+', value['run_id'])
            and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', value['operation_id']), 'INITIAL_PILOT_ROOT_APPROVAL_REQUIRED')
    current = (server.BASE/'current').resolve(strict=True)
    require(str(current) == value['current_release'] and current == ROOT
            and runtime._parse((current/'RELEASE.json').read_bytes())['source_sha'] == value['source_sha'],
            'INITIAL_PILOT_INSTALLED_PACKAGE_REQUIRED')
    runtime.current_source_guard(server, current)
    require((current/'scripts/initial-pilot-root.py').read_bytes() == Path(__file__).read_bytes(), 'INITIAL_PILOT_CONTROLLER_CHANGED')
    return ref, value


def write_new(path, raw):
    require(not path.exists() and not path.is_symlink(), 'INITIAL_PILOT_EXISTING_JOURNAL_REQUIRES_READBACK')
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as target:
        target.write(raw); target.flush(); os.fsync(target.fileno())
    require(native.protected_bytes(path) == raw, 'INITIAL_PILOT_JOURNAL_READBACK_CHANGED')
    return native.reference(path, raw)


def replace_env(path, old, new):
    require(native.protected_bytes(path) == old, 'INITIAL_PILOT_RELEASE_ENV_CAS_CHANGED')
    staged = path.with_name('initial-pilot-release.env.pending')
    write_new(staged, new)
    require(native.protected_bytes(path) == old, 'INITIAL_PILOT_RELEASE_ENV_CAS_CHANGED')
    os.replace(staged, path)
    fd = os.open(path.parent, os.O_RDONLY); os.fsync(fd); os.close(fd)
    require(native.protected_bytes(path) == new, 'INITIAL_PILOT_RELEASE_ENV_READBACK_CHANGED')


def frozen_guard(current, workspace):
    policy = runtime.current_policy(server, current, workspace)
    require(policy['body']['dispatch_frozen'] is True and policy['body']['real_sends_enabled'] is False
            and policy['body']['allow_real_operations'] is False and policy['body'].get('allow_channel_onboarding', False) is False,
            'INITIAL_PILOT_FROZEN_POLICY_REQUIRED')
    ownership = runtime.ownership_projection(server, current, workspace)
    runtime.in_flight_guard(server, current)
    facts = runtime._parse(server.database(current, "SELECT json_build_object('sessions',(SELECT count(*) FROM channel_sessions WHERE environment='REAL' AND (desired_state<>'STOPPED' OR NOT operational_pause OR recovery_enabled)),'profiles',(SELECT count(*) FROM integration_settings WHERE environment='REAL' AND type IN('waha','cloud','meta') AND enabled),'commands',(SELECT count(*) FROM commands WHERE environment='REAL' AND kind='channel_command' AND (status='PENDING' OR (status='FAILED' AND payload->>'type' IN('connect','restart','disconnect','logout') AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at')))));").encode())
    require(set(facts) == {'sessions','profiles','commands'} and all(type(v) is int and v == 0 for v in facts.values()), 'INITIAL_PILOT_CHANNEL_BARRIERS_REQUIRED')
    return ownership


def read_services(current, state, slot=1):
    require(type(slot) is int and slot in {1,3}, 'INITIAL_PILOT_TARGET_SLOT_REQUIRED')
    service = 'waha-'+str(slot).zfill(2)
    baseline = runtime.CORE if slot == 1 else runtime.CORE|{'waha-01'}
    expected = baseline|{service}
    ids = server.command(['docker', 'ps', '-aq', '--no-trunc'], current).split()
    require(len(ids) == len(expected) and len(set(ids)) == len(expected) and all(runtime._hash(cid) for cid in ids), 'INITIAL_PILOT_EXACT_INVENTORY_REQUIRED')
    rows = runtime._parse(server.command(['docker', 'inspect', *ids], current).encode())
    gateways = [row for row in rows if row.get('Config',{}).get('Labels',{}).get('com.docker.compose.service') == service]
    require(len(gateways) == 1 and gateways[0]['Config']['Labels'].get('com.docker.compose.project') == 'commerce-os'
            and runtime._hash(gateways[0].get('Id')), 'INITIAL_PILOT_EXACT_INVENTORY_REQUIRED')
    # A CREATED Docker container can have NetworkID='' until start. Its actual
    # network definition comes from network inspect; never substitute an ID here.
    services = runtime.inspect_inventory([row for row in rows if row is not gateways[0]],
                    portal=state['portal'], caddy_id=state['service_inventory']['caddy'])
    require(set(services) == baseline, 'INITIAL_PILOT_BASELINE_GATEWAYS_CHANGED')
    runtime._gateway(gateways[0]); runtime.live_projection(gateways[0])
    return {**services,service:gateways[0]}


def gateway_guard(row, image, slot=1):
    volumes = gateway_volumes(slot)
    host = row['HostConfig']; env = native.env_values(('\n'.join(row['Config']['Env'])+'\n').encode())
    require(row['Image'] == image and host.get('RestartPolicy', {}).get('Name') == 'no'
            and not host.get('PortBindings') and not host.get('Privileged')
            and (host.get('OomKillDisable') is None or host.get('OomKillDisable') is False)
            and host.get('CapDrop') == ['ALL'] and host.get('Init') is True
            and host.get('PidsLimit') == 100 and host.get('Memory') == 768*1024**2
            and host.get('NanoCpus') == 300000000 and 'no-new-privileges:true' in host.get('SecurityOpt', [])
            and set(row['NetworkSettings']['Networks']) == {'commerce-os_gateway-'+str(slot).zfill(2)}
            and env.get('WHATSAPP_RESTART_ALL_SESSIONS') == 'false'
            and env.get('WAHA_WORKER_RESTART_SESSIONS') == 'false' and env.get('WHATSAPP_START_SESSION') == ''
            and env.get('WAHA_PRINT_QR') == 'false', 'INITIAL_PILOT_CANONICAL_DEFINITION_REQUIRED')
    mounts = {item.get('Destination'): item.get('Name') for item in row['Mounts']}
    require(mounts == {'/app/.sessions': volumes[0], '/app/.media': volumes[1]}, 'INITIAL_PILOT_VOLUMES_CHANGED')


def gateway_identity(row):
    fields = {key:copy.deepcopy(row[key]) for key in ('Id','Image','Name','Config','HostConfig','Mounts')}
    # Docker normalizes the default false to null on first start. Both mean OOM
    # killing remains enabled; gateway_guard rejects the unsafe true value.
    if fields['HostConfig'].get('OomKillDisable') is None:
        fields['HostConfig']['OomKillDisable'] = False
    fields['networks'] = {name:{'Aliases':entry.get('Aliases'), 'GwPriority':entry.get('GwPriority',0)}
                         for name,entry in row['NetworkSettings']['Networks'].items()}
    return fields


def gateway_volumes(slot):
    require(type(slot) is int and slot in {1,3}, 'INITIAL_PILOT_TARGET_SLOT_REQUIRED')
    return ['commerce-os_waha-'+str(slot).zfill(2)+suffix for suffix in ('-sessions','-media')]


def volume_snapshot(current, slot=1):
    volumes_wanted = gateway_volumes(slot)
    names = sorted(server.command(['docker','volume','ls','--format','{{.Name}}'],current).splitlines())
    require(len(names) == len(set(names)), 'INITIAL_PILOT_VOLUME_INVENTORY_INVALID')
    present = set(volumes_wanted)&set(names)
    require(not present or present == set(volumes_wanted), 'INITIAL_PILOT_PARTIAL_VOLUME_INVENTORY')
    volumes = runtime._parse(server.command(['docker','volume','inspect',*volumes_wanted],current).encode()) if present else []
    return {'names':names,'volumes':volumes}


def empty_owned_volumes(volumes, slot=1):
    require({row.get('Name') for row in volumes} == set(gateway_volumes(slot)), 'INITIAL_PILOT_CREATED_VOLUMES_REQUIRED')
    for row in volumes:
        labels = row.get('Labels') or {}; name = row['Name']
        require(row.get('Driver') == 'local' and labels.get('com.docker.compose.project') == 'commerce-os'
                and labels.get('com.docker.compose.volume') == name.removeprefix('commerce-os_'), 'INITIAL_PILOT_VOLUME_OWNERSHIP_REQUIRED')
        path = Path(row['Mountpoint'])
        require(path.is_absolute() and not path.is_symlink() and path.is_dir()
                and path.parent.name == name and path.name == '_data' and not any(path.iterdir()),
                'INITIAL_PILOT_CREATED_VOLUME_NOT_EMPTY')


def rendered_guard(raw, pinned, slot=1):
    volumes = gateway_volumes(slot); network = 'gateway-'+str(slot).zfill(2)
    rendered = runtime._parse(raw); definition = rendered['services']['waha-'+str(slot).zfill(2)]
    env = definition.get('environment', {})
    require(rendered.get('name') == 'commerce-os' and definition.get('image') == pinned
            and re.search(r'@sha256:[a-f0-9]{64}$',pinned)
            and definition.get('restart') == 'no' and not definition.get('ports')
            and not definition.get('privileged') and definition.get('init') is True
            and definition.get('cap_drop') == ['ALL'] and definition.get('pids_limit') == 100
            and (type(definition.get('mem_limit')), definition.get('mem_limit')) in ((int,768*1024**2),(str,str(768*1024**2)))
            and definition.get('cpus') == 0.3 and not definition.get('depends_on')
            and not definition.get('build') and not definition.get('links') and not definition.get('volumes_from')
            and 'no-new-privileges:true' in definition.get('security_opt', [])
            and set(definition.get('networks', {})) == {network}
            and rendered.get('networks',{}).get(network,{}).get('name') == 'commerce-os_'+network
            and env.get('WHATSAPP_RESTART_ALL_SESSIONS') == 'false'
            and env.get('WAHA_WORKER_RESTART_SESSIONS') == 'false'
            and env.get('WHATSAPP_START_SESSION') == '' and env.get('WAHA_PRINT_QR') == 'false',
            'INITIAL_PILOT_REVIEWED_DEFINITION_UNSAFE')
    mounts = definition.get('volumes', [])
    require(type(mounts) is list and len(mounts) == 2
            and all(item.get('type') == 'volume' for item in mounts)
            and {item.get('target'):rendered.get('volumes',{}).get(item.get('source'),{}).get('name') for item in mounts}
                == {'/app/.sessions':volumes[0],'/app/.media':volumes[1]}, 'INITIAL_PILOT_VOLUMES_CHANGED')
    return definition


def preserved(before, after, slot=1):
    gateway_volumes(slot)
    network = 'commerce-os_gateway-'+str(slot).zfill(2)
    require(set(after) == set(before)|{'waha-'+str(slot).zfill(2)}, 'INITIAL_PILOT_EXACT_INVENTORY_REQUIRED')
    for name, old in before.items():
        actual = copy.deepcopy(after[name])
        if name in {'channel-worker', 'ingress'}:
            networks = actual['NetworkSettings']['Networks']
            require(set(networks) == set(old['NetworkSettings']['Networks'])|{network}, 'INITIAL_PILOT_WORKER_NETWORK_CHANGED')
            networks.pop(network)
        runtime.compare_live_snapshot({name: old}, {name: actual})


def network_guard(current, state, services, release, slot=1):
    gateway_volumes(slot)
    # Docker has no live endpoint for a created/stopped container. Do not invent it.
    names = set().union(*(set(row['NetworkSettings']['Networks']) for row in services.values()))
    rows = runtime._parse(server.command(['docker','network','inspect',*sorted(names)],current).encode())
    require(type(rows) is list and len(rows) == len(names), 'INITIAL_PILOT_NETWORK_READBACK_REQUIRED')
    networks = {}
    for row in rows:
        name = row.get('Name')
        require(name in names and name not in networks, 'INITIAL_PILOT_NETWORK_READBACK_REQUIRED')
        expected = {container['Id'] for container in services.values() if container['State']['Running'] and name in container['NetworkSettings']['Networks']}
        require(set(row.get('Containers',{})) == expected, 'INITIAL_PILOT_NETWORK_FOREIGN_ENDPOINT')
        networks[name] = {key:row[key] for key in ('Name','Id','Driver','Internal','EnableIPv6','IPAM','Options','Labels')}
        for container in services.values():
            endpoint=container['NetworkSettings']['Networks'].get(name)
            if endpoint is not None:
                require(endpoint.get('NetworkID') == row['Id'] or (not container['State']['Running'] and endpoint.get('NetworkID') == ''),
                        'INITIAL_PILOT_NETWORK_BINDING_CHANGED')
    require(set(networks) == set(state['network_baseline'])|{'commerce-os_gateway-'+str(slot).zfill(2)}
            and all(networks[name] == value for name,value in state['network_baseline'].items()), 'INITIAL_PILOT_EXISTING_NETWORK_CHANGED')
    runtime.topology(server.command,current,services,networks,release)
    return networks


def execute(action, ref_file):
    require(os.geteuid() == 0 and sys.platform == 'linux', 'INITIAL_PILOT_LINUX_ROOT_REQUIRED')
    require(action in {'prepare', 'start', 'readback'}, 'INITIAL_PILOT_ACTION_REQUIRED')
    ref, approval = load_approval(ref_file); current = ROOT
    directory = server.PRIVATE/'initial-pilot'/approval['run_id']; locks = []
    try:
        with runtime.deadline_fuse(time.monotonic()+300):
            locks = native.acquire_locks(server.PRIVATE)
            state_raw = native.protected_bytes(server.PRIVATE/'api-web-adoption.json')
            plan_raw = native.protected_bytes(server.PRIVATE/'daily-b02/plan.json')
            require(runtime.sha256(state_raw) == approval['before_adoption_sha256']
                    and runtime.sha256(plan_raw) == approval['before_plan_sha256'], 'INITIAL_PILOT_BASELINE_CAS_CHANGED')
            state = runtime._parse(state_raw); runtime.validate_state(state); runtime.validate_plan(state, plan_raw)
            require(state['runtime_stage'] == 'OPERATING' and not state['gateway_provisioning'], 'INITIAL_PILOT_ZERO_GATEWAYS_REQUIRED')
            config = runtime._parse(native.read_reference(approval['administrator_config_ref']))
            pilot = native.env_values(native.read_reference(approval['pilot_release_env_ref']))
            require(config['release_env'] == str(server.PRIVATE/'release.env')
                    and config['gateway_dir'] == pilot.get('COMMERCE_GATEWAY_CONFIG_DIR')
                    and not Path(config['overlay']).exists(), 'INITIAL_PILOT_CONFIGURATION_BOUNDARY_CHANGED')
            require(type(approval['credential_refs']) is dict and set(approval['credential_refs']) == {'waha-01.env','channel-pilot.env','ingress-pilot.env'}, 'INITIAL_PILOT_CREDENTIAL_REFERENCES_REQUIRED')
            for name, credential_ref in approval['credential_refs'].items():
                runtime.reference(credential_ref,str(Path(config['gateway_dir'])/name)); native.read_reference(credential_ref)
            agent = administrator.Administrator(config); agent.credentials(1, create=False)
            volume_before = runtime._parse(native.read_reference(approval['volume_inventory_ref']))
            observed_volumes = volume_snapshot(current)
            require(type(volume_before) is dict and set(volume_before) == {'names','volumes'}, 'INITIAL_PILOT_VOLUME_INVENTORY_INVALID')
            if action == 'prepare':
                require(observed_volumes == volume_before
                        and (bool(volume_before['volumes']) if approval['volume_mode']=='PRESERVE_EXISTING' else not volume_before['volumes']), 'INITIAL_PILOT_PRESERVED_VOLUMES_REQUIRED')
            else:
                prepared_volumes = runtime._parse(native.protected_bytes(directory/'prepared.json'))['volumes']
                require(observed_volumes == prepared_volumes, 'INITIAL_PILOT_PRESERVED_VOLUMES_REQUIRED')
            ownership = frozen_guard(current, state['owner_workspace_id'])
            new_env = native.read_reference(approval['new_release_env_ref'])
            new_values = native.env_values(new_env)
            require(new_values.get('COMMERCE_PILOT_RELEASE_ENV') == approval['pilot_release_env_ref']['path'], 'INITIAL_PILOT_OVERLAY_REQUIRED')
            if action == 'prepare':
                require(not directory.exists(), 'INITIAL_PILOT_EXISTING_JOURNAL_REQUIRES_READBACK')
                before = runtime.snapshot(server, server.PRIVATE, current, directory)
                before['source_sha'] = approval['source_sha']
                require(set(before['services']) == runtime.CORE, 'INITIAL_PILOT_ZERO_GATEWAYS_REQUIRED')
                require({k:v for k,v in before['release'].items() if k != 'COMMERCE_PILOT_RELEASE_ENV'}
                        == {k:v for k,v in new_values.items() if k != 'COMMERCE_PILOT_RELEASE_ENV'}, 'INITIAL_PILOT_RELEASE_BOUNDARY_CHANGED')
                with runtime.reviewed_backup_module(approval['backup_tools_manifest_ref'], current, approval['source_sha']) as backup_tools:
                    finished = runtime.prior_backup_guard(approval['backup_before_provision_ref'], before, backup_tools)
                query = "SELECT row_to_json(o) FROM number_operations o JOIN number_capacity_slots s ON s.id::text=o.input->>'slot_id' WHERE o.id="+runtime.sql_literal(approval['operation_id'])+"::uuid AND o.workspace_id="+runtime.sql_literal(state['owner_workspace_id'])+" AND o.environment='REAL' AND o.action='PROVISION' AND o.state IN('RESERVED','HUMAN_ACTION_REQUIRED') AND (o.lease_until IS NULL OR o.lease_until<=clock_timestamp()) AND s.slot=1 AND s.account_id::text=o.input->>'account_id';"
                operation = runtime._parse(server.database(current, query).encode())
                created = dt.datetime.fromisoformat(operation['created_at'].replace('Z', '+00:00'))
                captured = runtime._parse(native.read_reference(approval['runtime_before_ref']))
                require(type(captured) is dict and set(captured) == {'captured_at','services'}, 'INITIAL_PILOT_PRIOR_RUNTIME_REQUIRED')
                runtime.compare_live_snapshot(captured['services'], before['services'])
                captured_at = dt.datetime.fromisoformat(captured['captured_at'].replace('Z','+00:00'))
                require(finished <= captured_at <= created <= dt.datetime.now(dt.timezone.utc)
                        and dt.datetime.now(dt.timezone.utc)-finished <= dt.timedelta(hours=1), 'INITIAL_PILOT_BACKUP_BEFORE_OPERATION_REQUIRED')
                rendered = server.command(['sh',str(current/'scripts/compose-release.sh'),approval['new_release_env_ref']['path'],'config','--format','json'],current)
                require(runtime.sha256(rendered.encode()) == approval['compose_sha256'], 'INITIAL_PILOT_REVIEWED_COMPOSE_CHANGED')
                pinned = re.search(r'^    image: (.+)$',(current/'infra/compose/pilot.yaml').read_text(),re.M).group(1)
                rendered_guard(rendered.encode(),pinned)
                image = runtime._parse(server.command(['docker','image','inspect',pinned], current).encode())[0]['Id']
                directory.parent.mkdir(mode=0o700, exist_ok=True); directory.mkdir(mode=0o700)
                old_ref = write_new(directory/'previous-release.env', before['files']['release.env'])
                runtime_ref = approval['runtime_before_ref']
                write_new(directory/'intent.json', runtime.sealed_bytes({'approval_ref':ref,'ownership':ownership,'previous_release_env_ref':old_ref,'runtime_before_ref':runtime_ref}))
                replace_env(server.PRIVATE/'release.env', before['files']['release.env'], new_env)
                agent.compose('create', '--no-build', '--no-recreate', '--pull', 'never', 'waha-01')
                gateway = agent.snapshot(1); gateway_guard(gateway, image)
                require(gateway['State']['Running'] is False and gateway['State']['Pid'] == 0, 'INITIAL_PILOT_STOPPED_REQUIRED')
                for name in ('channel-worker', 'ingress'):
                    server.command(['docker','network','connect','commerce-os_gateway-01',before['services'][name]['Id']], current)
                after = read_services(current, state); preserved(before['services'], after)
                runtime.gateway_rendered_bindings(server,current,after,new_values)
                networks = network_guard(current,state,after,new_values)
                created_volumes = volume_snapshot(current)
                require(set(created_volumes['names']) == set(volume_before['names'])|set(VOLUMES), 'INITIAL_PILOT_UNEXPECTED_VOLUME_CREATED')
                if approval['volume_mode']=='PRESERVE_EXISTING':require(created_volumes == volume_before, 'INITIAL_PILOT_VOLUMES_CHANGED')
                else:empty_owned_volumes(created_volumes['volumes'])
                require(frozen_guard(current,state['owner_workspace_id']) == ownership, 'INITIAL_PILOT_OWNERSHIP_CHANGED')
                for credential_ref in approval['credential_refs'].values():native.read_reference(credential_ref)
                write_new(directory/'prepared.json', runtime.sealed_bytes({'approval_ref':ref,'services':after,'image':image,'volumes':created_volumes,'networks':networks}))
                return {'status':'PREPARED_STOPPED','slot':1,'containers_created':1,'volumes_created':2 if approval['volume_mode']=='CREATE_EMPTY' else 0,'servers_started':0,'sessions_observed':None,'adopted':False,'new_backup_required':True}
            intent = runtime._parse(native.protected_bytes(directory/'intent.json'))
            prepared = runtime._parse(native.protected_bytes(directory/'prepared.json'))
            require(intent['approval_ref'] == ref and prepared['approval_ref'] == ref
                    and native.protected_bytes(server.PRIVATE/'release.env') == new_env
                    and intent['ownership'] == ownership, 'INITIAL_PILOT_PREPARED_BINDING_CHANGED')
            services = read_services(current,state); gateway_guard(services['waha-01'], prepared['image'])
            runtime.gateway_rendered_bindings(server,current,services,new_values)
            require(gateway_identity(services['waha-01']) == gateway_identity(prepared['services']['waha-01']), 'INITIAL_PILOT_GATEWAY_IDENTITY_CHANGED')
            require(network_guard(current,state,services,new_values) == prepared['networks'], 'INITIAL_PILOT_NETWORK_IDENTITY_CHANGED')
            if action == 'start':
                require(not (directory/'start-intent.json').exists(), 'INITIAL_PILOT_START_REQUIRES_READBACK')
                runtime.compare_live_snapshot({k:v for k,v in prepared['services'].items() if k!='waha-01'}, {k:v for k,v in services.items() if k!='waha-01'})
                require(runtime.live_projection(prepared['services']['waha-01']) == runtime.live_projection(services['waha-01'])
                        and services['waha-01']['State']['Running'] is False, 'INITIAL_PILOT_CREATED_INSTANCE_CHANGED')
                write_new(directory/'start-intent.json', runtime.sealed_bytes({'approval_ref':ref,'container_id':services['waha-01']['Id']}))
                server.command(['docker','start',services['waha-01']['Id']],current)
            readback = agent.readback(1)
            require(readback['session_count'] == 0 and readback['connected_sessions'] == 0, 'INITIAL_PILOT_EXISTING_SESSIONS_REQUIRE_REVIEW')
            after = read_services(current,state); gateway_guard(after['waha-01'],prepared['image'])
            after_networks = network_guard(current,state,after,new_values)
            require(after_networks == prepared['networks'] and gateway_identity(after['waha-01']) == gateway_identity(prepared['services']['waha-01']), 'INITIAL_PILOT_GATEWAY_IDENTITY_CHANGED')
            runtime.compare_live_snapshot({k:v for k,v in prepared['services'].items() if k!='waha-01'}, {k:v for k,v in after.items() if k!='waha-01'})
            require(frozen_guard(current,state['owner_workspace_id']) == ownership, 'INITIAL_PILOT_OWNERSHIP_CHANGED')
            for credential_ref in approval['credential_refs'].values():native.read_reference(credential_ref)
            if action == 'start':write_new(directory/'http-readback.json',runtime.sealed_bytes({'observed_at':dt.datetime.now(dt.timezone.utc).isoformat(),'container_id':after['waha-01']['Id'],'readback':readback}))
            return {'status':'HTTP_VERIFIED_ADOPTION_REQUIRED','slot':1,'readback':readback,'adopted':False,'hold_released':False,'sessions_started':0,'new_backup_required':True,'new_restore_required':True}
    finally:
        for stream in reversed(locks): stream.close()


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 3, 'INITIAL_PILOT_ACTION_AND_REFERENCE_REQUIRED')
        print(json.dumps(execute(sys.argv[1], sys.argv[2])))
    except BaseException as error:
        print(str(error) if re.fullmatch(r'[A-Z_]+',str(error)) else 'INITIAL_PILOT_RECONCILIATION_REQUIRED', file=sys.stderr)
        sys.exit(1)
