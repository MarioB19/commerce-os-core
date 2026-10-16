"""Current public GitHub event/check reads for the trusted CI control plane.

Uses only the existing connected repository's GitHub read token; never ADC,
personal CLI state, write tokens, or candidate-provided URLs. App read-token
permissions for pulls/checks must be verified natively before activation.
"""
import re
import urllib.error
import urllib.parse
import urllib.request
import cloudbuild_admission as ledger
from cloudbuild_attestation import ATTESTATION, validate_app_check, validate_check_name, check_urls, validate_native_gate
from cloudbuild_connected_source import ConnectedSourceReader, REPOSITORY_ID
from cloudbuild_full_evidence import REPOSITORY, EvidenceError, need, canonical_hash
from cloudbuild_native_reader import MAX_RESPONSE, NoRedirect, decode

ROOT='https://api.github.com/repos/'+REPOSITORY


def validate_event(event):
    need(type(event) is dict and event.get('kind') in {'main','pull_request'},'GITHUB_EVENT_KIND_INVALID')
    keys={'kind','repository_id','source_sha','source_tree','base_sha'}
    if event['kind']=='pull_request':keys.add('pull_request')
    need(set(event)==keys and type(event['repository_id']) is int and event['repository_id']==REPOSITORY_ID,
         'GITHUB_EVENT_PUBLIC_PROFILE_REQUIRED')
    for key in ('source_sha','source_tree','base_sha'):ledger.digest(event[key],size=40)
    if event['kind']=='pull_request':
        need(type(event['pull_request']) is int and 0<event['pull_request']<=9999999,'GITHUB_PULL_REQUEST_INVALID')
    else:need(event['base_sha']==event['source_sha'],'GITHUB_MAIN_SOURCE_BINDING_INVALID')


class GitHubControlReader:
    def __init__(self,source_reader,*,opener=None):
        need(isinstance(source_reader,ConnectedSourceReader),'GITHUB_CONNECTED_READER_REQUIRED')
        self.source_reader=source_reader
        self.opener=opener or urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())

    def _read(self,path):
        checks=False
        if re.fullmatch(r'/commits/[a-f0-9]{40}/check-runs\?[^#]+',path):
            query=urllib.parse.parse_qs(urllib.parse.urlsplit(path).query,strict_parsing=True)
            checks=(set(query) in ({'filter','per_page'},{'check_name','filter','per_page'})
                    and query.get('filter')==['latest'] and query.get('per_page')==['100'])
            if 'check_name' in query:
                checks=checks and len(query['check_name'])==1
                if checks:validate_check_name(query['check_name'][0])
        need(path in {'','/git/ref/heads/main'} or re.fullmatch(r'/pulls/[1-9][0-9]{0,6}',path) or checks,
             'GITHUB_CONTROL_READ_ENDPOINT_REJECTED')
        token=self.source_reader.credential(remaining_seconds=120)
        request=urllib.request.Request(ROOT+path,headers={'Authorization':'Bearer '+token,
            'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',
            'User-Agent':'Commerce-OS-native-controller','Accept-Encoding':'identity'})
        try:
            with self.opener.open(request,timeout=20) as response:
                need(response.status==200 and response.headers.get('Content-Encoding','identity')=='identity',
                     'GITHUB_CONTROL_READ_UNCONFIRMED')
                need(not response.headers.get('Link'),'GITHUB_CONTROL_READ_PAGINATED')
                raw=response.read(MAX_RESPONSE+1)
        except urllib.error.HTTPError as error:
            status=error.code;error.close()
            raise EvidenceError('GITHUB_CONTROL_READ_HTTP_'+str(status)) from None
        except (OSError,ValueError):raise EvidenceError('GITHUB_CONTROL_READ_UNCERTAIN') from None
        return decode(raw)

    def repository(self):
        value=self._read('')
        need(type(value.get('id')) is int and value['id']==REPOSITORY_ID and value.get('full_name')==REPOSITORY
             and value.get('private') is False and value.get('archived') is False and value.get('disabled',False) is False,
             'GITHUB_CONTROL_REPOSITORY_CHANGED')
        return value

    def current_event(self,event):
        validate_event(event);self.repository()
        main=self._read('/git/ref/heads/main')
        need(main.get('ref')=='refs/heads/main' and main.get('object',{}).get('type')=='commit'
             and main['object'].get('sha')==event['base_sha'],'GITHUB_MAIN_OR_BASE_SUPERSEDED')
        pull=None
        if event['kind']=='pull_request':
            pull=self._read('/pulls/'+str(event['pull_request']))
            need(type(pull.get('number')) is int and pull['number']==event['pull_request'] and pull.get('state')=='open'
                 and pull.get('merged') is False and pull.get('base',{}).get('ref')=='main'
                 and pull['base'].get('sha')==event['base_sha']
                 and pull.get('head',{}).get('sha')==event['source_sha']
                 and pull['base'].get('repo',{}).get('id')==REPOSITORY_ID
                 and pull['head'].get('repo',{}).get('id')==REPOSITORY_ID,
                 'GITHUB_PULL_REQUEST_HEAD_OR_BASE_CHANGED')
        commit=self.source_reader.commit(REPOSITORY,event['source_sha'])
        need(commit['tree']['sha']==event['source_tree'],'GITHUB_EVENT_TREE_CHANGED')
        return {'event_sha256':canonical_hash({'event':event,'main':main,'pull':pull,'commit':commit}),
                'source_sha':event['source_sha'],'source_tree':event['source_tree']}

    def check(self,contract,project_number):
        self.repository();ledger.digest(contract['source_sha'],size=40);validate_check_name(contract['github_check_name'])
        path='/commits/'+contract['source_sha']+'/check-runs?'+urllib.parse.urlencode({
            'check_name':contract['github_check_name'],'filter':'latest','per_page':100})
        value=self._read(path)
        need(type(value.get('total_count')) is int and type(value.get('check_runs')) is list
             and 0<=value['total_count']<100 and len(value['check_runs'])==value['total_count'],
             'GITHUB_CHECK_INVENTORY_INCOMPLETE')
        matches=[row for row in value['check_runs'] if type(row) is dict and row.get('name')==contract['github_check_name']
                 and row.get('app',{}).get('id')==10529]
        need(len(matches)==1,'GITHUB_ONE_LATEST_CLOUD_BUILD_CHECK_REQUIRED')
        validate_app_check(matches[0],contract,project_number)
        return matches[0]

    def discover_pending_check(self, contract, native_pending, project_number):
        need(type(contract)is dict and 'github_check_name'not in contract,'GITHUB_PENDING_CHECK_ALREADY_NAMED')
        self.repository();ledger.digest(contract['source_sha'],size=40)
        urls=check_urls(contract['build_id'],project_number)
        value=self._read('/commits/'+contract['source_sha']+'/check-runs?filter=latest&per_page=100')
        need(type(value.get('total_count'))is int and type(value.get('check_runs'))is list
             and 0<=value['total_count']<100 and len(value['check_runs'])==value['total_count'],
             'GITHUB_CHECK_INVENTORY_INCOMPLETE')
        matches=[row for row in value['check_runs']if type(row)is dict
                 and row.get('app',{}).get('id')==10529 and row.get('head_sha')==contract['source_sha']
                 and row.get('details_url')in urls]
        need(len(matches)==1,'GITHUB_ONE_PENDING_NATIVE_CHECK_REQUIRED')
        check=matches[0];validate_check_name(check.get('name'))
        need(type(check.get('id'))is int and check['id']>0 and check.get('status')in {'queued','in_progress'}
             and check.get('conclusion')is None,'GITHUB_NATIVE_CHECK_NOT_PENDING')
        sealed={**contract,'github_check_name':check['name']}
        validate_native_gate(sealed,native_pending,project_number,require_pending=True)
        return {'contract':sealed,'check':check,'native_pending_sha256':canonical_hash(native_pending)}
