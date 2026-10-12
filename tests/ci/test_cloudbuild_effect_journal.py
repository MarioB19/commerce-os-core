from copy import deepcopy
from datetime import timedelta
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import cloudbuild_effect_journal as m
import test_cloudbuild_admission as fixture


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.parent=fixture.MemoryStore(fixture.reserved());self.store=fixture.MemoryStore()
        prepared=m.initialize_journal(self.store,self.parent,fixture.ATTEMPT,now=fixture.NOW)
        self.journal=m.DurableEffectJournal(self.store,self.parent,prepared['binding'],clock=lambda:fixture.NOW)
        self.action='deployment:cb-'+fixture.BUILD+'-1';self.payload={'method':'POST','path':'/deployments','body':{'ref':'a'*40}}
    def commit(self):return self.journal.commit_intent(self.action,self.payload)
    def result(self,**extra):
        return {'status':'RESPONSE_RECEIVED','intent_sha256':m.ledger.canonical_hash(self.payload),'native_id':42,'response_sha256':'a'*64,**extra}

    def test_confirmed_cas_authorizes_once_and_replay_never_does(self):
        first=self.commit();self.assertEqual(first['effect'],'CREATE_ONCE')
        self.assertEqual(first['attempt_id'],fixture.ATTEMPT)
        self.assertIsNone(self.commit()['effect'])
        self.assertEqual(len(self.store.document['actions']),1)
    def test_lost_cas_response_then_replay_stays_consumed(self):
        self.store.lose_response=True
        with self.assertRaisesRegex(RuntimeError,'WRITE_RESPONSE_LOST'):self.commit()
        self.store.lose_response=False;self.assertIsNone(self.commit()['effect'])
    def test_missing_journal_never_initializes_implicitly(self):
        self.store.document=None;self.store.generation='0'
        with self.assertRaisesRegex(RuntimeError,'EFFECT_JOURNAL_MISSING_NO_RESET'):self.commit()
        self.assertEqual(self.store.generation,'0')
    def test_changed_payload_or_binding_cannot_reuse_an_intent(self):
        self.commit();self.payload['body']['ref']='b'*40
        with self.assertRaisesRegex(RuntimeError,'EFFECT_REPLAY_PAYLOAD_CHANGED'):self.commit()
    def test_parent_changes_during_cas_consume_intent_without_dispatch(self):
        original=self.store.compare_and_swap
        def racing(expected,document):
            committed=original(expected,document);self.parent.generation=str(int(self.parent.generation)+1)
            return committed
        self.store.compare_and_swap=racing
        with self.assertRaisesRegex(RuntimeError,'EFFECT_PARENT_ADVANCED_NO_DISPATCH'):self.commit()
        self.assertIsNone(self.commit()['effect'])
    def test_unknown_result_is_preserved_when_native_result_is_reconciled(self):
        self.commit();unknown={'status':'UNKNOWN','intent_sha256':m.ledger.canonical_hash(self.payload)}
        self.journal.record_result(self.action,unknown);self.journal.record_result(self.action,self.result())
        action=self.store.document['actions'][self.action]
        self.assertEqual(action['history'],[unknown]);self.assertEqual(action['result']['native_id'],42)
        self.assertIsNone(self.commit()['effect'])
    def test_uncertain_fallback_cannot_erase_committed_native_response(self):
        self.commit();self.journal.record_result(self.action,self.result())
        self.journal.record_result(self.action,{'status':'UNKNOWN','intent_sha256':m.ledger.canonical_hash(self.payload)})
        self.assertEqual(self.store.document['actions'][self.action]['result']['native_id'],42)
    def test_different_native_id_does_not_overwrite_reconciliation(self):
        self.commit();self.journal.record_result(self.action,self.result())
        with self.assertRaisesRegex(RuntimeError,'EFFECT_NATIVE_ID_CHANGED'):
            self.journal.record_result(self.action,self.result(status='RECONCILED',native_id=43))
    def test_credentials_in_results_are_rejected(self):
        self.commit()
        with self.assertRaisesRegex(RuntimeError,'EFFECT_RESULT_CREDENTIAL_FIELD_FORBIDDEN'):
            self.journal.record_result(self.action,self.result(nested={'authorization':'synthetic'}))
    def test_expired_economics_block_new_effects(self):
        self.journal.clock=lambda:fixture.NOW+timedelta(days=1)
        with self.assertRaisesRegex(RuntimeError,'SOURCE_APPROVAL_EXPIRED'):self.commit()


if __name__=='__main__':unittest.main()
