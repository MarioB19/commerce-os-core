"""Fixed inline native triggers; generation is not admission or execution.

BuildTrigger and RepositoryEventConfig fields follow the Cloud Build v1 REST
reference. The provider's GitHub check name is observed separately and sealed.
"""
from copy import deepcopy
from cloudbuild_attestation import template, SERVICE_ACCOUNT
from cloudbuild_connected_source import CONNECTED_REPOSITORY
from cloudbuild_full_evidence import PROJECT, need, canonical_hash
from cloudbuild_controller import REGION

NAMES={'pull_request':'commerce-v7-attestation-pr','main':'commerce-v7-attestation-main'}


def trigger(kind, image):
    need(kind in NAMES,'TRIGGER_EVENT_REJECTED')
    event={'repository':CONNECTED_REPOSITORY}
    if kind=='pull_request':
        event['pullRequest']={'branch':'^main$','commentControl':'COMMENTS_ENABLED_FOR_EXTERNAL_CONTRIBUTORS_ONLY'}
    else:event['push']={'branch':'^main$'}
    return {'name':NAMES[kind], 'description':'Commerce V7 native FULL attestation; protected approval required',
        'repositoryEventConfig':event,'serviceAccount':SERVICE_ACCOUNT,
        'approvalConfig':{'approvalRequired':True}, 'includeBuildLogs':'INCLUDE_BUILD_LOGS_UNSPECIFIED',
        'build':template(image)}


def profile(image):
    rows={kind:trigger(kind,image)for kind in NAMES}
    return {'schema_version':1,'project':PROJECT,'region':REGION,'repository':CONNECTED_REPOSITORY,
        'triggers':rows,'trigger_hashes':{k:canonical_hash(v)for k,v in rows.items()},
        'execution_admitted':False,'automatic_approval':False,'github_check_name_observed':False,
        'maximum_approved_execution_seconds_each':120,'pending_exec_seconds':0}


def validate_readback(value, expected):
    need(type(value)is dict and type(expected)is dict,'TRIGGER_READBACK_REQUIRED')
    native=deepcopy(value)
    for key in ('id','resourceName','createTime'):native.pop(key,None)
    # Proto3 may serialize false/default empty fields; they may not add behavior.
    for key,default in {'disabled':False,'substitutions':{},'ignoredFiles':[], 'includedFiles':[],'tags':[]}.items():
        if key in native:
            need(type(native[key])is type(default) and native[key]==default,'TRIGGER_EXTRA_BEHAVIOR')
            del native[key]
    # Native Trigger readback omits these two proto3 defaults; runtime Build
    # validation independently normalizes options via OPTION_DEFAULTS.
    native.setdefault('includeBuildLogs','INCLUDE_BUILD_LOGS_UNSPECIFIED')
    options=native.get('build',{}).get('options',{})
    if 'automapSubstitutions' in options:
        need(type(options['automapSubstitutions']) is bool,'TRIGGER_EXTRA_BEHAVIOR')
    options.setdefault('automapSubstitutions',False)
    repo=native.get('repositoryEventConfig',{})
    if 'repositoryType'in repo:
        need(repo.pop('repositoryType')=='GITHUB','TRIGGER_VENDOR_CHANGED')
    need(native==expected,'TRIGGER_NATIVE_CONFIG_CHANGED')
    return True
