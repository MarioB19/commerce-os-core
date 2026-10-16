"""Preserve authenticated provider response bytes for canonical Root boot custody.

Invoked only by the immutable publisher image. The readers retain their exact
URLs, separate ADC/GitHub credentials, response validators and bounds. Capture
never saves request headers or responses from token/secret endpoints.
"""
from contextlib import contextmanager
from datetime import timedelta
import json
import re
from urllib.parse import urlsplit,parse_qs,unquote

from ci_release import require
from cloudbuild_full_evidence import PROJECT,REPOSITORY,log_filter
from cloudbuild_native_reader import PROJECT_URL,BUILD_ROOT,LOG_URL,decode
from cloudbuild_connected_source import GITHUB_ROOT
from cloudbuild_protected_storage import validate_descriptor
import cloudbuild_release_evidence as release

MAX_CAPTURE = 8*1024*1024
MAX_RESPONSE = 4*1024*1024
BOOT_TRANSFER_RESERVATION = 58*1024*1024


def validate_config(value):
    require(type(value)is dict and set(value)=={'restore_source_sha','restore_bundle'},'BOOT_CAPTURE_CONFIG_FIELDS')
    require(type(value['restore_source_sha'])is str and re.fullmatch('[a-f0-9]{40}',value['restore_source_sha']), 'BOOT_CAPTURE_RESTORE_SHA')
    validate_descriptor(value['restore_bundle'])
    require(value['restore_bundle']['size']<=4*1024*1024,'BOOT_CAPTURE_HISTORY_BOUND')
    return value


class Capture:
    def __init__(self,admission,check):
        self.admission=admission;self.ctx=release.validate_admission(admission);self.check=check
        v=admission['verification_manifest'];ctx=self.ctx
        self.urls={PROJECT_URL:'project',BUILD_ROOT+v['region']+'/builds/'+v['build_id']:'full_build',
                   GITHUB_ROOT+'/git/commits/'+v['source_sha']:'full_commit',
                   BUILD_ROOT+ctx['region']+'/builds/'+ctx['package_build_id']:'package_build'}
        self.queries={'full_logs':log_filter(v),'package_logs':
            'resource.type="build" AND resource.labels.build_id="'+ctx['package_build_id']+
            '" AND resource.labels.project_id="'+PROJECT+'" AND "'+release.PACKAGE_GATE+'"'}
        self.raw={};self.pages={k:[]for k in self.queries};self.total=0;self.manifest_url=None

    def classify(self,request):
        url=request.full_url;method=request.get_method()
        if method=='GET' and url in self.urls:return self.urls[url],None
        if method=='POST' and url==LOG_URL:
            payload=decode(request.data)
            for name,query in self.queries.items():
                if payload.get('filter')==query:
                    require(set(payload)<={'resourceNames','filter','pageSize','orderBy','pageToken'} and
                        payload.get('resourceNames')==['projects/'+PROJECT] and payload.get('pageSize')==100 and
                        payload.get('orderBy')=='timestamp asc','BOOT_CAPTURE_LOG_REQUEST')
                    previous='' if not self.pages[name] else decode(self.pages[name][-1]).get('nextPageToken','')
                    require(payload.get('pageToken','')==previous and (not self.pages[name]or previous),'BOOT_CAPTURE_LOG_PAGE_SEQUENCE')
                    return name,None
            raise RuntimeError('BOOT_CAPTURE_LOG_QUERY_CHANGED')
        if method=='GET' and url.startswith('https://storage.googleapis.com/storage/v1/b/'):
            query=parse_qs(urlsplit(url).query,strict_parsing=True)
            if query.get('alt')==['media']:
                require(set(query)=={'generation','alt'} and len(query['generation'])==1 and
                    query['generation'][0].isdigit() and int(query['generation'][0])>0,'BOOT_CAPTURE_OBJECT_QUERY')
                name=unquote(urlsplit(url).path.split('/o/',1)[1])
                require(name.endswith('/artifacts-'+self.ctx['package_build_id']+'.json'), 'BOOT_CAPTURE_ARTIFACT_PATH')
                return 'artifact_manifest',url
            return None,None
        raise RuntimeError('BOOT_CAPTURE_UNEXPECTED_RESPONSE')

    def record(self,name,raw,url):
        self.check();require(type(raw)is bytes and 0<len(raw)<=MAX_RESPONSE,'BOOT_CAPTURE_RESPONSE_BOUND')
        self.total+=len(raw);require(self.total<=MAX_CAPTURE,'BOOT_CAPTURE_AGGREGATE_BOUND')
        if name is None:return
        if name in self.pages:
            require(len(self.pages[name])<8,'BOOT_CAPTURE_PAGE_BOUND');self.pages[name].append(raw)
        else:
            self.raw[name]=raw
            if name=='artifact_manifest':self.manifest_url=url


class Response:
    def __init__(self,response,capture,name,url):
        self.response=response;self.capture=capture;self.name=name;self.url=url;self.raw=bytearray();self.closed=False
    def __getattr__(self,name):return getattr(self.response,name)
    def __enter__(self):self.response.__enter__();return self
    def __exit__(self,*args):
        try:
            if args[0]is None:self.capture.record(self.name,bytes(self.raw),self.url)
        finally:self.closed=True;self.response.__exit__(*args)
    def _read(self,method,n):
        self.capture.check();require(type(n)is int and 0<=n<=MAX_RESPONSE+1,'BOOT_CAPTURE_UNBOUNDED_READ')
        raw=getattr(self.response,method)(n);self.raw.extend(raw)
        require(len(self.raw)<=MAX_RESPONSE,'BOOT_CAPTURE_RESPONSE_BOUND');self.capture.check();return raw
    def read(self,n=-1):return self._read('read',n)
    def read1(self,n=-1):return self._read('read1',n)


class Opener:
    def __init__(self,inner,capture):self.inner=inner;self.capture=capture
    def open(self,request,timeout):
        self.capture.check();name,url=self.capture.classify(request)
        return Response(self.inner.open(request,timeout=timeout),self.capture,name,url)


@contextmanager
def capture_readers(capture,readers):
    saved=[]
    try:
        for reader in readers:
            require(not isinstance(reader.opener,Opener),'BOOT_CAPTURE_NESTED')
            saved.append((reader,reader.opener));reader.opener=Opener(reader.opener,capture)
        yield
    finally:
        for reader,opener in reversed(saved):reader.opener=opener


def collect_boot_inputs(*,config,custody,source_reader,full_reader,package_reader,release_admission,
                        admitted,expected_package,check,now,reserve,expires_at):
    # Imports are lazy: the controller never loads or executes the Root modules.
    from runtime_boot_admission import pack_inputs,history_bytes,sealed,MAX_WIRE
    from runtime_boot_install_gate import pack_log_pages
    validate_config(config);check();created=now()
    # Reserve maximum response/raw history/wire copies before any acquisition.
    reserve(BOOT_TRANSFER_RESERVATION)
    history=custody.read_json(config['restore_bundle']);history_bytes(history)
    require(history['restore_source_sha']==config['restore_source_sha'],'BOOT_CAPTURE_HISTORY_IDENTITY')
    capture=Capture(release_admission,check)
    with capture_readers(capture,(source_reader,full_reader,package_reader)):
        verified=package_reader.evidence(release_admission)
    require(verified==expected_package and capture.manifest_url==package_reader.object_url(verified['artifact_manifest_uri'],media=True),
            'BOOT_CAPTURE_PACKAGE_READBACK_CHANGED')
    require(set(capture.raw)=={'project','full_build','full_commit','package_build','artifact_manifest'},'BOOT_CAPTURE_ORIGINALS_INCOMPLETE')
    capture.raw['admission']=sealed(release_admission)
    for name,query in capture.queries.items():capture.raw[name]=pack_log_pages(query,capture.pages[name])
    check();expiry=min(created+timedelta(minutes=15),expires_at)
    require(now()<expiry,'BOOT_CAPTURE_AUTHORIZATION_EXPIRED')
    return pack_inputs(admitted,capture.raw,history,created_at=created,expires_at=expiry)
