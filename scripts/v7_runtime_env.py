#!/usr/bin/env python3
"""V7 window step: the runtime logins and settings V7 adds, written only into
the protected service env files (0600). Root on the VM; values never printed.

    v7_runtime_env.py logins <config.json>
        For each V7 login (AI with the business's keys, results projection,
        mail dispatch) create its LOGIN role once, grant its reviewed group
        and write <ENV>=postgres://… into the services that use it. A login
        already configured is kept (no silent rotation).
    v7_runtime_env.py set <config.json> <service> KEY=VALUE [KEY=VALUE…]
        Non-secret settings (origins, subscription names, flags).
    v7_runtime_env.py generate <config.json> <service> KEY <aes256|token> <project> <secret> [TEMPLATE]
        A new random value (32-byte AES key in base64, or a URL-safe token),
        escrowed as a new Secret Manager version with the VM identity (which
        may add versions but never read them), then written as KEY (inside
        TEMPLATE's `{}` when given, e.g. the relay URL). A KEY already present
        is kept: no version is added and nothing rotates. Prints the version
        name and the value's sha256 so the owner can compare.
    v7_runtime_env.py merge <config.json> <service> <file.env> PREFIX_
        The keys starting with PREFIX_ from a 0600 file another installer
        wrote (the laboratory's LAB_* logins), then the file is left as is.

Each write keeps a timestamped 0600 copy of the previous file next to it.
"""
import json
import os
import re
import secrets
import subprocess
import sys
import urllib.request
from base64 import b64encode, urlsafe_b64encode
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

FIELDS = {'compose', 'workdir', 'postgres_service', 'pg_user', 'database', 'db_host', 'secrets_dir', 'services'}
LOGINS = (
    {'name': 'ai', 'role': 'commerce_ai', 'inherit': False, 'env': 'AI_DATABASE_URL', 'services': ('api', 'automation')},
    {'name': 'results', 'role': 'commerce_results', 'inherit': False, 'env': 'RESULTS_DATABASE_URL', 'services': ('automation',)},
    {'name': 'mail', 'role': 'commerce_mail_dispatch', 'inherit': True, 'env': 'MAIL_DISPATCH_DATABASE_URL', 'services': ('automation',)},
)
KEY = re.compile(r'^[A-Z][A-Z0-9_]{1,63}$')
TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'


class EnvError(Exception):
    pass


def need(ok, code):
    if not ok:
        raise EnvError(code)


def load_config(path):
    raw = json.loads(Path(path).read_text())
    need(isinstance(raw, dict) and set(raw) == FIELDS, 'ENV_CONFIG_FIELDS')
    need(isinstance(raw['compose'], list) and raw['compose'] and all(isinstance(x, str) for x in raw['compose']), 'ENV_CONFIG_COMPOSE')
    for k in ('workdir', 'secrets_dir'):
        need(isinstance(raw[k], str) and raw[k].startswith('/') and '..' not in raw[k].split('/'), 'ENV_CONFIG_' + k.upper())
    for k in ('postgres_service', 'pg_user', 'database', 'db_host'):
        need(isinstance(raw[k], str) and re.fullmatch(r'[a-z][a-z0-9_-]{0,62}', raw[k]), 'ENV_CONFIG_' + k.upper())
    need(isinstance(raw['services'], dict) and raw['services'] and all(re.fullmatch(r'[a-z]{2,20}', s) and re.fullmatch(r'[a-z0-9-]{2,40}\.env', f)
         for s, f in raw['services'].items()), 'ENV_CONFIG_SERVICES')
    return raw


def read_env(path):
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                k, v = line.split('=', 1)
                values[k.strip()] = v
    return values


def write_env(path, updates, now=None):
    need(all(KEY.match(k) and '\n' not in v and '\0' not in v for k, v in updates.items()), 'ENV_VALUE_INVALID')
    lines = path.read_text().splitlines() if path.exists() else []
    if path.exists():
        stamp = (now or datetime.now(timezone.utc)).strftime('%Y%m%dT%H%M%SZ')
        n = 0
        while (path.with_name('%s.before-v7-%s-%d' % (path.name, stamp, n))).exists():
            n += 1
        backup = path.with_name('%s.before-v7-%s-%d' % (path.name, stamp, n))
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write('\n'.join(lines) + '\n')
    seen = set()
    out = []
    for line in lines:
        key = line.split('=', 1)[0].strip() if '=' in line and not line.lstrip().startswith('#') else None
        if key in updates:
            out.append(key + '=' + updates[key]); seen.add(key)
        else:
            out.append(line)
    out += [k + '=' + v for k, v in updates.items() if k not in seen]
    tmp = path.with_name('.' + path.name + '.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write('\n'.join(out) + '\n'); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, path)


class Host:
    def __init__(self, config, runner=subprocess.run, opener=urllib.request.urlopen):
        self.config, self.runner, self.opener = config, runner, opener

    def psql(self, sql):
        c = self.config
        r = self.runner([*c['compose'], 'exec', '-T', c['postgres_service'], 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', c['pg_user'], '-d', c['database']],
                        input=sql.encode(), capture_output=True, timeout=120, cwd=c['workdir'])
        need(r.returncode == 0, 'ENV_PSQL_FAILED')
        return (r.stdout or b'').decode().strip()

    def add_version(self, project, name, raw):
        req = urllib.request.Request(TOKEN_URL, headers={'Metadata-Flavor': 'Google'})
        with self.opener(req, timeout=10) as r:
            token = json.loads(r.read())['access_token']
        url = 'https://secretmanager.googleapis.com/v1/projects/%s/secrets/%s:addVersion' % (project, name)
        body = json.dumps({'payload': {'data': b64encode(raw).decode(), 'dataCrc32c': str(crc32c(raw))}}).encode()
        request = urllib.request.Request(url, data=body, method='POST', headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with self.opener(request, timeout=20) as r:
            version = json.loads(r.read()).get('name', '')
        need(re.fullmatch(r'projects/[0-9]+/secrets/' + re.escape(name) + r'/versions/[0-9]+', version), 'ENV_ESCROW_UNCONFIRMED')
        return version


def crc32c(raw):
    value = 0xffffffff
    for byte in raw:
        value ^= byte
        for _ in range(8):
            value = (value >> 1) ^ (0x82f63b78 if value & 1 else 0)
    return value ^ 0xffffffff


def generate(config, service, key, kind, project, secret, template=None, host=None):
    need(KEY.match(key) and kind in ('aes256', 'token') and re.fullmatch(r'[a-z][a-z0-9-]{4,61}[a-z0-9]', project)
         and re.fullmatch(r'commerce-v7-[a-z0-9-]{3,60}', secret), 'ENV_GENERATE_ARGS')
    need(template is None or (template.count('{}') == 1 and template.startswith('https://') and '\n' not in template), 'ENV_GENERATE_TEMPLATE')
    path = service_file(config, service)
    if read_env(path).get(key):
        return {'state': 'KEPT', 'service': service, 'key': key}
    raw = secrets.token_bytes(32)
    value = b64encode(raw).decode() if kind == 'aes256' else urlsafe_b64encode(raw).decode().rstrip('=')
    escrowed = value.encode() if kind == 'token' else raw
    version = (host or Host(config)).add_version(project, secret, escrowed)
    write_env(path, {key: template.replace('{}', value) if template else value})
    return {'state': 'GENERATED', 'service': service, 'key': key, 'version': version, 'sha256': sha256(escrowed).hexdigest()}


def service_file(config, service):
    need(service in config['services'], 'ENV_SERVICE_UNKNOWN')
    return Path(config['secrets_dir']) / config['services'][service]


def logins(config, host=None, password=lambda: secrets.token_hex(32)):
    host = host or Host(config)
    result = {}
    for spec in LOGINS:
        files = [service_file(config, s) for s in spec['services']]
        if all(read_env(f).get(spec['env']) for f in files):
            result[spec['name']] = 'KEPT'
            continue
        user = 'commerce_' + spec['name'] + '_v7_login'
        pw = password()
        need(re.fullmatch(r'[a-f0-9]{64}', pw), 'ENV_PASSWORD_SHAPE')
        inherit = 'INHERIT' if spec['inherit'] else 'NOINHERIT'
        host.psql(f"""DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{user}') THEN
  CREATE ROLE "{user}" LOGIN PASSWORD '{pw}' {inherit} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
 ELSE
  ALTER ROLE "{user}" WITH LOGIN PASSWORD '{pw}' {inherit} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
 END IF;
END$$;
GRANT "{spec['role']}" TO "{user}";""")
        url = 'postgres://%s:%s@%s:5432/%s' % (user, pw, config['db_host'], config['database'])
        for f in files:
            write_env(f, {spec['env']: url})
        result[spec['name']] = 'CONFIGURED'
    return result


def merge(config, service, source, prefix):
    need(re.fullmatch(r'[A-Z][A-Z0-9]{1,20}_', prefix), 'ENV_MERGE_PREFIX')
    src = Path(source)
    st = src.lstat()
    need(src.is_file() and not src.is_symlink() and st.st_mode & 0o077 == 0, 'ENV_MERGE_SOURCE_MODE')
    pairs = {k: v for k, v in read_env(src).items() if k.startswith(prefix)}
    need(pairs, 'ENV_MERGE_EMPTY')
    write_env(service_file(config, service), pairs)
    return sorted(pairs)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        need(len(argv) >= 2, 'usage')
        config = load_config(argv[1])
        if argv[0] == 'logins' and len(argv) == 2:
            print(json.dumps({'state': 'LOGINS_READY', 'logins': logins(config)}))
        elif argv[0] == 'set' and len(argv) >= 4:
            pairs = dict(a.split('=', 1) for a in argv[3:])
            write_env(service_file(config, argv[2]), pairs)
            print(json.dumps({'state': 'SETTINGS_WRITTEN', 'service': argv[2], 'keys': sorted(pairs)}))
        elif argv[0] == 'merge' and len(argv) == 5:
            print(json.dumps({'state': 'MERGED', 'service': argv[2], 'keys': merge(config, argv[2], argv[3], argv[4])}))
        elif argv[0] == 'generate' and len(argv) in (7, 8):
            print(json.dumps(generate(config, *argv[2:])))
        else:
            raise EnvError('usage')
        return 0
    except (EnvError, OSError, ValueError, subprocess.TimeoutExpired) as e:
        print(json.dumps({'state': 'ENV_FAILED', 'error': str(e)[:200]}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
