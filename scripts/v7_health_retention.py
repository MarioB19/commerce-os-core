#!/usr/bin/env python3
"""V7 F1 (RNF-03.e, RNF-02.g): retention of health telemetry.

Run by Root on the VM (systemd timer, and once in the Fase C window before the
fresh B02), never by an application role:

    v7_health_retention.py plan    <config.json>   (counts only)
    v7_health_retention.py run     <config.json>   (daily, online sweep)
    v7_health_retention.py cutover <config.json>   (Fase C, producers stopped)
    v7_health_retention.py compact <config.json>   (Fase C, after cutover)

The channel worker records one health observation per number and dimension on
every probe (~25 s). They are monitoring evidence: the application reads seven
days of them (number health and operational statistics over 1 h, 24 h and
168 h). Without retention they grew to 3.8 M rows and 9 GB by October 2026,
pushed the encrypted B02 dump over its 1 GiB per-file bound (B02 failed from
2026-10-13) and would have filled the disk.

`run` deletes, over every key (profile, environment, number, dimension) at
once and in chunks of `batch` rows, the health_signal records observed before
now − keep_days (minimum 2, default 8), always keeping the latest observation
of each key, together with their projection row and versions
(scripts/v7_health_retention_batch.sql, mode `sweep`). Each chunk is one
transaction that row-locks only its old signals, so producers keep running;
hash joins read each page once. A key-by-key pass was measured on production
on 17-oct at ~25 rows/s, because health rows are scattered over the heap. Rows whose number or dimension is null
or whose observed_at is not a finite instant are never touched. `plan` only
counts. `cutover` applies the same rule to every key in one transaction (the
Fase C cut, with producers stopped and a config whose keep_days is 2) and
`compact` then rewrites the three tables with VACUUM FULL. Output holds counts
and seconds, never identifiers or row data.

Config (root, 0600): {"compose": [...], "workdir": "...", "postgres_service": "postgres",
 "pg_user": "commerce_owner", "main_database": "commerce", "keep_days": 8,
 "batch": 1000000, "max_seconds": 1500}
"""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

FIELDS = {'compose', 'workdir', 'postgres_service', 'pg_user', 'main_database', 'keep_days', 'batch', 'max_seconds'}
BATCH_SQL = Path(__file__).resolve().with_name('v7_health_retention_batch.sql')
RESULT = re.compile(r'^HEALTH_RETENTION_RESULT\|(\d+)\|(\d+)\|(\d+)\|(\d+)$')
INSTANT = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$')
ENVIRONMENTS = {'SIMULATION', 'REAL'}


class RetentionError(Exception):
    pass


def need(ok, code):
    if not ok:
        raise RetentionError(code)


def load_config(path):
    raw = json.loads(Path(path).read_text())
    need(isinstance(raw, dict) and set(raw) == FIELDS, 'HEALTH_RETENTION_CONFIG_FIELDS')
    need(isinstance(raw['compose'], list) and raw['compose'] and all(isinstance(x, str) and x for x in raw['compose']),
         'HEALTH_RETENTION_CONFIG_COMPOSE')
    for k in ('workdir', 'postgres_service', 'pg_user', 'main_database'):
        need(isinstance(raw[k], str) and raw[k] and '\0' not in raw[k], 'HEALTH_RETENTION_CONFIG_' + k.upper())
    for k, low, high in (('keep_days', 2, 90), ('batch', 1000, 2000000), ('max_seconds', 60, 7200)):
        need(type(raw[k]) is int and low <= raw[k] <= high, 'HEALTH_RETENTION_CONFIG_' + k.upper())
    return raw


class Host:
    def __init__(self, config, runner=subprocess.run, clock=time.monotonic):
        self.config, self.runner, self.clock = config, runner, clock

    def psql(self, sql, variables=(), timeout=600):
        argv = [*self.config['compose'], 'exec', '-T', self.config['postgres_service'], 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
                '-v', 'VERBOSITY=verbose']
        for name, value in variables:
            need(re.fullmatch(r'[a-z_]+', name) and isinstance(value, str) and '\0' not in value, 'HEALTH_RETENTION_VARIABLE')
            argv += ['-v', name + '=' + value]
        argv += ['-U', self.config['pg_user'], '-d', self.config['main_database']]
        r = self.runner(argv, input=sql.encode(), capture_output=True, timeout=timeout, cwd=self.config['workdir'])
        if r.returncode != 0:
            tail = (r.stderr or b'').decode(errors='replace')[-600:]
            # Our own code first, else the PostgreSQL SQLSTATE (e.g. 57014 for a timeout); never row text.
            codes = re.findall(r'HEALTH_RETENTION_[A-Z_]+', tail) or ['SQLSTATE_' + x for x in re.findall(r'ERROR:\s+([0-9A-Z]{5}):', tail)]
            raise RetentionError('HEALTH_RETENTION_COMMAND_FAILED ' + (codes[0] if codes else 'EXIT_%d' % r.returncode))
        return (r.stdout or b'').decode().strip()


def cutoff(host, keep_days):
    value = host.psql("SELECT to_char((now()-make_interval(days=>%d)) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"');" % keep_days)
    need(INSTANT.match(value), 'HEALTH_RETENTION_CUTOFF')
    return value


# One aggregate pass. `candidates` is exact when the key was observed after the
# cutoff and an upper bound (ties with the latest) otherwise; batches are exact.
KEYS_SQL = """SELECT coalesce(json_agg(k ORDER BY k.ws,k.env,k.account,k.dimension),'[]') FROM (
 SELECT ws,env,account,dimension,
  to_char(least(:'cutoff'::timestamptz,latest) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') bound,
  CASE WHEN latest>=:'cutoff'::timestamptz THEN older ELSE total-1 END candidates
 FROM (SELECT workspace_id ws,environment env,account_id account,dimension,max(observed_at) latest,
   count(*) FILTER(WHERE observed_at<:'cutoff'::timestamptz) older,count(*) total
  FROM public.health_observation_index
  WHERE account_id<>'' AND dimension<>'' AND workspace_id<>'' AND isfinite(observed_at) AND environment IN('SIMULATION','REAL')
  GROUP BY 1,2,3,4) a) k WHERE k.candidates>0;"""


def keys(host, at):
    raw = json.loads(host.psql(KEYS_SQL, [('cutoff', at)]) or '[]')
    need(isinstance(raw, list), 'HEALTH_RETENTION_KEYS')
    for k in raw:
        need(isinstance(k, dict) and set(k) == {'ws', 'env', 'account', 'dimension', 'bound', 'candidates'}
             and all(isinstance(k[f], str) and k[f] for f in ('ws', 'account', 'dimension')) and k['env'] in ENVIRONMENTS
             and isinstance(k['bound'], str) and INSTANT.match(k['bound']) and k['bound'] <= at
             and type(k['candidates']) is int and k['candidates'] > 0, 'HEALTH_RETENTION_KEY_INVALID')
    return raw


def result(out, size):
    lines = [m for m in (RESULT.match(x) for x in out.splitlines()) if m]
    need(len(lines) == 1, 'HEALTH_RETENTION_RESULT_MISSING')
    d, i, v, r = (int(x) for x in lines[0].groups())
    need(i == d and r == d and v >= d and d <= size, 'HEALTH_RETENTION_RESULT_INVALID')
    return d, v


TAIL = "SELECT 'HEALTH_RETENTION_RESULT|'||doomed||'|'||projection||'|'||versions||'|'||records FROM health_retention_result;\nCOMMIT;\n"


def sweep(host, at, size):
    """One online chunk over every key (mode sweep): row locks only, hash joins."""
    sql = ("BEGIN;\nSET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='1800s';\nSET LOCAL client_min_messages=warning;\n"
           "SET LOCAL enable_nestloop=off;\nSET LOCAL work_mem='128MB';\n"
           "SELECT set_config('commerce.health_retention_mode','sweep',true),"
           "set_config('commerce.health_retention_bound',:'bound',true),set_config('commerce.health_retention_limit',:'lim',true) \\g /dev/null\n"
           + BATCH_SQL.read_text() + TAIL)
    return result(host.psql(sql, [('bound', at), ('lim', str(size))], timeout=1900), size)


CUT_LIMIT = 50000000
COMPACT = ('health_observation_index', 'record_versions', 'records')


def cutover(config, host=None):
    """Fase C only (producers stopped): one transaction over every key, hash
    joins and sequential scans instead of per-row index probes."""
    host = host or Host(config)
    start = host.clock()
    at = cutoff(host, config['keep_days'])
    sql = ("BEGIN;\nSET LOCAL lock_timeout='10s';\nSET LOCAL statement_timeout=0;\nSET LOCAL client_min_messages=warning;\n"
           "SET LOCAL enable_nestloop=off;\nSET LOCAL work_mem='256MB';\n"
           "SELECT set_config('commerce.health_retention_mode','all',true),"
           "set_config('commerce.health_retention_bound',:'bound',true),set_config('commerce.health_retention_limit',:'lim',true) \\g /dev/null\n"
           + BATCH_SQL.read_text() + TAIL)
    d, v = result(host.psql(sql, [('bound', at), ('lim', str(CUT_LIMIT))], timeout=7200), CUT_LIMIT)
    return {'state': 'HEALTH_RETENTION_CUT_APPLIED', 'keep_days': config['keep_days'], 'records_deleted': d,
            'versions_deleted': v, 'seconds': round(host.clock() - start, 1)}


def compact(config, host=None):
    """Fase C only: rewrite the three tables after the cut (exclusive locks)."""
    host = host or Host(config)
    seconds = {}
    for table in COMPACT:
        t = host.clock()
        host.psql('SET statement_timeout=0;\nVACUUM (FULL, ANALYZE) public.%s;\n' % table, timeout=7200)
        seconds[table] = round(host.clock() - t, 1)
    size = host.psql("SELECT pg_database_size(current_database());")
    need(size.isdigit(), 'HEALTH_RETENTION_SIZE')
    return {'state': 'HEALTH_RETENTION_COMPACTED', 'seconds': seconds, 'database_bytes': int(size)}


def plan(config, host=None):
    host = host or Host(config)
    at = cutoff(host, config['keep_days'])
    ks = keys(host, at)
    return {'state': 'HEALTH_RETENTION_PLAN', 'keep_days': config['keep_days'], 'keys': len(ks),
            'candidates': sum(k['candidates'] for k in ks)}


def run(config, host=None):
    host = host or Host(config)
    start = host.clock()
    at = cutoff(host, config['keep_days'])
    records = versions = chunks = 0
    complete = False
    while host.clock() - start < config['max_seconds']:
        d, v = sweep(host, at, config['batch'])
        chunks += 1; records += d; versions += v
        if d < config['batch']:
            complete = True
            break
    return {'state': 'HEALTH_RETENTION_APPLIED' if complete else 'HEALTH_RETENTION_PARTIAL', 'keep_days': config['keep_days'],
            'records_deleted': records, 'versions_deleted': versions, 'chunks': chunks, 'seconds': round(host.clock() - start, 1)}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        commands = {'plan': plan, 'run': run, 'cutover': cutover, 'compact': compact}
        need(len(argv) == 2 and argv[0] in commands, 'usage: v7_health_retention.py plan|run|cutover|compact <config.json>')
        config = load_config(argv[1])
        print(json.dumps(commands[argv[0]](config)))
        return 0
    except (RetentionError, OSError, ValueError, subprocess.TimeoutExpired) as e:
        print(json.dumps({'state': 'HEALTH_RETENTION_FAILED', 'error': str(e)[:300]}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
