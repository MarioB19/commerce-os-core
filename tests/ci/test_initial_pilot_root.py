"""Synthetic Root/Docker adapters. No actual gateway, credentials or approval."""
import contextlib
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from test_copy_runtime_deployment import fixture, checksum

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('initial_pilot_root_fixture',ROOT/'scripts/initial-pilot-root.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
READ_SERVICES=m.read_services
NETWORK_GUARD=m.network_guard


class PilotRoot(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.private=self.root/'private';self.private.mkdir()
  (self.root/'infra/compose').mkdir(parents=True)
  (self.root/'infra/compose/pilot.yaml').write_bytes((ROOT/'infra/compose/pilot.yaml').read_bytes())
  self.state,rows,self.plan=fixture(0);self.before={}
  self.before={name:next(r for r in rows if r['Id']==cid) for name,cid in self.state['service_inventory'].items()};self.services=copy.deepcopy(self.before)
  self.raw=m.runtime.sealed_bytes(self.state);(self.private/'daily-b02').mkdir();(self.private/'daily-b02/plan.json').write_bytes(self.plan)
  (self.private/'api-web-adoption.json').write_bytes(self.raw)
  self.old=b'COMMERCE_DEPLOY_SCOPE=copy-runtime\n';(self.private/'release.env').write_bytes(self.old)
  self.new=self.old+b'COMMERCE_PILOT_RELEASE_ENV=/synthetic/pilot-release.env\n'
  _,gateway_rows,_=fixture(1);self.gateway=gateway_rows[-1]
  self.gateway['HostConfig'].update(CapDrop=['ALL'],Init=True,PidsLimit=100,Memory=768*1024**2,NanoCpus=300000000,SecurityOpt=['no-new-privileges:true'])
  self.gateway['NetworkSettings']['Networks']={'commerce-os_gateway-01':{'NetworkID':checksum(3000),'Aliases':['waha-01'],'GwPriority':0}}
  self.gateway['Mounts']=[{'Destination':'/app/.sessions','Name':m.VOLUMES[0]},{'Destination':'/app/.media','Name':m.VOLUMES[1]}]
  self.volumes=[{'Name':name,'Driver':'local','Mountpoint':str(self.root/'docker-volumes'/name/'_data'),'Labels':{'com.docker.compose.project':'commerce-os','com.docker.compose.volume':name.removeprefix('commerce-os_')}} for name in m.VOLUMES]
  self.volume_names=sorted(['commerce-os_pg',*m.VOLUMES]);self.new_volumes=copy.deepcopy(self.volumes)
  import re
  pinned=re.search(r'^    image: (.+)$',(ROOT/'infra/compose/pilot.yaml').read_text(),re.M).group(1)
  self.rendered=json.dumps({'name':'commerce-os','services':{'waha-01':{'image':pinned,'restart':'no','init':True,'cap_drop':['ALL'],'pids_limit':100,'mem_limit':768*1024**2,'cpus':0.3,'security_opt':['no-new-privileges:true'],'networks':{'gateway-01':{}},'environment':m.native.env_values(('\n'.join(self.gateway['Config']['Env'])+'\n').encode()),'volumes':[{'type':'volume','source':'sessions','target':'/app/.sessions'},{'type':'volume','source':'media','target':'/app/.media'}]}},'volumes':{'sessions':{'name':m.VOLUMES[0]},'media':{'name':m.VOLUMES[1]}},'networks':{'gateway-01':{'name':'commerce-os_gateway-01'}}})
  now=dt.datetime.now(dt.timezone.utc);self.backup=now-dt.timedelta(seconds=4);self.created=now-dt.timedelta(seconds=2)
  self.owner={'held':True,'hold_at':now.isoformat(),'ownerships':[],'proofs':[],'challenges':[]}
  self.ref={'path':'/synthetic/approval.json','bytes':1,'sha256':'a'*64}
  def ref(name):return{'path':'/synthetic/'+name,'bytes':1,'sha256':'a'*64}
  self.approval={'schema_version':1,'source_sha':'a'*40,'current_release':str(self.root),'run_id':'123-1','operation_id':'11111111-1111-4111-8111-111111111111','volume_mode':'PRESERVE_EXISTING','before_adoption_sha256':m.runtime.sha256(self.raw),'before_plan_sha256':m.runtime.sha256(self.plan),'compose_sha256':m.runtime.sha256(self.rendered.encode()),**{name:ref(name) for name in ('pilot_release_env_ref','new_release_env_ref','administrator_config_ref','backup_before_provision_ref','backup_tools_manifest_ref','volume_inventory_ref','runtime_before_ref')}}
  self.approval['pilot_release_env_ref']['path']='/synthetic/pilot-release.env'
  self.approval['credential_refs']={name:{'path':'/synthetic/gateways/'+name,'bytes':1,'sha256':'a'*64} for name in ('waha-01.env','channel-pilot.env','ingress-pilot.env')}
  self.refs={self.approval['pilot_release_env_ref']['path']:b'COMMERCE_GATEWAY_CONFIG_DIR=/synthetic/gateways\n',self.approval['new_release_env_ref']['path']:self.new,self.approval['administrator_config_ref']['path']:json.dumps({'release_env':str(self.private/'release.env'),'gateway_dir':'/synthetic/gateways','overlay':str(self.root/'absent-overlay')}).encode(),self.approval['volume_inventory_ref']['path']:json.dumps({'names':self.volume_names,'volumes':self.volumes}).encode(),self.approval['runtime_before_ref']['path']:json.dumps({'captured_at':(now-dt.timedelta(seconds=3)).isoformat(),'services':self.before}).encode()}
  self.refs.update({ref['path']:b'synthetic-credential' for ref in self.approval['credential_refs'].values()})
  self.commands=[];self.sessions=0;owner=self
  class Agent:
   def __init__(self,_):pass
   def credentials(self,*args,**kwargs):return{'api_key':'synthetic-only'}
   def compose(self,*args):
    owner.commands.append(('compose',*args))
    if args==('create','--no-build','--no-recreate','--pull','never','waha-01'):
     owner.services['waha-01']=copy.deepcopy(owner.gateway)
     if owner.approval['volume_mode']=='CREATE_EMPTY':
      owner.volumes=copy.deepcopy(owner.new_volumes);owner.volume_names=sorted(['commerce-os_pg',*m.VOLUMES])
      for row in owner.volumes:Path(row['Mountpoint']).mkdir(parents=True)
    else:raise AssertionError(args)
    return ''
   def snapshot(self,slot):return copy.deepcopy(owner.services['waha-01'])
   def readback(self,slot):
    if not owner.services['waha-01']['State']['Running']:raise ValueError('GATEWAY_STOPPED_READBACK_REQUIRED')
    return{'slot':1,'running':True,'session_count':owner.sessions,'connected_sessions':0,'image_digest':owner.gateway['Image'],'network_present':True,'volumes_preserved':True}
  self.stack=contextlib.ExitStack()
  def patchit(obj,name,**kw):return self.stack.enter_context(patch.object(obj,name,**kw))
  patchit(m,'ROOT',new=self.root);patchit(m.server,'PRIVATE',new=self.private);patchit(m.os,'geteuid',return_value=0);patchit(m.sys,'platform',new='linux')
  patchit(m,'load_approval',side_effect=lambda _:(self.ref,self.approval));patchit(m.native,'protected_bytes',side_effect=lambda path:Path(path).read_bytes());patchit(m.native,'read_reference',side_effect=lambda ref:self.refs[ref['path']]);patchit(m.native,'acquire_locks',return_value=[])
  patchit(m,'network_guard',return_value={});patchit(m,'frozen_guard',side_effect=lambda *_:copy.deepcopy(self.owner));patchit(m,'read_services',side_effect=lambda *_:copy.deepcopy(self.services));patchit(m.administrator,'Administrator',new=Agent)
  patchit(m.runtime,'snapshot',side_effect=lambda *_:{'services':copy.deepcopy(self.before),'release':m.native.env_values(self.old),'files':{'release.env':self.old}})
  patchit(m.runtime,'reviewed_backup_module',side_effect=lambda *_:contextlib.nullcontext(None));patchit(m.runtime,'prior_backup_guard',side_effect=self.prior_backup_guard)
  patchit(m.runtime,'gateway_rendered_bindings',return_value=True)
  patchit(m.server,'database',side_effect=lambda *_:json.dumps({'created_at':self.created.isoformat()}))
  patchit(m.server,'command',side_effect=self.command)
 def tearDown(self):self.stack.close();self.tmp.cleanup()
 def prior_backup_guard(self,_ref,before,_tools):
  self.assertEqual(before['source_sha'],self.approval['source_sha']);return self.backup
 def command(self,args,*_):
  self.commands.append(tuple(args))
  if args[:3]==['docker','volume','ls']:return '\n'.join(self.volume_names)
  if args[:3]==['docker','volume','inspect']:return json.dumps(self.volumes)
  if args[0]=='sh':return self.rendered
  if args[:3]==['docker','image','inspect']:return json.dumps([{'Id':self.gateway['Image']}])
  if args[:3]==['docker','network','connect']:
   row=next(row for row in self.services.values() if row['Id']==args[-1]);row['NetworkSettings']['Networks']['commerce-os_gateway-01']=copy.deepcopy(self.gateway['NetworkSettings']['Networks']['commerce-os_gateway-01']);row['NetworkSettings']['Networks']['commerce-os_gateway-01']['NetworkID']=checksum(3000);return ''
  if args[:2]==['docker','start']:
   self.services['waha-01']['State'].update(Running=True,Pid=777,StartedAt=dt.datetime.now(dt.timezone.utc).isoformat());self.services['waha-01']['NetworkSettings']['Networks']['commerce-os_gateway-01']['NetworkID']=checksum(3000);return ''
  raise AssertionError(args)
 def mutations(self):return[c for c in self.commands if c[0]=='compose' or c[:3]==('docker','network','connect') or c[:2]==('docker','start')]
 def test_prepare_creates_exactly_one_stopped_gateway_and_preserves_existing_services(self):
  result=m.execute('prepare','synthetic');self.assertEqual(result['status'],'PREPARED_STOPPED');self.assertIsNone(result['sessions_observed']);self.assertFalse(result['adopted'])
  self.assertEqual([c for c in self.mutations() if c[0]=='compose'],[('compose','create','--no-build','--no-recreate','--pull','never','waha-01')]);self.assertFalse(self.services['waha-01']['State']['Running'])
  self.assertEqual(len(self.mutations()),3);self.assertEqual((self.private/'release.env').read_bytes(),self.new)
 def test_absence_approved_creates_only_two_empty_owned_volumes(self):
  self.approval['volume_mode']='CREATE_EMPTY';self.volumes=[];self.volume_names=['commerce-os_pg']
  self.refs[self.approval['volume_inventory_ref']['path']]=json.dumps({'names':self.volume_names,'volumes':[]}).encode()
  self.gateway['NetworkSettings']['Networks']['commerce-os_gateway-01']['NetworkID']=''
  result=m.execute('prepare','synthetic');self.assertEqual(result['volumes_created'],2)
  for row in self.volumes:self.assertEqual(list(Path(row['Mountpoint']).iterdir()),[])
  result=m.execute('start','synthetic');self.assertEqual(result['status'],'HTTP_VERIFIED_ADOPTION_REQUIRED')
 def test_unapproved_absence_cannot_create_volumes(self):
  self.volumes=[];self.volume_names=['commerce-os_pg']
  with self.assertRaisesRegex(Exception,'PRESERVED_VOLUMES_REQUIRED'):m.execute('prepare','synthetic')
  self.assertEqual(self.mutations(),[])
 def test_start_uses_observed_cid_and_replay_is_read_only(self):
  m.execute('prepare','synthetic');result=m.execute('start','synthetic');self.assertEqual(result['status'],'HTTP_VERIFIED_ADOPTION_REQUIRED');self.assertFalse(result['hold_released'])
  self.assertEqual([c for c in self.mutations() if c[:2]==('docker','start')],[('docker','start',self.gateway['Id'])])
  before=list(self.mutations());m.execute('readback','synthetic');self.assertEqual(self.mutations(),before)
  with self.assertRaisesRegex(Exception,'START_REQUIRES_READBACK'):m.execute('start','synthetic')
  self.assertEqual(self.mutations(),before)
 def test_nonzero_sessions_remain_uncertain_and_are_not_stopped_or_deleted(self):
  m.execute('prepare','synthetic');self.sessions=1
  with self.assertRaisesRegex(Exception,'EXISTING_SESSIONS_REQUIRE_REVIEW'):m.execute('start','synthetic')
  self.assertTrue((self.private/'initial-pilot/123-1/start-intent.json').exists());self.assertTrue(self.services['waha-01']['State']['Running'])
  self.assertFalse(any('rm' in c or 'stop' in c for c in self.commands))
 def test_created_inventory_preserves_empty_network_id_without_inventing_it(self):
  self.gateway['NetworkSettings']['Networks']['commerce-os_gateway-01']['NetworkID']=''
  self.services['waha-01']=copy.deepcopy(self.gateway)
  def inspect(args,*_):
   if args[:3]==['docker','ps','-aq']:return ' '.join(row['Id'] for row in self.services.values())
   if args[:2]==['docker','inspect']:return json.dumps(list(self.services.values()))
   raise AssertionError(args)
  with patch.object(m.server,'command',side_effect=inspect):actual=READ_SERVICES(self.root,self.state)
  self.assertEqual(actual['waha-01']['NetworkSettings']['Networks']['commerce-os_gateway-01']['NetworkID'],'')
 def test_network_snapshot_has_only_live_endpoints_and_rejects_foreign_members(self):
  m.execute('prepare','synthetic')
  self.services['waha-01']['NetworkSettings']['Networks']['commerce-os_gateway-01']['NetworkID']=''
  names=set().union(*(set(row['NetworkSettings']['Networks']) for row in self.services.values()));rows=[]
  for name in names:
   rows.append({'Name':name,'Id':checksum(3000 if name=='commerce-os_gateway-01' else 500),'Driver':'bridge','Internal':False,'EnableIPv6':False,'IPAM':{},'Options':{},'Labels':{},'Containers':{row['Id']:{} for row in self.services.values() if row['State']['Running'] and name in row['NetworkSettings']['Networks']}})
  state={'network_baseline':{row['Name']:{k:v for k,v in row.items() if k!='Containers'} for row in rows if row['Name']!='commerce-os_gateway-01'}}
  with patch.object(m.server,'command',side_effect=lambda *_:json.dumps(rows)),patch.object(m.runtime,'topology',return_value=True):
   self.assertIn('commerce-os_gateway-01',NETWORK_GUARD(self.root,state,self.services,{}))
   next(row for row in rows if row['Name']=='commerce-os_gateway-01')['Containers']['foreign']={}
   with self.assertRaisesRegex(Exception,'NETWORK_FOREIGN_ENDPOINT'):NETWORK_GUARD(self.root,state,self.services,{})
 def test_changed_baseline_rejected_before_docker_or_file_mutation(self):
  self.approval['before_adoption_sha256']='f'*64
  with self.assertRaisesRegex(Exception,'BASELINE_CAS_CHANGED'):m.execute('prepare','synthetic')
  self.assertEqual(self.commands,[]);self.assertEqual((self.private/'release.env').read_bytes(),self.old)
 def test_changed_compose_rejected_before_effects(self):
  self.approval['compose_sha256']='f'*64
  with self.assertRaisesRegex(Exception,'REVIEWED_COMPOSE_CHANGED'):m.execute('prepare','synthetic')
  self.assertEqual(self.mutations(),[]);self.assertEqual((self.private/'release.env').read_bytes(),self.old)
 def test_backup_after_operation_rejected_before_effects(self):
  self.backup=self.created+dt.timedelta(seconds=1)
  with self.assertRaisesRegex(Exception,'BACKUP_BEFORE_OPERATION'):m.execute('prepare','synthetic')
  self.assertEqual(self.mutations(),[])
 def test_preserved_volume_drift_rejected_before_effects(self):
  self.volumes[0]['Mountpoint']='/foreign'
  with self.assertRaisesRegex(Exception,'PRESERVED_VOLUMES_REQUIRED'):m.execute('prepare','synthetic')
  self.assertEqual(self.mutations(),[])
 def test_existing_journal_does_not_replay_creation(self):
  m.execute('prepare','synthetic');before=list(self.mutations())
  with self.assertRaisesRegex(Exception,'EXISTING_JOURNAL_REQUIRES_READBACK'):m.execute('prepare','synthetic')
  self.assertEqual(self.mutations(),before)
 def test_start_refuses_changed_worker_or_gateway_identity(self):
  m.execute('prepare','synthetic');self.services['api']['Id']=checksum(9876)
  with self.assertRaisesRegex(Exception,'OPERATION_INSTANCE_CHANGED'):m.execute('start','synthetic')
  self.assertFalse(any(c[:2]==('docker','start') for c in self.commands))
 def test_start_refuses_recreated_network_before_any_start(self):
  m.execute('prepare','synthetic')
  with patch.object(m,'network_guard',return_value={'commerce-os_gateway-01':{'Id':'different'}}):
   with self.assertRaisesRegex(Exception,'NETWORK_IDENTITY_CHANGED'):m.execute('start','synthetic')
  self.assertFalse(any(c[:2]==('docker','start') for c in self.commands))
  self.assertFalse((self.private/'initial-pilot/123-1/start-intent.json').exists())
 def test_definition_rejects_ports_autostart_and_storage_substitution(self):
  for field in ('ports','autostart','volume'):
   row=copy.deepcopy(self.gateway)
   if field=='ports':row['HostConfig']['PortBindings']={'3000/tcp':[{'HostPort':'3000'}]}
   if field=='autostart':row['Config']['Env'].append('WHATSAPP_START_SESSION=default')
   if field=='volume':row['Mounts'][0]['Name']='foreign'
   with self.subTest(field=field),self.assertRaises(Exception):m.gateway_guard(row,self.gateway['Image'])
 def test_rendered_memory_accepts_only_canonical_numeric_or_decimal_string(self):
  rendered=json.loads(self.rendered);pinned=rendered['services']['waha-01']['image']
  for value in (768*1024**2,str(768*1024**2)):
   rendered['services']['waha-01']['mem_limit']=value
   m.rendered_guard(json.dumps(rendered).encode(),pinned)
  for value in ('768m','805306368.0',float(805306368),805306367,None,True):
   rendered['services']['waha-01']['mem_limit']=value
   with self.subTest(value=value),self.assertRaisesRegex(Exception,'REVIEWED_DEFINITION_UNSAFE'):
    m.rendered_guard(json.dumps(rendered).encode(),pinned)
 def test_rendered_dependencies_cannot_create_other_services(self):
  for name,value in (('depends_on',{'postgres':{'condition':'service_started'}}),('build',{'context':'.'}),('links',['api']),('volumes_from',['postgres'])):
   rendered=json.loads(self.rendered);pinned=rendered['services']['waha-01']['image']
   rendered['services']['waha-01'][name]=value
   with self.subTest(name=name),self.assertRaisesRegex(Exception,'REVIEWED_DEFINITION_UNSAFE'):
    m.rendered_guard(json.dumps(rendered).encode(),pinned)
 def test_docker_default_oom_normalization_preserves_safe_identity(self):
  created=copy.deepcopy(self.gateway);created['HostConfig']['OomKillDisable']=False
  running=copy.deepcopy(created);running['HostConfig']['OomKillDisable']=None
  self.assertEqual(m.gateway_identity(created),m.gateway_identity(running))
  self.assertIsNone(running['HostConfig']['OomKillDisable'])
  m.gateway_guard(running,self.gateway['Image'])
  running['HostConfig']['OomKillDisable']=True
  with self.assertRaisesRegex(Exception,'CANONICAL_DEFINITION_REQUIRED'):m.gateway_guard(running,self.gateway['Image'])


if __name__=='__main__':unittest.main()
