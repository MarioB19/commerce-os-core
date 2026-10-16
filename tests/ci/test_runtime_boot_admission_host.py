"""Own temporary files only; synthetic authority cannot reach Root/systemd."""
import base64
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch
sys.path[:0]=[str(Path(__file__).resolve().parents[2]/'scripts')]
import runtime_boot_admission_host as h

class CustodyTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.root.chmod(0o700)
  self.report=self.root/'report';self.report.mkdir(mode=0o700);self.evidence=self.root/'evidence';self.approval=self.root/'approval.json'
  for obj,name,value in ((h.gate,'EVIDENCE',self.evidence),(h.gate,'APPROVAL',self.approval),(h.files,'directory',lambda p:None),(h.host,'protected_parents',lambda p:None),(h.host,'protected',lambda p,**kw:Path(p).read_bytes())):
   context=patch.object(obj,name,value);context.start();self.addCleanup(context.stop)
  self.binding={'synthetic':True};self.fences=0
 def fence(self):self.fences+=1
 def journal(self):return h.Custody(self.report,self.binding,self.fence)
 def test_intent_precedes_each_copy_and_approval_and_preserves_old_bytes(self):
  self.approval.write_bytes(b'old');self.approval.chmod(0o600);j=self.journal();j.action('evidence-directory',self.evidence)
  original=h.files.replace_file
  def write(path,raw,previous,mode,**kw):
   journal=h.runtime._parse(j.path.read_bytes());name='approval'if path==self.approval else 'original:'+h.pure.checksum(raw)
   self.assertEqual(journal['actions'][name]['status'],'INTENT');return original(path,raw,previous,mode,**kw)
  data=b'preserved raw original';target=self.evidence/(h.pure.checksum(data)+'.json')
  with patch.object(h.files,'replace_file',side_effect=write):
   j.action('original:'+h.pure.checksum(data),target,data);j.action('approval',self.approval,b'new')
  self.assertEqual(target.read_bytes(),data);self.assertEqual(self.approval.read_bytes(),b'new')
  self.assertEqual(base64.b64decode(j.value['actions']['approval']['previous_base64']),b'old')
 def test_unknown_directory_or_file_is_never_redispatched_after_restart(self):
  j=self.journal()
  with patch.object(Path,'mkdir',side_effect=OSError('synthetic lost acknowledgement')):
   with self.assertRaises(OSError):j.action('evidence-directory',self.evidence)
  with patch.object(Path,'mkdir',side_effect=AssertionError('no repeat')):
   with self.assertRaisesRegex(RuntimeError,'UNKNOWN_RECONCILE_ONLY'):self.journal().action('evidence-directory',self.evidence)
  self.evidence.mkdir(mode=0o700);j=self.journal();j.action('evidence-directory',self.evidence)
  with patch.object(h.files,'replace_file',side_effect=OSError('unknown')):
   with self.assertRaises(OSError):j.action('approval',self.approval,b'new')
  with patch.object(h.files,'replace_file',side_effect=AssertionError('no repeat')):
   with self.assertRaisesRegex(RuntimeError,'UNKNOWN_RECONCILE_ONLY'):self.journal().action('approval',self.approval,b'new')
 def test_lost_acknowledgement_reconciles_only_exact_original(self):
  j=self.journal();j.action('evidence-directory',self.evidence)
  original=h.files.replace_file
  def lost(*args,**kw):original(*args,**kw);raise OSError('lost ack')
  with patch.object(h.files,'replace_file',side_effect=lost):
   with self.assertRaises(OSError):j.action('approval',self.approval,b'exact')
  with patch.object(h.files,'replace_file',side_effect=AssertionError('no repeat')):
   fresh=self.journal();fresh.action('approval',self.approval,b'exact')
  self.assertEqual(fresh.value['actions']['approval']['status'],'VERIFIED')
  self.approval.write_bytes(b'changed')
  with self.assertRaisesRegex(RuntimeError,'UNKNOWN_RECONCILE_ONLY'):self.journal().action('approval',self.approval,b'exact')
 def test_expired_after_intent_has_zero_copy_and_retains_intent(self):
  j=self.journal();calls=0
  def fence():
   nonlocal calls;calls+=1
   if calls==3:raise RuntimeError('SYNTHETIC_EXPIRED')
  j.fence=fence
  with patch.object(h.files,'replace_file',side_effect=AssertionError('no copy')):
   with self.assertRaisesRegex(RuntimeError,'SYNTHETIC_EXPIRED'):j.action('approval',self.approval,b'new')
  self.assertEqual(h.runtime._parse(j.path.read_bytes())['actions']['approval']['status'],'INTENT')
 def test_binding_substitution_and_foreign_paths_rejected(self):
  self.journal()
  with self.assertRaisesRegex(RuntimeError,'JOURNAL_CHANGED'):h.Custody(self.report,{'different':True},self.fence)
  j=self.journal()
  with self.assertRaisesRegex(RuntimeError,'WRITE_SCOPE'):j.action('approval',self.root/'foreign',b'new')
 def test_unsafe_parent_rejected_before_first_journal_write(self):
  with patch.object(h.host,'protected_parents',side_effect=RuntimeError('PARENT_UNSAFE')):
   with self.assertRaisesRegex(RuntimeError,'PARENT_UNSAFE'):self.journal()
  self.assertFalse((self.report/'host-boot-admission.json').exists())
 def test_raw_original_larger_than_default_journal_bound_is_copied_bounded(self):
  j=self.journal();j.action('evidence-directory',self.evidence)
  data=b'x'*(h.host.MAX_OUTPUT+1);target=self.evidence/(h.pure.checksum(data)+'.json')
  j.action('original:'+h.pure.checksum(data),target,data)
  self.assertEqual(target.read_bytes(),data);self.assertLess(j.path.stat().st_size,2048)


class StagedInputTests(unittest.TestCase):
 def setUp(self):
  import types
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)/'commerce-ci-cb-synthetic';self.root.mkdir(mode=0o700)
  self.path=self.root/h.pure.FILENAME;self.raw=b'synthetic transported bytes';self.path.write_bytes(self.raw);self.path.chmod(0o600)
  original_stat=h.os.stat;original_fstat=h.os.fstat
  def root_stat(value):return types.SimpleNamespace(**{key:(0 if key=='st_uid'else getattr(value,key)) for key in dir(value) if key.startswith('st_')})
  for target,value in (('stat',lambda *a,**kw:root_stat(original_stat(*a,**kw))),('fstat',lambda *a,**kw:root_stat(original_fstat(*a,**kw)))):
   context=patch.object(h.os,target,value);context.start();self.addCleanup(context.stop)
  context=patch.object(h.pure,'unpack');self.parse=context.start();self.addCleanup(context.stop)
 def read(self,digest=None):return h.staged_input(self.root/'deploy-ci-vps.py',digest or h.pure.checksum(self.raw))
 def test_same_fixed_basename_raw_hash_and_custody_required(self):
  self.assertEqual(self.read(),self.raw);self.parse.assert_called_once_with(self.raw)
  with self.assertRaisesRegex(RuntimeError,'STAGING_CHANGED'):self.read('f'*64)
 def test_symlink_hardlink_and_permissions_rejected_before_parse(self):
  self.path.chmod(0o644)
  with self.assertRaisesRegex(RuntimeError,'FILE_UNSAFE'):self.read()
  self.path.chmod(0o600);h.os.link(self.path,self.root/'alias')
  with self.assertRaisesRegex(RuntimeError,'FILE_UNSAFE'):self.read()
  (self.root/'alias').unlink();self.path.unlink();self.path.symlink_to(self.root/'missing')
  with self.assertRaises(OSError):self.read()
  self.parse.assert_not_called()
 def test_stage_must_remain_root_private_directory_and_no_free_path(self):
  self.root.chmod(0o755)
  with self.assertRaisesRegex(RuntimeError,'CUSTODY'):self.read()
  with self.assertRaisesRegex(RuntimeError,'DIRECTORY_INVALID'):h.staged_input('/tmp/foreign/deploy-ci-vps.py','a'*64)

class GatewayIdsTests(unittest.TestCase):
 def test_only_prior_running_healthy_unchanged_gateway_ids_are_selected(self):
  before={'services':{'waha-01':{'Id':'a'*64,'Config':{'Healthcheck':{'Test':['CMD','healthy']}},'State':{'Running':True,'Paused':False,'Restarting':False,'Pid':123,'StartedAt':'2026-10-11T12:00:00Z','OOMKilled':False,'Status':'running','Health':{'Status':'healthy'}}},'waha-02':{'Id':'b'*64,'State':{'Running':False}},'api':{'Id':'c'*64,'State':{'Running':True}}}}
  state={'service_inventory':{'waha-01':'a'*64,'waha-02':'b'*64,'api':'c'*64,'waha-03':'d'*64}}
  self.assertEqual(h.gateway_ids(before,state),{'waha-01':'a'*64})
  state['service_inventory']['waha-01']='e'*64
  with self.assertRaisesRegex(RuntimeError,'GATEWAY_ID_CHANGED'):h.gateway_ids(before,state)
  state['service_inventory']['waha-01']='a'*64;before['services']['waha-01']['State']['Health']['Status']='unhealthy'
  with self.assertRaises(RuntimeError):h.gateway_ids(before,state)

class PrepareTests(unittest.TestCase):
 def test_four_lock_applied_pair_and_expiry_precede_every_custody_write(self):
  import contextlib,datetime as dt,types
  from unittest.mock import Mock
  from test_runtime_boot_admission import AdmissionTests
  fixture=AdmissionTests();fixture.setUp();value=h.pure.gate.restore.decode(fixture.packed())
  moment=dt.datetime.now(dt.timezone.utc);value.update(created_at=moment.isoformat(),expires_at=(moment+dt.timedelta(minutes=10)).isoformat())
  wire=h.pure.sealed(value)
  with tempfile.TemporaryDirectory()as directory:
   base=Path(directory).resolve();private=base/'private';private.mkdir(mode=0o700)
   root=base/'source';root.mkdir();(base/'current').symlink_to(root)
   report=fixture.f.report;reportdir=private/'deployments'/report['run_id'];reportdir.mkdir(parents=True)
   (private/'daily-b02').mkdir();(root/'packages/db/migrations').mkdir(parents=True);(root/'packages/db/migrations/0001_fixture.sql').write_bytes(b'--fixture')
   for name in h.gate.restore.RUNTIME:
    target=root/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b'fixture')
   state=h.pure.sealed({'runtime_stage':'OPERATING','current_release':str(root),'service_inventory':{}});plan=b'{}'
   (private/'api-web-adoption.json').write_bytes(state);(private/'daily-b02/plan.json').write_bytes(plan)
   applied={'status':'APPLIED','source_sha':report['source_sha'],'run_id':report['run_id'],'actual_state_sha256':h.pure.checksum(state),'actual_plan_sha256':h.pure.checksum(plan)}
   (reportdir/'copy-runtime-transition.json').write_bytes(h.pure.sealed(applied))
   calls=[];locks=[object()for _ in h.runtime.native.LOCKS]
   @contextlib.contextmanager
   def held(value):
    self.assertEqual(value,dict(zip(h.runtime.native.LOCKS,locks)));calls.append('locks');yield
   backup=types.SimpleNamespace(controller_update_locks=held);server=types.SimpleNamespace(PRIVATE=private,HOST_BOOT_INPUTS_RAW=wire)
   result={'approval_raw':b'{"synthetic":true}','originals':{},'input_sha256':h.pure.checksum(wire)}
   with patch.object(h.os,'geteuid',return_value=0),patch.object(h.host,'PRIVATE',private),patch.object(h.files,'directory'),patch.object(h.host,'protected',side_effect=lambda p,**_:Path(p).read_bytes()),patch.object(h.host,'native_host_id',return_value='123456'),patch.object(h.runtime,'validate_plan'),patch.object(h.pure,'produce',return_value=result)as produce,patch.object(h,'Custody')as custody:
    custody.return_value.raw=b'journal'
    out=h.prepare(server,root,reportdir,{'services':{}},report,state,plan,backup,locks,None)
    self.assertFalse(out['installation_verified']);self.assertGreaterEqual(len(calls),3)
    self.assertEqual(produce.call_args.kwargs['gateway_start_ids'],{})
    custody.reset_mock();produce.reset_mock()
    for fail in ('missing_lock','wrong_pair','expired_before_read'):
     argslocks=locks[:-1]if fail=='missing_lock'else locks
     if fail=='wrong_pair':(private/'api-web-adoption.json').write_bytes(b'changed')
     if fail=='expired_before_read':
      (private/'api-web-adoption.json').write_bytes(state)
      value['expires_at']=moment.isoformat();server.HOST_BOOT_INPUTS_RAW=h.pure.sealed(value)
     with self.subTest(fail=fail),self.assertRaises(RuntimeError):h.prepare(server,root,reportdir,{'services':{}},report,state,plan,backup,argslocks,None)
     custody.assert_not_called();produce.assert_not_called()

if __name__=='__main__':unittest.main()
