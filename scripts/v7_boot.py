#!/usr/bin/env python3
"""V7 F1 durable boot: after the VM starts, bring the installed release back.

    v7_boot.py run /opt/commerce-os/private/boot/operator.json

Run by Root from commerce-boot.service once Docker is up. Services already
restart on their own (restart: unless-stopped); this closes the gaps a reboot
leaves: containers created but never started and the order of dependencies.
It only starts what the installed release defines (compose-release.sh, so the
PITR overlay is honoured), never recreates, pulls or builds, never starts a
WhatsApp session (the gateway supervisor and the channel worker own that) and
never touches data. A hold file (written by a maintenance window) keeps the
platform stopped across reboots. It records one receipt per boot.
"""
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

FIELDS = {'workdir', 'release_env', 'services', 'timeout_seconds', 'receipt', 'hold'}
SERVICE = re.compile(r'^[a-z][a-z0-9-]{1,40}$')


class BootError(Exception):
    pass


def need(ok, code):
    if not ok:
        raise BootError(code)


def load_config(path):
    raw = json.loads(Path(path).read_text())
    need(isinstance(raw, dict) and set(raw) == FIELDS, 'BOOT_CONFIG_FIELDS')
    for key in ('workdir', 'release_env', 'receipt', 'hold'):
        need(isinstance(raw[key], str) and raw[key].startswith('/') and '..' not in raw[key].split('/'), 'BOOT_CONFIG_' + key.upper())
    need(isinstance(raw['services'], list) and 0 < len(raw['services']) <= 30 and all(isinstance(s, str) and SERVICE.match(s) for s in raw['services'])
         and len(set(raw['services'])) == len(raw['services']), 'BOOT_CONFIG_SERVICES')
    need(isinstance(raw['timeout_seconds'], int) and 30 <= raw['timeout_seconds'] <= 1800, 'BOOT_CONFIG_TIMEOUT')
    return raw


class Host:
    def __init__(self, config, runner=subprocess.run, clock=time.monotonic, sleep=time.sleep):
        self.config, self.runner, self.clock, self.sleep = config, runner, clock, sleep

    def compose(self, *args, timeout=600):
        r = self.runner(['sh', 'scripts/compose-release.sh', self.config['release_env'], *args], capture_output=True, timeout=timeout, cwd=self.config['workdir'])
        if r.returncode != 0:
            raise BootError('BOOT_COMPOSE_FAILED ' + re.sub(r'[^\w .:/-]', '_', (r.stderr or b'').decode(errors='replace')[-200:]))
        return (r.stdout or b'').decode()

    def states(self):
        rows = {}
        for line in self.compose('ps', '--all', '--format', 'json').splitlines():
            line = line.strip()
            if not line:
                continue
            items = json.loads(line)
            for row in (items if isinstance(items, list) else [items]):
                rows[row.get('Service')] = {'state': row.get('State'), 'health': row.get('Health') or ''}
        return rows


def ready(row):
    return row and row['state'] == 'running' and row['health'] in ('', 'healthy')


def run(config, host=None, now=lambda: datetime.now(timezone.utc)):
    host = host or Host(config)
    started_at = now().isoformat()
    receipt = {'schema_version': 1, 'booted_at': started_at, 'services': {}, 'state': None}
    if Path(config['hold']).exists():
        receipt['state'] = 'HELD_FOR_MAINTENANCE'
    else:
        host.compose('up', '-d', '--no-recreate', '--no-build', '--pull', 'never', *config['services'])
        deadline = host.clock() + config['timeout_seconds']
        while True:
            rows = host.states()
            missing = [s for s in config['services'] if not ready(rows.get(s))]
            receipt['services'] = {s: rows.get(s, {'state': 'missing', 'health': ''}) for s in config['services']}
            if not missing:
                receipt['state'] = 'READY'
                break
            if host.clock() >= deadline:
                receipt['state'] = 'NOT_READY'
                break
            host.sleep(5)
    receipt['finished_at'] = now().isoformat()
    path = Path(config['receipt'])
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(receipt, sort_keys=True))
    tmp.chmod(0o600)
    tmp.replace(path)
    return receipt


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        need(len(argv) == 2 and argv[0] == 'run', 'usage: v7_boot.py run <config.json>')
        receipt = run(load_config(argv[1]))
        print(json.dumps({'state': receipt['state'], 'services': len(receipt['services'])}))
        return 0 if receipt['state'] in ('READY', 'HELD_FOR_MAINTENANCE') else 1
    except (BootError, OSError, ValueError, subprocess.TimeoutExpired) as e:
        print(json.dumps({'state': 'BOOT_FAILED', 'error': str(e)[:300]}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
