"""Native-shaped evidence validation; synthetic originals confer no cloud authority."""
import base64
from copy import deepcopy
from datetime import timedelta
import hashlib
from pathlib import Path
import sys
import unittest
from urllib.parse import quote
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_source_recovery as r
import cloudbuild_runtime_meter as meter
from cloudbuild_gcs_store import encode
from test_cloudbuild_runtime import SourcePipelineTests, descriptor
from test_cloudbuild_admission import NOW, ATTEMPT

REQUEST = '99999999-9999-4999-8999-999999999999'
SERVICE = '88888888-8888-4888-8888-888888888888'


def fixture():
    f = SourcePipelineTests('test_source_acquisition_result_persists_before_upload');f.setUp();f.source_fixture()
    task = deepcopy(f.task); ledger = deepcopy(f.fixture.store.document)
    # This incident predates the prospective 420-minute ceiling. Its original
    # 480-minute document is read as history, never as new admission authority.
    ledger['monthly_limit_seconds'] = 480 * 60
    task['plan']['identity']['repository_id'] = r.REPOSITORY_ID
    task['event']['repository_id'] = r.REPOSITORY_ID
    task['payload']['source_approval'].update(repository=r.REPOSITORY, repository_id=r.REPOSITORY_ID)
    task['approval']['plan_sha256'] = r.ledger.canonical_hash(task['plan'])
    task['admission']['approval_sha256'] = r.ledger.canonical_hash(task['approval'])
    ledger['events'] = {r.ledger.event_key(task['plan']['identity']):ATTEMPT}
    for key in ('plan','approval','admission'):ledger['attempts'][ATTEMPT][key] = deepcopy(task[key])
    current = NOW + timedelta(minutes=10); observed = current - timedelta(seconds=5)
    payload = {'project':r.PROJECT,'project_number':'1065291779811','regions':['global','us-east1'],'builds':[]}
    inventory = {**payload,'complete':True,'inventory_sha256':r.ledger.canonical_hash(payload),
        'started_at':r.ledger.stamp(observed+timedelta(seconds=1)), 'observed_at':r.ledger.stamp(observed+timedelta(seconds=2))}
    task['admission']['inventory_sha256'] = inventory['inventory_sha256']
    ledger['attempts'][ATTEMPT]['admission'] = deepcopy(task['admission'])
    old_meter = meter.initial_document()
    for i,seconds in enumerate((450,15,5),1):
        old_meter['requests'][f'{i:08d}-1111-4111-8111-111111111111'] = {'started_at':r.ledger.stamp(NOW-timedelta(minutes=20-i)),
            'ceiling_ms':seconds*1000,'months':['2026-10'],'state':'COMPLETED','result_sha256':'1'*64}
    current_meter = deepcopy(old_meter);current_meter['active_request'] = REQUEST
    current_meter['requests'][REQUEST] = {'started_at':r.ledger.stamp(NOW),'ceiling_ms':450000,
        'months':['2026-10'],'state':'RESERVED','result_sha256':None}
    service_name='commerce-v7-controller-core'
    service={'name':'projects/'+r.PROJECT+'/locations/us-east1/services/'+service_name,'uid':SERVICE,
        'uri':'https://controller.example.run.app','latestReadyRevision':service_name+'-00001-abc',
        'template':{'serviceAccount':'commerce-v7-controller-core@'+r.PROJECT+'.iam.gserviceaccount.com','containers':[{'image':'us-east1-docker.pkg.dev/'+r.PROJECT+'/commerce-ci-public/controller@sha256:'+'5'*64}]}}
    taskraw=encode(task);control={'schema_version':1,'mode':'active','expires_at':task['expires_at'],
        'task':{**descriptor(task),'sha256':r.sha(taskraw),'size':len(taskraw)}}
    paused={**control,'mode':'paused','task':None};work={'operation':'SOURCE','phase':'ACQUIRE','attempt_id':ATTEMPT,'ceiling_seconds':450,'wire_timeout_seconds':480}
    def refraw(key,raw):return {'path':'/private/evidence/'+key+'.json','bytes':len(raw),'sha256':r.sha(raw)}
    stores={k:{'bucket':'private-custody','object':'runtime/'+k+'.json','generation':'10',
        'bytes':len(encode(v)),'sha256':r.sha(encode(v))}for k,v in [('ledger',ledger),('meter',old_meter),('control',control)]}
    before={'task':task,'documents':{'ledger':ledger,'meter':old_meter,'control':control},'stores':stores,
        'service':service,'work':work,'observed_at':r.ledger.stamp(NOW-timedelta(seconds=10))}
    intent={'at':r.ledger.stamp(NOW-timedelta(seconds=2)),'before_ref':refraw('before',encode(before)),
        'response_path':'/private/evidence/http_result.json','work':work,'no_retry':True,'control_generation':'10','service_uid':SERVICE}
    journal={'schema_version':1,'revision':1,'binding':{'attempt_id':ATTEMPT,'plan_sha256':r.ledger.canonical_hash(task['plan']),
        'source_sha':task['event']['source_sha']},'actions':{'source-acquire:'+ATTEMPT:{'intent_sha256':r.ledger.canonical_hash(task['payload']['source_approval']),
        'created_at':r.ledger.stamp(NOW+timedelta(seconds=2)),'result':None,'history':[]}}}
    values={'before':before,'invocation_intent':intent,'task_media':task,
        'http_result':{'error_type':None,'http_status':200,'request_outcome':'HTTP_CONFIRMED','response':{
            'automatic_retry':False,'build_success_claimed':False,'code':'CONTROLLER_REQUEST_FAILED','reservation_may_exist':True,'status':'STOP_PRESERVE'}},
        'service_iam_before':{'bindings':[{'role':'roles/run.invoker','members':['user:owner@example.invalid']}]},
        'service_iam_current':{'bindings':[{'role':'roles/run.invoker','members':['user:owner@example.invalid']}]},
        'request_logs':{'entries':[{'resource':{'type':'cloud_run_revision','labels':{'project_id':r.PROJECT,'location':'us-east1',
            'service_name':service_name,'revision_name':service['latestReadyRevision']}},
            'httpRequest':{'requestMethod':'POST','requestUrl':service['uri']+'/tick','status':200,'latency':'22s'},
            'timestamp':r.ledger.stamp(NOW-timedelta(seconds=1)),'receiveTimestamp':r.ledger.stamp(NOW+timedelta(seconds=22)),
            'trace':'projects/'+r.PROJECT+'/traces/'+'a'*32}]},'service_current':service,
        'source_request':{'method':'GET','at':r.ledger.stamp(observed+timedelta(seconds=1)),'url':'https://storage.googleapis.com/storage/v1/b/'+r.SOURCE_BUCKET+'/o/'+quote('full/'+ATTEMPT+'.tgz',safe='')},
        'source_result':{'http_status':404,'request_outcome':'HTTP_CONFIRMED'},'source_response':{'error':{'code':404,'status':'NOT_FOUND'}},'inventory':inventory}
    for key,doc,gen,obj in [('control',paused,'20','runtime/control.json'),('ledger',ledger,'10','runtime/ledger.json'),
                          ('meter',current_meter,'30','runtime/meter.json'),('journal',journal,'40',task['payload']['journal']['object'])]:
        raw=encode(doc);meta={'bucket':'private-custody','name':obj,'generation':gen,'size':str(len(raw)),
            'md5Hash':base64.b64encode(hashlib.md5(raw).digest()).decode()}
        values[key+'_media']=doc;values[key+'_metadata']=deepcopy(meta);values[key+'_current']=deepcopy(meta)
    raws={k:encode(v)for k,v in values.items()}
    bundle={'schema_version':1,'kind':r.KIND,'observed_at':r.ledger.stamp(observed),
        'valid_until':r.ledger.stamp(current+timedelta(seconds=60)),
        'originals':{k:refraw(k,v)for k,v in raws.items()}}
    def read(ref):return raws[Path(ref['path']).stem]
    return bundle,raws,read,current


class SourceRecoveryTests(unittest.TestCase):
    def setUp(self):self.bundle,self.raws,self.read,self.now=fixture()
    def valid(self):return r.validate_evidence(self.bundle,self.read,now=self.now)
    def change(self,key,callback):
        value=r.decode(self.raws[key]);callback(value);raw=encode(value);self.raws[key]=raw
        self.bundle['originals'][key].update(bytes=len(raw),sha256=r.sha(raw))
    def test_complete_proof_preserves_full_charge_and_identifies_exact_request(self):
        receipt=self.valid();self.assertEqual(receipt['request_id'],REQUEST);self.assertEqual(receipt['meter_ceiling_ms'],450000)
        self.assertEqual(meter.usage(r.decode(self.raws['meter_media']))['2026-10']['cpu_ms'],920000)
    def test_changed_original_bytes_reject_even_same_json(self):
        self.raws['source_response']+=b' '
        with self.assertRaisesRegex(RuntimeError,'ORIGINAL_CHANGED'):self.valid()
    def test_upload_intent_or_acquisition_result_forbids_recovery(self):
        for variant in ('intent','result'):
            self.setUp()
            def mutate(d):
                if variant=='intent':d['actions']['source-upload:'+ATTEMPT]=deepcopy(next(iter(d['actions'].values())))
                else:next(iter(d['actions'].values()))['result']={'status':'UNKNOWN','intent_sha256':next(iter(d['actions'].values()))['intent_sha256']}
            self.change('journal_media',mutate)
            self.rehash_gcs('journal')
            with self.assertRaises(RuntimeError):self.valid()
    def rehash_gcs(self,key):
        raw=self.raws[key+'_media']
        for suffix in ('metadata','current'):
            self.change(key+'_'+suffix,lambda d:d.update(size=str(len(raw)),md5Hash=base64.b64encode(hashlib.md5(raw).digest()).decode()))
    def test_absence_must_be404_for_exact_source_object(self):
        for key,mutate in [('source_result',lambda d:d.update(http_status=403)),('source_request',lambda d:d.update(url=d['url']+'?x=1')),
                           ('source_response',lambda d:d['error'].update(code=403))]:
            self.setUp();self.change(key,mutate)
            with self.assertRaisesRegex(RuntimeError,'NATIVE_ABSENCE_REQUIRED'):self.valid()
    def test_current_invoker_must_preserve_protected_root_only_policy(self):
        self.change('service_iam_current',lambda d:d['bindings'][0]['members'].append('allUsers'))
        with self.assertRaisesRegex(RuntimeError,'INVOKER_CHANGED'):self.valid()
    def test_stale404_is_not_current_absence_proof(self):
        self.change('source_request',lambda d:d.update(at=r.ledger.stamp(NOW)))
        with self.assertRaisesRegex(RuntimeError,'NATIVE_ABSENCE_REQUIRED'):self.valid()
    def test_inventory_change_is_not_no_build_proof(self):
        self.change('inventory',lambda d:d.update(inventory_sha256='0'*64))
        with self.assertRaisesRegex(RuntimeError,'NATIVE_INVENTORY_CHANGED'):self.valid()
    def test_active_control_cannot_release(self):
        self.change('control_media',lambda d:d.update(mode='active'));self.rehash_gcs('control')
        with self.assertRaisesRegex(RuntimeError,'CONTROL_NOT_PAUSED'):self.valid()
    def test_duplicate_log_or_different_revision_cannot_bind_terminal(self):
        for mutate in (lambda d:d['entries'].append(deepcopy(d['entries'][0])),
                       lambda d:d['entries'][0]['resource']['labels'].update(revision_name='other')):
            self.setUp();self.change('request_logs',mutate)
            with self.assertRaises(RuntimeError):self.valid()
    def test_generation_drift_closes_proof(self):
        self.change('meter_current',lambda d:d.update(generation='31'))
        with self.assertRaisesRegex(RuntimeError,'GCS_IDENTITY_CHANGED'):self.valid()
    def test_private_service_is_outside_public_incident_scope(self):
        self.change('service_current',lambda d:d.update(name=d['name'].replace('controller-core','controller')))
        with self.assertRaisesRegex(RuntimeError,'SERVICE_CHANGED'):self.valid()
    def test_future_log_receive_time_cannot_claim_terminal(self):
        self.change('request_logs',lambda d:d['entries'][0].update(receiveTimestamp=r.ledger.stamp(self.now+timedelta(seconds=1))))
        with self.assertRaisesRegex(RuntimeError,'INVOCATION_NOT_TERMINAL'):self.valid()
    def test_receipt_existing_generations_never_allow_zero(self):
        receipt=self.valid();receipt['meter_generation']='0'
        with self.assertRaises(RuntimeError):r.validate_receipt(receipt,now=self.now)
    def test_window_never_expires_into_permission(self):
        with self.assertRaisesRegex(RuntimeError,'EVIDENCE_EXPIRED'):
            r.validate_evidence(self.bundle,self.read,now=self.now+timedelta(seconds=61))
    def test_historical_meter_row_cannot_change(self):
        self.change('meter_media',lambda d:next(v for k,v in d['requests'].items()if k!=REQUEST).update(ceiling_ms=5000));self.rehash_gcs('meter')
        with self.assertRaisesRegex(RuntimeError,'METER_HISTORY_CHANGED'):self.valid()
    def test_meter_header_and_embedded_quota_changes_are_rejected(self):
        for change in ({'schema_version':True},{'schema_version':2},{'limit_cpu_ms':999999999},
                       {'limit_memory_mib_ms':999999999},{'revision':2}):
            self.setUp();self.change('meter_media',lambda d:d.update(change));self.rehash_gcs('meter')
            with self.assertRaises(RuntimeError):self.valid()


def load_tests(loader,tests,pattern):return loader.loadTestsFromTestCase(SourceRecoveryTests)
if __name__=='__main__':unittest.main()
