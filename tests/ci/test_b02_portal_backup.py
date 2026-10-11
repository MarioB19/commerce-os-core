import contextlib
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import b02_backup_contract as c

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
r = load('portal_b02_root', 'b02-backup-root.py')
t = load('portal_b02_transport', 'b02-backup-ci.py')

def ref(path):
    raw = Path(path).read_bytes(); return {'path': str(path), 'bytes': len(raw), 'sha256': c.sha256(raw)}
def put(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True); Path(path).write_bytes(value); Path(path).chmod(0o600); return ref(path)
def json_raw(value): return (json.dumps(value, sort_keys=True) + '\n').encode()
def portal():
    value = dict(source_sha='a'*40, run_id='77-1', container_id='d'*64, image='sha256:'+'e'*64, proxy_network='commerce-os_proxy')
    for field, path in [('report_ref',c.PORTAL_BASE/'current.json'),('runtime_env_ref',c.PORTAL_BASE/'releases/77-1/runtime.env'),('manifest_ref',c.PRIVATE.parent/'releases/new/portal-manifest.json')]:
        value[field] = {'path':str(path),'bytes':1,'sha256':'f'*64}
    return value

def row(cid):
    return {'Id':cid,'Name':'/service-'+cid[:2],'Image':'sha256:'+'e'*64,'Config':{'Env':['SYNTHETIC_ONLY=value']},'HostConfig':{},'Mounts':[],
            'NetworkSettings':{'Networks':{'core':{'NetworkID':'n'*64,'Aliases':['z','a'],'GwPriority':0,'IPAddress':'10.0.0.2'}}},
            'State':{'Running':True,'Paused':False,'Restarting':False,'Pid':42,'StartedAt':'one'}}

def capsule(): return dict(source_sha='a'*40,run_id='77-1',image='sha256:'+'e'*64,proxy_network='commerce-os_proxy',format='COMOSP01',private_files=14,sqlite_snapshot_consistent=True)

class PortalContracts(unittest.TestCase):
    def test_optional_v2_and_stage_v3_do_not_change_legacy_v1(self):
        self.assertEqual(c.plan_version({'schema_version':1}),1)
        p={'schema_version':2,'portal_backup':portal()|{'state_path':str(c.PORTAL_BASE/'state'),'state_uid':1000}}
        self.assertEqual(c.plan_version(p),2)
        for stage,count in [('CORE_PREPARED',5),('OPERATING',8),('OPERATING',11)]:
            self.assertEqual(c.plan_version(p|{'schema_version':3,'runtime_stage':stage,'runtime_projection_version':2,'preserved_runtime':{str(i):'a'*64 for i in range(count)}}),3)
        for patch in [{'state_uid':0},{'state_path':'/tmp/state'},{'runtime_env_ref':{'path':'/tmp/env','bytes':1,'sha256':'f'*64}},{'source_sha':None}]:
            with self.assertRaises(RuntimeError): c.plan_version(p|{'portal_backup':p['portal_backup']|patch})
        with self.assertRaises(RuntimeError): c.plan_version(p|{'schema_version':1})
        with self.assertRaises(RuntimeError): c.plan_version(p|{'schema_version':3,'runtime_stage':'CORE_PREPARED','runtime_projection_version':2,'preserved_runtime':{}})

    def test_v2_exact_four_exports_and_capsule_metadata_no_credentials(self):
        report={'backup_contract_version':2,'portal_capsule':capsule(),'exports':{name:{'bytes':1,'sha256':'a'*64} for name in c.PORTAL_EXPORTS}}
        self.assertEqual(c.export_names(report),c.PORTAL_EXPORTS)
        for bad in [report|{'portal_capsule':None},report|{'exports':{name:ref for name,ref in report['exports'].items() if name!='portal.backup.aes'}},report|{'portal_capsule':capsule()|{'session_secret':'FORBIDDEN'}},report|{'exports':report['exports']|{'runtime.env':{'bytes':1,'sha256':'a'*64}}}]:
            with self.assertRaises(RuntimeError): c.export_names(bad)

    def test_custody_requires_coetaneous_capsule_and_aggregate_under_one_gib(self):
        report={'run_id':'123-1','plan_sha256':'b'*64,'backup_contract_version':2,'portal_capsule':capsule(),'exports':{name:{'bytes':100,'sha256':'a'*64} for name in c.PORTAL_EXPORTS}}
        custody={'status':'B02_OFFHOST_CUSTODY_VERIFIED','run_id':'123-1','plan_sha256':'b'*64,'bucket':'own-bucket','objects':{name:ref|{'object':'b02/daily/123-1/'+name,'generation':'1','full_download_verified':True} for name,ref in report['exports'].items()},'keys_exported':False,'plaintext_exported':False,'backup_contract_version':2,'backup_decryption_key_exported':False,'portal_credentials_archived_encrypted':True,'portal_capsule':capsule()}
        c.validate_custody(custody,report,'own-bucket')
        for patch in [{'portal_capsule':capsule()|{'run_id':'78-1'}},{'backup_decryption_key_exported':True},{'portal_credentials_archived_encrypted':False}]:
            with self.assertRaisesRegex(RuntimeError,'PORTAL_CUSTODY'): c.validate_custody(custody|patch,report,'own-bucket')
        huge=copy.deepcopy(report);huge['exports']['ciphertext.backup.aes']['bytes']=c.MAX_BYTES
        with self.assertRaisesRegex(RuntimeError,'TOTAL_COST'): c.validate_custody(custody,huge,'own-bucket')

    def test_projection_v2_stable_network_aliases_and_full_v1_restart_detection(self):
        value=row('a'*64); changed=copy.deepcopy(value);changed['NetworkSettings']['Networks']['core']['Aliases'].reverse();changed['State']['Pid']=99;changed['NetworkSettings']['Networks']['core']['IPAddress']='10.0.0.3'
        self.assertEqual(c.projection_digest(value,2),c.projection_digest(changed,2))
        self.assertNotEqual(c.projection_digest(value),c.projection_digest(changed))
        changed['NetworkSettings']['Networks']['core']['GwPriority']=1
        self.assertNotEqual(c.projection_digest(value,2),c.projection_digest(changed,2))
        self.assertNotIn('SYNTHETIC_ONLY',json.dumps({'digest':c.projection_digest(value,2)}))

    def test_transport_portal_header_and_full_generation_bytes_are_verified(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);source=base/'portal.backup.aes';put(source,b'COMOSP01'+b'x'*64);calls=[]
            def command(args,**kwargs):
                calls.append(args)
                if 'describe' in args:return subprocess.CompletedProcess(args,0,json.dumps({'generation':'2','size':source.stat().st_size}),'')
                if '--if-generation-match=0' not in args:put(args[-2],source.read_bytes())
                return subprocess.CompletedProcess(args,0,'','')
            result=t.upload_verified(source,'gs://own-bucket/b02/daily/123-1/portal.backup.aes',base/'readback',command)
            self.assertTrue(result['full_download_verified']);self.assertIn('gs://own-bucket/b02/daily/123-1/portal.backup.aes#2',calls[-1])
            put(source,b'COMOSB02'+b'x'*64)
            with self.assertRaisesRegex(RuntimeError,'CIPHERTEXT_REQUIRED'):t.export_reference(source,'portal.backup.aes')

    def test_root_rejects_private_pdf_manifest_traversal_before_docker_or_copy(self):
        runner=r.BackupRunner.__new__(r.BackupRunner);p=portal()|{'state_path':str(c.PORTAL_BASE/'state'),'state_uid':1000}
        runner.plan={'schema_version':2,'portal_backup':p,'preserved_runtime':{p['container_id']:'a'*64}};runner.plan_sha256='b'*64;runner.inspect=mock.Mock()
        manifest={'source_sha':p['source_sha'],'origin':'https://ciclo.inovaris.online','pdfs':{name:'e'*64 for name in c.PDF_NAMES}}
        manifest['pdfs']['../escape.pdf']=manifest['pdfs'].pop(c.PDF_NAMES[0]);raw=json_raw(manifest)
        report={'status':'ORIGIN_READY','run_id':p['run_id'],'source_sha':p['source_sha'],'image':p['image'],'container':'mcl-portal-'+p['run_id'],'proxy_network':p['proxy_network'],'private_pdfs_verified':10,'portal_manifest_sha256':c.sha256(raw)}
        refs={p['manifest_ref']['path']:raw,p['report_ref']['path']:json_raw(report),p['runtime_env_ref']['path']:b'X=synthetic\n'}
        adoption={'schema_version':2,'portal':{name:p[name] for name in c.PORTAL_FIELDS},'b02_plan_sha256':runner.plan_sha256,'preserved_runtime':runner.plan['preserved_runtime']}
        with mock.patch.object(r,'read_file',return_value=json_raw(adoption)),mock.patch.object(r,'ref_read',side_effect=lambda value:refs[value['path']]),self.assertRaisesRegex(RuntimeError,'PORTAL_REPORT_DRIFT'):runner.portal_guard()
        runner.inspect.assert_not_called()

    def test_global_deadline_expired_never_starts_command(self):
        runner=r.BackupRunner.__new__(r.BackupRunner);runner.docker=['docker'];runner.deadline_at=time.monotonic()-1
        with mock.patch.object(r.subprocess,'run') as call, self.assertRaisesRegex(RuntimeError,'GLOBAL_DEADLINE'):runner.command(['ps'])
        call.assert_not_called()

    def test_complete_transport_consumes_four_full_downloads_then_matching_root_ack(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);config={'run_id':'123-1','source_sha':'a'*40,'scheduled':False,'bucket':'own-bucket','plan_sha256':'b'*64,
                'controller_sha256':c.sha256((ROOT/'scripts/b02-backup-root.py').read_bytes()),'contract_sha256':c.sha256((ROOT/'scripts/b02_backup_contract.py').read_bytes())}
            contents={'ciphertext.backup.aes':b'COMOSB02'+b'x'*64,'portal.backup.aes':b'COMOSP01'+b'y'*64,'source.json':b'{"public":true}','backup.json':b'{"public":true}'}
            report={'run_id':'123-1','source_sha':'a'*40,'plan_sha256':'b'*64,'status':'LOCAL_CUSTODY_PENDING','backup_contract_version':2,'portal_capsule':capsule(),
                    'exports':{name:{'path':'/private/'+name,'bytes':len(raw),'sha256':c.sha256(raw)} for name,raw in contents.items()}}
            objects={};downloads=[];events=[];remote_receipt=None
            metadata={'name':'own-bucket','projectNumber':c.PROJECT_NUMBER,'location':'US-EAST1','storageClass':'STANDARD',
                'iamConfiguration':{'publicAccessPrevention':'enforced','uniformBucketLevelAccess':{'enabled':True}},
                'lifecycle':{'rule':[{'action':{'type':'Delete'},'condition':{'age':30}}]},'softDeletePolicy':{'retentionDurationSeconds':'604800'}}
            def command(args,**kwargs):
                nonlocal remote_receipt
                value=''
                if args[0]=='ssh-keygen':
                    p=Path(args[args.index('-f')+1]);put(p,b'SYNTHETIC ONLY');put(p.with_suffix('.pub'),b'SYNTHETIC PUBLIC ONLY')
                elif args[:4]==['gcloud','compute','instances','describe']:
                    value=json.dumps({'id':c.VM_ID,'name':c.TARGET[1],'status':'RUNNING','zone':'https://www.googleapis.com/compute/v1/projects/'+c.TARGET[0]+'/zones/'+c.TARGET[2]})
                elif args[:4]==['gcloud','storage','buckets','describe']:value=json.dumps(metadata)
                elif args[:3]==['gcloud','compute','ssh']:
                    action=args[-1]
                    if ' status ' in action:value=json.dumps(report)
                    elif 'systemctl show' in action:value='LoadState=loaded\nActiveState=inactive\nMainPID=0\n'
                    elif ' ack ' in action:
                        self.assertEqual(set(downloads),set(c.PORTAL_EXPORTS)|{'custody.json'});self.assertIsNotNone(remote_receipt)
                        receipt=json.loads(remote_receipt);c.validate_custody(receipt,report,'own-bucket')
                        self.assertIn('--receipt-sha256 '+c.sha256(remote_receipt),action);events.append('ack');value=json.dumps({'status':'SUCCEEDED','external_copy_verified':True})
                    elif ' discard-export ' in action:events.append('discard')
                elif args[:3]==['gcloud','compute','scp']:
                    source,destination=args[-2:]
                    if source.startswith(c.TARGET[1]+':'):put(destination,contents[source.rsplit('/',1)[-1]])
                    else:remote_receipt=Path(source).read_bytes()
                elif args[:4]==['gcloud','storage','objects','describe']:
                    value=json.dumps({'generation':'9','size':len(objects[args[4]])})
                elif args[:3]==['gcloud','storage','cp']:
                    if '--if-generation-match=0' in args:
                        source,uri=args[-3:-1];self.assertNotIn(uri,objects);objects[uri]=Path(source).read_bytes()
                    else:
                        uri,destination=args[-3:-1];self.assertTrue(uri.endswith('#9'));raw=objects[uri[:-2]];put(destination,raw);downloads.append(uri.rsplit('/',1)[-1][:-2])
                else:self.fail('unexpected boundary '+str(args[:4]))
                return subprocess.CompletedProcess(args,0,value,'')
            upload=t.upload_verified
            with mock.patch.object(t,'transport_config',return_value=config),mock.patch.object(t,'main_head'),mock.patch.object(t,'command',side_effect=command),mock.patch.object(t,'upload_verified',side_effect=lambda p,u,r:upload(p,u,r,command)),mock.patch.object(t,'remove_ephemeral_key'),mock.patch.dict(os.environ,{'RUNNER_TEMP':temp}),mock.patch.object(sys,'argv',['b02-backup-ci.py']),contextlib.redirect_stdout(__import__('io').StringIO()) as output:
                t.main()
            result=json.loads(output.getvalue());self.assertEqual(result['backup_contract_version'],2);self.assertTrue(result['portal_ciphertext']['full_download_verified']);self.assertFalse(result['restore_verified']);self.assertEqual(events,['ack','discard'])
            self.assertEqual(set(objects),{'gs://own-bucket/b02/daily/123-1/'+name for name in (*c.PORTAL_EXPORTS,'custody.json')})
            self.assertEqual(list((base/'commerce-b02-123-1').iterdir()),[])


class ReviewedTools(unittest.TestCase):
    @contextlib.contextmanager
    def fixture(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp).resolve();private=base/'opt/commerce-os/private';daily=private/'daily-b02';daily.mkdir(parents=True,mode=0o700)
            candidate=private.parent/'releases/candidate';candidate.mkdir(parents=True);put(candidate/'RELEASE.json',json_raw({'source_sha':'a'*40}))
            old={'schema_version':1,'source_sha':'c'*40,'enabled':True,'schedule_enabled':False,'storage_path':str(private/'storage'),'canonical_sources':{},'controller_sources':{},'postgres':{'container_id':'b'*64},'original_minimum_ref':{'path':str(c.ORIGINAL_MINIMUM),'bytes':87,'sha256':'1'*64},'docker_config_path':str(private/'docker/config.json'),'bucket':'own-bucket','preserved_runtime':{'b'*64:'f'*64}}
            put(old['docker_config_path'],b'{}')
            for name in ('foundation_ref','promotion_ref','applied_plan_ref','admin_env_ref','restore_env_ref'):old[name]=put(private/(name+'.json'),b'{"synthetic":true}')
            for name in c.SOURCE_FILES:old['canonical_sources'][name]=put(private/(name+'.public'),b'CANONICAL SYNTHETIC '+name.encode())
            for name in r.CONTROLLER_NAMES[:2]:old['controller_sources'][name]=put(daily/name,b'OLD '+name.encode())['sha256']
            old_plan=put(daily/'plan.json',json_raw(old));old_adoption=put(private/'api-web-adoption.json',b'{"schema_version":2,"synthetic":true}\n')
            rows={cid:row(cid) for cid in ('b'*64,'d'*64,'1'*64,'2'*64,'3'*64)}
            p=portal();p['manifest_ref']['path']=str(candidate/'portal-manifest.json')
            adoption={'schema_version':3,'runtime_stage':'CORE_PREPARED','portal':p,'preserved_runtime':{cid:c.projection_digest(v,2) for cid,v in rows.items()},'b02_plan_ref':{'path':str(daily/'plan.json'),'bytes':old_plan['bytes'],'sha256':old_plan['sha256']}}
            approved={'schema_version':1,'source_sha':'a'*40,'before_plan_sha256':old_plan['sha256'],'before_adoption_sha256':old_adoption['sha256'],'runtime_stage':'CORE_PREPARED','tools':{name:put(candidate/'scripts'/name,b'REVIEWED '+name.encode()) for name in r.CONTROLLER_NAMES}}
            approval=put(private/'controller-approvals/approved.json',json_raw(approved))
            lstat=Path.lstat
            def rooted(path):
                value=lstat(path);return SimpleNamespace(**{name:getattr(value,name) for name in ('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns','st_mode','st_nlink')},st_uid=0)
            def command(args,**kwargs):
                return subprocess.CompletedProcess(args,0,'\n'.join(rows) if args[-3:]==['ps','-aq','--no-trunc'] else json.dumps(list(rows.values())),'')
            with mock.patch.object(r,'PRIVATE',private),mock.patch.object(r,'DAILY',daily),mock.patch.object(c,'PRIVATE',private),mock.patch.object(r.os,'geteuid',return_value=0),mock.patch.object(r.sys,'platform','linux'),mock.patch.object(r,'read_file',side_effect=lambda path,**kw:Path(path).read_bytes()),mock.patch.object(r,'protected_parents'),mock.patch.object(r,'controller_update_locks',side_effect=lambda held=None:contextlib.nullcontext()),mock.patch.object(r,'original_minimum_read',return_value=b'BACKUP_ENCRYPTION_KEY='+b'1'*64+b'\n'),mock.patch.object(r,'source_storage',return_value=private/'storage'),mock.patch.object(r,'storage_custody'),mock.patch.object(r.subprocess,'run',side_effect=command),mock.patch.object(Path,'lstat',rooted):
                yield SimpleNamespace(base=base,private=private,daily=daily,candidate=candidate,old=old,old_plan=old_plan,old_adoption=old_adoption,approval=approval,approved=approved,rows=rows,adoption=adoption)

    def invoke(self,f):return r.prepare_reviewed_controllers(f.approval,f.candidate,'a'*40,f.old_plan['sha256'],f.old_adoption['sha256'],f.adoption,f.rows)

    def test_root_precondition_and_cas_fail_before_tool_writes(self):
        with mock.patch.object(r.os,'geteuid',return_value=501),mock.patch.object(r,'write_private') as write,self.assertRaisesRegex(RuntimeError,'LINUX_ROOT'):r.prepare_reviewed_controllers({},'/tmp','a'*40,'b'*64,'c'*64,{},{} )
        write.assert_not_called()
        with self.fixture() as f:
            put(f.daily/'plan.json',json_raw(f.old|{'schedule_enabled':True}))
            with mock.patch.object(r,'write_private') as write,self.assertRaisesRegex(RuntimeError,'CAS_CONFLICT'):self.invoke(f)
            write.assert_not_called()

    def test_approved_hash_drift_does_not_auto_pin_or_install(self):
        with self.fixture() as f:
            put(f.candidate/'scripts'/c.PORTAL_HELPER,b'UNAPPROVED CHANGED BYTES')
            with mock.patch.object(r,'write_private') as write,self.assertRaisesRegex(RuntimeError,'SEALED_REFERENCE_DRIFT'):self.invoke(f)
            write.assert_not_called();self.assertEqual(ref(f.daily/'plan.json'),f.old_plan)

    def test_installs_exact_approved_three_tools_retains_old_pair_and_preserves_canonical_fields(self):
        with self.fixture() as f:
            result=self.invoke(f)
            self.assertFalse(result['pair_written']);self.assertEqual(ref(f.daily/'plan.json'),f.old_plan);self.assertEqual(ref(f.private/'api-web-adoption.json'),f.old_adoption)
            for name in r.CONTROLLER_NAMES:self.assertEqual(ref(f.daily/name)['sha256'],f.approved['tools'][name]['sha256'])
            self.assertEqual(result['plan']['source_sha'],f.old['source_sha']);self.assertEqual(result['plan']['canonical_sources'],f.old['canonical_sources']);self.assertFalse(result['plan']['schedule_enabled'])
            self.assertEqual(result['adoption']['b02_plan_ref'],{'path':str(f.daily/'plan.json'),'bytes':len(result['plan_bytes']),'sha256':result['plan_sha256']})
            journal=json.loads((Path(result['history_path'])/'journal.json').read_bytes());self.assertEqual(journal['status'],'TOOLS_INSTALLED_PAIR_CAS_PENDING')
            self.assertEqual((Path(result['history_path'])/'plan.before.json').read_bytes(),json_raw(f.old))
            with self.assertRaisesRegex(RuntimeError,'PAIR_NOT_APPLIED'):r.mark_pair_applied(result['history_path'],result['plan_sha256'],result['adoption_sha256'],{})
            put(f.daily/'plan.json',result['plan_bytes']);put(f.private/'api-web-adoption.json',result['adoption_bytes'])
            self.assertEqual(r.mark_pair_applied(result['history_path'],result['plan_sha256'],result['adoption_sha256'],{})['status'],'TOOLS_INSTALLED_PAIR_APPLIED')
            self.assertEqual(r.mark_pair_applied(result['history_path'],result['plan_sha256'],result['adoption_sha256'],{})['status'],'TOOLS_INSTALLED_PAIR_APPLIED')

    def test_partial_install_is_explicit_and_never_writes_plan_or_adoption(self):
        with self.fixture() as f:
            actual=r.write_private
            def fail(path,value,**kw):
                if Path(path)==f.daily/'b02_backup_contract.py':raise OSError('synthetic failure')
                actual(path,value,**kw)
            with mock.patch.object(r,'write_private',side_effect=fail),self.assertRaises(OSError):self.invoke(f)
            self.assertEqual(ref(f.daily/'plan.json'),f.old_plan);self.assertEqual(ref(f.private/'api-web-adoption.json'),f.old_adoption)
            journals=list((f.daily/'controller-updates').glob('*/journal.json'));self.assertEqual(len(journals),1)
            self.assertEqual(json.loads(journals[0].read_bytes())['installed_tools'],['b02-backup-root.py'])

    def test_held_locks_closed_set_is_required_and_foreign_descriptors_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'TOOL_LOCKS_REQUIRED'):
            with r.controller_update_locks({}):pass
        with tempfile.TemporaryDirectory() as temp:
            streams={}
            with contextlib.ExitStack() as stack:
                for name in r.LOCK_NAMES:
                    streams[name]=stack.enter_context(open(Path(temp)/name,'w+'))
                    # Explicitly invalid custody also when Linux CI runs as Root
                    # and an earlier controller test has changed the umask.
                    os.fchmod(streams[name].fileno(),0o644)
                with mock.patch.object(r,'PRIVATE',Path(temp)),self.assertRaisesRegex(RuntimeError,'LOCK_CUSTODY'):
                    with r.controller_update_locks(streams):pass

if __name__=='__main__':unittest.main()
