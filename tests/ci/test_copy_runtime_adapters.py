"""Behavioral adapter regressions with synthetic Docker/Root/API evidence.
No Cloud, external provider, installed runtime, database or physical sale proof.
"""
import copy
import contextlib
import io
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
from test_copy_runtime_deployment import fixture, checksum, ref, refresh
import copy_runtime_deployment as c
from ci_release import ReleaseError


def load(name, file):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).resolve().parents[2]/'scripts'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

changes=load('copy_changes','ci-changes.py')
client=load('copy_client','deploy-ci-client.py')


def frozen(version=93):
    return {'version':version,'body':{'dispatch_frozen':True,'real_sends_enabled':False,
        'allow_real_operations':False,'allow_channel_onboarding':False,
        'contact_messages_per_minute':6,'channel_account_concurrency':1}}


def network(name='existing',subnet='172.18.0.0/16',cid=500):
    return {'Name':name,'Id':checksum(cid),'Driver':'bridge','Scope':'local','Internal':True,
        'Attachable':False,'EnableIPv6':False,'IPAM':{'Driver':'default','Options':{},
        'Config':[{'Subnet':subnet,'Gateway':subnet.split('/')[0].rsplit('.',1)[0]+'.1'}]},
        'Options':{},'Labels':{},'Containers':{}}


def owned_edge(source='a'*40, endpoints=None):
    definition=c.edge_definition(source)
    row=network(definition['name'],definition['subnet'],900)
    row.update(Internal=False,Options=definition['options'],Labels=definition['labels'],
               Containers=endpoints or {})
    row['IPAM']['Config']=[{'Subnet':definition['subnet'],'Gateway':definition['gateway']}]
    return definition,row


class RuntimeAdapters(unittest.TestCase):
    def fail(self, fn,*args,**kwargs):
        with self.assertRaises(ReleaseError):fn(*args,**kwargs)

    def test_core_prepared_is_exact_five_and_not_operating_success(self):
        state,rows,_=fixture();rows=rows[:5]
        state.update(runtime_stage='CORE_PREPARED',status='PREPARED_ACTION_REQUIRED')
        state['service_inventory']={name:state['service_inventory'][name] for name in c.INITIAL}
        refresh(state,[next(row for row in rows if row['Id']==state['service_inventory'][name]) for name in state['service_inventory']])
        c.validate_inventory(state,rows)
        state['status']='ADOPTED_COPY_RUNTIME';self.fail(c.validate_state,state)
        state['status']='PREPARED_ACTION_REQUIRED';state['service_inventory']['ingress']=checksum(600)
        self.fail(c.validate_state,state)

    def test_prepared_transport_requires_no_consumers_and_does_not_become_success(self):
        report={'deployment_scope':'copy-runtime','status':'PREPARED_ACTION_REQUIRED','runtime_stage':'CORE_PREPARED',
                'consumers_started':False,'full_runtime_started':False,'healthy_services':3,'migration_count':67,
                'physical_sales_proven':False,'core_prepared':True}
        client.validate_requested_scope(report,'copy-runtime')
        for name,value in [('consumers_started',True),('runtime_stage','OPERATING'),('migration_count',65)]:
            bad=dict(report);bad[name]=value;self.fail(client.validate_requested_scope,bad,'copy-runtime')

    def test_copy_dispatch_continuation_forces_full_ci_even_empty_diff(self):
        result=changes.select('workflow_dispatch','refs/heads/main','a'*40,[],mode='release',publication_scope='copy-runtime')
        self.assertEqual((result['deploy'],result['scope']),('true','full'))
        self.assertEqual(changes.select('workflow_dispatch','refs/heads/main','a'*40,[],mode='verify',publication_scope='copy-runtime')['deploy'],'false')

    def test_prepared_cannot_be_deployed_baseline_with_job_or_incident_run(self):
        for suffix in ('/job/456',''):
            deployment={'sha':'a'*40,'payload':{'deployment_scope':'copy-runtime','runtime_stage':'CORE_PREPARED',
                'consumers_started':False,'installer_status':'SUCCEEDED','source_sha':'a'*40,
                'archive_sha256':'b'*64,'installation_run_id':'123-1','verification':'synthetic'}}
            status={'environment_url':'https://commerce-os.inovaris.online',
                    'log_url':'https://github.com/a/b/actions/runs/123'+suffix}
            fetch=lambda _: {'name':'deploy','workflow_name':'Commerce OS CI/CD','status':'completed',
                'conclusion':'success','head_sha':'a'*40,'run_id':123,'html_url':status['log_url']}
            self.assertFalse(changes.software_installation(deployment,status,fetch,'a/b'))

    def test_first_start_rejects_pending_or_enabled_profile(self):
        barriers={'database':'commerce','migration_count':67,**{key:0 for key in c.native.BARRIERS},
                  'login_sessions':1,'personal_tokens_live':1}
        for extra in ({'channel_commands_pending':1,'channel_profiles_enabled':0},
                      {'channel_commands_pending':0,'channel_profiles_enabled':1},
                      {'channel_commands_pending':False,'channel_profiles_enabled':0}):
            answers=[json.dumps(barriers),json.dumps(extra),'t'];server=types.SimpleNamespace(database=lambda *_:answers.pop(0))
            self.fail(c.first_start_guard,server,'synthetic')
        answers=[json.dumps(barriers),json.dumps({'channel_commands_pending':0,'channel_profiles_enabled':0}),'t']
        self.assertTrue(c.first_start_guard(types.SimpleNamespace(database=lambda *_:answers.pop(0)),'x')['real_channels_quarantined'])

    def test_first_start_owner_bool_and_open_policy_rejected(self):
        barriers={'database':'commerce','migration_count':67,**{key:0 for key in c.native.BARRIERS},
                  'login_sessions':1,'personal_tokens_live':True}
        self.fail(c.first_start_guard,types.SimpleNamespace(database=lambda *_:json.dumps(barriers)),'x')
        barriers['personal_tokens_live']=1;answers=[json.dumps(barriers),json.dumps({'channel_commands_pending':0,'channel_profiles_enabled':0}),'f']
        self.fail(c.first_start_guard,types.SimpleNamespace(database=lambda *_:answers.pop(0)),'x')

    def test_first_start_accepts_bounded_existing_tokens_without_opening_effects(self):
        barriers={'database':'commerce','migration_count':67,**{key:0 for key in c.native.BARRIERS},
                  'login_sessions':1,'personal_tokens_live':2}
        for count in (2,c.native.MAX_OWNER_TOKENS):
            answers=[json.dumps(barriers|{'personal_tokens_live':count}),
                     json.dumps({'channel_commands_pending':0,'channel_profiles_enabled':0}),'t']
            self.assertTrue(c.first_start_guard(types.SimpleNamespace(database=lambda *_:answers.pop(0)),'x')['real_dispatch_frozen'])
        for count in (0,True,'2',c.native.MAX_OWNER_TOKENS+1):
            self.fail(c.first_start_guard,types.SimpleNamespace(database=lambda *_:json.dumps(barriers|{'personal_tokens_live':count})),'x')
        for name in set(c.native.BARRIERS)-{'login_sessions','personal_tokens_live'}:
            with self.subTest(barrier=name):
                self.fail(c.first_start_guard,types.SimpleNamespace(database=lambda *_:json.dumps(barriers|{name:1})),'x')

    def test_edge_overlap_checks_all_docker_subnets_and_host_routes(self):
        definition,_=owned_edge()
        for observation in ({'networks':[network(subnet='172.30.0.0/16')],'routes':[]},
                            {'networks':[],'routes':[{'dst':'172.30.80.0/25'}]},
                            {'networks':[network(c.EDGE_NAME)],'routes':[]}):
            self.fail(c.edge_no_overlap,definition,observation)
        c.edge_no_overlap(definition,{'networks':[network()],'routes':[{'dst':'default'},{'dst':'10.70.0.1'}]})

    def test_edge_readback_rejects_foreign_endpoint_ipv6_options_and_source(self):
        definition,row=owned_edge();self.assertEqual(c.edge_readback(row,definition,set()),checksum(900))
        for key,value in [('Containers',{checksum(3):{}}),('EnableIPv6',True),('Internal',True),('Options',{}),('Labels',{})]:
            bad=copy.deepcopy(row);bad[key]=value;self.fail(c.edge_readback,bad,definition,set())
        running=copy.deepcopy(row);running['Containers']={checksum(7):{}}
        c.edge_readback(running,definition,{checksum(7)})

    def test_edge_root_preflight_changed_does_not_issue_create(self):
        with tempfile.TemporaryDirectory() as tmp:
            private=Path(tmp);(private/'controller-approvals').mkdir();definition,_=owned_edge()
            before={'state':{'schema_version':2,'preserved_runtime':{}},'state_raw':b'state','plan_raw':b'plan'}
            approval={'schema_version':1,'source_sha':'a'*40,'before_adoption_sha256':c.sha256(b'state'),
                'before_plan_sha256':c.sha256(b'plan'),'definition':definition,
                'preflight':{key:'a'*64 for key in ('networks_sha256','routes_sha256','containers_sha256')}}
            review={'source_sha':'a'*40,'consumer_edge_approval_ref':ref(str(private/'controller-approvals/edge.json'))}
            calls=[];server=types.SimpleNamespace(PRIVATE=private,command=lambda args,root:calls.append(args))
            with patch.object(c.native,'read_reference',return_value=c.sealed_bytes(approval)),patch.object(c,'edge_preflight',return_value={
                'hashes':{key:'b'*64 for key in approval['preflight']},'container_ids':set()}):
                self.fail(c.prepare_edge,server,'x',private/'100-1',before,review,[object()]*4)
            self.assertEqual(calls,[])

    def test_edge_creation_failure_retains_durable_reconciliation_without_delete(self):
        with tempfile.TemporaryDirectory() as tmp:
            private=Path(tmp);(private/'controller-approvals').mkdir();reportdir=private/'100-1';reportdir.mkdir()
            definition,row=owned_edge();observation={'networks':[],'routes':[],'container_ids':set(),
                'hashes':{key:'a'*64 for key in ('networks_sha256','routes_sha256','containers_sha256')}}
            before={'state':{'schema_version':2,'preserved_runtime':{}},'state_raw':b'state','plan_raw':b'plan'}
            approval={'schema_version':1,'source_sha':'a'*40,'before_adoption_sha256':c.sha256(b'state'),
                'before_plan_sha256':c.sha256(b'plan'),'definition':definition,'preflight':observation['hashes']}
            review={'source_sha':'a'*40,'consumer_edge_approval_ref':ref(str(private/'controller-approvals/edge.json'))}
            calls=[];reports=[]
            def command(args,root):
                calls.append(args)
                if args[1:3]==['network','create']:return checksum(900)
                raise ReleaseError('SYNTHETIC_READBACK_FAILURE')
            server=types.SimpleNamespace(PRIVATE=private,command=command,_write_report=lambda p,value:reports.append(copy.deepcopy(value)))
            def protected(path):return b'plan' if Path(path).name=='plan.json' else b'state'
            with patch.object(c.native,'read_reference',return_value=c.sealed_bytes(approval)),patch.object(c,'edge_preflight',return_value=observation),patch.object(c.native,'protected_bytes',side_effect=protected):
                self.fail(c.prepare_edge,server,'x',reportdir,before,review,[object()]*4)
            self.assertEqual(reports[-1]['status'],'RECONCILIATION_REQUIRED')
            self.assertFalse(reports[-1]['deletion_attempted']);self.assertFalse(any('rm' in args for args in calls))
            self.assertFalse((reportdir/'consumer-edge.json').exists())

    def test_hold_marker_checks_actual_candidate_not_only_running_image(self):
        calls=[]
        def command(args,root):
            calls.append(args)
            if args[1]=='inspect':return json.dumps([{'Image':'sha256:'+checksum(1)}])
            return json.dumps(c.HOLD_CAPABILITY if args[9]=='sha256:'+checksum(1) else {'schema_version':1})
        # Image argument is before node, independent of option ordering.
        def observed(args,root):
            calls.append(args)
            if args[1]=='inspect':return json.dumps([{'Image':'sha256:'+checksum(1)}])
            image=args[args.index('node')-1]
            return json.dumps(c.HOLD_CAPABILITY if image=='sha256:'+checksum(1) else {'schema_version':1})
        self.fail(c.copy_hold_capability,types.SimpleNamespace(command=observed),'x',checksum(2),'sha256:'+checksum(3))
        self.assertEqual([args[args.index('node')-1] for args in calls if 'node' in args],['sha256:'+checksum(1),'sha256:'+checksum(3)])

    def test_loaded_candidate_checks_source_platform_and_layers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'images.json').write_text(json.dumps({'commerce-os:release':{'source_sha':'a'*40,'layers':['layer']}}))
            row={'Id':'sha256:'+checksum(9),'Os':'linux','Architecture':'amd64','RootFS':{'Layers':['layer']},
                 'Config':{'Labels':{'org.opencontainers.image.revision':'a'*40}}}
            server=types.SimpleNamespace(command=lambda *_:json.dumps([row]))
            self.assertEqual(c.loaded_candidate_image(server,root,'a'*40),row['Id'])
            row['RootFS']['Layers']=['foreign'];self.fail(c.loaded_candidate_image,server,root,'a'*40)

    def test_exact_candidate_continuation_rejects_rebuilt_same_sha(self):
        with tempfile.TemporaryDirectory() as tmp:
            prior=Path(tmp)/'prior';candidate=Path(tmp)/'candidate';prior.mkdir();candidate.mkdir()
            images={tag:{'id':'sha256:'+checksum(i),'layers':['layer'+str(i)],'source_sha':'a'*40}
                    for i,tag in enumerate(('commerce-os:release','commerce-os-web:release','commerce-os-maintenance:release'),1)}
            release=dict(zip(('COMMERCE_IMAGE','COMMERCE_WEB_IMAGE','COMMERCE_MAINTENANCE_IMAGE'),[x['id'] for x in images.values()]))
            for root in (prior,candidate):
                (root/'scripts').mkdir();(root/'scripts/test.sh').write_bytes(b'public synthetic')
                (root/'RELEASE.json').write_text(json.dumps({'source_sha':'a'*40,'run_id':root.name}))
                (root/'images.json').write_text(json.dumps(images));(root/'web-manifest.json').write_text('{}')
                (root/'PACKAGE.sha256').write_text(c.sha256(b'public synthetic')+'  scripts/test.sh\n')
            c.continuation_identity(prior,candidate,release,'a'*40)
            images['commerce-os:release']['id']='sha256:'+checksum(99);(candidate/'images.json').write_text(json.dumps(images))
            self.fail(c.continuation_identity,prior,candidate,release,'a'*40)

    def test_quota_capture_is_real_only_and_never_resets_rows(self):
        calls=[];server=types.SimpleNamespace(database=lambda root,sql:calls.append(sql) or '{}')
        self.assertEqual(c.commercial_snapshot(server,'x'),c.sha256(b'{}'))
        query=calls[0];self.assertIn('warmup_rate_buckets',query);self.assertIn("a.environment='REAL'",query)
        self.assertIn("e.environment='REAL'",query);self.assertNotIn('UPDATE ',query);self.assertNotIn('DELETE ',query)

    def test_deadline_expiry_rejects_before_new_work(self):
        with patch.object(c.time,'monotonic',return_value=100):
            self.fail(c.deadline_check,100);self.assertEqual(c.deadline_check(102),2)

    def test_global_deadline_fuse_covers_native_calls_and_restores_handler(self):
        installed=[];previous=object()
        with patch.object(c.sys,'platform','linux'),patch.object(c.signal,'getitimer',return_value=(0.0,0.0)),patch.object(c.signal,'getsignal',return_value=previous),patch.object(c.signal,'signal',side_effect=lambda *v:installed.append(v)),patch.object(c.signal,'setitimer') as timer,patch.object(c.time,'monotonic',return_value=100):
            with c.deadline_fuse(102):
                self.fail(installed[0][1],None,None)
            self.assertEqual(installed[-1][1],previous);self.assertEqual(timer.call_args_list[-1].args[1],0)

    def test_gateway_proof_requires_existing_overlay_and_native_operation(self):
        state,rows,_=fixture(1);services={name:row for name,row in zip(state['service_inventory'],rows)}
        with patch.object(c.native,'read_reference',side_effect=ReleaseError('SYNTHETIC_MISSING_OVERLAY')):
            self.fail(c.verify_gateway_provisioning,types.SimpleNamespace(database=lambda *_:'{}'),'x',state,services,'synthetic-workspace')
        with patch.object(c.native,'read_reference',return_value=b'{}'):
            self.fail(c.verify_gateway_provisioning,types.SimpleNamespace(database=lambda *_:'{}'),'x',state,services,'synthetic-workspace')

    def test_gateway_stopped_preserves_canonical_capacity_binding_not_connection_claim(self):
        state,rows,_=fixture(1);name='waha-01';gateway=rows[-1]
        gateway['Mounts']=[{'Destination':'/app/.sessions','Name':'commerce-os_waha-01-sessions'},
                           {'Destination':'/app/.media','Name':'commerce-os_waha-01-media'}];refresh(state,rows)
        services={name:row for name,row in zip(state['service_inventory'],rows)};receipt=state['gateway_provisioning'][name]
        facts={'operation':{'id':receipt['operation_id'],'workspace_id':'synthetic-workspace','environment':'REAL','action':'PROVISION',
                'state':'SUCCEEDED','result':{'outcome':'VERIFIED','sessions_started':0,'overlay_sha':c.sha256(b'{}')}},'audit':[{'actor':{'type':'service','id':'synthetic-administrator'}}],
            'slots':[{'workspace_id':'synthetic-workspace','environment':'REAL','host_ref':'primary','slot':1,'gateway_ref':name,
                'operation_id':receipt['operation_id'],'readback':{'source':'bounded_administrator','verified':True,
                    'overlay_sha':c.sha256(b'{}'),'image_digest':gateway['Image'],'network_present':True,'volumes_preserved':True}}]}
        with patch.object(c.native,'read_reference',return_value=b'{}'):
            c.verify_gateway_provisioning(types.SimpleNamespace(database=lambda *_:json.dumps(facts)),'x',state,services,'synthetic-workspace')
            facts['operation']['action']='DRAIN'
            self.fail(c.verify_gateway_provisioning,types.SimpleNamespace(database=lambda *_:json.dumps(facts)),'x',state,services,'synthetic-workspace')

    def test_canonical_policy_receipt_authenticates_event_actor_and_response(self):
        prior=frozen();after=frozen(94);state={'policy_version':93,'policy_body_sha256':c.policy(prior)['policy_body_sha256']}
        eid='00000000-0000-0000-0000-000000000001';response={'data':'synthetic accepted'}
        entry={'event_id':eid,'idempotency_actor':'personal:synthetic-pat','idempotency_operation':'integration.settings.disable',
               'idempotency_key':'synthetic-request','response_sha256':c.sha256(c.sealed_bytes(response)), 'before':prior,'after':after}
        document={'schema_version':1,'workspace_id':'synthetic-workspace','initial_policy':prior,
                  'receipts':[ref('/opt/commerce-os/private/receipts/94.json',c.sealed_bytes(entry))]}
        facts={'event':{'workspace_id':'synthetic-workspace','environment':'REAL','event_type':'integration.settings_disabled',
            'actor':{'type':'personal_api','id':'synthetic-owner','credential_id':'synthetic-pat'},
            'payload':{'configuration_version':94,'changed':True},'aggregate_id':'waha:synthetic'},
            'idempotency':{'status_code':200,'response':response}}
        with tempfile.TemporaryDirectory() as tmp:
            private=Path(tmp);(private/'copy-runtime-revisions.json').write_text('{}')
            with patch.object(c.native,'protected_bytes',return_value=c.sealed_bytes(document)),patch.object(c.native,'read_reference',return_value=c.sealed_bytes(entry)):
                observed,receipts=c.canonical_revision_observation(types.SimpleNamespace(database=lambda *_:json.dumps(facts)),'x',state,'synthetic-workspace',after,private)
                self.assertEqual(observed,c.policy(after));self.assertEqual(len(receipts),1)
                facts['event']['actor']['credential_id']='foreign'
                self.fail(c.canonical_revision_observation,types.SimpleNamespace(database=lambda *_:json.dumps(facts)),'x',state,'synthetic-workspace',after,private)

    def test_bounded_migration_deadline_is_shared_and_no_bootstrap_in_executor(self):
        self.assertNotIn('bootstrap',c.BOUNDED_MIGRATION_JS);self.assertIn('pg_advisory_xact_lock(83947101)',c.BOUNDED_MIGRATION_JS)
        server=types.SimpleNamespace(migrations=lambda _: {'old':checksum(1)})
        self.fail(c.apply_reviewed_migrations,server,'x','y',{'migration_hashes':{'old':checksum(1),**{name:checksum(2) for name in c.MIGRATION_NAMES}}},{},0)


class GatewayReconciliationAdapters(unittest.TestCase):
    def gateway(self):
        state,rows,_=fixture(1);gateway=rows[-1];name='waha-01'
        gateway['Mounts']=[{'Destination':'/app/.sessions','Name':'commerce-os_waha-01-sessions'},
                           {'Destination':'/app/.media','Name':'commerce-os_waha-01-media'}];refresh(state,rows)
        services=dict(zip(state['service_inventory'],rows));receipt=state['gateway_provisioning'][name]
        facts={'operation':{'id':receipt['operation_id'],'workspace_id':'synthetic-workspace','environment':'REAL','action':'PROVISION',
                'state':'SUCCEEDED','result':{'outcome':'VERIFIED','sessions_started':0,'overlay_sha':c.sha256(b'{}')}},
            'audit':[{'actor':{'type':'service','id':'synthetic-administrator'}}],
            'slots':[{'workspace_id':'synthetic-workspace','environment':'REAL','host_ref':'primary','slot':1,'gateway_ref':name,
                'operation_id':receipt['operation_id'],'readback':{'source':'bounded_administrator','verified':True,
                    'overlay_sha':c.sha256(b'{}'),'image_digest':gateway['Image'],'network_present':True,'volumes_preserved':True}}]}
        return state,services,facts

    def test_foreign_overlay_and_noncanonical_readback_or_actor_rejected(self):
        for change in ('overlay','missing_readback','foreign_actor','foreign_slot_overlay','unapplied_expand'):
            state,services,facts=self.gateway();raw=b'{}'
            if change=='overlay':raw=b'{"foreign":true}'
            if change=='missing_readback':facts['slots'][0]['readback']=None
            if change=='foreign_actor':facts['audit'][0]['actor']={'type':'anonymous','id':'foreign'}
            if change=='foreign_slot_overlay':facts['slots'][0]['readback']['overlay_sha']='a'*64
            if change=='unapplied_expand':facts['operation'].update(action='EXPAND',input={'apply':False})
            with self.subTest(change=change),patch.object(c.native,'read_reference',return_value=raw):
                with self.assertRaises(ReleaseError):
                    c.verify_gateway_provisioning(types.SimpleNamespace(database=lambda *_:json.dumps(facts)),'x',state,services,'synthetic-workspace')

    def test_only_canonical_new_gateway_networks_change_existing_workers(self):
        state,rows,_=fixture();candidate,new_rows,_=fixture(1)
        previous=dict(zip(state['service_inventory'],rows));services=dict(zip(candidate['service_inventory'],new_rows))
        for name in ('ingress','channel-worker'):
            services[name]['NetworkSettings']['Networks']['commerce-os_gateway-01']={'NetworkID':checksum(990),
                'EndpointID':checksum(991),'Aliases':[name],'GwPriority':0}
        files={name:b'PUBLIC_SYNTHETIC=1\n' for name in c.FILES}
        before={'state':state,'services':previous,'owner':{'tokens':[]},'workspace':'synthetic-workspace','files':files}
        server=types.SimpleNamespace(compare_owner_auth=lambda *_:{'identity_preserved':True})
        with patch.object(c.native,'protected_bytes',return_value=files['release.env']):
            self.assertEqual(c.gateway_continuity(before,services,candidate,{'tokens':[]},server,'/synthetic'),{'waha-01'})
            for change in ('foreign_network','changed_endpoint','changed_pid','replaced_api'):
                changed=copy.deepcopy(services)
                if change=='foreign_network':changed['channel-worker']['NetworkSettings']['Networks']['foreign']={}
                if change=='changed_endpoint':changed['ingress']['NetworkSettings']['Networks']['synthetic-core']['EndpointID']=checksum(999)
                if change=='changed_pid':changed['channel-worker']['State']['Pid']+=1
                if change=='replaced_api':changed['api']['Id']=checksum(1001)
                with self.subTest(change=change),self.assertRaises(ReleaseError):
                    c.gateway_continuity(before,changed,candidate,{'tokens':[]},server,'/synthetic')

    def test_profile_applying_and_number_preparing_block_both_scopes_without_sql_updates(self):
        for name in ('number','profile','lifecycle'):
            facts={key:0 for key in ('sends','provider','voice','number','profile','lifecycle')};facts[name]=1;queries=[]
            server=types.SimpleNamespace(database=lambda _,query:queries.append(query) or json.dumps(facts))
            with self.subTest(name=name),self.assertRaises(ReleaseError):c.in_flight_guard(server,'x')
            self.assertIn("environment='REAL' AND state='PREPARING' AND lease_until>now()",queries[0])
            self.assertIn("environment='REAL' AND profile_operation_status='APPLYING'",queries[0])
            self.assertIn("kind='channel_command' AND status='PENDING' AND result ? 'processing_owner'",queries[0])
            self.assertNotIn("payload->'_processing'",queries[0])
            self.assertNotIn('UPDATE ',queries[0]);self.assertNotIn('DELETE ',queries[0])

    def test_canonical_hold_observation_is_real_only_and_preserves_proof_hashes(self):
        facts={'held':True,'hold_at':'2026-10-08T06:00:00Z','ownerships':[{'frozen':True}], 'proofs':[], 'challenges':[]}
        queries=[];server=types.SimpleNamespace(database=lambda _,query:queries.append(query) or json.dumps(facts))
        self.assertEqual(c.ownership_projection(server,'x','synthetic-workspace'),facts)
        self.assertIn("a.environment='REAL'",queries[0]);self.assertIn('evidence_sha256',queries[0])
        self.assertIn('copy_source_isolation_challenges',queries[0]);self.assertNotIn('UPDATE ',queries[0])
        facts['held']=False
        with self.assertRaises(ReleaseError):c.ownership_projection(server,'x','synthetic-workspace')

    def test_unclaimed_pending_lifecycle_is_allowed_but_existing_claim_is_not(self):
        facts={key:0 for key in ('sends','provider','voice','number','profile','lifecycle')};queries=[]
        server=types.SimpleNamespace(database=lambda _,query:queries.append(query) or json.dumps(facts))
        c.in_flight_guard(server,'x')
        self.assertIn("AND result ? 'processing_owner'",queries[0])
        facts['lifecycle']=1
        with self.assertRaisesRegex(ReleaseError,'COPY_RUNTIME_IN_FLIGHT_OPERATIONS_REQUIRE_RECONCILIATION'):c.in_flight_guard(server,'x')

    def test_prior_backup_uses_native_aggregate_and_portal_bounds_with_streaming_reader(self):
        from b02_backup_contract import MAX_BYTES,PORTAL_MAX_BYTES
        before={'plan_raw':b'synthetic plan','state':{'backup_source_sha':c.SOURCE_SHA},'source_sha':'a'*40}
        directory=c.PRIVATE/'daily-b02/runs/101-1';journal=ref(str(directory/'journal.json'))
        exports={name:{'path':str(directory/'backups'/name),'bytes':size,'sha256':'c'*64}
            for name,size in [('ciphertext.backup.aes',33*1024**2),('portal.backup.aes',PORTAL_MAX_BYTES),('source.json',100),('backup.json',100)]}
        facts={'kind':'DAILY_B02','run_id':'101-1','status':'SUCCEEDED','external_copy_verified':True,
            'plan_sha256':c.sha256(before['plan_raw']),'backup_source_sha':c.SOURCE_SHA,'source_sha':'a'*40,
            'cleanup':{'runtime_preserved':True,'owned_plaintext_removed':True},'exports':exports,
            'finished_at':c.dt.datetime.now(c.dt.timezone.utc).isoformat()}
        source={'status':'B02_SOURCE_VERIFIED','plan_sha256':facts['plan_sha256']}
        backup={'status':'B02_LOCAL_CIPHERTEXT_VERIFIED','plan_sha256':facts['plan_sha256'],'encrypted':True,
            'format':2,'snapshot_consistent':True,'keys_exported':False}
        calls=[]
        def native_reference(path,**kwargs):
            calls.append((Path(path).name,kwargs));return exports[Path(path).name]
        from b02_backup_contract import backup_run_identity
        tools=types.SimpleNamespace(MAX_BYTES=MAX_BYTES,PORTAL_MAX_BYTES=PORTAL_MAX_BYTES,file_reference=native_reference,
            backup_run_identity=backup_run_identity,verify_trigger_journal=lambda report:None)
        def read(reference):
            name=Path(reference['path']).name
            return c.sealed_bytes(facts if name=='journal.json' else source if name=='source.json' else backup)
        with patch.object(c.native,'read_reference',side_effect=read):
            c.prior_backup_guard(journal,before,tools)
            self.assertEqual(calls,[('ciphertext.backup.aes',{'ciphertext':True,'header':b'COMOSB02'}),
                                   ('portal.backup.aes',{'ciphertext':True,'header':b'COMOSP01'})])
            exports['portal.backup.aes']['bytes']=PORTAL_MAX_BYTES+1
            with self.assertRaisesRegex(ReleaseError,'COPY_RUNTIME_GATEWAY_PRIOR_CIPHERTEXT_INVALID'):c.prior_backup_guard(journal,before,tools)
            exports['portal.backup.aes']['bytes']=PORTAL_MAX_BYTES
            exports['ciphertext.backup.aes']['bytes']=MAX_BYTES
            with self.assertRaisesRegex(ReleaseError,'COPY_RUNTIME_GATEWAY_PRIOR_BACKUP_TOTAL_BOUND'):c.prior_backup_guard(journal,before,tools)

    def approval(self,private,current,sha='a'*40):
        return {'schema_version':1,'source_sha':sha,'current_release':str(current),'run_id':'200-1',
            'before_adoption_sha256':'b'*64,'before_plan_sha256':'c'*64,'observed_policy':{},
            'runtime_before_ref':ref('/synthetic/runtime.json'),'previous_release_env_ref':ref('/synthetic/old.env'),
            'current_release_env_ref':ref(str(private/'release.env')),'ownership_observation_ref':ref('/synthetic/ownership.json'),
            'backup_before_provision_ref':ref('/synthetic/backup.json'),'gateway_provisioning':{},
            'backup_tools_manifest_ref':ref('/synthetic/tools.json')}

    def test_wrong_candidate_sha_rejected_before_journal_or_pair_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp).resolve();current=base/'releases'/'candidate';current.mkdir(parents=True);(base/'current').symlink_to(current)
            (current/'RELEASE.json').write_text(json.dumps({'source_sha':'a'*40}));private=base/'private';private.mkdir()
            manifest=self.approval(private,current,'d'*40);reference=ref(str(private/'controller-approvals/gateways.json'))
            calls=[];server=types.SimpleNamespace(BASE=base,PRIVATE=private,command=lambda *_:calls.append('DOCKER'),_write_report=lambda *_:calls.append('WRITE'))
            with patch.object(c.native,'protected_bytes',return_value=c.sealed_bytes(reference)),patch.object(c.native,'read_reference',return_value=c.sealed_bytes(manifest)):
                with self.assertRaisesRegex(ReleaseError,'COPY_RUNTIME_GATEWAY_SOURCE_SHA_CHANGED'):c.reconcile_gateways(server,'/synthetic/ref.json')
            self.assertEqual(calls,[]);self.assertFalse((private/'deployments').exists())

    def test_running_controller_bytes_must_match_package_not_only_sha(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'scripts').mkdir();source=Path(c.__file__)
            for name,actual in {'copy_runtime_deployment.py':source,'deploy-ci-vps.py':source,'api_web_deployment.py':Path(c.native.__file__),
                                'ci_provider_evidence.py':Path(c.provider_evidence.__file__)}.items():
                (root/'scripts'/name).write_bytes(actual.read_bytes())
            server=types.SimpleNamespace(__file__=str(source))
            with patch.object(c,'verify_package') as verify:
                c.current_source_guard(server,root);verify.assert_called_once_with(root)
                (root/'scripts/ci_provider_evidence.py').write_bytes(b'foreign provider reader')
                with self.assertRaisesRegex(ReleaseError,'COPY_RUNTIME_GATEWAY_RUNNING_CONTROLLER_CHANGED'):c.current_source_guard(server,root)
                (root/'scripts/ci_provider_evidence.py').write_bytes(Path(c.provider_evidence.__file__).read_bytes())
                (root/'scripts/copy_runtime_deployment.py').write_bytes(b'foreign public controller')
                with self.assertRaisesRegex(ReleaseError,'COPY_RUNTIME_GATEWAY_RUNNING_CONTROLLER_CHANGED'):c.current_source_guard(server,root)

    def test_existing_report_is_never_overwritten_and_replay_emits_one_terminal_document(self):
        for status in ('SUCCEEDED','RUNNING'):
            with self.subTest(status=status),tempfile.TemporaryDirectory() as tmp:
                base=Path(tmp).resolve();current=base/'releases'/'candidate';current.mkdir(parents=True);(base/'current').symlink_to(current)
                (current/'RELEASE.json').write_text(json.dumps({'source_sha':'a'*40}));private=base/'private';private.mkdir()
                manifest=self.approval(private,current);reference=ref(str(private/'controller-approvals/gateways.json'))
                report_dir=private/'deployments'/'200-1';report_dir.mkdir(parents=True)
                prior={'status':status,'action':'RECONCILE_CANONICAL_GATEWAY_INVENTORY','approval_ref':reference,'source_sha':manifest['source_sha'],'run_id':manifest['run_id']}
                path=report_dir/'report.json';path.write_bytes(c.sealed_bytes(prior));original=path.read_bytes()
                reference_file=base/'ref.json';reference_file.write_bytes(c.sealed_bytes(reference));out=io.StringIO();writes=[]
                server=types.SimpleNamespace(BASE=base,PRIVATE=private,error_code=str,_write_report=lambda *_:writes.append('WRITE'))
                import runtime_boot_install as boot
                with patch.object(boot,'gateway_replay',return_value={}),patch.object(boot,'gateway_recover',side_effect=ReleaseError('COPY_RUNTIME_GATEWAY_RETRY_REQUIRES_RECONCILIATION')),patch.object(c.native,'protected_bytes',side_effect=lambda path:Path(path).read_bytes()),patch.object(c.native,'read_reference',return_value=c.sealed_bytes(manifest)),patch.object(c,'current_source_guard',return_value=None),patch.object(c,'deadline_fuse',return_value=contextlib.nullcontext()),patch.object(c.native,'acquire_locks',return_value=[]),patch.object(c,'snapshot',return_value={'state':{'last_release_receipt_ref':ref(str(report_dir/'adoption-receipt.json'))}}),contextlib.redirect_stdout(out):
                    if status=='SUCCEEDED':self.assertTrue(c.reconcile_gateways(server,reference_file)['idempotent_replay'])
                    else:
                        with self.assertRaisesRegex(ReleaseError,'COPY_RUNTIME_GATEWAY_RETRY_REQUIRES_RECONCILIATION'):c.reconcile_gateways(server,reference_file)
                self.assertEqual(path.read_bytes(),original);self.assertEqual(writes,[])
                lines=out.getvalue().splitlines();self.assertEqual(len(lines),1 if status=='SUCCEEDED' else 0)
                if lines:self.assertEqual(json.loads(lines[0])['status'],'SUCCEEDED')


if __name__=='__main__':unittest.main()
