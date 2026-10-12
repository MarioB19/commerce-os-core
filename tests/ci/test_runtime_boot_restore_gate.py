"""Synthetic linked originals; no filesystem, cloud, key, or restore effects."""
import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'scripts'))
import runtime_boot_restore_gate as g

SOURCE='a'*40
NOW=dt.datetime(2026,10,12,tzinfo=dt.timezone.utc)

def raw(value): return (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
def ref(path,data): return {'path':path,'bytes':len(data),'sha256':g.sha(data)}

class Fixture:
 def __init__(self,receipt_change=None,manifest_change=None):
  self.refs={};self.raws={};self.docs={}
  uid='11111111-2222-4333-8444-555555555555';run='gcp-'+uid.replace('-','');planhash='1'*64
  portal={'source_sha':SOURCE,'run_id':'1234-1','image':'sha256:'+'2'*64,'proxy_network':'edge','format':'COMOSP01','private_files':13,'sqlite_snapshot_consistent':True}
  sources={n:'3'*64 for n in g.RUNTIME};migrations={'0001_synthetic.sql':'4'*64}
  queries={'zero_barriers':{'synthetic_zero':'SELECT 0'},'rls_query':'SELECT true','expected_rls':[]}
  q=self.add('readback_queries',queries)
  manifest={'source_sha':SOURCE,'backup_source_sha':'b'*40,'runtime_files':sources,'migration_files':migrations,'backup_canonical_sources':{'backup.mjs':[1,'5'*64]},'adapter_files':{'readback-queries.json':q['sha256']}}
  if manifest_change:manifest_change(manifest)
  manifestref=self.add('source_manifest',manifest)
  exe={'uid':uid,'name':g.contract.GCP_JOB+'/executions/synthetic-1','job':g.contract.GCP_JOB.rsplit('/',1)[-1],'creator':'synthetic@example.com','createTime':'2026-10-11T13:00:00Z','startTime':'2026-10-11T13:00:10Z','completionTime':'2026-10-11T13:10:00Z','succeededCount':1,'taskCount':1,'parallelism':1,'template':{'synthetic':'fixture'}}
  binding={'schema_version':1,'kind':'B02_GCP_BINDING','mode':'MANUAL','job':g.contract.GCP_JOB,'scheduler':g.contract.GCP_SCHEDULER,'executor':g.contract.GCP_EXECUTOR,'invoker':g.contract.GCP_INVOKER,'job_uid':'66666666-2222-4333-8444-555555555555','source_sha':SOURCE,'job_generation':'1','plan_sha256':planhash,'template_sha256':g.sha(g.contract.canonical({k:exe[k] for k in ('taskCount','parallelism','template')})),'image':'us-east1-docker.pkg.dev/'+g.contract.TARGET[0]+'/commerce-b02/transport@sha256:'+'6'*64,'bucket':'synthetic-bucket','oslogin_uid':1001,'oslogin_username':'sa_synthetic','executor_id':'123456789012345','manual_creator':'synthetic@example.com','schedule_utc':'17:00','valid_from':g.contract.GCP_FINANCIAL_START.isoformat(),'valid_until':'2026-10-12T00:00:00Z','activation_id':'synthetic-fixture','first_custody_ref':None}
  br=raw(binding)
  context={'kind':'GCP_CLOUD_RUN','mode':'MANUAL','binding_sha256':g.sha(br),'run_id':run,'source_sha':SOURCE,'plan_sha256':planhash,'scheduled_delivery_proven':False,'execution_uid':uid,'execution':exe['name'],'creator':exe['creator'],'created_at':exe['createTime'],'slot':None}
  auth={'schema_version':1,'kind':'B02_GCP_AUTHORIZATION','context':context,'binding':binding,'binding_ref':ref('/opt/commerce-os/private/daily-b02/gcp-binding.json',br),'caller':{'name':binding['executor_id'],'uid':1001,'username':'sa_synthetic'},'issued_at':'2026-10-11T13:00:20Z','expires_at':'2026-10-11T13:02:20Z'}
  authref=self.add('authorization',auth,'/opt/commerce-os/private/daily-b02/gcp-authorizations/'+run+'.json')
  slot='manual:'+uid;claimref=self.add('claim',{'schema_version':1,'slot_key':slot,'authorization_ref':authref,'run_id':run},'/opt/commerce-os/private/daily-b02/schedule-claims/'+g.sha(slot.encode())+'.json')
  exeref=self.add('execution',exe)
  common={'run_id':run,'plan_sha256':planhash,'backup_source_sha':'b'*40,'backup_contract_version':2,'portal_capsule':portal,'keys_exported':False}
  self.add('source',dict(common,status='B02_SOURCE_VERIFIED',original_key_compared_in_RAM=True,canonical_sources=manifest['backup_canonical_sources']))
  self.add('backup',dict(common,status='B02_LOCAL_CIPHERTEXT_VERIFIED',encrypted=True,format=2,snapshot_consistent=True,private_assets=2))
  files={'source.json':self.refs['source'],'backup.json':self.refs['backup'],'ciphertext.backup.aes':ref('/synthetic/ciphertext.backup.aes',b'ciphertext'),'portal.backup.aes':ref('/synthetic/portal.backup.aes',b'portal')}
  objects={n:{'object':'b02/daily/'+run+'/'+n,'bytes':r['bytes'],'sha256':r['sha256'],'generation':'1','full_download_verified':True} for n,r in files.items()}
  custody=dict(common,status='B02_OFFHOST_CUSTODY_VERIFIED',bucket=binding['bucket'],objects=copy.deepcopy(objects),plaintext_exported=False,backup_decryption_key_exported=False,portal_credentials_archived_encrypted=True)
  custodyref=self.add('custody',custody);files['custody.json']=custodyref
  fifth={'object':'b02/daily/'+run+'/custody.json','bucket':binding['bucket'],'bytes':custodyref['bytes'],'sha256':custodyref['sha256'],'generation':'1','full_download_verified':True,'create_command_succeeded':True};objects['custody.json']=fifth
  report={'status':'SUCCEEDED','run_id':run,'source_sha':SOURCE,'backup_source_sha':'b'*40,'plan_sha256':planhash,'external_copy_verified':True,'restore_verified':False,'backup_contract_version':2,'exports':{n:r for n,r in files.items() if n!='custody.json'},'portal_capsule':portal,'trigger':{'authorization_ref':authref,'claim_ref':claimref}}
  reportref=self.add('root_report',report)
  terminal={'resource':{'type':'cloud_run_job','labels':{'project_id':g.contract.TARGET[0],'job_name':exe['job'],'location':'us-east1'}},'logName':'projects/'+g.contract.TARGET[0]+'/logs/run.googleapis.com%2Fstdout','labels':{'run.googleapis.com/execution_name':'synthetic-1'},'insertId':'synthetic','timestamp':'2026-10-11T13:09:59Z','jsonPayload':{'status':'B02_GCP_OFFSITE_VERIFIED','run_id':run,'source_sha':SOURCE,'execution':exe['name'],'execution_uid':uid,'external_copy_verified':True,'restore_verified':False,'scheduled_delivery_proven':False,'custody_object':fifth,'root_ack':{'status':'SUCCEEDED','run_id':run,'source_sha':SOURCE,'external_copy_verified':True},'export_discard_command_succeeded':True,'ephemeral_key_cleanup':{'key_absent_verified':True,'remove_calls':1,'profile_reads':2}}}
  termref=self.add('terminal_log',terminal)
  downloadref=self.add('download',{'status':'B02_LOCAL_OFFHOST_DOWNLOAD_VERIFIED','proof_scope':'AUTHENTIC_ROOT_OFFHOST','run_id':run,'plan_sha256':planhash,'bucket':binding['bucket'],'objects':objects,'files':files})
  canonical={name:{'path':'/synthetic/repo/'+n,'bytes':1,'sha256':sources[n]} for name,n in (('root','scripts/b02-backup-root.py'),('contract','scripts/b02_backup_contract.py'))}
  relayref=self.add('trigger_relay',{'status':'GCP_TRIGGER_EVIDENCE_COPIED_LOCAL','source_sha':SOURCE,'run_id':run,'plan_sha256':planhash,'custody_object':fifth,'root_report_ref':reportref,'custody_ref':custodyref,'canonical_refs':canonical})
  planfiles=copy.deepcopy(files)
  for key,name in {'root_report':'root-report.json','execution':'trigger-execution.json','download':'relay-download-receipt.json','trigger_relay':'trigger-relay.json','authorization':'trigger-authorization.json','claim':'trigger-claim.json','terminal_log':'trigger-terminal-log.json'}.items():planfiles[name]=self.refs[key]
  self.add('staging_plan',{'status':'FRESH_STAGING_PLAN_VERIFIED_NO_RESTORE','run_id':run,'source_sha':SOURCE,'native_report_sha256':reportref['sha256'],'files':planfiles,'native_window':{'not_before':'2026-10-11T12:59:00Z','not_after':'2026-10-11T13:11:00Z'}})
  control={'run_id':run,'caller_source_sha':SOURCE,'backup_source_sha':'b'*40,'plan_sha256':planhash,'bucket':binding['bucket'],'proof_scope':'AUTHENTIC_ROOT_OFFHOST','root_report_ref':reportref,'source_manifest_ref':manifestref,'relay_receipt_ref':downloadref,'trigger_relay_ref':relayref,'files':files,'canonical_refs':canonical,'gcp_evidence':{'authorization':{'root_ref':authref,'local_ref':authref},'claim':{'root_ref':claimref,'local_ref':claimref},'execution_ref':exeref,'terminal_log_ref':termref}}
  cref=self.add('restore_control',control)
  receipt={'schema_version':1,'status':'RESTORE_VERIFIED_PLAINTEXT_RETAINED','source_sha':SOURCE,'restore_source_sha':SOURCE,'root_caller_source_sha':SOURCE,'backup_source_sha':'b'*40,'run_id':run,'proof_scope':'AUTHENTIC_ROOT_OFFHOST','restore_environment':'LOCAL_COLIMA','production_access':False,'external_effects':False,'control_sha256':g.sha(json.dumps(control,sort_keys=True,separators=(',',':')).encode()),'backup_trigger_proof':{'kind':'GCP_ROOT_AND_PROVIDER_TERMINAL','run_id':run,'execution_uid':uid,'custody_object':fifth},'started_at':'2026-10-11T13:12:00Z','finished_at':'2026-10-11T13:20:00Z','local_isolation':{'environment':'LOCAL_COLIMA','network':'LOOPBACK_ONLY_NO_ROUTES','effective_capabilities_zero':True,'no_new_privileges':True,'external_homes_and_container_state_hidden':True},'checks':{'cluster':{'durability_enabled':True,'loopback_only':True,'unix_socket_disabled':True},'authenticated_before_database_write':True,'readback':{'exact_migration_hashes':True,'integration_secrets_rls_exact':True,'closed_roles':True,'migration_count':1,'zero_safety_barriers':1,'records':2,'events':0,'effects':0},'assets':{'final_assets_stream_hash_verified':True,'private_assets':2,'private_asset_bytes':3,'authenticated_manifest_sha256':'7'*64},'portal':{'verify':True,'restore':True,'owned_plaintext_removed':True,'production_promoted':False}},'cleanup':{'postgres_stopped':True,'processes_stopped':True,'ciphertext_preserved':True,'own_plaintext_retained':True}}
  if receipt_change:receipt_change(receipt)
  rref=self.add('restore_receipt',receipt)
  self.add('restore_export',{'status':'AUTHENTIC_LOCAL_COLIMA_RESTORE_EXPORTED','source_sha':SOURCE,'original_bytes_preserved':True,'production_access':False,'local_receipt_ref':rref,'remote_receipt_ref':rref,'local_control_ref':cref,'remote_control_ref':cref})
 def add(self,name,value,path=None):
  data=raw(value);r=ref(path or '/synthetic/'+name+'.json',data);self.refs[name]=r;self.raws[r['path']]=data;self.docs[name]=copy.deepcopy(value);return r
 def read(self,r):return self.raws[r['path']]
 def validate(self,**kwargs):return g.validate_historical_restore(self.refs,self.read,expected_source_sha=SOURCE,now=kwargs.get('now',NOW))

class RestoreGateTests(unittest.TestCase):
 def test_complete_history_does_not_claim_current_backup_or_install(self):
  f=Fixture();before=copy.deepcopy(f.refs);r=f.validate();self.assertEqual(r['status'],'HISTORICAL_RESTORE_ORIGINALS_VERIFIED');self.assertEqual(f.refs,before)
  self.assertFalse(r['fresh_backup_proven']);self.assertFalse(r['installation_authorized']);self.assertFalse(r['candidate_compatible'])
 def test_history_has_no_invented_age_expiration(self):
  self.assertEqual(Fixture().validate(now=NOW+dt.timedelta(days=100))['status'],'HISTORICAL_RESTORE_ORIGINALS_VERIFIED')
 def test_future_or_reversed_restore_times_rejected(self):
  for field,value in (('started_at','2026-10-11T13:09:00Z'),('finished_at','2026-10-13T00:00:00Z'),('finished_at','2026-10-11T13:11:00Z')):
   with self.subTest(field=field,value=value),self.assertRaisesRegex(Exception,'TIME_CHANGED'):Fixture(lambda r:r.update({field:value})).validate()
 def test_authentication_readback_assets_portal_and_cleanup_are_all_mandatory(self):
  changes=[lambda r:r['checks'].update(authenticated_before_database_write=False),lambda r:r['checks']['readback'].update(closed_roles=False),lambda r:r['checks']['readback'].update(migration_count=68),lambda r:r['checks']['readback'].update(zero_safety_barriers=37),lambda r:r['checks']['assets'].update(private_assets=3),lambda r:r['checks']['portal'].update(restore=False),lambda r:r['cleanup'].update(postgres_stopped=False),lambda r:r['local_isolation'].update(network='host')]
  for change in changes:
   with self.subTest(change=change),self.assertRaises(Exception):Fixture(change).validate()
 def test_synthetic_scope_production_or_external_effects_rejected(self):
  for key,value in (('proof_scope','SYNTHETIC_FIXTURE'),('production_access',True),('external_effects',True),('status','RUNNING')):
   with self.subTest(key=key),self.assertRaisesRegex(Exception,'RECEIPT_CHANGED'):Fixture(lambda r:r.update({key:value})).validate()
 def test_raw_bytes_changed_before_semantic_parse_rejected(self):
  f=Fixture();p=f.refs['restore_receipt']['path'];f.raws[p]+=b' '
  with self.assertRaisesRegex(Exception,'ORIGINAL_CHANGED'):f.validate()
 def test_reserialized_control_with_same_semantics_rejected_by_raw_link(self):
  f=Fixture();p=f.refs['restore_control']['path'];data=json.dumps(f.docs['restore_control'],indent=2).encode();f.raws[p]=data;f.refs['restore_control']=ref(p,data)
  with self.assertRaisesRegex(Exception,'EXPORT_CHANGED'):f.validate()
 def test_duplicate_json_rejected(self):
  f=Fixture();p=f.refs['restore_export']['path'];data=b'{"duplicate":1,"duplicate":2}';f.raws[p]=data;f.refs['restore_export']=ref(p,data)
  with self.assertRaisesRegex(Exception,'DUPLICATE_JSON'):f.validate()
 def test_missing_original_and_size_bound_before_reader(self):
  f=Fixture();del f.refs['claim']
  with self.assertRaisesRegex(Exception,'ORIGINAL_SET'):f.validate()
  f=Fixture();f.refs['authorization']['bytes']=g.MAX_ORIGINAL_BYTES+1
  with patch.object(f,'read',side_effect=AssertionError('must not read')):
   with self.assertRaisesRegex(Exception,'REFERENCE_BOUND'):f.validate()
 def test_cross_run_execution_or_generation_link_rejected(self):
  for name,key,value in (('execution','uid','foreign'),('root_report','run_id','gcp-'+'f'*32),('custody','bucket','foreign-bucket')):
   f=Fixture();d=f.docs[name];d[key]=value;f.add(name,d,f.refs[name]['path'])
   with self.subTest(name=name),self.assertRaises(Exception):f.validate()
 def test_compatible_candidate_requires_equal_schema_and_all_restore_sources(self):
  f=Fixture();r=f.validate();kwargs={'candidate_source_sha':'c'*40,'candidate_migrations':r['migration_files'],'candidate_restore_sources':r['restore_sources']}
  self.assertEqual(g.validate_candidate_compatibility(r,**kwargs)['status'],'HISTORICAL_RESTORE_CANDIDATE_COMPATIBLE')
  for key in ('candidate_migrations','candidate_restore_sources'):
   changed=copy.deepcopy(kwargs);changed[key][next(iter(changed[key]))]='f'*64
   with self.subTest(key=key),self.assertRaises(Exception):g.validate_candidate_compatibility(r,**changed)
 def test_installer_entry_always_rereads_originals(self):
  f=Fixture();r=f.validate();calls=[]
  def read(v):calls.append(v);return f.read(v)
  out=g.validate_restore_for_candidate(f.refs,read,expected_source_sha=SOURCE,now=NOW,candidate_source_sha='c'*40,candidate_migrations=r['migration_files'],candidate_restore_sources=r['restore_sources'])
  self.assertEqual(len(calls),16);self.assertFalse(out['installation_authorized'])

if __name__=='__main__':unittest.main()
