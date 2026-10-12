from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
import pathlib
import sys
import threading
import unittest
import uuid
from unittest.mock import Mock

P = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('gcp_mail_dispatch', P/'scripts/gcp_mail_dispatch.py')
m = importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
NOW = datetime(2026, 10, 11, 20, tzinfo=timezone.utc)
ATTEMPT = '11111111-1111-4111-8111-111111111111'
KEY = bytes(range(32))


def config():
    return {'schema_version':1,'project':'synthetic-project','sender':'invitations@synthetic-project.appspotmail.com',
        'origin':'https://commerce.example','audience':'https://mail.example',
        'dispatcher_email':'mail-dispatch@synthetic-project.iam.gserviceaccount.com','dispatcher_subject':'123456789012345678901'}


def payload(at=NOW, attempt=ATTEMPT):
    return {'schema_version':1,'event_id':'22222222-2222-4222-8222-222222222222',
        'workspace_id':'33333333-3333-4333-8333-333333333333','entity_id':'44444444-4444-4444-8444-444444444444',
        'entity_version':1,'template':m.TEMPLATE,'recipient':'fixture@example.invalid','recipient_hmac':'a'*64,
        'link_token':'cos_inv_'+m.b64(bytes(range(32))), 'dispatched_at':at.isoformat(),
        'authorized_until':(at+timedelta(seconds=120)).isoformat(),
        'link_expires_at':(at+timedelta(hours=24)).isoformat(),'budget_reservation_id':attempt}


class Store:
    def __init__(self):
        self.document=m.initial_journal();self.generation='1';self.calls=0;self.lose_at=None
        self.lock=threading.Lock();self.on_cas=None
    def load(self):return self.generation,deepcopy(self.document)
    def compare_and_swap(self,expected,document):
        with self.lock:
            self.calls+=1
            if expected!=self.generation:raise RuntimeError('SYNTHETIC_CONFLICT')
            self.document=deepcopy(document);self.generation=str(int(self.generation)+1)
            if self.on_cas:self.on_cas(self.calls)
            if self.lose_at==self.calls:raise TimeoutError('SYNTHETIC_LOST_ACK')
            return self.generation


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.now=NOW;self.store=Store();self.cfg=config();self.provider=Mock();self.fence=Mock()
        self.claims={'iss':'https://accounts.google.com','aud':self.cfg['audience'],
            'email':self.cfg['dispatcher_email'],'sub':self.cfg['dispatcher_subject'],
            'email_verified':True,'iat':int(NOW.timestamp()),'exp':int(NOW.timestamp())+3600}
        self.auth=Mock(return_value=self.claims);self.key=Mock(return_value=KEY)
        self.service=m.DispatchService(self.cfg,store=self.store,authenticate=self.auth,key_provider=self.key,
            fence=self.fence,provider=self.provider,clock=lambda:self.now)
    def raw(self,value=None,attempt=ATTEMPT):return m.seal(value or payload(),attempt,KEY,bytes(range(12)))
    def send(self,raw=None):return self.service.dispatch(raw or self.raw(),'SYNTHETIC_ID_TOKEN')
    def test_real_gcm_roundtrip_and_aad_reject_attempt_substitution(self):
        self.assertEqual(m.open_envelope(self.raw(),KEY),(ATTEMPT,payload()))
        changed=m.decode(self.raw());changed['attempt_id']=str(uuid.uuid4())
        with self.assertRaisesRegex(m.MailError,'AUTHENTICATION_FAILED'):self.send(m.encode(changed))
        self.provider.assert_not_called();self.assertEqual(self.store.calls,0)
    def test_wrong_key_never_creates_intent(self):
        self.key.return_value=b'z'*32
        with self.assertRaisesRegex(m.MailError,'AUTHENTICATION_FAILED'):self.send()
        self.assertEqual(self.store.calls,0);self.provider.assert_not_called()
    def test_google_signature_verifier_failure_precedes_secret_or_journal(self):
        self.auth.side_effect=ValueError('SYNTHETIC_INVALID_SIGNATURE')
        with self.assertRaises(ValueError):self.send()
        self.key.assert_not_called();self.assertEqual(self.store.calls,0);self.provider.assert_not_called()
    def test_identity_exact_audience_subject_verified_email_and_expiry(self):
        for field,value in [('aud','https://other.example'),('sub','987654321012345678901'),
                            ('email','foreign@example.invalid'),('email_verified',False),('exp',int(NOW.timestamp()))]:
            self.setUp();self.claims[field]=value
            with self.subTest(field=field),self.assertRaises(m.MailError):self.send()
            self.assertEqual(self.store.calls,0);self.provider.assert_not_called()
    def test_envelope_and_payload_are_closed_no_sender_html_or_link_origin(self):
        for field,value in [('sender','foreign@example.invalid'),('html','<b>x</b>'),('url','https://foreign.example'),
                            ('recipient','first@example.invalid,second@example.invalid'),('entity_version',True),
                            ('link_expires_at',(NOW+timedelta(days=2)).isoformat()),('budget_reservation_id',str(uuid.uuid4()))]:
            body=payload();body[field]=value
            with self.subTest(field=field),self.assertRaises(m.MailError):self.send(self.raw(body))
            self.assertEqual(self.store.calls,0);self.provider.assert_not_called()
    def test_fixed_template_fragment_and_confirmed_intent_precede_single_provider_call(self):
        def provider(**kwargs):
            row=self.store.document['attempts'][ATTEMPT]
            self.assertEqual(row['state'],'INTENT');self.assertEqual(self.store.calls,1)
            self.assertEqual(kwargs['sender'],self.cfg['sender']);self.assertEqual(kwargs['recipient'],payload()['recipient'])
            self.assertIn('/accept-invitation#cos_inv_',kwargs['body'])
            self.assertNotIn('?',kwargs['body'])
        self.provider.side_effect=provider
        result=self.send()
        self.assertEqual(result,{'attempt_id':ATTEMPT,'state':'ACCEPTED','delivery_proven':False})
        self.assertEqual(self.fence.call_count,2);self.assertEqual(self.provider.call_count,1);self.assertEqual(self.store.calls,2)
        saved=m.encode(self.store.document)
        for secret in (payload()['recipient'],payload()['link_token'],'SYNTHETIC_ID_TOKEN'):
            self.assertNotIn(secret.encode(),saved)
    def test_intent_lost_ack_is_unknown_and_second_call_never_sends(self):
        self.store.lose_at=1
        self.assertEqual(self.send()['state'],'UNKNOWN')
        self.assertEqual(self.send()['state'],'UNKNOWN')
        self.assertEqual(self.store.calls,1);self.provider.assert_not_called()
    def test_provider_exception_is_unknown_not_false_rejection_and_never_retried(self):
        self.provider.side_effect=TimeoutError('SYNTHETIC_PROVIDER_SECRET')
        result=self.send();self.assertEqual(result['state'],'UNKNOWN')
        self.assertNotIn('SECRET',str(result));self.assertEqual(self.send(),result)
        self.assertEqual(self.provider.call_count,1);self.assertEqual(self.store.calls,2)
    def test_accepted_response_lost_ack_returns_unknown_then_reads_confirmed_state_without_send(self):
        self.store.lose_at=2
        self.assertEqual(self.send()['state'],'UNKNOWN')
        self.assertEqual(self.send()['state'],'ACCEPTED')
        self.assertEqual(self.provider.call_count,1);self.assertEqual(self.store.calls,2)
    def test_same_attempt_cannot_change_payload_and_new_attempt_cannot_repeat_entity_version(self):
        self.send();changed=payload();changed['recipient']='other@example.invalid'
        with self.assertRaisesRegex(m.MailError,'ATTEMPT_CHANGED'):self.send(self.raw(changed))
        other=str(uuid.uuid4());changed=payload(attempt=other);changed['event_id']=str(uuid.uuid4())
        with self.assertRaisesRegex(m.MailError,'EVENT_ALREADY_CONSUMED'):self.send(self.raw(changed,other))
        self.assertEqual(self.provider.call_count,1)
    def test_missing_journal_never_bootstraps(self):
        self.store.generation='0';self.store.document=None
        with self.assertRaisesRegex(m.MailError,'MISSING_NO_RESET'):self.send()
        self.assertEqual(self.store.calls,0);self.provider.assert_not_called()
    def test_pause_during_cas_keeps_intent_and_never_sends(self):
        self.fence.side_effect=[None,RuntimeError('SYNTHETIC_PAUSED')]
        self.assertEqual(self.send()['state'],'UNKNOWN');self.provider.assert_not_called()
        self.assertEqual(self.store.document['attempts'][ATTEMPT]['state'],'UNKNOWN')
    def test_auth_expiry_during_final_fence_blocks_provider(self):
        def advance():self.now=NOW+timedelta(seconds=120)
        self.fence.side_effect=[None,lambda _payload:advance()]
        # Mock iterable returns callable as a value, so explicitly execute it.
        self.fence.side_effect=lambda _payload: advance() if self.fence.call_count==2 else None
        self.assertEqual(self.send()['state'],'UNKNOWN');self.provider.assert_not_called()
    def test_token_expiry_during_final_fence_blocks_provider(self):
        self.claims['exp']=int(NOW.timestamp())+2
        self.fence.side_effect=lambda _payload:setattr(self,'now',NOW+timedelta(seconds=2)) if self.fence.call_count==2 else None
        self.assertEqual(self.send()['state'],'UNKNOWN');self.provider.assert_not_called()
    def history(self,count,age):
        for _ in range(count):
            attempt=str(uuid.uuid4());key=m.hashlib.sha256(attempt.encode()).hexdigest();start=self.now-timedelta(seconds=age)
            self.store.document['events'][key]=attempt
            self.store.document['attempts'][attempt]={'event_key':key,'payload_sha256':'b'*64,'event_id':str(uuid.uuid4()),
                'intent_at':start.isoformat(),'authorized_until':(start+timedelta(seconds=120)).isoformat(),
                'state':'UNKNOWN','result_at':start.isoformat()}
    def test_minute_quota_includes_uncertain_attempts_and_boundary(self):
        self.history(8,60)
        with self.assertRaisesRegex(m.MailError,'RECIPIENT_QUOTA'):self.send()
        self.provider.assert_not_called();self.assertEqual(self.store.calls,0)
    def test_native_pacific_day_quota_includes_uncertain_prior_attempts(self):
        self.history(100,3600)
        with self.assertRaisesRegex(m.MailError,'RECIPIENT_QUOTA'):self.send()
        self.provider.assert_not_called()
    def test_older_history_is_preserved_but_does_not_occupy_rolling_quota(self):
        self.history(100,24*3600+121);old=deepcopy(self.store.document)
        self.assertEqual(self.send()['state'],'ACCEPTED')
        for attempt,row in old['attempts'].items():self.assertEqual(self.store.document['attempts'][attempt],row)
    def test_delayed_previous_sends_cannot_concentrate_with_next_reservations(self):
        self.history(8,0)
        for row in self.store.document['attempts'].values():
            row.update(state='ACCEPTED',result_at=(NOW+timedelta(seconds=119)).isoformat())
        self.now=NOW+timedelta(seconds=121)
        # Old intent timestamps are outside60s, but actual sends may be two
        # seconds old. A new independent entity must not get another slot.
        with self.assertRaisesRegex(m.MailError,'RECIPIENT_QUOTA'):
            self.send(self.raw(payload(at=self.now)))
        self.provider.assert_not_called();self.assertEqual(self.store.calls,0)
    def test_minute_lease_end_boundary_includes_all_states_without_refund(self):
        self.history(8,180)
        for index,row in enumerate(self.store.document['attempts'].values()):
            row['state']=('INTENT','UNKNOWN','REJECTED','ACCEPTED')[index%4]
            if row['state']=='INTENT':row['result_at']=None
        with self.assertRaisesRegex(m.MailError,'RECIPIENT_QUOTA'):self.send()
        self.provider.assert_not_called();self.assertEqual(self.store.calls,0)
    def test_minute_slot_releases_only_after_entire_send_window_is_older(self):
        self.history(8,181);old=deepcopy(self.store.document)
        self.assertEqual(self.send()['state'],'ACCEPTED')
        for attempt,row in old['attempts'].items():self.assertEqual(self.store.document['attempts'][attempt],row)
    def test_25_hour_pacific_day_retains_early_sends_older_than_24_hours(self):
        self.now=datetime(2026,11,2,7,30,tzinfo=timezone.utc)
        self.claims.update(iat=int(self.now.timestamp()),exp=int(self.now.timestamp())+3600)
        self.history(100,24*3600+120)
        with self.assertRaisesRegex(m.MailError,'RECIPIENT_QUOTA'):self.send(self.raw(payload(at=self.now)))
        self.provider.assert_not_called();self.assertEqual(self.store.calls,0)
    def test_native_day_change_allows_capacity_without_deleting_old_history(self):
        self.now=datetime(2026,11,2,8,1,tzinfo=timezone.utc)
        self.claims.update(iat=int(self.now.timestamp()),exp=int(self.now.timestamp())+3600)
        self.history(100,3600);old=deepcopy(self.store.document)
        self.assertEqual(self.send(self.raw(payload(at=self.now)))['state'],'ACCEPTED')
        for attempt,row in old['attempts'].items():self.assertEqual(self.store.document['attempts'][attempt],row)
    def test_pacific_send_days_include_both_when_lease_crosses_midnight(self):
        for start,end,days in [
            ('2026-11-02T07:59:00Z','2026-11-02T08:01:00Z',{'2026-11-01','2026-11-02'}),
            ('2026-11-02T07:58:00Z','2026-11-02T08:00:00Z',{'2026-11-01'}),
            ('2026-03-08T07:59:00Z','2026-03-08T08:01:00Z',{'2026-03-07','2026-03-08'}),
            ('2026-03-08T09:59:00Z','2026-03-08T10:01:00Z',{'2026-03-08'}),
        ]:
            with self.subTest(start=start):
                self.assertEqual({day.isoformat() for day in m.possible_send_days(start,end)},days)
        with self.assertRaisesRegex(m.MailError,'SEND_WINDOW_INVALID'):
            m.possible_send_days(NOW,NOW+timedelta(seconds=121))
    def test_duplicate_json_nonfinite_and_oversize_fail_closed(self):
        for raw in (b'{"a":1,"a":2}',b'{"a":NaN}',b'{}'*m.MAX_BODY):
            with self.subTest(raw=raw[:16]),self.assertRaises(m.MailError):m.decode(raw)
    def test_configuration_never_allows_sender_or_redirect_origin(self):
        for field,value in [('sender','foreign@example.invalid'),('origin','https://user@commerce.example'),
                            ('origin','https://commerce.example/path'),('audience','http://mail.example')]:
            cfg=config();cfg[field]=value
            with self.subTest(field=field),self.assertRaises(m.MailError):m.validate_config(cfg)
    def test_legacy_text_workspace_is_preserved_without_uuid_rewrite(self):
        body=payload();body['workspace_id']='legacy-profile-id';body['entity_version']=9007199254740991
        self.assertEqual(self.send(self.raw(body))['state'],'ACCEPTED')
        self.assertEqual(self.fence.call_args.args[0]['workspace_id'],'legacy-profile-id')
    def test_workspace_shared_utf16_boundary_and_version_are_closed(self):
        for value in ('', '\0', 'x'*257, '\U0001f600'*129, None, 123):
            body=payload();body['workspace_id']=value
            with self.subTest(value=str(value)[:10]),self.assertRaises(m.MailError):self.send(self.raw(body))
        body=payload();body['workspace_id']='\U0001f600'*128;m.validate_payload(body,ATTEMPT,NOW)
        body['entity_version']=9007199254740992
        with self.assertRaisesRegex(m.MailError,'VERSION_INVALID'):m.validate_payload(body,ATTEMPT,NOW)
        self.provider.assert_not_called();self.assertEqual(self.store.calls,0)


if __name__=='__main__':unittest.main()
