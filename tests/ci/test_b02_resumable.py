"""Local adversarial fixtures for direct ciphertext transport; no cloud or credentials."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import urllib.parse

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
import b02_backup_contract as c

def load(name,filename):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/filename)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

r=load('resumable_root_test','b02-backup-root.py')
t=load('resumable_cloud_test','b02-backup-gcp.py')
BUCKET='commerce-own-backups'
RUN='gcp-efcb1286e8d14b1286f73d899ee229fd'
NAME='ciphertext.backup.aes'
OBJECT='b02/daily/'+RUN+'/'+NAME
PAYLOAD=b'COMOSB02'+b'synthetic-ciphertext'*4
EXPECTED={'bytes':len(PAYLOAD),'sha256':hashlib.sha256(PAYLOAD).hexdigest()}
TOKEN='synthetic-oauth-token-never-real'
CAPABILITY='synthetic-session-capability'

def uri(bucket=BUCKET,name=OBJECT):
    return 'https://storage.googleapis.com/upload/storage/v1/b/'+bucket+'/o?'+urllib.parse.urlencode({'uploadType':'resumable','name':name,'upload_id':CAPABILITY})

class Response:
    def __init__(self,status=200,body=None,headers=None,url=None):
        self.status=status;self.body=json.dumps(body or {}).encode();self.headers=headers or {};self.url=url
    def read(self,n=-1):return self.body if n<0 else self.body[:n]
    def geturl(self):return self.url
    def __enter__(self):return self
    def __exit__(self,*args):return False

class SessionCreation(unittest.TestCase):
    def test_create_only_length_and_oauth_stay_in_request_ram(self):
        seen=[]
        def open_(request,timeout):
            seen.append(request);self.assertEqual(timeout,30)
            parsed=urllib.parse.urlsplit(request.full_url)
            self.assertEqual(parsed.scheme,'https');self.assertEqual(parsed.netloc,'storage.googleapis.com')
            self.assertEqual(urllib.parse.parse_qs(parsed.query),{'uploadType':['resumable'],'name':[OBJECT],'ifGenerationMatch':['0']})
            self.assertEqual(request.method,'POST');self.assertEqual(request.get_header('Authorization'),'Bearer '+TOKEN)
            self.assertEqual(request.get_header('X-upload-content-length'),str(len(PAYLOAD)))
            self.assertEqual(json.loads(request.data),{'name':OBJECT,'contentType':'application/octet-stream'})
            return Response(headers={'Location':uri()},url=request.full_url)
        with mock.patch.object(t.urllib.request,'build_opener',return_value=SimpleNamespace(open=open_)):
            self.assertEqual(t.create_resumable_session(BUCKET,OBJECT,EXPECTED,TOKEN),uri())
        self.assertEqual(len(seen),1)

    def test_session_unknown_hides_token_uri_and_never_retries(self):
        op=mock.Mock(side_effect=OSError(TOKEN+' '+uri()))
        with mock.patch.object(t.urllib.request,'build_opener',return_value=SimpleNamespace(open=op)):
            with self.assertRaises(RuntimeError) as caught:t.create_resumable_session(BUCKET,OBJECT,EXPECTED,TOKEN)
        self.assertEqual(str(caught.exception),'B02_UPLOAD_SESSION_UNKNOWN_PRESERVE');self.assertEqual(op.call_count,1)
        self.assertNotIn(TOKEN,str(caught.exception));self.assertNotIn(CAPABILITY,str(caught.exception))

    def test_wrong_location_status_redirect_and_deadline_reject(self):
        for bad in ('https://attacker.invalid/capability',uri(name=OBJECT+'-wrong')):
            with self.subTest(location=bad),mock.patch.object(t.urllib.request,'build_opener',return_value=SimpleNamespace(open=lambda req,**kw:Response(headers={'Location':bad},url=req.full_url))):
                with self.assertRaises(RuntimeError):t.create_resumable_session(BUCKET,OBJECT,EXPECTED,TOKEN)
        for status,url in ((308,None),(200,'https://storage.googleapis.com/other')):
            with self.subTest(status=status,url=url),mock.patch.object(t.urllib.request,'build_opener',return_value=SimpleNamespace(open=lambda req,**kw:Response(status,headers={'Location':uri()},url=url or req.full_url))):
                with self.assertRaises(RuntimeError):t.create_resumable_session(BUCKET,OBJECT,EXPECTED,TOKEN)
        with mock.patch.object(t.urllib.request,'build_opener') as opener:
            for timeout in (0,-1,31,True):
                with self.subTest(timeout=timeout),self.assertRaises(RuntimeError):t.create_resumable_session(BUCKET,OBJECT,EXPECTED,TOKEN,timeout=timeout)
            opener.assert_not_called()

class FullReadback(unittest.TestCase):
    def test_generation_pinned_download_hash_required_and_bad_file_preserved(self):
        for corrupt in (False,True):
            with self.subTest(corrupt=corrupt),tempfile.TemporaryDirectory() as temporary:
                client=t.Transport.__new__(t.Transport);client.work=Path(temporary);client.binding={'bucket':BUCKET};calls=[]
                def command(argv):
                    calls.append(argv)
                    if argv[2:4]==['objects','describe']:
                        return SimpleNamespace(stdout=json.dumps({'bucket':BUCKET,'name':OBJECT,'generation':'7','size':str(len(PAYLOAD))}))
                    self.assertEqual(argv[3],'gs://'+BUCKET+'/'+OBJECT+'#7')
                    Path(argv[4]).write_bytes(PAYLOAD[:-1]+b'!' if corrupt else PAYLOAD)
                    return SimpleNamespace(stdout='')
                client.command=command
                if corrupt:
                    with self.assertRaisesRegex(RuntimeError,'FULL_OBJECT_HASH'):client.verify_uploaded(EXPECTED,NAME,OBJECT,True)
                    self.assertTrue((client.work/('readback-'+NAME)).exists())
                else:
                    result=client.verify_uploaded(EXPECTED,NAME,OBJECT,True)
                    self.assertTrue(result['full_download_verified']);self.assertEqual(result['generation'],'7')
                    self.assertFalse((client.work/('readback-'+NAME)).exists())
                self.assertEqual(len(calls),2)

    def test_metadata_identity_and_existing_target_block_download(self):
        with tempfile.TemporaryDirectory() as temporary:
            client=t.Transport.__new__(t.Transport);client.work=Path(temporary);client.binding={'bucket':BUCKET}
            base={'bucket':BUCKET,'name':OBJECT,'generation':'7','size':str(len(PAYLOAD))}
            for delta in ({'bucket':'other'},{'name':OBJECT+'wrong'},{'generation':'0'},{'size':'1'}):
                client.command=mock.Mock(return_value=SimpleNamespace(stdout=json.dumps(base|delta)))
                with self.subTest(delta=delta),self.assertRaises(RuntimeError):client.verify_uploaded(EXPECTED,NAME,OBJECT,True)
                self.assertEqual(client.command.call_count,1)
            target=client.work/('readback-'+NAME);target.write_bytes(b'preserved')
            client.command=mock.Mock(return_value=SimpleNamespace(stdout=json.dumps(base)))
            with self.assertRaisesRegex(RuntimeError,'TARGET_EXISTS'):client.verify_uploaded(EXPECTED,NAME,OBJECT,True)
            self.assertEqual(target.read_bytes(),b'preserved');self.assertEqual(client.command.call_count,1)

class TargetBinding(unittest.TestCase):
    def test_uri_exact_and_canonical_encoded_object(self):
        self.assertEqual(r.resumable_target(uri(),BUCKET,OBJECT),uri().split('storage.googleapis.com',1)[1])

    def test_rejects_host_credentials_redirect_object_overwrite_and_query_ambiguity(self):
        invalid=[uri().replace('https:','http:'),uri().replace('storage.googleapis.com','evil.invalid'),
                 uri().replace('storage.googleapis.com','storage.googleapis.com.evil.invalid'),
                 uri().replace('storage.googleapis.com','user@storage.googleapis.com'),
                 uri().replace('storage.googleapis.com','storage.googleapis.com:443'),
                 uri(bucket='other-bucket'),uri(name=OBJECT+'wrong'),uri()+'&ifGenerationMatch=7',
                 uri()+'&upload_id=other_secret',uri()+'&unknown=x',uri()+'#fragment',
                 uri().replace('upload_id=','missing='),uri().replace('https:','https:\n'),
                 uri().replace('uploadType=resumable','uploadType=media')]
        for value in invalid:
            with self.subTest(uri=value),self.assertRaises(RuntimeError):r.resumable_target(value,BUCKET,OBJECT)

class Connection:
    def __init__(self,response=None,send_error=None,send_hook=None):
        self.response=response or Response(body={'bucket':BUCKET,'name':OBJECT,'size':str(len(PAYLOAD)),'generation':'7'})
        self.send_error=send_error;self.send_hook=send_hook;self.sock=SimpleNamespace(settimeout=mock.Mock())
        self.requests=[];self.headers={};self.sent=[];self.closed=False
    def putrequest(self,method,target):self.requests.append((method,target))
    def putheader(self,k,v):self.headers[k]=v
    def endheaders(self):pass
    def send(self,block):
        self.sent.append(block)
        if self.send_hook:self.send_hook()
        if self.send_error:raise self.send_error
    def getresponse(self):return self.response
    def close(self):self.closed=True

class StreamTransport(unittest.TestCase):
    @contextlib.contextmanager
    def fixture(self,connection):
        with tempfile.TemporaryDirectory() as temporary,contextlib.ExitStack() as stack:
            p=Path(temporary).resolve()/NAME;p.write_bytes(PAYLOAD);p.chmod(0o600)
            # Local fixture ownership is the only platform boundary substituted;
            # descriptor hashes, inode, timestamps, mode and nlink remain real.
            fstat=os.fstat;lstat=Path.lstat
            def root_stat(info):
                fields=('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns','st_uid','st_mode','st_nlink')
                return SimpleNamespace(**({k:getattr(info,k) for k in fields}|{'st_uid':0}))
            stack.enter_context(mock.patch.object(r,'protected_parents'))
            stack.enter_context(mock.patch.object(r.os,'fstat',side_effect=lambda fd:root_stat(fstat(fd))))
            stack.enter_context(mock.patch.object(Path,'lstat',lambda path,*a,**kw:root_stat(lstat(path,*a,**kw))))
            factory=mock.Mock(return_value=connection)
            yield p,factory

    def test_one_tls_put_no_oauth_and_descriptor_hashes_verified(self):
        con=Connection()
        with self.fixture(con) as (p,factory):
            result=r.stream_resumable(p,EXPECTED,uri(),BUCKET,OBJECT,connection_factory=factory)
            self.assertEqual(result,EXPECTED|{'generation':'7'});self.assertEqual(p.read_bytes(),PAYLOAD)
        self.assertEqual(factory.call_count,1);self.assertEqual(factory.call_args.args,('storage.googleapis.com',443))
        self.assertEqual(con.requests,[('PUT',r.resumable_target(uri(),BUCKET,OBJECT))]);self.assertEqual(b''.join(con.sent),PAYLOAD)
        self.assertEqual(con.headers,{'Content-Length':str(len(PAYLOAD)),'Content-Type':'application/octet-stream'});self.assertTrue(con.closed)
        self.assertNotIn(CAPABILITY,json.dumps(result));self.assertNotIn(TOKEN,json.dumps(result))

    def test_timeout_closes_once_and_keeps_input(self):
        con=Connection(send_error=TimeoutError(uri()))
        with self.fixture(con) as (p,factory),self.assertRaisesRegex(RuntimeError,'UNKNOWN_PRESERVE') as caught:
            try:r.stream_resumable(p,EXPECTED,uri(),BUCKET,OBJECT,connection_factory=factory)
            finally:self.assertEqual(p.read_bytes(),PAYLOAD)
        self.assertEqual(factory.call_count,1);self.assertEqual(len(con.requests),1);self.assertTrue(con.closed)
        self.assertNotIn(CAPABILITY,str(caught.exception))

    def test_real_wall_clock_fuse_stops_drip_response_and_restores_handler(self):
        import signal,time
        class SlowResponse(Response):
            def read(self,n=-1):time.sleep(2);return super().read(n)
        con=Connection(response=SlowResponse());before=signal.getsignal(signal.SIGALRM);start=time.monotonic()
        with self.fixture(con) as (p,factory):
            with self.assertRaisesRegex(RuntimeError,'TIMEOUT_PRESERVE'):
                # Allow real TLS context setup; the fuse must still interrupt the 2s read.
                r.stream_resumable(p,EXPECTED,uri(),BUCKET,OBJECT,timeout=.5,connection_factory=factory)
        self.assertLess(time.monotonic()-start,1);self.assertTrue(con.closed)
        self.assertEqual(signal.getsignal(signal.SIGALRM),before);self.assertEqual(signal.getitimer(signal.ITIMER_REAL),(0.0,0.0))

    def test_changed_content_modes_links_and_expected_size_block_dispatch(self):
        for variant in ('hash','mode','size','hardlink'):
            con=Connection()
            with self.subTest(variant=variant),self.fixture(con) as (p,factory):
                expected=dict(EXPECTED)
                if variant=='hash':expected['sha256']='0'*64
                elif variant=='mode':p.chmod(0o644)
                elif variant=='size':expected['bytes']+=1
                else:os.link(p,p.with_name('second-link'))
                with self.assertRaises(RuntimeError):r.stream_resumable(p,expected,uri(),BUCKET,OBJECT,connection_factory=factory)
                factory.assert_not_called()

    def test_redirect_or_wrong_metadata_and_post_send_drift_fail_without_replay(self):
        for variant in ('redirect','bucket','generation','source_after'):
            con=Connection()
            with self.subTest(variant=variant),self.fixture(con) as (p,factory):
                if variant=='redirect':con.response.status=307
                elif variant=='bucket':con.response.body=json.dumps({'bucket':'foreign','name':OBJECT,'size':str(len(PAYLOAD)),'generation':'7'}).encode()
                elif variant=='generation':con.response.body=json.dumps({'bucket':BUCKET,'name':OBJECT,'size':str(len(PAYLOAD)),'generation':'0'}).encode()
                else:con.send_hook=lambda:p.write_bytes(PAYLOAD[:-1]+b'!')
                with self.assertRaises(RuntimeError):r.stream_resumable(p,EXPECTED,uri(),BUCKET,OBJECT,connection_factory=factory)
                self.assertEqual(factory.call_count,1);self.assertEqual(len(con.requests),1);self.assertTrue(con.closed)

class RootRunAuthority(unittest.TestCase):
    @contextlib.contextmanager
    def fixture(self):
        with tempfile.TemporaryDirectory() as temporary,contextlib.ExitStack() as stack:
            runs=Path(temporary).resolve();directory=runs/RUN;directory.mkdir()
            exports={}
            for name in c.BASE_EXPORTS:
                p=directory/name;p.write_bytes(PAYLOAD if name==NAME else b'{}');p.chmod(0o600)
                exports[name]={'path':str(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
            binding={'source_sha':'a'*40,'plan_sha256':'b'*64,'bucket':BUCKET,'oslogin_uid':12345,'oslogin_username':'sa_synthetic'}
            report={'status':'LOCAL_CUSTODY_PENDING','source_sha':binding['source_sha'],'plan_sha256':binding['plan_sha256'],'exports':exports}
            runner=SimpleNamespace(runs=runs,report=mock.Mock(return_value=report))
            stack.enter_context(mock.patch.object(r,'controller_update_locks',return_value=contextlib.nullcontext()))
            stack.enter_context(mock.patch.object(r,'read_gcp_binding',return_value=binding))
            stack.enter_context(mock.patch.object(r,'verify_trigger_journal',return_value={'binding':binding,'context':{'run_id':RUN}}))
            stack.enter_context(mock.patch.dict(os.environ,{'SUDO_UID':'12345'}))
            stack.enter_context(mock.patch.object(r.pwd,'getpwuid',return_value=SimpleNamespace(pw_name='sa_synthetic')))
            stack.enter_context(mock.patch.object(r,'file_reference',side_effect=lambda path,**kw:exports[path.name]))
            upload=stack.enter_context(mock.patch.object(r,'stream_resumable',return_value=EXPECTED|{'generation':'7'}))
            yield runner,binding,report,directory,upload

    def test_single_durable_intent_omits_capability_and_unknown_is_not_replayed(self):
        with self.fixture() as (runner,binding,report,directory,upload):
            def fail(*args,**kwargs):
                intent=directory/('upload-'+NAME+'.intent.json');self.assertTrue(intent.exists())
                self.assertNotIn(CAPABILITY,intent.read_text());raise RuntimeError('B02_UPLOAD_UNKNOWN_PRESERVE')
            upload.side_effect=fail;request={'name':NAME,'session_uri':uri(),'timeout_seconds':20}
            with self.assertRaisesRegex(RuntimeError,'UNKNOWN_PRESERVE'):r.gcp_upload_object(runner,RUN,request)
            with self.assertRaises(FileExistsError):r.gcp_upload_object(runner,RUN,request)
            self.assertEqual(upload.call_count,1);self.assertFalse((directory/('upload-'+NAME+'.result.json')).exists())

    def test_success_uses_bounded_budget_and_rejects_invalid_deadline_before_intent(self):
        with self.fixture() as (runner,binding,report,directory,upload):
            for seconds in (0,-1,901,True,1.5):
                with self.subTest(seconds=seconds),self.assertRaisesRegex(RuntimeError,'REQUEST_INVALID'):
                    r.gcp_upload_object(runner,RUN,{'name':NAME,'session_uri':uri(),'timeout_seconds':seconds})
            upload.assert_not_called()
            result=r.gcp_upload_object(runner,RUN,{'name':NAME,'session_uri':uri(),'timeout_seconds':7})
            self.assertEqual(upload.call_args.kwargs,{'timeout':7});self.assertEqual(result['status'],'B02_CIPHERTEXT_OBJECT_UPLOADED')
            for file in directory.glob('upload-*.json'):
                self.assertNotIn(CAPABILITY,file.read_text());self.assertNotIn(TOKEN,file.read_text())

    def test_arbitrary_paths_identity_and_nonpending_run_block_before_upload(self):
        for variant in ('name','extra_path','caller','profile','source_path','symlink','status'):
            with self.subTest(variant=variant),self.fixture() as (runner,binding,report,directory,upload):
                request={'name':NAME,'session_uri':uri(),'timeout_seconds':20}
                if variant=='name':request['name']='../../minimum.key'
                elif variant=='extra_path':request['path']='/arbitrary'
                elif variant=='caller':os.environ['SUDO_UID']='999'
                elif variant=='profile':binding['oslogin_username']='other'
                elif variant=='source_path':report['exports'][NAME]['path']=str(directory.parent/NAME)
                elif variant=='symlink':
                    link=directory/'alias';link.symlink_to(directory/NAME);report['exports'][NAME]['path']=str(link)
                else:report['status']='RUNNING'
                with self.assertRaises(RuntimeError):r.gcp_upload_object(runner,RUN,request)
                upload.assert_not_called();self.assertFalse((directory/('upload-'+NAME+'.intent.json')).exists())

if __name__=='__main__':unittest.main()
