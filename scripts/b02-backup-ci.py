#!/usr/bin/env python3
"""Existing CI WIF/IAP identity transports encrypted B02, never a backup key."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import signal
import stat
import subprocess
import sys
import time
from b02_backup_contract import (DAILY, MAX_BYTES, TARGET, VM_ID, need, sha256, transport_config,
    unique_json, validate_bucket, validate_custody, export_names, ciphertext_header)
from ephemeral_os_login import remove_ephemeral_key


def command(args, *, timeout=180, check=True, failure_code='B02_TRANSPORT_COMMAND_FAILED', input=None):
    """A private process group per command; timeout never leaves owned SSH/SCP."""
    need(failure_code in {'B02_TRANSPORT_COMMAND_FAILED', 'B02_DISCARD_EXPORT_COMMAND_FAILED',
         'B02_OS_LOGIN_CLEANUP_COMMAND_FAILED'}, 'B02_TRANSPORT_FAILURE_CODE_INVALID')
    need(type(timeout) in (int, float) and 0 < timeout <= 1800, 'B02_COMMAND_DEADLINE_INVALID')
    child = None
    try:
        child = subprocess.Popen(args, text=True, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        stdout, stderr = child.communicate(input=input, timeout=timeout)
        need(len(stdout.encode()) + len(stderr.encode()) <= 4*1024**2, 'B02_COMMAND_OUTPUT_BOUND')
        result = subprocess.CompletedProcess(args, child.returncode, stdout, stderr)
    except (OSError, subprocess.SubprocessError):
        unknown = failure_code.removesuffix('_COMMAND_FAILED') + '_UNKNOWN_PRESERVE'
        raise RuntimeError(unknown) from None
    finally:
        if child is not None:
            # The session cannot contain a pre-existing or unrelated child. Kill
            # descendants even if gcloud itself already exited. Remote systemd
            # and the journal are reconciled independently, never assumed stopped.
            try: os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: child.wait(timeout=2)
            except subprocess.TimeoutExpired: pass
            try: os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            child.wait(timeout=5)
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream is not None: stream.close()
    if check: need(result.returncode == 0, failure_code)
    return result


def local_reference(path, *, ciphertext=False, header=b'COMOSB02'):
    path = Path(path)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source:
        info = os.fstat(source.fileno())
        need(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1
             and stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= MAX_BYTES, 'B02_RUNNER_FILE_CUSTODY_INVALID')
        if ciphertext:
            need(source.read(8) == header and info.st_size > 36, 'B02_RUNNER_CIPHERTEXT_REQUIRED'); source.seek(0)
        digest = hashlib.sha256()
        for block in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(block)
        fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_uid', 'st_mode', 'st_nlink')
        signature = lambda value: tuple(getattr(value, key) for key in fields)
        need(signature(info) == signature(os.fstat(source.fileno())) == signature(path.lstat()), 'B02_RUNNER_FILE_CHANGED')
    return {'bytes': info.st_size, 'sha256': digest.hexdigest()}


def export_reference(path, name):
    header = ciphertext_header(name)
    if header == b'COMOSP01':
        return local_reference(path, ciphertext=True, header=header)
    return local_reference(path, ciphertext=header is not None)


def verify_instance(stdout):
    value = unique_json(stdout)
    need(str(value.get('id')) == VM_ID and value.get('name') == TARGET[1]
         and value.get('zone') == 'https://www.googleapis.com/compute/v1/projects/' + TARGET[0] + '/zones/' + TARGET[2]
         and value.get('status') == 'RUNNING', 'B02_INSTANCE_IDENTITY_MISMATCH')


def upload_verified(path, uri, readback, runner=command):
    expected = export_reference(path, path.name)
    # An unknown create is reconciled by its exact immutable object; never overwrite or re-upload.
    try:
        result = runner(['gcloud', 'storage', 'cp', '--if-generation-match=0', str(path), uri, '--quiet'], check=False)
        created = result.returncode == 0
    except RuntimeError:
        created = False
    metadata = unique_json(runner(['gcloud', 'storage', 'objects', 'describe', uri, '--format=json']).stdout)
    generation = str(metadata.get('generation', ''))
    need(generation.isdigit() and int(generation) > 0 and str(metadata.get('size')) == str(expected['bytes']), 'B02_OBJECT_METADATA_MISMATCH')
    runner(['gcloud', 'storage', 'cp', uri + '#' + generation, str(readback), '--quiet'])
    readback.chmod(0o600)
    need(export_reference(readback, path.name) == expected, 'B02_FULL_OBJECT_HASH_MISMATCH')
    readback.unlink()
    return expected | {'generation': generation, 'full_download_verified': True, 'create_command_succeeded': created}


def main_head(config):
    need(command(['gh', 'api', 'repos/MarioB19/commerce-os/commits/main', '--jq', '.sha']).stdout.strip()
         == config['source_sha'], 'SUPERSEDED_COMMIT')


def unit_state(stdout, returncode=0):
    if returncode != 0:
        return 'UNKNOWN'
    values = dict(line.split('=', 1) for line in stdout.splitlines() if '=' in line)
    pid = values.get('MainPID', '')
    if not pid.isdigit():
        return 'UNKNOWN'
    if int(pid) > 0 or values.get('ActiveState') in ('active', 'activating', 'deactivating', 'reloading'):
        return 'RUNNING'
    if int(pid) == 0 and values.get('ActiveState') in ('inactive', 'failed') and values.get('LoadState') in ('loaded', 'not-found'):
        return 'TERMINAL'
    return 'UNKNOWN'


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--preflight', action='store_true'); args = parser.parse_args()
    config = transport_config(os.environ); main_head(config)
    root = Path(__file__).resolve().parent
    for name, key in (('b02-backup-root.py', 'controller_sha256'), ('b02_backup_contract.py', 'contract_sha256')):
        need(sha256((root / name).read_bytes()) == config[key], 'B02_REVIEWED_CONTROLLER_SOURCE_REQUIRED')
    if args.preflight:
        print(json.dumps({'status': 'B02_TRANSPORT_PREFLIGHT_VERIFIED', 'Cloud_calls': 0,
            'run_id': config['run_id'], 'source_sha': config['source_sha']})); return
    os.umask(0o077)
    work = Path(os.environ['RUNNER_TEMP']) / ('commerce-b02-' + config['run_id']); work.mkdir(mode=0o700)
    key = work / 'iap-key'; registered = False; complete = False; result_public = None
    base = ['--project=' + TARGET[0], '--zone=' + TARGET[2], '--tunnel-through-iap', '--quiet', '--ssh-key-file=' + str(key)]
    def ssh(text, *, check=True, failure_code='B02_TRANSPORT_COMMAND_FAILED'):
        return command(['gcloud', 'compute', 'ssh', TARGET[1], *base, '--ssh-key-expire-after=30m', '--command=' + text], check=check, failure_code=failure_code)
    root_command = 'sudo /usr/bin/python3 ' + str(DAILY / 'b02-backup-root.py')
    identity = ' --plan-sha256 ' + config['plan_sha256'] + ' --run-id ' + config['run_id']
    def report():
        value = ssh(root_command + ' status' + identity, check=False)
        need(value.returncode == 0, 'B02_REMOTE_REPORT_UNKNOWN_PRESERVE')
        candidate = unique_json(value.stdout)
        if candidate.get('status') == 'NOT_STARTED':
            need(candidate == {'status': 'NOT_STARTED', 'run_id': config['run_id'], 'plan_sha256': config['plan_sha256']}, 'B02_REMOTE_REPORT_IDENTITY_MISMATCH')
            return None
        need(candidate['run_id'] == config['run_id'] and candidate['source_sha'] == config['source_sha']
             and candidate['plan_sha256'] == config['plan_sha256'], 'B02_REMOTE_REPORT_IDENTITY_MISMATCH')
        return candidate
    try:
        verify_instance(command(['gcloud', 'compute', 'instances', 'describe', TARGET[1],
            '--project=' + TARGET[0], '--zone=' + TARGET[2], '--format=json', '--quiet']).stdout)
        bucket = validate_bucket(unique_json(command(['gcloud', 'storage', 'buckets', 'describe',
            'gs://' + config['bucket'], '--raw', '--format=json', '--quiet']).stdout), config['bucket'])
        command(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)])
        registered = True
        # Hash validation precedes invoking the installed root controller.
        checks = config['controller_sha256'] + '  ' + str(DAILY / 'b02-backup-root.py') + '\n' + config['contract_sha256'] + '  ' + str(DAILY / 'b02_backup_contract.py') + '\n'
        ssh('printf %s ' + shlex.quote(checks) + ' | sudo sha256sum --check --status')
        main_head(config)
        unit = 'commerce-b02-' + config['run_id']
        previous = report()
        if previous is None:
            state = ssh('sudo systemctl show ' + unit + '.service --property=LoadState --property=ActiveState --property=MainPID --no-pager', check=False)
            need(unit_state(state.stdout, state.returncode) == 'TERMINAL', 'B02_REMOTE_START_UNKNOWN_PRESERVE')
            # One detached dispatch only. A lost response is followed by reads, not another start.
            try:
                ssh('sudo systemd-run --quiet --collect --unit=' + unit + ' --property=RuntimeMaxSec=1650 '
                    '--property=TimeoutStopSec=60 --property=UMask=0077 /usr/bin/python3 '
                    + str(DAILY / 'b02-backup-root.py') + ' execute' + identity + ' --source-sha ' + config['source_sha']
                    + (' --scheduled' if config['scheduled'] else ''), check=False)
            except RuntimeError:
                pass
        deadline = time.monotonic() + 1660
        current = previous
        while current is None or current.get('status') == 'RUNNING':
            need(time.monotonic() < deadline, 'B02_REMOTE_TIMEOUT_UNKNOWN_PRESERVE')
            time.sleep(5); current = report()
        need(current['status'] == 'LOCAL_CUSTODY_PENDING', 'B02_REMOTE_LOCAL_CUSTODY_REQUIRED')
        state = ssh('sudo systemctl show ' + unit + '.service --property=LoadState --property=ActiveState --property=MainPID --no-pager', check=False)
        need(unit_state(state.stdout, state.returncode) == 'TERMINAL', 'B02_REMOTE_TASK_NOT_TERMINAL')
        fresh = report(); need(fresh == current, 'B02_REMOTE_FINAL_REPORT_CHANGED')
        ssh(root_command + ' export' + identity)
        objects = {}
        names = export_names(current)
        for name in names:
            file = work / name
            command(['gcloud', 'compute', 'scp', *base, TARGET[1] + ':~/commerce-b02-' + config['run_id'] + '/' + name, str(file)])
            file.chmod(0o600)
            expected = {field: current['exports'][name][field] for field in ('bytes', 'sha256')}
            need(export_reference(file, name) == expected, 'B02_VM_RUNNER_HASH_MISMATCH')
            object_name = 'b02/daily/' + config['run_id'] + '/' + name
            verified = upload_verified(file, 'gs://' + config['bucket'] + '/' + object_name, work / ('readback-' + name))
            objects[name] = verified | {'object': object_name}
        need(sum(obj['bytes'] for obj in objects.values()) <= MAX_BYTES, 'B02_TOTAL_COST_SIZE_LIMIT')
        custody = {'status': 'B02_OFFHOST_CUSTODY_VERIFIED', 'run_id': config['run_id'], 'source_sha': config['source_sha'],
            'plan_sha256': config['plan_sha256'], 'bucket': config['bucket'], 'bucket_configuration': bucket, 'objects': objects,
            'keys_exported': False, 'plaintext_exported': False, 'restore_verified': False}
        if current.get('backup_contract_version', 1) == 2:
            custody.update(backup_contract_version=2, backup_decryption_key_exported=False,
                portal_credentials_archived_encrypted=True, portal_capsule=current['portal_capsule'])
        validate_custody(custody, current, config['bucket'])
        receipt = work / 'custody.json'; receipt.write_text(json.dumps(custody, sort_keys=True) + '\n'); receipt.chmod(0o600)
        upload_verified(receipt, 'gs://' + config['bucket'] + '/b02/daily/' + config['run_id'] + '/custody.json', work / 'readback-custody.json')
        command(['gcloud', 'compute', 'scp', *base, str(receipt), TARGET[1] + ':~/commerce-b02-' + config['run_id'] + '/custody.json'])
        ack = unique_json(ssh(root_command + ' ack' + identity + ' --receipt-sha256 ' + sha256(receipt.read_bytes())).stdout)
        need(ack['status'] == 'SUCCEEDED' and ack['external_copy_verified'] is True, 'B02_REMOTE_CUSTODY_ACK_REQUIRED')
        complete = True
        ssh(root_command + ' discard-export' + identity, failure_code='B02_DISCARD_EXPORT_COMMAND_FAILED')
        result_public = {'status': 'B02_DAILY_OFFSITE_VERIFIED', 'run_id': config['run_id'], 'source_sha': config['source_sha'],
            'ciphertext': objects['ciphertext.backup.aes'], 'keys_exported': False, 'restore_verified': False}
        if current.get('backup_contract_version', 1) == 2:
            result_public.update(backup_contract_version=2, portal_ciphertext=objects['portal.backup.aes'],
                backup_decryption_key_exported=False, portal_credentials_archived_encrypted=True,
                portal_capsule=current['portal_capsule'])
    finally:
        try:
            if registered:
                def key_command(args):
                    return command(args, failure_code='B02_OS_LOGIN_CLEANUP_COMMAND_FAILED')
                remove_ephemeral_key(key.with_suffix('.pub').read_text(), key_command)
        finally:
            key.unlink(missing_ok=True); key.with_suffix('.pub').unlink(missing_ok=True)
            # Keep ciphertext/receipts on incomplete runs for exact reconciliation.
            if complete:
                for name in (*export_names(current), 'custody.json'):
                    (work / name).unlink(missing_ok=True)
    print(json.dumps(result_public))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and __import__('re').fullmatch(r'[A-Z0-9_]{1,100}', str(error)) else type(error).__name__
        print(json.dumps({'status': 'STOP_PRESERVE', 'code': code}), file=sys.stderr); sys.exit(1)
