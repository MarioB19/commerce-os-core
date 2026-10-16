"""Fixed private publisher identity, credential and observation readers.

The write credential is acquired explicitly from the original connection using
accessReadWriteToken, never from a source read token. It remains in RAM and its
existence does not prove GitHub Deployment write permission. Only a verified
native POST and subsequent GET can prove the requested publication.
"""
from datetime import datetime,timedelta,timezone
import json
from pathlib import Path
import re
import shlex
import time
import urllib.error
import urllib.request
import uuid

from ci_provider_evidence import PROJECT,REPOSITORY
from ci_release import require,digest
from cloudbuild_connected_source import CONNECTION,CONNECTED_REPOSITORY,INSTALLATION_ID,REPOSITORY_ID,REMOTE,timestamp
from cloudbuild_native_install import ACCOUNT,INSTANCE,INSTANCE_ID,ZONE,validate_admitted
from cloudbuild_native_reader import NoRedirect,decode
from ephemeral_os_login import remove_ephemeral_key

GOOGLE='https://cloudbuild.googleapis.com/v2/'
GITHUB='https://api.github.com/repos/'+REPOSITORY
METADATA='http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/'
COMPUTE='https://compute.googleapis.com/compute/v1/projects/'+PROJECT+'/zones/'+ZONE+'/instances/'+INSTANCE
PUBLIC={'https://commerce-os.inovaris.online/api/version','https://ciclo.inovaris.online/api/version'}


class Reader:
    def __init__(self,*,opener=None,clock=time.monotonic):
        self.opener=opener or urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        self.clock=clock

    def request(self,url,*,token=None,method='GET',body=None,metadata=False,maximum=1024*1024):
        allowed={GOOGLE+CONNECTION,GOOGLE+CONNECTED_REPOSITORY,GOOGLE+CONNECTED_REPOSITORY+':accessReadWriteToken',
            GITHUB,GITHUB+'/git/ref/heads/main',GITHUB+'/actions/permissions',
            GITHUB+'/actions/variables/COMMERCE_DEPLOY_PAUSED',COMPUTE,*PUBLIC,METADATA+'email',METADATA+'token'}
        require(url in allowed,'PUBLISHER_READER_ENDPOINT_REJECTED')
        require(method==('POST'if url.endswith(':accessReadWriteToken')else 'GET') and
                ((method=='POST'and body==b'{}')or(method=='GET'and body is None)),'PUBLISHER_READER_METHOD_REJECTED')
        require(metadata==url.startswith(METADATA),'PUBLISHER_READER_AUTH_SCOPE_CHANGED')
        headers={'Accept-Encoding':'identity','Accept':'application/json'}
        if metadata:headers['Metadata-Flavor']='Google';require(token is None,'PUBLISHER_METADATA_BEARER_FORBIDDEN')
        elif url not in PUBLIC:
            require(type(token)is str and token and not any(c.isspace()for c in token),'PUBLISHER_READER_TOKEN_UNAVAILABLE')
            headers['Authorization']='Bearer '+token
        else:
            require(token is None,'PUBLISHER_PUBLIC_BEARER_FORBIDDEN');headers['Cache-Control']='no-cache'
        if url.startswith(GITHUB):headers.update({'X-GitHub-Api-Version':'2022-11-28','User-Agent':'Commerce-OS-private-publisher'})
        if body is not None:headers['Content-Type']='application/json'
        request=urllib.request.Request(url,method=method,data=body,headers=headers)
        raw=bytearray();expires=self.clock()+30
        try:
            with self.opener.open(request,timeout=3 if metadata else 15)as response:
                require(response.status==200 and response.headers.get('Content-Encoding','identity')=='identity'
                        and not response.headers.get('Link'),'PUBLISHER_READER_RESPONSE_UNCONFIRMED')
                if metadata:require(response.headers.get('Metadata-Flavor')=='Google','PUBLISHER_METADATA_UNCONFIRMED')
                while True:
                    require(self.clock()<expires,'PUBLISHER_READER_DEADLINE')
                    chunk=response.read1(min(65536,maximum-len(raw)+1))
                    require(self.clock()<expires,'PUBLISHER_READER_DEADLINE')
                    if not chunk:break
                    raw.extend(chunk);require(len(raw)<=maximum,'PUBLISHER_READER_SIZE_BOUND')
        except urllib.error.HTTPError as error:
            status=error.code;error.close();raise RuntimeError('PUBLISHER_READER_HTTP_'+str(status)) from None
        except (OSError,ValueError):raise RuntimeError('PUBLISHER_READER_OUTCOME_UNKNOWN') from None
        return bytes(raw)


class PublisherIdentity:
    def __init__(self,*,reader=None):self.reader=reader or Reader()
    def email(self):
        value=self.reader.request(METADATA+'email',metadata=True,maximum=16384).decode().strip()
        require(value==ACCOUNT,'PUBLISHER_WORKLOAD_IDENTITY_CHANGED');return value
    def token(self):
        self.email();value=decode(self.reader.request(METADATA+'token',metadata=True,maximum=16384))
        require(set(value)=={'access_token','expires_in','token_type'}and value['token_type']=='Bearer'
                and type(value['expires_in'])is int and value['expires_in']>=120
                and type(value['access_token'])is str and value['access_token']
                and not any(c.isspace()for c in value['access_token']),'PUBLISHER_WORKLOAD_TOKEN_INVALID')
        return value['access_token']
    def instance(self):
        value=decode(self.reader.request(COMPUTE,token=self.token()))
        require(value.get('name')==INSTANCE and str(value.get('id'))==INSTANCE_ID
                and value.get('zone')=='https://www.googleapis.com/compute/v1/projects/'+PROJECT+'/zones/'+ZONE,
                'PUBLISHER_VM_IDENTITY_CHANGED')
        return value


def repository(value):
    require(type(value)is dict and type(value.get('id'))is int and value['id']==REPOSITORY_ID
            and value.get('full_name')==REPOSITORY and value.get('private')is False
            and value.get('archived')is False and value.get('disabled',False)is False,
            'PUBLISHER_ORIGINAL_REPOSITORY_REQUIRED')


class PublisherCredential:
    def __init__(self,google_token_provider,*,reader=None,now=lambda:datetime.now(timezone.utc)):
        self.google_token_provider=google_token_provider;self.reader=reader or Reader();self.now=now
        self._attempted=False;self._token=None;self._expires=None
    def acquire(self):
        require(not self._attempted,'PUBLISHER_CREDENTIAL_ACQUISITION_ALREADY_ATTEMPTED');self._attempted=True
        token=self.google_token_provider()
        connection=decode(self.reader.request(GOOGLE+CONNECTION,token=token))
        require(connection.get('name')==CONNECTION and not connection.get('disabled',False)
                and not connection.get('reconciling',False)
                and connection.get('installationState',{}).get('stage')=='COMPLETE'
                and connection.get('githubConfig',{}).get('appInstallationId')==INSTALLATION_ID,
                'PUBLISHER_ORIGINAL_CONNECTION_REQUIRED')
        connected=decode(self.reader.request(GOOGLE+CONNECTED_REPOSITORY,token=token))
        require(connected.get('name')==CONNECTED_REPOSITORY and connected.get('remoteUri')==REMOTE,
                'PUBLISHER_CONNECTED_REPOSITORY_CHANGED')
        credential=decode(self.reader.request(GOOGLE+CONNECTED_REPOSITORY+':accessReadWriteToken',
            token=token,method='POST',body=b'{}'))
        require(set(credential)=={'token','expirationTime'},'PUBLISHER_CREDENTIAL_FIELDS_INVALID')
        raw=credential['token'];expires=timestamp(credential['expirationTime'])
        require(type(raw)is str and raw and not any(c.isspace()for c in raw)
                and self.now()+timedelta(minutes=16)<=expires<=self.now()+timedelta(hours=24),
                'PUBLISHER_CREDENTIAL_TTL_INVALID')
        repository(decode(self.reader.request(GITHUB,token=raw)))
        self._token=raw;self._expires=expires
        return {'requested_capability':'connected-repository-read-write','repository_id':REPOSITORY_ID,
                'expires_at':expires.isoformat(),'deployment_write_proven':False}
    def credential(self,*,remaining_seconds=120):
        require(type(remaining_seconds)is int and 0<remaining_seconds<=900 and self._token is not None
                and self.now()+timedelta(seconds=remaining_seconds)<self._expires,
                'PUBLISHER_CREDENTIAL_EXPIRED')
        return self._token


class PublisherControls:
    def __init__(self,credential_provider,*,reader=None):
        self.credential_provider=credential_provider;self.reader=reader or Reader()
    def _read(self,path):return decode(self.reader.request(GITHUB+path,token=self.credential_provider()))
    def _repository(self):repository(self._read(''))
    def main(self):
        self._repository();value=self._read('/git/ref/heads/main')
        require(value.get('ref')=='refs/heads/main'and value.get('object',{}).get('type')=='commit'
                and type(value['object'].get('sha'))is str and re.fullmatch('[a-f0-9]{40}',value['object']['sha']),
                'PUBLISHER_MAIN_IDENTITY_CHANGED')
        return value['object']['sha']
    def controls(self):
        self._repository();paused=self._read('/actions/variables/COMMERCE_DEPLOY_PAUSED')
        actions=self._read('/actions/permissions')
        require(paused.get('name')=='COMMERCE_DEPLOY_PAUSED'and paused.get('value')in{'true','false'}
                and type(actions.get('enabled'))is bool,'PUBLISHER_CONTROLS_INVALID')
        return {'deploy_paused':paused['value']=='true','github_actions_enabled':actions['enabled']}


def https_read(url,*,reader=None):
    require(url in PUBLIC,'PUBLISHER_HTTPS_ENDPOINT_REJECTED')
    return decode((reader or Reader()).request(url,maximum=65536))


class NativeRootReadback:
    """Run the same pinned canonical collector via the bounded IAP adapter."""
    def __init__(self,transport,collector_sha256):
        self.transport=transport
        source=Path(__file__).with_name('cloudbuild-installed-readback.py')
        require(type(collector_sha256)is str and re.fullmatch('[a-f0-9]{64}',collector_sha256)
                and digest(source)==collector_sha256,'PUBLISHER_ROOT_COLLECTOR_CHANGED')
        self.source=source.read_text()
    def __call__(self,run_id):
        t=self.transport;t.remaining();t.observed_identity()
        admitted=validate_admitted(t.admission_reader())
        require(run_id==admitted['installation_run_id'] and (t.admitted is None or admitted==t.admitted),
                'PUBLISHER_ROOT_ADMISSION_CHANGED')
        t.admitted=admitted
        key=t.private/('readback-'+str(uuid.uuid4()));attempted=False
        try:
            t.run(['ssh-keygen','-q','-t','ed25519','-N','','-C','commerce-release-readback','-f',str(key)])
            command='sudo /usr/bin/python3 -c '+shlex.quote(self.source)+' '+shlex.quote(run_id)
            attempted=True
            result=t.run(['gcloud','compute','ssh',INSTANCE,'--project='+PROJECT,'--zone='+ZONE,
                '--account='+ACCOUNT,'--tunnel-through-iap','--quiet','--ssh-key-file='+str(key),
                '--ssh-key-expire-after=5m','--command='+command],capture=True)
            value=decode(result.stdout.encode())
            require(value.get('custody')=='ROOT_NATIVE_READBACK','PUBLISHER_ROOT_CUSTODY_REQUIRED')
            return value
        finally:
            # Readback imports only its own temporary public key; failures still
            # revoke that exact key and never touch another runner's resources.
            t.begin_cleanup()
            try:
                if attempted:remove_ephemeral_key(key.with_suffix('.pub').read_text(),lambda argv:t.run(argv,check=False,capture=True))
            finally:key.unlink(missing_ok=True);key.with_suffix('.pub').unlink(missing_ok=True)
