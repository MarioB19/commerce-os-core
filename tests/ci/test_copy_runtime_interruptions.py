"""Actual outer controllers and real private journals; synthetic Docker/Root facts."""
import contextlib,io,json,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import copy_runtime_deployment as c
from deployment_scope import NO_PORTAL

class Interruptions(unittest.TestCase):
 def write(self,path,value):
  Path(path).write_text(json.dumps(value,sort_keys=True)+'\n')
 def layout(self,directory):
  base=(Path(directory)/'commerce').resolve();private=base/'private';private.mkdir(mode=0o700,parents=True);(private/'deployments').mkdir()
  releases=base/'releases';releases.mkdir();previous=releases/'previous';previous.mkdir()
  (previous/'RELEASE.json').write_text(json.dumps({'source_sha':'a'*40}));(base/'current').symlink_to(previous)
  (private/'release.env').write_text('COMMERCE_DEPLOY_SCOPE=copy-runtime\nCOMMERCE_IMAGE=sha256:'+'b'*64+'\n')
  return base,private,previous
 def publisher(self,error_type):
  with tempfile.TemporaryDirectory(prefix='copy-interrupt-') as directory:
   base,private,previous=self.layout(directory);archive=Path(directory)/'public-package.tar';archive.write_bytes(b'public-synthetic')
   commands=[];locks=[types.SimpleNamespace(close=lambda:None) for _ in range(4)];policy={'version':98,'body':{}}
   before={'state':{'schema_version':3,'runtime_stage':'OPERATING','portal':{}},'state_raw':b'state','plan_raw':b'plan','policy':policy,'owner':{},'workspace':'fixture','services':{'api':{'Id':'d'*64}},'release':{}}
   def command(args,_root):
    commands.append(args)
    return '1' if 'supports' in args else ''
   def task(_root,_dir,_args,phase,_timeout):
    if phase=='activate':raise error_type()
   def extract(_archive,root,_hash):
    root.mkdir();(root/'RELEASE.json').write_text(json.dumps({'source_sha':'a'*40,'run_id':'123','migration_hashes':{}}))
   server=types.SimpleNamespace(BASE=base,PRIVATE=private,PREPARE_TIMEOUT_SECONDS=1200,INSTALL_TIMEOUT_SECONDS=1200,
    command=command,run_deployment_task=task,_write_report=self.write,migrations=lambda _: {},
    compare_owner_auth=lambda *_:None,raw_policy_snapshot=lambda _:json.dumps({'fixture':policy}),
    snapshot_api_deployment_status=lambda *_:None,preserved_containers=lambda:{},error_code=lambda e:type(e).__name__)
   with contextlib.ExitStack() as stack,contextlib.redirect_stdout(io.StringIO()):
    replacements={(c,'deadline_fuse'):lambda _:contextlib.nullcontext(),(c.native,'acquire_locks_for_prepare'):lambda _:locks[0],
     (c.native,'acquire_locks'):lambda _:locks,(c,'snapshot'):lambda *_:before,(c,'extract_release'):extract,
     (c,'reviewed_migrations'):lambda *_:{},(c,'verify_migrations'):lambda *_a,**_k:None,
     (c,'migration_stage_guard'):lambda *_a,**_k:None,(c,'installed_migration_identity'):lambda *_:None,
     (c,'apply_reviewed_migrations'):lambda *_a,**_k:{'synthetic':True},
     (c.native,'verify_predeploy_backup'):lambda *_:{'synthetic':True},(c,'loaded_candidate_image'):lambda *_:'sha256:'+'b'*64,
     (c,'copy_hold_capability'):lambda *_:True,(c,'in_flight_guard'):lambda *_:None,(c,'commercial_snapshot'):lambda *_:'quiet'}
    for (module,name),value in replacements.items():stack.enter_context(patch.object(module,name,value))
    with self.assertRaises(error_type):c.publish(server,str(archive),'c'*64,'a'*40,'123-1',NO_PORTAL)
   report=json.loads((private/'deployments/123-1/report.json').read_text())
   self.assertEqual(report['status'],'FAILED');self.assertEqual(report['error'],error_type.__name__)
   self.assertEqual(report['rollback'],{'status':'BLOCKED','error':'COPY_RUNTIME_DURABLE_RECONCILIATION_REQUIRED','database_restored':False,'transient_hold_active':True})
   self.assertTrue(any('hold' in args for args in commands));self.assertFalse(any('release' in args or 'attest' in args for args in commands))
   self.assertFalse((private/'api-web-adoption.json').exists());self.assertFalse((private/'daily-b02/plan.json').exists())
 def reconciler(self,error_type):
  with tempfile.TemporaryDirectory(prefix='gateway-interrupt-') as directory:
   base,private,current=self.layout(directory);(private/'controller-approvals').mkdir();(private/'daily-b02').mkdir()
   state={'runtime_stage':'OPERATING','current_release':str(current)};state_raw=c.sealed_bytes(state);plan_raw=b'{}'
   (private/'api-web-adoption.json').write_bytes(state_raw);(private/'daily-b02/plan.json').write_bytes(plan_raw)
   manifest={'schema_version':1,'source_sha':'a'*40,'current_release':str(current),'run_id':'123-1',
    'before_adoption_sha256':c.sha256(state_raw),'before_plan_sha256':c.sha256(plan_raw),'observed_policy':{},
    'runtime_before_ref':{},'previous_release_env_ref':{},'current_release_env_ref':{},'ownership_observation_ref':{},
    'backup_before_provision_ref':{},'gateway_provisioning':{},'backup_tools_manifest_ref':{}}
   approval=private/'controller-approvals/approval.json';approval.write_bytes(c.sealed_bytes(manifest))
   ref={'path':str(approval),'bytes':approval.stat().st_size,'sha256':c.sha256(approval.read_bytes())};ref_file=private/'approval-ref.json';ref_file.write_bytes(c.sealed_bytes(ref))
   commands=[];server=types.SimpleNamespace(BASE=base,PRIVATE=private,_write_report=self.write,command=lambda args,_:commands.append(args),error_code=lambda e:type(e).__name__)
   with contextlib.ExitStack() as stack,contextlib.redirect_stdout(io.StringIO()):
    replacements={(c.native,'protected_bytes'):lambda p:Path(p).read_bytes(),(c.native,'read_reference'):lambda r:Path(r['path']).read_bytes(),
     (c,'current_source_guard'):lambda *_:None,(c,'deadline_fuse'):lambda _:contextlib.nullcontext(),
     (c.native,'acquire_locks'):lambda _:[],(c,'validate_state'):lambda *_:None,(c,'validate_plan'):lambda *_:None,
     (c,'terminal_journals'):lambda *_:(_ for _ in ()).throw(error_type())}
    for (module,name),value in replacements.items():stack.enter_context(patch.object(module,name,value))
    with self.assertRaises(error_type):c.reconcile_gateways(server,str(ref_file))
   report=json.loads((private/'deployments/123-1/report.json').read_text())
   self.assertEqual(report['status'],'FAILED');self.assertEqual(report['error'],error_type.__name__);self.assertTrue(report['reconciliation_required'])
   self.assertEqual((private/'api-web-adoption.json').read_bytes(),state_raw);self.assertEqual((private/'daily-b02/plan.json').read_bytes(),plan_raw)
   self.assertEqual(commands,[]);self.assertFalse(report['hold_released']);self.assertEqual(report['gateways_started'],0)
 def test_publisher_keyboard_interrupt_preserves_failed_report_and_active_hold(self):self.publisher(KeyboardInterrupt)
 def test_publisher_system_exit_preserves_failed_report_and_active_hold(self):self.publisher(SystemExit)
 def test_reconciler_keyboard_interrupt_preserves_failed_report_and_pair(self):self.reconciler(KeyboardInterrupt)
 def test_reconciler_system_exit_preserves_failed_report_and_pair(self):self.reconciler(SystemExit)

if __name__=='__main__':unittest.main()
