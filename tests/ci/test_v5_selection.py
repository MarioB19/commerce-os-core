import importlib.util,unittest,json,io,tempfile,re
from pathlib import Path
from contextlib import redirect_stdout
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('selection',Path(__file__).resolve().parents[2]/'scripts/ci-changes.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class SoftwareBaselineTests(unittest.TestCase):
 repository='MarioB19/commerce-os'
 prefix='https://github.com/'+repository+'/actions/runs/'
 def automatic(self,sha='a'*40,name='deploy'):
  deployment={'id':10,'sha':sha,'payload':{}}
  status={'state':'success','environment_url':'https://commerce-os.inovaris.online','log_url':self.prefix+'100/job/200'}
  job={'name':name,'workflow_name':'Commerce OS CI/CD','status':'completed','conclusion':'success','head_sha':sha,'run_id':100,'html_url':status['log_url']}
  return deployment,status,job
 def manual(self):
  deployment={'id':9,'sha':'b'*40,'payload':{'installer_status':'SUCCEEDED','source_sha':'b'*40,'archive_sha256':'c'*64,'installation_run_id':'90-1','verification':'Canonical installer and HTTPS readback verified.'}}
  status={'state':'success','environment_url':'https://commerce-os.inovaris.online','log_url':self.prefix+'90'}
  return deployment,status
 def test_successful_backup_same_head_does_not_hide_pending_application(self):
  backup={'id':10,'sha':'a'*40,'payload':{}}
  backup_status={'state':'success','environment_url':'','log_url':self.prefix+'100/job/200'}
  manual,manual_status=self.manual();calls=[]
  def fetch(path):
   calls.append(path)
   return {'deployments?environment=production&per_page=30':[backup,manual],'deployments/10/statuses?per_page=1':[backup_status],'deployments/9/statuses?per_page=1':[manual_status]}[path]
  baseline=m.deployed_baseline(fetch,self.repository)
  self.assertEqual(baseline,'b'*40)
  selected=m.select('workflow_dispatch','refs/heads/main',baseline,['apps/api/src/account-security.ts'],mode='release')
  self.assertEqual((selected['deploy'],selected['scope']),('true','full'))
  self.assertFalse(any(path.startswith('actions/jobs/')for path in calls))
 def test_only_completed_matching_software_job_can_supply_automatic_baseline(self):
  d,s,j=self.automatic();self.assertTrue(m.software_installation(d,s,lambda path:j,self.repository))
  for field,values in [('name',['backup','credential','verify']),('workflow_name',['Another workflow',None]),('status',['in_progress','queued']),('conclusion',['failure','cancelled','skipped',None]),('head_sha',['b'*40,None]),('run_id',[99,'100',None]),('html_url',[self.prefix+'100/job/201',None])]:
   for value in values:
    with self.subTest(field=field,value=value):self.assertFalse(m.software_installation(d,s,lambda path:{**j,field:value},self.repository))
 def test_backup_or_credential_job_is_rejected_even_with_software_url(self):
  for name in ['backup','credential']:
   d,s,j=self.automatic(name=name);paths=[]
   def fetch(path):paths.append(path);return j
   self.assertFalse(m.software_installation(d,s,fetch,self.repository));self.assertEqual(paths,['actions/jobs/200'])
 def test_verified_canonical_incident_payload_remains_eligible_without_actions_success(self):
  d,s=self.manual()
  self.assertTrue(m.software_installation(d,s,lambda path:self.fail('Manual receipt must not infer a successful Actions job'),self.repository))
  for key,value in [('installer_status','FAILED'),('source_sha','a'*40),('archive_sha256','not-a-hash'),('installation_run_id','91-1'),('installation_run_id','90-0'),('verification','')]:
   with self.subTest(key=key):self.assertFalse(m.software_installation({**d,'payload':{**d['payload'],key:value}},s,lambda path:{},self.repository))
 def test_log_links_are_bound_to_repository_and_exact_run_job(self):
  d,s,j=self.automatic()
  for link in ['https://github.com/Other/repo/actions/runs/100/job/200',self.prefix+'100/job/200/extra',self.prefix+'100/job/200?token=x','https://example.invalid/actions/runs/100/job/200','']:
   with self.subTest(link=link):self.assertFalse(m.software_installation(d,{**s,'log_url':link},lambda path:self.fail('Invalid link must not be fetched'),self.repository))
  for url in ['', 'https://ciclo.inovaris.online','http://commerce-os.inovaris.online']:
   with self.subTest(url=url):self.assertFalse(m.software_installation(d,{**s,'environment_url':url},lambda path:self.fail('Wrong application URL must not be fetched'),self.repository))
 def test_unknown_or_malformed_history_uses_conservative_full_release(self):
  for deployments in [[],None,[None],[{'id':True,'sha':'a'*40}],[{'id':'10','sha':'a'*40}]]:
   with self.subTest(deployments=deployments):
    baseline=m.deployed_baseline(lambda path:deployments,self.repository);self.assertEqual(baseline,'')
    selected=m.select('workflow_dispatch','refs/heads/main',baseline,[],mode='release',complete=False)
    self.assertEqual((selected['deploy'],selected['scope']),('true','full'))
 def test_unobservable_job_never_converts_environment_success_into_publication(self):
  d,s,j=self.automatic()
  def fetch(path):
   if path.startswith('deployments?'):return[d]
   if path.startswith('deployments/'):return[s]
   raise m.subprocess.CalledProcessError(1,['gh','api'])
  self.assertEqual(m.deployed_baseline(fetch,self.repository),'')
 def test_failed_software_deployment_is_not_a_successful_baseline(self):
  d,s,j=self.automatic()
  for state in ['failure','error','pending','in_progress']:
   def fetch(path):return[d]if path.startswith('deployments?')else[{**s,'state':state}]
   with self.subTest(state=state):self.assertEqual(m.deployed_baseline(fetch,self.repository),'')
 def test_selector_can_read_software_jobs_without_new_write_permissions(self):
  workflow=(Path(__file__).resolve().parents[2]/'.github/workflows/ci.yml').read_text()
  changes=re.search(r'^  changes:\n(.*?)(?=^  [a-z-]+:|\Z)',workflow,re.M|re.S)[1]
  permissions=re.search(r'^    permissions:\n(.*?)(?=^    [a-z-]+:)',changes,re.M|re.S)[1]
  self.assertEqual(dict(re.findall(r'^      ([a-z-]+): ([a-z]+)$',permissions,re.M)),{'contents':'read','deployments':'read','actions':'read'})
class SelectionTests(unittest.TestCase):
 def test_impact_matrix(self):
  for paths,scope in [(['docs/guide.md'],'light'),(['apps/api/src/app.ts'],'full'),(['apps/web/src/main.tsx'],'web'),(['portals/mi-ciclo-listo/src/main.tsx'],'portal'),(['pnpm-lock.yaml'],'full'),(['.github/workflows/ci.yml'],'full'),(['config.md'],'full'),(['docs/old.md','apps/api/renamed.md'],'full'),(['packages/db/migrations/0042.sql'],'full')]:
   with self.subTest(paths=paths):self.assertEqual(m.impact(paths),scope)
  self.assertEqual(m.impact(['docs/a.md'],False),'full')
 def test_dispatch_verify_never_releases_and_release_uses_full_baseline(self):
  self.assertFalse(m.should_deploy('workflow_dispatch','refs/heads/main','a'*40,['apps/api/a.ts'],'verify'))
  self.assertEqual(m.select('workflow_dispatch','refs/heads/main','a'*40,['docs/a.md','apps/api/a.ts'],mode='release')['scope'],'full')
  self.assertEqual(m.select('pull_request','refs/pull/3/merge','a'*40,['apps/api/a.ts'],draft=True)['scope'],'light')
  self.assertFalse(m.should_deploy('push','refs/heads/feature','a'*40,['apps/api/a.ts']))
 def test_credential_and_unknown_dispatch_modes_never_enter_release_selection(self):
  for mode in ['credential','verify','unknown','']:
   for baseline in ['',None,'0'*40,'a'*40]:
    with self.subTest(mode=mode,baseline=baseline):
     self.assertFalse(m.should_deploy('workflow_dispatch','refs/heads/main',baseline,['apps/api/a.ts'],mode))
     self.assertEqual(m.select('workflow_dispatch','refs/heads/main',baseline,['apps/api/a.ts'],mode=mode,complete=False)['deploy'],'false')
  self.assertTrue(m.should_deploy('workflow_dispatch','refs/heads/main','a'*40,['apps/api/a.ts'],'release'))
 def test_final_gate_rejects_every_non_success(self):
  self.assertTrue(m.final_gate('success','success','full'))
  for result in ('failure','cancelled','skipped','',None,'pending'):
   self.assertFalse(m.final_gate(result,'success','full'));self.assertFalse(m.final_gate('success',result,'full'))
  self.assertFalse(m.final_gate('success','success','unknown'))
 def test_already_deployed_sha_does_not_release_twice(self):
  self.assertFalse(m.should_deploy('workflow_dispatch','refs/heads/main','a'*40,[],'release'))
 def test_publication_pause_accepts_only_closed_repository_boolean(self):
  for value,expected in [('',False),('false',False),('true',True)]:
   self.assertEqual(m.publication_paused(value),expected)
  for value in ('TRUE','False','1','yes',' true','true ',None,True):
   with self.subTest(value=value),self.assertRaisesRegex(RuntimeError,'^COMMERCE_DEPLOY_PAUSED_INVALID$'):m.publication_paused(value)
 def test_unknown_pause_fails_before_event_read_baseline_or_outputs(self):
  with patch.dict(m.os.environ,{'COMMERCE_DEPLOY_PAUSED':'unknown'},clear=True),patch.object(m.subprocess,'check_output') as command,patch.object(m.Path,'read_text') as read:
   with self.assertRaisesRegex(RuntimeError,'^COMMERCE_DEPLOY_PAUSED_INVALID$'):m.main()
  command.assert_not_called();read.assert_not_called()
 def test_paused_package_changes_still_require_full_verification_and_release_selection(self):
  for event,paused in [('push','true'),('workflow_dispatch','true'),('workflow_dispatch','false'),('push','')]:
   with self.subTest(event=event,paused=paused),tempfile.TemporaryDirectory() as directory:
    base=Path(directory);event_path=base/'event.json';event_path.write_text(json.dumps({'before':'b'*40}));output=base/'output';summary=base/'summary';stdout=io.StringIO()
    env={'EVENT_NAME':event,'REF':'refs/heads/main','GITHUB_EVENT_PATH':str(event_path),'GITHUB_OUTPUT':str(output),'GITHUB_STEP_SUMMARY':str(summary),'DISPATCH_MODE':'release','COMMERCE_DEPLOY_PAUSED':paused}
    with patch.dict(m.os.environ,env,clear=True),patch.object(m,'deployed_baseline',return_value='a'*40),patch.object(m,'diff_paths',return_value=['package.json','pnpm-lock.yaml','scripts/b02-backup-ci.py']),redirect_stdout(stdout):m.main()
    self.assertIn('scope=full\n',output.read_text());self.assertIn('deploy=true\n',output.read_text());self.assertIn('diff_complete=true\n',output.read_text())
    self.assertIn('Publicación CI pausada' if paused=='true' else 'Publicación CI sin pausa temporal',summary.read_text())
    self.assertEqual(json.loads(stdout.getvalue().splitlines()[0])['scope'],'full')
  self.assertFalse(m.backup_delivery_only(['scripts/b02-backup-ci.py','package.json']))
  self.assertFalse(m.backup_delivery_only(['scripts/b02-backup-ci.py','pnpm-lock.yaml']))
 def test_only_publication_jobs_use_pause_and_full_audit_remains(self):
  workflow=(Path(__file__).resolve().parents[2]/'.github/workflows/ci.yml').read_text()
  jobs=dict(re.findall(r'^  ([a-z-]+):\n(.*?)(?=^  [a-z-]+:|\Z)',workflow,re.M|re.S))
  self.assertIn("if: needs.changes.outputs.deploy == 'true' && vars.COMMERCE_DEPLOY_PAUSED != 'true'",jobs['package'])
  self.assertIn("if: github.ref == 'refs/heads/main' && needs.changes.outputs.deploy == 'true' && vars.COMMERCE_DEPLOY_PAUSED != 'true'",jobs['deploy'])
  self.assertIn('COMMERCE_DEPLOY_PAUSED: ${{ vars.COMMERCE_DEPLOY_PAUSED }}',jobs['changes'])
  self.assertIn('pnpm audit --audit-level high',jobs['verify'])
  for name,body in jobs.items():
   if name not in ('changes','package','deploy'):self.assertNotIn('COMMERCE_DEPLOY_PAUSED',body)
