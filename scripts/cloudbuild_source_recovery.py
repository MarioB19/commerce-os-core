"""Authenticate the narrow SOURCE-failed-before-upload recovery evidence.

Pure validation. Readers are protected installation adapters, never HTTP inputs.
The caller must authenticate the whole bundle's digest and re-run this validator
at its final CAS fence. This module grants no credentials and performs no writes.
"""
from datetime import timedelta
from decimal import Decimal
import base64
import hashlib
import re
from urllib.parse import quote
import cloudbuild_admission as ledger
from cloudbuild_gcs_store import decode, encode, generation
from cloudbuild_full_evidence import PROJECT, need
from cloudbuild_effect_journal import validate_journal
import cloudbuild_runtime_meter as meter

KIND = 'SOURCE_FAILED_BEFORE_UPLOAD'
# Fixed public incident profile. Never a request/config-selected private recovery.
REPOSITORY = 'MarioB19/commerce-os-core'
REPOSITORY_ID = 1414365450
SOURCE_BUCKET = 'commerce-v7-public-sources-1065291779811'
ORIGINALS = frozenset('invocation_intent before task_media http_result request_logs service_current '
    'service_iam_before service_iam_current control_metadata control_media control_current ledger_metadata ledger_media ledger_current '
    'meter_metadata meter_media meter_current journal_metadata journal_media journal_current '
    'source_request source_result source_response inventory'.split())
RECEIPT_FIELDS = ('schema_version kind attempt_id request_id plan_sha256 source_sha task_sha256 '
    'service_uid revision image_digest ledger_generation ledger_sha256 meter_generation meter_sha256 '
    'meter_before_sha256 meter_request_started_at meter_ceiling_ms source_journal_sha256 source_object '
    'evidence_sha256 observed_at valid_until')


def sha(raw): return hashlib.sha256(raw).hexdigest()


def validate_receipt(receipt, *, now):
    ledger.exact(receipt, RECEIPT_FIELDS, 'SOURCE_RECOVERY_RECEIPT_FIELDS')
    need(type(receipt['schema_version']) is int and receipt['schema_version'] == 1
         and receipt['kind'] == KIND, 'SOURCE_RECOVERY_RECEIPT_KIND')
    for key in ('attempt_id', 'request_id', 'service_uid'): ledger.native_uuid(receipt[key])
    for key in ('plan_sha256','task_sha256','ledger_sha256','meter_sha256','meter_before_sha256',
                'source_journal_sha256','evidence_sha256','image_digest'): ledger.digest(receipt[key])
    ledger.digest(receipt['source_sha'], size=40)
    for key in ('ledger_generation','meter_generation'):
        generation(receipt[key]); need(receipt[key] != '0', 'SOURCE_RECOVERY_EXISTING_GENERATION_REQUIRED')
    need(type(receipt['revision']) is str and re.fullmatch(r'commerce-v7-controller-core-[a-z0-9-]+', receipt['revision'])
         and receipt['source_object'] == 'full/' + receipt['attempt_id'] + '.tgz'
         and type(receipt['meter_ceiling_ms']) is int and receipt['meter_ceiling_ms'] == 450000,
         'SOURCE_RECOVERY_RECEIPT_IDENTITY')
    start, end = ledger.timestamp(receipt['observed_at']), ledger.timestamp(receipt['valid_until'])
    need(start <= now < end and 0 < (end-start).total_seconds() <= 120,
         'SOURCE_RECOVERY_EVIDENCE_EXPIRED')
    need(now > ledger.timestamp(receipt['meter_request_started_at']) + timedelta(milliseconds=450000),
         'SOURCE_RECOVERY_EXECUTION_WINDOW_OPEN')
    return receipt


def validate_evidence(bundle, read_original, *, now):
    ledger.exact(bundle, 'schema_version kind observed_at valid_until originals', 'SOURCE_RECOVERY_BUNDLE_FIELDS')
    need(type(bundle['schema_version']) is int and bundle['schema_version'] == 1 and bundle['kind'] == KIND
         and type(bundle['originals']) is dict and set(bundle['originals']) == ORIGINALS,
         'SOURCE_RECOVERY_ORIGINALS_REQUIRED')
    start, end = ledger.timestamp(bundle['observed_at']), ledger.timestamp(bundle['valid_until'])
    need(start <= now < end and 0 < (end-start).total_seconds() <= 120, 'SOURCE_RECOVERY_EVIDENCE_EXPIRED')
    raw = {}; documents = {}; total = 0
    for key, ref in bundle['originals'].items():
        ledger.exact(ref, 'path bytes sha256', 'SOURCE_RECOVERY_REFERENCE_FIELDS')
        need(type(ref['path']) is str and ref['path'].startswith('/') and type(ref['bytes']) is int
             and 0 < ref['bytes'] <= 4*1024*1024, 'SOURCE_RECOVERY_REFERENCE_INVALID')
        ledger.digest(ref['sha256']); value = read_original(ref)
        need(type(value) is bytes and len(value) == ref['bytes'] and sha(value) == ref['sha256'],
             'SOURCE_RECOVERY_ORIGINAL_CHANGED')
        total += len(value); need(total <= 32*1024*1024, 'SOURCE_RECOVERY_TOTAL_BOUND')
        raw[key] = value; documents[key] = decode(value)
    before = documents['before']; task = documents['task_media']; intent = documents['invocation_intent']
    need(before.get('task') == task and task.get('operation') == 'SOURCE' and task.get('phase') == 'ACQUIRE',
         'SOURCE_RECOVERY_TASK_CHANGED')
    attempt_id = ledger.native_uuid(task.get('attempt_id')); plan = task['plan']; ledger.validate_plan(plan)
    need(plan['stage'] == 'full' and plan['timeout_seconds'] == 5700, 'SOURCE_RECOVERY_FULL_REQUIRED')
    need(task.get('event',{}).get('source_sha') == plan['identity']['source_sha']
         and plan['identity']['repository_id'] == REPOSITORY_ID
         and task['payload']['source_approval']['repository'] == REPOSITORY
         and task['payload']['source_approval']['repository_id'] == REPOSITORY_ID,
         'SOURCE_RECOVERY_SOURCE_CHANGED')
    work = {'operation':'SOURCE','phase':'ACQUIRE','attempt_id':attempt_id,'ceiling_seconds':450,'wire_timeout_seconds':480}
    need(before.get('work') == work and intent.get('work') == work and intent.get('no_retry') is True
         and intent['before_ref'] == bundle['originals']['before']
         and intent['response_path'] == bundle['originals']['http_result']['path']
         and intent['control_generation'] == before['stores']['control']['generation'],
         'SOURCE_RECOVERY_INVOKE_NOT_BOUND')
    initial_control = before['documents']['control']; target = initial_control['task']
    need(initial_control['mode'] == 'active' and target['sha256'] == sha(raw['task_media'])
         and target['size'] == len(raw['task_media']), 'SOURCE_RECOVERY_TASK_BYTES_CHANGED')
    service = documents['service_current']; old_service = before['service']
    name = service.get('name',''); service_name = name.rsplit('/',1)[-1]
    need(name == 'projects/'+PROJECT+'/locations/us-east1/services/'+service_name
         and service_name == 'commerce-v7-controller-core'
         and all(service.get(k) == old_service.get(k) for k in ('name','uid','uri','latestReadyRevision'))
         and intent['service_uid'] == service['uid'] and service.get('reconciling',False) is False,
         'SOURCE_RECOVERY_SERVICE_CHANGED')
    images = service.get('template',{}).get('containers',[])
    old_images = old_service.get('template',{}).get('containers',[])
    need(len(images) == len(old_images) == 1 and images[0].get('image') == old_images[0].get('image')
         and service.get('template',{}).get('serviceAccount') == old_service.get('template',{}).get('serviceAccount')
         == 'commerce-v7-controller-core@'+PROJECT+'.iam.gserviceaccount.com'
         and re.fullmatch(r'us-east1-docker.pkg.dev/'+re.escape(PROJECT)+r'/commerce-ci-public/controller@sha256:[a-f0-9]{64}',images[0]['image']),
         'SOURCE_RECOVERY_IMAGE_CHANGED')
    old_iam, current_iam = documents['service_iam_before'], documents['service_iam_current']
    bindings = current_iam.get('bindings')
    need(type(bindings) is list and len(bindings) == 1 and bindings == old_iam.get('bindings')
         and set(bindings[0]) == {'role','members'} and bindings[0]['role'] == 'roles/run.invoker'
         and len(bindings[0]['members']) == 1 and bindings[0]['members'][0].startswith('user:')
         and not current_iam.get('auditConfigs',[]), 'SOURCE_RECOVERY_INVOKER_CHANGED')
    custody = before['stores']['ledger']['bucket']
    def gcs(key, expected_object):
        meta, again = documents[key+'_metadata'], documents[key+'_current']; payload = raw[key+'_media']
        gen = generation(meta.get('generation'))
        need(meta.get('bucket') == again.get('bucket') == custody and meta.get('name') == again.get('name') == expected_object
             and again.get('generation') == gen and meta.get('size') == again.get('size') == str(len(payload))
             and meta.get('contentEncoding') in (None,'identity') and again.get('contentEncoding') in (None,'identity')
             and meta.get('md5Hash') == again.get('md5Hash') == base64.b64encode(hashlib.md5(payload).digest()).decode(),
             'SOURCE_RECOVERY_GCS_IDENTITY_CHANGED')
        return gen, documents[key+'_media']
    ledger_gen, current_ledger = gcs('ledger',before['stores']['ledger']['object']); ledger.validate_historical_ledger(current_ledger)
    need(current_ledger == before['documents']['ledger'] and ledger_gen == before['stores']['ledger']['generation']
         and sha(raw['ledger_media']) == before['stores']['ledger']['sha256']
         and current_ledger['active_attempt'] == attempt_id and current_ledger['blocked'] is None,
         'SOURCE_RECOVERY_LEDGER_CHANGED')
    attempt = current_ledger['attempts'][attempt_id]
    need(attempt['state'] == 'RESERVED' and 'intent' not in attempt and 'build_id' not in attempt
         and all(attempt[k] == task[k] for k in ('plan','approval','admission')),
         'SOURCE_RECOVERY_DISPATCH_NOT_EXCLUDED')
    control_gen, control = gcs('control',before['stores']['control']['object'])
    need(int(control_gen) > int(before['stores']['control']['generation']) and control == {
        'schema_version':1,'mode':'paused','task':None,'expires_at':initial_control['expires_at']}
         and ledger.timestamp(control['expires_at']) > now, 'SOURCE_RECOVERY_CONTROL_NOT_PAUSED')
    meter_gen, current_meter = gcs('meter',before['stores']['meter']['object']); meter.validate(current_meter)
    old_meter = before['documents']['meter']; meter.validate(old_meter)
    # The current schema stores no mutable quota fields; quotas belong to the
    # pinned tooling. Compare the entire closed header, not just known rows.
    need(type(current_meter['schema_version']) is type(old_meter['schema_version']) is int
         and {k:v for k,v in current_meter.items() if k not in ('requests','active_request')}
         == {k:v for k,v in old_meter.items() if k not in ('requests','active_request')},
         'SOURCE_RECOVERY_METER_HEADER_CHANGED')
    need(sha(encode(old_meter)) == before['stores']['meter']['sha256'], 'SOURCE_RECOVERY_BEFORE_METER_CHANGED')
    need(old_meter['active_request'] is None and all(current_meter['requests'].get(k) == v for k,v in old_meter['requests'].items())
         and int(meter_gen) > int(before['stores']['meter']['generation']), 'SOURCE_RECOVERY_METER_HISTORY_CHANGED')
    extra = set(current_meter['requests']) - set(old_meter['requests']); request_id = current_meter['active_request']
    need(extra == {request_id}, 'SOURCE_RECOVERY_REQUEST_NOT_UNIQUE'); row = current_meter['requests'][request_id]
    need(row['state'] == 'RESERVED' and row['ceiling_ms'] == 450000 and row['result_sha256'] is None,
         'SOURCE_RECOVERY_RESERVATION_CHANGED')
    response = documents['http_result']
    need(response == {'error_type':None,'http_status':200,'request_outcome':'HTTP_CONFIRMED','response':{
        'automatic_retry':False,'build_success_claimed':False,'code':'CONTROLLER_REQUEST_FAILED',
        'reservation_may_exist':True,'status':'STOP_PRESERVE'}}, 'SOURCE_RECOVERY_HTTP_TERMINAL_REQUIRED')
    logs = documents['request_logs']; need(set(logs) == {'entries'} and len(logs['entries']) == 1,
                                            'SOURCE_RECOVERY_UNIQUE_LOG_REQUIRED')
    log = logs['entries'][0]; request = log.get('httpRequest',{}); labels = log.get('resource',{}).get('labels',{})
    need(log.get('resource',{}).get('type') == 'cloud_run_revision' and labels.get('project_id') == PROJECT
         and labels.get('location') == 'us-east1' and labels.get('service_name') == service_name
         and labels.get('revision_name') == service['latestReadyRevision'].rsplit('/',1)[-1]
         and request.get('requestMethod') == 'POST' and request.get('requestUrl') == service['uri'].rstrip('/')+'/tick'
         and request.get('status') == 200 and re.fullmatch(r'projects/'+re.escape(PROJECT)+r'/traces/[a-f0-9]{32}',log.get('trace','')),
         'SOURCE_RECOVERY_LOG_IDENTITY_CHANGED')
    latency = request.get('latency',''); need(re.fullmatch(r'[0-9]+(?:\.[0-9]{1,9})?s',latency), 'SOURCE_RECOVERY_LATENCY_INVALID')
    elapsed = Decimal(latency[:-1]); need(0 < elapsed <= 480, 'SOURCE_RECOVERY_LATENCY_INVALID')
    native_start = ledger.timestamp(log['timestamp']); native_end = native_start + timedelta(seconds=float(elapsed))
    request_start = ledger.timestamp(row['started_at'])
    need(ledger.timestamp(before['observed_at']) <= ledger.timestamp(intent['at']) <= native_start <= request_start < native_end
         and native_end <= start and native_end <= ledger.timestamp(log['receiveTimestamp']) <= now
         and now > request_start + timedelta(seconds=450), 'SOURCE_RECOVERY_INVOCATION_NOT_TERMINAL')
    journal_target = task['payload']['journal']; journal_gen, journal = gcs('journal',journal_target['object'])
    binding = {'attempt_id':attempt_id,'plan_sha256':ledger.canonical_hash(plan),'source_sha':plan['identity']['source_sha']}
    validate_journal(journal,binding); action = 'source-acquire:'+attempt_id
    need(journal_target['bucket'] == custody and int(journal_gen) > int(journal_target['minimum_generation'])
         and journal_target['object'].endswith('/source-journals/'+attempt_id+'.json') and journal['revision'] == 1
         and set(journal['actions']) == {action}, 'SOURCE_RECOVERY_UPLOAD_NOT_EXCLUDED')
    acquired = journal['actions'][action]
    need(acquired['intent_sha256'] == ledger.canonical_hash(task['payload']['source_approval'])
         and acquired['result'] is None and acquired['history'] == []
         and request_start <= ledger.timestamp(acquired['created_at']) <= native_end,
         'SOURCE_RECOVERY_ACQUISITION_CHANGED')
    obj = 'full/'+attempt_id+'.tgz'; src_request = documents['source_request']; src_result = documents['source_result']
    source_url = 'https://storage.googleapis.com/storage/v1/b/'+SOURCE_BUCKET+'/o/'+quote(obj,safe='')
    need(src_request.get('method') == 'GET' and src_request.get('url') == source_url
         and start <= ledger.timestamp(src_request.get('at')) <= now
         and src_result.get('http_status') == 404 and src_result.get('request_outcome') == 'HTTP_CONFIRMED'
         and documents['source_response'].get('error',{}).get('code') == 404,
         'SOURCE_RECOVERY_NATIVE_ABSENCE_REQUIRED')
    inventory = documents['inventory']; payload = {k:inventory[k] for k in ('project','project_number','regions','builds')}
    need(inventory.get('complete') is True and payload['project'] == PROJECT and payload['project_number'] == '1065291779811'
         and 'global' in payload['regions'] and 'us-east1' in payload['regions']
         and inventory['inventory_sha256'] == ledger.canonical_hash(payload) == task['admission']['inventory_sha256']
         and start <= ledger.timestamp(inventory['started_at']) <= ledger.timestamp(inventory['observed_at']) <= now,
         'SOURCE_RECOVERY_NATIVE_INVENTORY_CHANGED')
    receipt = {'schema_version':1,'kind':KIND,**binding,'request_id':request_id,
        'task_sha256':sha(raw['task_media']),'service_uid':service['uid'],
        'revision':service['latestReadyRevision'].rsplit('/',1)[-1], 'image_digest':images[0]['image'].rsplit(':',1)[-1],
        'ledger_generation':ledger_gen,'ledger_sha256':sha(raw['ledger_media']),
        'meter_generation':meter_gen,'meter_sha256':sha(raw['meter_media']),
        'meter_before_sha256':before['stores']['meter']['sha256'],'meter_request_started_at':row['started_at'],
        'meter_ceiling_ms':row['ceiling_ms'],'source_journal_sha256':sha(raw['journal_media']),'source_object':obj,
        'evidence_sha256':ledger.canonical_hash(bundle),'observed_at':bundle['observed_at'],'valid_until':bundle['valid_until']}
    return validate_receipt(receipt,now=now)
