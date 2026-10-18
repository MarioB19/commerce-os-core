"""Synthetic local contracts; no Google credentials, cloud calls or production paths."""
import contextlib
import copy
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
import b02_backup_contract as c

def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

r=load('gcp_b02_root_tests','b02-backup-root.py')
s=load('gcp_b02_setup_tests','setup-b02-gcp-scheduler.py')
t=load('gcp_b02_client_tests','b02-backup-gcp.py')
NOW=dt.datetime(2026,10,9,10,5,tzinfo=dt.timezone.utc)
UID='efcb1286-e8d1-4b12-86f7-3d899ee229fd'
JOBUID='7ad053e1-a6d9-4a86-9a40-e1c16f4079b7'
TOKEN='synthetic.token.for.local.tests.only'


def fixtures(mode='MANUAL'):
    config={'source_sha':'a'*40,'image':'us-east1-docker.pkg.dev/'+c.TARGET[0]+'/commerce-b02/transport@sha256:'+'b'*64,
        'sdk_image':'gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:'+'c'*64,'schedule_utc':'10:00',
        'valid_until':'2026-11-04T00:00:00Z','bucket':'commerce-own-backups','plan_sha256':'d'*64,
        'manual_creator':'owner@example.invalid','activation_id':'synthetic-review-1'}
    plan=s.setup_plan(config);job=plan['job']|{'uid':JOBUID,'generation':'1','observedGeneration':'1','reconciling':False,
        'terminalCondition':{'type':'Ready','state':'CONDITION_SUCCEEDED'}}
    scheduler=plan['scheduler']|{'state':'PAUSED'}
    profile={'name':'12345678901234567890','posixAccounts':[{'uid':'2001','username':'sa_synthetic','operatingSystemType':'LINUX'}]}
    observed=s.readback(config,TOKEN,lambda url,_:job if 'run.googleapis' in url else scheduler)
    binding=s.bind(config,observed,profile,'12345678901234567890')
    if mode=='SCHEDULED':
        binding.update(mode=mode,first_custody_ref={'path':'/synthetic/journal.json','bytes':10,'sha256':'e'*64});scheduler['state']='ENABLED'
    execution={'name':c.GCP_JOB+'/executions/commerce-b02-daily-abcde','uid':UID,'job':c.GCP_JOB.rsplit('/',1)[1],
        'taskCount':1,'parallelism':1,'template':copy.deepcopy(job['template']['template']),
        'creator':config['manual_creator'] if mode=='MANUAL' else c.GCP_INVOKER,'createTime':NOW.isoformat()}
    task=copy.deepcopy(execution['template'])|{'name':c.gcp_task_name(execution['name']),
        'execution':execution['name'].rsplit('/',1)[1],'job':execution['job'],'index':0}
    return config,binding,job,scheduler,profile,execution,task


class IdentityAndNativeContracts(unittest.TestCase):
    def test_native_oslogin_email_endpoint_and_bare_immutable_profile_id(self):
        config,b,j,sc,p,e,t=fixtures();calls=[]
        expected='https://oslogin.googleapis.com/v1/users/'+c.GCP_EXECUTOR+'/loginProfile?projectId='+c.TARGET[0]
        def getter(url,token):
            calls.append(url);return p if 'oslogin.' in url else sc if 'cloudscheduler.' in url else j
        with mock.patch.object(r,'google_get',side_effect=getter):
            self.assertEqual(r.google_observation(b,TOKEN)['oslogin']['name'],b['executor_id'])
        self.assertEqual(calls[-1],expected)
        for name in ('users/'+b['executor_id'],c.GCP_EXECUTOR,'99999999999999999999',None):
            wrong=p|{'name':name}
            with self.subTest(name=name):
                with self.assertRaisesRegex(RuntimeError,'BINDING_INVALID'):s.bind(config,s.readback(config,TOKEN,lambda url,_:j if 'run.googleapis' in url else sc),wrong,b['executor_id'])
                with mock.patch.object(r,'google_get',side_effect=lambda url,_:wrong if 'oslogin.' in url else sc if 'cloudscheduler.' in url else j),self.assertRaisesRegex(RuntimeError,'PROFILE_CHANGED'):
                    r.google_observation(b,TOKEN)
        for url in (expected.replace(c.GCP_EXECUTOR,b['executor_id']),expected.replace(c.GCP_EXECUTOR,c.GCP_INVOKER),expected+'&other=1'):
            with self.assertRaisesRegex(RuntimeError,'ENDPOINT'):r.google_get(url,TOKEN)
        with mock.patch('urllib.request.build_opener',return_value=SimpleNamespace(open=mock.Mock(side_effect=OSError('synthetic')))):
            with self.assertRaisesRegex(RuntimeError,'GOOGLE_READ_FAILED'):r.google_get(expected,TOKEN)
        # An authentic empty profile has the correct identity but cannot bind a Unix user.
        observed=s.readback(config,TOKEN,lambda url,_:j if 'run.googleapis' in url else sc)
        with self.assertRaisesRegex(RuntimeError,'POSIX_AMBIGUOUS'):s.bind(config,observed,{'name':b['executor_id']},b['executor_id'])

    def test_native_task_name_parent_identity_and_gen2_omission(self):
        _,b,j,_,_,e,t=fixtures()
        for field in ('index','maxRetries','executionEnvironment'):t.pop(field,None)
        c.gcp_execution_guard(b,j,e,t,NOW)
        for patch in ({'name':e['name']+'/tasks/0'}, {'name':c.gcp_task_name(e['name'])[:-1]+'1'},
                      {'name':c.gcp_task_name(e['name']).replace('abcde-task0','other-task0')},
                      {'job':c.GCP_JOB},{'job':'other'}, {'execution':e['name']},{'execution':'other'},
                      {'executionEnvironment':None},{'executionEnvironment':'EXECUTION_ENVIRONMENT_GEN1'},
                      {'executionEnvironment':'EXECUTION_ENVIRONMENT_UNSPECIFIED'}):
            with self.subTest(patch=patch),self.assertRaises(RuntimeError):c.gcp_execution_guard(b,j,e,t|patch,NOW)
        for job in (c.GCP_JOB,'other'):
            with self.assertRaises(RuntimeError):c.gcp_execution_guard(b,j,e|{'job':job},t,NOW)
        for suffix in ('/tasks/0','/tasks/other-task0','/tasks/commerce-b02-daily-abcde-task1'):
            with self.assertRaisesRegex(RuntimeError,'ENDPOINT'):
                r.google_get('https://run.googleapis.com/v2/'+e['name']+suffix,TOKEN)

    def test_native_protojson_false_omission_requires_positive_ready_readback(self):
        config,binding,job,scheduler,*_=fixtures()
        del job['reconciling']
        self.assertTrue(c.gcp_job_reconciled(job))
        c.gcp_job_guard(binding,job)
        s.readback(config,TOKEN,lambda url,_:job if 'run.googleapis' in url else scheduler)
        for patch in ({'reconciling':None},{'reconciling':0},{'reconciling':True},{'reconciling':'false'},
                      {'generation':'0'},{'observedGeneration':'2'},{'terminalCondition':{}},
                      {'terminalCondition':{'type':'Ready','state':'CONDITION_FAILED'}},
                      {'terminalCondition':{'type':'Ready','state':'CONDITION_PENDING'}},
                      {'terminalCondition':{'type':'Other','state':'CONDITION_SUCCEEDED'}},
                      {'deleteTime':NOW.isoformat()}):
            with self.subTest(patch=patch):
                self.assertFalse(c.gcp_job_reconciled(job|patch))
                with self.assertRaises(RuntimeError):c.gcp_job_guard(binding,job|patch)
                with self.assertRaises(RuntimeError):s.readback(config,TOKEN,lambda url,_:job|patch if 'run.googleapis' in url else scheduler)

    def test_image_entrypoint_and_cmd_match_cloud_run_inheritance(self):
        dockerfile=(ROOT/'infra/b02-cloud-run.Dockerfile').read_text()
        instructions={line.split(' ',1)[0]:json.loads(line.split(' ',1)[1])
            for line in dockerfile.splitlines() if line.startswith(('ENTRYPOINT ', 'CMD '))}
        command=['python3','-B','/opt/commerce/scripts/b02-backup-gcp.py']
        self.assertEqual(instructions['ENTRYPOINT'],command)
        self.assertEqual(instructions['CMD'],[])
        # A Job command overrides ENTRYPOINT; absent args inherit image CMD.
        self.assertEqual(s.setup_plan(fixtures()[0])['job']['template']['template']['containers'][0]['command']
                         +instructions['CMD'],command)

    def test_gcp_backup_identity_never_enters_portal_github_identity(self):
        value=c.gcp_run_identity(UID);self.assertEqual(c.backup_run_identity(value),value)
        self.assertEqual(c.backup_run_identity('123-2'),'123-2')
        with self.assertRaisesRegex(RuntimeError,'INVALID_BACKUP_RUN'):c.run_identity(value)
        for bad in (UID.upper(),UID.replace('-4b12-','-1b12-'),UID.replace('-86f7-','-76f7-'),'gcp-'+UID):
            with self.subTest(bad=bad),self.assertRaises(RuntimeError):c.gcp_run_identity(bad)

    def test_native_execution_is_not_a_scheduled_delivery_claim(self):
        for mode in ('MANUAL','SCHEDULED'):
            _,b,j,_,_,e,t=fixtures(mode);result=c.gcp_execution_guard(b,j,e,t,NOW)
            self.assertEqual(result['run_id'],c.gcp_run_identity(UID));self.assertIs(result['scheduled_delivery_proven'],False)
            self.assertEqual(result['mode'],mode)

    def test_executor_actor_task_retries_overrides_and_stale_are_closed(self):
        _,b,j,_,_,e,t=fixtures()
        for patch in ({'creator':c.GCP_INVOKER},{'uid':JOBUID.upper()},{'taskCount':2}, {'parallelism':2},
                      {'retriedCount':1},{'template':{}},{'createTime':(NOW-dt.timedelta(minutes=6)).isoformat()},
                      {'createTime':(NOW+dt.timedelta(seconds=1)).isoformat()}):
            with self.subTest(patch=patch),self.assertRaises(RuntimeError):c.gcp_execution_guard(b,j,e|patch,t,NOW)
        for patch in ({'retried':1},{'index':1},{'index':False},{'serviceAccount':c.GCP_INVOKER},
                      {'timeout':'3600s'},{'volumes':[]},{'maxRetries':1},{'containers':[]},{'vpcAccess':{'x':1}},
                      {'completionTime':NOW.isoformat()}):
            with self.subTest(patch=patch),self.assertRaises(RuntimeError):c.gcp_execution_guard(b,j,e,t|patch,NOW)

    def test_job_digest_generation_and_fixed_resources_reject_drift(self):
        _,b,j,_,_,e,t=fixtures()
        for patch in ({'uid':UID},{'generation':'2'},{'observedGeneration':'0'},{'reconciling':True}):
            with self.subTest(patch=patch),self.assertRaises(RuntimeError):c.gcp_execution_guard(b,j|patch,e,t,NOW)
        for mutate in (lambda x:x['template'].update(taskCount=2),
                       lambda x:x['template']['template']['containers'][0].update(image='mutable:latest'),
                       lambda x:x['template']['template'].update(serviceAccount=c.GCP_INVOKER)):
            changed=copy.deepcopy(j);mutate(changed)
            with self.assertRaises(RuntimeError):c.gcp_job_guard(b,changed)

    def test_expiry_is_original_window_and_reserves_entire_task_budget(self):
        _,b,j,_,_,e,t=fixtures()
        for patch in ({'valid_from':'2026-10-09T00:00:00Z'},{'valid_until':'2026-12-04T00:00:01Z'},
                      {'schedule_utc':'24:00'},{'schema_version':True}):
            with self.subTest(patch=patch),self.assertRaises(RuntimeError):c.gcp_binding(b|patch)
        near=c.utc_time(b['valid_until'])-dt.timedelta(seconds=1799)
        with self.assertRaisesRegex(RuntimeError,'EXPIRED'):c.gcp_execution_guard(b,j,e,t,near)

    def test_single_owner_renewal_extends_the_window_to_december_4(self):
        _,b,*_=fixtures()
        self.assertEqual(c.GCP_FINANCIAL_ORIGINAL_END,dt.datetime(2026,11,4,tzinfo=dt.timezone.utc))
        self.assertEqual(c.GCP_FINANCIAL_END,dt.datetime(2026,12,4,tzinfo=dt.timezone.utc))
        self.assertEqual(c.gcp_binding(b|{'valid_until':'2026-12-04T00:00:00Z'})['valid_until'],'2026-12-04T00:00:00Z')
        renewed=b|{'valid_until':'2026-12-04T00:00:00Z'}
        self.assertTrue(r.financial_renewal(b,renewed))
        for previous,candidate in ((b,renewed|{'mode':'SCHEDULED'}),(b,b|{'valid_until':'2026-11-20T00:00:00Z'}),
                                   (b|{'valid_until':'2026-11-03T00:00:00Z'},renewed),(renewed,b)):
            with self.subTest(candidate=candidate['valid_until'],mode=candidate['mode']):self.assertFalse(r.financial_renewal(previous,candidate))
        config,*_=fixtures()
        self.assertIs(s.setup_plan(config)['financial']['renewal'],False)
        self.assertIs(s.setup_plan(config|{'valid_until':'2026-12-04T00:00:00Z'})['financial']['renewal'],True)
        with self.assertRaisesRegex(RuntimeError,'FINANCIAL_EXPIRY'):s.setup_plan(config|{'valid_until':'2026-12-04T00:00:01Z'})

    def test_schedule_exact_window_invoker_retry_and_inactive_readback(self):
        _,b,j,sc,_,e,t=fixtures('SCHEDULED')
        c.gcp_scheduler_guard(b,sc,paused=False)
        for patch in ({'schedule':'1 10 * * *'},{'state':'PAUSED'},{'timeZone':'America/Mexico_City'},
                      {'retryConfig':{'retryCount':1}}):
            with self.subTest(patch=patch),self.assertRaises(RuntimeError):c.gcp_scheduler_guard(b,sc|patch,paused=False)
        wrong=copy.deepcopy(sc);wrong['httpTarget']['body']='eyJvdmVycmlkZXMiOnt9fQ=='
        with self.assertRaises(RuntimeError):c.gcp_scheduler_guard(b,wrong,paused=False)
        late=NOW+dt.timedelta(minutes=26);e['createTime']=late.isoformat()
        with self.assertRaisesRegex(RuntimeError,'WINDOW'):c.gcp_execution_guard(b,j,e,t,late)

    def test_scheduler_materialized_defaults_are_closed_and_content_type_is_explicit(self):
        config,binding,job,scheduler,*_=fixtures()
        g=copy.deepcopy(scheduler);g['httpTarget']['headers']['User-Agent']='Google-Cloud-Scheduler'
        s.readback(config,TOKEN,lambda url,_:job if 'run.googleapis' in url else g)
        for patch in ({'minBackoffDuration':'6s'},{'maxBackoffDuration':'4000s'},{'maxDoublings':6},{'maxRetryDuration':'1s'}):
            changed=copy.deepcopy(g);changed['retryConfig'].update(patch)
            with self.subTest(patch=patch),self.assertRaises(RuntimeError):c.gcp_scheduler_guard(binding,changed,paused=True)
        g['httpTarget']['headers']['Authorization']='unexpected'
        with self.assertRaises(RuntimeError):c.gcp_scheduler_guard(binding,g,paused=True)

    def test_setup_does_not_emit_resource_mutation_and_keeps_cleanup_explicit(self):
        config,*_=fixtures();plan=s.setup_plan(config)
        self.assertEqual(plan['cloud_mutations'],0);self.assertFalse(plan['auto_activate'])
        self.assertTrue(plan['expiry_cleanup']['future_operator_execution_required'])
        self.assertFalse(plan['expiry_cleanup']['automatic']);self.assertEqual(plan['extra_components'],[])
        self.assertIn('2026-11-03T23:30:00+00:00',plan['iam_required'][0]['condition'])
        self.assertEqual(plan['scheduler']['schedule'],'0 10 * * *')
        changed=dict(config,image='transport:latest')
        with self.assertRaises(RuntimeError):s.setup_plan(changed)

    def test_native_google_is_requested_by_root_and_oslogin_caller_checked(self):
        _,b,j,sc,p,e,t=fixtures();calls=[]
        def getter(url,token):
            calls.append((url,token));return p if 'oslogin.' in url else sc if 'cloudscheduler.' in url else t if '/tasks/' in url else e if '/executions/' in url else j
        with mock.patch.object(r,'google_get',side_effect=getter),mock.patch.dict(os.environ,{'SUDO_UID':'2001'}),mock.patch.object(r.pwd,'getpwuid',return_value=SimpleNamespace(pw_name='sa_synthetic')):
            actual=r.google_observation(b,TOKEN,execution=e['name'],require_login=True)
            self.assertEqual(len(calls),5);self.assertEqual(actual['oslogin']['uid'],2001)
            self.assertNotIn('posixAccounts',json.dumps(actual));self.assertTrue(all(token==TOKEN for _,token in calls))
            with mock.patch.dict(os.environ,{'SUDO_UID':'2002'}),self.assertRaisesRegex(RuntimeError,'CALLER_IDENTITY'):
                r.google_observation(b,TOKEN,execution=e['name'],require_login=True)

    def test_google_endpoint_redirect_and_transport_error_do_not_expose_token(self):
        for url in ('https://attacker.invalid/','http://run.googleapis.com/','https://run.googleapis.com/v2/'+c.GCP_JOB+'?token='+TOKEN):
            with self.assertRaisesRegex(RuntimeError,'ENDPOINT'):r.google_get(url,TOKEN)
        with mock.patch('urllib.request.build_opener',return_value=SimpleNamespace(open=mock.Mock(side_effect=OSError(TOKEN)))):
            with self.assertRaises(RuntimeError) as caught:r.google_get('https://run.googleapis.com/v2/'+c.GCP_JOB,TOKEN)
            self.assertEqual(str(caught.exception),'B02_GOOGLE_READ_FAILED');self.assertNotIn(TOKEN,str(caught.exception))

    def test_claim_trigger_ref_validates_original_immutable_binding(self):
        _,b,j,_,p,e,t=fixtures();context=c.gcp_execution_guard(b,j,e,t,NOW);run=context['run_id']
        permit={'schema_version':1,'kind':'B02_GCP_AUTHORIZATION','context':context,'binding':b,
            'issued_at':NOW.isoformat(),'expires_at':(NOW+dt.timedelta(seconds=120)).isoformat(),
            'binding_ref':{'path':str(r.GCP_BINDING_PATH),'bytes':len(c.canonical(b)),'sha256':c.sha256(c.canonical(b))},
            'google_observation_sha256':'a'*64,'caller':{'name':b['executor_id'],'uid':b['oslogin_uid'],'username':b['oslogin_username']}}
        permitref={'path':str(r.GCP_PERMITS/(run+'.json')),'bytes':12,'sha256':'d'*64}
        claimref={'path':str(r.GCP_CLAIMS/(c.sha256(('manual:'+UID).encode())+'.json')),'bytes':12,'sha256':'c'*64}
        claim={'schema_version':1,'slot_key':'manual:'+UID,'authorization_ref':permitref,'run_id':run}
        report={'run_id':run,'source_sha':b['source_sha'],'plan_sha256':b['plan_sha256'],
            'trigger':{'authorization_ref':permitref,'claim_ref':claimref}}
        with mock.patch.object(r,'ref_read',side_effect=lambda ref:c.canonical(permit if ref==permitref else claim)):
            self.assertEqual(r.verify_trigger_journal(report)['binding'],b)
            with self.assertRaisesRegex(RuntimeError,'TRIGGER_CHANGED'):r.verify_trigger_journal(report|{'source_sha':'f'*40})
            permit['binding']=b|{'schedule_utc':'11:00'}
            with self.assertRaisesRegex(RuntimeError,'ARCHIVE_CHANGED'):r.verify_trigger_journal(report)


class RootCutoverAndAuthorization(unittest.TestCase):
    def test_duplicate_slot_and_lost_authorization_never_start_a_backup(self):
        _,b,j,sc,p,e,t=fixtures('SCHEDULED')
        class Clock(dt.datetime):
            @classmethod
            def now(cls,tz=None):return NOW
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);permits=base/'permits';permits.mkdir();claims=base/'claims';claims.mkdir();runs=base/'runs';runs.mkdir()
            runner=SimpleNamespace(runs=runs,report=mock.Mock(),plan_sha256=b['plan_sha256'])
            observed={'job':j,'scheduler':sc,'execution':e,'task':t,'oslogin':{'uid':2001}}
            with contextlib.ExitStack() as stack:
                for name,value in [('GCP_PERMITS',permits),('GCP_CLAIMS',claims)]:stack.enter_context(mock.patch.object(r,name,value))
                stack.enter_context(mock.patch.object(r.dt,'datetime',Clock));stack.enter_context(mock.patch.object(r,'controller_update_locks',return_value=contextlib.nullcontext()))
                stack.enter_context(mock.patch.object(r,'read_gcp_binding',return_value=b));stack.enter_context(mock.patch.object(r,'google_observation',return_value=observed))
                stack.enter_context(mock.patch.object(r,'private_directory',side_effect=lambda p:p));stack.enter_context(mock.patch.object(r,'read_file',side_effect=lambda p:p.read_bytes()))
                stack.enter_context(mock.patch.object(r,'file_reference',return_value={'path':'/synthetic/binding','bytes':1,'sha256':'a'*64}))
                slot=c.GCP_SCHEDULER+':'+NOW.replace(minute=0,second=0,microsecond=0).isoformat()
                (claims/(c.sha256(slot.encode())+'.json')).write_text('{}')
                with self.assertRaisesRegex(RuntimeError,'SLOT_ALREADY_CLAIMED'):r.gcp_authorize(runner,{'access_token':TOKEN,'execution':e['name']})
                (permits/'lost.json').write_text(json.dumps({'context':{'run_id':c.gcp_run_identity(UID)}}))
                with self.assertRaisesRegex(RuntimeError,'PRIOR_AUTHORIZATION_UNCONFIRMED'):r.gcp_authorize(runner,{'access_token':TOKEN,'execution':e['name']})
                runner.report.assert_not_called()

    def test_apply_compare_and_swap_preserves_prewrite_on_partial_failure(self):
        _,b,*_=fixtures();plan={'schedule_enabled':False};state={'b02_plan_sha256':'a'*64}
        facts={'binding':b,'plan_before_ref':{'path':str(r.DAILY/'plan.json')},'state_before_ref':{'path':str(r.PRIVATE/'api-web-adoption.json')},
            'binding_before_ref':None,'plan_after':plan,'state_after':state}
        directory=r.GCP_UPDATES/b['activation_id'];observation={'created_at':NOW.isoformat(),'facts':facts}
        contents={directory/'observation.json':c.canonical(observation),r.DAILY/'plan.json':b'oldplan',r.PRIVATE/'api-web-adoption.json':b'oldstate'}
        def ref(path):raw=contents[path];return {'path':str(path),'sha256':c.sha256(raw),'bytes':len(raw)}
        contents[directory/'seal.json']=c.canonical({'status':'SEALED','observation_ref':ref(directory/'observation.json')})
        events=[]
        def write(path,raw,replace=False):
            events.append((str(path),replace));contents[path]=raw
            if path==r.PRIVATE/'api-web-adoption.json':raise RuntimeError('SYNTHETIC_CRASH')
        class Clock(dt.datetime):
            @classmethod
            def now(cls,tz=None):return NOW
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(r.dt,'datetime',Clock));stack.enter_context(mock.patch.object(r,'controller_update_locks',return_value=contextlib.nullcontext()))
            stack.enter_context(mock.patch.object(r,'cutover_facts',return_value=facts));stack.enter_context(mock.patch.object(r,'read_file',side_effect=lambda path:contents[path]))
            stack.enter_context(mock.patch.object(r,'ref_read',side_effect=lambda item:contents[Path(item['path'])]));stack.enter_context(mock.patch.object(r,'file_reference',side_effect=ref))
            stack.enter_context(mock.patch.object(r,'write_private',side_effect=write));stack.enter_context(mock.patch.object(r,'json_write',side_effect=lambda path,value,replace=False:write(path,c.canonical(value),replace)))
            with self.assertRaisesRegex(RuntimeError,'SYNTHETIC_CRASH'):
                r.schedule_cutover(SimpleNamespace(runtime_guard=mock.Mock()),'gcp-apply',{'access_token':TOKEN,'binding':b},c.sha256(contents[directory/'observation.json']))
        self.assertEqual(json.loads(contents[directory/'journal.json'])['status'],'PREWRITE')
        self.assertEqual(contents[directory/'plan.before.json'],b'oldplan');self.assertEqual(contents[directory/'state.before.json'],b'oldstate')
        self.assertNotIn(r.GCP_BINDING_PATH,contents)

    def test_scheduled_proposal_uses_native_plan_hash_and_performs_no_write(self):
        _,binding,*_=fixtures();runner=SimpleNamespace(plan={'schedule_enabled':False,'sentinel':'preserved'})
        first={'path':'/synthetic/journal.json','bytes':5,'sha256':'b'*64}
        with mock.patch.object(r,'controller_update_locks',return_value=contextlib.nullcontext()),mock.patch.object(r,'read_gcp_binding',return_value=binding),mock.patch.object(r,'cutover_facts',return_value={'verified':True}) as guard,mock.patch.object(r,'write_private') as write:
            actual=r.propose_scheduled_binding(runner,{'access_token':TOKEN,'activation_id':'synthetic-schedule-2','first_custody_ref':first})
            candidate=actual['binding'];self.assertEqual(candidate['mode'],'SCHEDULED');self.assertEqual(candidate['first_custody_ref'],first)
            self.assertEqual(candidate['plan_sha256'],c.sha256((json.dumps(dict(runner.plan,schedule_enabled=True),sort_keys=True)+'\n').encode()))
            self.assertEqual(candidate['schedule_utc'],binding['schedule_utc']);self.assertFalse(actual['pair_written'])
            write.assert_not_called();guard.assert_called_once()

    def test_review_drift_prevents_any_cutover_write(self):
        _,b,*_=fixtures();directory=r.GCP_UPDATES/b['activation_id'];raw=c.canonical({'created_at':NOW.isoformat(),'facts':{'old':1}})
        with mock.patch.object(r,'controller_update_locks',return_value=contextlib.nullcontext()),mock.patch.object(r,'cutover_facts',return_value={'new':2}),mock.patch.object(r,'read_file',return_value=raw),mock.patch.object(r,'write_private') as write:
            with self.assertRaisesRegex(RuntimeError,'REVIEW_CHANGED'):r.schedule_cutover(None,'gcp-apply',{'access_token':TOKEN,'binding':b},c.sha256(raw))
            write.assert_not_called()

    def test_legacy_shared_rolling_limit_counts_all_sources(self):
        records=[{'run_id':str(i)+'-1','started_at':NOW.isoformat(),'status':'FAILED',
                  'source_sha':'a'*40,'scheduled':False} for i in range(36)]
        c.check_run_budget(records,NOW)
        records.append({'run_id':c.gcp_run_identity(UID),'started_at':NOW.isoformat(),'status':'SUCCEEDED',
                        'source_sha':'b'*40,'scheduled':True})
        with self.assertRaisesRegex(RuntimeError,'30_DAY_RUN_LIMIT'):c.check_run_budget(records,NOW)
        c.check_run_budget(records[1:],NOW)


class TransportContainment(unittest.TestCase):
    def test_environment_cannot_impersonate_github_or_retry_task(self):
        env={'CLOUD_RUN_JOB':'commerce-b02-daily','CLOUD_RUN_EXECUTION':'commerce-b02-daily-abcde',
            'CLOUD_RUN_TASK_INDEX':'0','CLOUD_RUN_TASK_COUNT':'1','CLOUD_RUN_TASK_ATTEMPT':'0','B02_SOURCE_SHA':'a'*40}
        t.cloud_environment(env)
        for patch in ({'GITHUB_RUN_ID':'123'},{'CLOUD_RUN_TASK_ATTEMPT':'1'},{'CLOUD_RUN_TASK_COUNT':'2'}):
            with self.assertRaises(RuntimeError):t.cloud_environment(env|patch)

    def test_transport_deadline_prevents_dispatch_and_bounds_single_call(self):
        client=t.Transport.__new__(t.Transport);client.clock=lambda:100;client.deadline=120;client.runner=mock.Mock(return_value=SimpleNamespace(returncode=0))
        client.command(['synthetic'],timeout=900);self.assertEqual(client.runner.call_args.kwargs['timeout'],15)
        client.deadline=105
        with self.assertRaisesRegex(RuntimeError,'GLOBAL_DEADLINE'):client.command(['synthetic'])
        self.assertEqual(client.runner.call_count,1)

    def test_journal_is_exclusive_and_durable_before_dispatch(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'intent.json';t.durable_json(path,{'attempt':1})
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            with self.assertRaises(FileExistsError):t.durable_json(path,{'attempt':2})
            self.assertEqual(json.loads(path.read_bytes()),{'attempt':1})

    def test_timeout_kills_only_its_own_process_group_including_grandchild(self):
        with tempfile.TemporaryDirectory() as temp:
            marker=Path(temp)/'pids.json'
            childcode='import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'
            code='import subprocess,sys,os,time,json,signal\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\np=subprocess.Popen([sys.executable,"-c",sys.argv[2]])\nopen(sys.argv[1],"w").write(json.dumps([os.getpid(),p.pid]))\ntime.sleep(60)'
            unrelated=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],start_new_session=True)
            try:
                with self.assertRaisesRegex(RuntimeError,'UNKNOWN'):t.common.command([sys.executable,'-c',code,str(marker),childcode],timeout=0.5)
                self.assertIsNone(unrelated.poll());pids=json.loads(marker.read_text())
                for pid in pids:
                    result=subprocess.run(['ps','-p',str(pid),'-o','stat='],text=True,capture_output=True)
                    self.assertTrue(result.returncode!=0 or result.stdout.strip().startswith('Z'),result.stdout)
            finally:
                unrelated.terminate();unrelated.wait(timeout=5)


class FullTransportLocalDouble(unittest.TestCase):
    def exercise(self, *, scp_failure=False, upload_unknown=False, dispatch_unknown=False, ack_unknown=False, ack_drift=False, initial_remaining=1695):
        config,b,*_=fixtures();run=c.gcp_run_identity(UID)
        payloads={'ciphertext.backup.aes':b'COMOSB02'+b'x'*50,'portal.backup.aes':b'COMOSP01'+b'y'*50,
            'source.json':b'{"synthetic_source":true}','backup.json':b'{"synthetic_backup":true}'}
        portal={'source_sha':'f'*40,'run_id':'77-1','image':'sha256:'+'e'*64,'proxy_network':'commerce-os_proxy',
            'format':'COMOSP01','private_files':14,'sqlite_snapshot_consistent':True}
        report={'run_id':run,'source_sha':b['source_sha'],'plan_sha256':b['plan_sha256'],'status':'LOCAL_CUSTODY_PENDING',
            'backup_contract_version':2,'portal_capsule':portal,
            'exports':{name:{'bytes':len(raw),'sha256':c.sha256(raw)} for name,raw in payloads.items()}}
        authorized={'status':'B02_GCP_AUTHORIZED','run_id':run,'source_sha':b['source_sha'],'plan_sha256':b['plan_sha256'],
            'scheduled':False,'trigger_ref':{'path':'/synthetic/permit','bytes':1,'sha256':'a'*64},
            'claim_ref':{'path':'/synthetic/claim','bytes':1,'sha256':'b'*64}}
        bucket={'name':b['bucket'],'projectNumber':c.PROJECT_NUMBER,'location':'US-EAST1','storageClass':'STANDARD',
            'iamConfiguration':{'publicAccessPrevention':'enforced','uniformBucketLevelAccess':{'enabled':True}},
            'lifecycle':{'rule':[{'action':{'type':'Delete'},'condition':{'age':30}}]},
            'softDeletePolicy':{'retentionDurationSeconds':'604800'}}
        counts={'dispatch':0,'status':0,'ack':0,'discard':0,'upload':0,'download':0,'scp':0,'https_upload':0};objects={}
        with tempfile.TemporaryDirectory() as temporary:
            client=t.Transport.__new__(t.Transport);client.clock=time.monotonic;client.deadline=time.monotonic()+initial_remaining
            client.execution=c.GCP_JOB+'/executions/commerce-b02-daily-abcde';client.source=b['source_sha']
            client.work=Path(temporary);client.key=client.work/'iap-key';client.registered=False;client.acknowledged=False
            client.base=[];client.root='sudo synthetic-root'
            def response(value=''):return SimpleNamespace(returncode=0,stdout=json.dumps(value) if isinstance(value,dict) else value,stderr='')
            def ssh(command,**kwargs):
                if ' gcp-binding' in command:return response(b)
                if ' gcp-authorize' in command:
                    self.assertEqual(json.loads(kwargs['input'])['access_token'],TOKEN);return response(authorized)
                if ' status' in command:
                    counts['status']+=1;return response({'status':'NOT_STARTED','run_id':run,'plan_sha256':b['plan_sha256']} if counts['status']==1 else report)
                if 'systemctl show' in command:return response('LoadState=not-found\nActiveState=inactive\nMainPID=0\n')
                if 'systemd-run' in command:
                    counts['dispatch']+=1;self.assertTrue((client.work/'dispatch-intent.json').exists())
                    if dispatch_unknown:raise RuntimeError('B02_TRANSPORT_UNKNOWN_PRESERVE')
                if ' gcp-upload-object' in command:
                    counts['https_upload']+=1
                    request=json.loads(kwargs['input']);name=request['name']
                    self.assertEqual(set(request),{'name','session_uri','timeout_seconds'})
                    self.assertIs(type(request['timeout_seconds']),int);self.assertLessEqual(request['timeout_seconds'],900)
                    self.assertLessEqual(request['timeout_seconds'],initial_remaining-10)
                    self.assertEqual(kwargs['timeout'],request['timeout_seconds']+5)
                    self.assertNotIn(request['session_uri'],command);self.assertNotIn(TOKEN,kwargs['input'])
                    self.assertTrue((client.work/('transfer-'+name+'.intent.json')).exists())
                    if upload_unknown:raise RuntimeError('B02_ROOT_UPLOAD_UNKNOWN_PRESERVE')
                    objects['gs://'+b['bucket']+'/b02/daily/'+run+'/'+name]=payloads[name]
                    return response({'status':'B02_CIPHERTEXT_OBJECT_UPLOADED','run_id':run,'name':name,
                                     'bytes':len(payloads[name]),'sha256':c.sha256(payloads[name])})
                if ' ack' in command:
                    counts['ack']+=1
                    if ack_unknown:raise RuntimeError('B02_TRANSPORT_UNKNOWN_PRESERVE')
                    return response(report|{'status':'SUCCEEDED','external_copy_verified':True}|({'run_id':'other'} if ack_drift else {}))
                if ' discard-export' in command:counts['discard']+=1
                return response()
            def command(args,**kwargs):
                if args[:4]==['gcloud','compute','instances','describe']:
                    return response({'id':c.VM_ID,'name':c.TARGET[1],'zone':'https://www.googleapis.com/compute/v1/projects/'+c.TARGET[0]+'/zones/'+c.TARGET[2],'status':'RUNNING'})
                if args[:4]==['gcloud','storage','buckets','describe']:return response(bucket)
                if args[:3]==['gcloud','compute','scp']:
                    counts['scp']+=1
                    if scp_failure:raise RuntimeError('B02_TRANSPORT_UNKNOWN_PRESERVE')
                    if ':~/' in args[-2]:
                        path=Path(args[-1]);path.write_bytes(payloads[Path(args[-2]).name]);path.chmod(0o600)
                    return response()
                if args[:3]==['gcloud','storage','cp']:
                    if '--if-generation-match=0' in args:
                        counts['upload']+=1;objects[args[-2]]=Path(args[-3]).read_bytes()
                    else:
                        counts['download']+=1;uri=args[3].split('#')[0];Path(args[4]).write_bytes(objects[uri])
                    return response()
                if args[:4]==['gcloud','storage','objects','describe']:
                    return response({'generation':'1','size':str(len(objects[args[4]])),'bucket':b['bucket'],'name':args[4].split('/',3)[3]})
                return response()
            client.ssh=ssh;client.runner=command
            def session(bucket,name,expected,token,**kwargs):
                self.assertEqual(bucket,b['bucket']);self.assertEqual(token,TOKEN)
                return 'https://storage.googleapis.com/synthetic-session/'+name+'?upload_id=synthetic-secret'
            with mock.patch.object(t,'metadata_token',return_value=TOKEN),mock.patch.object(t,'create_resumable_session',side_effect=session):
                if scp_failure or upload_unknown or ack_unknown or ack_drift:
                    with self.assertRaisesRegex(RuntimeError,'UNKNOWN'):client.run()
                else:
                    result=client.run();self.assertEqual(result['status'],'B02_GCP_OFFSITE_VERIFIED')
                    self.assertIs(result['scheduled_delivery_proven'],False);self.assertIs(result['restore_verified'],False)
            self.assertEqual(counts['dispatch'],1)
            for path in client.work.iterdir():
                if path.is_file():
                    self.assertNotIn(b'upload_id=synthetic-secret',path.read_bytes());self.assertNotIn(TOKEN.encode(),path.read_bytes())
            return counts

    def test_four_exports_five_full_readbacks_ack_and_discard(self):
        self.assertEqual(self.exercise(),{'dispatch':1,'status':3,'ack':1,'discard':1,'upload':1,'download':5,'scp':1,'https_upload':4})

    def test_remaining_global_budget_reaches_root_fuse(self):
        self.assertEqual(self.exercise(initial_remaining=16)['https_upload'],4)

    def test_unknown_dispatch_is_read_only_reconciled_without_another_start(self):
        self.assertEqual(self.exercise(dispatch_unknown=True)['dispatch'],1)

    def test_scp_failure_does_not_create_another_dump_or_custody_claim(self):
        counts=self.exercise(scp_failure=True);self.assertEqual(counts['ack'],0);self.assertEqual(counts['upload'],1)
        self.assertEqual(counts['https_upload'],4)

    def test_unknown_root_upload_never_repeats_put_or_claims_custody(self):
        counts=self.exercise(upload_unknown=True);self.assertEqual(counts['https_upload'],1)
        self.assertEqual(counts['ack'],0);self.assertEqual(counts['download'],0)

    def test_wrong_ack_identity_is_rejected_without_discard_or_success(self):
        counts=self.exercise(ack_drift=True);self.assertEqual(counts['ack'],1);self.assertEqual(counts['discard'],0)

    def test_unknown_ack_is_not_retried_and_export_is_preserved(self):
        counts=self.exercise(ack_unknown=True);self.assertEqual(counts['ack'],1);self.assertEqual(counts['discard'],0)


class NeverStartedAuthorizationReconciliation(unittest.TestCase):
    def exercise(self, *, failure=None, claim_present=True):
        _,binding,job,scheduler,profile,execution,task=fixtures()
        context=c.gcp_execution_guard(binding,job,execution,task,NOW);run=context['run_id']
        completed=(NOW+dt.timedelta(minutes=3)).isoformat();execution['completionTime']=completed;task['completionTime']=completed
        if failure=='running_task':task.pop('completionTime')
        if failure=='wrong_execution':execution['uid']=JOBUID
        current=NOW+dt.timedelta(minutes=10)
        if failure=='valid_permit':current=NOW+dt.timedelta(seconds=60)
        class Clock(dt.datetime):
            @classmethod
            def now(cls,tz=None):return current
        with tempfile.TemporaryDirectory() as temporary,contextlib.ExitStack() as stack:
            base=Path(temporary);permits=base/'permits';permits.mkdir();claims=base/'claims';claims.mkdir();resolutions=base/'resolutions';resolutions.mkdir();runs=base/'runs';runs.mkdir()
            pointer=base/'binding.json';pointer.write_bytes(c.canonical(binding));permitpath=permits/(run+'.json')
            def ref(path):raw=Path(path).read_bytes();return {'path':str(path),'bytes':len(raw),'sha256':c.sha256(raw)}
            def write(path,value,replace=False):
                with open(path,'x') as stream:json.dump(value,stream)
            permit={'schema_version':1,'kind':'B02_GCP_AUTHORIZATION','context':context,'binding':binding,
                'issued_at':NOW.isoformat(),'expires_at':(NOW+dt.timedelta(seconds=120)).isoformat(),
                'binding_ref':ref(pointer),'google_observation_sha256':'a'*64,
                'caller':{'name':profile['name'],'uid':binding['oslogin_uid'],'username':binding['oslogin_username']}}
            permitpath.write_bytes(c.canonical(permit));slot='manual:'+UID;claimpath=claims/(c.sha256(slot.encode())+'.json')
            if claim_present:write(claimpath,{'schema_version':1,'slot_key':slot,'run_id':run,'authorization_ref':ref(permitpath)})
            if failure=='existing_run':(runs/run).mkdir()
            runner=SimpleNamespace(runs=runs,runtime_guard=mock.Mock())
            state='LoadState=not-found\nActiveState=inactive\nMainPID=0\n'
            if failure=='active_unit':state='LoadState=loaded\nActiveState=active\nMainPID=123\n'
            for name,value in [('GCP_BINDING_PATH',pointer),('GCP_PERMITS',permits),('GCP_CLAIMS',claims),('GCP_RESOLUTIONS',resolutions)]:stack.enter_context(mock.patch.object(r,name,value))
            stack.enter_context(mock.patch.object(r.dt,'datetime',Clock));stack.enter_context(mock.patch.object(r,'controller_update_locks',return_value=contextlib.nullcontext()))
            stack.enter_context(mock.patch.object(r,'read_gcp_binding',return_value=binding));stack.enter_context(mock.patch.object(r,'google_observation',return_value={'job':job,'scheduler':scheduler,'execution':execution,'task':task}))
            stack.enter_context(mock.patch.object(r,'read_file',side_effect=lambda path:Path(path).read_bytes()));stack.enter_context(mock.patch.object(r,'ref_read',side_effect=lambda item:Path(item['path']).read_bytes()))
            stack.enter_context(mock.patch.object(r,'file_reference',side_effect=ref));stack.enter_context(mock.patch.object(r,'json_write',side_effect=write));stack.enter_context(mock.patch.object(r,'private_directory',side_effect=lambda path:path))
            host=stack.enter_context(mock.patch.object(r.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=state)))
            request={'run_id':run,'access_token':TOKEN}
            if failure:
                with self.assertRaises(RuntimeError):r.reconcile_authorization(runner,request)
                self.assertEqual(list(resolutions.iterdir()),[]);return
            result=r.reconcile_authorization(runner,request);self.assertEqual(result['status'],'NO_BACKUP_STARTED')
            self.assertTrue(claimpath.exists());self.assertFalse((runs/run).exists());self.assertEqual(len(list(resolutions.iterdir())),1)
            r.authorization_terminal(permitpath,permit,[])
            self.assertEqual(host.call_args.args[0][0:2],['systemctl','show'])
            with self.assertRaises(FileExistsError):r.reconcile_authorization(runner,request)
            changed=json.loads((resolutions/(run+'.json')).read_text());changed['execution_uid']=JOBUID
            (resolutions/(run+'.json')).write_text(json.dumps(changed))
            with self.assertRaisesRegex(RuntimeError,'RECONCILIATION_CHANGED'):r.authorization_terminal(permitpath,permit,[])

    def test_terminal_execution_no_unit_no_dump_closes_permission_but_preserves_slot(self):self.exercise()
    def test_crash_after_permit_before_claim_preserves_original_slot_without_backup(self):self.exercise(claim_present=False)
    def test_live_or_changed_evidence_never_creates_a_resolution(self):
        for failure in ('running_task','wrong_execution','valid_permit','existing_run','active_unit'):
            with self.subTest(failure=failure):self.exercise(failure=failure)


class CutoverNativeFacts(unittest.TestCase):
    def exercise(self, *, drift=None, renewal_until=None):
        _,binding,*_=fixtures();plan={'schedule_enabled':False,'preserved':'unchanged'}
        raw=(json.dumps(plan,sort_keys=True)+'\n').encode();binding['plan_sha256']=c.sha256(raw)
        class Clock(dt.datetime):
            @classmethod
            def now(cls,tz=None):return NOW
        with tempfile.TemporaryDirectory() as temporary,contextlib.ExitStack() as stack:
            private=Path(temporary);daily=private/'daily-b02';daily.mkdir();runs=daily/'runs';runs.mkdir();directory=runs/c.gcp_run_identity(UID);directory.mkdir()
            pointer=daily/'gcp-binding.json';pointer.write_bytes(c.canonical(binding));(daily/'plan.json').write_bytes(raw)
            state_raw=c.canonical({'b02_plan_sha256':c.sha256(raw),'sentinel':'preserved'});(private/'api-web-adoption.json').write_bytes(state_raw)
            first={'kind':'DAILY_B02','run_id':directory.name,'status':'SUCCEEDED','external_copy_verified':True,
                'source_sha':binding['source_sha'],'plan_sha256':c.sha256(raw),'cleanup':{'runtime_preserved':True,'owned_plaintext_removed':True},
                'trigger':{'synthetic':True},'exports':{name:{'bytes':10,'sha256':'a'*64} for name in c.BASE_EXPORTS}}
            if drift=='unfinished':first['status']='LOCAL_CUSTODY_PENDING'
            if drift=='cleanup':first['cleanup']['owned_plaintext_removed']=False
            path=directory/'journal.json';path.write_bytes(c.canonical(first))
            def ref(path):value=Path(path).read_bytes();return {'path':str(path),'bytes':len(value),'sha256':c.sha256(value)}
            candidate=binding|{'mode':'SCHEDULED','activation_id':'synthetic-activate-2','first_custody_ref':ref(path),
                'plan_sha256':c.sha256((json.dumps(dict(plan,schedule_enabled=True),sort_keys=True)+'\n').encode())}
            if drift=='clock':candidate['schedule_utc']='11:00'
            if drift=='renewal':candidate['valid_until']='2026-11-03T00:00:00Z'
            if drift=='plan':candidate['plan_sha256']='f'*64
            if renewal_until:candidate=binding|{'valid_until':renewal_until,'activation_id':'synthetic-renewal-1'}
            runner=SimpleNamespace(runs=runs,plan=plan,plan_sha256=c.sha256(raw),report=lambda _:first)
            for name,value in [('PRIVATE',private),('DAILY',daily),('GCP_BINDING_PATH',pointer),('GCP_PERMITS',daily/'none')]:stack.enter_context(mock.patch.object(r,name,value))
            stack.enter_context(mock.patch.object(r.dt,'datetime',Clock));stack.enter_context(mock.patch.object(r,'schedule_terminal_guard'))
            stack.enter_context(mock.patch.object(r,'gcp_pair',return_value=state_raw));stack.enter_context(mock.patch.object(r,'read_file',side_effect=lambda path:Path(path).read_bytes()))
            stack.enter_context(mock.patch.object(r,'ref_read',side_effect=lambda item:Path(item['path']).read_bytes()));stack.enter_context(mock.patch.object(r,'file_reference',side_effect=ref))
            stack.enter_context(mock.patch.object(r,'verify_trigger_journal',return_value={'context':{'mode':'MANUAL','binding_sha256':c.sha256(c.canonical(binding))}}))
            observed=stack.enter_context(mock.patch.object(r,'google_observation',return_value={'synthetic_native':True}))
            if drift:
                with self.assertRaises(RuntimeError):r.cutover_facts(runner,candidate,TOKEN)
                observed.assert_not_called()
            else:
                facts=r.cutover_facts(runner,candidate,TOKEN)
                self.assertEqual(facts['plan_after'],dict(plan,schedule_enabled=renewal_until is None));self.assertEqual(facts['state_after']['sentinel'],'preserved')
                self.assertEqual(pointer.read_bytes(),c.canonical(binding));self.assertEqual((daily/'plan.json').read_bytes(),raw)
                self.assertIs(observed.call_args.kwargs['paused'],True)

    def test_scheduled_facts_preserve_pair_until_sealed_apply(self):self.exercise()
    def test_first_custody_cleanup_clock_financial_and_plan_drift_block_activation(self):
        for drift in ('unfinished','cleanup','clock','renewal','plan'):
            with self.subTest(drift=drift):self.exercise(drift=drift)

    def test_owner_renewal_rebinds_manual_until_december_4_only(self):
        self.exercise(renewal_until='2026-12-04T00:00:00Z')
        for until in ('2026-11-20T00:00:00Z','2026-12-04T00:00:01Z','2026-11-03T00:00:00Z'):
            with self.subTest(until=until):self.exercise(drift='renewal-other',renewal_until=until)

    def test_publication_blocks_unreconciled_permission_and_partial_cutover(self):
        import copy_runtime_deployment as runtime
        with tempfile.TemporaryDirectory() as temporary:
            private=Path(temporary);(private/'deployments').mkdir();daily=private/'daily-b02';daily.mkdir();(daily/'runs').mkdir()
            permits=daily/'gcp-authorizations';permits.mkdir();run=c.gcp_run_identity(UID);path=permits/(run+'.json')
            raw=c.canonical({'context':{'run_id':run,'execution_uid':UID}});path.write_bytes(raw)
            with mock.patch.object(runtime.native,'protected_bytes',side_effect=lambda p:Path(p).read_bytes()):
                with self.assertRaises(FileNotFoundError):runtime.terminal_journals(private,{},None)
                resolutions=daily/'gcp-authorization-reconciliations';resolutions.mkdir()
                (resolutions/(run+'.json')).write_bytes(c.canonical({'status':'NO_BACKUP_STARTED','run_id':run,'execution_uid':UID,
                    'authorization_ref':{'path':str(path),'bytes':len(raw),'sha256':c.sha256(raw)},'slot_preserved':True,'backup_started':False}))
                runtime.terminal_journals(private,{},None)
                updates=daily/'scheduler-updates';updates.mkdir();review=updates/'synthetic';review.mkdir();(review/'journal.json').write_text('{"status":"PREWRITE"}')
                with self.assertRaisesRegex(Exception,'CUTOVER_UNCONFIRMED'):runtime.terminal_journals(private,{},None)


if __name__=='__main__':unittest.main()
