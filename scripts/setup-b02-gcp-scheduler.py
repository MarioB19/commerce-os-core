#!/usr/bin/env python3
"""Render the one finite B02 setup and verify its inactive native readback.

No create, IAM write, resume or delete action exists here. A valid_until after the
original 2026-11-04 end is the owner's single renewal (renewal=true in the plan).
Operators review the plan, provision separately, then supply authentic readback.
"""
import argparse
import datetime as dt
import stat
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
from b02_backup_contract import (TARGET, PROJECT_NUMBER, GCP_JOB, GCP_SCHEDULER, GCP_EXECUTOR, GCP_INVOKER,
    canonical, sha256, need, utc_time, gcp_binding, gcp_job_guard, gcp_job_reconciled, gcp_scheduler_guard, daily_cron,
    GCP_FINANCIAL_START, GCP_FINANCIAL_END, GCP_FINANCIAL_ORIGINAL_END)

FIELDS={'source_sha','image','sdk_image','schedule_utc','valid_until','bucket','plan_sha256','manual_creator','activation_id'}


def setup_plan(config):
    need(type(config) is dict and set(config)==FIELDS,'B02_SETUP_CONFIG_INVALID')
    need(re.fullmatch(r'[a-f0-9]{40}',config.get('source_sha',''))
         and re.fullmatch(r'us-east1-docker\.pkg\.dev/'+re.escape(TARGET[0])+r'/commerce-b02/transport@sha256:[a-f0-9]{64}',config.get('image',''))
         and re.fullmatch(r'gcr\.io/google\.com/cloudsdktool/google-cloud-cli@sha256:[a-f0-9]{64}',config.get('sdk_image','')),'B02_SETUP_IMAGE_PIN_REQUIRED')
    need(GCP_FINANCIAL_START < utc_time(config['valid_until']) <= GCP_FINANCIAL_END,'B02_SETUP_FINANCIAL_EXPIRY_INVALID')
    need(re.fullmatch(r'[a-f0-9]{64}',config.get('plan_sha256',''))
         and re.fullmatch(r'[a-z0-9][a-z0-9-]{4,61}[a-z0-9]',config.get('bucket',''))
         and re.fullmatch(r'[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+',config.get('manual_creator',''))
         and re.fullmatch(r'[a-z0-9][a-z0-9-]{7,63}',config.get('activation_id','')),'B02_SETUP_SCOPE_INVALID')
    task={'containers':[{'name':'transport','image':config['image'],'command':['python3','-B','/opt/commerce/scripts/b02-backup-gcp.py'],
        'env':[{'name':'B02_SOURCE_SHA','value':config['source_sha']}],
        'resources':{'limits':{'cpu':'2','memory':'8Gi'}},'volumeMounts':[{'name':'work','mountPath':'/work'}]}],
        'serviceAccount':GCP_EXECUTOR,'maxRetries':0,'timeout':'1800s','executionEnvironment':'EXECUTION_ENVIRONMENT_GEN2',
        'volumes':[{'name':'work','emptyDir':{'medium':'MEMORY','sizeLimit':'3Gi'}}]}
    job={'name':GCP_JOB,'template':{'taskCount':1,'parallelism':1,'template':task}}
    scheduler={'name':GCP_SCHEDULER,'schedule':daily_cron(config['schedule_utc']),'timeZone':'Etc/UTC',
        'attemptDeadline':'180s','httpTarget':{'headers':{'Content-Type':'application/json'},'uri':'https://run.googleapis.com/v2/'+GCP_JOB+':run','httpMethod':'POST',
            'oauthToken':{'serviceAccountEmail':GCP_INVOKER,'scope':'https://www.googleapis.com/auth/cloud-platform'},'body':'e30='},
        'retryConfig':{'retryCount':0,'maxRetryDuration':'0s','minBackoffDuration':'5s','maxBackoffDuration':'3600s','maxDoublings':5}}
    return {'kind':'B02_GCP_SETUP_PLAN','schema_version':1,'config':config,'job':job,'scheduler':scheduler,
        'scheduler_required_readback_state':'PAUSED','auto_activate':False,'cloud_mutations':0,
        'financial':{'valid_from':GCP_FINANCIAL_START.isoformat(),'valid_until':config['valid_until'],
            'usd_authorized_total_first_30d':125,'actions_usd':0,'remaining_budget_verified':False,
            'renewal':utc_time(config['valid_until'])>GCP_FINANCIAL_ORIGINAL_END},
        'iam_required':[{'principal':GCP_INVOKER,'resource':GCP_JOB,'role':'roles/run.invoker',
            'condition':"request.time < timestamp('"+(utc_time(config['valid_until'])-dt.timedelta(seconds=1800)).isoformat()+"')"},
            {'principal':GCP_EXECUTOR,'resource':TARGET[1],'role':'roles/compute.osAdminLogin'},
            {'principal':GCP_EXECUTOR,'resource':'iap_tunnel/'+TARGET[2]+'/'+ '6334472381123916728','role':'roles/iap.tunnelResourceAccessor','port':22},
            *[{'principal':GCP_EXECUTOR,'resource':'buckets/'+config['bucket'],'role':role} for role in
                ('roles/storage.objectCreator','roles/storage.objectViewer','roles/storage.bucketViewer')]],
        'remaining_native_gates':['actual_project_budget_and_expiry','remaining_shared_30_start_allowance','run_execution_task_read_only_permissions',
            'exact_vm_lookup_permissions','executor_oslogin_uid','artifact_pull_service_agent',
            'scheduler_service_agent','APIs_quotas','no_other_B02_agenda','registry_scanning_disabled'],
        'creation_order':['build_source_and_digest_verified','create_own_identities_and_registry_after_review',
            'create_job_without_execution','create_scheduler_then_pause_before_fixed_next_slot',
            'readback_PAUSED_and_Root_schedule_false','Root_observe_seal_apply_MANUAL',
            'manual_genuine_custody_and_restore','Root_observe_seal_apply_SCHEDULED',
            'resume_exact_scheduler_then_wait_natural_delivery'],
        'cost_notes':['The IAM invocation cutoff reserves the full 1800-second task budget before expiry.',
            'Paused Scheduler and retained registry still bill; binding expiry is not resource deletion.'],
        'expiry_cleanup':{'execute_before':config['valid_until'],'automatic':False,'future_operator_execution_required':True,
            'order':['pause exact own Scheduler and verify','verify own Job executions terminal',
                'delete own Scheduler and verify absent','delete own Job and verify absent',
                'delete only own transport image generations and empty dedicated repository; verify absent',
                'remove only own IAM grants and the two owned service identities; verify absent'],
            'preserve':['production VM','B02 bucket and immutable backup generations','Root journals and keys'],
            'proof_required':['names and immutable IDs match setup readback','provider delete operations terminal','resources absent','billing lag follow-up']},
        'extra_components':[]}


def readback(config, token, getter):
    plan=setup_plan(config)
    job=getter('https://run.googleapis.com/v2/'+GCP_JOB,token)
    scheduler=getter('https://cloudscheduler.googleapis.com/v1/'+GCP_SCHEDULER,token)
    # Binding is derived from actual provider identities, never fabricated IDs.
    task=job.get('template',{}).get('template',{})
    need(task.get('serviceAccount')==GCP_EXECUTOR,'B02_SETUP_EXECUTOR_CHANGED')
    # SA immutable numeric identity and POSIX identity must be separately observed;
    # do not guess a Unix user from its email. Return only the verified resource
    # portion until that explicit native prerequisite is supplied to bind().
    need(job.get('name')==GCP_JOB and job.get('template')==plan['job']['template']
         and gcp_job_reconciled(job)
         and not job.get('deleteTime'),'B02_SETUP_JOB_DRIFT')
    need(scheduler.get('state')=='PAUSED','B02_SETUP_SCHEDULER_MUST_BE_PAUSED')
    gcp_scheduler_guard({'scheduler':GCP_SCHEDULER,'schedule_utc':config['schedule_utc']},scheduler,paused=True)
    return {'status':'INACTIVE_RESOURCE_READBACK_VERIFIED','job':job,'scheduler':scheduler,
        'config_sha256':sha256(canonical(config)),'binding_ready':False,
        'pending':'AUTHENTIC_EXECUTOR_ID_AND_POSIX_PROFILE','cloud_mutations':0}


def bind(config, observed, profile, executor_id):
    setup_plan(config)
    need(observed.get('status')=='INACTIVE_RESOURCE_READBACK_VERIFIED'
         and observed.get('config_sha256')==sha256(canonical(config))
         and profile.get('name')==executor_id,'B02_SETUP_NATIVE_BINDING_INVALID')
    accounts=[r for r in profile.get('posixAccounts',[]) if r.get('operatingSystemType') in (None,'LINUX')]
    need(len(accounts)==1,'B02_SETUP_POSIX_AMBIGUOUS')
    row=accounts[0];job=observed['job']
    binding={key:config[key] for key in ('source_sha','image','schedule_utc','valid_until','bucket','plan_sha256','manual_creator','activation_id')}
    binding.update(schema_version=1,kind='B02_GCP_BINDING',mode='MANUAL',job=GCP_JOB,job_uid=job['uid'],
        job_generation=job['generation'],template_sha256=sha256(canonical(job['template'])),executor=GCP_EXECUTOR,
        executor_id=executor_id,oslogin_uid=int(row['uid']),oslogin_username=row['username'],invoker=GCP_INVOKER,
        scheduler=GCP_SCHEDULER,valid_from=GCP_FINANCIAL_START.isoformat(),first_custody_ref=None)
    gcp_binding(binding);gcp_job_guard(binding,job);gcp_scheduler_guard(binding,observed['scheduler'],paused=True)
    return binding


def write_new(path,value):
    info=path.parent.lstat()
    need(stat.S_ISDIR(info.st_mode) and not path.parent.is_symlink() and info.st_uid==os.geteuid()
         and stat.S_IMODE(info.st_mode)==0o700,'B02_SETUP_OUTPUT_CUSTODY_INVALID')
    raw=canonical(value)
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as stream:
        stream.write(raw);stream.flush();os.fsync(stream.fileno())
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)
    return {'path':str(path),'bytes':len(raw),'sha256':sha256(raw)}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=('prepared','plan','readback','bind'),default='prepared',nargs='?')
    parser.add_argument('--config');parser.add_argument('--output');parser.add_argument('--executor-id');args=parser.parse_args()
    if args.action=='prepared':print(json.dumps({'status':'PREPARED_ONLY','cloud_calls':0,'cloud_mutations':0}));return
    from b02_backup_contract import unique_json
    config=unique_json(Path(args.config).read_bytes());result=setup_plan(config)
    if args.action in ('readback','bind'):
        spec=importlib.util.spec_from_file_location('b02_setup_root_reader',Path(__file__).with_name('b02-backup-root.py'))
        native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
        request=unique_json(sys.stdin.buffer.read(16385));need(set(request)=={'access_token'},'B02_SETUP_TOKEN_STDIN_REQUIRED')
        try:
            result=readback(config,request['access_token'],native.google_get)
            if args.action=='bind':
                need(isinstance(args.executor_id,str) and re.fullmatch(r'[1-9][0-9]{10,30}',args.executor_id),'B02_SETUP_EXECUTOR_ID_INVALID')
                profile=native.google_get('https://oslogin.googleapis.com/v1/users/'+GCP_EXECUTOR+'/loginProfile?projectId='+TARGET[0],request['access_token'])
                result=bind(config,result,profile,args.executor_id)
        finally:request.clear()
    print(json.dumps({'status':result.get('status','PLAN_ONLY'),'output':write_new(Path(args.output),result),'cloud_mutations':0}))


if __name__=='__main__':
    try:main()
    except Exception as error:
        code=str(error) if isinstance(error,RuntimeError) and re.fullmatch(r'[A-Z0-9_]{1,100}',str(error)) else 'B02_SETUP_FAILED'
        print(json.dumps({'status':'STOP_PRESERVE','code':code}),file=sys.stderr);sys.exit(1)
