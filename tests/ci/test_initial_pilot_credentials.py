"""Own synthetic fixtures. No Docker, Cloud, actual credentials or API writes."""
import contextlib,copy,hashlib,importlib.util,io,json,os
from pathlib import Path
import tempfile,types,unittest,shutil,subprocess
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('pilot_capacity',ROOT/'scripts/number-capacity-administrator.py')
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
KEY='synthetic-key-for-credential-regression';HOOK='synthetic-hook-for-credential-regression'

class PilotCredentials(unittest.TestCase):
 def make(self,directory,hashed=True):
  directory=Path(directory)
  def write(name,text):
   p=directory/name;p.write_text(text);p.chmod(0o600);return p
  key='sha512:'+hashlib.sha512(KEY.encode()).hexdigest() if hashed else KEY
  write('waha-01.env','WAHA_API_KEY='+key+'\n')
  write('channel-pilot.env','WAHA_01_URL=http://waha-01:3000\nWAHA_01_API_KEY='+KEY+'\nWAHA_01_WEBHOOK_SECRET='+HOOK+'\n')
  write('ingress-pilot.env','WAHA_01_WEBHOOK_SECRET='+HOOK+'\n')
  agent=object.__new__(a.Administrator);agent.directory=directory;agent.overlay=directory/'additional-gateways.json'
  return agent
 def identity(self,directory):
  return {p.name:(p.read_bytes(),p.stat().st_ino,p.stat().st_mtime_ns,p.stat().st_mode) for p in Path(directory).iterdir()}
 def test_hashed_server_maps_existing_plaintext_and_hook_without_rotating_files(self):
  with tempfile.TemporaryDirectory() as d:
   agent=self.make(d);before=self.identity(d)
   self.assertEqual(agent.credentials(1),{'WAHA_API_KEY':KEY,'WHATSAPP_HOOK_HMAC_KEY':HOOK})
   self.assertEqual(self.identity(d),before)
 def test_raw_server_and_matching_pilot_files_remain_valid(self):
  with tempfile.TemporaryDirectory() as d:
   agent=self.make(d,False);self.assertEqual(agent.credentials(1,False)['WAHA_API_KEY'],KEY)
 def test_binding_wrong_key_hook_url_and_server_hook_are_rejected_unchanged(self):
  for name,edit in [('channel-pilot.env',lambda s:s.replace(KEY,'wrong-synthetic-key')),
                    ('ingress-pilot.env',lambda s:s.replace(HOOK,'wrong-synthetic-hook')),
                    ('channel-pilot.env',lambda s:s.replace('http://waha-01:3000','http://foreign:3000')),
                    ('waha-01.env',lambda s:s+'WHATSAPP_HOOK_HMAC_KEY=wrong-synthetic-hook\n')]:
   with self.subTest(name=name),tempfile.TemporaryDirectory() as d:
    agent=self.make(d);p=Path(d)/name;p.write_text(edit(p.read_text()));before=self.identity(d)
    with self.assertRaisesRegex(ValueError,'PRIVATE_PILOT_CREDENTIAL_BINDING_CHANGED'):agent.credentials(1,False)
    self.assertEqual(self.identity(d),before)
 def test_missing_private_plaintext_or_half_configuration_never_generates(self):
  for name in ('channel-pilot.env','ingress-pilot.env','waha-01.env'):
   with self.subTest(name=name),tempfile.TemporaryDirectory() as d:
    agent=self.make(d);(Path(d)/name).unlink();before=self.identity(d)
    with self.assertRaises((ValueError,FileNotFoundError)):agent.credentials(1,False)
    self.assertEqual(self.identity(d),before)
 def test_raw_complete_credentials_remain_compatible_for_slot1_and_additional(self):
  for slot in (1,2):
   with self.subTest(slot=slot),tempfile.TemporaryDirectory() as d:
    agent=object.__new__(a.Administrator);agent.directory=Path(d)
    p=Path(d)/('waha-'+str(slot).zfill(2)+'.env');p.write_text('WAHA_API_KEY='+KEY+'\nWHATSAPP_HOOK_HMAC_KEY='+HOOK+'\n');p.chmod(0o600)
    before=self.identity(d);self.assertEqual(agent.credentials(slot,False),{'WAHA_API_KEY':KEY,'WHATSAPP_HOOK_HMAC_KEY':HOOK});self.assertEqual(self.identity(d),before)
 def test_duplicate_oversized_linked_and_public_env_are_rejected(self):
  for mutation in ('duplicate','oversized','link','public'):
   with self.subTest(mutation=mutation),tempfile.TemporaryDirectory() as d:
    agent=self.make(d);p=Path(d)/'channel-pilot.env'
    if mutation=='duplicate':p.write_text(p.read_text()+'WAHA_01_API_KEY=another-synthetic-key\n')
    if mutation=='oversized':p.write_text('A='+'x'*16384+'\n')
    if mutation=='link':os.link(p,Path(d)/'linked.env')
    if mutation=='public':p.chmod(0o644)
    with self.assertRaises(ValueError):agent.credentials(1,False)
 def test_permissions_widened_between_initial_check_and_open_are_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   agent=self.make(d);path=Path(d)/'waha-01.env';actual_open=os.open
   def raced_open(open_path,*args,**kwargs):
    if Path(open_path)==path:path.chmod(0o644)
    return actual_open(open_path,*args,**kwargs)
   with patch.object(a.os,'open',side_effect=raced_open),self.assertRaisesRegex(ValueError,'PRIVATE_CREDENTIAL_CUSTODY_CHANGED'):agent.credentials(1,False)
   self.assertEqual(path.stat().st_mode & 0o777,0o644)
 def test_unexpected_owner_is_rejected_without_chown_or_key_rotation(self):
  with tempfile.TemporaryDirectory() as d:
   agent=self.make(d);before=self.identity(d);different_uid=os.geteuid()+1
   with patch.object(a.os,'geteuid',return_value=different_uid),self.assertRaisesRegex(ValueError,'PRIVATE_CREDENTIAL_CUSTODY_CHANGED'):agent.credentials(1,False)
   self.assertEqual(self.identity(d),before)
 def test_changed_descriptor_owner_is_rejected_before_credential_read(self):
  with tempfile.TemporaryDirectory() as d:
   agent=self.make(d);before=self.identity(d);actual_fstat=os.fstat
   def foreign_fstat(fd):
    value=actual_fstat(fd);fields={k:getattr(value,k) for k in ('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns','st_uid','st_mode','st_nlink')};fields['st_uid']+=1
    return types.SimpleNamespace(**fields)
   with patch.object(a.os,'fstat',side_effect=foreign_fstat),self.assertRaisesRegex(ValueError,'PRIVATE_CREDENTIAL_CUSTODY_CHANGED'):agent.credentials(1,False)
   self.assertEqual(self.identity(d),before)
 def test_readback_key_uses_only_stdin_and_query_includes_stopped_sessions(self):
  with tempfile.TemporaryDirectory() as d:
   agent=self.make(d);agent.snapshot=lambda _:{'Id':'a'*64,'State':{'Running':True},'Image':'sha256:'+'b'*64}
   before=self.identity(d);calls=[];out=io.StringIO()
   def run(args,**kwargs):calls.append((args,kwargs));return '{"count":0,"connected":0}'
   with patch.object(a,'run',side_effect=run),contextlib.redirect_stdout(out):result=agent.readback(1)
   self.assertEqual(result['session_count'],0);self.assertEqual(out.getvalue(),'');self.assertEqual(self.identity(d),before)
   args,kwargs=calls[0];self.assertEqual(args[:4],['docker','exec','-i','a'*64]);self.assertEqual(json.loads(kwargs['input']),{'api_key':KEY})
   self.assertNotIn(KEY,' '.join(args));self.assertNotIn(HOOK,' '.join(args));self.assertNotIn('--env',args);self.assertNotIn('process.env.WAHA_API_KEY',args[-1]);self.assertIn('/api/sessions?all=true',args[-1])
 def test_readback_invalid_counts_fail_and_nonzero_session_count_is_retained(self):
  with tempfile.TemporaryDirectory() as d:
   agent=self.make(d);agent.snapshot=lambda _:{'Id':'a'*64,'State':{'Running':True},'Image':'sha256:'+'b'*64}
   for result in ({'count':False,'connected':0},{'count':0,'connected':1},{'count':-1,'connected':0},{'count':0,'connected':0,'extra':1}):
    with self.subTest(result=result),patch.object(a,'run',return_value=json.dumps(result)),self.assertRaisesRegex(ValueError,'GATEWAY_SESSION_READBACK_INVALID'):agent.readback(1)
   with patch.object(a,'run',return_value='{"count":1,"connected":0}'):
    self.assertEqual(agent.readback(1)['session_count'],1)
 def test_snapshot_absence_is_distinct_from_duplicate_or_bad_container_id(self):
  agent=object.__new__(a.Administrator)
  for answer,error in [('', 'GATEWAY_NOT_PROVISIONED'),('a'*64+'\n'+'b'*64,'GATEWAY_READBACK_REQUIRED'),('invalid','GATEWAY_READBACK_REQUIRED')]:
   agent.compose=lambda *args:'waha-01\n' if args==('config','--services') else answer
   with self.subTest(answer=answer),patch.object(a,'run',return_value=''),self.assertRaisesRegex(ValueError,error):agent.snapshot(1)
 def test_snapshot_queries_all_containers_and_retains_stopped_gateway(self):
  agent=object.__new__(a.Administrator);calls=[];cid='a'*64
  stopped={'Id':cid,'State':{'Running':False},
   'Mounts':[{'Destination':'/app/.sessions','Name':'commerce-os_waha-01-sessions'},
             {'Destination':'/app/.media','Name':'commerce-os_waha-01-media'}],
   'NetworkSettings':{'Networks':{'commerce-os_gateway-01':{}}}}
  agent.compose=lambda *args:calls.append(args) or ('waha-01\n' if args==('config','--services') else cid)
  with patch.object(a,'run',return_value=json.dumps([stopped])) as run:result=agent.snapshot(1)
  self.assertEqual(calls,[('config','--services'),('ps','--all','-q','waha-01')]);self.assertFalse(result['State']['Running'])
  run.assert_called_once_with(['docker','inspect',cid])
 def test_readback_stopped_gateway_rejects_before_credentials_or_remote_command(self):
  with tempfile.TemporaryDirectory() as d:
   agent=self.make(d);before=self.identity(d)
   agent.snapshot=lambda _:{'Id':'a'*64,'State':{'Running':False},'Image':'sha256:'+'b'*64}
   with patch.object(agent,'credentials') as credentials,patch.object(a,'run') as run:
    with self.assertRaisesRegex(ValueError,'^GATEWAY_STOPPED_READBACK_REQUIRED$'):agent.readback(1)
   credentials.assert_not_called();run.assert_not_called();self.assertEqual(self.identity(d),before)
 def test_actual_absence_is_confirmed_with_all_query_and_never_inspected(self):
  agent=object.__new__(a.Administrator);calls=[];agent.compose=lambda *args:calls.append(args) or ('waha-01\n' if args==('config','--services') else '')
  with patch.object(a,'run',return_value='') as run:
   with self.assertRaisesRegex(ValueError,'^GATEWAY_NOT_PROVISIONED$'):agent.snapshot(1)
  self.assertEqual(calls,[('config','--services'),('ps','--all','-q','waha-01')]);run.assert_called_once_with(['docker','ps','--all','--quiet','--no-trunc'])
 def test_measure_does_not_silently_exclude_invalid_existing_gateway(self):
  for error in ('GATEWAY_NOT_PROVISIONED','GATEWAY_STOPPED_READBACK_REQUIRED','PRIVATE_PILOT_CREDENTIAL_BINDING_CHANGED','GATEWAY_VOLUME_CHANGED'):
   with self.subTest(error=error),tempfile.TemporaryDirectory() as d:
    agent=self.make(d);calls=[]
    agent.api=lambda path,body=None:({'slots':[{'slot':1}]} if path.startswith('/number-capacity?') else calls.append((path,body)) or {'synthetic':True})
    agent.readback=lambda _:(_ for _ in ()).throw(ValueError(error))
    def proc_read(path):return 'cpu 1 1 1 8 1 1 1 1\n' if str(path)=='/proc/stat' else 'MemTotal: 100000 kB\nMemAvailable: 80000 kB\n'
    with patch.object(a.Path,'read_text',proc_read),patch.object(a.time,'sleep'):
     if error=='GATEWAY_NOT_PROVISIONED':self.assertEqual(agent.measure(),{'synthetic':True});self.assertEqual(calls[0][1]['slots'],[])
     else:
      with self.assertRaisesRegex(ValueError,error):agent.measure()
      self.assertEqual(calls,[])
 def test_slot1_overlay_digest_is_canonical_and_additional_digest_preserved(self):
  with tempfile.TemporaryDirectory() as d:
   agent=self.make(d);digest=agent.provisioning_overlay_digest()
   self.assertEqual(digest,a.helper.digest(ROOT/'infra/compose/pilot.yaml'));self.assertRegex(digest,r'^[a-f0-9]{64}$')
   agent.overlay.write_bytes(b'{"public_synthetic_overlay":true}')
   self.assertEqual(agent.provisioning_overlay_digest(),hashlib.sha256(agent.overlay.read_bytes()).hexdigest())
 @unittest.skipUnless(shutil.which('node'),'Node executable required for fixed JS readback harness')
 def test_actual_fixed_javascript_reports_only_counts_without_network_or_secret_output(self):
  mock="global.fetch=async(url,opts)=>{if(url!=='http://127.0.0.1:3000/api/sessions?all=true'||!opts.headers['X-Api-Key']||opts.redirect!=='error')throw Error('MOCK');return {ok:true,json:async()=>[{status:'WORKING'},{status:'STOPPED'},{status:'WORKING'}]}};"
  result=subprocess.run([shutil.which('node'),'-e',mock+a.SESSION_READBACK_JS],input=json.dumps({'api_key':KEY}),capture_output=True,text=True,timeout=20)
  self.assertEqual(result.returncode,0);self.assertEqual(json.loads(result.stdout),{'count':3,'connected':2})
  self.assertNotIn(KEY,result.stdout+result.stderr);self.assertNotIn(HOOK,result.stdout+result.stderr)
 @unittest.skipUnless(shutil.which('node'),'Node executable required for fixed JS readback harness')
 def test_fixed_javascript_failure_is_redacted_and_never_returns_fake_zero(self):
  for mock in ("global.fetch=async()=>({ok:false});", "global.fetch=async()=>({ok:true,json:async()=>({invalid:true})});"):
   result=subprocess.run([shutil.which('node'),'-e',mock+a.SESSION_READBACK_JS],input=json.dumps({'api_key':KEY}),capture_output=True,text=True,timeout=20)
   self.assertNotEqual(result.returncode,0);self.assertEqual(result.stdout,'');self.assertNotIn(KEY,result.stdout+result.stderr)
 def test_subprocess_receives_private_input_separately_and_failure_output_is_redacted(self):
  with patch.object(a.subprocess,'run',return_value=types.SimpleNamespace(returncode=0,stdout='public readback')) as run:
   self.assertEqual(a.run(['docker','exec','-i','synthetic','node'],input='synthetic-private-input'),'public readback')
   self.assertEqual(run.call_args.kwargs['input'],'synthetic-private-input');self.assertNotIn('synthetic-private-input',run.call_args.args[0])
  with patch.object(a.subprocess,'run',return_value=types.SimpleNamespace(returncode=1,stdout=KEY,stderr=HOOK)):
   with self.assertRaisesRegex(RuntimeError,'^BOUNDED_HOST_COMMAND_FAILED$'):a.run(['docker','exec','synthetic'])

if __name__=='__main__':unittest.main()
