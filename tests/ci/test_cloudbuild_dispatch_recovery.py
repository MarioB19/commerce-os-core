"""Fixed private incident originals, offline; timestamps in mutations are synthetic."""
import copy,datetime as dt,hashlib,importlib.util,json,pathlib,sys,unittest
I=pathlib.Path(__file__).resolve().parents[2]
PUBLIC=pathlib.Path('/private/tmp/commerce-v7-f0-native-20261010/runtime-controller-public-pacing-20261011/context/scripts')
sys.path.insert(0,str(PUBLIC))
s=importlib.util.spec_from_file_location('dispatch_recovery_under_test',I/'scripts/cloudbuild_dispatch_recovery.py');x=importlib.util.module_from_spec(s);s.loader.exec_module(x)
V=pathlib.Path('/Users/brandonmuro/.local/share/commerce-os-validation-20261008');D=V/'f0-operating-controller-20261011/invocations/v11-full-dispatch-1';P=V/'f0-v11-dispatch-recovery-pause-20261011/apply-1';G=V/'f0-public-v11-dispatch-diagnostic-20261011'
def enc(v):return (json.dumps(v,sort_keys=True,separators=(',',':'))+'\n').encode()
class Tests(unittest.TestCase):
 def setUp(self):
  self.paths={'invocation_intent':D.parent/'1791759655850273-dispatch_full-dispatch.intent.json','before':D/'before.json','task_media':D/'before-task-media.raw.json','http_result':D/'http-result.json','request_logs':G/'controller-logs.response.private.json','service_current':P/'service-after.response.private.json','service_iam_before':D/'service-before-iam.raw.json','service_iam_current':P/'service-iam-after.response.private.json','regional_builds':G/'recent-regional-builds.response.private.json','native_build':V/'f0-public-v11-full-unknown-observation-20261011/progress-1/native-build.response.private.json','project':V/'f0-public-images-20261011/publisher/51be7503dcbfb73aa84f73178a6c10e6c733c209b765af066b7f6f14996e08c5/push-1/project.response.private.json','commit':V/'f0-public-v11-gate-compose-20261011/commit.private.json'}
  for name in ('control','ledger','meter'):
   for part in ('metadata','media','current'):self.paths[name+'_'+part]=P/('after-'+name+'-'+part+'.response.private.json')
  self.raw={k:p.read_bytes()for k,p in self.paths.items()};self.now=dt.datetime(2026,10,11,23,14,tzinfo=dt.timezone.utc)
 def bundle(self):
  return {'schema_version':1,'kind':x.KIND,'observed_at':(self.now-dt.timedelta(seconds=30)).isoformat(),'valid_until':(self.now+dt.timedelta(seconds=60)).isoformat(),'originals':{k:{'path':str(self.paths[k]),'bytes':len(v),'sha256':x.sha(v)}for k,v in self.raw.items()}}
 def call(self):
  b=self.bundle();lookup={str(self.paths[k]):v for k,v in self.raw.items()};return x.validate_evidence(b,lambda ref:lookup[ref['path']],now=self.now)
 def mutate(self,key,fn):
  v=json.loads(self.raw[key]);fn(v);self.raw[key]=enc(v)
 def mutate_gcs(self,key,fn):
  self.mutate(key+'_media',fn);wire=self.raw[key+'_media']
  import base64
  for p in ('metadata','current'):self.mutate(key+'_'+p,lambda v:v.update(size=str(len(wire)),md5Hash=base64.b64encode(hashlib.md5(wire).digest()).decode()))
 def test_authentic_originals_bind_native_build_without_claiming_ledger_bind(self):
  r=self.call();self.assertEqual(r['build_id'],'1b64eda8-35cd-4803-bdc6-652447dcc1d1');self.assertEqual(r['meter_ceiling_ms'],450000);self.assertEqual(r['ledger_sha256'],x.sha(self.raw['ledger_media']))
 def test_complete_service_configuration_cannot_drift(self):
  self.mutate('service_current',lambda v:v['scaling'].update(maxInstanceCount=3))
  with self.assertRaisesRegex(Exception,'SERVICE_CONFIGURATION_CHANGED'):self.call()
 def test_control_must_be_paused(self):
  self.mutate_gcs('control',lambda v:v.update(mode='active'))
  with self.assertRaisesRegex(Exception,'CONTROL_NOT_PAUSED'):self.call()
 def test_meter_history_preserved(self):
  def change(v):next(r for r in v['requests'].values()if r['state']=='COMPLETED')['ceiling_ms']+=1000
  self.mutate_gcs('meter',change)
  with self.assertRaisesRegex(Exception,'METER_HISTORY_CHANGED'):self.call()
 def test_ledger_historical_rows_preserved(self):
  self.mutate_gcs('ledger',lambda v:v.update(revision=v['revision']+1))
  with self.assertRaisesRegex(Exception,'LEDGER_HISTORY_CHANGED'):self.call()
 def test_source_drift_rejected(self):
  self.mutate('native_build',lambda v:v['source']['storageSource'].update(generation='999'))
  with self.assertRaisesRegex(Exception,'NATIVE_SOURCE_MISMATCH'):self.call()
 def test_regional_unique_match_required(self):
  self.mutate('regional_builds',lambda v:v['builds'].extend(copy.deepcopy(v['builds'])))
  with self.assertRaisesRegex(Exception,'UNIQUE_NATIVE_BUILD_REQUIRED'):self.call()
 def test_regional_incomplete_denied(self):
  self.mutate('regional_builds',lambda v:v.update(nextPageToken='next'))
  with self.assertRaisesRegex(Exception,'LIST_INCOMPLETE'):self.call()
 def test_wrong_native_identity_rejected(self):
  self.mutate('native_build',lambda v:v.update(id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
  with self.assertRaisesRegex(Exception,'BUILD_CHANGED'):self.call()
 def test_execution_window_preserved(self):
  self.now=dt.datetime(2026,10,11,23,9,27,tzinfo=dt.timezone.utc)
  with self.assertRaisesRegex(Exception,'INVOCATION_NOT_TERMINAL'):self.call()
 def test_terminal_http_exact_and_logs_bound(self):
  self.mutate('http_result',lambda v:v['response'].update(code='ARBITRARY'))
  with self.assertRaisesRegex(Exception,'HTTP_TERMINAL_REQUIRED'):self.call()
 def test_future_log_reception_denied(self):
  self.mutate('request_logs',lambda v:v['entries'][0].update(receiveTimestamp='2026-10-12T01:00:00Z'))
  with self.assertRaisesRegex(Exception,'INVOCATION_NOT_TERMINAL'):self.call()
 def test_receipt_expiry_and_exact_fields(self):
  r=self.call()
  with self.assertRaisesRegex(Exception,'EVIDENCE_EXPIRED'):x.validate_receipt(r,now=self.now+dt.timedelta(minutes=2))
  r['verified']=True
  with self.assertRaisesRegex(Exception,'RECEIPT_FIELDS'):x.validate_receipt(r,now=self.now)
 def test_receipt_cannot_change_fixed_incident(self):
  r=self.call();r['source_sha']='e'*40
  with self.assertRaisesRegex(Exception,'INCIDENT_CHANGED'):x.validate_receipt(r,now=self.now)
 def test_raw_corruption_denied(self):
  with self.assertRaisesRegex(Exception,'ORIGINAL_CHANGED'):x.validate_evidence(self.bundle(),lambda ref:b'{}',now=self.now)
if __name__=='__main__':unittest.main()
