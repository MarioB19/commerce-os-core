#!/usr/bin/env python3
"""Actuate the explicitly sealed existing slot 3; never start a WhatsApp session.

prepare creates one stopped server. start is single-dispatch. complete-http is
read-only reconciliation of a delayed server response, never a second start.
Adoption and API administration are separate canonical operations.
"""
import datetime as dt
import json
import importlib.util
import os
from pathlib import Path
import re
import sys
import time

import additional_existing_gateway as approved
from ci_release import ReleaseError, require

runtime,native,review,initial=approved.runtime,approved.native,approved.review,approved.initial
# Pure guards keep their initial-pilot defaults. This controller always passes 3.
spec=importlib.util.spec_from_file_location('additional_initial',Path(__file__).with_name('initial-pilot-root.py'))
pilot=importlib.util.module_from_spec(spec);spec.loader.exec_module(pilot)
server=pilot.server
ROOT=Path(__file__).resolve().parent.parent
SLOT,SERVICE,NETWORK=approved.SLOT,approved.SERVICE,approved.NETWORK


def fsync_directory(path):
    fd=os.open(path,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)


def write_new(path,raw):
    ref=pilot.write_new(path,raw)
    fd=os.open(path.parent,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)
    return ref


def materialize_credentials(ref_file):
    """One sealed profile -> one previously absent private file; no rotation."""
    require(os.geteuid()==0 and sys.platform=='linux','ADDITIONAL_EXISTING_LINUX_ROOT_REQUIRED')
    adapter=approved.Native();ref=approved.initial.ref_file(ref_file)
    value=runtime._parse(approved.initial.read_ref(ref))
    require(set(value)==approved.CREDENTIAL_APPROVAL_FIELDS and value['schema_version']==1
            and value['kind']=='ADDITIONAL_EXISTING_CREDENTIALS'
            and Path(ref['path']).parent==adapter.private/'controller-approvals', 'ADDITIONAL_EXISTING_CREDENTIAL_APPROVAL_REQUIRED')
    approved.initial.identity(value['review_id'])
    folder=approved.directory(adapter,value['review_id']);capture=approved.load_capture(folder,value['review_id'])
    require(approved.initial.read_ref(value['capture_ref'])==review.read_private(folder/'capture.json'),'ADDITIONAL_EXISTING_CAPTURE_CHANGED')
    directory=adapter.private/'additional-existing-credentials'/value['review_id']
    exported=None;raw=None
    with runtime.deadline_fuse(time.monotonic()+300),adapter.locked():
        facts=adapter.credentials_native(folder,capture,value['params'])
        require(facts==value['native'],'ADDITIONAL_EXISTING_CREDENTIAL_OBSERVATION_CHANGED')
        require(not directory.exists() and not directory.is_symlink(),'ADDITIONAL_EXISTING_CREDENTIAL_MATERIALIZATION_STARTED')
        review.private_directory(directory.parent,create=True);fsync_directory(adapter.private)
        review.private_directory(directory,create=True);fsync_directory(directory.parent)
        write_new(directory/'intent.json',runtime.sealed_bytes({'approval_ref':ref,'target':facts['target'],'profile_version':facts['profile']['profile_version']}))
        try:
            current=Path(facts['current_release'])
            exported=approved.profile_binding(adapter.server,current,facts['operation'],facts['workspace'],facts['source_sha'],export=True)
            require({k:v for k,v in exported.items() if k!='credential_env'}==facts['profile'],'ADDITIONAL_EXISTING_CREDENTIAL_OBSERVATION_CHANGED')
            raw=bytearray(exported['credential_env'].encode('ascii'))
            require(0<len(raw)<=2048 and re.fullmatch(rb'WAHA_API_KEY=[A-Za-z0-9._~:/+!=@%\-]{1,512}\nWHATSAPP_HOOK_HMAC_KEY=[A-Za-z0-9._~:/+!=@%\-]{1,512}\n',raw), 'ADDITIONAL_EXISTING_CREDENTIAL_FORMAT_REQUIRED')
            require(not native.env_values(bytes(raw))['WAHA_API_KEY'].startswith('sha512:'), 'ADDITIONAL_EXISTING_PLAINTEXT_CREDENTIAL_REQUIRED')
            # Repeat the full read-only guards after export and before O_EXCL.
            require(adapter.credentials_native(folder,capture,value['params'])==facts,'ADDITIONAL_EXISTING_CREDENTIAL_OBSERVATION_CHANGED')
            target=Path(facts['target']);file_ref=write_new(target,bytes(raw))
            config=runtime._parse(approved.initial.read_ref(value['params']['administrator_config_ref']))
            agent=adapter.pilot.administrator.Administrator(config)
            approved.profile_matches_credential(facts['profile'],approved.credential_binding(adapter.server,current,agent,facts['operation'],facts['workspace'],facts['source_sha']))
            write_new(directory/'materialized.json',runtime.sealed_bytes({'approval_ref':ref,'credential_ref':file_ref,'profile':facts['profile'],'generated':False,'rotated':False}))
            return {'status':'EXISTING_CREDENTIAL_MATERIALIZED','slot':SLOT,'profile_version':facts['profile']['profile_version'],
                    'credentials_written':1,'credentials_generated':False,'credentials_rotated':False,'containers_created':0}
        finally:
            if raw is not None:raw[:]=b'\0'*len(raw)
            if exported is not None:exported['credential_env']=''


def journal_guard(ref,approval,intent,prepared,ownership,new_env,overlay):
    require(type(intent) is dict and set(intent)=={'approval_ref','ownership','previous_release_env_ref','runtime_before_ref'}
            and type(prepared) is dict and set(prepared)=={'approval_ref','services','image','volumes','networks'}
            and intent['approval_ref']==prepared['approval_ref']==ref and intent['ownership']==ownership
            and intent['runtime_before_ref']==approval['runtime_before_ref']
            and native.protected_bytes(server.PRIVATE/'release.env')==new_env
            and native.protected_bytes(server.PRIVATE/'additional-gateways.json')==overlay,
            'ADDITIONAL_EXISTING_PREPARED_BINDING_CHANGED')


def execute(action,ref_file):
    require(os.geteuid()==0 and sys.platform=='linux', 'ADDITIONAL_EXISTING_LINUX_ROOT_REQUIRED')
    require(action in {'prepare','start','readback','complete-http'}, 'ADDITIONAL_EXISTING_ACTION_REQUIRED')
    ref,approval=approved.load_approval(ref_file);current=ROOT
    directory=server.PRIVATE/'additional-existing-gateway'/approval['run_id'];locks=[]
    try:
        with runtime.deadline_fuse(time.monotonic()+300):
            locks=native.acquire_locks(server.PRIVATE)
            state_raw=native.protected_bytes(server.PRIVATE/'api-web-adoption.json')
            plan_raw=native.protected_bytes(server.PRIVATE/'daily-b02/plan.json')
            require(runtime.sha256(state_raw)==approval['before_adoption_sha256'] and runtime.sha256(plan_raw)==approval['before_plan_sha256'], 'ADDITIONAL_EXISTING_BASELINE_CAS_CHANGED')
            state=runtime._parse(state_raw);runtime.validate_state(state);runtime.validate_plan(state,plan_raw)
            require(state['runtime_stage']=='OPERATING' and set(state['gateway_provisioning'])=={'waha-01'}
                    and set(state['service_inventory'])==approved.BASELINE, 'ADDITIONAL_EXISTING_NINE_SERVICE_BASELINE_REQUIRED')
            config=runtime._parse(native.read_reference(approval['administrator_config_ref']))
            pilot_values=native.env_values(native.read_reference(approval['pilot_release_env_ref']))
            require(type(config) is dict and set(config)=={'api_origin','token_file','release_env','gateway_dir','overlay'}
                    and config['release_env']==str(server.PRIVATE/'release.env') and config['gateway_dir']==pilot_values.get('COMMERCE_GATEWAY_CONFIG_DIR')
                    and config['overlay']==str(server.PRIVATE/'additional-gateways.json'), 'ADDITIONAL_EXISTING_CONFIGURATION_CHANGED')
            for name,credential_ref in approval['credential_refs'].items():
                runtime.reference(credential_ref,str(Path(config['gateway_dir'])/name));native.read_reference(credential_ref)
            new_env=native.read_reference(approval['new_release_env_ref'])
            require(native.protected_bytes(server.PRIVATE/'release.env')==new_env
                    and native.env_values(new_env).get('COMMERCE_PILOT_RELEASE_ENV')==approval['pilot_release_env_ref']['path'], 'ADDITIONAL_EXISTING_RELEASE_ENV_CHANGED')
            overlay=native.read_reference(approval['additional_overlay_ref'])
            require(runtime._parse(overlay)==pilot.administrator.helper.overlay(['03'],config['gateway_dir']), 'ADDITIONAL_EXISTING_OVERLAY_CHANGED')
            native.read_reference(approval['gcp_binding_ref'])
            require(runtime._parse(plan_raw).get('schedule_enabled') is False, 'ADDITIONAL_EXISTING_MANUAL_BACKUP_REQUIRED')
            agent=pilot.administrator.Administrator(config)
            operation=approved.read_operation(server,current,approval['operation_id'],state['owner_workspace_id'])['operation']
            require(approved.credential_binding(server,current,agent,operation,state['owner_workspace_id'],approval['source_sha'])==approval['credential_binding'], 'ADDITIONAL_EXISTING_PRIVATE_BINDING_CHANGED')
            ownership=pilot.frozen_guard(current,state['owner_workspace_id'])
            volume_before=runtime._parse(native.read_reference(approval['volume_inventory_ref']))
            observed_volumes=pilot.volume_snapshot(current,SLOT)
            if action=='prepare':
                require(not directory.exists() and not directory.is_symlink()
                        and not Path(config['overlay']).exists() and not Path(config['overlay']).is_symlink(), 'ADDITIONAL_EXISTING_PREPARATION_ALREADY_STARTED')
                require(observed_volumes==volume_before and (bool(volume_before['volumes']) if approval['volume_mode']=='PRESERVE_EXISTING' else not volume_before['volumes']), 'ADDITIONAL_EXISTING_VOLUME_INVENTORY_CHANGED')
                before=runtime.snapshot(server,server.PRIVATE,current,directory);before['source_sha']=approval['source_sha']
                approved.baseline_guard(before)
                require(approved.manual_binding(server,current,before)==approval['gcp_binding_ref'], 'ADDITIONAL_EXISTING_GCP_BINDING_CHANGED')
                captured=runtime._parse(native.read_reference(approval['runtime_before_ref']))
                require(set(captured)=={'captured_at','services'}, 'ADDITIONAL_EXISTING_CAPTURE_REQUIRED')
                runtime.compare_live_snapshot(captured['services'],before['services'])
                with runtime.reviewed_backup_module(approval['backup_tools_manifest_ref'],current,approval['source_sha']) as tools:
                    finished=runtime.prior_backup_guard(approval['backup_before_provision_ref'],before,tools)
                require(finished<=initial.timestamp(captured['captured_at'])<=initial.timestamp(operation['created_at'])<=dt.datetime.now(dt.timezone.utc), 'ADDITIONAL_EXISTING_BACKUP_OPERATION_ORDER_REQUIRED')
                candidate=server.command(['sh',str(current/'scripts/compose-release.sh'),str(server.PRIVATE/'release.env'),'-f',approval['additional_overlay_ref']['path'],'config','--format','json'],current).encode()
                require(runtime.sha256(candidate)==approval['compose_sha256'], 'ADDITIONAL_EXISTING_REVIEWED_COMPOSE_CHANGED')
                pinned=re.search(r'^    image: (.+)$',(current/'infra/compose/pilot.yaml').read_text(),re.M).group(1)
                pilot.rendered_guard(candidate,pinned,SLOT)
                image=runtime._parse(server.command(['docker','image','inspect',pinned],current).encode())[0]['Id']
                review.private_directory(directory.parent,create=True);fsync_directory(server.PRIVATE)
                review.private_directory(directory,create=True);fsync_directory(directory.parent)
                old_ref=write_new(directory/'previous-release.env',before['files']['release.env'])
                write_new(directory/'intent.json',runtime.sealed_bytes({'approval_ref':ref,'ownership':ownership,'previous_release_env_ref':old_ref,'runtime_before_ref':approval['runtime_before_ref']}))
                write_new(Path(config['overlay']),overlay)
                require(pilot.administrator.helper.validate(config['overlay'],config['gateway_dir'])==['03'], 'ADDITIONAL_EXISTING_OVERLAY_CHANGED')
                actual=agent.compose('config','--format','json').encode()
                require(runtime._parse(actual)==runtime._parse(candidate), 'ADDITIONAL_EXISTING_INSTALLED_COMPOSE_CHANGED')
                agent.compose('create','--no-build','--no-recreate','--pull','never',SERVICE)
                gateway=agent.snapshot(SLOT);pilot.gateway_guard(gateway,image,SLOT)
                require(gateway['State']['Running'] is False and gateway['State']['Pid']==0 and gateway['State']['Status']=='created', 'ADDITIONAL_EXISTING_CREATED_REQUIRED')
                for name in ('channel-worker','ingress'):
                    # Match Compose's service/name aliases so a later release has
                    # no application-boundary drift to normalize or waive.
                    aliases=sorted({name,before['services'][name]['Name'].removeprefix('/')})
                    args=['docker','network','connect']
                    for alias in aliases:args.extend(['--alias',alias])
                    server.command([*args,NETWORK,before['services'][name]['Id']],current)
                after=pilot.read_services(current,state,SLOT);pilot.preserved(before['services'],after,SLOT)
                runtime.gateway_rendered_bindings(server,current,after,native.env_values(new_env))
                networks=pilot.network_guard(current,state,after,native.env_values(new_env),SLOT)
                volumes=pilot.volume_snapshot(current,SLOT)
                require(set(volumes['names'])==set(volume_before['names'])|set(pilot.gateway_volumes(SLOT)), 'ADDITIONAL_EXISTING_UNEXPECTED_VOLUME_CREATED')
                if approval['volume_mode']=='PRESERVE_EXISTING':require(volumes==volume_before,'ADDITIONAL_EXISTING_VOLUMES_CHANGED')
                else:pilot.empty_owned_volumes(volumes['volumes'],SLOT)
                require(pilot.frozen_guard(current,state['owner_workspace_id'])==ownership, 'ADDITIONAL_EXISTING_OWNERSHIP_CHANGED')
                for credential_ref in approval['credential_refs'].values():native.read_reference(credential_ref)
                write_new(directory/'prepared.json',runtime.sealed_bytes({'approval_ref':ref,'services':after,'image':image,'volumes':volumes,'networks':networks}))
                return {'status':'PREPARED_STOPPED','slot':SLOT,'containers_created':1,'servers_started':0,'adopted':False,'sessions_started':0}
            intent=runtime._parse(native.protected_bytes(directory/'intent.json'))
            prepared=runtime._parse(native.protected_bytes(directory/'prepared.json'))
            journal_guard(ref,approval,intent,prepared,ownership,new_env,overlay)
            require(observed_volumes==prepared['volumes'], 'ADDITIONAL_EXISTING_VOLUMES_CHANGED')
            services=pilot.read_services(current,state,SLOT)
            pilot.gateway_guard(services[SERVICE],prepared['image'],SLOT)
            runtime.gateway_rendered_bindings(server,current,services,native.env_values(new_env))
            require(pilot.gateway_identity(services[SERVICE])==pilot.gateway_identity(prepared['services'][SERVICE])
                    and pilot.network_guard(current,state,services,native.env_values(new_env),SLOT)==prepared['networks'], 'ADDITIONAL_EXISTING_GATEWAY_CHANGED')
            runtime.compare_live_snapshot({k:v for k,v in prepared['services'].items() if k!=SERVICE},{k:v for k,v in services.items() if k!=SERVICE})
            if action=='start':
                require(not (directory/'start-intent.json').exists() and not (directory/'start-intent.json').is_symlink()
                        and services[SERVICE]['State']['Status']=='created' and services[SERVICE]['State']['Running'] is False
                        and runtime.live_projection(services[SERVICE])==runtime.live_projection(prepared['services'][SERVICE]), 'ADDITIONAL_EXISTING_START_REQUIRES_READBACK')
                write_new(directory/'start-intent.json',runtime.sealed_bytes({'approval_ref':ref,'container_id':services[SERVICE]['Id'],'requested_at':dt.datetime.now(dt.timezone.utc).isoformat()}))
                server.command(['docker','start',services[SERVICE]['Id']],current)
            started=runtime._parse(native.protected_bytes(directory/'start-intent.json'))
            require(type(started) is dict and set(started)=={'approval_ref','container_id','requested_at'}
                    and started['approval_ref']==ref and started['container_id']==services[SERVICE]['Id']
                    and initial.timestamp(operation['created_at'])<=initial.timestamp(started['requested_at']), 'ADDITIONAL_EXISTING_START_BINDING_CHANGED')
            if action=='complete-http':
                require(not (directory/'http-readback.json').exists() and not (directory/'http-readback.json').is_symlink(), 'ADDITIONAL_EXISTING_HTTP_ALREADY_RECORDED')
            reads=[]
            for _ in range(2 if action=='complete-http' else 1):
                readback=agent.readback(SLOT)
                require(readback.get('running') is True and type(readback.get('session_count')) is int and readback['session_count']==0
                        and type(readback.get('connected_sessions')) is int and readback['connected_sessions']==0, 'ADDITIONAL_EXISTING_ZERO_SESSIONS_REQUIRED')
                reads.append({'observed_at':dt.datetime.now(dt.timezone.utc).isoformat(),'readback':readback})
            require(all(item['readback']==reads[0]['readback'] for item in reads), 'ADDITIONAL_EXISTING_HTTP_CHANGED')
            after=pilot.read_services(current,state,SLOT);pilot.gateway_guard(after[SERVICE],prepared['image'],SLOT)
            require(after[SERVICE]['State']['Running'] is True and after[SERVICE]['RestartCount']==0
                    and initial.timestamp(started['requested_at'])<=initial.timestamp(after[SERVICE]['State']['StartedAt'])<=initial.timestamp(reads[0]['observed_at'])
                    and pilot.gateway_identity(after[SERVICE])==pilot.gateway_identity(prepared['services'][SERVICE])
                    and pilot.network_guard(current,state,after,native.env_values(new_env),SLOT)==prepared['networks'], 'ADDITIONAL_EXISTING_GATEWAY_CHANGED')
            runtime.compare_live_snapshot({k:v for k,v in prepared['services'].items() if k!=SERVICE},{k:v for k,v in after.items() if k!=SERVICE})
            require(pilot.frozen_guard(current,state['owner_workspace_id'])==ownership, 'ADDITIONAL_EXISTING_OWNERSHIP_CHANGED')
            for credential_ref in approval['credential_refs'].values():native.read_reference(credential_ref)
            if action=='complete-http':
                write_new(directory/'http-completion.json',runtime.sealed_bytes({'start_intent_ref':initial.file_ref(directory/'start-intent.json'),'prepared_ref':initial.file_ref(directory/'prepared.json'),'reads':reads,'container_id':after[SERVICE]['Id'],'docker_mutations':0}))
            if action in {'start','complete-http'}:
                write_new(directory/'http-readback.json',runtime.sealed_bytes({'observed_at':reads[-1]['observed_at'],'container_id':after[SERVICE]['Id'],'readback':readback}))
            return {'status':'HTTP_VERIFIED_ADOPTION_REQUIRED','slot':SLOT,'readback':readback,'adopted':False,'hold_released':False,'sessions_started':0,'new_backup_required':True,'new_restore_required':True}
    finally:
        for stream in reversed(locks):stream.close()


if __name__=='__main__':
    try:
        require(len(sys.argv)==3,'ADDITIONAL_EXISTING_ACTION_AND_REFERENCE_REQUIRED')
        result=materialize_credentials(sys.argv[2]) if sys.argv[1]=='materialize-credentials' else execute(sys.argv[1],sys.argv[2])
        print(json.dumps(result,sort_keys=True))
    except (Exception,KeyboardInterrupt) as error:
        code=str(error) if isinstance(error,ReleaseError) and re.fullmatch(r'[A-Z0-9_]{1,100}',str(error)) else type(error).__name__
        print(json.dumps({'status':'FAILED_RECONCILIATION_REQUIRED','error':code}),file=sys.stderr)
        raise SystemExit(1)
