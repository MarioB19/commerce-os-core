#!/usr/bin/env python3
"""Start one isolated, persistent clock observation after an authorized deployment.

Only synthetic configuration is created. Existing observations are never replaced
or restarted against a different image; their source SHA remains in the report.
"""
import datetime
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time

PROJECT = 'commerce-closure-soak'


def run(args, root):
    result = subprocess.run(args, cwd=root, text=True, capture_output=True, timeout=100)
    if result.returncode:
        raise RuntimeError('STAGING_COMMAND_FAILED')
    return result.stdout.strip()


def start(root, private, sha, execute=run, memory_bytes=None, disk_bytes=None):
    if not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise ValueError('INVALID_SOURCE_SHA')
    target = private / 'staging-soak'
    manifest = target / 'observation.json'
    if manifest.exists():
        # Preserve continuous evidence and its image, including after a later deploy.
        previous = json.loads(manifest.read_text())
        return {**previous, 'status': 'EXISTING_OBSERVATION', 'requested_source_sha': sha,
                'state_query': 'See operational-runbook.md; actual completion must be read from staging_soak_state.'}
    if memory_bytes is None:
        values = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        memory_bytes = int(values['MemAvailable'].split()[0]) * 1024
    if disk_bytes is None:
        disk_bytes = shutil.disk_usage(private).free
    if memory_bytes < 1024**3 or disk_bytes < 1024**3:
        return {'status': 'DEFERRED_CAPACITY', 'source_sha': sha, 'minimum_available_bytes': 1024**3}
    release = dict(line.split('=', 1) for line in (private / 'release.env').read_text().splitlines()
                   if line and not line.startswith('#'))
    image = release['COMMERCE_IMAGE']
    inspected = json.loads(execute(['docker', 'image', 'inspect', image], root))[0]
    if inspected['Os'] != 'linux' or inspected['Architecture'] != 'amd64' or not re.fullmatch(r'sha256:[a-f0-9]{64}', inspected['Id']):
        raise RuntimeError('STAGING_IMAGE_INVALID')
    if target.exists():
        # An interrupted setup may already have a volume. Preserve it for diagnosis.
        raise RuntimeError('STAGING_PARTIAL_SETUP_REQUIRES_REVIEW')
    target.mkdir(mode=0o700)
    password, key = secrets.token_hex(32), secrets.token_hex(32)
    config = {
        'POSTGRES_USER': 'commerce_owner', 'POSTGRES_DB': 'commerce_staging_soak',
        'POSTGRES_PASSWORD': password,
        'DATABASE_URL': f'postgresql://commerce_owner:{password}@postgres:5432/commerce_staging_soak',
        'DATA_ENCRYPTION_KEY': key, 'DB_POOL_MAX': '5', 'LOG_LEVEL': 'silent',
        'STAGING_SOAK_ISOLATED': 'true', 'DISPATCH_FROZEN': 'true',
        'REAL_SENDS_ENABLED': 'false', 'ALLOW_REAL_OPERATIONS': 'false',
    }
    (target / 'soak.env').write_text(''.join(f'{k}={v}\n' for k, v in config.items()))
    (target / 'compose.env').write_text(f'STAGING_CONFIG_DIR={target}\nSTAGING_IMAGE={inspected["Id"]}\nSTAGING_POSTGRES_MEMORY=256m\n')
    shutil.copyfile(root / 'infra/compose/staging-soak.yaml', target / 'compose.yaml')
    for file in target.iterdir():
        file.chmod(0o600)
    compose = ['docker', 'compose', '-p', PROJECT, '--env-file', str(target / 'compose.env'), '-f', str(target / 'compose.yaml')]
    execute([*compose, 'up', '-d', '--wait', '--wait-timeout', '75'], root)
    network = json.loads(execute(['docker', 'network', 'inspect', PROJECT + '_isolated'], root))[0]
    if network.get('Internal') is not True:
        execute([*compose, 'stop'], root)
        raise RuntimeError('STAGING_NETWORK_ISOLATION_FAILED')
    cid = execute([*compose, 'ps', '-q', 'observer'], root)
    observer = json.loads(execute(['docker', 'inspect', cid], root))[0]
    if not observer['State']['Running'] or observer['Image'] != inspected['Id'] or observer['HostConfig'].get('PortBindings'):
        execute([*compose, 'stop'], root)
        raise RuntimeError('STAGING_OBSERVER_VERIFICATION_FAILED')
    database = [*compose, 'exec', '-T', 'postgres', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'commerce_owner', '-d', 'commerce_staging_soak', '-c']
    sample = None
    for _ in range(20):
        exists = execute([*database, "SELECT to_regclass('public.staging_soak_state') IS NOT NULL"], root)
        if exists == 't':
            value = execute([*database, 'SELECT row_to_json(s) FROM staging_soak_state s'], root)
            sample = json.loads(value) if value else None
            if sample and sample['failures']:
                raise RuntimeError('STAGING_FIRST_SAMPLE_FAILED')
            if sample and sample['samples'] > 0:
                break
        time.sleep(2)
    if not sample or sample['samples'] < 1:
        raise RuntimeError('STAGING_FIRST_SAMPLE_PENDING')
    result = {'status': 'STARTED', 'source_sha': sha, 'runtime_image': inspected['Id'],
              'project': PROJECT, 'started_at': observer['State']['StartedAt'],
              'recorded_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'isolated_network': True, 'production_credentials': False, 'external_calls': 0,
              'required_observed_seconds': 86400, 'completion': 'PENDING_ACTUAL_OBSERVATION',
              'first_sample': {key: sample[key] for key in ['started_at', 'samples', 'failures', 'observed_seconds', 'status']}}
    manifest.write_text(json.dumps(result, sort_keys=True) + '\n')
    manifest.chmod(0o600)
    return result


if __name__ == '__main__':
    os.umask(0o077)
    if os.geteuid() != 0:
        raise SystemExit('ROOT_REQUIRED')
    print(json.dumps(start(Path.cwd(), Path('/opt/commerce-os/private'), sys.argv[1]), sort_keys=True))
