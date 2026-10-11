"""Trusted Deployment writer with durable single-dispatch callbacks.

No installer or cloud resources are created here. The caller supplies native
FULL/package/archive, canonical Root/IAP and HTTPS readers from its trusted
image. GitHub uses a separate write-authorized credential, never a source App
read token. Success publication requires authenticated Root and HTTPS readback.

journal.commit_intent(action, payload) must perform CAS + exact readback and
return {effect: CREATE_ONCE, intent_sha256, fencing_generation, attempt_id} only
for the first dispatch. A replay returns effect=None. record_result never
authorizes another dispatch. UNKNOWN reservations/intents are not refunded.
"""
import hashlib
import json
import re
import urllib.error
import urllib.request

from ci_release import require
from ci_provider_evidence import REPOSITORY, installation_enabled
from cloudbuild_native_reader import NoRedirect
import cloudbuild_release_evidence as evidence

REPOSITORY_ID=1414365450
API='https://api.github.com/repos/'+REPOSITORY
MAX_RESPONSE=1024**2


def encoded(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()


class GitHubDeploymentAPI:
    def __init__(self,token_provider,*,opener=None):
        self.token_provider=token_provider
        self.opener=opener or urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())

    def request(self,method,path,body=None):
        reads={'','/git/ref/heads/main','/deployments?environment=production&per_page=100'}
        allowed=(method=='GET' and (path in reads or re.fullmatch(r'/deployments/[1-9][0-9]*(?:/statuses\?per_page=100)?',path)))
        allowed=allowed or(method=='POST' and (path=='/deployments' or re.fullmatch(r'/deployments/[1-9][0-9]*/statuses',path)))
        require(allowed and (body is None)==(method=='GET'),'GITHUB_PUBLICATION_ENDPOINT_REJECTED')
        try:token=self.token_provider()
        except Exception:raise RuntimeError('GITHUB_PUBLICATION_TOKEN_UNAVAILABLE') from None
        require(type(token)is str and token and not any(c.isspace()for c in token),'GITHUB_PUBLICATION_TOKEN_UNAVAILABLE')
        request=urllib.request.Request(API+path,method=method,data=None if body is None else encoded(body),headers={
            'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',
            'Content-Type':'application/json','Accept-Encoding':'identity'})
        try:
            with self.opener.open(request,timeout=20)as response:
                require(response.status==(201 if method=='POST'else 200) and
                        response.headers.get('Content-Encoding','identity')=='identity' and
                        not response.headers.get('Link'),'GITHUB_PUBLICATION_RESPONSE_UNCONFIRMED')
                raw=response.read(MAX_RESPONSE+1)
        except urllib.error.HTTPError as error:
            error.close();raise RuntimeError('GITHUB_PUBLICATION_HTTP_ERROR') from None
        except (OSError,ValueError):raise RuntimeError('GITHUB_PUBLICATION_OUTCOME_UNKNOWN') from None
        # Shared duplicate-field, finite-number and byte-bound parser accepts
        # both native GitHub objects and lists; no provider text is relayed.
        return evidence.parse(raw)


class NativePublisher:
    def __init__(self,admission_reader,root_reader,https_reader,github,journal):
        self.admission_reader=admission_reader;self.root_reader=root_reader
        self.https_reader=https_reader;self.github=github;self.journal=journal

    def prepared(self):
        admitted=self.admission_reader()
        context=admitted['context'];installation_enabled(context)
        require(context['package_origin']=='cloud-build','NATIVE_PUBLISHER_PACKAGE_REQUIRED')
        repository=self.github.request('GET','')
        require(repository.get('id')==REPOSITORY_ID and repository.get('full_name')==REPOSITORY and
                repository.get('private')is False and repository.get('archived')is False,'PUBLIC_PUBLISHER_REPOSITORY_CHANGED')
        head=self.github.request('GET','/git/ref/heads/main')
        require(head.get('ref')=='refs/heads/main' and head.get('object',{}).get('type')=='commit' and
                head['object'].get('sha')==context['source_sha'],'PUBLICATION_MAIN_SUPERSEDED')
        root=self.root_reader(admitted['installation_run_id'])
        core=self.https_reader(evidence.ORIGIN+'/api/version')
        portal=self.https_reader('https://ciclo.inovaris.online/api/version')
        payload=evidence.deployment_payload(admitted,root,core,portal)
        require(self.admission_reader()==admitted,'PUBLICATION_ADMISSION_CHANGED_DURING_READBACK')
        return admitted,payload

    def dispatch(self,action,path,body):
        payload={'method':'POST','path':path,'body':body}
        intent=self.journal.commit_intent(action,payload)
        require(type(intent)is dict and intent.get('effect')=='CREATE_ONCE' and
                intent.get('intent_sha256')==hashlib.sha256(encoded(payload)).hexdigest() and
                type(intent.get('fencing_generation'))is str and re.fullmatch('[1-9][0-9]*',intent['fencing_generation']) and
                type(intent.get('attempt_id'))is str and intent['attempt_id'],'PUBLICATION_INTENT_NOT_NEW_RECONCILE_ONLY')
        try:
            result=self.github.request('POST',path,body)
            require(type(result)is dict and type(result.get('id'))is int and result['id']>0,'PUBLICATION_NATIVE_ID_REQUIRED')
            self.journal.record_result(action,{'status':'RESPONSE_RECEIVED','intent_sha256':intent['intent_sha256'],
                'native_id':result['id'],'response_sha256':hashlib.sha256(encoded(result)).hexdigest()})
        except Exception:
            # A failed result-write is also uncertain. Never turn it into a
            # second external mutation; a future run performs only readback.
            try:self.journal.record_result(action,{'status':'UNKNOWN','intent_sha256':intent['intent_sha256']})
            except Exception:pass
            raise RuntimeError('PUBLICATION_OUTCOME_UNKNOWN_RECONCILE_ONLY') from None
        return result

    def reconcile_or_publish(self):
        admitted,payload=self.prepared();context=admitted['context'];run=admitted['installation_run_id']
        rows=self.github.request('GET','/deployments?environment=production&per_page=100')
        require(type(rows)is list and len(rows)<100,'GITHUB_DEPLOYMENT_INVENTORY_INCOMPLETE')
        matches=[v for v in rows if type(v)is dict and type(v.get('payload'))is dict and v['payload'].get('installation_run_id')==run]
        require(len(matches)<=1,'GITHUB_DEPLOYMENT_IDENTITY_AMBIGUOUS')
        if matches:
            deployment=matches[0]
            require(type(deployment.get('id'))is int and deployment['id']>0 and
                    deployment.get('sha')==context['source_sha'] and deployment.get('payload')==payload,
                    'GITHUB_DEPLOYMENT_CONFLICT')
        else:
            body={'ref':context['source_sha'],'task':'deploy','auto_merge':False,'required_contexts':[],
                'environment':'production','description':'Native Cloud Build and canonical Root installation verified',
                'transient_environment':False,'production_environment':True,'payload':payload}
            deployment=self.dispatch('deployment:'+run,'/deployments',body)
        endpoint='/deployments/'+str(deployment['id'])
        actual=self.github.request('GET',endpoint)
        require(actual.get('id')==deployment['id'] and actual.get('sha')==context['source_sha'] and
                actual.get('payload')==payload,'GITHUB_DEPLOYMENT_READBACK_MISMATCH')
        statuses=self.github.request('GET',endpoint+'/statuses?per_page=100')
        require(type(statuses)is list and len(statuses)<100,'GITHUB_STATUS_INVENTORY_INCOMPLETE')
        if statuses:
            require(evidence.software_installation(actual,statuses[0],payload,context),'GITHUB_LATEST_STATUS_CONFLICT')
            return {'status':'NATIVE_DEPLOYMENT_RECONCILED','deployment_id':actual['id'],'installation_run_id':run}
        # A partial deployment can progress to its distinct status action only
        # after a second full native/custody read. A lost status response cannot
        # issue another status: its durable action has no CREATE_ONCE effect.
        require(self.prepared()==(admitted,payload),'PUBLICATION_READBACK_CHANGED')
        body={'state':'success','environment_url':evidence.ORIGIN,'log_url':evidence.build_url(context),
              'description':'Canonical Root and HTTPS readback verified','auto_inactive':False}
        created=self.dispatch('deployment-status:'+run,endpoint+'/statuses',body)
        statuses=self.github.request('GET',endpoint+'/statuses?per_page=100')
        require(type(statuses)is list and 0<len(statuses)<100 and statuses[0].get('id')==created['id'] and
                evidence.software_installation(actual,statuses[0],payload,context),'GITHUB_STATUS_READBACK_MISMATCH')
        return {'status':'NATIVE_DEPLOYMENT_PUBLISHED','deployment_id':actual['id'],'installation_run_id':run}
