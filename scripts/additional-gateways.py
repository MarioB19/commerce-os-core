#!/usr/bin/env python3
"""Canonical optional WAHA slots. Never starts containers or writes credentials."""
import json
import hashlib
import fcntl
import tempfile
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent


def overlay(slots, directory):
    if not slots or len(slots) != len(set(slots)) or any(not re.fullmatch(r'0[2-9]|1[0-9]|20', s) for s in slots):
        raise ValueError('INVALID_ADDITIONAL_GATEWAY_SLOTS')
    directory = Path(directory)
    if not directory.is_absolute() or directory.is_symlink():
        raise ValueError('PRIVATE_GATEWAY_DIRECTORY_REQUIRED')
    image = re.search(r'^    image: (.+)$', (ROOT / 'infra/compose/pilot.yaml').read_text(), re.M).group(1)
    services, networks, volumes = {}, {}, {}
    for slot in sorted(slots):
        service, network = 'waha-' + slot, 'gateway-' + slot
        services[service] = {
            'image': image, 'platform': 'linux/amd64', 'restart': 'no', 'init': True,
            'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
            'pids_limit': 100, 'mem_limit': '768m', 'cpus': 0.3, 'stop_grace_period': '30s',
            'env_file': [str(directory / (service + '.env'))],
            'environment': {
                'WHATSAPP_DEFAULT_ENGINE': 'GOWS', 'WAHA_WORKER_ID': service,
                'WAHA_BASE_URL': 'http://' + service + ':3000', 'WAHA_PRINT_QR': 'false',
                'WAHA_DASHBOARD_ENABLED': 'false', 'WHATSAPP_SWAGGER_ENABLED': 'false',
                'WHATSAPP_RESTART_ALL_SESSIONS': 'false', 'WAHA_WORKER_RESTART_SESSIONS': 'false',
                'WHATSAPP_START_SESSION': '', 'WAHA_APPS_ENABLED': 'false',
                'WAHA_LOG_FORMAT': 'JSON', 'WAHA_LOG_LEVEL': 'warn', 'WAHA_HTTP_LOG_LEVEL': 'warn',
                'WHATSAPP_FILES_LIFETIME': '3600', 'WHATSAPP_FILES_FOLDER': '/app/.media',
            },
            'volumes': [service + '-sessions:/app/.sessions', service + '-media:/app/.media'],
            'networks': [network],
            'logging': {'driver': 'json-file', 'options': {'max-size': '5m', 'max-file': '2'}},
        }
        networks[network] = {}
        volumes[service + '-sessions'] = {}
        volumes[service + '-media'] = {}
    for worker in ['channel-worker', 'ingress']:
        services[worker] = {'networks': dict(networks)}
    return {'services': services, 'networks': networks, 'volumes': volumes}


def validate(path, directory):
    path = Path(path)
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise ValueError('PRIVATE_GATEWAY_OVERLAY_REQUIRED')
    value = json.loads(path.read_text())
    slots = [s.removeprefix('waha-') for s in value.get('services', {}) if s.startswith('waha-')]
    if value != overlay(slots, directory):
        raise ValueError('ADDITIONAL_GATEWAY_OVERLAY_CHANGED')
    for slot in slots:
        credential = Path(directory) / ('waha-' + slot + '.env')
        if not credential.is_file() or credential.is_symlink() or credential.stat().st_mode & 0o077:
            raise ValueError('PRIVATE_GATEWAY_CREDENTIAL_REQUIRED')
    return slots


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest() if Path(path).exists() else 'absent'


def incremental(path, directory, slots, expected=None, apply=False):
    """Review/apply a monotone extension; previous services and credentials are immutable."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lockpath = path.with_suffix(path.suffix + '.lock')
    fd = os.open(lockpath, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous = validate(path, directory) if path.exists() else []
        desired = sorted(set(previous) | set(slots))
        value = overlay(desired, directory)
        before = digest(path)
        encoded = (json.dumps(value, indent=2) + '\n').encode()
        after = hashlib.sha256(encoded).hexdigest()
        diff = {'previous_revision': before, 'revision': after,
                'added': sorted(set(desired) - set(previous)), 'preserved': previous,
                'additional_gateways': len(desired), 'containers_started': 0}
        if not apply:
            return diff
        # Exact retries are harmless. A smaller stale request must not be called
        # a replay merely because another expansion already covers its slots.
        if before == after and (expected == before or set(slots) == set(previous)):
            return {**diff, 'applied': True, 'replayed': True}
        if expected != before:
            raise ValueError('GATEWAY_REVISION_CONFLICT')
        # Validate every credential before replacing anything.
        for slot in desired:
            credential = Path(directory) / ('waha-' + slot + '.env')
            if not credential.is_file() or credential.is_symlink() or credential.stat().st_mode & 0o077:
                raise ValueError('PRIVATE_GATEWAY_CREDENTIAL_REQUIRED')
        tempfd, tempname = tempfile.mkstemp(prefix='.gateway-', dir=path.parent)
        try:
            with os.fdopen(tempfd, 'wb') as target:
                target.write(encoded)
                target.flush()
                os.fsync(target.fileno())
            validate(tempname, directory)
            if path.exists():
                backup = path.with_suffix('.' + before + '.backup')
                if not backup.exists():
                    with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as target:
                        target.write(path.read_bytes())
                        target.flush()
                        os.fsync(target.fileno())
            os.replace(tempname, path)
            parentfd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(parentfd)
            finally:
                os.close(parentfd)
            validate(path, directory)
            if digest(path) != after:
                raise ValueError('GATEWAY_READBACK_MISMATCH')
            return {**diff, 'applied': True, 'replayed': False}
        finally:
            if os.path.exists(tempname):
                os.unlink(tempname)

def main():
    action, path, directory, *slots = sys.argv[1:]
    if action in ('plan', 'extend'):
        expected = slots.pop(0) if action == 'extend' and slots else None
        print(json.dumps(incremental(path, directory, slots, expected, action == 'extend')))
        return
    if action == 'prepare':
        value = overlay(slots, directory)
        # Refuse replacement, including concurrent preparation and symlinks.
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as target:
            target.write(json.dumps(value, indent=2) + '\n')
    elif action != 'validate' or slots:
        raise ValueError('INVALID_GATEWAY_OPERATION')
    slots = validate(path, directory)
    print(json.dumps({'valid': True, 'additional_gateways': len(slots), 'containers_started': 0}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, AttributeError) as error:
        # Never echo parsed credentials, paths or private overlay values.
        print(type(error).__name__ + ': ADDITIONAL_GATEWAY_VALIDATION_FAILED', file=sys.stderr)
        sys.exit(2)
