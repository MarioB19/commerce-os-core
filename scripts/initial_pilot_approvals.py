"""Root capture -> API operation -> observed, explicitly sealed pilot approval."""
import datetime as dt
import importlib.util
from pathlib import Path
import re
import time

import copy_runtime_approvals as review
import copy_runtime_deployment as runtime
from ci_release import digest, require, verify_package

native = runtime.native
READERS = tuple(dict.fromkeys((*review.READERS, 'initial-pilot-approvals.py',
    'initial_pilot_approvals.py', 'initial-pilot-root.py',
    'number-capacity-administrator.py', 'additional-gateways.py')))
CREDENTIALS = {'waha-01.env', 'channel-pilot.env', 'ingress-pilot.env'}


def identity(review_id):
    require(type(review_id) is str and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', review_id),
            'PILOT_REVIEW_ID_REQUIRED')


def timestamp(value):
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(parsed.tzinfo is not None and parsed.utcoffset() == dt.timedelta(0), 'PILOT_REVIEW_UTC_REQUIRED')
    return parsed


def file_ref(path):
    raw = review.read_private(Path(path))
    return native.reference(Path(path), raw)


def read_ref(ref):
    runtime.reference(ref)
    raw = review.read_private(Path(ref['path']))
    require(native.reference(Path(ref['path']), raw) == ref, 'PILOT_REVIEW_REFERENCE_CHANGED')
    return raw


def ref_file(path):
    ref = runtime._parse(review.read_private(Path(path)))
    read_ref(ref)
    return ref


def directory(adapter, review_id, create=False):
    identity(review_id)
    base = review.private_directory(adapter.private/'initial-pilot-reviews', create=create)
    return review.private_directory(base/review_id, create=create)


def same_capture(first, second):
    require({k:v for k,v in first.items() if k not in {'captured_at','services'}} ==
            {k:v for k,v in second.items() if k not in {'captured_at','services'}}, 'PILOT_REVIEW_CAPTURE_CHANGED')
    runtime.compare_live_snapshot(first['services'], second['services'])


class Native(review.Native):
    def __init__(self):
        super().__init__()
        self.loaded_readers={name:review.read_private(Path(__file__).with_name(name),mode=None) for name in READERS}
        spec = importlib.util.spec_from_file_location('pilot_review_actuator', Path(__file__).with_name('initial-pilot-root.py'))
        self.pilot = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.pilot)
        self.server = self.pilot.server
        self.server.command = review.bounded_command

    def package(self):
        current = (self.base/'current').resolve(strict=True)
        require(current == Path(__file__).resolve().parent.parent, 'PILOT_REVIEW_INSTALLED_READER_REQUIRED')
        for name in READERS:
            require(self.loaded_readers[name] == review.read_private(Path(__file__).with_name(name), mode=None) ==
                    review.read_private(current/'scripts'/name, mode=None), 'PILOT_REVIEW_READER_CHANGED')
        verify_package(current)
        runtime.current_source_guard(self.server, current)
        release = runtime._parse(review.read_private(current/'RELEASE.json', mode=None))
        require(runtime._hash(release.get('source_sha'), 40), 'PILOT_REVIEW_PACKAGE_IDENTITY')
        return current, release['source_sha'], digest(current/'PACKAGE.sha256')

    def baseline(self, folder):
        current, source, manifest = self.package()
        before = runtime.snapshot(self.server, self.private, current, folder/'unused-report')
        require(before['state']['schema_version'] == 3 and before['state']['runtime_stage'] == 'OPERATING'
                and not before['state']['gateway_provisioning'] and set(before['services']) == runtime.CORE,
                'PILOT_REVIEW_OPERATING_ZERO_GATEWAYS_REQUIRED')
        before['source_sha'] = source
        return current, manifest, before

    def backup(self, capture, before, current):
        read_ref(capture['backup_before_provision_ref']); read_ref(capture['backup_tools_manifest_ref'])
        with runtime.reviewed_backup_module(capture['backup_tools_manifest_ref'], current, before['source_sha']) as tools:
            return runtime.prior_backup_guard(capture['backup_before_provision_ref'], before, tools)

    def capture_native(self, folder, backup, tools):
        current, manifest, before = self.baseline(folder)
        runtime.in_flight_guard(self.server, current)
        policy = before['policy']['body']
        require(policy['dispatch_frozen'] is True and policy['real_sends_enabled'] is False
                and policy['allow_real_operations'] is False and not policy.get('allow_channel_onboarding', False),
                'PILOT_REVIEW_FROZEN_POLICY_REQUIRED')
        finished = self.backup({'backup_before_provision_ref':backup,'backup_tools_manifest_ref':tools}, before, current)
        now = dt.datetime.now(dt.timezone.utc)
        require(finished <= now, 'PILOT_REVIEW_BACKUP_BEFORE_CAPTURE_REQUIRED')
        return {'current_release':str(current), 'source_sha':before['source_sha'], 'package_manifest_sha256':manifest,
                'before_adoption_sha256':runtime.sha256(before['state_raw']),
                'before_plan_sha256':runtime.sha256(before['plan_raw']),
                'profile_sha256':{name:runtime.sha256(raw) for name,raw in before['files'].items()},
                'backup_finished_at':finished.isoformat(), 'captured_at':now.isoformat(), 'services':before['services']}

    def candidate_env(self, folder, pilot_path):
        old = review.read_private(self.private/'release.env')
        values = native.env_values(old)
        # Preserve every existing line except the sole explicit overlay selector.
        lines = [line for line in old.decode().splitlines() if not line.startswith('COMMERCE_PILOT_RELEASE_ENV=')]
        raw = ('\n'.join(lines)+'\nCOMMERCE_PILOT_RELEASE_ENV='+str(pilot_path)+'\n').encode()
        require({k:v for k,v in values.items() if k != 'COMMERCE_PILOT_RELEASE_ENV'} ==
                {k:v for k,v in native.env_values(raw).items() if k != 'COMMERCE_PILOT_RELEASE_ENV'},
                'PILOT_REVIEW_RELEASE_BOUNDARY_CHANGED')
        return review.immutable(folder/'candidate-release.env', raw)

    def observe_native(self, folder, capture, params):
        current, manifest, before = self.baseline(folder)
        require(str(current) == capture['current_release'] and before['source_sha'] == capture['source_sha']
                and manifest == capture['package_manifest_sha256']
                and runtime.sha256(before['state_raw']) == capture['before_adoption_sha256']
                and runtime.sha256(before['plan_raw']) == capture['before_plan_sha256']
                and {name:runtime.sha256(raw) for name,raw in before['files'].items()} == capture['profile_sha256'],
                'PILOT_REVIEW_CAPTURE_BASELINE_CHANGED')
        prior = runtime._parse(read_ref(capture['runtime_before_ref']))
        require(set(prior) == {'captured_at','services'} and prior['captured_at'] == capture['captured_at'],
                'PILOT_REVIEW_CAPTURE_REFERENCE_CHANGED')
        runtime.compare_live_snapshot(prior['services'], before['services'])
        ownership = self.pilot.frozen_guard(current, before['workspace'])
        finished = self.backup(capture, before, current)
        query = ("SELECT row_to_json(o) FROM number_operations o JOIN number_capacity_slots s ON s.id::text=o.input->>'slot_id' WHERE o.id="+
            runtime.sql_literal(params['operation_id'])+"::uuid AND o.workspace_id="+runtime.sql_literal(before['workspace'])+
            " AND o.environment='REAL' AND o.action='PROVISION' AND o.state IN('RESERVED','HUMAN_ACTION_REQUIRED')"
            " AND (o.lease_until IS NULL OR o.lease_until<=clock_timestamp()) AND s.slot=1 AND s.workspace_id=o.workspace_id"
            " AND s.environment='REAL' AND s.operation_id=o.id AND s.account_id::text=o.input->>'account_id';")
        operation = runtime._parse(self.server.database(current, query).encode())
        require(type(operation) is dict and operation.get('id') == params['operation_id'], 'PILOT_REVIEW_OPERATION_REQUIRED')
        require(finished == timestamp(capture['backup_finished_at']) and
                finished <= timestamp(prior['captured_at']) <= timestamp(operation['created_at']) <= dt.datetime.now(dt.timezone.utc),
                'PILOT_REVIEW_BACKUP_CAPTURE_OPERATION_ORDER_REQUIRED')
        config = runtime._parse(read_ref(params['administrator_config_ref']))
        require(type(config) is dict and set(config) == {'api_origin','token_file','release_env','gateway_dir','overlay'},
                'PILOT_REVIEW_ADMIN_CONFIG_REQUIRED')
        pilot = native.env_values(read_ref(params['pilot_release_env_ref']))
        require(config['release_env'] == str(self.private/'release.env') and config['gateway_dir'] == pilot.get('COMMERCE_GATEWAY_CONFIG_DIR')
                and not Path(config['overlay']).exists() and not Path(config['overlay']).is_symlink(),
                'PILOT_REVIEW_CONFIGURATION_BOUNDARY_CHANGED')
        review.private_directory(Path(config['gateway_dir']))
        token_ref = file_ref(config['token_file'])
        credentials = {name:file_ref(Path(config['gateway_dir'])/name) for name in sorted(CREDENTIALS)}
        self.pilot.administrator.Administrator(config).credentials(1, create=False)
        new_env = native.env_values(read_ref(params['new_release_env_ref']))
        require(new_env.get('COMMERCE_PILOT_RELEASE_ENV') == params['pilot_release_env_ref']['path']
                and {k:v for k,v in new_env.items() if k!='COMMERCE_PILOT_RELEASE_ENV'} ==
                    {k:v for k,v in before['release'].items() if k!='COMMERCE_PILOT_RELEASE_ENV'}, 'PILOT_REVIEW_RELEASE_BOUNDARY_CHANGED')
        volumes = self.pilot.volume_snapshot(current)
        raw = self.server.command(['sh',str(current/'scripts/compose-release.sh'),params['new_release_env_ref']['path'],'config','--format','json'],current).encode()
        pinned = re.search(r'^    image: (.+)$',review.read_private(current/'infra/compose/pilot.yaml',mode=None).decode(),re.M).group(1)
        self.pilot.rendered_guard(raw,pinned)
        image = runtime._parse(self.server.command(['docker','image','inspect',pinned],current).encode())
        require(type(image) is list and len(image)==1 and runtime._hash(image[0].get('Id','').removeprefix('sha256:')),
                'PILOT_REVIEW_PINNED_IMAGE_REQUIRED')
        for ref in credentials.values(): read_ref(ref)
        read_ref(token_ref)
        return {'ownership':ownership,'operation':operation,'volume_inventory':volumes,
                'volume_mode':'PRESERVE_EXISTING' if volumes['volumes'] else 'CREATE_EMPTY',
                'credential_refs':credentials,'administrator_token_ref':token_ref,
                'compose_sha256':runtime.sha256(raw),'image_id':image[0]['Id']}


def capture(adapter, review_id, backup_ref_path, tools_ref_path):
    identity(review_id)
    folder = directory(adapter,review_id,True)
    require(not (folder/'capture.json').exists(), 'PILOT_REVIEW_CAPTURE_EXISTS')
    backup, tools = ref_file(backup_ref_path), ref_file(tools_ref_path)
    with adapter.locked():
        first=adapter.capture_native(folder,backup,tools); second=adapter.capture_native(folder,backup,tools)
        same_capture(first,second)
        prior = review.immutable(folder/'runtime-before.json',review.encoded({k:second[k] for k in ('captured_at','services')}))
        value={k:v for k,v in second.items() if k!='services'}
        value.update(schema_version=1,review_id=review_id,backup_before_provision_ref=backup,backup_tools_manifest_ref=tools,runtime_before_ref=prior)
        ref=review.immutable(folder/'capture.json',review.encoded(value))
    return {'status':'CAPTURED_OPERATION_REQUIRED','review_id':review_id,'source_sha':value['source_sha'],
            'capture_sha256':ref['sha256'],'services_observed':8,'approval_issued':False,'business_mutations':0}


def load_capture(folder, review_id):
    value=runtime._parse(review.read_private(folder/'capture.json'))
    require(value.get('schema_version')==1 and value.get('review_id')==review_id, 'PILOT_REVIEW_CAPTURE_INVALID')
    for name in ('backup_before_provision_ref','backup_tools_manifest_ref','runtime_before_ref'):read_ref(value[name])
    return value


def approval_value(saved, params, facts, volume_ref):
    approval={key:saved[key] for key in ('source_sha','current_release','before_adoption_sha256','before_plan_sha256',
                  'backup_before_provision_ref','backup_tools_manifest_ref','runtime_before_ref')}
    approval.update(schema_version=1,**params,volume_inventory_ref=volume_ref,
                    **{key:facts[key] for key in ('volume_mode','credential_refs','compose_sha256')})
    return approval


def observe(adapter, review_id, run_id, operation_id, pilot_env, admin_config):
    require(re.fullmatch(r'[1-9][0-9]*-[1-9][0-9]*',run_id) and
            re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',operation_id), 'PILOT_REVIEW_OPERATION_IDENTITY')
    folder=directory(adapter,review_id); saved=load_capture(folder,review_id)
    require(not (folder/'observation.json').exists(), 'PILOT_REVIEW_OBSERVATION_EXISTS')
    params={'run_id':run_id,'operation_id':operation_id,'pilot_release_env_ref':file_ref(pilot_env),
            'administrator_config_ref':file_ref(admin_config)}
    with adapter.locked():
        params['new_release_env_ref']=adapter.candidate_env(folder,params['pilot_release_env_ref']['path'])
        first=adapter.observe_native(folder,saved,params); second=adapter.observe_native(folder,saved,params)
        require(first==second,'PILOT_REVIEW_NATIVE_CHANGED')
        volume_ref=review.immutable(folder/'volume-inventory.json',review.encoded(second['volume_inventory']))
        approval=approval_value(saved,params,second,volume_ref)
        value={'schema_version':1,'review_id':review_id,'created_at_epoch':int(time.time()),
               'capture_ref':file_ref(folder/'capture.json'),'params':params,'native':second,'approval':approval}
        ref=review.immutable(folder/'observation.json',review.encoded(value))
    return summary(value,ref,'OBSERVED_REVIEW_REQUIRED')


def summary(value, ref, status):
    approval=value['approval']
    return {'status':status,'review_id':value['review_id'],'observation_sha256':ref['sha256'],
            'source_sha':approval['source_sha'],'run_id':approval['run_id'],'operation_id':approval['operation_id'],
            'volume_mode':approval['volume_mode'],'services_observed':8,'gateway_created':False,'sessions_started':0}


def seal(adapter, review_id, observation_sha):
    require(runtime._hash(observation_sha),'PILOT_REVIEW_OBSERVATION_HASH_REQUIRED')
    folder=directory(adapter,review_id); raw=review.read_private(folder/'observation.json')
    require(runtime.sha256(raw)==observation_sha,'PILOT_REVIEW_OBSERVATION_HASH_CHANGED')
    value=runtime._parse(raw)
    require(set(value)=={'schema_version','review_id','created_at_epoch','capture_ref','params','native','approval'}
            and value['schema_version']==1 and value['review_id']==review_id,'PILOT_REVIEW_OBSERVATION_INVALID')
    saved=load_capture(folder,review_id)
    require(read_ref(value['capture_ref'])==review.read_private(folder/'capture.json'),'PILOT_REVIEW_CAPTURE_CHANGED')
    ref=native.reference(folder/'observation.json',raw)
    with adapter.locked():
        receipt=folder/'seal.json'
        if receipt.exists() or receipt.is_symlink():
            sealed=runtime._parse(review.read_private(receipt))
            require(sealed['observation_ref']==ref,'PILOT_REVIEW_RECEIPT_CHANGED')
            read_ref(sealed['approval_ref']); read_ref(sealed['reference_file_ref'])
            return summary(value,ref,'SEALED_REPLAY_HISTORICAL')
        require(type(value['created_at_epoch']) is int and 0<=time.time()-value['created_at_epoch']<=review.MAX_AGE,
                'PILOT_REVIEW_OBSERVATION_EXPIRED')
        require(adapter.observe_native(folder,saved,value['params'])==value['native'],'PILOT_REVIEW_NATIVE_CHANGED')
        require(runtime._parse(read_ref(value['approval']['volume_inventory_ref']))==value['native']['volume_inventory'],
                'PILOT_REVIEW_VOLUME_REFERENCE_CHANGED')
        require(approval_value(saved,value['params'],value['native'],value['approval']['volume_inventory_ref'])==value['approval'],
                'PILOT_REVIEW_APPROVAL_CHANGED')
        require(adapter.observe_native(folder,saved,value['params'])==value['native'],'PILOT_REVIEW_NATIVE_CHANGED')
        require(review.read_private(folder/'observation.json')==raw,'PILOT_REVIEW_OBSERVATION_CHANGED')
        approvals=review.private_directory(adapter.private/'controller-approvals',create=True)
        approved=review.immutable(approvals/('initial-pilot-'+review_id+'.json'),review.encoded(value['approval']))
        reference=review.immutable(folder/'approval-ref.json',review.encoded(approved))
        review.immutable(receipt,review.encoded({'schema_version':1,'observation_ref':ref,'approval_ref':approved,'reference_file_ref':reference}))
    result=summary(value,ref,'SEALED'); result['approval_ref_file']=str(folder/'approval-ref.json')
    return result
