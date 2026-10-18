"""Closed daily B02 contracts; importing this module performs no I/O."""
import datetime as dt
import hashlib
import json
import re
import uuid
from pathlib import Path

TARGET = ('project-c6f43813-9ac9-47ab-9fe', 'commerce-os-test', 'us-east1-d')
VM_ID = '6334472381123916728'
PROJECT_NUMBER = '1065291779811'
ORIGINAL_MINIMUM = Path('/opt/commerce-restore-private/ensayo-9418-20261005/input/backup-key.env')
ORIGINAL_MINIMUM_UID = 2000
REPOSITORY = 'MarioB19/commerce-os'
WORKFLOW = REPOSITORY + '/.github/workflows/ci.yml@refs/heads/main'
PRIVATE = Path('/opt/commerce-os/private')
DAILY = PRIVATE / 'daily-b02'
MAX_BYTES = 1024 ** 3
MAX_RUNS = 37
WINDOW_DAYS = 30
BACKUP_TIMEOUT = 1500
TERMINAL = {'SUCCEEDED', 'FAILED', 'FAILED_RECONCILED'}
SOURCE_FILES = ('backup.mjs', 'backup-database.mjs', 'postgres-tool.mjs', 'local-env.mjs')
PORTAL_BASE = Path('/opt/mcl-portal')
PORTAL_HELPER = 'b02-portal-capsule.mjs'
PORTAL_MAX_BYTES = 32 * 1024 ** 2 + 256 * 1024 + 48
BASE_EXPORTS = ('ciphertext.backup.aes', 'source.json', 'backup.json')
PORTAL_EXPORTS = BASE_EXPORTS + ('portal.backup.aes',)
PDF_NAMES = ('bono-01-primera-semana-lista.pdf', 'bono-02-instrumentos-evaluacion-observacion.pdf',
    'bono-03-kit-cte-control-grupo.pdf', 'bono-04-banco-dinamicas.pdf', 'bono-05-proyectos-temporada.pdf',
    'bono-06-adecuaciones-diversidad-aula.pdf', 'bono-07-cartas-comunicados-familias.pdf',
    'bono-08-material-recortable-aula.pdf', 'calendario-del-ciclo.pdf', 'mi-ciclo-listo-paquete-completo.pdf')
PORTAL_FIELDS = {'source_sha', 'run_id', 'container_id', 'image', 'proxy_network',
    'report_ref', 'runtime_env_ref', 'manifest_ref'}


def validate_portal_backup(value):
    need(isinstance(value, dict) and set(value) == PORTAL_FIELDS | {'state_path', 'state_uid'},
         'BACKUP_PORTAL_PLAN_INVALID')
    need(all(isinstance(value.get(name), str) for name in ('source_sha', 'container_id', 'image', 'proxy_network'))
         and re.fullmatch(r'[a-f0-9]{40}', value.get('source_sha', ''))
         and re.fullmatch(r'[a-f0-9]{64}', value.get('container_id', ''))
         and re.fullmatch(r'sha256:[a-f0-9]{64}', value.get('image', ''))
         and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value.get('proxy_network', ''))
         and value['proxy_network'] not in ('host', 'none', 'bridge'), 'BACKUP_PORTAL_IDENTITY_INVALID')
    run_identity(value.get('run_id'))
    for name in ('report_ref', 'runtime_env_ref', 'manifest_ref'):
        reference(value[name])
    need(value['report_ref']['path'] == str(PORTAL_BASE / 'current.json')
         and value['runtime_env_ref']['path'] == str(PORTAL_BASE / 'releases' / value['run_id'] / 'runtime.env')
         and Path(value['manifest_ref']['path']).name == 'portal-manifest.json'
         and Path(value['manifest_ref']['path']).parent.parent == PRIVATE.parent / 'releases'
         and value['state_path'] == str(PORTAL_BASE / 'state') and type(value['state_uid']) is int
         and value['state_uid'] == 1000, 'BACKUP_PORTAL_SCOPE_INVALID')
    return value


def plan_version(plan):
    version = plan.get('schema_version')
    need(type(version) is int and version in (1, 2, 3), 'BACKUP_PLAN_VERSION_INVALID')
    if version == 1:
        need('portal_backup' not in plan, 'BACKUP_LEGACY_PORTAL_FIELD_INVALID')
    else:
        validate_portal_backup(plan.get('portal_backup'))
    if version == 3:
        need(plan.get('runtime_projection_version') == 2 and plan.get('runtime_stage') in ('CORE_PREPARED', 'OPERATING'),
             'BACKUP_RUNTIME_STAGE_INVALID')
        count = len(plan.get('preserved_runtime', {}))
        need(count == 5 if plan['runtime_stage'] == 'CORE_PREPARED' else 8 <= count <= 11, 'BACKUP_RUNTIME_STAGE_COUNT_INVALID')
    return version


def validate_portal_metadata(value):
    need(isinstance(value, dict) and set(value) == {'source_sha', 'run_id', 'image', 'proxy_network',
         'format', 'private_files', 'sqlite_snapshot_consistent'}, 'BACKUP_PORTAL_METADATA_INVALID')
    need(all(isinstance(value.get(name), str) for name in ('source_sha', 'image', 'proxy_network'))
         and re.fullmatch(r'[a-f0-9]{40}', value['source_sha'])
         and re.fullmatch(r'sha256:[a-f0-9]{64}', value['image'])
         and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value['proxy_network'])
         and value['proxy_network'] not in ('host', 'none', 'bridge')
         and value['format'] == 'COMOSP01' and type(value['private_files']) is int
         and value['private_files'] in (13, 14) and value['sqlite_snapshot_consistent'] is True,
         'BACKUP_PORTAL_METADATA_INVALID')
    run_identity(value['run_id'])
    return value


def export_names(report):
    version = report.get('backup_contract_version', 1)
    need(type(version) is int and version in (1, 2), 'BACKUP_EXPORT_VERSION_INVALID')
    if version == 2:
        validate_portal_metadata(report.get('portal_capsule'))
    names = PORTAL_EXPORTS if version == 2 else BASE_EXPORTS
    need(isinstance(report.get('exports'), dict) and set(report['exports']) == set(names),
         'BACKUP_EXACT_EXPORTS_REQUIRED')
    return names


def ciphertext_header(name):
    return {'ciphertext.backup.aes': b'COMOSB02', 'portal.backup.aes': b'COMOSP01'}.get(name)


def need(value, code):
    if not value:
        raise RuntimeError(code)


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def unique_json(value):
    def pairs(items):
        result = {}
        for key, entry in items:
            need(key not in result, 'DUPLICATE_JSON_FIELD')
            result[key] = entry
        return result
    return json.loads(value, object_pairs_hook=pairs)


def run_identity(value):
    need(isinstance(value, str) and re.fullmatch(r'[0-9]+-[0-9]+', value), 'INVALID_BACKUP_RUN')
    return value



def backup_run_identity(value):
    """Backup IDs are distinct from immutable GitHub portal/release IDs."""
    if isinstance(value, str) and re.fullmatch(r'gcp-[a-f0-9]{32}', value):
        parsed = uuid.UUID(hex=value[4:])
        need(parsed.version == 4 and parsed.variant == uuid.RFC_4122, 'INVALID_BACKUP_RUN')
        return value
    return run_identity(value)


def gcp_run_identity(value):
    need(isinstance(value, str), 'B02_GCP_EXECUTION_UID_INVALID')
    try: parsed = uuid.UUID(value)
    except (ValueError, AttributeError): raise RuntimeError('B02_GCP_EXECUTION_UID_INVALID') from None
    need(str(parsed) == value and parsed.version == 4 and parsed.variant == uuid.RFC_4122,
         'B02_GCP_EXECUTION_UID_INVALID')
    return 'gcp-' + parsed.hex


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def utc_time(value):
    try: parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except (ValueError, AttributeError, TypeError): raise RuntimeError('B02_GCP_TIME_INVALID') from None
    need(parsed.utcoffset() == dt.timedelta(0), 'B02_GCP_TIME_INVALID')
    return parsed


GCP_FINANCIAL_START = dt.datetime(2026,10,5,tzinfo=dt.timezone.utc)
# The original 30-day authorization ended 2026-11-04. The owner renewed it once,
# for one more equal period with the same 37-run quota (V7 log, 2026-10-16):
# a binding may now run until 2026-12-04. Root accepts the change of
# valid_until only as that exact renewal (b02-backup-root.py cutover_facts).
GCP_FINANCIAL_ORIGINAL_END = dt.datetime(2026,11,4,tzinfo=dt.timezone.utc)
GCP_FINANCIAL_END = dt.datetime(2026,12,4,tzinfo=dt.timezone.utc)
GCP_REGION = 'us-east1'
GCP_JOB = 'projects/' + TARGET[0] + '/locations/' + GCP_REGION + '/jobs/commerce-b02-daily'
GCP_SCHEDULER = GCP_JOB
GCP_EXECUTOR = 'commerce-b02-executor@' + TARGET[0] + '.iam.gserviceaccount.com'
GCP_INVOKER = 'commerce-b02-scheduler@' + TARGET[0] + '.iam.gserviceaccount.com'
GCP_BINDING_FIELDS = {'schema_version','kind','mode','source_sha','plan_sha256','bucket',
    'job','job_uid','job_generation','template_sha256','image','executor','executor_id',
    'oslogin_uid','oslogin_username','invoker','scheduler','manual_creator','valid_from',
    'valid_until','schedule_utc','activation_id','first_custody_ref'}


def gcp_binding(value):
    need(type(value) is dict and set(value) == GCP_BINDING_FIELDS and type(value['schema_version']) is int and value['schema_version'] == 1
         and value['kind'] == 'B02_GCP_BINDING' and value['mode'] in ('MANUAL','SCHEDULED'), 'B02_GCP_BINDING_INVALID')
    need(value['job'] == GCP_JOB and value['scheduler'] == GCP_SCHEDULER
         and value['executor'] == GCP_EXECUTOR and value['invoker'] == GCP_INVOKER, 'B02_GCP_TARGET_INVALID')
    gcp_run_identity(value['job_uid'])
    need(re.fullmatch(r'[a-f0-9]{40}', value['source_sha'] or '')
         and re.fullmatch(r'[1-9][0-9]{0,18}', str(value['job_generation']))
         and isinstance(value['job_generation'], str), 'B02_GCP_SOURCE_INVALID')
    hash_identity(value['plan_sha256']); hash_identity(value['template_sha256'])
    need(isinstance(value['image'], str) and re.fullmatch(r'us-east1-docker\.pkg\.dev/' + re.escape(TARGET[0])
         + r'/commerce-b02/transport@sha256:[a-f0-9]{64}', value['image']), 'B02_GCP_IMAGE_INVALID')
    need(isinstance(value['bucket'], str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{4,61}[a-z0-9]', value['bucket']), 'B02_GCP_BUCKET_INVALID')
    need(type(value['oslogin_uid']) is int and value['oslogin_uid'] > 0
         and isinstance(value['oslogin_username'], str) and re.fullmatch(r'sa_[a-z0-9_]{1,64}', value['oslogin_username'])
         and isinstance(value['executor_id'], str) and re.fullmatch(r'[1-9][0-9]{10,30}', value['executor_id']), 'B02_GCP_OSLOGIN_INVALID')
    need(isinstance(value['manual_creator'], str) and re.fullmatch(r'[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+', value['manual_creator'])
         and value['manual_creator'] not in (GCP_INVOKER, GCP_EXECUTOR), 'B02_GCP_MANUAL_CREATOR_INVALID')
    need(isinstance(value['schedule_utc'],str) and re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]', value['schedule_utc']), 'B02_GCP_SCHEDULE_TIME_INVALID')
    start, end = utc_time(value['valid_from']), utc_time(value['valid_until'])
    need(start == GCP_FINANCIAL_START and start < end <= GCP_FINANCIAL_END, 'B02_GCP_AUTHORIZATION_WINDOW_INVALID')
    need(isinstance(value['activation_id'], str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{7,63}', value['activation_id']), 'B02_GCP_ACTIVATION_ID_INVALID')
    if value['mode'] == 'MANUAL': need(value['first_custody_ref'] is None, 'B02_GCP_FIRST_CUSTODY_INVALID')
    else: reference(value['first_custody_ref'])
    return value


def gcp_job_reconciled(job):
    # ProtoJSON omits false scalars. Native v2 GET after successful creation
    # omits reconciling; require the independent Ready and generation proof.
    return (type(job) is dict and job.get('reconciling', False) is False
            and isinstance(job.get('generation'), str)
            and re.fullmatch(r'[1-9][0-9]*', job['generation']) is not None
            and job.get('observedGeneration') == job['generation']
            and type(job.get('terminalCondition')) is dict
            and job['terminalCondition'].get('type') == 'Ready'
            and job['terminalCondition'].get('state') == 'CONDITION_SUCCEEDED'
            and not job.get('deleteTime'))


def gcp_job_guard(binding, job):
    gcp_binding(binding)
    need(type(job) is dict and job.get('name') == binding['job'] and job.get('uid') == binding['job_uid']
         and job.get('generation') == binding['job_generation'] and not job.get('deleteTime')
         and gcp_job_reconciled(job), 'B02_GCP_JOB_DRIFT')
    template = job.get('template')
    need(type(template) is dict and sha256(canonical(template)) == binding['template_sha256']
         and type(template.get('taskCount')) is int and template.get('taskCount') == 1
         and type(template.get('parallelism')) is int and template.get('parallelism') == 1, 'B02_GCP_TEMPLATE_DRIFT')
    task = template.get('template', {})
    need(set(task) <= {'serviceAccount','maxRetries','timeout','containers','volumes','executionEnvironment'}
         and task.get('serviceAccount') == GCP_EXECUTOR and type(task.get('maxRetries')) is int and task.get('maxRetries') == 0
         and task.get('executionEnvironment') == 'EXECUTION_ENVIRONMENT_GEN2'
         and task.get('timeout') == '1800s' and len(task.get('containers', [])) == 1, 'B02_GCP_TASK_LIMITS_INVALID')
    container = task['containers'][0]
    need(set(container) <= {'name','image','resources','env','command','args','volumeMounts'}
         and ('name' not in container or container['name']=='transport')
         and container.get('image') == binding['image']
         and container.get('resources', {}).get('limits') == {'cpu':'2','memory':'8Gi'}
         and container.get('env') == [{'name':'B02_SOURCE_SHA','value':binding['source_sha']}]
         and container.get('command') == ['python3','-B','/opt/commerce/scripts/b02-backup-gcp.py']
         and container.get('args', []) == []
         and container.get('volumeMounts') == [{'name':'work','mountPath':'/work'}]
         and task.get('volumes') == [{'name':'work','emptyDir':{'medium':'MEMORY','sizeLimit':'3Gi'}}]
         and not task.get('vpcAccess') and not container.get('dependsOn'), 'B02_GCP_CONTAINER_DRIFT')
    return task


def daily_cron(clock):
    need(isinstance(clock,str) and re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]',clock),'B02_GCP_SCHEDULE_TIME_INVALID')
    hour,minute=map(int,clock.split(':'));return f'{minute} {hour} * * *'


def gcp_scheduler_guard(binding, scheduler, *, paused):
    need(type(scheduler) is dict and scheduler.get('name') == binding['scheduler']
         and scheduler.get('state') == ('PAUSED' if paused else 'ENABLED')
         and scheduler.get('schedule') == daily_cron(binding['schedule_utc']) and scheduler.get('timeZone') == 'Etc/UTC', 'B02_GCP_SCHEDULER_DRIFT')
    target = scheduler.get('httpTarget', {})
    headers=target.get('headers',{})
    need(type(headers) is dict and all(isinstance(k,str) and isinstance(v,str) for k,v in headers.items()), 'B02_GCP_SCHEDULER_TARGET_DRIFT')
    lowered={key.lower():value for key,value in headers.items()}
    retry=scheduler.get('retryConfig',{})
    need(len(lowered)==len(headers) and set(lowered)<={'content-type','user-agent'}
         and lowered.get('content-type')=='application/json'
         and lowered.get('user-agent','Google-Cloud-Scheduler')=='Google-Cloud-Scheduler'
         and set(target)<={'uri','httpMethod','oauthToken','headers','body'}
         and target.get('uri') == 'https://run.googleapis.com/v2/' + GCP_JOB + ':run'
         and target.get('httpMethod') == 'POST'
         and target.get('oauthToken') == {'serviceAccountEmail': GCP_INVOKER, 'scope':'https://www.googleapis.com/auth/cloud-platform'}
         and target.get('body', '') in ('', 'e30=')
         and set(retry)<={'retryCount','maxRetryDuration','minBackoffDuration','maxBackoffDuration','maxDoublings'}
         and type(retry.get('retryCount',0)) is int and retry.get('retryCount',0)==0
         and retry.get('maxRetryDuration','0s')=='0s'
         and retry.get('minBackoffDuration','5s')=='5s' and retry.get('maxBackoffDuration','3600s')=='3600s'
         and type(retry.get('maxDoublings',5)) is int and retry.get('maxDoublings',5)==5
         and scheduler.get('attemptDeadline','180s')=='180s', 'B02_GCP_SCHEDULER_TARGET_DRIFT')
    return True


def gcp_task_name(execution):
    need(isinstance(execution,str) and re.fullmatch(re.escape(GCP_JOB)+r'/executions/commerce-b02-daily-[a-z0-9]{1,30}',execution),
         'B02_GCP_EXECUTION_NAME_INVALID')
    return execution+'/tasks/'+execution.rsplit('/',1)[1]+'-task0'


def gcp_execution_guard(binding, job, execution, task, now):
    task_template = gcp_job_guard(binding, job)
    need(utc_time(binding['valid_from']) <= now and now + dt.timedelta(seconds=1800) <= utc_time(binding['valid_until']), 'B02_GCP_AUTHORIZATION_EXPIRED')
    name = execution.get('name', '')
    need(isinstance(name,str) and re.fullmatch(re.escape(GCP_JOB)+r'/executions/commerce-b02-daily-[a-z0-9]{1,30}',name)
         and execution.get('job') == GCP_JOB.rsplit('/',1)[1] and not execution.get('deleteTime')
         and type(execution.get('taskCount')) is int and execution.get('taskCount') == 1
         and type(execution.get('parallelism')) is int and execution.get('parallelism') == 1
         and execution.get('template') == task_template and execution.get('retriedCount',0) == 0
         and execution.get('creator') == (binding['manual_creator'] if binding['mode']=='MANUAL' else GCP_INVOKER), 'B02_GCP_EXECUTION_DRIFT')
    run_id = gcp_run_identity(execution.get('uid'))
    created = utc_time(execution.get('createTime'))
    need(dt.timedelta(0) <= now-created <= dt.timedelta(minutes=5)
         and utc_time(binding['valid_from']) <= created < utc_time(binding['valid_until']), 'B02_GCP_EXECUTION_STALE')
    need(task.get('name') == gcp_task_name(name) and task.get('execution') == name.rsplit('/',1)[1]
         and task.get('job') == GCP_JOB.rsplit('/',1)[1] and type(task.get('index',0)) is int and task.get('index',0) == 0
         and task.get('retried',0) == 0 and not task.get('completionTime')
         and task.get('containers') == task_template['containers']
         and all(task.get(key) == task_template.get(key) for key in ('serviceAccount','timeout','volumes'))
         # Jobs only support GEN2. Native Task GET omits this output, while both
         # Job and Execution templates above must still explicitly pin GEN2.
         and task.get('executionEnvironment','EXECUTION_ENVIRONMENT_GEN2') == 'EXECUTION_ENVIRONMENT_GEN2'
         and type(task.get('maxRetries',0)) is int and task.get('maxRetries',0) == 0
         and not task.get('vpcAccess'), 'B02_GCP_TASK_DRIFT')
    slot = None
    if binding['mode'] == 'SCHEDULED':
        hour, minute = map(int,binding['schedule_utc'].split(':'))
        slot = created.replace(hour=hour,minute=minute,second=0,microsecond=0)
        need(dt.timedelta(0) <= created-slot < dt.timedelta(minutes=30), 'B02_GCP_SCHEDULE_WINDOW_INVALID')
    return {'kind':'GCP_CLOUD_RUN','run_id':run_id,'execution':name,'execution_uid':execution['uid'],
        'creator':execution['creator'],'created_at':execution['createTime'], 'source_sha':binding['source_sha'],
        'plan_sha256':binding['plan_sha256'],'binding_sha256':sha256(canonical(binding)),
        'mode':binding['mode'],'slot':slot.isoformat() if slot else None,
        'job_sha256':sha256(canonical(job)),'task_sha256':sha256(canonical(task)),
        'execution_sha256':sha256(canonical(execution)), 'scheduled_delivery_proven':False}

def hash_identity(value):
    need(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value), 'INVALID_BACKUP_SHA256')
    return value


def reference(value):
    need(isinstance(value, dict) and set(value) == {'path', 'bytes', 'sha256'}, 'INVALID_BACKUP_REFERENCE')
    need(isinstance(value['path'], str) and Path(value['path']).is_absolute(), 'INVALID_BACKUP_REFERENCE')
    need(type(value['bytes']) is int and value['bytes'] > 0, 'INVALID_BACKUP_REFERENCE')
    hash_identity(value['sha256'])
    return value


def transport_config(env):
    event = env.get('GITHUB_EVENT_NAME')
    need(event == 'schedule' or (event == 'workflow_dispatch' and env.get('B02_MODE') == 'backup'), 'BACKUP_EVENT_REQUIRED')
    need(env.get('GITHUB_REPOSITORY') == REPOSITORY and env.get('GITHUB_REF') == 'refs/heads/main'
         and env.get('GITHUB_WORKFLOW_REF') == WORKFLOW, 'BACKUP_MAIN_WORKFLOW_REQUIRED')
    need(tuple(env.get(key) for key in ('GCP_PROJECT_ID', 'GCP_INSTANCE', 'GCP_ZONE')) == TARGET, 'BACKUP_TEST_TARGET_REQUIRED')
    need(re.fullmatch(r'[a-f0-9]{40}', env.get('GITHUB_SHA', '')), 'BACKUP_SOURCE_REQUIRED')
    need(env.get('B02_BACKUP_ENABLED') == 'true', 'BACKUP_NOT_ENABLED')
    if event == 'schedule':
        need(env.get('B02_SCHEDULE_ENABLED') == 'true', 'BACKUP_SCHEDULE_NOT_ENABLED')
    config = unique_json(env.get('B02_TRANSPORT_JSON', '{}'))
    need(isinstance(config, dict) and set(config) == {'bucket', 'plan_sha256', 'controller_sha256', 'contract_sha256'}, 'BACKUP_TRANSPORT_CONFIG_REQUIRED')
    need(isinstance(config['bucket'], str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{4,61}[a-z0-9]', config['bucket']), 'BACKUP_BUCKET_REQUIRED')
    for key in ('plan_sha256', 'controller_sha256', 'contract_sha256'):
        hash_identity(config[key])
    return dict(config, run_id=run_identity(env.get('GITHUB_RUN_ID', '') + '-' + env.get('GITHUB_RUN_ATTEMPT', '')),
                source_sha=env['GITHUB_SHA'], scheduled=event == 'schedule')


def check_run_budget(journals, now):
    cutoff = now - dt.timedelta(days=WINDOW_DAYS)
    times = [dt.datetime.fromisoformat(item['started_at']) for item in journals]
    need(all(value.tzinfo is not None and value <= now for value in times), 'BACKUP_LEDGER_TIME_INVALID')
    need(sum(value >= cutoff for value in times) < MAX_RUNS, 'BACKUP_30_DAY_RUN_LIMIT')


def validate_bucket(value, bucket):
    need(isinstance(value, dict) and value.get('name') == bucket
         and str(value.get('projectNumber')) == PROJECT_NUMBER
         and value.get('location') == 'US-EAST1' and value.get('storageClass') == 'STANDARD',
         'B02_BUCKET_IDENTITY_DRIFT')
    iam = value.get('iamConfiguration', {})
    need(isinstance(iam, dict) and iam.get('publicAccessPrevention') == 'enforced'
         and isinstance(iam.get('uniformBucketLevelAccess'), dict)
         and iam['uniformBucketLevelAccess'].get('enabled') is True, 'B02_BUCKET_PRIVACY_DRIFT')
    need(value.get('lifecycle') == {'rule': [{'action': {'type': 'Delete'}, 'condition': {'age': 30}}]},
         'B02_BUCKET_LIFECYCLE_DRIFT')
    soft = value.get('softDeletePolicy', {})
    need(isinstance(soft, dict) and str(soft.get('retentionDurationSeconds')) == '604800',
         'B02_BUCKET_SOFT_DELETE_DRIFT')
    for name in ('versioning', 'autoclass'):
        setting = value.get(name, {})
        need(isinstance(setting, dict) and setting.get('enabled', False) is False, 'B02_BUCKET_STORAGE_POLICY_DRIFT')
    return {'name': bucket, 'projectNumber': PROJECT_NUMBER, 'location': 'US-EAST1',
        'storageClass': 'STANDARD', 'configuration_verified': True}


def runtime_projection(value, version=1):
    # Environment stays in RAM; the journal records only the projection digest.
    need(type(version) is int and version in (1, 2), 'BACKUP_RUNTIME_PROJECTION_VERSION_INVALID')
    if version == 1:
        state = value['State']
        return {key: value[key] for key in ('Id', 'Image', 'Config', 'HostConfig', 'Mounts', 'NetworkSettings')} | {
            'State': {key: state[key] for key in ('Running', 'Paused', 'Restarting', 'Pid', 'StartedAt')}}
    networks = value['NetworkSettings']['Networks']
    need(isinstance(networks, dict), 'BACKUP_RUNTIME_NETWORKS_INVALID')
    normalized = {}
    for name, network in networks.items():
        aliases = network.get('Aliases') or []
        need(isinstance(aliases, list) and all(isinstance(alias, str) for alias in aliases)
             and isinstance(network.get('NetworkID'), str) and type(network.get('GwPriority', 0)) is int,
             'BACKUP_RUNTIME_NETWORKS_INVALID')
        normalized[name] = {'NetworkID': network['NetworkID'], 'Aliases': sorted(aliases), 'GwPriority': network.get('GwPriority', 0)}
    return {key: value[key] for key in ('Id', 'Image', 'Name', 'Config', 'HostConfig', 'Mounts')} | {
        'NetworkSettings': {'Networks': normalized}}


def projection_digest(value, version=1):
    return sha256(json.dumps(runtime_projection(value, version), sort_keys=True, separators=(',', ':')).encode())


def validate_custody(value, report, bucket):
    export_names(report)
    need(all(isinstance(ref, dict) and type(ref.get('bytes')) is int and ref['bytes'] > 0
             and hash_identity(ref.get('sha256')) for ref in report['exports'].values()), 'BACKUP_EXPORT_REFERENCE_INVALID')
    need(sum(ref['bytes'] for ref in report['exports'].values()) <= MAX_BYTES, 'BACKUP_TOTAL_COST_SIZE_LIMIT')
    need(isinstance(value, dict) and value.get('status') == 'B02_OFFHOST_CUSTODY_VERIFIED'
         and value.get('run_id') == report['run_id'] and value.get('bucket') == bucket
         and value.get('plan_sha256') == report['plan_sha256'], 'BACKUP_CUSTODY_IDENTITY_MISMATCH')
    objects = value.get('objects')
    need(isinstance(objects, dict) and set(objects) == set(report['exports']), 'BACKUP_CUSTODY_OBJECTS_MISMATCH')
    for name, ref in report['exports'].items():
        obj = objects[name]
        need(isinstance(obj, dict) and obj.get('bytes') == ref['bytes'] and obj.get('sha256') == ref['sha256']
             and obj.get('full_download_verified') is True and re.fullmatch(r'[1-9][0-9]*', str(obj.get('generation', '')))
             and obj.get('object') == 'b02/daily/' + report['run_id'] + '/' + name, 'BACKUP_CUSTODY_DOWNLOAD_REQUIRED')
    need(value.get('keys_exported') is False and value.get('plaintext_exported') is False, 'BACKUP_CUSTODY_ENCRYPTED_ONLY')
    if report.get('backup_contract_version', 1) == 2:
        need(value.get('backup_contract_version') == 2 and value.get('backup_decryption_key_exported') is False
             and value.get('portal_credentials_archived_encrypted') is True
             and value.get('portal_capsule') == report.get('portal_capsule'), 'BACKUP_PORTAL_CUSTODY_REQUIRED')
    return value
