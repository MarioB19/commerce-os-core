#!/usr/bin/env python3
"""V7 F1 — PostgreSQL PITR operator: pgBackRest with a GCS repository in another region.

Root on the VM:  python3 -I scripts/v7_pitr.py <config.json> <command> [options]

Read-only:  preflight, status.
Effects:    render, build-image, enable, backup {full|diff|incr}, rehearse, disable.

Each command does exactly what it names and never retries an effect. The
repository cipher pass is generated on the host, stays in a 0600 file that only
Docker reads as an env_file, and never reaches stdout, evidence, argv or Git.
`enable` and `disable` recreate only the PostgreSQL container (same data volume)
through the canonical composition, and verify the cluster system identifier
before and after. A failure after the recreate of `enable` returns PostgreSQL to
its previous configuration before raising. Effects that touch the running
cluster take the four Root locks; scheduled backups take only the PITR lock.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pitr_repository_policy as policy  # noqa: E402

STANZA = 'commerce'
ROOT_LOCKS = ('daily-b02-controller.lock', 'ci-deploy.lock', 'backup-schedule.lock', 'maintenance-backup.lock')
PGBACKREST_VERSION = 'pgBackRest 2.59.3'
POSTGRES_MAJOR_MINOR = '17.11'
DATA_DIR = '/var/lib/postgresql/data'
# Laboratory only (fake GCS endpoint host:port, static token, self-signed TLS).
LAB_ENV = {'PGBACKREST_REPO1_GCS_ENDPOINT', 'PGBACKREST_REPO1_GCS_KEY_TYPE', 'PGBACKREST_REPO1_GCS_KEY',
           'PGBACKREST_REPO1_STORAGE_VERIFY_TLS'}
CONFIG_FIELDS = {'schema_version', 'compose', 'workdir', 'private_dir', 'locks_dir', 'service', 'image',
                 'network', 'bucket', 'region', 'primary_region', 'pg_user', 'pg_database', 'escrow', 'lab'}
OPTIONAL_FIELDS = {'escrow', 'lab'}
METADATA_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}')
MAX_ARCHIVE_PENDING = 2
MAX_ARCHIVE_PENDING_AGE = 300
MAX_BACKUP_AGE = 36 * 3600
MAX_FULL_AGE = 8 * 86400


class PitrError(RuntimeError):
    pass


def need(value, code):
    if not value:
        raise PitrError(code)


def utc_now():
    return dt.datetime.now(dt.timezone.utc)


def iso(value):
    return value.astimezone(dt.timezone.utc).isoformat().replace('+00:00', 'Z')


def load_config(path):
    raw = Path(path).read_bytes()
    need(0 < len(raw) <= 65536, 'PITR_CONFIG_BOUND')
    config = json.loads(raw)
    need(type(config) is dict and set(config) <= CONFIG_FIELDS and CONFIG_FIELDS - OPTIONAL_FIELDS <= set(config),
         'PITR_CONFIG_FIELDS')
    escrow = config.get('escrow')
    need(escrow is None or (type(escrow) is dict and set(escrow) == {'project', 'secret'}
                            and re.fullmatch(r'[a-z][a-z0-9-]{4,61}[a-z0-9]', escrow['project'] or '')
                            and re.fullmatch(r'commerce-v7-pitr-[a-z0-9-]{3,40}', escrow['secret'] or '')),
         'PITR_ESCROW_INVALID')
    need(config['schema_version'] == 1, 'PITR_CONFIG_VERSION')
    need(type(config['compose']) is list and 1 <= len(config['compose']) <= 16
         and all(type(arg) is str and arg and '\n' not in arg for arg in config['compose']), 'PITR_COMPOSE_INVALID')
    for key in ('workdir', 'private_dir', 'locks_dir'):
        need(type(config[key]) is str and config[key].startswith('/') and '..' not in config[key], 'PITR_PATH_INVALID')
    for key in ('service', 'image', 'network'):
        need(type(config[key]) is str and NAME.fullmatch(config[key].replace(':', '.')), 'PITR_NAME_INVALID')
    lab = config.get('lab')
    need(lab is None or (type(lab) is dict and set(lab) <= LAB_ENV
                         and all(type(v) is str and re.fullmatch(r'[A-Za-z0-9_.:/=-]{1,512}', v) for v in lab.values())),
         'PITR_LAB_OVERRIDE_INVALID')
    # Same validation the production config renders with; raises on any change.
    policy.configuration(bucket=config['bucket'], region=config['region'], primary_region=config['primary_region'],
                         cluster_id='1' * 19, pg_user=config['pg_user'], pg_database=config['pg_database'])
    return config


def write_atomic(path, raw, mode):
    path = Path(path)
    temporary = path.with_name('.' + path.name + '.tmp')
    try:
        temporary.unlink()
    except FileNotFoundError:
        pass
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary, mode)
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    need(path.read_bytes() == raw, 'PITR_WRITE_READBACK_FAILED')


class Host:
    """Every external effect goes through `run`; tests replace it."""

    def __init__(self, config, runner=None):
        self.config = config
        self.runner = runner or self._subprocess
        self.private = Path(config['private_dir'])

    @staticmethod
    def _subprocess(argv, *, cwd=None, input=None, timeout=600, env=None):
        result = subprocess.run(argv, cwd=cwd, input=input, capture_output=True, timeout=timeout, env=env)
        if result.returncode != 0:
            # Bounded, sanitized diagnostics only: never echo stdin (may contain SQL with values).
            # pgBackRest reports errors on stdout (log-level-console); psql on stderr.
            tail = (result.stderr.decode('utf-8', 'replace')[-600:] + ' ' + result.stdout.decode('utf-8', 'replace')[-600:])
            tail = re.sub(r'(?i)(cipher-pass|password|token)[^\s]*\s*[=:]\s*\S+', r'\1=<redacted>', tail)
            raise PitrError('PITR_COMMAND_FAILED:' + os.path.basename(argv[0]) + ':' + tail.strip().replace('\n', ' | '))
        return result.stdout.decode('utf-8', 'replace')

    def run(self, argv, *, input=None, timeout=600):
        env = dict(os.environ)
        env['COMMERCE_PITR_DIR'] = str(self.private)
        return self.runner(list(argv), cwd=self.config['workdir'], input=input, timeout=timeout, env=env)

    def compose(self, *args, timeout=600):
        return self.run([*self.config['compose'], *args], timeout=timeout)

    def container(self):
        ids = self.compose('ps', '-q', self.config['service']).split()
        need(len(ids) == 1 and re.fullmatch(r'[a-f0-9]{12,64}', ids[0]), 'PITR_POSTGRES_CONTAINER_REQUIRED')
        return self.inspect(ids[0])

    def inspect(self, ref):
        rows = json.loads(self.run(['docker', 'inspect', ref]))
        need(type(rows) is list and len(rows) == 1, 'PITR_INSPECT_INVALID')
        return rows[0]

    def psql(self, cid, sql, timeout=120):
        return self.run(['docker', 'exec', '-i', '--env', 'PGOPTIONS=-c statement_timeout=0', cid, 'psql', '-XqAt',
                         '-v', 'ON_ERROR_STOP=1', '-U', self.config['pg_user'], '-d', self.config['pg_database']],
                        input=sql.encode(), timeout=timeout).strip()

    def pgbackrest(self, cid, *args, timeout=3600):
        return self.run(['docker', 'exec', '-u', 'postgres', cid, 'pgbackrest', '--stanza=' + STANZA, *args],
                        timeout=timeout)


def private_dir(host, create=False):
    path = host.private
    if create and not path.exists():
        path.mkdir(mode=0o700, parents=False)
    info = path.lstat()
    need(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700 and info.st_uid == os.geteuid(),
         'PITR_PRIVATE_DIR_UNSAFE')
    return path


class Locks:
    def __init__(self, directory, names):
        self.paths = [Path(directory) / name for name in names]
        self.held = []

    def __enter__(self):
        try:
            for path in self.paths:
                fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                stream = os.fdopen(fd, 'a+b')
                self.held.append(stream)
                info = os.fstat(stream.fileno())
                need(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
                     'PITR_LOCK_UNSAFE')
                try:
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise PitrError('PITR_LOCK_BUSY:' + path.name) from None
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        for stream in reversed(self.held):
            stream.close()
        self.held = []


def system_identifier(host, cid):
    value = host.psql(cid, 'SELECT system_identifier FROM pg_control_system();')
    need(re.fullmatch(r'[1-9][0-9]{10,19}', value), 'PITR_SYSTEM_IDENTIFIER_INVALID')
    return value


def archive_settings(host, cid):
    rows = host.psql(cid, "SELECT name||'|'||setting||coalesce(unit,'') FROM pg_settings "
                          "WHERE name IN ('wal_level','archive_mode','archive_timeout','archive_command') ORDER BY name;")
    return dict(line.split('|', 1) for line in rows.splitlines() if '|' in line)


def data_mount(row):
    mounts = [m for m in row.get('Mounts', []) if m.get('Destination') == DATA_DIR]
    need(len(mounts) == 1 and mounts[0].get('Type') == 'volume' and mounts[0].get('Name'), 'PITR_DATA_VOLUME_REQUIRED')
    return mounts[0]['Name']


def rendered_paths(host):
    return host.private / 'pgbackrest.conf', host.private / 'pgbackrest.env', host.private / 'enabled'


def read_env_names(path):
    return {line.split('=', 1)[0] for line in path.read_text().splitlines() if '=' in line}


# ---------------------------------------------------------------- commands

def cmd_preflight(host, _args):
    row = host.container()
    cid = row['Id']
    networks = sorted(row['NetworkSettings']['Networks'])
    settings = archive_settings(host, cid)
    size = int(host.psql(cid, 'SELECT pg_database_size(current_database());'))
    conf, env, marker = rendered_paths(host)
    report = {'state': 'PITR_PREFLIGHT_READ_ONLY', 'container': cid[:12], 'image': row['Image'],
              'data_volume': data_mount(row), 'networks': networks, 'system_identifier': system_identifier(host, cid),
              'archive_mode': settings.get('archive_mode'), 'wal_level': settings.get('wal_level'),
              'database_bytes': size, 'rendered': conf.exists() and env.exists(), 'enabled': marker.exists(),
              'lab': host.config.get('lab') is not None}
    try:
        net = host.inspect(host.config['network'])
        report['pitr_network'] = {'internal': net.get('Internal'), 'ipv6': net.get('EnableIPv6'),
                                  'driver': net.get('Driver')}
    except PitrError:
        report['pitr_network'] = None
    return report


def cmd_render(host, _args):
    directory = private_dir(host, create=True)
    row = host.container()
    cluster = system_identifier(host, row['Id'])
    c = host.config
    text = policy.configuration(bucket=c['bucket'], region=c['region'], primary_region=c['primary_region'],
                                cluster_id=cluster, pg_user=c['pg_user'], pg_database=c['pg_database']).encode()
    conf, env, _ = rendered_paths(host)
    # Readable by the postgres user inside the container; it carries no secret.
    write_atomic(conf, text, 0o644)
    created = False
    if not env.exists():
        lines = ['PGBACKREST_REPO1_CIPHER_PASS=' + secrets.token_hex(32)]
        lines += [k + '=' + v for k, v in sorted((c.get('lab') or {}).items())]
        write_atomic(env, ('\n'.join(lines) + '\n').encode(), 0o600)
        created = True
    info = env.lstat()
    need(stat.S_IMODE(info.st_mode) == 0o600 and info.st_uid == os.geteuid(), 'PITR_SECRET_FILE_UNSAFE')
    names = read_env_names(env)
    need('PGBACKREST_REPO1_CIPHER_PASS' in names and names <= LAB_ENV | {'PGBACKREST_REPO1_CIPHER_PASS'},
         'PITR_SECRET_FILE_FIELDS')
    secret = next(line.split('=', 1)[1] for line in env.read_text().splitlines()
                  if line.startswith('PGBACKREST_REPO1_CIPHER_PASS='))
    need(re.fullmatch(r'[a-f0-9]{64}', secret), 'PITR_CIPHER_PASS_INVALID')
    return {'state': 'PITR_RENDERED', 'cluster_id': cluster, 'config_sha256': hashlib.sha256(text).hexdigest(),
            'cipher_created': created, 'cipher_sha256': hashlib.sha256(secret.encode()).hexdigest(),
            'directory': str(directory)}


def verify_image(host, image):
    row = host.inspect(image)
    version = host.run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'pgbackrest', image, 'version']).strip()
    postgres = host.run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'postgres', image, '--version']).strip()
    need(version == PGBACKREST_VERSION, 'PITR_PGBACKREST_VERSION_CHANGED')
    need(re.search(r'\(PostgreSQL\) ' + re.escape(POSTGRES_MAJOR_MINOR) + r'\b', postgres), 'PITR_POSTGRES_VERSION_CHANGED')
    return row['Id']


def cmd_build_image(host, _args):
    host.run(['docker', 'build', '--pull=false', '-t', host.config['image'], '-f', 'infra/postgres/Dockerfile',
              'infra/postgres'], timeout=1800)
    image_id = verify_image(host, host.config['image'])
    return {'state': 'PITR_IMAGE_BUILT', 'image': host.config['image'], 'image_id': image_id,
            'pgbackrest': PGBACKREST_VERSION}


# Same reviewed options as the consumer egress bridge: no inter-container
# traffic, NAT egress only, published ports (none) bound to loopback.
NETWORK_OPTIONS = {'com.docker.network.bridge.enable_icc': 'false',
                   'com.docker.network.bridge.enable_ip_masquerade': 'true',
                   'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1'}


def ensure_network(host):
    name = host.config['network']
    try:
        row = host.inspect(name)
    except PitrError:
        options = [arg for key, value in sorted(NETWORK_OPTIONS.items()) for arg in ('--opt', key + '=' + value)]
        host.run(['docker', 'network', 'create', '--driver', 'bridge', *options,
                  '--label', 'com.inovaris.commerce.role=pitr-edge', name])
        row = host.inspect(name)
    need(row.get('Driver') == 'bridge' and row.get('Internal') is False and row.get('EnableIPv6') is False
         and all((row.get('Options') or {}).get(k) == v for k, v in NETWORK_OPTIONS.items()), 'PITR_NETWORK_UNSAFE')
    # The lab attaches its fake GCS endpoint here; production admits no peer.
    return set() if host.config.get('lab') is not None else set(row.get('Containers') or {})


def client_backends(host, cid):
    return int(host.psql(cid, "SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend' "
                              "AND pid<>pg_backend_pid();"))


def recreate(host, timeout=240):
    host.compose('up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', str(timeout),
                 host.config['service'], timeout=timeout + 60)
    return host.container()


def latest_backup(info):
    need(type(info) is list and len(info) == 1 and info[0].get('name') == STANZA, 'PITR_INFO_INVALID')
    backups = info[0].get('backup') or []
    return backups[-1] if backups else None


def info_json(host, cid):
    return json.loads(host.pgbackrest(cid, '--output=json', 'info', timeout=300))


def journal(host, record):
    runs = host.private / 'runs'
    if not runs.exists():
        runs.mkdir(mode=0o700)
    name = record['started_at'].replace(':', '').replace('-', '') + '-' + record['kind'] + '.json'
    write_atomic(runs / name, (json.dumps(record, sort_keys=True) + '\n').encode(), 0o600)


def record_run(host, cid, record):
    """Health reads these rows; missing table (older schema) keeps only the private journal."""
    exists = host.psql(cid, "SELECT to_regclass('public.platform_backup_runs') IS NOT NULL;")
    if exists != 't':
        return False
    payload = json.dumps(record, sort_keys=True).replace("'", "''")
    host.psql(cid, "SELECT public.record_platform_backup_run('" + payload + "'::jsonb);")
    return True


def run_backup(host, cid, kind, start_fast=False):
    started = utc_now()
    record = {'kind': 'PITR_' + kind.upper(), 'started_at': iso(started), 'status': 'RUNNING'}
    journal(host, record)
    try:
        args = ['--type=' + kind]
        if start_fast:
            args.append('--start-fast')
        host.pgbackrest(cid, *args, 'backup', timeout=6 * 3600)
        last = latest_backup(info_json(host, cid))
        need(last and last.get('type') == kind, 'PITR_BACKUP_NOT_RECORDED')
        record.update(status='SUCCEEDED', label=last['label'], finished_at=iso(utc_now()),
                      database_bytes=int(last['info']['size']), repository_bytes=int(last['info']['repository']['delta']),
                      wal_start=last['archive']['start'], wal_stop=last['archive']['stop'])
    except Exception as error:
        record.update(status='FAILED', finished_at=iso(utc_now()), error=str(error)[:300])
        journal(host, record)
        try:
            record_run(host, cid, record)
        finally:
            raise
    journal(host, record)
    record['recorded_in_database'] = record_run(host, cid, record)
    return record


def verify_enabled(host, before, image_id):
    row = host.container()
    cid = row['Id']
    need(row['Image'] == image_id, 'PITR_IMAGE_NOT_RUNNING')
    need(data_mount(row) == before['volume'], 'PITR_DATA_VOLUME_CHANGED')
    networks = set(row['NetworkSettings']['Networks'])
    need(host.config['network'] in networks and set(before['networks']) <= networks
         and networks - set(before['networks']) == {host.config['network']}, 'PITR_NETWORK_MEMBERSHIP_CHANGED')
    need(system_identifier(host, cid) == before['system_identifier'], 'PITR_SYSTEM_IDENTIFIER_CHANGED')
    settings = archive_settings(host, cid)
    effective = {'wal_level': settings.get('wal_level'), 'archive_mode': settings.get('archive_mode'),
                 'archive_timeout': settings.get('archive_timeout'), 'archive_command': settings.get('archive_command')}
    conf = dict(line.split('=', 1) for line in rendered_paths(host)[0].read_text().splitlines() if '=' in line)
    policy.validate_effective(effective, conf)
    return row


def cmd_enable(host, args):
    conf, env, marker = rendered_paths(host)
    need(conf.exists() and env.exists(), 'PITR_RENDER_REQUIRED')
    need(not marker.exists(), 'PITR_ALREADY_ENABLED')
    image_id = verify_image(host, host.config['image'])
    with Locks(host.config['locks_dir'], ROOT_LOCKS):
        foreign = ensure_network(host)
        need(not foreign, 'PITR_NETWORK_FOREIGN_ENDPOINT')
        row = host.container()
        cid = row['Id']
        before = {'container': cid, 'image': row['Image'], 'volume': data_mount(row),
                  'networks': sorted(row['NetworkSettings']['Networks']), 'system_identifier': system_identifier(host, cid)}
        need(host.config['network'] not in before['networks'], 'PITR_NETWORK_ALREADY_ATTACHED')
        conf_text = conf.read_text()
        need('repo1-path=/commerce/' + before['system_identifier'] + '\n' in conf_text, 'PITR_RENDER_CLUSTER_MISMATCH')
        clients = client_backends(host, cid)
        need(clients == 0 or args.allow_clients, 'PITR_CLIENTS_CONNECTED')
        write_atomic(marker, (json.dumps({'image_id': image_id, 'network': host.config['network'],
                                          'enabled_at': iso(utc_now())}, sort_keys=True) + '\n').encode(), 0o600)
        steps = []
        try:
            recreate(host)
            row = verify_enabled(host, before, image_id)
            cid = row['Id']
            steps.append('recreated')
            host.pgbackrest(cid, 'stanza-create', timeout=600)
            steps.append('stanza')
            host.pgbackrest(cid, 'check', timeout=600)
            steps.append('archive_checked')
            backup = run_backup(host, cid, 'full', start_fast=True)
            steps.append('full_backup')
        except BaseException as error:
            rollback = disable_after_failure(host, before)
            raise PitrError('PITR_ENABLE_FAILED_ROLLED_BACK:' + ','.join(steps) + ':' + rollback + ':' + str(error)[:400]) from None
        # Root evidence for scripts/v7_infra_adoption.py: the exact container
        # replacement this command made, same volume and cluster identity.
        write_atomic(host.private / 'enable-receipt.json', (json.dumps({
            'schema_version': 1, 'state': 'PITR_ENABLED', 'enabled_at': iso(utc_now()),
            'before': before, 'after': {'container': cid, 'image': image_id, 'network': host.config['network']},
            'first_full_label': backup.get('label')}, sort_keys=True) + '\n').encode(), 0o600)
    return {'state': 'PITR_ENABLED', 'image_id': image_id, 'previous_image': before['image'],
            'previous_container': before['container'][:12], 'container': cid[:12], 'system_identifier': before['system_identifier'],
            'client_backends_at_switch': clients, 'steps': steps, 'first_full': backup}


def disable_after_failure(host, before):
    marker = rendered_paths(host)[2]
    try:
        marker.unlink()
    except FileNotFoundError:
        pass
    try:
        row = recreate(host)
        need(data_mount(row) == before['volume'] and system_identifier(host, row['Id']) == before['system_identifier'],
             'PITR_ROLLBACK_IDENTITY')
        need(archive_settings(host, row['Id']).get('archive_mode') == 'off', 'PITR_ROLLBACK_ARCHIVE_STILL_ON')
        return 'ROLLED_BACK'
    except Exception as error:
        return 'ROLLBACK_FAILED(' + str(error)[:200] + ')'


def cmd_disable(host, _args):
    conf, _env, marker = rendered_paths(host)
    need(marker.exists(), 'PITR_NOT_ENABLED')
    with Locks(host.config['locks_dir'], ROOT_LOCKS):
        row = host.container()
        before = {'volume': data_mount(row), 'system_identifier': system_identifier(host, row['Id'])}
        marker.unlink()
        # The enable evidence no longer describes the running container; keep it
        # aside so a later Root adoption fails closed instead of reusing it.
        receipt = host.private / 'enable-receipt.json'
        if receipt.exists():
            os.replace(receipt, host.private / ('enable-receipt.disabled-' + iso(utc_now()).replace(':', '') + '.json'))
        row = recreate(host)
        need(data_mount(row) == before['volume'] and system_identifier(host, row['Id']) == before['system_identifier'],
             'PITR_DISABLE_IDENTITY_CHANGED')
        settings = archive_settings(host, row['Id'])
        need(settings.get('archive_mode') == 'off', 'PITR_DISABLE_ARCHIVE_STILL_ON')
        need(host.config['network'] not in row['NetworkSettings']['Networks'], 'PITR_DISABLE_NETWORK_STILL_ATTACHED')
    return {'state': 'PITR_DISABLED', 'container': row['Id'][:12], 'image': row['Image'],
            'system_identifier': before['system_identifier'], 'repository_preserved': True}


def cmd_backup(host, args):
    need(rendered_paths(host)[2].exists(), 'PITR_NOT_ENABLED')
    with Locks(host.private, ('pitr-backup.lock',)):
        row = host.container()
        return {'state': 'PITR_BACKUP', **run_backup(host, row['Id'], args.type)}


def archiver(host, cid):
    raw = host.psql(cid, "SELECT json_build_object('archived',archived_count,'failed',failed_count,"
                         "'last_archived_wal',last_archived_wal,'last_archived_at',last_archived_time,"
                         "'last_failed_wal',last_failed_wal,'last_failed_at',last_failed_time,"
                         "'current_wal',pg_walfile_name(pg_current_wal_lsn()),"
                         "'pending',(SELECT count(*) FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready'),"
                         "'oldest_pending_age_s',(SELECT extract(epoch FROM now()-min(modification))::bigint "
                         "FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready')) FROM pg_stat_archiver;")
    return json.loads(raw)


def assess(archive, last, last_full, now):
    problems = []
    if archive['pending'] > MAX_ARCHIVE_PENDING or (archive['oldest_pending_age_s'] or 0) > MAX_ARCHIVE_PENDING_AGE:
        problems.append('ARCHIVE_BACKLOG')
    if archive['last_failed_at'] and (not archive['last_archived_at'] or archive['last_failed_at'] > archive['last_archived_at']):
        problems.append('ARCHIVE_FAILING')
    if not last or now - last['timestamp']['stop'] > MAX_BACKUP_AGE:
        problems.append('BACKUP_STALE')
    if not last_full or now - last_full['timestamp']['stop'] > MAX_FULL_AGE:
        problems.append('FULL_BACKUP_STALE')
    return problems


def cmd_status(host, _args):
    row = host.container()
    cid = row['Id']
    enabled = rendered_paths(host)[2].exists()
    archive = archiver(host, cid)
    report = {'state': 'PITR_STATUS_READ_ONLY', 'enabled': enabled, 'archive': archive}
    if not enabled:
        report['problems'] = ['PITR_NOT_ENABLED']
        return report
    info = info_json(host, cid)
    backups = (info[0].get('backup') or []) if info else []
    last = backups[-1] if backups else None
    fulls = [b for b in backups if b.get('type') == 'full']
    archive_ranges = info[0].get('archive') or []
    now = int(time.time())
    report.update(stanza_status=info[0].get('status', {}).get('message'),
                  backups=[{'label': b['label'], 'type': b['type'], 'stop': b['timestamp']['stop'],
                            'database_bytes': b['info']['size'], 'repository_delta_bytes': b['info']['repository']['delta']}
                           for b in backups[-10:]],
                  archive_range=[{'min': a.get('min'), 'max': a.get('max')} for a in archive_ranges],
                  oldest_restorable=backups[0]['timestamp']['stop'] if backups else None,
                  problems=assess(archive, last, fulls[-1] if fulls else None, now))
    return report


def table_counts(host, cid):
    """Exact counts of every public table, one REPEATABLE READ snapshot."""
    script = ("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n"
              "SELECT format('SELECT %L||''|''||count(*) FROM public.%I;', c.relname, c.relname) FROM pg_class c "
              "JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') "
              "ORDER BY c.relname \\gexec\nCOMMIT;\n")
    out = host.psql(cid, script, timeout=900)
    return dict((line.split('|', 1)[0], int(line.split('|', 1)[1])) for line in out.splitlines() if '|' in line)


def migrations(host, cid):
    raw = host.psql(cid, "SELECT count(*)||'|'||coalesce(max(name),'') FROM schema_migrations;")
    count, last = raw.split('|', 1)
    return {'count': int(count), 'last': last}


def cmd_rehearse(host, args):
    """Restore into an isolated container and temporary volume, verify, remove both.

    With --create-restore-point (maintenance window: producers stopped) the
    restored counts must equal production exactly. Without it the target is the
    latest archived WAL and counts are reported, not compared.
    """
    conf, env, marker = rendered_paths(host)
    need(marker.exists(), 'PITR_NOT_ENABLED')
    stamp = utc_now().strftime('%Y%m%dT%H%M%SZ')
    name = 'pitr-rehearsal-' + stamp.lower()
    with Locks(host.private, ('pitr-backup.lock',)):
        row = host.container()
        cid = row['Id']
        expected = None
        target = []
        if args.create_restore_point:
            need(client_backends(host, cid) == 0 or args.allow_clients, 'PITR_CLIENTS_CONNECTED')
            expected = {'tables': table_counts(host, cid), 'migrations': migrations(host, cid)}
            point = 'v7_rehearsal_' + stamp.lower()
            host.psql(cid, "SELECT pg_create_restore_point('" + point + "');")
            segment = host.psql(cid, 'SELECT pg_walfile_name(pg_current_wal_lsn());')
            host.psql(cid, 'SELECT pg_switch_wal();')
            deadline = time.time() + 180
            while time.time() < deadline:
                last = host.psql(cid, 'SELECT coalesce(last_archived_wal,\'\') FROM pg_stat_archiver;')
                if last and last[:24] >= segment:
                    break
                time.sleep(2)
            else:
                raise PitrError('PITR_RESTORE_POINT_NOT_ARCHIVED')
            target = ['--type=name', '--target=' + point, '--target-action=promote']
        free = int(host.run(['df', '--output=avail', '-B1', '/var/lib/docker']).split()[-1])
        size = int(host.psql(cid, 'SELECT pg_database_size(current_database());'))
        need(free > 2 * size + 4 * 1024 ** 3, 'PITR_REHEARSAL_DISK_SPACE')
        started = time.monotonic()
        host.run(['docker', 'volume', 'create', '--label', 'com.inovaris.commerce.role=pitr-rehearsal', name])
        try:
            host.run(['docker', 'run', '-d', '--name', name, '--network', host.config['network'],
                      '--label', 'com.inovaris.commerce.role=pitr-rehearsal', '--env-file', str(env),
                      '-v', str(conf) + ':/etc/pgbackrest/pgbackrest.conf:ro', '-v', name + ':' + DATA_DIR,
                      '--memory', '1536m', '--cpus', '1', '--entrypoint', 'sleep', host.config['image'], 'infinity'])
            host.run(['docker', 'exec', name, 'chown', 'postgres:postgres', DATA_DIR])
            host.run(['docker', 'exec', '-u', 'postgres', name, 'pgbackrest', '--stanza=' + STANZA,
                      '--archive-mode=off', *target, 'restore'], timeout=4 * 3600)
            restored_at = time.monotonic()
            # Recovery needs max_connections >= the primary's (80); hot standby
            # stays off so nothing reads a half-recovered cluster. pg_ctl -w
            # returns only once the promoted server accepts connections, and
            # fails if the postmaster exits.
            options = '-c listen_addresses= -c archive_mode=off -c hot_standby=off -c max_connections=100 -c shared_buffers=128MB'
            try:
                host.run(['docker', 'exec', '-u', 'postgres', name, 'pg_ctl', '-D', DATA_DIR, '-o', options,
                          '-l', '/tmp/rehearsal.log', '-w', '-t', '3600', 'start'], timeout=3700)
            except PitrError:
                log = host.run(['docker', 'exec', name, 'tail', '-c', '1500', '/tmp/rehearsal.log'], timeout=30)
                raise PitrError('PITR_REHEARSAL_START_FAILED:' + log.replace('\n', ' | ')) from None
            # With hot standby off the server refuses connections until the
            # target is reached and promoted; pg_ctl may report it started first.
            deadline = time.time() + 3600
            while time.time() < deadline:
                try:
                    state = host.run(['docker', 'exec', '-u', 'postgres', name, 'psql', '-XqAt', '-U', host.config['pg_user'],
                                      '-d', host.config['pg_database'], '-c', 'SELECT pg_is_in_recovery()'], timeout=30).strip()
                except PitrError as error:
                    if 'not accepting connections' not in str(error) and 'starting up' not in str(error):
                        raise
                    state = ''
                if state == 'f':
                    break
                time.sleep(3)
            else:
                raise PitrError('PITR_REHEARSAL_NOT_PROMOTED')
            ready = time.monotonic()
            probe = Host(dict(host.config), host.runner)
            restored = {'tables': table_counts(probe, name), 'migrations': migrations(probe, name)}
            identifier = system_identifier(probe, name)
        finally:
            for argv in (['docker', 'rm', '-f', '-v', name], ['docker', 'volume', 'rm', name]):
                try:
                    host.run(argv, timeout=300)
                except PitrError:
                    pass
    need(identifier == system_identifier(host, cid), 'PITR_REHEARSAL_OTHER_CLUSTER')
    result = {'state': 'PITR_REHEARSAL_RESTORED', 'target': 'restore_point' if expected else 'latest',
              'restore_seconds': round(restored_at - started, 1), 'ready_seconds': round(ready - started, 1),
              'tables': len(restored['tables']), 'rows': sum(restored['tables'].values()),
              'migrations': restored['migrations'], 'container_removed': True}
    if expected:
        mismatched = sorted(t for t in set(expected['tables']) | set(restored['tables'])
                            if expected['tables'].get(t) != restored['tables'].get(t))
        need(not mismatched and expected['migrations'] == restored['migrations'],
             'PITR_REHEARSAL_COUNTS_DIFFER:' + ','.join(mismatched[:20]))
        result['state'] = 'PITR_REHEARSAL_VERIFIED_EXACT'
        result['expected_rows'] = sum(expected['tables'].values())
    return result


def default_http(request, timeout=30):
    import urllib.request
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read(65536)
        return response.status, raw


def cmd_escrow(host, _args, http=None):
    """Add the repository cipher pass as a new Secret Manager version with the
    VM identity (secretVersionAdder only). Restoring on another host reads it
    with the owner's identity; this host can neither list nor read versions."""
    import base64
    import urllib.request
    escrow = host.config.get('escrow')
    need(escrow, 'PITR_ESCROW_NOT_CONFIGURED')
    env = rendered_paths(host)[1]
    need(env.exists(), 'PITR_RENDER_REQUIRED')
    secret = next(line.split('=', 1)[1] for line in env.read_text().splitlines()
                  if line.startswith('PGBACKREST_REPO1_CIPHER_PASS='))
    http = http or default_http
    status, raw = http(urllib.request.Request(METADATA_TOKEN, headers={'Metadata-Flavor': 'Google'}))
    need(status == 200, 'PITR_ESCROW_IDENTITY_UNAVAILABLE')
    token = json.loads(raw)['access_token']
    url = ('https://secretmanager.googleapis.com/v1/projects/' + escrow['project'] + '/secrets/'
           + escrow['secret'] + ':addVersion')
    body = json.dumps({'payload': {'data': base64.b64encode(secret.encode()).decode()}}).encode()
    request = urllib.request.Request(url, data=body, method='POST',
                                     headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        status, raw = http(request)
    finally:
        body = b''
    need(status == 200, 'PITR_ESCROW_REJECTED')
    version = json.loads(raw).get('name', '')
    need(re.fullmatch(r'projects/[0-9]+/secrets/' + re.escape(escrow['secret']) + r'/versions/[0-9]+', version),
         'PITR_ESCROW_UNCONFIRMED')
    return {'state': 'PITR_CIPHER_ESCROWED', 'version': version,
            'cipher_sha256': hashlib.sha256(secret.encode()).hexdigest(),
            'verify': 'owner reads the version and compares its sha256; the VM cannot read it back'}


COMMANDS = {'preflight': cmd_preflight, 'escrow': cmd_escrow, 'render': cmd_render, 'build-image': cmd_build_image,
            'enable': cmd_enable, 'disable': cmd_disable, 'backup': cmd_backup, 'status': cmd_status,
            'rehearse': cmd_rehearse}


def main(argv=None, host_factory=Host):
    parser = argparse.ArgumentParser(prog='v7_pitr.py')
    parser.add_argument('config')
    parser.add_argument('command', choices=sorted(COMMANDS))
    parser.add_argument('type', nargs='?', choices=['full', 'diff', 'incr'])
    parser.add_argument('--allow-clients', action='store_true')
    parser.add_argument('--create-restore-point', action='store_true')
    args = parser.parse_args(argv)
    need(args.command != 'backup' or args.type, 'PITR_BACKUP_TYPE_REQUIRED')
    os.umask(0o077)
    host = host_factory(load_config(args.config))
    try:
        result = COMMANDS[args.command](host, args)
        code = 0 if not result.get('problems') else 3
    except PitrError as error:
        result, code = {'state': 'PITR_ERROR', 'error': str(error)[:1200]}, 2
    result['command'] = args.command
    result['at'] = iso(utc_now())
    if host.private.exists() and args.command not in ('status', 'preflight'):
        evidence = host.private / 'evidence'
        if not evidence.exists():
            evidence.mkdir(mode=0o700)
        write_atomic(evidence / (result['at'].replace(':', '') + '-' + args.command + '.json'),
                     (json.dumps(result, sort_keys=True) + '\n').encode(), 0o600)
    print(json.dumps(result, sort_keys=True))
    return code


if __name__ == '__main__':
    sys.exit(main())
