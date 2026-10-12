"""Synthetic publisher identity and token scopes; no real credentials or API."""
import copy
from datetime import datetime,timedelta,timezone
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch,Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import cloudbuild_publisher_readers as m
from ci_release import ReleaseError
from test_cloudbuild_native_publisher import native_fixture

NOW=datetime(2026,10,11,15,tzinfo=timezone.utc)
REPO={'id':m.REPOSITORY_ID,'full_name':m.REPOSITORY,'private':False,'archived':False}


class FixtureReader:
    def __init__(self):self.values={};self.calls=[];self.error=None
    def request(self,url,**kwargs):
        self.calls.append((url,kwargs))
        if self.error and url.endswith(self.error):raise RuntimeError('synthetic lost response')
        value=self.values[url]
        return value if type(value)is bytes else json.dumps(value).encode()


class PublisherCredentialTests(unittest.TestCase):
    def setUp(self):
        self.reader=FixtureReader();self.reader.values={
            m.GOOGLE+m.CONNECTION:{'name':m.CONNECTION,'installationState':{'stage':'COMPLETE'},
                'githubConfig':{'appInstallationId':m.INSTALLATION_ID}},
            m.GOOGLE+m.CONNECTED_REPOSITORY:{'name':m.CONNECTED_REPOSITORY,'remoteUri':m.REMOTE},
            m.GOOGLE+m.CONNECTED_REPOSITORY+':accessReadWriteToken':{'token':'synthetic-github-write',
                'expirationTime':(NOW+timedelta(hours=1)).isoformat()},m.GITHUB:copy.deepcopy(REPO)}
        self.provider=m.PublisherCredential(lambda:'synthetic-google',reader=self.reader,now=lambda:NOW)
    def test_original_connection_then_one_write_token_and_numeric_private_repo(self):
        result=self.provider.acquire()
        self.assertFalse(result['deployment_write_proven']);self.assertNotIn('token',result)
        self.assertEqual(self.provider.credential(),'synthetic-github-write')
        self.assertEqual([url for url,_ in self.reader.calls],[m.GOOGLE+m.CONNECTION,m.GOOGLE+m.CONNECTED_REPOSITORY,
            m.GOOGLE+m.CONNECTED_REPOSITORY+':accessReadWriteToken',m.GITHUB])
        self.assertEqual(self.reader.calls[2][1]['token'],'synthetic-google')
        self.assertEqual(self.reader.calls[3][1]['token'],'synthetic-github-write')
        with self.assertRaisesRegex(ReleaseError,'ALREADY_ATTEMPTED'):self.provider.acquire()
        self.assertEqual(len(self.reader.calls),4)
    def test_wrong_connection_or_repository_blocks_token_mint(self):
        self.reader.values[m.GOOGLE+m.CONNECTION]['githubConfig']['appInstallationId']='other'
        with self.assertRaisesRegex(ReleaseError,'ORIGINAL_CONNECTION'):self.provider.acquire()
        self.assertFalse(any(url.endswith('Token')for url,_ in self.reader.calls))
    def test_public_or_recreated_repo_does_not_release_cached_token(self):
        for key,value in (('private',True),('id',1)):
            self.setUp();self.reader.values[m.GITHUB][key]=value
            with self.assertRaisesRegex(ReleaseError,'ORIGINAL_REPOSITORY'):self.provider.acquire()
            with self.assertRaisesRegex(ReleaseError,'EXPIRED'):self.provider.credential()
    def test_short_unknown_and_excessive_expiry_rejected(self):
        for expiry in ('',(NOW+timedelta(minutes=10)).isoformat(),(NOW+timedelta(days=2)).isoformat()):
            self.setUp();self.reader.values[m.GOOGLE+m.CONNECTED_REPOSITORY+':accessReadWriteToken']['expirationTime']=expiry
            with self.assertRaises(Exception):self.provider.acquire()
            self.assertIsNone(self.provider._token)
    def test_lost_token_response_is_never_automatically_minted_again(self):
        self.reader.error=':accessReadWriteToken'
        with self.assertRaisesRegex(RuntimeError,'lost response'):self.provider.acquire()
        with self.assertRaisesRegex(ReleaseError,'ALREADY_ATTEMPTED'):self.provider.acquire()
        self.assertEqual(sum(url.endswith(':accessReadWriteToken')for url,_ in self.reader.calls),1)
    def test_expired_cached_credential_has_no_refresh_side_effect(self):
        self.provider.acquire();self.provider.now=lambda:NOW+timedelta(hours=1)
        with self.assertRaisesRegex(ReleaseError,'EXPIRED'):self.provider.credential()
        self.assertEqual(len(self.reader.calls),4)


class IdentityControlsTests(unittest.TestCase):
    def setUp(self):self.reader=FixtureReader()
    def test_metadata_email_precedes_token_and_no_fallback_principal(self):
        self.reader.values={m.METADATA+'email':m.ACCOUNT.encode(),m.METADATA+'token':
            {'access_token':'synthetic','expires_in':3600,'token_type':'Bearer'}}
        identity=m.PublisherIdentity(reader=self.reader)
        self.assertEqual(identity.token(),'synthetic')
        self.assertTrue(all(kwargs['metadata']for _,kwargs in self.reader.calls))
        self.reader.calls=[];self.reader.values[m.METADATA+'email']=b'personal@example.invalid'
        with self.assertRaisesRegex(ReleaseError,'IDENTITY_CHANGED'):identity.token()
        self.assertEqual(len(self.reader.calls),1)
    def test_controls_report_real_pause_and_actions_not_forced_defaults(self):
        self.reader.values={m.GITHUB:REPO,m.GITHUB+'/actions/variables/COMMERCE_DEPLOY_PAUSED':
            {'name':'COMMERCE_DEPLOY_PAUSED','value':'true'},m.GITHUB+'/actions/permissions':{'enabled':False}}
        controls=m.PublisherControls(lambda:'synthetic',reader=self.reader)
        self.assertEqual(controls.controls(),{'deploy_paused':True,'github_actions_enabled':False})
        self.reader.values[m.GITHUB+'/actions/permissions']['enabled']='false'
        with self.assertRaisesRegex(ReleaseError,'CONTROLS_INVALID'):controls.controls()
    def test_main_requires_commit_shape_and_exact_repo(self):
        self.reader.values={m.GITHUB:REPO,m.GITHUB+'/git/ref/heads/main':
            {'ref':'refs/heads/main','object':{'type':'commit','sha':'a'*40}}}
        controls=m.PublisherControls(lambda:'synthetic',reader=self.reader)
        self.assertEqual(controls.main(),'a'*40)
        self.reader.values[m.GITHUB+'/git/ref/heads/main']['object']['type']='tag'
        with self.assertRaisesRegex(ReleaseError,'MAIN_IDENTITY'):controls.main()


class Response(io.BytesIO):
    def __init__(self,raw=b'{}',headers=None):super().__init__(raw);self.headers=headers or {};self.status=200
class Opener:
    def __init__(self,response):self.response=response;self.calls=[]
    def open(self,request,timeout):self.calls.append(request);return self.response


class HTTPScopesTests(unittest.TestCase):
    def test_read_only_urls_cannot_accept_post_and_source_token_endpoint_is_absent(self):
        opener=Opener(Response());reader=m.Reader(opener=opener)
        for url,kwargs in ((m.GITHUB,{'token':'x','method':'POST','body':b'{}'}),
                           (m.GOOGLE+m.CONNECTED_REPOSITORY+':accessReadToken',{'token':'x'}),
                           ('https://outside.invalid',{'token':'x'})):
            with self.assertRaises(ReleaseError):reader.request(url,**kwargs)
        self.assertEqual(opener.calls,[])
    def test_public_and_metadata_requests_never_receive_bearer(self):
        for url,kwargs in ((next(iter(m.PUBLIC)),{}),(m.METADATA+'token',{'metadata':True})):
            opener=Opener(Response(headers={'Metadata-Flavor':'Google'}));reader=m.Reader(opener=opener)
            with self.assertRaises(ReleaseError):reader.request(url,token='synthetic',**kwargs)
            self.assertEqual(opener.calls,[])
            reader.request(url,**kwargs)
            self.assertIsNone(opener.calls[0].get_header('Authorization'))
    def test_metadata_flavor_pagination_encoding_and_size_fail_closed(self):
        for response,url,kwargs in ((Response(),m.METADATA+'email',{'metadata':True}),
            (Response(headers={'Content-Encoding':'gzip'}),m.GITHUB,{'token':'x'}),
            (Response(headers={'Link':'next'}),m.GITHUB,{'token':'x'}),
            (Response(b'12345'),m.GITHUB,{'token':'x','maximum':4})):
            with self.assertRaises(ReleaseError):m.Reader(opener=Opener(response)).request(url,**kwargs)


class RootReadbackTests(unittest.TestCase):
    def test_canonical_collector_exact_pin_and_cleanup_after_unknown_ssh(self):
        admitted,observation,_,_=native_fixture()
        with tempfile.TemporaryDirectory()as directory:
            private=Path(directory).resolve();commands=[]
            def execute(argv,**kwargs):
                commands.append(argv)
                if argv[0]=='ssh-keygen':
                    Path(argv[-1]).write_text('synthetic-private');Path(argv[-1]+'.pub').write_text('ssh-ed25519 c3ludGhldGlj fixture')
                    return SimpleNamespace(returncode=0,stdout='')
                raise RuntimeError('synthetic SSH unknown')
            transport=SimpleNamespace(private=private,admitted=None,remaining=Mock(),observed_identity=Mock(),
                admission_reader=lambda:copy.deepcopy(admitted),run=execute,begin_cleanup=Mock())
            pin=m.digest(Path(m.__file__).with_name('cloudbuild-installed-readback.py'))
            with self.assertRaisesRegex(ReleaseError,'COLLECTOR_CHANGED'):m.NativeRootReadback(transport,'0'*64)
            reader=m.NativeRootReadback(transport,pin)
            with patch.object(m,'remove_ephemeral_key')as cleanup:
                with self.assertRaisesRegex(RuntimeError,'SSH unknown'):reader(admitted['installation_run_id'])
            cleanup.assert_called_once();self.assertEqual(list(private.iterdir()),[])
            self.assertEqual(len(commands),2)
            ssh=commands[1];self.assertIn('--account='+m.ACCOUNT,ssh)
            command=next(arg for arg in ssh if arg.startswith('--command='))
            self.assertIn('sudo /usr/bin/python3 -c ',command)
            self.assertNotIn('systemd-run',command);self.assertNotIn('copy_runtime_deployment',command)


if __name__=='__main__':unittest.main()
