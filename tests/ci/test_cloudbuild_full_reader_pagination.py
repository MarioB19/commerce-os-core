"""Portable proposed reader; synthetic native bytes, no network or state effects."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
import urllib.error
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'scripts'), str(ROOT/'tests/ci')]
import cloudbuild_native_reader as m
import test_cloudbuild_native_reader as previous
import test_cloudbuild_boot_admission as boot_fixture
import test_cloudbuild_attestation as gate_fixture
from test_cloudbuild_publish_status import fixture, NUMBER


class Tests(unittest.TestCase):
    def setUp(self):
        self.manifest, self.build, self.github, self.receipt, self.entries = fixture()
        self.project = {'projectId': m.PROJECT, 'projectNumber': NUMBER}
        self.token = Mock(return_value='synthetic')

    def reader(self, responses):
        self.opener = previous.Opener(responses)
        return m.GoogleFullReader(self.token, lambda *_: self.github, opener=self.opener)

    def test_empty_partial_pages_keep_exact_query_and_opaque_token(self):
        reader = self.reader([{'nextPageToken':'a+/='}, {'entries':[], 'nextPageToken':'b'}, {'entries':self.entries}])
        self.assertEqual(reader.logs(self.manifest), self.entries)
        expected = {'resourceNames':['projects/'+m.PROJECT], 'filter':m.log_filter(self.manifest), 'pageSize':100, 'orderBy':'timestamp asc'}
        requests = [r for r,_ in self.opener.calls]
        self.assertEqual([json.loads(r.data) for r in requests], [expected, {**expected,'pageToken':'a+/='}, {**expected,'pageToken':'b'}])
        self.assertEqual([r.full_url for r in requests], [m.LOG_URL]*3)
        self.assertEqual([r.method for r in requests], ['POST']*3)
        self.assertEqual(self.token.call_count,3)

    def test_eighth_final_page_is_accepted(self):
        reader=self.reader([{'nextPageToken':str(i)} for i in range(7)]+[{'entries':self.entries}])
        self.assertEqual(reader.logs(self.manifest), self.entries)
        self.assertEqual(len(self.opener.calls),8)

    def test_eighth_page_with_token_does_not_issue_ninth_request(self):
        reader=self.reader([{'nextPageToken':str(i)} for i in range(9)])
        with self.assertRaisesRegex(m.EvidenceError,'LOG_QUERY_INCOMPLETE'):reader.logs(self.manifest)
        self.assertEqual(len(self.opener.calls),8)

    def test_repeated_token_is_not_replayed(self):
        reader=self.reader([{'nextPageToken':'a'}, {'nextPageToken':'b'}, {'nextPageToken':'a'}])
        with self.assertRaisesRegex(m.EvidenceError,'TOKEN_REPEATED'):reader.logs(self.manifest)
        self.assertEqual(len(self.opener.calls),3)

    def test_token_shape_and_bound(self):
        for token in (None, 0, True, [], 'a'*4097):
            with self.subTest(token_type=type(token).__name__):
                reader=self.reader([{'nextPageToken':token}])
                with self.assertRaisesRegex(m.EvidenceError,'TOKEN_INVALID'):reader.logs(self.manifest)
                self.assertEqual(len(self.opener.calls),1)

    def test_unknown_response_fields_or_nonlist_entries_fail(self):
        for page in ({'entries':{}}, {'partial':True}, {'entries':None}):
            reader=self.reader([page])
            with self.assertRaisesRegex(m.EvidenceError,'LOG_QUERY_INCOMPLETE'):reader.logs(self.manifest)
            self.assertEqual(len(self.opener.calls),1)

    def test_aggregate_entries_keep_original_strict_less_than_100_contract(self):
        reader=self.reader([{'entries':[{}]*49,'nextPageToken':'next'}, {'entries':[{}]*51}])
        with self.assertRaisesRegex(m.EvidenceError,'LOG_QUERY_INCOMPLETE'):reader.logs(self.manifest)
        reader=self.reader([{'entries':[{}]*49,'nextPageToken':'next'}, {'entries':[{}]*50}])
        self.assertEqual(len(reader.logs(self.manifest)),99)

    def test_aggregate_raw_bytes_are_not_reset_for_next_page(self):
        first=b'{"nextPageToken":"a"}'+b' '*70
        second=b'{"entries":[]}'+b' '*35
        reader=self.reader([first,second])
        with patch.object(m,'MAX_RESPONSE',128), self.assertRaisesRegex(m.EvidenceError,'NATIVE_RESPONSE_SIZE_INVALID'):
            reader.logs(self.manifest)
        self.assertEqual(len(self.opener.calls),2)

    def test_duplicate_receipts_in_distinct_pages_are_not_deduplicated(self):
        reader=self.reader([self.project,self.build,{'entries':self.entries,'nextPageToken':'a'}, {'entries':self.entries}])
        with self.assertRaisesRegex(m.EvidenceError,'UNIQUE_NATIVE_RUNNER_RECEIPT_REQUIRED'):reader.evaluate(self.manifest)
        self.assertEqual(len(self.opener.calls),4)

    def test_unique_receipt_does_not_short_circuit_incomplete_search(self):
        reader=self.reader([self.project,self.build,{'entries':self.entries,'nextPageToken':'a'}]+[{'nextPageToken':str(i)} for i in range(7)])
        with self.assertRaisesRegex(m.EvidenceError,'LOG_QUERY_INCOMPLETE'):reader.evaluate(self.manifest)
        self.assertEqual(len(self.opener.calls),10)

    def test_success_still_requires_same_source_provenance_and_complete_stages(self):
        for mutation, expected in ((lambda b:b['sourceProvenance']['resolvedStorageSource'].update(generation='24'),'RESOLVED_SOURCE_MISMATCH'),
                                   (lambda b:b['steps'][0].update(exitCode=1),'NATIVE_STEP_NOT_SUCCESSFUL')):
            build=copy.deepcopy(self.build);mutation(build)
            reader=self.reader([self.project,build])
            with self.assertRaisesRegex(m.EvidenceError,expected):reader.evaluate(self.manifest)
            self.assertEqual(len(self.opener.calls),2)
        receipt=copy.deepcopy(self.receipt);receipt['stages'].pop()
        log=copy.deepcopy(self.entries[0]);log['textPayload']=json.dumps(receipt)
        reader=self.reader([self.project,self.build,{'nextPageToken':'a'},{'entries':[log]}])
        with self.assertRaisesRegex(m.EvidenceError,'FULL_STAGE_SET_MISMATCH'):reader.evaluate(self.manifest)

    def test_working_build_still_does_not_query_logs_or_claim_pass(self):
        build=copy.deepcopy(self.build);build['status']='WORKING'
        reader=self.reader([self.project,build])
        self.assertEqual(reader.evaluate(self.manifest)['state'],'pending')
        self.assertEqual(len(self.opener.calls),2)

    def test_http_failure_after_first_page_never_retries(self):
        error=urllib.error.HTTPError(m.LOG_URL,429,'synthetic',{},io.BytesIO(b'synthetic'))
        reader=self.reader([{'nextPageToken':'a'},error])
        with self.assertRaisesRegex(m.EvidenceError,'NATIVE_READ_HTTP_ERROR'):reader.logs(self.manifest)
        self.assertEqual(len(self.opener.calls),2)

    def test_deadline_consumed_by_token_provider_prevents_request(self):
        clock=[0]
        def token():clock[0]=91;return 'synthetic'
        reader=self.reader([{}]);reader.token_provider=token
        with patch.object(m.time,'monotonic',side_effect=lambda:clock[0]),self.assertRaisesRegex(m.EvidenceError,'LOG_QUERY_DEADLINE'):
            reader.logs(self.manifest)
        self.assertFalse(self.opener.calls)

    def test_deadline_after_page_prevents_new_token_and_request(self):
        reader=self.reader([{'nextPageToken':'a'},{}]);clock=[0]
        original=self.opener.open
        def opened(*args,**kwargs):
            response=original(*args,**kwargs);clock[0]=91;return response
        self.opener.open=opened
        with patch.object(m.time,'monotonic',side_effect=lambda:clock[0]),self.assertRaisesRegex(m.EvidenceError,'LOG_QUERY_DEADLINE'):
            reader.logs(self.manifest)
        self.assertEqual(len(self.opener.calls),1);self.assertEqual(self.token.call_count,1)

    def test_each_query_starts_without_token_and_consumed_budget(self):
        reader=self.reader([{'nextPageToken':'a'},{'entries':self.entries},{'entries':self.entries}])
        self.assertEqual(reader.logs(self.manifest),reader.logs(self.manifest))
        self.assertNotIn('pageToken',json.loads(self.opener.calls[-1][0].data))

    def test_attestor_entrypoint_uses_complete_full_query(self):
        f=gate_fixture.GateTests();f.setUp();f.approve()
        reader=self.reader([self.project,self.project,f.full.build,{'nextPageToken':'a'}, {'entries':f.full.logs}])
        reader.commit_reader=lambda *_:f.full.github
        result=gate_fixture.m.attest(f.bundle,f.store,f.api,reader,Mock())
        self.assertEqual(result['status'],'PASSED')
        self.assertEqual(len(self.opener.calls),5)
        f.api.create_once.assert_not_called()

    def test_publisher_package_and_root_boot_capture_preserve_all_raw_full_pages(self):
        f=boot_fixture.Tests();f.setUp()
        page1=b'{"nextPageToken":"native-next"}  \n'
        page2=boot_fixture.raw({'entries':f.f[4]})
        responses=[f.full_raw[0],f.full_raw[1],page1,page2,f.full_raw[3]]
        f.full=m.GoogleFullReader(lambda:'synthetic-google',f.source.commit,opener=boot_fixture.package_fixture.Opener(responses))
        f.package.full_reader=f.full
        wire=f.collect();_,native,_=boot_fixture.boot.unpack(wire)
        envelope=json.loads(native['full_logs'])
        import base64
        self.assertEqual([base64.b64decode(p['base64']) for p in envelope['pages']],[page1,page2])
        self.assertEqual(boot_fixture.boot.gate.logs(native['full_logs'],m.log_filter(f.p.admission['verification_manifest'])),f.f[4])
        f.reserve.assert_called_once_with(58*1024*1024)


if __name__=='__main__':unittest.main()
