#!/usr/bin/env python3
"""V7 RF-19.o (D-18): retention of «Probar número» tests (30 days).

Run by Root on the VM (systemd timer), never by an application role:

    v7_lab_retention.py run <config.json>

1. Main database (cluster owner): commerce_number_lab.purge_expired_runs()
   shreds the sealed content of expired runs and deletes their example
   receipts, writing one retention receipt per run.
2. Laboratory engine database: commerce_number_lab_engine.purge_run() deletes
   every row the run left there; the receipt records engine_purged_at.
3. Laboratory custody: the receipt files named in the receipt are removed
   inside the worker container; the receipt records files_purged_at.

Each step is idempotent and resumable from the receipts. Prints counts only.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

FIELDS = {'compose', 'workdir', 'postgres_service', 'pg_user', 'main_database', 'worker_service', 'lab_storage_dir'}
KEY = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{64}$')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
ENGINE = re.compile(r'^commerce_lab_engine_[a-z0-9_]+$')


class RetentionError(Exception):
    pass


def need(ok, code):
    if not ok:
        raise RetentionError(code)


def load_config(path):
    raw = json.loads(Path(path).read_text())
    need(isinstance(raw, dict) and set(raw) == FIELDS, 'LAB_RETENTION_CONFIG_FIELDS')
    need(isinstance(raw['compose'], list) and raw['compose'] and all(isinstance(x, str) for x in raw['compose']), 'LAB_RETENTION_CONFIG_COMPOSE')
    for k in FIELDS - {'compose'}:
        need(isinstance(raw[k], str) and raw[k] and '\0' not in raw[k], 'LAB_RETENTION_CONFIG_' + k.upper())
    need(raw['lab_storage_dir'].startswith('/') and '..' not in raw['lab_storage_dir'].split('/'), 'LAB_RETENTION_CONFIG_LAB_STORAGE_DIR')
    return raw


class Host:
    def __init__(self, config, runner=subprocess.run):
        self.config, self.runner = config, runner

    def run(self, argv, data=None, timeout=300):
        r = self.runner(argv, input=data.encode() if data is not None else None, capture_output=True, timeout=timeout, cwd=self.config['workdir'])
        if r.returncode != 0:
            tail = (r.stderr or b'').decode(errors='replace')[-300:]
            raise RetentionError('LAB_RETENTION_COMMAND_FAILED ' + re.sub(r'[^\w .:/-]', '_', tail))
        return (r.stdout or b'').decode()

    def compose(self, *args, data=None, timeout=300):
        return self.run([*self.config['compose'], *args], data=data, timeout=timeout)

    def psql(self, database, sql):
        out = self.compose('exec', '-T', self.config['postgres_service'], 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
                           '-U', self.config['pg_user'], '-d', database, data=sql)
        return out.strip()


def engine_database(host):
    names = [n for n in host.psql(host.config['main_database'], "SELECT datname FROM pg_database WHERE datname ~ '^commerce_lab_engine_' ORDER BY 1;").split('\n') if n]
    need(len(names) <= 1 and all(ENGINE.match(n) for n in names), 'LAB_RETENTION_ENGINE_AMBIGUOUS')
    return names[0] if names else None


def run(config, host=None):
    host = host or Host(config)
    main = config['main_database']
    purged = json.loads(host.psql(main, "SELECT coalesce(json_agg(t),'[]') FROM commerce_number_lab.purge_expired_runs(100) t;") or '[]')
    pending = json.loads(host.psql(main, "SELECT coalesce(json_agg(json_build_object('run_id',run_id,'engine',engine_purged_at IS NULL,'files',files_purged_at IS NULL,'keys',attachment_keys)),'[]') FROM commerce_number_lab.retention_receipts WHERE engine_purged_at IS NULL OR files_purged_at IS NULL;") or '[]')
    engine = engine_database(host) if any(p['engine'] for p in pending) else None
    rows = files = 0
    for p in pending:
        need(UUID.match(p['run_id']), 'LAB_RETENTION_RUN_ID')
        if p['engine']:
            if engine:
                rows += int(host.psql(engine, "SELECT commerce_number_lab_engine.purge_run('%s'::uuid);" % p['run_id']) or 0)
            host.psql(main, "UPDATE commerce_number_lab.retention_receipts SET engine_purged_at=clock_timestamp() WHERE run_id='%s'::uuid AND engine_purged_at IS NULL;" % p['run_id'])
        if p['files']:
            keys = p['keys'] or []
            need(all(isinstance(k, str) and KEY.match(k) for k in keys), 'LAB_RETENTION_KEY')
            if keys:
                paths = [config['lab_storage_dir'].rstrip('/') + '/assets/' + k + '.enc' for k in keys]
                host.compose('exec', '-T', config['worker_service'], 'rm', '-f', '--', *paths)
                files += len(keys)
            host.psql(main, "UPDATE commerce_number_lab.retention_receipts SET files_purged_at=clock_timestamp() WHERE run_id='%s'::uuid AND files_purged_at IS NULL;" % p['run_id'])
    return {'state': 'LAB_RETENTION_APPLIED', 'runs_shredded': len(purged), 'engine_runs_purged': sum(1 for p in pending if p['engine']),
            'engine_rows_deleted': rows, 'receipt_files_removed': files}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        need(len(argv) == 2 and argv[0] == 'run', 'usage: v7_lab_retention.py run <config.json>')
        print(json.dumps(run(load_config(argv[1]))))
        return 0
    except (RetentionError, OSError, ValueError, subprocess.TimeoutExpired) as e:
        print(json.dumps({'state': 'LAB_RETENTION_FAILED', 'error': str(e)[:300]}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
