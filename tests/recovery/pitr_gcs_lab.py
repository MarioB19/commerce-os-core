#!/usr/bin/env python3
"""Local laboratory for the V7 PITR operator against a GCS-protocol repository.

Synthetic only: a local Docker engine, fake-gcs-server and throwaway volumes.
Runs the real scripts/v7_pitr.py through the real scripts/compose-release.sh
(api-web scope, production.yaml + copy-api-web.yaml + postgres-pitr.yaml) and
asserts every step. Never touches cloud resources or production paths.

  python3 tests/recovery/pitr_gcs_lab.py <empty-work-dir> [--keep]
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FAKE_GCS = 'fsouza/fake-gcs-server:1.52.2'
BASE = 'postgres:17.11-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826'
BUCKET = 'commerce-v7-pitr-lab'
NETWORKS = {'commerce-os_core': ['--internal'], 'pitrlab-proxy': ['--internal'], 'pitrlab-edge': []}


def sh(*argv, check=True, input=None, env=None, timeout=900):
    result = subprocess.run(argv, capture_output=True, input=input, env=env, timeout=timeout, cwd=ROOT)
    if check and result.returncode != 0:
        raise SystemExit('FAILED ' + ' '.join(argv[:6]) + '\n' + result.stderr.decode()[-2000:] + result.stdout.decode()[-2000:])
    return result


def operator(config, *args, expect=0):
    result = sh(sys.executable, '-I', 'scripts/v7_pitr.py', str(config), *args, check=False, timeout=3600)
    out = result.stdout.decode().strip().splitlines()
    value = json.loads(out[-1]) if out else {}
    if result.returncode != expect:
        raise SystemExit('operator ' + ' '.join(args) + ' exited ' + str(result.returncode) + ': ' + json.dumps(value)[:3000]
                         + '\n' + result.stderr.decode()[-2000:])
    return value


def psql(sql):
    cid = sh('docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=commerce-os',
             '--filter', 'label=com.docker.compose.service=postgres').stdout.decode().split()[0]
    return sh('docker', 'exec', '-i', cid, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'commerce_owner', '-d', 'commerce',
              input=sql.encode()).stdout.decode().strip()


def cleanup():
    ids = sh('docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=commerce-os', check=False).stdout.decode().split()
    ids += sh('docker', 'ps', '-aq', '--filter', 'label=com.inovaris.commerce.role=pitr-rehearsal', check=False).stdout.decode().split()
    ids += sh('docker', 'ps', '-aq', '--filter', 'name=^pitrlab-gcs$', check=False).stdout.decode().split()
    if ids:
        sh('docker', 'rm', '-f', '-v', *ids, check=False)
    for volume in ('commerce-os_pg', 'commerce-os_pitr-spool'):
        sh('docker', 'volume', 'rm', volume, check=False)
    for network in [*NETWORKS, 'commerce-os_pitr-edge']:
        sh('docker', 'network', 'rm', network, check=False)


def main():
    work = Path(sys.argv[1]).resolve()
    keep = '--keep' in sys.argv
    work.mkdir(mode=0o700, exist_ok=True)
    assert not any(work.iterdir()), 'empty work directory required'
    private = work / 'private'
    private.mkdir(mode=0o700)
    pitr = private / 'pitr'
    locks = work / 'locks'
    locks.mkdir(mode=0o700)
    cleanup()
    evidence = {'state': 'LAB_STARTED', 'production_data': False, 'cloud_effects': 0}
    try:
        for name, flags in NETWORKS.items():
            sh('docker', 'network', 'create', '--driver', 'bridge', *flags, name)
        sh('docker', 'volume', 'create', 'commerce-os_pg')
        env = {
            'COMMERCE_SECRETS_DIR': str(private), 'COMMERCE_DEPLOY_SCOPE': 'api-web',
            'COMMERCE_POSTGRES_IMAGE': BASE, 'COMMERCE_PROXY_NETWORK': 'pitrlab-proxy',
            'COMMERCE_API_EDGE_NETWORK': 'pitrlab-edge', 'COMMERCE_IMAGE': 'lab-unused', 'COMMERCE_WEB_IMAGE': 'lab-unused',
        }
        for line in (ROOT / 'infra/compose/production.yaml').read_text().split('${')[1:]:
            name = line.split(':')[0].split('}')[0]
            env.setdefault(name, str(work / 'unused'))
        (private / 'release.env').write_text(''.join(k + '=' + v + '\n' for k, v in sorted(env.items())))
        (private / 'postgres.env').write_text('POSTGRES_USER=commerce_owner\nPOSTGRES_DB=commerce\nPOSTGRES_PASSWORD=lab-only-not-secret\n')
        for name in ('api', 'ingress', 'automation', 'channel', 'admin', 'backup', 'api-web-adoption'):
            (private / (name + ('.json' if name == 'api-web-adoption' else '.env'))).write_text('{}\n' if name == 'api-web-adoption' else '')
        compose = ['sh', 'scripts/compose-release.sh', str(private / 'release.env')]
        sh(*compose, 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'postgres')
        psql((ROOT / 'packages/db/migrations/0111_v7_platform_recovery.sql').read_text())
        psql("CREATE TABLE notes(id integer PRIMARY KEY, body text NOT NULL);"
             "INSERT INTO notes VALUES(1, 'PLAINTEXT-CANARY-' || md5('commerce-pitr-lab'));"
             "CREATE TABLE payments(id integer PRIMARY KEY, amount_cents bigint NOT NULL);"
             "CREATE TABLE schema_migrations(name text PRIMARY KEY, sha256 text);"
             "INSERT INTO schema_migrations VALUES('0110_v7_meta_profile_sync.sql','x');"
             "INSERT INTO payments SELECT g, g*100 FROM generate_series(1,5000) g;")
        # pitr-edge is created here, with the operator's options, so the fake
        # GCS endpoint can join it; the operator verifies the same options.
        sh('docker', 'network', 'create', '--driver', 'bridge', '--opt', 'com.docker.network.bridge.enable_icc=false',
           '--opt', 'com.docker.network.bridge.enable_ip_masquerade=true', '--opt',
           'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', '--label', 'com.inovaris.commerce.role=pitr-edge',
           'commerce-os_pitr-edge')
        data = work / 'gcs-data' / BUCKET
        data.mkdir(parents=True)
        os.chmod(work / 'gcs-data', 0o755)
        os.chmod(data, 0o777)
        # Inter-container traffic is disabled on pitr-edge (enable_icc=false), as
        # in production: the container only reaches the outside through NAT. The
        # fake endpoint listens on the host, reached at the bridge gateway.
        gateway = json.loads(sh('docker', 'network', 'inspect', 'commerce-os_pitr-edge').stdout)[0]['IPAM']['Config'][0]['Gateway']
        sh('docker', 'run', '-d', '--name', 'pitrlab-gcs', '--network', 'host',
           '-v', str(work / 'gcs-data') + ':/storage', FAKE_GCS, '-scheme', 'https', '-host', gateway, '-port', '14443',
           '-backend', 'filesystem', '-filesystem-root', '/storage', '-public-host', gateway + ':14443')
        time.sleep(2)
        config = work / 'pitr.json'
        config.write_text(json.dumps({
            'schema_version': 1, 'compose': compose, 'workdir': str(ROOT), 'private_dir': str(pitr), 'locks_dir': str(locks),
            'service': 'postgres', 'image': 'commerce-os-postgres:pitr', 'network': 'commerce-os_pitr-edge',
            'bucket': BUCKET, 'region': 'us-central1', 'primary_region': 'us-east1', 'pg_user': 'commerce_owner',
            'pg_database': 'commerce',
            'lab': {'PGBACKREST_REPO1_GCS_ENDPOINT': gateway + ':14443',
                    'PGBACKREST_REPO1_STORAGE_VERIFY_TLS': 'n', 'PGBACKREST_REPO1_GCS_KEY_TYPE': 'token',
                    'PGBACKREST_REPO1_GCS_KEY': 'lab-token'}}))
        os.chmod(config, 0o600)
        steps = evidence['steps'] = {}
        steps['preflight'] = operator(config, 'preflight')
        assert steps['preflight']['archive_mode'] == 'off' and not steps['preflight']['enabled']
        steps['build_image'] = operator(config, 'build-image')
        steps['render'] = operator(config, 'render')
        assert steps['render']['cipher_created'] is True
        secret_line = (pitr / 'pgbackrest.env').read_text().splitlines()[0]
        assert oct((pitr / 'pgbackrest.env').stat().st_mode & 0o777) == '0o600'
        steps['enable'] = operator(config, 'enable')
        assert steps['enable']['state'] == 'PITR_ENABLED', steps['enable']
        assert psql('SHOW archive_mode;') == 'on'
        psql("INSERT INTO payments SELECT g, g*100 FROM generate_series(5001,7000) g;")
        steps['backup_incr'] = operator(config, 'backup', 'incr')
        assert steps['backup_incr']['status'] == 'SUCCEEDED' and steps['backup_incr']['label'].endswith('I')
        steps['rehearse_exact'] = operator(config, 'rehearse', '--create-restore-point')
        assert steps['rehearse_exact']['state'] == 'PITR_REHEARSAL_VERIFIED_EXACT', steps['rehearse_exact']
        psql('DELETE FROM payments WHERE id > 6000;')
        steps['rehearse_latest'] = operator(config, 'rehearse')
        assert steps['rehearse_latest']['state'] == 'PITR_REHEARSAL_RESTORED'
        time.sleep(65)  # one archive_timeout so the latest WAL with the delete is archived
        steps['status'] = operator(config, 'status')
        assert steps['status']['enabled'] and not [p for p in steps['status']['problems'] if p.startswith('ARCHIVE')], steps['status']
        health = json.loads(psql('SELECT public.platform_recovery_status();'))
        assert health['archive_mode'] == 'on' and health['last_full_at'] and health['last_backup_at'] and health['pending'] == 0, health
        assert steps['enable']['first_full']['recorded_in_database'] is True and steps['backup_incr']['recorded_in_database'] is True
        steps['health'] = {key: health[key] is not None for key in ('last_archived_at', 'last_backup_at', 'last_full_at')}
        canary = psql('SELECT body FROM notes WHERE id=1;').encode()
        stored = [q for q in (work / 'gcs-data').rglob('*') if q.is_file()]
        assert stored and not any(canary in q.read_bytes() for q in stored), 'plaintext reached the repository'
        steps['disable'] = operator(config, 'disable')
        assert psql('SHOW archive_mode;') == 'off'
        assert psql('SELECT count(*) FROM payments;') == '6000'
        outputs = json.dumps(steps)
        assert secret_line.split('=', 1)[1] not in outputs, 'cipher pass leaked into operator output'
        for path in (pitr / 'evidence').iterdir():
            assert secret_line.split('=', 1)[1] not in path.read_text(), 'cipher pass leaked into evidence'
        repo = [p for p in (work / 'gcs-data').rglob('*') if p.is_file()]
        evidence.update(state='SYNTHETIC_GCS_PITR_LAB_VERIFIED', repository_objects=len(repo),
                        repository_bytes=sum(p.stat().st_size for p in repo), postgres=BASE.split('@')[0],
                        pgbackrest=steps['build_image']['pgbackrest'])
    finally:
        if not keep:
            cleanup()
    print(json.dumps(evidence, sort_keys=True))


if __name__ == '__main__':
    main()
