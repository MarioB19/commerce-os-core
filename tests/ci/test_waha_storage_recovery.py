import importlib.util,unittest,tempfile,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('recovery',Path(__file__).resolve().parents[2]/'scripts/waha-storage-recovery.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class WahaRecoveryTest(unittest.TestCase):
 def fixture(self):
  return ({'account_id':'test','desired_state':'STOPPED','operational_pause':True,'sending_enabled':False,'uncertain':0,'recovery_stage':'STORAGE_REPLACEMENT_REQUESTED','gateway_id':'http://waha-01:3000','credential_generation':2},{'Id':'old','State':{'Running':False},'Config':{'Labels':{'com.docker.compose.project':'commerce-os','com.docker.compose.service':'waha-01'}},'Mounts':[{'Type':'volume','Destination':'/app/.sessions','Name':'original'}]})
 def test_offline_plan_preserves_old_volume_and_identity_generation(self):
  s,c=self.fixture();p=m.plan(s,c);self.assertFalse(p['old_volume_deletion']);self.assertFalse(p['session_start']);self.assertEqual(p['new_generation'],3);self.assertFalse(p['authentication_verified'])
 def test_rejects_running_or_uncertain_or_other_account(self):
  for change in ['running','uncertain','gateway']:
   s,c=self.fixture()
   if change=='running':c['State']['Running']=True
   elif change=='uncertain':s['uncertain']=1
   else:s['gateway_id']='http://waha-02:3000'
   with self.assertRaises(RuntimeError):m.plan(s,c)

 def test_unfinished_replacement_cannot_be_replayed(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp);(p/'receipt.json').write_text(json.dumps({'account_id':'same','stage':'RECREATING_STOPPED'}))
   with self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):m.reject_unreconciled_journal(p,'same')
   m.reject_unreconciled_journal(p,'different')
