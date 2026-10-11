"""Synthetic contract regressions only; no installed/cloud/physical evidence."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest

sys.path[:0] = [str(Path(__file__).resolve().parents[2]/'scripts')]
import copy_runtime_deployment as contract
from ci_release import ReleaseError
import importlib.util
spec = importlib.util.spec_from_file_location('copy_contract_vps', Path(__file__).resolve().parents[2]/'scripts/deploy-ci-vps.py')
vps = importlib.util.module_from_spec(spec); sys.modules[spec.name] = vps; spec.loader.exec_module(vps)
compare_owner_auth = vps.compare_owner_auth


def checksum(index):
    return format(index, '064x')


def ref(path, raw=b'public synthetic bytes'):
    return {'path': path, 'bytes': len(raw), 'sha256': contract.sha256(raw)}


def owner():
    return {'clock_utc': '2026-10-08T06:00:00Z', 'read_only': 'on',
        'sessions': [{'id':'synthetic-session','user_id':'synthetic-owner',
            'created_at':'2026-10-08T01:00:00Z','updated_at':'2026-10-08T01:00:00Z',
            'expires_at':'2026-10-08T13:00:00Z','unexpired':True}],
        'tokens':[{'id':'synthetic-pat','user_id':'synthetic-owner','workspace_id':'synthetic-workspace',
            'allowed_environments':['REAL','SIMULATION'],'version':1,'created_at':'2026-10-07T01:00:00Z',
            'expires_at':'2026-11-07T01:00:00Z','revoked_at':None,'unexpired':True}],
        'memberships':[{'user_id':'synthetic-owner','workspace_id':'synthetic-workspace','role':'owner','active':True}]}


def fixture(gateways=0):
    portal = {'container_id':checksum(5),'image':'sha256:'+checksum(105),
        'source_sha':'a'*40,'run_id':'100-1','proxy_network':'synthetic-proxy',
        'report_ref':ref('/opt/mcl-portal/current.json'),
        'runtime_env_ref':ref('/opt/mcl-portal/releases/100-1/runtime.env'),
        'manifest_ref':ref('/opt/commerce-os/releases/portal-synthetic/portal-manifest.json')}
    names = ['api','web','postgres','caddy','portal','ingress','automation-worker','channel-worker']
    names += ['waha-'+str(i).zfill(2) for i in range(1,gateways+1)]
    rows=[]
    for index, name in enumerate(names, 1):
        labels = {'com.docker.compose.project':'commerce-os','com.docker.compose.service':name}
        if name=='caddy': labels={}
        if name=='portal': labels={'com.inovaris.product':'mi-ciclo-listo-portal','com.inovaris.source-sha':'a'*40}
        network = 'synthetic-proxy' if name=='portal' else 'synthetic-core'
        env=[]
        if name.startswith('waha-'):
            env=['WHATSAPP_DEFAULT_ENGINE=GOWS','WAHA_PRINT_QR=false','WAHA_DASHBOARD_ENABLED=false',
                'WHATSAPP_SWAGGER_ENABLED=false','WHATSAPP_RESTART_ALL_SESSIONS=false',
                'WAHA_WORKER_RESTART_SESSIONS=false','WHATSAPP_START_SESSION=','WAHA_APPS_ENABLED=false']
        running=not name.startswith('waha-')
        rows.append({'Id':checksum(index),'Image':'sha256:'+checksum(index+100),
            'Name':'/mcl-portal-100-1' if name=='portal' else '/synthetic-'+name,
            'Config':{'Labels':labels,'Env':env,'Cmd':['synthetic-command']},
            'HostConfig':{'RestartPolicy':{'Name':'no' if name.startswith('waha-') else 'unless-stopped'},'PortBindings':{}},
            'Mounts':[],'NetworkSettings':{'Networks':{network:{'NetworkID':checksum(500),
                'EndpointID':checksum(index+600),'IPAddress':'192.0.2.'+str(index),'Aliases':[name],'GwPriority':0}}},
            'State':{'Running':running,'Paused':False,'Restarting':False,'Pid':index+1000 if running else 0,
                'StartedAt':'2026-10-08T05:00:00Z'}})
    state={'schema_version':3,'status':'ADOPTED_COPY_RUNTIME','scope':'copy-runtime','runtime_stage':'OPERATING',
        'backup_source_sha':contract.SOURCE_SHA,'current_release':'/opt/commerce-os/releases/runtime-synthetic',
        'smtp_transition_ref':ref('/opt/commerce-os/private/smtp-synthetic.json'),
        'canonical_files':{name:ref('/opt/commerce-os/private/'+name) for name in contract.FILES},
        'preserved_runtime':{row['Id']:contract.definition_digest(row) for row in rows},
        'network_baseline':{'synthetic-core':{},'synthetic-proxy':{},'synthetic-edge':{}},
        'active_proxy_sha256':checksum(800),'caddy_config_ref':ref('/opt/commerce-os/private/caddy-synthetic'),
        'policy_version':98,'firewall_rule_count':9,'portal':portal,
        'runtime_projection_version':2,'service_inventory':{name:row['Id'] for name,row in zip(names,rows)},
        'owner_workspace_id':'synthetic-workspace','policy_body_sha256':checksum(900),
        'last_release_receipt_ref':ref('/opt/commerce-os/private/deployments/101-1/report.json'),
        'consumer_edge_ref':ref('/opt/commerce-os/private/deployments/101-1/consumer-edge.json'),
        'gateway_provisioning':{name:{'operation_id':'00000000-0000-0000-0000-'+str(i).zfill(12),
            'slot':i,'overlay_ref':ref('/opt/commerce-os/private/gateway-synthetic/'+name+'.json'),
            'definition_sha256':contract.definition_digest(rows[names.index(name)])}
            for i,name in enumerate(names[8:],1)}}
    plan={'schema_version':3,'runtime_stage':state['runtime_stage'],'preserved_runtime':state['preserved_runtime'],'runtime_projection_version':2,
          'source_sha':contract.SOURCE_SHA,'native_fields':'must be checked by the real B02 validator'}
    raw=contract.sealed_bytes(plan)
    state['b02_plan_ref']=ref('/opt/commerce-os/private/daily-b02/plan.json',raw)
    state['b02_plan_sha256']=state['b02_plan_ref']['sha256']
    return state,rows,raw


def refresh(state,rows):
    state['service_inventory']={name:row['Id'] for name,row in zip(state['service_inventory'],rows)}
    state['preserved_runtime']={row['Id']:contract.definition_digest(row) for row in rows}
    for name,receipt in state['gateway_provisioning'].items():
        receipt['definition_sha256']=state['preserved_runtime'][state['service_inventory'][name]]
    raw=contract.sealed_bytes({'schema_version':3,'runtime_stage':state['runtime_stage'],'preserved_runtime':state['preserved_runtime'],'runtime_projection_version':2,
        'source_sha':contract.SOURCE_SHA,'native_fields':'must be checked by the real B02 validator'})
    state['b02_plan_ref']=ref('/opt/commerce-os/private/daily-b02/plan.json',raw)
    state['b02_plan_sha256']=state['b02_plan_ref']['sha256']
    return raw


class RuntimeContract(unittest.TestCase):
    def fail(self,fn,*args,**kwargs):
        with self.assertRaises(ReleaseError): fn(*args,**kwargs)

    def test_eight_services_plus_each_gateway_count_including_stopped(self):
        for count in range(4):
            with self.subTest(count=count):
                state,rows,raw=fixture(count)
                self.assertEqual(len(contract.validate_inventory(state,rows)),8+count)
                self.assertEqual(contract.validate_plan(state,raw)['preserved_runtime'],state['preserved_runtime'])

    def test_schema_unknown_missing_bool_version_extra_gateway_and_duplicate_rejected(self):
        for change in ('unknown','missing','bool','extra','duplicate','unhashable'):
            state,_,_=fixture(3)
            if change=='unknown':state['extra']=True
            if change=='missing':del state['service_inventory']['ingress']
            if change=='bool':state['schema_version']=True
            if change=='extra':state['service_inventory']['waha-04']=checksum(88)
            if change=='duplicate':state['service_inventory']['api']=state['service_inventory']['web']
            if change=='unhashable':state['service_inventory']['api']=[]
            with self.subTest(change=change):self.fail(contract.validate_state,state)

    def test_foreign_duplicate_missing_and_relabelled_container_rejected(self):
        for change in ('foreign','duplicate','missing','relabel'):
            state,rows,_=fixture(0)
            if change=='foreign':rows.append(copy.deepcopy(rows[0]));rows[-1]['Id']=checksum(2000)
            if change=='duplicate':rows[-1]=copy.deepcopy(rows[0])
            if change=='missing':rows.pop()
            if change=='relabel':rows[-1]['Config']['Labels']['com.docker.compose.project']='foreign'
            with self.subTest(change=change):self.fail(contract.validate_inventory,state,rows)

    def test_core_stopped_restarting_paused_or_bad_pid_rejected(self):
        for patch in ({'Running':False,'Pid':0},{'Restarting':True},{'Paused':True},{'Pid':True}):
            state,rows,_=fixture(0);rows[0]['State'].update(patch)
            self.fail(contract.validate_inventory,state,rows)

    def test_gateway_started_is_observed_but_is_not_a_connection_proof(self):
        state,rows,_=fixture(1);rows[-1]['State'].update(Running=True,Pid=99)
        self.assertIn('waha-01',contract.validate_inventory(state,rows))

    def test_gateway_ports_restart_and_session_autostart_rejected(self):
        for change in ('port','restart','autostart','qr'):
            state,rows,_=fixture(1);gateway=rows[-1]
            if change=='port':gateway['HostConfig']['PortBindings']={'3000/tcp':[{'HostPort':'3000'}]}
            if change=='restart':gateway['HostConfig']['RestartPolicy']['Name']='always'
            if change=='autostart':gateway['Config']['Env'][-2]='WHATSAPP_START_SESSION=default'
            if change=='qr':gateway['Config']['Env'][1]='WAHA_PRINT_QR=true'
            refresh(state,rows)
            with self.subTest(change=change):self.fail(contract.validate_inventory,state,rows)

    def test_pid_start_and_endpoint_are_live_not_static(self):
        state,rows,_=fixture(0);new=copy.deepcopy(rows)
        new[0]['State'].update(Pid=2000,StartedAt='2026-10-08T05:30:00Z')
        endpoint=next(iter(new[0]['NetworkSettings']['Networks'].values()))
        endpoint.update(EndpointID=checksum(3000),IPAddress='192.0.2.100')
        self.assertEqual(contract.definition_digest(rows[0]),contract.definition_digest(new[0]))
        contract.validate_inventory(state,new)
        self.fail(contract.compare_live_snapshot,{row['Id']:row for row in rows},{row['Id']:row for row in new})

    def test_endpoint_changes_during_backup_are_detected_without_pid_change(self):
        _,rows,_=fixture(0);new=copy.deepcopy(rows)
        next(iter(new[0]['NetworkSettings']['Networks'].values()))['EndpointID']=checksum(99)
        self.fail(contract.compare_live_snapshot,{row['Id']:row for row in rows},{row['Id']:row for row in new})

    def test_gateways_require_exact_canonical_provisioning_bindings(self):
        for patch in ('missing','slot','digest','unknown'):
            state,_,_=fixture(3)
            if patch=='missing':del state['gateway_provisioning']['waha-01']
            elif patch=='slot':state['gateway_provisioning']['waha-01']['slot']=3
            elif patch=='digest':state['gateway_provisioning']['waha-01']['definition_sha256']=checksum(888)
            else:state['gateway_provisioning']['waha-01']['verified']=True
            with self.subTest(patch=patch):self.fail(contract.validate_state,state)

    def test_static_definition_changes_are_not_reconciled(self):
        for field in ('Image','Config','HostConfig','Mounts','NetworkSettings','Name'):
            state,rows,_=fixture(0)
            if field=='Image':rows[0]['Image']='sha256:'+checksum(9000)
            elif field=='Config':rows[0]['Config']['Cmd']=['changed']
            elif field=='HostConfig':rows[0]['HostConfig']['Memory']=1234
            elif field=='Mounts':rows[0]['Mounts']=[{'Destination':'/foreign'}]
            elif field=='NetworkSettings':next(iter(rows[0]['NetworkSettings']['Networks'].values()))['NetworkID']=checksum(8000)
            else:rows[0]['Name']='/foreign'
            with self.subTest(field=field):self.fail(contract.validate_inventory,state,rows)

    def test_portal_identity_refs_and_network_preserved(self):
        for change in ('code','image','network','manifest'):
            state,rows,_=fixture(0)
            if change=='code':rows[4]['Config']['Labels']['com.inovaris.source-sha']='b'*40
            if change=='image':rows[4]['Image']='sha256:'+checksum(999)
            if change=='network':rows[4]['NetworkSettings']['Networks']['wrong']=rows[4]['NetworkSettings']['Networks'].pop('synthetic-proxy')
            if change=='manifest':state['portal']['manifest_ref']['path']='/opt/commerce-os/releases/../portal-manifest.json'
            with self.subTest(change=change):self.fail(contract.validate_inventory,state,rows)

    def test_exact_plan_hash_bytes_path_and_projection_version(self):
        state,_,raw=fixture(0)
        self.fail(contract.validate_plan,state,raw+b' ')
        state['b02_plan_ref']['path']='/tmp/plan.json';self.fail(contract.validate_plan,state,raw)
        state,_,raw=fixture(0);bad=json.loads(raw);bad['runtime_projection_version']=1
        bad=contract.sealed_bytes(bad);state['b02_plan_ref']=ref('/opt/commerce-os/private/daily-b02/plan.json',bad)
        state['b02_plan_sha256']=state['b02_plan_ref']['sha256'];self.fail(contract.validate_plan,state,bad)

    def test_owner_expiry_and_canonical_renewal_keep_identity(self):
        before=owner();after=copy.deepcopy(before);after['clock_utc']='2026-10-08T13:01:00Z'
        after['sessions'][0]['unexpired']=False
        facts=contract.compare_owner(before,after,'synthetic-workspace',compare_owner_auth)
        self.assertTrue(facts['identity_preserved'])
        after=copy.deepcopy(before);after['clock_utc']='2026-10-08T12:30:00Z'
        after['sessions'][0].update(updated_at='2026-10-08T12:20:00Z',expires_at='2026-10-09T00:20:00Z')
        self.assertEqual(contract.compare_owner(before,after,'synthetic-workspace',compare_owner_auth)['canonical_renewed_sessions'],1)

    def test_owner_identity_permissions_and_revoked_token_rejected(self):
        for change in ('subject','member','scope','revoked','workspace','newsession'):
            before=owner();after=copy.deepcopy(before)
            if change=='subject':after['sessions'][0]['user_id']='foreign'
            if change=='member':after['memberships'][0]['role']='member'
            if change=='scope':after['tokens'][0]['allowed_environments']=['SIMULATION']
            if change=='revoked':after['tokens'][0]['revoked_at']='2026-10-08T05:00:00Z'
            if change=='workspace':after['tokens'][0]['workspace_id']='foreign'
            if change=='newsession':after['sessions'][0]['id']='new-session'
            with self.subTest(change=change):self.fail(contract.compare_owner,before,after,'synthetic-workspace',compare_owner_auth)

    def test_canonical_revision_chain_requires_adjacent_audit_receipts(self):
        before={'policy_version':93,'policy_body_sha256':checksum(93)}
        after={'policy_version':95,'policy_body_sha256':checksum(95)}
        receipts=[{'previous_version':i,'version':i+1,'before_policy_sha256':checksum(i),
            'after_policy_sha256':checksum(i+1),'actor_id':'synthetic-owner',
            'operation':'integration.settings_updated','resource_key':'meta:SYNTHETIC',
            'receipt_ref':ref('/opt/commerce-os/private/revisions/'+str(i)+'.json')} for i in (93,94)]
        contract.canonical_revisions(before,after,receipts)
        for patch in ('gap','hash','unknown','reused','bool'):
            changed=copy.deepcopy(receipts)
            if patch=='gap':changed[1]['version']=97
            if patch=='hash':changed[1]['before_policy_sha256']=checksum(99)
            if patch=='unknown':changed[1]['operation']='manual_sql'
            if patch=='reused':changed[1]['receipt_ref']=changed[0]['receipt_ref']
            if patch=='bool':changed[0]['previous_version']=True
            with self.subTest(patch=patch):self.fail(contract.canonical_revisions,before,after,changed)
        self.fail(contract.canonical_revisions,before,after,[])

    def test_live_snapshot_equal_passes_and_foreign_inventory_rejected(self):
        _,rows,_=fixture(1);snap={row['Id']:row for row in rows}
        contract.compare_live_snapshot(snap,copy.deepcopy(snap))
        changed=copy.deepcopy(snap);changed.pop(next(iter(changed)))
        self.fail(contract.compare_live_snapshot,snap,changed)

    def test_future_publication_allows_new_apps_and_non93_policy_preserving_boundaries(self):
        before,rows,_=fixture(3);after=copy.deepcopy(before);new=copy.deepcopy(rows)
        for name,row in zip(after['service_inventory'],new):
            if name in contract.CORE-{'postgres','caddy','portal'}:
                row['Id']=checksum(int(row['Id'],16)+1000);row['Image']='sha256:'+checksum(5000)
        refresh(after,new);after['current_release']='/opt/commerce-os/releases/new-synthetic'
        facts=contract.validate_publication(before,after,rows,new,before_owner=owner(),after_owner=owner(),compare_owner_auth=compare_owner_auth)
        self.assertTrue(facts['identity_preserved'])
        after['policy_version']=99
        self.fail(contract.validate_publication,before,after,rows,new,before_owner=owner(),after_owner=owner(),compare_owner_auth=compare_owner_auth)

    def test_legitimate_canonical_edits_before_future_deploy_are_not_overwritten(self):
        previous,rows,_=fixture(0);candidate=copy.deepcopy(previous)
        candidate.update(policy_version=99,policy_body_sha256=checksum(901))
        receipt={'previous_version':98,'version':99,'before_policy_sha256':checksum(900),
            'after_policy_sha256':checksum(901),'actor_id':'synthetic-owner',
            'operation':'operational_settings.updated','resource_key':'synthetic-workspace',
            'receipt_ref':ref('/opt/commerce-os/private/revisions/synthetic.json')}
        observed={'policy_version':99,'policy_body_sha256':checksum(901)}
        contract.validate_publication(previous,candidate,rows,rows,before_owner=owner(),after_owner=owner(),
            compare_owner_auth=compare_owner_auth,observed_policy=observed,revision_receipts=[receipt])
        self.fail(contract.validate_publication,previous,candidate,rows,rows,before_owner=owner(),after_owner=owner(),
            compare_owner_auth=compare_owner_auth,observed_policy=observed,revision_receipts=[])

    def test_future_publication_rejects_preserved_restart_and_private_profile_changes(self):
        before,rows,_=fixture(1);after=copy.deepcopy(before);new=copy.deepcopy(rows)
        new[3]['State']['Pid']+=1
        self.fail(contract.validate_publication,before,after,rows,new,before_owner=owner(),after_owner=owner(),compare_owner_auth=compare_owner_auth)
        new=copy.deepcopy(rows);after['canonical_files']['channel.env']['sha256']=checksum(9123)
        self.fail(contract.validate_publication,before,after,rows,new,before_owner=owner(),after_owner=owner(),compare_owner_auth=compare_owner_auth)

    def test_cas_rejects_drift_and_plan_scope_change_and_writes_nothing(self):
        candidate,_,new_plan=fixture(0);previous=copy.deepcopy(candidate)
        old_plan=new_plan;before=contract.sealed_bytes(previous)
        kwargs={'expected_state_sha256':contract.sha256(before),'expected_plan_sha256':contract.sha256(old_plan),
            'candidate':candidate,'candidate_plan_raw':new_plan}
        self.assertEqual(contract.validate_cas_transition(before,before,old_plan,old_plan,**kwargs),
            {'prewrite_cas_validated':True,'state_written':False,'consumers_started':False,'physical_sales_proven':False})
        self.fail(contract.validate_cas_transition,before,before+b' ',old_plan,old_plan,**kwargs)
        self.fail(contract.validate_cas_transition,before,before,old_plan,old_plan+b' ',**kwargs)
        bad=json.loads(new_plan);bad['source_sha']='b'*40;bad=contract.sealed_bytes(bad)
        changed=copy.deepcopy(candidate);changed['b02_plan_ref']=ref('/opt/commerce-os/private/daily-b02/plan.json',bad)
        changed['b02_plan_sha256']=changed['b02_plan_ref']['sha256']
        kwargs.update(candidate=changed,candidate_plan_raw=bad)
        self.fail(contract.validate_cas_transition,before,before,old_plan,old_plan,**kwargs)

    def test_initial_five_service_v2_continuity_and_cas_keep_actual_legacy_projection(self):
        candidate,rows,new_plan=fixture(3);baseline=rows[:5]
        previous={key:copy.deepcopy(candidate[key]) for key in contract.BASE_FIELDS}
        previous.update(schema_version=2,status='ADOPTED_EXISTING_API_WEB',scope='api-web',policy_version=93)
        previous['preserved_runtime']={row['Id']:contract._legacy_digest(row) for row in baseline}
        old_plan=contract.sealed_bytes({'preserved_runtime':previous['preserved_runtime'],
            'source_sha':contract.SOURCE_SHA,'native_fields':'must be checked by the real B02 validator'})
        previous['b02_plan_sha256']=contract.sha256(old_plan)
        self.assertTrue(contract.validate_initial_continuity(previous,candidate,baseline,rows,
            before_owner=owner(),after_owner=owner(),compare_owner_auth=compare_owner_auth)['identity_preserved'])
        raw=contract.sealed_bytes(previous)
        contract.validate_cas_transition(raw,raw,old_plan,old_plan,expected_state_sha256=contract.sha256(raw),
            expected_plan_sha256=contract.sha256(old_plan),candidate=candidate,candidate_plan_raw=new_plan)
        corrupt=copy.deepcopy(baseline);corrupt[2]['State']['Pid']+=1
        self.fail(contract.validate_initial_continuity,previous,candidate,corrupt,rows,
            before_owner=owner(),after_owner=owner(),compare_owner_auth=compare_owner_auth)


if __name__=='__main__':unittest.main()
