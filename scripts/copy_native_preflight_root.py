#!/usr/bin/env python3
"""Fixed stdin-only Linux Root diagnostic. No configuration or business mutations."""
import datetime as dt
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import select
import stat
import subprocess
import time

BASE = Path('/opt/commerce-os')
PRIVATE = BASE / 'private'
MAX_BYTES = 1024 * 1024
MAX_OUTPUT = 256 * 1024
SERVICES = {'api', 'web', 'postgres', 'caddy', 'ingress', 'automation-worker', 'channel-worker', 'waha-01', 'waha-02', 'waha-03'}
STATUSES = {'SUCCEEDED', 'FAILED', 'RUNNING', 'PREPARED_ACTION_REQUIRED', 'FAILED_RECONCILED', 'LOCAL_CUSTODY_PENDING', 'RECONCILIATION_REQUIRED', 'ADOPTED_EXISTING_API_WEB', 'ADOPTED_COPY_RUNTIME', 'APPLIED', 'PREWRITE', 'TOOLS_INSTALLING_PAIR_CAS_PENDING', 'TOOLS_INSTALLED_PAIR_CAS_PENDING', 'PAIR_APPLIED'}
REASONS = {'MISSING', 'CUSTODY', 'FORMAT', 'BOUND', 'COMMAND', 'DRIFT', 'UNRECOGNIZED'}
ENV_NAMES = ('release.env', 'api.env', 'ingress.env', 'automation.env', 'channel.env', 'postgres.env', 'admin.env')
DIGEST = re.compile(r'[a-f0-9]{64}')
RUN_ID = re.compile(r'[1-9][0-9]*-[1-9][0-9]*')
DEADLINE = None


def need(condition, code):
    if not condition:
        raise RuntimeError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def unique(raw):
    def pairs(values):
        result = {}
        for key, value in values:
            need(key not in result, 'FORMAT')
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(RuntimeError('FORMAT')))
    except (ValueError, UnicodeError, RecursionError):
        raise RuntimeError('FORMAT') from None


def check_deadline():
    need(DEADLINE is None or time.monotonic() < DEADLINE, 'BOUND')


def command(args):
    check_deadline()
    environment = {'PATH': '/usr/bin:/usr/sbin:/bin:/sbin', 'LANG': 'C', 'HOME': '/nonexistent'}
    child = None
    try:
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, env=environment)
        expires = min(DEADLINE or time.monotonic()+15, time.monotonic()+15)
        raw = bytearray()
        while True:
            remaining = expires-time.monotonic()
            need(remaining > 0, 'BOUND')
            ready, _, _ = select.select([child.stdout], [], [], remaining)
            need(bool(ready), 'BOUND')
            part = os.read(child.stdout.fileno(), 65536)
            if not part:
                break
            raw.extend(part); need(len(raw) <= MAX_BYTES, 'BOUND')
        need(child.wait(timeout=max(0.1, expires-time.monotonic())) == 0, 'COMMAND')
        return bytes(raw)
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError('COMMAND') from None
    finally:
        if child is not None:
            if child.poll() is None:
                child.kill()
            child.stdout.close()
            child.wait(timeout=5)


def docker(*args):
    return command(['/usr/bin/docker', '--config=/nonexistent', '--host=unix:///var/run/docker.sock', *args])


def signature(info):
    return tuple(getattr(info, name) for name in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_uid', 'st_mode', 'st_nlink'))


def directory(path, private=True):
    current = Path(path)
    while True:
        info = current.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'CUSTODY')
        if private and current.is_relative_to(PRIVATE):
            need(stat.S_IMODE(info.st_mode) == 0o700, 'CUSTODY')
        if current == Path('/'):
            break
        current = current.parent
    return info


def protected(path, private=True):
    path = Path(path)
    directory(path.parent, private)
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, 'O_NOATIME', 0)
    with os.fdopen(os.open(path, flags), 'rb') as source:
        info = os.fstat(source.fileno())
        need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
             and (stat.S_IMODE(info.st_mode) == 0o600 if private else not info.st_mode & 0o022)
             and 0 < info.st_size <= MAX_BYTES, 'CUSTODY')
        raw = source.read(MAX_BYTES + 1)
        need(len(raw) == info.st_size and signature(info) == signature(os.fstat(source.fileno()))
             == signature(path.lstat()), 'DRIFT')
    return raw, {'status': 'OBSERVED', 'sha256': sha(raw), 'bytes': len(raw), 'uid': 0,
                 'mode': stat.S_IMODE(info.st_mode), 'nlink': 1}


def unknown(error):
    reason = str(error) if isinstance(error, RuntimeError) and str(error) in REASONS else 'COMMAND'
    if isinstance(error, FileNotFoundError):
        reason = 'MISSING'
    return {'status': 'UNKNOWN', 'reason': reason}


def file_observation(path, json_fields=False):
    try:
        raw, result = protected(path)
        if json_fields:
            value = unique(raw)
            need(type(value) is dict, 'FORMAT')
            result['schema_version'] = value.get('schema_version') if type(value.get('schema_version')) is int and 0 < value['schema_version'] <= 3 else None
            result['document_status'] = value.get('status') if value.get('status') in STATUSES else None
            result['runtime_stage'] = value.get('runtime_stage') if value.get('runtime_stage') in {'CORE_PREPARED', 'OPERATING'} else None
            result['scope'] = value.get('scope') if value.get('scope') in {'api-web', 'copy-runtime'} else None
        return result
    except (RuntimeError, OSError, ValueError, TypeError, RecursionError) as error:
        return unknown(error)


def current_release():
    try:
        directory(BASE, False)
        link = BASE / 'current'
        info = link.lstat()
        need(stat.S_ISLNK(info.st_mode) and info.st_uid == 0, 'CUSTODY')
        link_text = os.readlink(link)
        target = Path(link_text)
        target = target if target.is_absolute() else BASE / target
        need(target.parent == BASE / 'releases' and re.fullmatch(r'ci-[1-9][0-9]*-[1-9][0-9]*-[a-f0-9]{12}', target.name), 'FORMAT')
        directory(target, False)
        raw, result = protected(target / 'RELEASE.json', False)
        value = unique(raw)
        need(type(value) is dict and type(value.get('source_sha')) is str and re.fullmatch(r'[a-f0-9]{40}', value['source_sha']), 'FORMAT')
        need(signature(link.lstat()) == signature(info) and os.readlink(link) == link_text, 'DRIFT')
        return {'status': 'OBSERVED', 'source_sha': value['source_sha'], 'release_sha256': sha(target.name.encode()),
                'metadata_sha256': result['sha256']}
    except (RuntimeError, OSError, ValueError, TypeError, RecursionError) as error:
        return unknown(error)


def journals(base, filename):
    try:
        directory(base)
        entries = sorted(Path(base).iterdir(), key=lambda item: item.name)
        need(len(entries) <= 100, 'BOUND')
        result = []
        for entry in entries:
            directory(entry)
            observation = file_observation(entry / filename, True)
            result.append({'name_sha256': sha(entry.name.encode()), 'run_id': entry.name if RUN_ID.fullmatch(entry.name) else None,
                           'observation': observation})
        return {'status': 'OBSERVED', 'entries': result}
    except (RuntimeError, OSError, ValueError, TypeError) as error:
        return unknown(error)


def containers():
    ids = docker('ps', '-aq', '--no-trunc').decode().split()
    need(len(ids) <= 32 and len(ids) == len(set(ids)) and all(DIGEST.fullmatch(cid) for cid in ids), 'BOUND')
    if not ids:
        return [], []
    rows = unique(docker('inspect', *sorted(ids)))
    need(type(rows) is list and len(rows) == len(ids) and {row.get('Id') for row in rows if type(row) is dict} == set(ids), 'FORMAT')
    result = []
    for row in rows:
        need(type(row.get('Image')) is str and re.fullmatch(r'sha256:[a-f0-9]{64}', row['Image']), 'FORMAT')
        config, host, state = row.get('Config', {}), row.get('HostConfig', {}), row.get('State', {})
        need(type(config) is dict and type(host) is dict and type(state) is dict and type(config.get('Env', [])) is list, 'FORMAT')
        labels = config.get('Labels') or {}
        service = labels.get('com.docker.compose.service')
        if service not in SERVICES:
            service = 'portal' if labels.get('com.inovaris.product') == 'mi-ciclo-listo-portal' else None
        ports = []
        for port, bindings in (host.get('PortBindings') or {}).items():
            need(re.fullmatch(r'[1-9][0-9]{0,4}/(?:tcp|udp)', port), 'FORMAT')
            for binding in bindings or []:
                need(type(binding) is dict and type(binding.get('HostIp')) is str and type(binding.get('HostPort')) is str
                     and binding['HostPort'].isdigit() and 0 < int(binding['HostPort']) <= 65535, 'FORMAT')
                address = binding['HostIp']
                if address:
                    ipaddress.ip_address(address)
                ports.append({'container_port': port, 'host_ip': address, 'host_port': int(binding['HostPort'])})
        need(len(ports) <= 32 and type(state.get('Running')) is bool and type(state.get('Pid')) is int and 0 <= state['Pid'] <= 2**31-1, 'FORMAT')
        result.append({'id': row['Id'], 'image_id': row['Image'], 'name_sha256': sha(str(row.get('Name', '')).encode()),
                       'service': service, 'running': state['Running'], 'pid': state['Pid'],
                       'env_sha256': sha(json.dumps(config.get('Env', []), separators=(',', ':')).encode()),
                       'definition_sha256': sha(json.dumps({key: row.get(key) for key in ('Config', 'HostConfig', 'Mounts')}, sort_keys=True, separators=(',', ':')).encode()),
                       'ports': ports})
    need(set(docker('ps', '-aq', '--no-trunc').decode().split()) == set(ids), 'DRIFT')
    return sorted(result, key=lambda item: item['id']), ids


def networks():
    ids = docker('network', 'ls', '--quiet', '--no-trunc').decode().split()
    need(len(ids) <= 32 and len(ids) == len(set(ids)) and all(DIGEST.fullmatch(cid) for cid in ids), 'BOUND')
    rows = unique(docker('network', 'inspect', *sorted(ids))) if ids else []
    need(type(rows) is list and len(rows) == len(ids) and {row.get('Id') for row in rows if type(row) is dict} == set(ids), 'FORMAT')
    result = []
    for row in rows:
        need(row.get('Id') in ids and row.get('Driver') in {'bridge', 'host', 'null'} and type(row.get('Internal')) is bool, 'FORMAT')
        configs = row.get('IPAM', {}).get('Config') or []
        need(type(configs) is list and len(configs) <= 8, 'BOUND')
        ranges = []
        for config in configs:
            subnet, gateway = config.get('Subnet'), config.get('Gateway')
            if subnet is not None:
                need(type(subnet) is str, 'FORMAT'); ipaddress.ip_network(subnet)
            if gateway is not None:
                need(type(gateway) is str, 'FORMAT'); ipaddress.ip_address(gateway)
            ranges.append({'subnet': subnet, 'gateway': gateway})
        endpoints = row.get('Containers') or {}
        need(type(endpoints) is dict and len(endpoints) <= 32 and all(DIGEST.fullmatch(cid) for cid in endpoints), 'BOUND')
        result.append({'id': row['Id'], 'name_sha256': sha(str(row.get('Name', '')).encode()), 'driver': row['Driver'],
                       'internal': row['Internal'], 'ipam': ranges, 'container_ids': sorted(endpoints),
                       'definition_sha256': sha(json.dumps({key: row.get(key) for key in ('IPAM', 'Options', 'Labels')}, sort_keys=True, separators=(',', ':')).encode())})
    return sorted(result, key=lambda item: item['id'])


def volumes():
    names = docker('volume', 'ls', '--quiet').decode().split()
    need(len(names) <= 64 and len(names) == len(set(names)) and all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', name) for name in names), 'BOUND')
    rows = unique(docker('volume', 'inspect', *sorted(names))) if names else []
    need(type(rows) is list and len(rows) == len(names) and {row.get('Name') for row in rows} == set(names), 'FORMAT')
    return sorted([{'name_sha256': sha(row['Name'].encode()), 'driver': row.get('Driver') if row.get('Driver') == 'local' else None,
                    'definition_sha256': sha(json.dumps({key: row.get(key) for key in ('Driver', 'Options', 'Labels')}, sort_keys=True, separators=(',', ':')).encode())}
                   for row in rows], key=lambda item: item['name_sha256'])


def observed(function):
    try:
        return {'status': 'OBSERVED', 'items': function()}
    except (RuntimeError, OSError, ValueError, TypeError, KeyError, AttributeError, UnicodeError) as error:
        return unknown(error)


def collect():
    result = {'schema_version': 1, 'status': 'OBSERVED', 'observed_at': dt.datetime.now(dt.timezone.utc).isoformat(),
              'business_mutations': 0, 'configuration_mutations': 0, 'backup_executed': False, 'installed': False,
              'readiness_proven': False, 'snapshot_atomic': False, 'current_release': current_release(),
              'files': {'api-web-adoption.json': file_observation(PRIVATE / 'api-web-adoption.json', True),
                        'daily-b02/plan.json': file_observation(PRIVATE / 'daily-b02/plan.json', True)},
              'deployment_journals': journals(PRIVATE / 'deployments', 'report.json'),
              'backup_journals': journals(PRIVATE / 'daily-b02/runs', 'journal.json'),
              'controller_journals': journals(PRIVATE / 'daily-b02/controller-updates', 'journal.json')}
    for name in ENV_NAMES:
        result['files'][name] = file_observation(PRIVATE / name)
    result['containers'] = observed(lambda: containers()[0])
    result['networks'] = observed(networks)
    result['volumes'] = observed(volumes)
    try:
        directory(BASE, False); available = os.statvfs(BASE)
        result['disk'] = {'status': 'OBSERVED', 'available_bytes': available.f_bavail * available.f_frsize}
    except (RuntimeError, OSError) as error:
        result['disk'] = unknown(error)
    # No whole-host transaction or commercial readiness is inferred from reads.
    def has_unknown(value):
        return type(value) is dict and (value.get('status') == 'UNKNOWN' or any(has_unknown(v) for v in value.values())) or type(value) is list and any(has_unknown(v) for v in value)
    if has_unknown(result):
        result['status'] = 'OBSERVED_PARTIAL'
    return result


def main():
    global DEADLINE
    need(os.geteuid() == 0 and os.uname().sysname == 'Linux', 'ROOT_LINUX_REQUIRED')
    DEADLINE = time.monotonic() + 120
    def interrupted(_signum, _frame):
        raise RuntimeError('BOUND')
    signal.signal(signal.SIGALRM, interrupted); signal.alarm(120)
    try:
        result = collect(); raw = json.dumps(result, sort_keys=True, separators=(',', ':'))
        need(len(raw.encode()) <= MAX_OUTPUT, 'BOUND')
        print(raw)
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print('{"schema_version":1,"status":"UNKNOWN","reason":"COLLECTOR_FAILED","readiness_proven":false}')
        raise SystemExit(1)
