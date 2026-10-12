import base64
from copy import deepcopy
from datetime import timedelta
import hashlib
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import cloudbuild_source_continuation as c
import cloudbuild_source_resume as source
import cloudbuild_runtime as runtime
import cloudbuild_github_reader as github_reader
from cloudbuild_gcs_store import encode, decode
from test_cloudbuild_source_resume import fixture
from test_cloudbuild_admission import MemoryStore
from test_cloudbuild_runtime import config, descriptor


def native_descriptor(value, *, object='runtime/meter.json', generation='50'):
    raw=encode(value)
    return {'bucket':'private-custody','object':object,'generation':generation,'size':len(raw),
        'sha256':hashlib.sha256(raw).hexdigest(),'md5':base64.b64encode(hashlib.md5(raw).digest()).decode()}


def continuation_fixture():
    bundle,raws,read,now=fixture(); proof=source.validate_evidence(bundle,read,now=now)
    proposed=c.propose_recovery(raws['meter_media'],meter_generation=proof['meter_generation'],
        ledger_raw=raws['ledger_media'],ledger_generation=proof['ledger_generation'],proof=proof,now=now)
    auth=c.produce(proof,raws['meter_media'],raws['ledger_media'],native_descriptor(proposed['document']),
        recovered_at=c.ledger.stamp(now),expires_at=c.ledger.stamp(now+timedelta(hours=2)))
    meter=deepcopy(proposed['document']);active='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    meter['active_request']=active;meter['requests'][active]={'started_at':c.ledger.stamp(now),'ceiling_ms':450000,
        'months':['2026-10'],'state':'RESERVED','result_sha256':None}
    task=decode(raws['task_media'])
    args={'ledger_generation':proof['ledger_generation'],'ledger_document':decode(raws['ledger_media']),
        'journal_generation':proof['source_journal_generation'],'journal_document':decode(raws['journal_media']),
        'meter_generation':'51','meter_document':meter,'source_approval':task['payload']['source_approval'],'now':now}
    return auth,args,task


class ContinuationTests(unittest.TestCase):
    def setUp(self): self.auth,self.args,self.task=continuation_fixture()
    def valid(self): return c.validate_current(self.auth,**self.args)
    def test_protected_derivation_and_history_allow_only_fixed_incident(self):
        before=deepcopy((self.auth,self.args));result=self.valid()
        self.assertEqual(result['attempt_id'],source.ATTEMPT);self.assertEqual(result['source_sha'],source.SOURCE_SHA)
        self.assertEqual((self.auth,self.args),before)
        self.assertFalse(self.auth['meter_receipt']['reservation_refunded'])
    def test_changed_receipt_original_and_descriptor_reject(self):
        for mutate in (lambda a:a['meter_receipt'].update(source_retry_authorized=True),
                       lambda a:a.update(ledger_raw=base64.b64encode(b'{}').decode()),
                       lambda a:a['meter_after'].update(sha256='0'*64)):
            self.setUp();mutate(self.auth)
            with self.assertRaises(RuntimeError):self.valid()
    def test_expired_or_future_recovery_cannot_start_new_execution(self):
        for now in (self.args['now']-timedelta(seconds=1),self.args['now']+timedelta(hours=3)):
            self.args['now']=now
            with self.assertRaises(RuntimeError):self.valid()
    def test_ledger_mutation_or_generation_change_is_rejected(self):
        for key in ('ledger_generation','ledger_document'):
            self.setUp()
            if key.endswith('generation'):self.args[key]='11'
            else:self.args[key]['revision']+=1
            with self.assertRaises(RuntimeError):self.valid()
    def test_journal_second_action_or_new_generation_is_not_replay_permission(self):
        for variant in ('generation','action','approval'):
            self.setUp()
            if variant=='generation':self.args['journal_generation']='41'
            elif variant=='action':self.args['journal_document']['actions']['source-resume:'+source.ATTEMPT]={}
            else:self.args['source_approval']['review_sha256']='f'*64
            with self.assertRaises(RuntimeError):self.valid()
    def test_old_meter_row_changes_or_no_new450_reservation_reject(self):
        for variant in ('oldrow','newrow','active','generation'):
            self.setUp();doc=self.args['meter_document']
            if variant=='oldrow':doc['requests'][self.auth['proof']['request_id']]['result_sha256']='f'*64
            elif variant=='newrow':doc['requests'][doc['active_request']]['ceiling_ms']=120000
            elif variant=='active':doc['active_request']=None
            else:self.args['meter_generation']='49'
            with self.assertRaises(RuntimeError):self.valid()


class FactoryContinuationTests(unittest.TestCase):
    def setUp(self):
        self.auth,self.args,self.task=continuation_fixture();self.moment=self.args['now']
        # These two constants are the installed public transformation, without
        # changing any admission, control, journal or continuation implementation.
        for key,value in [('REPOSITORY_ID',source.REPOSITORY_ID),('REPOSITORY',source.REPOSITORY)]:
            p=patch.object(runtime,key,value);p.start();self.addCleanup(p.stop)
        p=patch.object(github_reader,'REPOSITORY_ID',source.REPOSITORY_ID);p.start();self.addCleanup(p.stop)
        self.factory=runtime.RuntimeFactory(config(),clock=lambda:self.moment)
        self.ledger=MemoryStore(self.args['ledger_document']);self.ledger.generation=self.args['ledger_generation']
        self.journal=MemoryStore(self.args['journal_document']);self.journal.generation=self.args['journal_generation']
        self.meter=MemoryStore(self.args['meter_document']);self.meter.generation=self.args['meter_generation']
        self.task['phase']='RESUME'
        recovery=native_descriptor(self.auth,object='runtime/tasks/'+source.ATTEMPT+'/source-resume-recovery.json')
        self.task['payload']['recovery']=recovery
        self.control={'schema_version':1,'mode':'active','expires_at':self.task['expires_at'],'task':descriptor(self.task)}
        f=self.factory;f.control_store=Mock();f.control_store.load.side_effect=lambda:('60',deepcopy(self.control))
        f.custody=Mock();f.custody.read_json.side_effect=lambda ref:deepcopy(self.auth if ref==recovery else self.task)
        f.ledger_store=self.ledger;f.meter_store=self.meter;f._store=Mock(return_value=self.journal)
        f.source_reader=Mock();f.github=Mock();f.github.current_event.return_value={'event_sha256':'7'*64}
        f.inventory_snapshot=Mock(return_value={'complete':True,'inventory_sha256':self.task['admission']['inventory_sha256']})
        f.sources=Mock(bucket=source.SOURCE_BUCKET,prefix='full/')
        f.sources.upload_source_once.return_value={'state':'SOURCE_UPLOADED_AND_VERIFIED'}
        self.data=b'fixture authentic hash'
    def archive(self,directory,approval,reader):
        p=directory/'source.tgz';p.write_bytes(self.data)
        return {'archive_path':str(p),'archive_bytes':len(self.data),'archive_sha256':hashlib.sha256(self.data).hexdigest()}
    def test_producer_preserves_original_admission_and_requires_protected_path(self):
        original=deepcopy(self.task);original['phase']='ACQUIRE';original['payload'].pop('recovery')
        reference=self.task['payload']['recovery']
        result=c.resume_task(original,reference,custody=self.factory.config['custody'],now=self.moment)
        self.assertEqual(result,self.task)
        wrong=deepcopy(reference);wrong['object']='runtime/elsewhere.json'
        with self.assertRaisesRegex(RuntimeError,'TASK_CUSTODY'):
            c.resume_task(original,wrong,custody=self.factory.config['custody'],now=self.moment)

    def test_object_present_after_intent_closes_acquisition_without_replay(self):
        self.factory.sources.require_source_absent.side_effect=RuntimeError('SOURCE_CONTINUATION_OBJECT_EXISTS')
        with patch.object(runtime,'prepare_archive') as acquire:
            with self.assertRaisesRegex(RuntimeError,'OBJECT_EXISTS'):self.factory.execute(self.factory.inspect_work())
            acquire.assert_not_called()
        self.assertIn('source-resume:'+source.ATTEMPT,self.journal.document['actions'])
        self.factory.sources.upload_source_once.assert_not_called()

    def test_real_factory_ledger_journal_same_attempt_acquires_once_and_preserves_old_intent(self):
        before_ledger=self.ledger.load();before_meter=self.meter.load();old=deepcopy(self.journal.document['actions'])
        work=self.factory.inspect_work()
        with patch.object(runtime,'prepare_archive',side_effect=self.archive) as acquire:
            result=self.factory.execute(work);self.assertEqual(result['request_outcome'],'CONFIRMED')
            with self.assertRaises(RuntimeError):self.factory.execute(work)
            self.assertEqual(acquire.call_count,1)
        actions=self.journal.document['actions'];self.assertEqual(len(actions),2)
        original='source-acquire:'+source.ATTEMPT;continued='source-resume:'+source.ATTEMPT
        self.assertEqual(actions[original]['intent_sha256'],old[original]['intent_sha256'])
        self.assertEqual(actions[original]['created_at'],old[original]['created_at'])
        self.assertEqual(actions[original]['result']['status'],'RECONCILED')
        self.assertEqual(actions[continued]['result']['status'],'RECONCILED')
        self.assertEqual(self.ledger.load(),before_ledger);self.assertEqual(self.meter.load(),before_meter)
        self.factory.sources.upload_source_once.assert_called_once()
    def test_pause_during_resume_cas_consumes_new_intent_without_acquisition(self):
        original=self.journal.compare_and_swap
        def paused(generation,value):
            result=original(generation,value);self.control['mode']='paused';return result
        self.journal.compare_and_swap=paused
        with patch.object(runtime,'prepare_archive') as acquire:
            with self.assertRaisesRegex(RuntimeError,'CONTROL_CHANGED'):self.factory.execute(self.factory.inspect_work())
            acquire.assert_not_called()
        self.assertIn('source-resume:'+source.ATTEMPT,self.journal.document['actions'])
        self.factory.sources.upload_source_once.assert_not_called()
    def test_acquisition_failure_is_consumed_without_second_resume(self):
        with patch.object(runtime,'prepare_archive',side_effect=OSError('fixture failure')) as acquire:
            work=self.factory.inspect_work()
            with self.assertRaises(OSError):self.factory.execute(work)
            with self.assertRaises(RuntimeError):self.factory.execute(work)
            self.assertEqual(acquire.call_count,1)
        self.assertIsNone(self.journal.document['actions']['source-acquire:'+source.ATTEMPT]['result'])
    def test_last_control_read_cannot_outlive_resume_authorization(self):
        self.auth['expires_at']=c.ledger.stamp(self.moment+timedelta(seconds=3))
        original=self.factory.control_store.load.side_effect
        def delayed():
            value=original()
            if self.factory.sources.require_source_absent.called:self.moment+=timedelta(seconds=4)
            return value
        self.factory.control_store.load.side_effect=delayed
        with patch.object(runtime,'prepare_archive') as acquire:
            with self.assertRaisesRegex(RuntimeError,'RESUME_EXPIRED'):self.factory.execute(self.factory.inspect_work())
            acquire.assert_not_called()
        self.assertIn('source-resume:'+source.ATTEMPT,self.journal.document['actions'])

    def test_expiry_during_final_inventory_stops_after_intent(self):
        self.auth['expires_at']=c.ledger.stamp(self.moment+timedelta(seconds=3))
        calls=0
        def snapshot():
            nonlocal calls
            calls+=1
            if calls==2:self.moment+=timedelta(seconds=4)
            return {'complete':True,'inventory_sha256':self.task['admission']['inventory_sha256']}
        self.factory.inventory_snapshot.side_effect=snapshot
        with patch.object(runtime,'prepare_archive') as acquire:
            with self.assertRaisesRegex(RuntimeError,'RESUME_EXPIRED'):self.factory.execute(self.factory.inspect_work())
            acquire.assert_not_called()
        self.assertIn('source-resume:'+source.ATTEMPT,self.journal.document['actions'])


if __name__=='__main__':unittest.main()
