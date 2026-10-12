"""Native trigger attestation, separate from the bootstrap FULL contract.

The controller reserves the existing gate UUID then approves it once. The
attestor re-reads protected custody and FULL evidence; it never executes source
files or posts a GitHub status. Real trigger/App provenance is an installation
gate, not evidence supplied by these local contracts or synthetic tests.
"""
from copy import deepcopy
import json
import re
import uuid
import cloudbuild_admission as ledger
from cloudbuild_connected_source import CONNECTED_REPOSITORY, REPOSITORY_ID, REMOTE
from cloudbuild_controller import REGION, now, validate_eligibility
from cloudbuild_full_evidence import (PROJECT, OPTION_DEFAULTS, canonical_hash, need,
    normalize_step, expanded, validate_manifest)

ATTESTATION = 'Commerce V7 Cloud Build attestation'
SERVICE_ACCOUNT = 'projects/' + PROJECT + '/serviceAccounts/commerce-v7-attestor-core@' + PROJECT + '.iam.gserviceaccount.com'


def template(image):
    need(type(image) is str and re.fullmatch(r'us-east1-docker\.pkg\.dev/' + re.escape(PROJECT) +
         r'/commerce-ci-public/attestor@sha256:[a-f0-9]{64}', image), 'ATTESTOR_IMAGE_REQUIRED')
    return {'serviceAccount': SERVICE_ACCOUNT, 'timeout': '120s', 'queueTtl': '14400s',
        'options': {'logging':'CLOUD_LOGGING_ONLY', 'sourceProvenanceHash':['SHA256'],
                    'automapSubstitutions':False, 'dynamicSubstitutions':True,
                    'substitutionOption':'ALLOW_LOOSE'},
        'steps':[{'id':'Commerce-V7-native-attestation', 'name':image, 'entrypoint':'/usr/bin/python3',
            'timeout':'120s', 'args':['-I','/opt/trusted/cloudbuild-attest.py','--gate-build-id','$BUILD_ID']} ]}


def validate_contract(contract):
    ledger.exact(contract, 'build_id trigger_id repository_id source_sha source_tree image substitutions full_manifest_sha256 github_check_name',
                 'ATTESTATION_CONTRACT_FIELDS_INVALID')
    ledger.native_uuid(contract['build_id']); ledger.native_uuid(contract['trigger_id'])
    need(type(contract['repository_id']) is int and contract['repository_id'] == REPOSITORY_ID,
         'ATTESTATION_PRIVATE_PROFILE_REQUIRED')
    ledger.digest(contract['source_sha'], size=40); ledger.digest(contract['source_tree'], size=40)
    ledger.digest(contract['full_manifest_sha256']); template(contract['image'])
    validate_check_name(contract['github_check_name'])
    subs = contract['substitutions']
    need(type(subs) is dict and subs.get('COMMIT_SHA') == contract['source_sha']
         and all(type(key) is str and type(value) is str and len(value) <= 4096 for key,value in subs.items())
         and set(subs) <= {'COMMIT_SHA','REVISION_ID','SHORT_SHA','REPO_NAME','REPO_FULL_NAME','BRANCH_NAME','REF_NAME',
                          'TRIGGER_NAME','TRIGGER_BUILD_CONFIG_PATH','_HEAD_BRANCH','_BASE_BRANCH','_HEAD_REPO_URL','_PR_NUMBER'},
         'ATTESTATION_NATIVE_SUBSTITUTIONS_INVALID')
    # The authenticated GitHub trigger includes REF_NAME on both PR and main.
    # It is a branch alias here; no tag or alternate ref is admitted.
    if 'REF_NAME' in subs:
        need(subs.get('BRANCH_NAME') == subs['REF_NAME'] and bool(subs['REF_NAME']),
             'ATTESTATION_REF_BRANCH_MISMATCH')
        if '_HEAD_BRANCH' in subs:
            need(subs['_HEAD_BRANCH'] == subs['REF_NAME'], 'ATTESTATION_REF_BRANCH_MISMATCH')
    if 'REVISION_ID' in subs: need(subs['REVISION_ID'] == contract['source_sha'], 'ATTESTATION_REVISION_MISMATCH')
    if 'SHORT_SHA' in subs: need(subs['SHORT_SHA'] == contract['source_sha'][:7], 'ATTESTATION_REVISION_MISMATCH')
    if 'REPO_FULL_NAME' in subs: need(subs['REPO_FULL_NAME'] == 'MarioB19/commerce-os-core', 'ATTESTATION_REPOSITORY_MISMATCH')


def gate_binding(contract):
    validate_contract(contract)
    return {key:contract[key] for key in ('build_id','trigger_id','repository_id','source_sha','source_tree','github_check_name')} | {
        'config_sha256': canonical_hash(template(contract['image']))}


def validate_git_source(value, expected_sha):
    need(type(value) is dict and len(value) == 1, 'ATTESTATION_SOURCE_INVALID')
    if 'connectedRepository' in value:
        row = value['connectedRepository']
        need(type(row) is dict and set(row) <= {'repository','revision','dir'} and
             row.get('repository') == CONNECTED_REPOSITORY and row.get('dir','') == '' and
             row.get('revision') == expected_sha, 'ATTESTATION_SOURCE_MISMATCH')
        return 'resolvedConnectedRepository', row
    row = value.get('gitSource')
    need(type(row) is dict and set(row) <= {'url','revision','dir'} and row.get('url') == REMOTE
         and row.get('dir','') == '' and row.get('revision') == expected_sha, 'ATTESTATION_SOURCE_MISMATCH')
    return 'resolvedGitSource', row


def validate_native_gate(contract, build, project_number, *, require_pending=False):
    validate_contract(contract)
    need(re.fullmatch('[1-9][0-9]*',str(project_number)), 'ATTESTATION_PROJECT_NUMBER_INVALID')
    resources = {'projects/' + p + '/locations/' + REGION + '/builds/' + contract['build_id']
                 for p in (PROJECT, str(project_number))}
    need(type(build) is dict and build.get('id') == contract['build_id'] and build.get('name') in resources
         and build.get('projectId') == PROJECT and build.get('buildTriggerId') == contract['trigger_id'],
         'ATTESTATION_NATIVE_IDENTITY_MISMATCH')
    expected = template(contract['image'])
    for key in ('serviceAccount','timeout','queueTtl'):
        need(build.get(key) == expected[key], 'ATTESTATION_NATIVE_CONFIG_MISMATCH')
    for key in ('secrets','availableSecrets','images','artifacts','dependencies','gitConfig','logsBucket'):
        need(not build.get(key), 'ATTESTATION_UNEXPECTED_INPUT')
    options = build.get('options', {})
    need(type(options) is dict and set(options) <= set(OPTION_DEFAULTS), 'ATTESTATION_OPTIONS_INVALID')
    normalized = {key:options.get(key, value) for key,value in OPTION_DEFAULTS.items()}
    wanted = {**OPTION_DEFAULTS, **expected['options']}
    need(all(type(normalized[k]) is type(v) and normalized[k] == v for k,v in wanted.items()), 'ATTESTATION_OPTIONS_MISMATCH')
    need(build.get('substitutions') == contract['substitutions'], 'ATTESTATION_SUBSTITUTIONS_CHANGED')
    steps = build.get('steps')
    need(type(steps) is list and len(steps) == 1, 'ATTESTATION_ONE_TRUSTED_STEP_REQUIRED')
    step = normalize_step(steps[0]); wanted_step = normalize_step(expected['steps'][0])
    need(step in (wanted_step, expanded(wanted_step, {'BUILD_ID':contract['build_id']})), 'ATTESTATION_STEP_CHANGED')
    resolved_key, source_row = validate_git_source(build.get('source'), contract['source_sha'])
    approval = build.get('approval')
    need(type(approval) is dict and set(approval) <= {'state','config','result'}
         and approval.get('config') == {'approvalRequired':True}, 'ATTESTATION_APPROVAL_REQUIRED')
    state = build.get('status')
    need(state in {'PENDING','QUEUED','WORKING','SUCCESS','FAILURE','INTERNAL_ERROR','TIMEOUT','CANCELLED','EXPIRED'},
         'ATTESTATION_NATIVE_STATUS_INVALID')
    if require_pending:
        need(state == 'PENDING' and approval.get('state') == 'PENDING' and not approval.get('result')
             and not build.get('startTime'), 'ATTESTATION_ALREADY_STARTED_OR_APPROVED')
    else:
        need(approval.get('state') == 'APPROVED' and approval.get('result',{}).get('decision') == 'APPROVED',
             'ATTESTATION_NATIVE_APPROVAL_UNCONFIRMED')
    if state == 'SUCCESS':
        need(steps[0].get('status') == 'SUCCESS' and steps[0].get('exitCode',0) == 0, 'ATTESTATION_STEP_NOT_SUCCESSFUL')
        provenance = build.get('sourceProvenance',{})
        need(type(provenance) is dict and set(provenance) <= {resolved_key,'fileHashes'}
             and provenance.get(resolved_key) == source_row, 'ATTESTATION_RESOLVED_SOURCE_MISMATCH')
    return state


def full_reconciled(document, full_attempt_id, full_manifest, contract):
    ledger.validate_ledger(document); validate_manifest(full_manifest); validate_contract(contract)
    need(canonical_hash(full_manifest) == contract['full_manifest_sha256']
         and full_manifest['source_sha'] == contract['source_sha']
         and full_manifest['source_tree'] == contract['source_tree'], 'ATTESTATION_FULL_BINDING_MISMATCH')
    attempt = document['attempts'].get(full_attempt_id,{})
    need(attempt.get('state') == 'RECONCILED' and attempt.get('build_id') == full_manifest['build_id']
         and attempt.get('plan',{}).get('stage') == 'full' and attempt.get('terminal',{}).get('status') == 'SUCCESS',
         'ATTESTATION_RECONCILED_FULL_REQUIRED')


class GateController:
    def __init__(self, store, api, full_reader, eligibility_reader, *, clock=now):
        self.store=store; self.api=api; self.full_reader=full_reader
        self.eligibility_reader=eligibility_reader; self.clock=clock

    def approve(self, gate_attempt_id, full_attempt_id, full_manifest, contract):
        _generation, document = self.store.load()
        ledger.need(document is not None,'LEDGER_MISSING_NO_RESET')
        full_reconciled(document,full_attempt_id,full_manifest,contract)
        attempt = document['attempts'].get(gate_attempt_id,{})
        need(attempt.get('plan',{}).get('stage') == 'attestation', 'ATTESTATION_RESERVATION_REQUIRED')
        if 'intent' in attempt:
            need(attempt['intent'].get('gate') == gate_binding(contract), 'ATTESTATION_INTENT_CHANGED')
            return {'state':'RECONCILIATION_REQUIRED','build_id':contract['build_id']}
        need(attempt.get('state') == 'RESERVED' and document['active_attempt'] == gate_attempt_id,
             'ATTESTATION_RESERVATION_REQUIRED')
        eligibility=self.eligibility_reader(attempt,contract)
        validate_eligibility(eligibility,attempt,self.clock())
        need(self.full_reader.evaluate(full_manifest)['state'] == 'success','ATTESTATION_NATIVE_FULL_REQUIRED')
        project = self.full_reader.project(); need(project.get('projectId') == PROJECT,'ATTESTATION_PROJECT_MISMATCH')
        build = self.api.build(contract['build_id'])
        validate_native_gate(contract,build,project.get('projectNumber'),require_pending=True)
        validate_eligibility(eligibility,attempt,self.clock())
        request = {'build_id':contract['build_id'],'approvalResult':{'decision':'APPROVED'}}
        command = {'op':'approve_intent','attempt_id':gate_attempt_id,'gate':gate_binding(contract),
            'nonce':str(uuid.uuid5(uuid.UUID(gate_attempt_id),'commerce-native-approve-v1')),
            'request_sha256':ledger.canonical_hash(request)}
        transaction=ledger.transact(self.store,command,now=self.clock())
        if not transaction.effect: return {'state':'RECONCILIATION_REQUIRED','build_id':contract['build_id']}
        need(transaction.effect['type']=='APPROVE_ONCE','ATTESTATION_EFFECT_CHANGED')
        try:
            validate_eligibility(eligibility,attempt,self.clock())
            ledger.validate_approval(attempt['approval'],attempt['plan'],self.clock())
            ledger.validate_admission(attempt['admission'],self.clock(),attempt['approval'])
            self.api.approve_once(contract['build_id'])
            observed=self.api.build(contract['build_id'])
            validate_native_gate(contract,observed,project.get('projectNumber'))
            ledger.transact(self.store,{'op':'bind_gate','attempt_id':gate_attempt_id,
                'build_id':contract['build_id'],'gate':gate_binding(contract),
                'config_sha256':gate_binding(contract)['config_sha256'],
                'native_evidence_sha256':canonical_hash(observed)},now=self.clock())
        except Exception:
            ledger.transact(self.store,{'op':'unknown','attempt_id':gate_attempt_id,
                'reason':'NATIVE_APPROVE_OUTCOME_UNKNOWN','evidence_sha256':canonical_hash(request)},now=self.clock())
            return {'state':'UNKNOWN','build_id':contract['build_id']}
        return {'state':'NATIVE_APPROVAL_CONFIRMED','build_id':contract['build_id']}

    def reconcile(self, gate_attempt_id, full_attempt_id, full_manifest, contract, check_reader):
        _generation,document=self.store.load(); ledger.need(document is not None,'LEDGER_MISSING_NO_RESET')
        full_reconciled(document,full_attempt_id,full_manifest,contract)
        attempt=document['attempts'].get(gate_attempt_id,{})
        need(attempt.get('intent',{}).get('gate')==gate_binding(contract),'ATTESTATION_DURABLE_APPROVAL_REQUIRED')
        project=self.full_reader.project(); need(project.get('projectId')==PROJECT,'ATTESTATION_PROJECT_MISMATCH')
        build=self.api.build(contract['build_id'])
        if build.get('approval',{}).get('state')=='PENDING':
            validate_native_gate(contract,build,project.get('projectNumber'),require_pending=True)
            return {'state':'UNKNOWN_APPROVAL_NOT_OBSERVED','build_id':contract['build_id']}
        state=validate_native_gate(contract,build,project.get('projectNumber'))
        if 'build_id' not in attempt:
            ledger.transact(self.store,{'op':'bind_gate','attempt_id':gate_attempt_id,
                'build_id':contract['build_id'],'gate':gate_binding(contract),
                'config_sha256':gate_binding(contract)['config_sha256'],
                'native_evidence_sha256':canonical_hash(build)},now=self.clock())
        if state in {'PENDING','QUEUED','WORKING'}:
            ledger.transact(self.store,{'op':'running','attempt_id':gate_attempt_id,'build_id':contract['build_id']},now=self.clock())
            return {'state':'PENDING','build_id':contract['build_id']}
        need(type(build.get('startTime')) is str and type(build.get('finishTime')) is str,
             'ATTESTATION_NATIVE_BILLABLE_INTERVAL_REQUIRED')
        observation={'build_id':contract['build_id'],'status':state,'started_at':build['startTime'],
            'finished_at':build['finishTime'],'execution_not_started':False,'evidence_sha256':canonical_hash(build)}
        ledger.transact(self.store,{'op':'terminal','attempt_id':gate_attempt_id,'observation':observation},now=self.clock())
        receipt=None; check=None
        if state=='SUCCESS':
            need(self.full_reader.evaluate(full_manifest)['state']=='success','ATTESTATION_NATIVE_FULL_REQUIRED')
            receipt=receipt_from_logs(self.api.attestation_logs(contract['build_id']),contract,full_manifest)
            check=check_reader(contract)
            validate_app_check(check,contract,project['projectNumber'])
        proof=canonical_hash({'contract':contract,'native':build,'receipt':receipt,'check':check})
        ledger.transact(self.store,{'op':'reconcile','attempt_id':gate_attempt_id,
            'evidence_sha256':proof,'native_verified':True},now=self.clock())
        return {'state':'ATTESTATION_PASSED' if state=='SUCCESS' else 'ATTESTATION_FAILED',
            'build_id':contract['build_id'],'evidence_sha256':proof,'deployment_proven':False,
            'github_check_verified':state=='SUCCESS'}


def expected_receipt(contract, manifest):
    return {'schema_version':1,'provider':'google-cloud-build','gate_name':ATTESTATION,
        'gate_build_id':contract['build_id'],'verification_build_id':manifest['build_id'],
        'source_sha':contract['source_sha'],'source_tree':contract['source_tree'],
        'full_manifest_sha256':canonical_hash(manifest),'status':'PASSED',
        'deployment_proven':False,'github_check_published':False}


def receipt_from_logs(entries, contract, manifest):
    need(type(entries) is list and len(entries)<=800,'ATTESTATION_LOG_QUERY_BOUND')
    receipts=[]
    for entry in entries:
        need(type(entry) is dict and entry.get('resource',{}).get('type')=='build'
             and entry.get('resource',{}).get('labels',{}).get('build_id')==contract['build_id']
             and entry.get('resource',{}).get('labels',{}).get('project_id')==PROJECT,'ATTESTATION_LOG_IDENTITY_MISMATCH')
        value=entry.get('jsonPayload')
        if value is None and type(entry.get('textPayload')) is str:
            text=entry['textPayload'];prefix='Step #0 - "Commerce-V7-native-attestation": '
            if text.startswith(prefix):text=text[len(prefix):]
            if not text.startswith('{'):continue
            from cloudbuild_native_reader import decode
            value=decode(text.encode())
        if type(value) is dict and value.get('gate_name')==ATTESTATION:receipts.append(value)
    need(len(receipts)==1 and receipts[0]==expected_receipt(contract,manifest),'ATTESTATION_ONE_EXACT_RECEIPT_REQUIRED')
    return receipts[0]


def validate_check_name(value):
    need(type(value) is str and 0 < len(value.encode('utf-8')) <= 256
         and all(c.isprintable() for c in value), 'ATTESTATION_NATIVE_CHECK_NAME_INVALID')


def check_urls(build_id, project_number):
    ledger.native_uuid(build_id)
    need(re.fullmatch('[1-9][0-9]*',str(project_number)), 'ATTESTATION_PROJECT_NUMBER_INVALID')
    return {'https://console.cloud.google.com/cloud-build/builds;region='+REGION+'/'+build_id+'?project='+p
            for p in (PROJECT,str(project_number))}


def validate_app_check(check, contract, project_number):
    """Only the actual Cloud Build App check for this UUID and SHA can pass."""
    validate_check_name(contract['github_check_name'])
    urls=check_urls(contract['build_id'],project_number)
    need(type(check) is dict and type(check.get('id')) is int and check['id']>0
         and check.get('app',{}).get('id')==10529 and check.get('name')==contract['github_check_name']
         and check.get('head_sha')==contract['source_sha'] and check.get('status')=='completed'
         and check.get('conclusion')=='success' and check.get('details_url') in urls,
         'ATTESTATION_GITHUB_APP_CHECK_NOT_PROVEN')


def attest(bundle, store, api, full_reader, event_reader):
    """Entry point for the immutable attestor image after protected bundle read.

    bundle is loaded by gate UUID from private GCS custody, never /workspace.
    Native GitHub App check correlation remains the controller's final gate.
    """
    ledger.exact(bundle,'gate_attempt_id full_attempt_id full_manifest contract','ATTESTATION_BUNDLE_INVALID')
    _generation, document=store.load(); ledger.need(document is not None,'LEDGER_MISSING_NO_RESET')
    contract=bundle['contract']; manifest=bundle['full_manifest']
    full_reconciled(document,bundle['full_attempt_id'],manifest,contract)
    attempt=document['attempts'].get(bundle['gate_attempt_id'],{})
    need(document['active_attempt']==bundle['gate_attempt_id'] and
         attempt.get('intent',{}).get('gate')==gate_binding(contract), 'ATTESTATION_DURABLE_APPROVAL_REQUIRED')
    project=full_reader.project(); need(project.get('projectId')==PROJECT,'ATTESTATION_PROJECT_MISMATCH')
    validate_native_gate(contract,api.build(contract['build_id']),project.get('projectNumber'))
    event_reader(contract)
    need(full_reader.evaluate(manifest)['state']=='success','ATTESTATION_NATIVE_FULL_REQUIRED')
    return expected_receipt(contract,manifest)
