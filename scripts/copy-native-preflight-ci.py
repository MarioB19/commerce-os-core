#!/usr/bin/env python3
"""Closed manual WIF/IAP diagnostic; only a fixed public collector travels on stdin."""
import argparse
import datetime as dt
import ipaddress
import json
import os
from pathlib import Path
import re
import select
import subprocess
import sys
import tempfile
import time
from ephemeral_os_login import remove_ephemeral_key

REPOSITORY = 'MarioB19/commerce-os'
TARGET = ('project-c6f43813-9ac9-47ab-9fe', 'commerce-os-test', 'us-east1-d')
VM_ID = '6334472381123916728'
PROVIDER = 'projects/1065291779811/locations/global/workloadIdentityPools/commerce-copy-cd/providers/github-production'
SERVICE_ACCOUNT = 'commerce-copy-deploy@project-c6f43813-9ac9-47ab-9fe.iam.gserviceaccount.com'
DEADLINE = None
REMOTE = 'sudo /usr/bin/env PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -'
COLLECTOR = 'scripts/copy_native_preflight_root.py'
MAX_BYTES = 1024 * 1024
MAX_REPORT = 256 * 1024
ROOT = Path(__file__).resolve().parent.parent


def need(value, code):
    if not value:
        raise RuntimeError(code)


def command(args, input=None, timeout=60):
    """Bound both output and time; child stderr never leaves this transport."""
    child = None
    need(DEADLINE is None or time.monotonic() < DEADLINE, 'PREFLIGHT_COMMAND_TIMEOUT')
    try:
        child = subprocess.Popen(args, cwd=ROOT, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        expires = min(DEADLINE or time.monotonic()+timeout, time.monotonic()+timeout)
        offset = 0
        if input is not None:
            need(type(input) is bytes and len(input) <= 65536, 'PREFLIGHT_PUBLIC_PAYLOAD_INVALID')
            os.set_blocking(child.stdin.fileno(), False)
        raw = bytearray()
        input_open = input is not None
        while True:
            remaining = expires-time.monotonic()
            need(remaining > 0, 'PREFLIGHT_COMMAND_TIMEOUT')
            ready, writable, _ = select.select([child.stdout], [child.stdin] if input_open else [], [], remaining)
            need(bool(ready or writable), 'PREFLIGHT_COMMAND_TIMEOUT')
            if writable:
                offset += os.write(child.stdin.fileno(), input[offset:offset+4096])
                if offset == len(input):
                    child.stdin.close(); input_open = False
            if ready:
                chunk = os.read(child.stdout.fileno(), 65536)
                if not chunk:
                    break
                raw.extend(chunk); need(len(raw) <= MAX_BYTES, 'PREFLIGHT_OUTPUT_BOUND')
        need(not input_open, 'PREFLIGHT_PAYLOAD_NOT_CONSUMED')
        code = child.wait(timeout=max(0.1, expires-time.monotonic()))
        return subprocess.CompletedProcess(args, code, raw.decode('utf-8'), '')
    except (OSError, UnicodeError, subprocess.SubprocessError):
        raise RuntimeError('PREFLIGHT_COMMAND_FAILED') from None
    finally:
        if child is not None:
            if child.poll() is None:
                child.kill()
            child.stdout.close()
            if child.stdin is not None and not child.stdin.closed:
                child.stdin.close()
            child.wait(timeout=5)


def success(args, **kwargs):
    result = command(args, **kwargs)
    need(result.returncode == 0, 'PREFLIGHT_COMMAND_FAILED')
    return result.stdout


def parse(raw):
    def unique(values):
        result = {}
        for key, value in values:
            need(key not in result, 'PREFLIGHT_JSON_INVALID'); result[key] = value
        return result
    need(type(raw) is str and len(raw.encode()) <= MAX_BYTES, 'PREFLIGHT_OUTPUT_BOUND')
    try:
        return json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(RuntimeError('PREFLIGHT_JSON_INVALID')))
    except (ValueError, RecursionError):
        raise RuntimeError('PREFLIGHT_JSON_INVALID') from None


def config(env):
    need(env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and env.get('COPY_PREFLIGHT_MODE') == 'copy-preflight', 'PREFLIGHT_MANUAL_REQUIRED')
    need(env.get('GITHUB_REPOSITORY') == REPOSITORY and env.get('GITHUB_REF') == 'refs/heads/main'
         and env.get('GITHUB_WORKFLOW_REF') == REPOSITORY + '/.github/workflows/ci.yml@refs/heads/main', 'PREFLIGHT_MAIN_REQUIRED')
    sha = env.get('COPY_PREFLIGHT_EXPECTED_SHA', '')
    need(re.fullmatch(r'[a-f0-9]{40}', sha) and sha == env.get('GITHUB_SHA'), 'PREFLIGHT_EXACT_SHA_REQUIRED')
    need(tuple(env.get(key) for key in ('GCP_PROJECT_ID', 'GCP_INSTANCE', 'GCP_ZONE')) == TARGET, 'PREFLIGHT_TARGET_REQUIRED')
    need(env.get('GCP_WORKLOAD_IDENTITY_PROVIDER') == PROVIDER and env.get('GCP_DEPLOY_SERVICE_ACCOUNT') == SERVICE_ACCOUNT, 'PREFLIGHT_EXISTING_IDENTITY_REQUIRED')
    need(not env.get('COPY_PREFLIGHT_INPUT_JSON') and not env.get('COPY_PREFLIGHT_RETURN_PUBLIC_KEY')
         and env.get('COPY_PREFLIGHT_ACTION', 'inspect') in ('', 'inspect'), 'PREFLIGHT_UNUSED_INPUT_REQUIRED')
    run_id = env.get('GITHUB_RUN_ID', '') + '-' + env.get('GITHUB_RUN_ATTEMPT', '')
    need(re.fullmatch(r'[1-9][0-9]*-[1-9][0-9]*', run_id), 'PREFLIGHT_RUN_REQUIRED')
    return {'sha': sha, 'run_id': run_id}


def verify_main(value):
    need(success(['gh', 'api', 'repos/' + REPOSITORY + '/commits/main', '--jq', '.sha']).strip() == value['sha'], 'PREFLIGHT_SUPERSEDED')
    need(success(['git', 'rev-parse', 'HEAD']).strip() == value['sha'], 'PREFLIGHT_CHECKOUT_MISMATCH')


def payload(value):
    immutable = success(['git', 'show', value['sha'] + ':' + COLLECTOR]).encode()
    need(0 < len(immutable) <= 65536 and (ROOT / COLLECTOR).read_bytes() == immutable, 'PREFLIGHT_COLLECTOR_SOURCE_MISMATCH')
    return immutable


def vm_report(raw):
    value = parse(raw)
    need(type(value) is dict and str(value.get('id')) == VM_ID and value.get('name') == TARGET[1]
         and value.get('zone') == 'https://www.googleapis.com/compute/v1/projects/' + TARGET[0] + '/zones/' + TARGET[2], 'PREFLIGHT_INSTANCE_IDENTITY_MISMATCH')
    status = value.get('status') if value.get('status') in {'RUNNING', 'STOPPING', 'STOPPED', 'TERMINATED', 'STAGING', 'PROVISIONING', 'SUSPENDED', 'SUSPENDING'} else 'UNKNOWN'
    machine = str(value.get('machineType', '')).split('/')[-1]
    machine = machine if machine == 'e2-standard-4' else 'UNKNOWN'
    return {'project': TARGET[0], 'name': TARGET[1], 'id': VM_ID, 'zone': TARGET[2], 'status': status, 'machine_type': machine}


def public_report(value):
    """A second allowlist prevents raw remote strings from reaching CI logs."""
    from copy_native_preflight_root import STATUSES, SERVICES, ENV_NAMES, REASONS
    need(type(value) is dict and set(value) == {'schema_version', 'status', 'observed_at', 'business_mutations', 'configuration_mutations', 'backup_executed', 'installed', 'readiness_proven', 'snapshot_atomic', 'current_release', 'files', 'deployment_journals', 'backup_journals', 'controller_journals', 'containers', 'networks', 'volumes', 'disk'}, 'PREFLIGHT_REPORT_SHAPE_INVALID')
    need(type(value['schema_version']) is int and value['schema_version'] == 1 and value['status'] in {'OBSERVED', 'OBSERVED_PARTIAL'}
         and type(value['business_mutations']) is int and value['business_mutations'] == 0
         and type(value['configuration_mutations']) is int and value['configuration_mutations'] == 0
         and all(value[key] is False for key in ('backup_executed', 'installed', 'readiness_proven', 'snapshot_atomic')), 'PREFLIGHT_REPORT_CLAIM_INVALID')
    keys = {'schema_version', 'status', 'observed_at', 'business_mutations', 'configuration_mutations', 'backup_executed', 'installed', 'readiness_proven', 'snapshot_atomic', 'current_release', 'files', 'deployment_journals', 'backup_journals', 'controller_journals', 'containers', 'networks', 'volumes', 'disk', 'reason', 'sha256', 'bytes', 'uid', 'mode', 'nlink', 'document_status', 'runtime_stage', 'scope', 'source_sha', 'release_sha256', 'metadata_sha256', 'entries', 'name_sha256', 'run_id', 'observation', 'items', 'id', 'image_id', 'service', 'running', 'pid', 'env_sha256', 'definition_sha256', 'ports', 'container_port', 'host_ip', 'host_port', 'driver', 'internal', 'ipam', 'container_ids', 'subnet', 'gateway', 'available_bytes'}
    keys |= set(ENV_NAMES) | {'api-web-adoption.json', 'daily-b02/plan.json'}
    def validate(item, key='', depth=0):
        need(depth <= 12, 'PREFLIGHT_REPORT_BOUND')
        if type(item) is dict:
            need(len(item) <= 100 and set(item) <= keys, 'PREFLIGHT_REPORT_SHAPE_INVALID')
            for child_key, child in item.items():
                validate(child, child_key, depth+1)
        elif type(item) is list:
            need(len(item) <= 100, 'PREFLIGHT_REPORT_BOUND')
            for child in item:
                validate(child, 'id' if key == 'container_ids' else key, depth+1)
        elif item is None or type(item) is bool:
            return
        elif type(item) is int:
            need(0 <= item <= 2**63-1, 'PREFLIGHT_REPORT_BOUND')
        elif type(item) is str:
            if key.endswith('sha256') or key == 'id':
                need(re.fullmatch(r'[a-f0-9]{64}', item), 'PREFLIGHT_REPORT_VALUE_INVALID')
            elif key == 'source_sha':
                need(re.fullmatch(r'[a-f0-9]{40}', item), 'PREFLIGHT_REPORT_VALUE_INVALID')
            elif key == 'image_id':
                need(re.fullmatch(r'sha256:[a-f0-9]{64}', item), 'PREFLIGHT_REPORT_VALUE_INVALID')
            elif key in {'host_ip', 'gateway', 'subnet'}:
                if item or key != 'host_ip':
                    (ipaddress.ip_network if key == 'subnet' else ipaddress.ip_address)(item)
            elif key == 'observed_at':
                timestamp = dt.datetime.fromisoformat(item); need(timestamp.utcoffset() == dt.timedelta(0), 'PREFLIGHT_REPORT_VALUE_INVALID')
            elif key == 'run_id':
                need(re.fullmatch(r'[1-9][0-9]*-[1-9][0-9]*', item), 'PREFLIGHT_REPORT_VALUE_INVALID')
            elif key == 'container_port':
                need(re.fullmatch(r'[1-9][0-9]{0,4}/(?:tcp|udp)', item), 'PREFLIGHT_REPORT_VALUE_INVALID')
            else:
                allowed = {'status': STATUSES | {'UNKNOWN', 'OBSERVED', 'OBSERVED_PARTIAL'}, 'reason': REASONS,
                           'document_status': STATUSES, 'runtime_stage': {'CORE_PREPARED', 'OPERATING'},
                           'scope': {'api-web', 'copy-runtime'}, 'service': SERVICES | {'portal'}, 'driver': {'local', 'bridge', 'host', 'null'}}
                need(item in allowed.get(key, set()), 'PREFLIGHT_REPORT_VALUE_INVALID')
        else:
            raise RuntimeError('PREFLIGHT_REPORT_VALUE_INVALID')
    validate(value)
    need(len(json.dumps(value).encode()) <= MAX_REPORT, 'PREFLIGHT_REPORT_BOUND')
    return value


def execute(value):
    global DEADLINE
    verify_main(value); source = payload(value)
    need(success(['gcloud', 'auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']).strip() == SERVICE_ACCOUNT, 'PREFLIGHT_AUTHENTICATED_IDENTITY_REQUIRED')
    vm_raw = success(['gcloud', 'compute', 'instances', 'describe', TARGET[1], '--project=' + TARGET[0], '--zone=' + TARGET[2], '--format=json(id,name,status,zone,machineType,metadata.items)', '--quiet'])
    machine = vm_report(vm_raw)
    vm_metadata = parse(vm_raw).get('metadata', {}).get('items', [])
    need(type(vm_metadata) is list and len(vm_metadata) <= 100, 'PREFLIGHT_VM_METADATA_INVALID')
    flags = [item.get('value') for item in vm_metadata if type(item) is dict and item.get('key') == 'enable-oslogin']
    need(len(flags) <= 1, 'PREFLIGHT_VM_METADATA_INVALID')
    if not flags:
        project = parse(success(['gcloud', 'compute', 'project-info', 'describe', '--project=' + TARGET[0], '--format=json(commonInstanceMetadata.items)', '--quiet']))
        items = project.get('commonInstanceMetadata', {}).get('items', [])
        need(type(items) is list and len(items) <= 100, 'PREFLIGHT_VM_METADATA_INVALID')
        flags = [item.get('value') for item in items if type(item) is dict and item.get('key') == 'enable-oslogin']
    need(len(flags) == 1 and type(flags[0]) is str and flags[0].upper() == 'TRUE', 'PREFLIGHT_OS_LOGIN_REQUIRED')
    machine['os_login_enabled'] = True
    verify_main(value)
    directory = Path(tempfile.mkdtemp(prefix='commerce-copy-preflight-' + value['run_id'] + '-', dir=os.environ['RUNNER_TEMP']))
    key = directory / 'iap-key'; registered = False; cleanup = None
    try:
        success(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'commerce-copy-preflight-' + value['run_id'], '-f', str(key)])
        need(key.exists() and key.with_suffix('.pub').exists(), 'PREFLIGHT_KEY_PREPARATION_FAILED')
        verify_main(value)
        registered = True
        response = command(['gcloud', 'compute', 'ssh', TARGET[1], '--project=' + TARGET[0], '--zone=' + TARGET[2],
                            '--tunnel-through-iap', '--quiet', '--ssh-key-file=' + str(key), '--ssh-key-expire-after=15m',
                            '--command=' + REMOTE, '--ssh-flag=-T'], input=source, timeout=180)
        need(response.returncode == 0, 'PREFLIGHT_NATIVE_READ_FAILED')
        report = public_report(parse(response.stdout)); verify_main(value)
    finally:
        try:
            if registered:
                # Reserve cleanup independently of the expired read budget.
                DEADLINE = time.monotonic() + 190
                cleanup = remove_ephemeral_key(key.with_suffix('.pub').read_text(), command)
        finally:
            key.unlink(missing_ok=True); key.with_suffix('.pub').unlink(missing_ok=True)
            directory.rmdir()
    need(cleanup is not None and cleanup['key_absent_verified'] is True, 'PREFLIGHT_KEY_CLEANUP_REQUIRED')
    return {'schema_version': 1, 'status': 'NATIVE_DIAGNOSTIC_OBSERVED', 'source_sha': value['sha'], 'run_id': value['run_id'],
            'vm': machine, 'native': report, 'ephemeral_key_absent_verified': True, 'new_iam_grants': 0,
            'oauth_app_grants': 0, 'backup_executed': False, 'installed': False, 'readiness_proven': False}


def main():
    global DEADLINE
    parser = argparse.ArgumentParser(); parser.add_argument('--preflight', action='store_true'); args = parser.parse_args()
    DEADLINE = time.monotonic() + (90 if args.preflight else 300)
    value = config(os.environ); verify_main(value); payload(value)
    if args.preflight:
        print(json.dumps({'status': 'COPY_PREFLIGHT_INPUTS_VALIDATED', 'source_sha': value['sha'], 'Cloud_calls': 0})); return
    print(json.dumps(execute(value), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'PREFLIGHT_[A-Z_]{1,70}', str(error)) else 'PREFLIGHT_FAILED_UNKNOWN'
        print(json.dumps({'status': 'UNKNOWN', 'code': code, 'readiness_proven': False}), file=sys.stderr)
        raise SystemExit(1)
