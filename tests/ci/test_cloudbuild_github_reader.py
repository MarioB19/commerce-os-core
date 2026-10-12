from datetime import datetime,timedelta,timezone
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import cloudbuild_github_reader as m
from cloudbuild_connected_source import ConnectedSourceReader


class Response:
    status=200;headers={}
    def __init__(self,value):self.raw=json.dumps(value).encode()
    def __enter__(self):return self
    def __exit__(self,*_):return False
    def read(self,n):return self.raw[:n]


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.now=datetime.now(timezone.utc);self.source=ConnectedSourceReader(Mock(),now=lambda:self.now)
        self.source._read_token='synthetic-app-read';self.source._expires=self.now+timedelta(hours=1)
        self.source.commit=Mock(return_value={'sha':'a'*40,'tree':{'sha':'b'*40}})
        self.repo={'id':m.REPOSITORY_ID,'full_name':m.REPOSITORY,'private':False,'archived':False}
        self.main={'ref':'refs/heads/main','object':{'type':'commit','sha':'c'*40}}
        self.pull={'number':49,'state':'open','merged':False,'base':{'ref':'main','sha':'c'*40,'repo':{'id':m.REPOSITORY_ID}},
                   'head':{'sha':'a'*40,'repo':{'id':m.REPOSITORY_ID}}}
        self.event={'kind':'pull_request','repository_id':m.REPOSITORY_ID,'pull_request':49,
                    'source_sha':'a'*40,'source_tree':'b'*40,'base_sha':'c'*40}
        self.opener=Mock();self.opener.open.side_effect=lambda req,timeout:Response({'':self.repo,'/git/ref/heads/main':self.main,'/pulls/49':self.pull}[req.full_url.removeprefix(m.ROOT)])
        self.reader=m.GitHubControlReader(self.source,opener=self.opener)
    def test_same_private_repo_current_head_base_and_tree_required(self):
        result=self.reader.current_event(self.event);self.assertEqual(result['source_sha'],'a'*40)
        self.assertEqual(self.opener.open.call_count,3)
        for call in self.opener.open.call_args_list:
            self.assertEqual(call.args[0].get_header('Authorization'),'Bearer synthetic-app-read')
        self.source.google_token_provider.assert_not_called()
    def test_fork_or_superseded_head_or_main_blocks_current_event(self):
        for mutate,code in [(lambda:self.pull['head']['repo'].update(id=1),'GITHUB_PULL_REQUEST_HEAD_OR_BASE_CHANGED'),
                            (lambda:self.pull['head'].update(sha='d'*40),'GITHUB_PULL_REQUEST_HEAD_OR_BASE_CHANGED'),
                            (lambda:self.main['object'].update(sha='e'*40),'GITHUB_MAIN_OR_BASE_SUPERSEDED')]:
            self.setUp();mutate()
            with self.assertRaisesRegex(RuntimeError,code):self.reader.current_event(self.event)
    def test_private_repository_never_inherits_public_reader(self):
        self.repo['private']=True
        with self.assertRaisesRegex(RuntimeError,'GITHUB_CONTROL_REPOSITORY_CHANGED'):self.reader.current_event(self.event)
    def test_no_writes_redirects_arbitrary_ref_or_google_token_provider(self):
        for path in ['/deployments','/git/ref/heads/other','https://example.invalid/','/pulls/../token']:
            with self.assertRaisesRegex(RuntimeError,'GITHUB_CONTROL_READ_ENDPOINT_REJECTED'):self.reader._read(path)
        self.opener.open.assert_not_called();self.source.google_token_provider.assert_not_called()
    def test_native_latest_check_endpoint_and_identity(self):
        gate='55555555-5555-4555-8555-555555555555'
        contract={'build_id':gate,'source_sha':'a'*40,'github_check_name':'provider check (us-east1)'}
        check={'id':1,'name':contract['github_check_name'],'app':{'id':10529},'head_sha':'a'*40,'status':'completed','conclusion':'success',
            'details_url':'https://console.cloud.google.com/cloud-build/builds;region=us-east1/'+gate+'?project=123'}
        self.opener.open.side_effect=[Response(self.repo),Response({'total_count':1,'check_runs':[check]})]
        self.assertEqual(self.reader.check(contract,'123'),check)
        self.assertIn('filter=latest',self.opener.open.call_args.args[0].full_url)
    def test_paginated_checks_never_choose_an_unproven_old_success(self):
        response=Response({'total_count':1,'check_runs':[]});response.headers={'Link':'next-page'}
        self.opener.open.side_effect=[Response(self.repo),response]
        with self.assertRaisesRegex(RuntimeError,'GITHUB_CONTROL_READ_PAGINATED'):
            self.reader.check({'source_sha':'a'*40,'github_check_name':'observed-check'},'123')

    def pending_fixture(self):
        from test_cloudbuild_attestation import GateTests,NUMBER
        gate=GateTests();gate.setUp();contract=dict(gate.contract);contract.pop('github_check_name')
        check={'id':73,'name':'Observed provider name (region)','app':{'id':10529},
            'head_sha':contract['source_sha'],'status':'queued','conclusion':None,
            'details_url':next(iter(m.check_urls(contract['build_id'],NUMBER)))}
        self.opener.open.side_effect=[Response(self.repo),Response({'total_count':1,'check_runs':[check]})]
        return gate,contract,check,NUMBER

    def test_acquire_exact_pending_provider_name_and_bind_native_pending(self):
        gate,contract,check,number=self.pending_fixture()
        result=self.reader.discover_pending_check(contract,gate.build,number)
        self.assertEqual(result['contract']['github_check_name'],check['name'])
        self.assertNotIn('github_check_name',contract)
        self.assertEqual(result['native_pending_sha256'],m.canonical_hash(gate.build))

    def test_pending_acquisition_rejects_other_app_uuid_sha_or_terminal(self):
        for key,value in [('app',{'id':1}),('details_url','https://example.invalid/'),
                          ('head_sha','c'*40),('status','completed'),('name','bad\nname')]:
            gate,contract,check,number=self.pending_fixture();check[key]=value
            self.opener.open.side_effect=[Response(self.repo),Response({'total_count':1,'check_runs':[check]})]
            with self.assertRaises(RuntimeError):self.reader.discover_pending_check(contract,gate.build,number)
        gate,contract,check,number=self.pending_fixture();gate.build['approval']['state']='APPROVED'
        with self.assertRaisesRegex(RuntimeError,'ALREADY_STARTED'):self.reader.discover_pending_check(contract,gate.build,number)

    def test_duplicate_native_check_or_unsealed_success_name_is_rejected(self):
        gate,contract,check,number=self.pending_fixture()
        self.opener.open.side_effect=[Response(self.repo),Response({'total_count':2,'check_runs':[check,check]})]
        with self.assertRaisesRegex(RuntimeError,'ONE_PENDING'):self.reader.discover_pending_check(contract,gate.build,number)
        check.update(status='completed',conclusion='success')
        with self.assertRaisesRegex(RuntimeError,'NOT_PROVEN'):
            m.validate_app_check(check,{**contract,'github_check_name':'another'},number)


if __name__=='__main__':unittest.main()
