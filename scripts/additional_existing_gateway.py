"""Observed Root approval for the existing account in slot 3, after slot 1.

The installed package is the authority. This module never creates a business
record, credentials, a backup, a GCP binding, or an approval from caller facts.
"""
import datetime as dt
import importlib.util
import json
from pathlib import Path
import re
import time
from types import SimpleNamespace

import initial_pilot_approvals as initial
import initial_pilot_adoption_approvals as adoption
from ci_release import require

review, runtime, native = initial.review, initial.runtime, initial.native
SLOT = 3
SERVICE = 'waha-03'
NETWORK = 'commerce-os_gateway-03'
BASELINE = runtime.CORE | {'waha-01'}
READERS = tuple(dict.fromkeys((*adoption.READERS, 'additional_existing_gateway.py',
    'additional-existing-gateway-approvals.py', 'additional-existing-gateway-root.py')))
FIELDS = {'schema_version','source_sha','current_release','run_id','operation_id',
    'before_adoption_sha256','before_plan_sha256','pilot_release_env_ref','new_release_env_ref',
    'administrator_config_ref','backup_before_provision_ref','backup_tools_manifest_ref',
    'volume_inventory_ref','volume_mode','runtime_before_ref','credential_refs','compose_sha256',
    'target_slot','additional_overlay_ref','gcp_binding_ref','credential_binding'}


def baseline_guard(before):
    state = before['state']
    require(state['schema_version'] == 3 and state['runtime_stage'] == 'OPERATING'
            and set(state['gateway_provisioning']) == {'waha-01'}
            and set(state['service_inventory']) == BASELINE and set(before['services']) == BASELINE,
            'ADDITIONAL_EXISTING_NINE_SERVICE_BASELINE_REQUIRED')


def operation_guard(operation, slot, workspace, now):
    require(type(operation) is dict and type(slot) is dict, 'ADDITIONAL_EXISTING_OPERATION_REQUIRED')
    data = operation.get('input', {})
    require(operation.get('workspace_id') == workspace and slot.get('workspace_id') == workspace
            and operation.get('environment') == slot.get('environment') == 'REAL'
            and operation.get('action') == 'PROVISION' and operation.get('state') in {'RESERVED','HUMAN_ACTION_REQUIRED'}
            and data.get('existing_account') is True and type(slot.get('slot')) is int and slot['slot'] == SLOT
            and slot.get('state') == 'RESERVED' and slot.get('host_ref') == 'primary' and slot.get('gateway_ref') in ('WAHA_03', SERVICE)
            and slot.get('id') == data.get('slot_id') and slot.get('account_id') == data.get('account_id')
            and slot.get('operation_id') == operation.get('id') and data.get('gateway_profile_ref') == 'WAHA_03'
            and all(type(data.get(k)) is int and data[k] > 0 for k in ('expected_account_version','expected_session_version'))
            and all(runtime._identifier(v) for v in (operation.get('id'),slot.get('id'),slot.get('account_id'),data.get('gateway_profile_ref'))),
            'ADDITIONAL_EXISTING_OPERATION_BINDING_CHANGED')
    require(initial.timestamp(operation['created_at']) <= now
            and (operation.get('lease_until') is None or initial.timestamp(operation['lease_until']) <= now),
            'ADDITIONAL_EXISTING_OPERATION_LEASE_ACTIVE')


def approval_guard(value):
    require(type(value) is dict and set(value) == FIELDS and type(value['schema_version']) is int
            and value['schema_version'] == 1 and type(value['target_slot']) is int and value['target_slot'] == SLOT
            and value['volume_mode'] in {'CREATE_EMPTY','PRESERVE_EXISTING'}
            and runtime._hash(value['source_sha'],40)
            and all(runtime._hash(value[k]) for k in ('before_adoption_sha256','before_plan_sha256','compose_sha256'))
            and re.fullmatch(r'[1-9][0-9]*-[1-9][0-9]*',value['run_id'])
            and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',value['operation_id'])
            and set(value['credential_refs']) == {'waha-03.env'}, 'ADDITIONAL_EXISTING_APPROVAL_REQUIRED')
    for name in FIELDS:
        if name.endswith('_ref'): runtime.reference(value[name])
    for ref in value['credential_refs'].values(): runtime.reference(ref)


# Credentials enter only stdin of the installed API process, never SQL/argv/logs.
# Only the profile selected by the canonical existing-account operation is decrypted.
CREDENTIAL_JS = r"""
import {readFileSync} from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
const db=await import('./packages/db/src/index.ts');let c;
const eq=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)};
try{
 const raw=readFileSync(0);if(raw.length>8192)throw Error();const i=JSON.parse(raw.toString());raw.fill(0);
 if(process.env.COMMERCE_RELEASE_SHA!==i.source_sha)throw Error();
 c=await db.pool.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL statement_timeout='10000ms'");
 const a=await db.getRecord(c,i.workspace,'channel_account',i.account_id);
 const s=(await c.query('SELECT * FROM channel_sessions WHERE workspace_id=$1 AND account_id=$2 AND environment=$3',[i.workspace,i.account_id,'REAL'])).rows;
 if(!a||a.environment!=='REAL'||a.body.provider!=='waha'||a.body.gateway_ref!=='WAHA_03'||a.body.sending_enabled!==false||a.body.deleted_at||a.body.unlinked_at||a.version!==i.account_version||s.length!==1)throw Error();
 const session=s[0];if(session.revision!==i.session_version||session.archived_at||session.desired_state!=='STOPPED'||session.operational_pause!==true||session.recovery_enabled!==false)throw Error();
 if(i.profile_key!=='waha:'+a.body.gateway_ref)throw Error();
 const p=await db.readIntegrationSettings(c,i.workspace,'REAL',i.profile_key,{secrets:true});
 if(!p||p.enabled!==false||p.type!=='waha'||p.config.base_url!=='http://waha-03:3000'||!eq(p.secrets?.api_key,i.api_key)||!eq(p.secrets?.webhook_secret,i.webhook_secret))throw Error();
 i.api_key='';i.webhook_secret='';
 process.stdout.write(JSON.stringify({account_id:a.id,account_version:a.version,session_version:session.revision,profile_key:p.key,profile_version:p.version,credentials_match:true,profile_disabled:true}));
 await c.query('ROLLBACK');
}catch{process.exitCode=1;process.stderr.write('ADDITIONAL_EXISTING_PRIVATE_BINDING_FAILED\n');}
finally{if(c)c.release();await db.pool.end();}
"""


PROFILE_JS = CREDENTIAL_JS.replace(
    "||!eq(p.secrets?.api_key,i.api_key)||!eq(p.secrets?.webhook_secret,i.webhook_secret)",
    "||p.secrets?.api_key?.startsWith('sha512:')||![p.secrets?.api_key,p.secrets?.webhook_secret].every(v=>typeof v==='string'&&/^[A-Za-z0-9._~:/+!=@%\\-]{1,512}$/.test(v))").replace("credentials_match:true", "secrets_present:true,secrets_valid:true")
EXPORT_JS = PROFILE_JS.replace(
    "secrets_present:true,secrets_valid:true,profile_disabled:true}",
    "secrets_present:true,secrets_valid:true,profile_disabled:true,credential_env:'WAHA_API_KEY='+p.secrets.api_key+'\\nWHATSAPP_HOOK_HMAC_KEY='+p.secrets.webhook_secret+'\\n'}")


def profile_binding(server, current, operation, workspace, source, *, export=False):
    data=operation['input']
    payload={'workspace':workspace,'source_sha':source,'account_id':data['account_id'],
             'account_version':data['expected_account_version'],'session_version':data['expected_session_version'],
             'profile_key':'waha:'+data['gateway_profile_ref']}
    raw=server.command(['sh','scripts/compose-release.sh',str(server.PRIVATE/'release.env'),
        'exec','-T','api','node','--import','tsx','--input-type=module','-e',EXPORT_JS if export else PROFILE_JS],current,json.dumps(payload))
    try:
        result=runtime._parse(raw.encode())
        fields={'account_id','account_version','session_version','profile_key','profile_version','secrets_present','secrets_valid','profile_disabled'}
        require(type(result) is dict and set(result)==fields|({'credential_env'} if export else set())
                and result['account_id']==data['account_id'] and result['account_version']==data['expected_account_version']
                and result['session_version']==data['expected_session_version'] and result['profile_key']=='waha:WAHA_03'
                and type(result['profile_version']) is int and result['profile_version']>0
                and result['secrets_present'] is True and result['secrets_valid'] is True and result['profile_disabled'] is True,
                'ADDITIONAL_EXISTING_PRIVATE_BINDING_CHANGED')
        return result
    finally:raw=''


def credential_binding(server, current, agent, operation, workspace, source):
    credentials = agent.credentials(SLOT, create=False)
    data = operation['input']
    payload = {'workspace':workspace,'source_sha':source,'account_id':data['account_id'],
        'account_version':data['expected_account_version'],'session_version':data['expected_session_version'],
        'profile_key':'waha:'+data['gateway_profile_ref'],'api_key':credentials['WAHA_API_KEY'],
        'webhook_secret':credentials['WHATSAPP_HOOK_HMAC_KEY']}
    try:
        result = runtime._parse(server.command(['sh','scripts/compose-release.sh',str(server.PRIVATE/'release.env'),
            'exec','-T','api','node','--import','tsx','--input-type=module','-e',CREDENTIAL_JS],current,json.dumps(payload)).encode())
    finally:
        payload['api_key']=''; payload['webhook_secret']=''; credentials.clear()
    require(type(result) is dict and set(result) == {'account_id','account_version','session_version','profile_key','profile_version','credentials_match','profile_disabled'}
            and result['credentials_match'] is True and result['profile_disabled'] is True
            and result['account_id'] == data['account_id'] and result['account_version'] == data['expected_account_version']
            and result['session_version'] == data['expected_session_version'] and result['profile_key'] == 'waha:'+data['gateway_profile_ref']
            and type(result['profile_version']) is int and result['profile_version'] > 0,
            'ADDITIONAL_EXISTING_PRIVATE_BINDING_CHANGED')
    return result


def profile_matches_credential(profile, actual):
    require(profile.get('secrets_present') is True and profile.get('secrets_valid') is True
            and actual.get('credentials_match') is True
            and {k:v for k,v in profile.items() if k not in {'secrets_present','secrets_valid'}}
                == {k:v for k,v in actual.items() if k!='credentials_match'},
            'ADDITIONAL_EXISTING_PRIVATE_BINDING_CHANGED')


def read_operation(server, current, operation_id, workspace):
    q = ("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT json_build_object('operation',"
         "(SELECT row_to_json(o) FROM number_operations o WHERE o.id="+runtime.sql_literal(operation_id)+"::uuid),"
         "'slot',(SELECT row_to_json(s) FROM number_capacity_slots s WHERE s.workspace_id="+runtime.sql_literal(workspace)+
         " AND s.environment='REAL' AND s.host_ref='primary' AND s.slot=3)); ROLLBACK;")
    facts = runtime._parse(server.database(current,q).encode())
    operation_guard(facts.get('operation'),facts.get('slot'),workspace,dt.datetime.now(dt.timezone.utc))
    require(facts['operation']['id'] == operation_id, 'ADDITIONAL_EXISTING_OPERATION_CHANGED')
    return facts


def manual_binding(server, current, before):
    baseline_guard(before)
    plan = runtime._parse(before['plan_raw'])
    require(plan.get('schedule_enabled') is False, 'ADDITIONAL_EXISTING_MANUAL_BACKUP_REQUIRED')
    spec=importlib.util.spec_from_file_location('additional_backup',current/'scripts/b02-backup-root.py')
    backup=importlib.util.module_from_spec(spec);spec.loader.exec_module(backup)
    def runtime_guard():
        actual=runtime.closed_inventory(server.command,current,before['state'])
        runtime.compare_live_snapshot(before['services'],actual)
    runner=SimpleNamespace(plan_sha256=runtime.sha256(before['plan_raw']),plan=plan,runtime_guard=runtime_guard)
    value=backup.read_gcp_binding(runner)
    require(value['mode']=='MANUAL' and value['source_sha']==before['source_sha'], 'ADDITIONAL_EXISTING_MANUAL_BACKUP_REQUIRED')
    return initial.file_ref(backup.GCP_BINDING_PATH)


class Native(initial.Native):
    def __init__(self):
        super().__init__()
        self.loaded_readers={name:review.read_private(Path(__file__).with_name(name),mode=None) for name in READERS}

    def package(self):
        result=super().package()
        for name in READERS:
            require(self.loaded_readers[name] == review.read_private(Path(__file__).with_name(name),mode=None), 'ADDITIONAL_EXISTING_READER_CHANGED')
        return result

    def baseline(self, folder):
        current, source, manifest=self.package()
        before=runtime.snapshot(self.server,self.private,current,folder/'unused-report')
        before['source_sha']=source;baseline_guard(before)
        manual_binding(self.server,current,before)
        return current,manifest,before

    def candidate_overlay(self, folder, config):
        require(config['overlay']==str(self.private/'additional-gateways.json')
                and not Path(config['overlay']).exists() and not Path(config['overlay']).is_symlink(), 'ADDITIONAL_EXISTING_OVERLAY_PRESENT')
        value=self.pilot.administrator.helper.overlay(['03'],config['gateway_dir'])
        return review.immutable(folder/'candidate-additional-gateways.json',(json.dumps(value,indent=2)+'\n').encode())

    def observe_native(self, folder, capture, params):
        current,manifest,before=self.baseline(folder)
        require(str(current)==capture['current_release'] and before['source_sha']==capture['source_sha']
                and manifest==capture['package_manifest_sha256']
                and runtime.sha256(before['state_raw'])==capture['before_adoption_sha256']
                and runtime.sha256(before['plan_raw'])==capture['before_plan_sha256']
                and {name:runtime.sha256(raw) for name,raw in before['files'].items()}==capture['profile_sha256'], 'ADDITIONAL_EXISTING_CAPTURE_CHANGED')
        prior=runtime._parse(initial.read_ref(capture['runtime_before_ref']))
        require(set(prior)=={'captured_at','services'} and prior['captured_at']==capture['captured_at'], 'ADDITIONAL_EXISTING_CAPTURE_CHANGED')
        runtime.compare_live_snapshot(prior['services'],before['services'])
        ownership=self.pilot.frozen_guard(current,before['workspace'])
        finished=self.backup(capture,before,current)
        facts=read_operation(self.server,current,params['operation_id'],before['workspace'])
        require(finished==initial.timestamp(capture['backup_finished_at']) and finished<=initial.timestamp(prior['captured_at'])
                <=initial.timestamp(facts['operation']['created_at']), 'ADDITIONAL_EXISTING_BACKUP_OPERATION_ORDER_REQUIRED')
        config=runtime._parse(initial.read_ref(params['administrator_config_ref']))
        require(type(config) is dict and set(config)=={'api_origin','token_file','release_env','gateway_dir','overlay'}, 'ADDITIONAL_EXISTING_ADMIN_CONFIG_REQUIRED')
        pilot=native.env_values(initial.read_ref(params['pilot_release_env_ref']))
        require(config['release_env']==str(self.private/'release.env') and config['gateway_dir']==pilot.get('COMMERCE_GATEWAY_CONFIG_DIR')
                and before['release'].get('COMMERCE_PILOT_RELEASE_ENV')==params['pilot_release_env_ref']['path']
                and initial.read_ref(params['new_release_env_ref'])==before['files']['release.env']
                and config['overlay']==str(self.private/'additional-gateways.json')
                and not Path(config['overlay']).exists() and not Path(config['overlay']).is_symlink(), 'ADDITIONAL_EXISTING_CONFIGURATION_CHANGED')
        review.private_directory(Path(config['gateway_dir']))
        require(runtime._parse(initial.read_ref(params['additional_overlay_ref']))==self.pilot.administrator.helper.overlay(['03'],config['gateway_dir']), 'ADDITIONAL_EXISTING_OVERLAY_CHANGED')
        token_ref=initial.file_ref(config['token_file'])
        credentials={'waha-03.env':initial.file_ref(Path(config['gateway_dir'])/'waha-03.env')}
        agent=self.pilot.administrator.Administrator(config)
        binding=credential_binding(self.server,current,agent,facts['operation'],before['workspace'],before['source_sha'])
        volumes=self.pilot.volume_snapshot(current,SLOT)
        raw=self.server.command(['sh',str(current/'scripts/compose-release.sh'),str(self.private/'release.env'),'-f',params['additional_overlay_ref']['path'],'config','--format','json'],current).encode()
        pinned=re.search(r'^    image: (.+)$',review.read_private(current/'infra/compose/pilot.yaml',mode=None).decode(),re.M).group(1)
        self.pilot.rendered_guard(raw,pinned,SLOT)
        require(set(runtime._parse(raw)['services'])==BASELINE-{'caddy','portal'}|{SERVICE}, 'ADDITIONAL_EXISTING_COMPOSE_SET_CHANGED')
        image=runtime._parse(self.server.command(['docker','image','inspect',pinned],current).encode())
        require(type(image) is list and len(image)==1 and runtime._hash(image[0].get('Id','').removeprefix('sha256:')), 'ADDITIONAL_EXISTING_IMAGE_REQUIRED')
        for ref in credentials.values():initial.read_ref(ref)
        initial.read_ref(token_ref)
        return {'ownership':ownership,'operation':facts['operation'],'slot':facts['slot'],'credential_binding':binding,
                'volume_inventory':volumes,'volume_mode':'PRESERVE_EXISTING' if volumes['volumes'] else 'CREATE_EMPTY',
                'credential_refs':credentials,'administrator_token_ref':token_ref,'gcp_binding_ref':manual_binding(self.server,current,before),
                'compose_sha256':runtime.sha256(raw),'image_id':image[0]['Id']}


    def credentials_native(self, folder, capture, params):
        current,manifest,before=self.baseline(folder)
        require(str(current)==capture['current_release'] and before['source_sha']==capture['source_sha']
                and manifest==capture['package_manifest_sha256']
                and runtime.sha256(before['state_raw'])==capture['before_adoption_sha256']
                and runtime.sha256(before['plan_raw'])==capture['before_plan_sha256']
                and {k:runtime.sha256(v) for k,v in before['files'].items()}==capture['profile_sha256'],
                'ADDITIONAL_EXISTING_CAPTURE_CHANGED')
        prior=runtime._parse(initial.read_ref(capture['runtime_before_ref']))
        require(set(prior)=={'captured_at','services'} and prior['captured_at']==capture['captured_at'], 'ADDITIONAL_EXISTING_CAPTURE_CHANGED')
        runtime.compare_live_snapshot(prior['services'],before['services'])
        ownership=self.pilot.frozen_guard(current,before['workspace'])
        finished=self.backup(capture,before,current)
        facts=read_operation(self.server,current,params['operation_id'],before['workspace'])
        require(finished==initial.timestamp(capture['backup_finished_at']) and finished<=initial.timestamp(prior['captured_at'])
                <=initial.timestamp(facts['operation']['created_at']), 'ADDITIONAL_EXISTING_BACKUP_OPERATION_ORDER_REQUIRED')
        config=runtime._parse(initial.read_ref(params['administrator_config_ref']))
        require(type(config) is dict and set(config)=={'api_origin','token_file','release_env','gateway_dir','overlay'}, 'ADDITIONAL_EXISTING_ADMIN_CONFIG_REQUIRED')
        pilot_ref=initial.file_ref(before['release']['COMMERCE_PILOT_RELEASE_ENV'])
        pilot=native.env_values(initial.read_ref(pilot_ref))
        require(config['release_env']==str(self.private/'release.env') and config['gateway_dir']==pilot.get('COMMERCE_GATEWAY_CONFIG_DIR')
                and config['overlay']==str(self.private/'additional-gateways.json')
                and not Path(config['overlay']).exists() and not Path(config['overlay']).is_symlink(), 'ADDITIONAL_EXISTING_CONFIGURATION_CHANGED')
        review.private_directory(Path(config['gateway_dir']))
        target=Path(config['gateway_dir'])/'waha-03.env'
        require(not target.exists() and not target.is_symlink(), 'ADDITIONAL_EXISTING_CREDENTIAL_ALREADY_EXISTS')
        token_ref=initial.file_ref(config['token_file'])
        profile=profile_binding(self.server,current,facts['operation'],before['workspace'],before['source_sha'])
        initial.read_ref(token_ref)
        return {'source_sha':before['source_sha'],'current_release':str(current),'workspace':before['workspace'],
                'operation':facts['operation'],'slot':facts['slot'],'ownership':ownership,'profile':profile,
                'target':str(target),'administrator_token_ref':token_ref,'pilot_release_env_ref':pilot_ref,
                'gcp_binding_ref':manual_binding(self.server,current,before)}


def directory(adapter, review_id, create=False):
    initial.identity(review_id)
    base=review.private_directory(adapter.private/'additional-existing-gateway-reviews',create=create)
    return review.private_directory(base/review_id,create=create)


def capture(adapter, review_id, backup_ref_path, tools_ref_path):
    initial.identity(review_id)
    folder = directory(adapter,review_id,True)
    require(not (folder/'capture.json').exists(), 'PILOT_REVIEW_CAPTURE_EXISTS')
    backup, tools = initial.ref_file(backup_ref_path), initial.ref_file(tools_ref_path)
    with adapter.locked():
        first=adapter.capture_native(folder,backup,tools); second=adapter.capture_native(folder,backup,tools)
        initial.same_capture(first,second)
        prior = review.immutable(folder/'runtime-before.json',review.encoded({k:second[k] for k in ('captured_at','services')}))
        value={k:v for k,v in second.items() if k!='services'}
        value.update(schema_version=1,review_id=review_id,backup_before_provision_ref=backup,backup_tools_manifest_ref=tools,runtime_before_ref=prior)
        ref=review.immutable(folder/'capture.json',review.encoded(value))
    return {'status':'CAPTURED_OPERATION_REQUIRED','review_id':review_id,'source_sha':value['source_sha'],
            'capture_sha256':ref['sha256'],'services_observed':9,'approval_issued':False,'business_mutations':0}


def load_capture(folder, review_id):
    value=runtime._parse(review.read_private(folder/'capture.json'))
    require(value.get('schema_version')==1 and value.get('review_id')==review_id, 'PILOT_REVIEW_CAPTURE_INVALID')
    for name in ('backup_before_provision_ref','backup_tools_manifest_ref','runtime_before_ref'):initial.read_ref(value[name])
    return value


def approval_value(saved, params, facts, volume_ref):
    approval={key:saved[key] for key in ('source_sha','current_release','before_adoption_sha256','before_plan_sha256',
                  'backup_before_provision_ref','backup_tools_manifest_ref','runtime_before_ref')}
    approval.update(schema_version=1,target_slot=SLOT,**params,volume_inventory_ref=volume_ref,
                    gcp_binding_ref=facts['gcp_binding_ref'],credential_binding=facts['credential_binding'],
                    **{key:facts[key] for key in ('volume_mode','credential_refs','compose_sha256')})
    approval_guard(approval)
    return approval


def observe(adapter, review_id, run_id, operation_id, pilot_env, admin_config):
    require(re.fullmatch(r'[1-9][0-9]*-[1-9][0-9]*',run_id) and
            re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',operation_id), 'PILOT_REVIEW_OPERATION_IDENTITY')
    folder=directory(adapter,review_id); saved=load_capture(folder,review_id)
    require(not (folder/'observation.json').exists(), 'PILOT_REVIEW_OBSERVATION_EXISTS')
    params={'run_id':run_id,'operation_id':operation_id,'pilot_release_env_ref':initial.file_ref(pilot_env),
            'administrator_config_ref':initial.file_ref(admin_config)}
    with adapter.locked():
        params['new_release_env_ref']=initial.file_ref(adapter.private/'release.env')
        params['additional_overlay_ref']=adapter.candidate_overlay(folder,runtime._parse(initial.read_ref(params['administrator_config_ref'])))
        first=adapter.observe_native(folder,saved,params); second=adapter.observe_native(folder,saved,params)
        require(first==second,'PILOT_REVIEW_NATIVE_CHANGED')
        volume_ref=review.immutable(folder/'volume-inventory.json',review.encoded(second['volume_inventory']))
        approval=approval_value(saved,params,second,volume_ref)
        value={'schema_version':1,'review_id':review_id,'created_at_epoch':int(time.time()),
               'capture_ref':initial.file_ref(folder/'capture.json'),'params':params,'native':second,'approval':approval}
        ref=review.immutable(folder/'observation.json',review.encoded(value))
    return summary(value,ref,'OBSERVED_REVIEW_REQUIRED')


def summary(value, ref, status):
    approval=value['approval']
    return {'status':status,'review_id':value['review_id'],'observation_sha256':ref['sha256'],
            'source_sha':approval['source_sha'],'run_id':approval['run_id'],'operation_id':approval['operation_id'],
            'volume_mode':approval['volume_mode'],'services_observed':9,'gateway_created':False,'sessions_started':0}


def seal(adapter, review_id, observation_sha):
    require(runtime._hash(observation_sha),'PILOT_REVIEW_OBSERVATION_HASH_REQUIRED')
    folder=directory(adapter,review_id); raw=review.read_private(folder/'observation.json')
    require(runtime.sha256(raw)==observation_sha,'PILOT_REVIEW_OBSERVATION_HASH_CHANGED')
    value=runtime._parse(raw)
    require(set(value)=={'schema_version','review_id','created_at_epoch','capture_ref','params','native','approval'}
            and value['schema_version']==1 and value['review_id']==review_id,'PILOT_REVIEW_OBSERVATION_INVALID')
    saved=load_capture(folder,review_id)
    require(initial.read_ref(value['capture_ref'])==review.read_private(folder/'capture.json'),'PILOT_REVIEW_CAPTURE_CHANGED')
    ref=native.reference(folder/'observation.json',raw)
    with adapter.locked():
        receipt=folder/'seal.json'
        if receipt.exists() or receipt.is_symlink():
            sealed=runtime._parse(review.read_private(receipt))
            require(sealed['observation_ref']==ref,'PILOT_REVIEW_RECEIPT_CHANGED')
            initial.read_ref(sealed['approval_ref']); initial.read_ref(sealed['reference_file_ref'])
            return summary(value,ref,'SEALED_REPLAY_HISTORICAL')
        require(type(value['created_at_epoch']) is int and 0<=time.time()-value['created_at_epoch']<=review.MAX_AGE,
                'PILOT_REVIEW_OBSERVATION_EXPIRED')
        require(adapter.observe_native(folder,saved,value['params'])==value['native'],'PILOT_REVIEW_NATIVE_CHANGED')
        require(runtime._parse(initial.read_ref(value['approval']['volume_inventory_ref']))==value['native']['volume_inventory'],
                'PILOT_REVIEW_VOLUME_REFERENCE_CHANGED')
        require(approval_value(saved,value['params'],value['native'],value['approval']['volume_inventory_ref'])==value['approval'],
                'PILOT_REVIEW_APPROVAL_CHANGED')
        require(adapter.observe_native(folder,saved,value['params'])==value['native'],'PILOT_REVIEW_NATIVE_CHANGED')
        require(review.read_private(folder/'observation.json')==raw,'PILOT_REVIEW_OBSERVATION_CHANGED')
        approvals=review.private_directory(adapter.private/'controller-approvals',create=True)
        approved=review.immutable(approvals/('additional-existing-'+review_id+'.json'),review.encoded(value['approval']))
        reference=review.immutable(folder/'approval-ref.json',review.encoded(approved))
        review.immutable(receipt,review.encoded({'schema_version':1,'observation_ref':ref,'approval_ref':approved,'reference_file_ref':reference}))
    result=summary(value,ref,'SEALED'); result['approval_ref_file']=str(folder/'approval-ref.json')
    return result


def load_approval(ref_file):
    ref=runtime._parse(review.read_private(Path(ref_file)))
    value=runtime._parse(initial.read_ref(ref));approval_guard(value)
    require(Path(ref['path']).parent == review.PRIVATE/'controller-approvals', 'ADDITIONAL_EXISTING_APPROVAL_CUSTODY_REQUIRED')
    adapter=Native();current,source,_=adapter.package()
    require(value['current_release']==str(current) and value['source_sha']==source, 'ADDITIONAL_EXISTING_INSTALLED_PACKAGE_REQUIRED')
    return ref,value


class AdoptionNative(Native):
    def compare_native(self, before, after):
        runtime.compare_live_snapshot(before['services'], after['services'])
        self.server.compare_owner_auth(before['owner'], after['owner'])
        require({k: v for k, v in before.items() if k not in {'services', 'owner'}}
                == {k: v for k, v in after.items() if k not in {'services', 'owner'}}, 'PILOT_ADOPTION_NATIVE_CHANGED')

    def observe_native(self, folder, params):
        current, source, manifest_sha = self.package()
        initial.read_ref(params['pilot_approval_ref_file_ref'])
        approval_ref, approval = load_approval(params['pilot_approval_ref_file_ref']['path'])
        require(approval['source_sha'] == source and approval['run_id'] != params['run_id'], 'PILOT_ADOPTION_SOURCE_CHANGED')
        report_dir = self.private/'deployments'/params['run_id']
        require(not report_dir.exists() and not report_dir.is_symlink(), 'PILOT_ADOPTION_ATTEMPT_ALREADY_STARTED')
        journal_dir = self.private/'additional-existing-gateway'/approval['run_id']
        journals = {name: initial.file_ref(journal_dir/(name+'.json'))
                    for name in ('intent', 'prepared', 'start-intent', 'http-readback')}
        intent, prepared, started, http = [runtime._parse(initial.read_ref(journals[name]))
                    for name in ('intent', 'prepared', 'start-intent', 'http-readback')]
        state_raw = review.read_private(self.private/'api-web-adoption.json')
        plan_raw = review.read_private(self.private/'daily-b02/plan.json')
        state = runtime._parse(state_raw); runtime.validate_state(state); runtime.validate_plan(state, plan_raw)
        require(state['runtime_stage'] == 'OPERATING' and set(state['gateway_provisioning']) == {'waha-01'} and set(state['service_inventory']) == BASELINE
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
        services = self.pilot.read_services(current, state, SLOT)
        require(set(services) == BASELINE | {SERVICE}, 'PILOT_ADOPTION_SINGLE_GATEWAY_REQUIRED')
        self.pilot.gateway_guard(services[SERVICE], prepared['image'], SLOT)
        require(self.pilot.gateway_identity(services[SERVICE]) == self.pilot.gateway_identity(prepared['services'][SERVICE]),
                'PILOT_ADOPTION_PREPARED_GATEWAY_CHANGED')
        runtime.compare_live_snapshot({k: v for k, v in prepared['services'].items() if k != SERVICE},
                                      {k: v for k, v in services.items() if k != SERVICE})
        networks = self.pilot.network_guard(current, state, services, release, SLOT)
        volumes = self.pilot.volume_snapshot(current, SLOT)
        require(networks == prepared['networks'] and volumes == prepared['volumes'], 'PILOT_ADOPTION_STORAGE_OR_NETWORK_CHANGED')
        require(native.active_proxy_digest(self.server.command, current, services) == state['active_proxy_sha256'],
                'PILOT_ADOPTION_PROXY_CHANGED')
        runtime.verify_edge(self.server, current, state, services, release)
        config = runtime._parse(initial.read_ref(approval['administrator_config_ref']))
        for ref in approval['credential_refs'].values(): initial.read_ref(ref)
        agent = self.pilot.administrator.Administrator(config)
        agent.credentials(SLOT, create=False)
        http_now = agent.readback(SLOT)
        require(http_now == http['readback'], 'PILOT_ADOPTION_HTTP_READBACK_CHANGED')
        runtime.gateway_rendered_bindings(self.server, current, services, release)
        overlay_bytes = initial.read_ref(approval['additional_overlay_ref'])
        require(review.read_private(self.private/'additional-gateways.json') == overlay_bytes, 'ADDITIONAL_EXISTING_OVERLAY_CHANGED')
        initial.read_ref(approval['gcp_binding_ref'])
        overlay_ref = initial.file_ref(self.private/'additional-gateways.json')
        provisioning = {**state['gateway_provisioning'], SERVICE: {'operation_id': approval['operation_id'], 'slot': SLOT,
            'overlay_ref': overlay_ref, 'definition_sha256': runtime.definition_digest(services[SERVICE])}}
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
        require(runtime.gateway_continuity(before, services, candidate, owner, self.server, self.private) == {SERVICE},
                'PILOT_ADOPTION_GATEWAY_SET_CHANGED')
        runtime.verify_gateway_provisioning(self.server, current, candidate, services, workspace)
        query = ("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT json_build_object('operation',"
                 "(SELECT row_to_json(o) FROM number_operations o WHERE o.id="+runtime.sql_literal(approval['operation_id'])+"::uuid),"
                 "'slot',(SELECT row_to_json(s) FROM number_capacity_slots s WHERE s.operation_id="+
                 runtime.sql_literal(approval['operation_id'])+"::uuid AND s.slot=3),"
                 "'audit',(SELECT row_to_json(e) FROM domain_events e WHERE e.workspace_id="+runtime.sql_literal(workspace)+
                 " AND e.environment='REAL' AND e.aggregate_id="+runtime.sql_literal(approval['operation_id'])+
                 " AND e.event_type='capacity.admin_readback' AND e.payload->>'outcome'='VERIFIED' ORDER BY e.occurred_at DESC,e.id LIMIT 1)); ROLLBACK;")
        facts = runtime._parse(self.server.database(current, query).encode())
        adoption.journal_binding(approval_ref, approval, intent, prepared, started, http, services,
                        facts.get('operation'), facts.get('slot'), facts.get('audit'), dt.datetime.now(dt.timezone.utc), slot=SLOT)
        require(credential_binding(self.server,current,agent,facts['operation'],workspace,source)==approval['credential_binding'], 'ADDITIONAL_EXISTING_PRIVATE_BINDING_CHANGED')
        require(facts['operation']['workspace_id'] == workspace
                and initial.timestamp(ownership['hold_at']) > max(initial.timestamp(facts['audit']['occurred_at']),
                    initial.timestamp(facts['slot']['readback']['observed_at'])),
                'PILOT_ADOPTION_NEW_HOLD_REQUIRED')
        with runtime.reviewed_backup_module(approval['backup_tools_manifest_ref'], current, source) as tools:
            finished = runtime.prior_backup_guard(approval['backup_before_provision_ref'], before, tools)
        require(finished <= initial.timestamp(prior_runtime['captured_at']) <= initial.timestamp(facts['operation']['created_at']),
                'PILOT_ADOPTION_BACKUP_ORDER_REQUIRED')
        tool_refs = {name: native.reference(current/'scripts'/name, review.read_private(current/'scripts'/name, mode=None)) for name in review.TOOLS}
        manifest = adoption.tools_manifest(source, runtime.sha256(state_raw), runtime.sha256(plan_raw), tool_refs)
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


def adoption_directory(adapter, review_id, create=False):
    initial.identity(review_id)
    base = review.private_directory(adapter.private/'additional-existing-adoption-reviews', create=create)
    return review.private_directory(base/review_id, create=create)


def adoption_approval_value(facts, run_id, ownership_ref, tools_ref):
    keys = adoption.FIELDS-{'schema_version', 'run_id', 'ownership_observation_ref', 'backup_tools_manifest_ref'}
    value = {key: facts[key] for key in keys}
    return dict(value, schema_version=1, run_id=run_id, ownership_observation_ref=ownership_ref, backup_tools_manifest_ref=tools_ref)


def adoption_summary(value, ref, status):
    return {'status': status, 'review_id': value['review_id'], 'observation_sha256': ref['sha256'],
            'source_sha': value['native']['source_sha'], 'run_id': value['params']['run_id'],
            'gateways_observed': 2, 'sessions_observed': 0, 'adoption_executed': False, 'backup_executed': False,
            'business_mutations': 0, 'source_isolation_issued': False}


def adoption_observe(adapter, review_id, run_id, pilot_ref_file):
    require(type(run_id) is str and re.fullmatch(r'[1-9][0-9]*-[1-9][0-9]*', run_id), 'PILOT_ADOPTION_RUN_ID_REQUIRED')
    folder = adoption_directory(adapter, review_id, True)
    require(not (folder/'observation.json').exists(), 'PILOT_ADOPTION_OBSERVATION_EXISTS')
    params = {'run_id': run_id, 'pilot_approval_ref_file_ref': initial.file_ref(pilot_ref_file)}
    with adapter.locked():
        first = adapter.observe_native(folder, params); second = adapter.observe_native(folder, params)
        adapter.compare_native(first, second)
        ownership_ref = review.immutable(folder/'ownership.json', review.encoded(second['ownership']))
        tools_path = adapter.private/'controller-approvals'/('additional-existing-adoption-'+review_id+'-tools.json')
        tools_ref = native.reference(tools_path, review.encoded(second['tools_manifest']))
        approval = adoption_approval_value(second, run_id, ownership_ref, tools_ref)
        value = {'schema_version': 1, 'review_id': review_id, 'created_at_epoch': int(time.time()),
                 'params': params, 'native': second, 'approval': approval}
        ref = review.immutable(folder/'observation.json', review.encoded(value))
    return adoption_summary(value, ref, 'OBSERVED_REVIEW_REQUIRED')


def adoption_seal(adapter, review_id, observation_sha):
    require(runtime._hash(observation_sha), 'PILOT_ADOPTION_OBSERVATION_HASH_REQUIRED')
    folder = adoption_directory(adapter, review_id); raw = review.read_private(folder/'observation.json')
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
            return adoption_summary(value, ref, 'SEALED_REPLAY_HISTORICAL')
        require(type(value['created_at_epoch']) is int and 0 <= time.time()-value['created_at_epoch'] <= review.MAX_AGE,
                'PILOT_ADOPTION_OBSERVATION_EXPIRED')
        current = adapter.observe_native(folder, value['params'])
        adapter.compare_native(value['native'], current)
        ownership_ref = value['approval']['ownership_observation_ref']
        require(runtime._parse(initial.read_ref(ownership_ref)) == current['ownership'], 'PILOT_ADOPTION_OWNERSHIP_REFERENCE_CHANGED')
        approvals = review.private_directory(adapter.private/'controller-approvals', create=True)
        tools_path = approvals/('additional-existing-adoption-'+review_id+'-tools.json')
        tools_raw = review.encoded(current['tools_manifest']); tools_ref = native.reference(tools_path, tools_raw)
        require(adoption_approval_value(current, value['params']['run_id'], ownership_ref, tools_ref) == value['approval'],
                'PILOT_ADOPTION_APPROVAL_CHANGED')
        adapter.compare_native(current, adapter.observe_native(folder, value['params']))
        require(review.read_private(folder/'observation.json') == raw, 'PILOT_ADOPTION_OBSERVATION_CHANGED')
        actual_tools = review.immutable(tools_path, tools_raw)
        require(actual_tools == tools_ref, 'PILOT_ADOPTION_TOOL_REFERENCE_CHANGED')
        approved = review.immutable(approvals/('additional-existing-adoption-'+review_id+'.json'), review.encoded(value['approval']))
        reference = review.immutable(folder/'approval-ref.json', review.encoded(approved))
        review.immutable(receipt, review.encoded({'schema_version': 1, 'observation_ref': ref, 'approval_ref': approved,
                                                'tools_ref': tools_ref, 'reference_file_ref': reference}))
    result = adoption_summary(value, ref, 'SEALED'); result['approval_ref_file'] = str(folder/'approval-ref.json')
    return result


CREDENTIAL_APPROVAL_FIELDS={'schema_version','kind','review_id','capture_ref','params','native'}


def credentials_observe(adapter, review_id, operation_id, administrator_config):
    require(type(operation_id) is str and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',operation_id), 'ADDITIONAL_EXISTING_OPERATION_REQUIRED')
    folder=directory(adapter,review_id);capture=load_capture(folder,review_id)
    params={'operation_id':operation_id,'administrator_config_ref':initial.file_ref(administrator_config)}
    require(not (folder/'credentials-observation.json').exists(), 'ADDITIONAL_EXISTING_CREDENTIAL_OBSERVATION_EXISTS')
    with adapter.locked():
        first=adapter.credentials_native(folder,capture,params);second=adapter.credentials_native(folder,capture,params)
        require(first==second,'ADDITIONAL_EXISTING_CREDENTIAL_OBSERVATION_CHANGED')
        value={'schema_version':1,'kind':'ADDITIONAL_EXISTING_CREDENTIALS','review_id':review_id,
               'capture_ref':initial.file_ref(folder/'capture.json'),'params':params,'native':second}
        observation={'created_at_epoch':int(time.time()),'approval':value}
        ref=review.immutable(folder/'credentials-observation.json',review.encoded(observation))
    return {'status':'OBSERVED_REVIEW_REQUIRED','review_id':review_id,'observation_sha256':ref['sha256'],
            'source_sha':second['source_sha'],'profile_version':second['profile']['profile_version'],
            'credentials_written':False,'credentials_generated':False}


def credentials_seal(adapter, review_id, observation_sha):
    require(runtime._hash(observation_sha),'ADDITIONAL_EXISTING_OBSERVATION_HASH_REQUIRED')
    folder=directory(adapter,review_id);raw=review.read_private(folder/'credentials-observation.json')
    require(runtime.sha256(raw)==observation_sha,'ADDITIONAL_EXISTING_OBSERVATION_HASH_CHANGED')
    observed=runtime._parse(raw);value=observed['approval']
    require(set(observed)=={'created_at_epoch','approval'} and set(value)==CREDENTIAL_APPROVAL_FIELDS
            and value['schema_version']==1 and value['kind']=='ADDITIONAL_EXISTING_CREDENTIALS'
            and value['review_id']==review_id,'ADDITIONAL_EXISTING_CREDENTIAL_APPROVAL_REQUIRED')
    capture=load_capture(folder,review_id)
    require(initial.read_ref(value['capture_ref'])==review.read_private(folder/'capture.json'),'ADDITIONAL_EXISTING_CAPTURE_CHANGED')
    observation_ref=native.reference(folder/'credentials-observation.json',raw)
    with adapter.locked():
        receipt=folder/'credentials-seal.json'
        if receipt.exists() or receipt.is_symlink():
            saved=runtime._parse(review.read_private(receipt))
            require(saved['observation_ref']==observation_ref,'ADDITIONAL_EXISTING_CREDENTIAL_SEAL_CHANGED')
            initial.read_ref(saved['approval_ref']);initial.read_ref(saved['reference_file_ref'])
            return {'status':'SEALED_REPLAY_HISTORICAL','approval_ref_file':str(folder/'credentials-approval-ref.json')}
        require(type(observed['created_at_epoch']) is int and 0<=time.time()-observed['created_at_epoch']<=review.MAX_AGE,'ADDITIONAL_EXISTING_OBSERVATION_EXPIRED')
        for _ in range(2):
            require(adapter.credentials_native(folder,capture,value['params'])==value['native'],'ADDITIONAL_EXISTING_CREDENTIAL_OBSERVATION_CHANGED')
        require(review.read_private(folder/'credentials-observation.json')==raw,'ADDITIONAL_EXISTING_OBSERVATION_CHANGED')
        approvals=review.private_directory(adapter.private/'controller-approvals',create=True)
        approved=review.immutable(approvals/('additional-existing-credentials-'+review_id+'.json'),review.encoded(value))
        reference=review.immutable(folder/'credentials-approval-ref.json',review.encoded(approved))
        review.immutable(receipt,review.encoded({'observation_ref':observation_ref,'approval_ref':approved,'reference_file_ref':reference}))
    return {'status':'SEALED','approval_ref_file':str(folder/'credentials-approval-ref.json'),'credentials_written':False,'credentials_generated':False}
