"""Synthetic API and durable journal contracts; never authenticates or publishes."""
import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import cloudbuild_native_publisher as m
from ci_release import ReleaseError
from test_cloudbuild_release_provider import observation,context,contract,PACKAGE,SHA


def native_fixture():
    admitted,native,core,portal=observation();c=context(False)
    run=contract.cloud_installation_id(PACKAGE,1,local_package=False)
    admitted.update(context=c,installation_run_id=run,artifact_uri='gs://fixture/release.tar#1')
    native['report'].update(provider_evidence=c,run_id=run,release='ci-'+run+'-'+SHA[:12])
    native['report_ref']['path']='/opt/commerce-os/private/deployments/'+run+'/report.json'
    return admitted,native,core,portal


class Journal:
    def __init__(self):self.actions={};self.results=[];self.unknown=False;self.lose_result=False
    def commit_intent(self,action,payload):
        digest=hashlib.sha256(m.encoded(payload)).hexdigest()
        if action in self.actions:
            assert self.actions[action]==digest
            return {'effect':None,'intent_sha256':digest,'fencing_generation':'2','attempt_id':'fixture'}
        self.actions[action]=digest
        if self.unknown:raise RuntimeError('synthetic CAS response lost')
        return {'effect':'CREATE_ONCE','intent_sha256':digest,'fencing_generation':'2','attempt_id':'fixture'}
    def record_result(self,action,result):
        self.results.append((action,result))
        if self.lose_result:raise RuntimeError('synthetic result response lost')


class GitHub:
    def __init__(self,admitted,payload):
        self.admitted=admitted;self.payload=payload;self.deployments=[];self.statuses=[];self.calls=[]
        self.lost=None;self.silent=False;self.wrong_readback=False;self.head=SHA
        self.repository={'id':m.REPOSITORY_ID,'full_name':m.REPOSITORY,'private':False,'archived':False}
    def request(self,method,path,body=None):
        self.calls.append((method,path,body))
        if method=='POST':
            if path=='/deployments':
                result={'id':11,'sha':body['ref'],'payload':body['payload']}
                if not self.silent:self.deployments=[copy.deepcopy(result)]
            else:
                result={**body,'id':12}
                if not self.silent:self.statuses=[copy.deepcopy(result)]
            if self.lost==path:raise TimeoutError('synthetic lost response')
            return result
        if path=='':return self.repository
        if path=='/git/ref/heads/main':return {'ref':'refs/heads/main','object':{'type':'commit','sha':self.head}}
        if path=='/deployments?environment=production&per_page=100':return copy.deepcopy(self.deployments)
        if path.endswith('/statuses?per_page=100'):return copy.deepcopy(self.statuses)
        result=copy.deepcopy(self.deployments[0]);result['id']=99 if self.wrong_readback else result['id'];return result
    def posts(self):return [c for c in self.calls if c[0]=='POST']


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.admitted,self.native,self.core,self.portal=native_fixture()
        self.payload=m.evidence.deployment_payload(self.admitted,self.native,self.core,self.portal)
        self.github=GitHub(self.admitted,self.payload);self.journal=Journal();self.reads=[]
        def admission():self.reads.append('native');return copy.deepcopy(self.admitted)
        self.publisher=m.NativePublisher(admission,lambda run:copy.deepcopy(self.native),
            lambda url:copy.deepcopy(self.core if url.startswith(m.evidence.ORIGIN)else self.portal),self.github,self.journal)
    def test_missing_installation_or_https_proof_prevents_any_publication(self):
        for target,key,value in ((self.native['report'],'status','RUNNING'),
                                 (self.core,'sha','0'*40),(self.portal,'activities',0)):
            before=target[key];target[key]=value
            with self.assertRaises(ReleaseError):self.publisher.reconcile_or_publish()
            target[key]=before
        self.assertEqual(self.github.posts(),[]);self.assertEqual(self.journal.actions,{})
    def test_two_distinct_intents_then_exact_native_readbacks(self):
        result=self.publisher.reconcile_or_publish()
        self.assertEqual(result['status'],'NATIVE_DEPLOYMENT_PUBLISHED');self.assertEqual(len(self.github.posts()),2)
        self.assertEqual(len(self.journal.actions),2);self.assertEqual(len(self.reads),4)
        self.assertFalse(self.github.posts()[0][2]['auto_merge']);self.assertFalse(self.github.posts()[1][2]['auto_inactive'])
        self.assertTrue(all(r['status']=='RESPONSE_RECEIVED'for _,r in self.journal.results))
    def test_existing_success_reconciles_with_zero_posts(self):
        self.publisher.reconcile_or_publish();self.github.calls=[]
        self.assertEqual(self.publisher.reconcile_or_publish()['status'],'NATIVE_DEPLOYMENT_RECONCILED')
        self.assertEqual(self.github.posts(),[])
    def test_lost_deployment_response_reconciles_existing_then_status_only(self):
        self.github.lost='/deployments'
        with self.assertRaisesRegex(RuntimeError,'OUTCOME_UNKNOWN'):self.publisher.reconcile_or_publish()
        self.github.lost=None;self.github.calls=[];self.publisher.reconcile_or_publish()
        self.assertEqual([p[1]for p in self.github.posts()],['/deployments/11/statuses'])
        self.assertEqual(self.journal.results[0][1]['status'],'UNKNOWN')
    def test_lost_status_response_never_duplicates_status(self):
        self.github.lost='/deployments/11/statuses'
        with self.assertRaisesRegex(RuntimeError,'OUTCOME_UNKNOWN'):self.publisher.reconcile_or_publish()
        self.github.lost=None;self.github.calls=[]
        self.assertEqual(self.publisher.reconcile_or_publish()['status'],'NATIVE_DEPLOYMENT_RECONCILED')
        self.assertEqual(self.github.posts(),[])
    def test_unknown_with_no_visible_deployment_never_reposts(self):
        self.github.lost='/deployments';self.github.silent=True
        with self.assertRaises(RuntimeError):self.publisher.reconcile_or_publish()
        self.github.calls=[]
        with self.assertRaisesRegex(ReleaseError,'INTENT_NOT_NEW'):self.publisher.reconcile_or_publish()
        self.assertEqual(self.github.posts(),[])
    def test_unknown_cas_response_consumes_intent_without_external_effect(self):
        self.journal.unknown=True
        with self.assertRaisesRegex(RuntimeError,'CAS response lost'):self.publisher.reconcile_or_publish()
        self.assertEqual(self.github.posts(),[]);self.journal.unknown=False
        with self.assertRaisesRegex(ReleaseError,'INTENT_NOT_NEW'):self.publisher.reconcile_or_publish()
        self.assertEqual(self.github.posts(),[])
    def test_failed_result_journal_never_authorizes_second_post(self):
        self.journal.lose_result=True
        with self.assertRaisesRegex(RuntimeError,'OUTCOME_UNKNOWN'):self.publisher.reconcile_or_publish()
        self.journal.lose_result=False;self.github.calls=[];self.publisher.reconcile_or_publish()
        self.assertEqual([p[1]for p in self.github.posts()],['/deployments/11/statuses'])
    def test_public_or_wrong_repository_is_rejected_before_any_mutation(self):
        for key,value in [('private',True),('id',9),('archived',True)]:
            old=self.github.repository[key];self.github.repository[key]=value
            with self.assertRaisesRegex(ReleaseError,'PUBLIC_PUBLISHER_REPOSITORY_CHANGED'):self.publisher.reconcile_or_publish()
            self.github.repository[key]=old
        self.assertEqual(self.github.posts(),[])
    def test_new_main_or_incomplete_custody_never_publishes(self):
        self.github.head='0'*40
        with self.assertRaisesRegex(ReleaseError,'MAIN_SUPERSEDED'):self.publisher.reconcile_or_publish()
        self.github.head=SHA;self.native['report']['consumers_started']=False
        with self.assertRaisesRegex(ReleaseError,'INSTALLED_REPORT'):self.publisher.reconcile_or_publish()
        self.assertEqual(self.github.posts(),[])
    def test_admission_changes_during_readback_stop_before_publication(self):
        calls=[]
        def changing():
            calls.append(True);return copy.deepcopy(self.admitted)if len(calls)==1 else dict(self.admitted,archive_sha256='0'*64)
        self.publisher.admission_reader=changing
        with self.assertRaisesRegex(ReleaseError,'ADMISSION_CHANGED'):self.publisher.reconcile_or_publish()
        self.assertEqual(self.github.posts(),[])
    def test_duplicate_identity_or_full_inventory_is_incomplete(self):
        row={'id':11,'sha':SHA,'payload':self.payload}
        for rows,expected in [([row,row],'IDENTITY_AMBIGUOUS'),([{}]*100,'INVENTORY_INCOMPLETE')]:
            self.github.deployments=rows
            with self.assertRaisesRegex(ReleaseError,expected):self.publisher.reconcile_or_publish()
        self.assertEqual(self.github.posts(),[])
    def test_wrong_id_readback_blocks_status_after_one_deployment_post(self):
        self.github.wrong_readback=True
        with self.assertRaisesRegex(ReleaseError,'READBACK_MISMATCH'):self.publisher.reconcile_or_publish()
        self.assertEqual([p[1]for p in self.github.posts()],['/deployments'])
    def test_existing_failure_is_never_overwritten(self):
        self.github.deployments=[{'id':11,'sha':SHA,'payload':self.payload}];self.github.statuses=[{'state':'failure'}]
        with self.assertRaisesRegex(ReleaseError,'LATEST_STATUS_CONFLICT'):self.publisher.reconcile_or_publish()
        self.assertEqual(self.github.posts(),[])


class Response(io.BytesIO):
    def __init__(self,raw,status=200,headers=None):super().__init__(raw);self.status=status;self.headers=headers or {}
class Opener:
    def __init__(self,response):self.response=response;self.calls=[]
    def open(self,request,timeout):self.calls.append(request);return self.response


class CredentialTests(unittest.TestCase):
    def test_explicit_publisher_provider_and_fixed_repository(self):
        opener=Opener(Response(b'{"id":1}'));api=m.GitHubDeploymentAPI(lambda:'synthetic-publisher-only',opener=opener)
        self.assertEqual(api.request('GET','')['id'],1);request=opener.calls[0]
        self.assertEqual(request.full_url,m.API);self.assertEqual(request.get_header('Authorization'),'Bearer synthetic-publisher-only')
        self.assertEqual(request.get_header('Accept-encoding'),'identity')
    def test_arbitrary_endpoint_and_mutation_method_rejected_before_token(self):
        api=m.GitHubDeploymentAPI(lambda:self.fail('token accessed'))
        for method,path in [('POST','/issues'),('DELETE','/deployments/1'),('GET','https://outside.invalid'),('GET','/deployments/0')]:
            with self.assertRaisesRegex(ReleaseError,'ENDPOINT_REJECTED'):api.request(method,path,{}if method=='POST'else None)
    def test_oversized_duplicate_json_and_encoded_response_rejected(self):
        for response in [Response(b'x'*(m.MAX_RESPONSE+1)),Response(b'{"id":1,"id":2}'),Response(b'{}',headers={'Content-Encoding':'gzip'})]:
            api=m.GitHubDeploymentAPI(lambda:'synthetic',opener=Opener(response))
            with self.assertRaises((ReleaseError,RuntimeError)):api.request('GET','')
    def test_post_must_have_native_created_response(self):
        api=m.GitHubDeploymentAPI(lambda:'synthetic',opener=Opener(Response(b'{"id":1}',status=200)))
        with self.assertRaisesRegex(ReleaseError,'RESPONSE_UNCONFIRMED'):api.request('POST','/deployments',{})
    def test_short_inventory_with_pagination_header_is_not_complete(self):
        response=Response(b'[]',headers={'Link':'<https://api.github.com/next>; rel="next"'})
        api=m.GitHubDeploymentAPI(lambda:'synthetic',opener=Opener(response))
        with self.assertRaisesRegex(ReleaseError,'RESPONSE_UNCONFIRMED'):
            api.request('GET','/deployments?environment=production&per_page=100')


if __name__=='__main__':unittest.main()
