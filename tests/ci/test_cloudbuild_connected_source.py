import copy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_connected_source as m

class Response:
    status=200
    def __init__(self,value):self.raw=json.dumps(value).encode()
    def __enter__(self):return self
    def __exit__(self,*_):return False
    def read(self,n):return self.raw[:n]

class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.now=datetime(2026,10,11,14,tzinfo=timezone.utc)
        self.values=[{'name':m.CONNECTION,'installationState':{'stage':'COMPLETE'},'githubConfig':{'appInstallationId':m.INSTALLATION_ID}}, {'name':m.CONNECTED_REPOSITORY,'remoteUri':m.REMOTE}, {'token':'synthetic-read-credential','expirationTime':(self.now+timedelta(hours=1)).isoformat()}, {'id':m.REPOSITORY_ID,'full_name':m.REPOSITORY,'private':False,'archived':False}]
        self.calls=[]
        def send(request,timeout):self.calls.append(request);return Response(self.values.pop(0))
        self.opener=Mock();self.opener.open.side_effect=send
        self.reader=m.ConnectedSourceReader(lambda:'synthetic-google-credential',opener=self.opener,now=lambda:self.now)
    def test_native_repository_scope_then_distinct_github_credential(self):
        self.reader.connect();self.values.append({'sha':'a'*40,'tree':{'sha':'b'*40}})
        self.assertEqual(self.reader.commit(m.REPOSITORY,'a'*40)['tree']['sha'],'b'*40)
        self.assertEqual([c.method for c in self.calls],['GET','GET','POST','GET','GET'])
        self.assertTrue(all(c.get_header('Authorization')=='Bearer synthetic-google-credential' for c in self.calls[:3]))
        self.assertTrue(all(c.get_header('Authorization')=='Bearer synthetic-read-credential' for c in self.calls[3:]))
        self.assertEqual(self.calls[2].data,b'{}')
    def test_private_repository_cannot_inherit_public_profile(self):
        self.values[3]['id']=1359063164;self.values[3]['private']=True
        with self.assertRaisesRegex(m.EvidenceError,'SOURCE_GITHUB_REPOSITORY_CHANGED'):self.reader.connect()
        self.assertIsNone(self.reader._read_token)
    def test_wrong_connection_installation_blocks_token_request(self):
        self.values[0]['githubConfig']['appInstallationId']='other'
        with self.assertRaisesRegex(m.EvidenceError,'SOURCE_CONNECTION_NOT_READY'):self.reader.connect()
        self.assertEqual(len(self.calls),1)
    def test_incorrect_connected_remote_blocks_token_request(self):
        self.values[1]['remoteUri']='https://example.invalid/other.git'
        with self.assertRaisesRegex(m.EvidenceError,'SOURCE_CONNECTED_REPOSITORY_CHANGED'):self.reader.connect()
        self.assertEqual(len(self.calls),2)
    def test_expiration_is_required_and_never_silently_refreshed(self):
        self.reader.connect();self.now+=timedelta(hours=1)
        with self.assertRaisesRegex(m.EvidenceError,'SOURCE_CREDENTIAL_EXPIRED'):self.reader.commit(m.REPOSITORY,'a'*40)
        self.assertEqual(len(self.calls),4)
    def test_commit_sha_and_profile_are_strict(self):
        for repo,sha in [('other/repo','a'*40),(m.REPOSITORY,'../../token')]:
            with self.assertRaises(m.EvidenceError):self.reader.commit(repo,sha)
        self.assertFalse(self.calls)
    def test_endpoint_method_and_write_token_are_rejected_without_transport(self):
        for method,url,body in [('GET',m.GOOGLE_ROOT+m.CONNECTED_REPOSITORY+':accessReadWriteToken',None),('POST',m.GITHUB_ROOT,b'{}'),('GET','https://evil.invalid/',None)]:
            with self.assertRaises(m.EvidenceError):self.reader._request(method,url,'synthetic',body=body)
        self.assertFalse(self.calls)
    def test_lost_read_response_does_not_retry_or_expose_credential(self):
        self.opener.open.side_effect=OSError('synthetic-google-credential')
        with self.assertRaisesRegex(m.EvidenceError,'^SOURCE_READ_UNCERTAIN$'):self.reader.connect()
        self.assertEqual(self.opener.open.call_count,1)

class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.base=Path(self.tmp.name).resolve();self.repo=self.base/'fixture';self.repo.mkdir(mode=0o700)
        self.dest=self.base/'destination';self.dest.mkdir(mode=0o700)
        (self.repo/'scripts').mkdir();(self.repo/'.github/workflows').mkdir(parents=True)
        (self.repo/'scripts/cloudbuild-verify.py').write_text('synthetic fixture runner\n')
        (self.repo/'.github/workflows/ci.yml').write_text('synthetic fixture workflow\n')
        self.cmd('init','--quiet');self.cmd('add','.');self.cmd('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Fixture')
        self.approval={'repository_id':m.REPOSITORY_ID,'repository':m.REPOSITORY,'source_sha':self.cmd('rev-parse','HEAD'),'source_tree':self.cmd('rev-parse','HEAD^{tree}'),'runner_sha256':hashlib.sha256((self.repo/'scripts/cloudbuild-verify.py').read_bytes()).hexdigest(),'workflow_sha256':hashlib.sha256((self.repo/'.github/workflows/ci.yml').read_bytes()).hexdigest(),'review_sha256':'c'*64,'expires_at':(m.clock()+timedelta(hours=1)).isoformat()}
        self.reader=Mock();self.reader.commit.return_value={'sha':self.approval['source_sha'],'tree':{'sha':self.approval['source_tree']}};self.reader.credential.return_value='synthetic-source-secret'
        self.reader.tree.side_effect=self.tree
        self.production_git=m.git;self.fetches=[]
        def local_git(root,*args,credential=None):
            if args and args[0]=='fetch':
                self.fetches.append((args,credential))
                # Test-only local source; production function only permits HTTPS.
                subprocess.run(['git','-c','core.hooksPath=/dev/null','fetch','--quiet','--no-tags','--depth=1','file://'+str(self.repo),args[-1]],cwd=root,check=True,capture_output=True)
                return ''
            return self.production_git(root,*args,credential=credential)
        p=patch.object(m,'git',side_effect=local_git);p.start();self.addCleanup(p.stop)
    def cmd(self,*args):return subprocess.check_output(['git',*args],cwd=self.repo,stderr=subprocess.DEVNULL).decode().strip()
    def tree(self,tree_sha):
        entries=[]
        for row in self.cmd('ls-tree','-rlz','--full-tree',tree_sha).split('\0'):
            if not row:continue
            fields,path=row.split('\t',1);mode,kind,sha,size=fields.split()
            entries.append({'path':path,'mode':mode,'type':kind,'sha':sha,'size':int(size)})
        return {'sha':tree_sha,'truncated':False,'tree':entries}
    def test_archive_has_original_commit_clean_shallow_git_and_no_credentials(self):
        result=m.prepare_archive(self.dest,self.approval,self.reader)
        self.assertEqual(result['source_sha'],self.approval['source_sha']);self.assertEqual(result['source_tree'],self.approval['source_tree'])
        self.assertEqual(len(self.fetches),1);self.assertIn(m.REMOTE,self.fetches[0][0]);self.assertEqual(self.fetches[0][1],'synthetic-source-secret')
        with tarfile.open(result['archive_path'],'r:gz') as archive:
            config=archive.extractfile('./.git/config').read().decode();self.assertEqual(config,m.SANITIZED_CONFIG)
            self.assertEqual(archive.extractfile('./.git/shallow').read().decode().strip(),self.approval['source_sha'])
            for member in archive.getmembers():
                self.assertTrue(member.isdir() or member.isfile())
                if member.isfile():self.assertNotIn(b'synthetic-source-secret',archive.extractfile(member).read())
        self.assertTrue(result['self_contained_shallow_git']);self.assertTrue(result['git_config_sanitized'])
        self.assertEqual(result['preflight']['tracked_files'],2)
        self.assertGreater(result['acquisition_resources']['cpu_seconds'],0)
    def test_destination_with_existing_evidence_is_never_overwritten(self):
        (self.dest/'receipt').write_text('original')
        with self.assertRaisesRegex(m.EvidenceError,'SOURCE_DESTINATION_NOT_EMPTY'):m.prepare_archive(self.dest,self.approval,self.reader)
        self.assertEqual((self.dest/'receipt').read_text(),'original');self.assertFalse(self.fetches)
    def test_symlink_in_candidate_is_rejected_before_checkout(self):
        (self.repo/'unsafe').symlink_to('/etc/passwd');self.cmd('add','unsafe');self.cmd('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Link fixture')
        self.approval['source_sha']=self.cmd('rev-parse','HEAD');self.approval['source_tree']=self.cmd('rev-parse','HEAD^{tree}');self.reader.commit.return_value={'sha':self.approval['source_sha'],'tree':{'sha':self.approval['source_tree']}}
        with self.assertRaisesRegex(m.EvidenceError,'SOURCE_NON_REGULAR_TRACKED_ENTRY'):m.prepare_archive(self.dest,self.approval,self.reader)
        self.assertFalse((self.dest/'source/unsafe').exists())
        self.assertFalse(self.fetches)
    def test_protected_review_tree_must_match_authenticated_commit(self):
        self.reader.commit.return_value['tree']['sha']='e'*40
        with self.assertRaisesRegex(m.EvidenceError,'SOURCE_APPROVED_TREE_CHANGED'):m.prepare_archive(self.dest,self.approval,self.reader)
        self.assertFalse(self.fetches)
    def test_expired_approval_blocks_even_local_checkout(self):
        self.approval['expires_at']=(m.clock()-timedelta(seconds=1)).isoformat()
        with self.assertRaisesRegex(m.EvidenceError,'SOURCE_APPROVAL_EXPIRED'):m.prepare_archive(self.dest,self.approval,self.reader)
        self.reader.commit.assert_not_called()
    def test_source_credential_not_in_process_arguments_or_persistent_git_config(self):
        with patch.object(m,'run_git',return_value=Mock(returncode=0,stdout=b'')) as run:
            self.production_git(self.dest,'fetch',m.REMOTE,'a'*40,credential='unique-sensitive-fixture')
        args,kwargs=run.call_args;self.assertNotIn('unique-sensitive-fixture',' '.join(args[0]));self.assertIn('COMMERCE_SOURCE_AUTH_HEADER',kwargs['environment'])
        self.assertNotIn('HOME',kwargs['environment']);self.assertEqual(kwargs['environment']['GIT_CONFIG_GLOBAL'],'/dev/null')
        self.assertIn('http.followRedirects=false',args[0]);self.assertIn('credential.helper=',args[0])
    def test_truncated_or_oversized_tree_blocks_before_any_fetch(self):
        original=self.tree(self.approval['source_tree'])
        for mutate,code in [(lambda v:v.update(truncated=True),'SOURCE_PREFLIGHT_TREE_INCOMPLETE'),
                            (lambda v:v['tree'][0].update(size=m.MAX_TRACKED_BYTES+1),'SOURCE_TRACKED_SIZE_REQUIRES_ADMISSION')]:
            value=copy.deepcopy(original);mutate(value);self.reader.tree.side_effect=None;self.reader.tree.return_value=value
            with self.assertRaisesRegex(m.EvidenceError,code):m.prepare_archive(self.dest,self.approval,self.reader)
            self.assertFalse(self.fetches)
    def test_actual_fetched_tree_must_match_authenticated_sizes(self):
        value=self.tree(self.approval['source_tree']);value['tree'][0]['size']+=1
        self.reader.tree.side_effect=None;self.reader.tree.return_value=value
        with self.assertRaisesRegex(m.EvidenceError,'SOURCE_FETCHED_TREE_DIFFERS_FROM_PREFLIGHT'):m.prepare_archive(self.dest,self.approval,self.reader)
        self.assertFalse((self.dest/'source/scripts/cloudbuild-verify.py').exists())
    def test_archive_limit_applies_while_writing(self):
        with patch.object(m,'MAX_ARCHIVE',64):
            with self.assertRaisesRegex(m.EvidenceError,'SOURCE_ARCHIVE_SIZE_REQUIRES_ADMISSION'):m.prepare_archive(self.dest,self.approval,self.reader)
        self.assertLessEqual((self.dest/'source.tgz').stat().st_size,64)
if __name__=='__main__':unittest.main()
