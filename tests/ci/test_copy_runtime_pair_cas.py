"""Real temporary file CAS with synthetic Root/Docker/B02 boundaries; no Cloud."""
import contextlib,json,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import copy_runtime_deployment as c
LOCAL_FULL='8c4008b5-f960-4ccb-817a-73372dfdd1d8'
import runtime_boot_install as boot
from ci_release import ReleaseError

class PairCAS(unittest.TestCase):
 def run_case(self,failure=None,gateway=False,local=False):
  with tempfile.TemporaryDirectory(prefix='review-pair-cas-') as directory:
   private=Path(directory);(private/'daily-b02').mkdir();report_dir=private/'deployments'/'101-1';report_dir.mkdir(parents=True)
   plan=private/'daily-b02'/'plan.json';state=private/'api-web-adoption.json'
   old_plan=b'{"synthetic_old_plan":true}';old_state=b'{"synthetic_old_state":true}'
   plan.write_bytes(old_plan);state.write_bytes(old_state);(private/'release.env').write_bytes(b'PUBLIC_SYNTHETIC=1\n')
   report={'status':'RUNNING','source_sha':'a'*40,'run_id':'101-1'}
   if local:report.update(run_id='cv-'+LOCAL_FULL+'-1',provider_evidence={'package_origin':'canonical-local'})
   (report_dir/'report.json').write_text(json.dumps(report))
   before={'state':{'active_proxy_sha256':'b'*64,'portal':{}},'workspace':'synthetic-workspace',
    'policy':{'version':98},'policy_observed':{},'plan_raw':old_plan,'state_raw':old_state}
   services={'api':{'Id':'c'*64}};calls=[];candidate={}
   new_plan=b'{"synthetic_new_plan":true}'
   def state_for(_b,_s,_r,reference,stage,*_args):
    candidate.update(runtime_stage=stage,last_release_receipt_ref=reference)
    return dict(candidate)
   def prepare(*_args,**_kwargs):
    calls.append('TOOLS')
    if failure=='drift':state.write_bytes(b'{"synthetic_competing_state":true}')
    return {'adoption':dict(candidate),'adoption_bytes':c.sealed_bytes(candidate),'plan_bytes':new_plan,'history_path':private/'history'}
   def mark(*_args):
    calls.append('MARK')
    self.assertEqual(json.loads((report_dir/'report.json').read_text())['status'],'RUNNING')
    if failure=='mark':raise ReleaseError('SYNTHETIC_MARK_FAILED')
    if failure=='keyboard':raise KeyboardInterrupt()
    if failure=='systemexit':raise SystemExit(2)
   def install_boot(*_args):
    calls.append('BOOT')
    self.assertEqual(json.loads((report_dir/'report.json').read_text())['status'],'RUNNING')
    self.assertEqual(json.loads((report_dir/'copy-runtime-transition.json').read_text())['status'],'APPLIED')
    if failure=='boot':raise ReleaseError('SYNTHETIC_BOOT_NOT_CONFIRMED')
    return {'status':'HOST_BOOT_INSTALLED_REBOOT_NOT_VERIFIED'}
   def policy_apply(*_args):
    calls.append('BOOT-POLICY')
    self.assertEqual(json.loads((report_dir/'copy-runtime-transition.json').read_text())['status'],'APPLIED')
    if failure=='boot':raise ReleaseError('SYNTHETIC_BOOT_NOT_CONFIRMED')
    return {'status':'HOST_BOOT_POLICY_RECONCILED_INSTALLATION_PRESERVED'}
   def admit(*_args):
    calls.append('ADMIT')
    return types.SimpleNamespace(fence=lambda:calls.append('BOOT-FENCE'),apply=policy_apply)
   backup=types.SimpleNamespace(prepare_reviewed_controllers=prepare,mark_pair_applied=mark)
   def write(path,value):
    if Path(path)==report_dir/'report.json' and value.get('status')=='SUCCEEDED':
     if failure=='terminal-keyboard':raise KeyboardInterrupt()
     if failure=='terminal-systemexit':raise SystemExit(2)
    Path(path).write_text(json.dumps(value))
   server=types.SimpleNamespace(PRIVATE=private,_write_report=write,command=lambda *_:'',owner_auth_snapshot=lambda *_:{})
   real_atomic=c.atomic_bytes
   def atomic(path,raw):
    calls.append('PLAN' if Path(path)==plan else 'STATE')
    if failure=='state' and Path(path)==state:raise ReleaseError('SYNTHETIC_STATE_WRITE_FAILED')
    return real_atomic(path,raw)
   with contextlib.ExitStack() as stack:
    mocks={(c.native,'protected_bytes'):lambda path:Path(path).read_bytes(),
     (c.native,'active_proxy_digest'):lambda *_:'b'*64,(c.native,'read_portal_references'):lambda *_:None,
     (c,'network_snapshot'):lambda *_:{},(c,'topology'):lambda *_:None,
     (c,'current_policy'):lambda *_:before['policy'],(c,'definition_digest'):lambda *_:'d'*64,
     (c,'state_for_stage'):state_for,(c,'verify_edge'):lambda *_:None,
     (c,'verify_gateway_provisioning'):lambda *_:None,(c,'stage_continuity'):lambda *_:None,
     (c,'reviewed_backup_module'):lambda *_:contextlib.nullcontext(backup),
     (c,'validate_state'):lambda *_:None,(c,'validate_inventory'):lambda *_:None,(c,'validate_plan'):lambda *_:None,
     (c,'atomic_bytes'):atomic,(boot,'install'):install_boot,(boot,'gateway_admission'):admit,
     (c,'gateway_continuity'):lambda *_:None,(c.provider_evidence,'installed_components'):lambda *_:None}
    for (module,name),value in mocks.items():stack.enter_context(patch.object(module,name,value))
    def final_guard():
     calls.append('GUARD')
     if failure=='guard':raise ReleaseError('SYNTHETIC_FINAL_GUARD_FAILED')
    try:c.commit_stage(server,private/'candidate',report_dir,before,services,report,'OPERATING',{'backup_tools_manifest_ref':{}},[object() for _ in range(4)],before_terminal=final_guard,gateway_extension=gateway)
    except BaseException as error:actual_error=str(error) if isinstance(error,ReleaseError) else type(error).__name__
    else:actual_error=None
   terminal=json.loads((report_dir/'report.json').read_text())
   journal=json.loads((report_dir/'copy-runtime-transition.json').read_text())
   if failure is None:
    self.assertIsNone(actual_error);self.assertEqual(terminal['status'],'SUCCEEDED');self.assertEqual(journal['status'],'APPLIED');self.assertEqual(calls,['ADMIT','BOOT-FENCE','TOOLS','BOOT-FENCE','PLAN','STATE','MARK','BOOT-POLICY','GUARD'] if gateway else ['TOOLS','PLAN','STATE','MARK','GUARD'] if local else ['TOOLS','PLAN','STATE','MARK','BOOT','GUARD'])
    if local:self.assertEqual(terminal['host_boot'],{'status':'HOST_BOOT_DEFERRED_CANONICAL_LOCAL','installation_verified':False,'reason':'NO_NATIVE_PACKAGE_BOOT_ADMISSION','run_id':report['run_id'],'units_changed':0})
   else:
    self.assertIsNotNone(actual_error);self.assertEqual(report['status'],'RUNNING');self.assertEqual(terminal['status'],'RUNNING');self.assertEqual(journal['status'],'APPLIED' if failure in ('boot','guard','terminal-keyboard','terminal-systemexit') else 'PREWRITE')
    self.assertEqual((report_dir/'adoption-applied.json').exists(),failure in ('boot','guard','terminal-keyboard','terminal-systemexit'))
    if failure=='state':self.assertEqual(plan.read_bytes(),new_plan);self.assertEqual(state.read_bytes(),old_state);self.assertNotIn('MARK',calls)
    if failure=='drift':self.assertEqual(actual_error,'COPY_RUNTIME_PAIR_CAS_CHANGED');self.assertEqual(plan.read_bytes(),old_plan);self.assertNotIn('PLAN',calls)
    if failure=='mark':self.assertEqual(plan.read_bytes(),new_plan);self.assertEqual(state.read_bytes(),c.sealed_bytes(candidate));self.assertEqual(calls[-1],'MARK')
 def test_gateway_policy_admitted_before_pair_and_never_reinstalls(self):self.run_case(gateway=True)
 def test_gateway_policy_failure_never_publishes_success(self):self.run_case('boot',gateway=True)
 def test_terminal_write_keyboard_interrupt_leaves_memory_and_durable_status_running(self):self.run_case('terminal-keyboard')
 def test_terminal_write_system_exit_leaves_memory_and_durable_status_running(self):self.run_case('terminal-systemexit')
 def test_keyboard_interrupt_at_mark_never_sets_terminal_memory_or_file_success(self):self.run_case('keyboard')
 def test_system_exit_at_mark_never_sets_terminal_memory_or_file_success(self):self.run_case('systemexit')
 def test_final_guard_failure_retains_applied_pair_without_terminal_success(self):self.run_case('guard')
 def test_success_is_written_only_after_actual_pair_and_mark(self):self.run_case()
 def test_partial_plan_replacement_retains_prewrite_and_running(self):self.run_case('state')
 def test_competing_adoption_after_tools_stops_before_plan_write(self):self.run_case('drift')
 def test_mark_failure_preserves_pair_without_terminal_success(self):self.run_case('mark')
 def test_boot_hook_failure_after_applied_pair_never_publishes_success(self):self.run_case('boot')
 def test_canonical_local_package_defers_boot_without_calling_the_installer(self):self.run_case(local=True)
 def test_canonical_local_guard_failure_still_never_publishes_success(self):self.run_case('guard',local=True)
 def test_deferred_boot_requires_both_local_origin_and_local_run_identity(self):
  local={'run_id':'cv-'+LOCAL_FULL+'-1','provider_evidence':{'package_origin':'canonical-local'}}
  self.assertTrue(c.canonical_local_package(local))
  for changed in ({'run_id':'cb-'+LOCAL_FULL+'-1'},{'run_id':'101-1'},{'provider_evidence':{'package_origin':'cloud-build'}},
                  {'provider_evidence':None},{'run_id':'cv-'+LOCAL_FULL+'-1;x'}):
   report=dict(local,**changed)
   self.assertFalse(c.canonical_local_package(report))
   with self.assertRaisesRegex(ReleaseError,'COPY_RUNTIME_DEFERRED_BOOT_REQUIRES_LOCAL_PACKAGE'):c.deferred_host_boot(report)

if __name__=='__main__':unittest.main(verbosity=2)
