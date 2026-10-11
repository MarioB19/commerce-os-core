#!/usr/bin/env python3
"""One-off reviewed VPS setup: Resend TLS preflight and API-only infrastructure update.
Never reads or writes the SMTP credential, enables recovery, authenticates to SMTP, or sends mail.
"""
import argparse
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import stat
import subprocess
import sys
import tempfile

BASE = Path('/opt/commerce-os')
PRIVATE = BASE / 'private'
API_ENV = PRIVATE / 'api.env'
RELEASE_ENV = PRIVATE / 'release.env'
HOST, PORT = 'smtp.resend.com', 465
ORIGIN = 'https://commerce-os.inovaris.online'
KEYS = {'SMTP_ALLOWED_TARGETS', 'PUBLIC_WEB_ORIGIN'}
COMMAND_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}

class SetupError(RuntimeError):
    pass

def require(value, code):
    if not value:
        raise SetupError(code)

def run(args, *, cwd=None, input_text=None, timeout=30):
    try:
        result = subprocess.run(args, cwd=cwd, env=COMMAND_ENV, input=input_text,
                                capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise SetupError('COMMAND_UNAVAILABLE_OR_TIMEOUT') from None
    require(result.returncode == 0, 'COMMAND_FAILED')
    return result.stdout.strip()

def smtp_reply(stream):
    code = None
    for _ in range(40):
        line = stream.readline(4097)
        require(len(line) <= 4096 and len(line) >= 5 and line[:3].isdigit() and line[3:4] in (b'-', b' '), 'SMTP_PROTOCOL_INVALID')
        current = int(line[:3])
        if code is None:
            code = current
        require(current == code, 'SMTP_PROTOCOL_INVALID')
        if line[3:4] == b' ':
            return code
    raise SetupError('SMTP_REPLY_TOO_LONG')

def preflight():
    try:
        resolved = sorted({item[4][0] for item in socket.getaddrinfo(HOST, PORT, type=socket.SOCK_STREAM)},
                          key=lambda value: (ipaddress.ip_address(value).version, value))
    except (OSError, ValueError):
        raise SetupError('SMTP_DNS_FAILED') from None
    require(0 < len(resolved) <= 24 and all(ipaddress.ip_address(ip).is_global for ip in resolved), 'SMTP_DNS_TARGET_DENIED')
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    checks, usable = [], []
    for address in resolved:
        try:
            with socket.create_connection((address, PORT), timeout=8) as raw:
                with context.wrap_socket(raw, server_hostname=HOST) as secure:
                    secure.settimeout(8)
                    with secure.makefile('rb') as stream:
                        require(smtp_reply(stream) == 220, 'SMTP_GREETING_REJECTED')
                        secure.sendall(b'EHLO commerce-os.inovaris.online\r\n')
                        require(smtp_reply(stream) == 250, 'SMTP_EHLO_REJECTED')
                        secure.sendall(b'QUIT\r\n')
                        checks.append({'address': address, 'status': 'TLS_EHLO_OK', 'tls': secure.version()})
                        usable.append(address)
        except (OSError, ssl.SSLError, SetupError):
            checks.append({'address': address, 'status': 'TLS_EHLO_FAILED'})
    require(bool(usable), 'NO_VERIFIED_SMTP_ADDRESS')
    return {'host': HOST, 'port': PORT, 'verified_addresses': usable, 'checks': checks,
            'smtp_auth_attempted': False, 'smtp_mail_attempted': False}

def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def snapshot(path):
    try:
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
            before = fingerprint(os.fstat(stream.fileno()))
            require(stat.S_ISREG(before[2]) and before[2] & 0o777 == 0o600 and before[3] == 0, 'PRIVATE_FILE_PERMISSIONS_INVALID')
            data = stream.read(1024 * 1024 + 1)
            after = fingerprint(os.fstat(stream.fileno()))
        require(len(data) <= 1024 * 1024 and before == after and fingerprint(path.stat(follow_symlinks=False)) == after, 'CONFIG_CHANGED_CONCURRENTLY')
        return data, after
    except OSError:
        raise SetupError('PRIVATE_FILE_UNAVAILABLE') from None

def parse_env(data):
    values = {}
    for line in data.decode('utf-8').splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        require('=' in line, 'ENV_FORMAT_UNSUPPORTED')
        key, value = line.split('=', 1)
        require(re.fullmatch(r'[A-Z][A-Z0-9_]*', key) and key not in values, 'ENV_KEYS_AMBIGUOUS')
        values[key] = value
    return values

def candidate_env(original, verified):
    values = parse_env(original)
    try:
        targets = json.loads(values.get('SMTP_ALLOWED_TARGETS', '[]'))
    except ValueError:
        raise SetupError('EXISTING_SMTP_TARGETS_INVALID') from None
    require(isinstance(targets, list), 'EXISTING_SMTP_TARGETS_INVALID')
    matching = []
    for i, target in enumerate(targets):
        require(isinstance(target, dict) and set(target) == {'host', 'port', 'mode', 'addresses'} and
                isinstance(target['host'], str) and isinstance(target['port'], int) and not isinstance(target['port'], bool) and
                target['mode'] in ('local', 'remote') and isinstance(target['addresses'], list) and target['addresses'], 'EXISTING_SMTP_TARGETS_INVALID')
        try:
            for address in target['addresses']:
                ipaddress.ip_address(address)
        except (ValueError, TypeError):
            raise SetupError('EXISTING_SMTP_TARGETS_INVALID') from None
        if (target['host'], target['port'], target['mode']) == (HOST, PORT, 'remote'):
            matching.append(i)
    require(len(matching) <= 1, 'DUPLICATE_RESEND_TARGET')
    if matching:
        index = matching[0]
        # Keep every existing authorized address, but put a freshly verified one first: the app uses addresses[0].
        addresses = list(dict.fromkeys(verified + targets[index]['addresses']))
        targets[index] = {**targets[index], 'addresses': addresses}
    else:
        targets.append({'host': HOST, 'port': PORT, 'mode': 'remote', 'addresses': verified})
    updates = {'SMTP_ALLOWED_TARGETS': json.dumps(targets, separators=(',', ':')), 'PUBLIC_WEB_ORIGIN': ORIGIN}
    lines, seen = [], set()
    for line in original.splitlines(keepends=True):
        key = line.split(b'=', 1)[0].decode('ascii', errors='ignore')
        if key in updates:
            ending = b'\r\n' if line.endswith(b'\r\n') else b'\n'
            lines.append((key + '=' + updates[key]).encode() + ending)
            seen.add(key)
        else:
            lines.append(line)
    if lines and not lines[-1].endswith(b'\n'):
        lines[-1] += b'\n'
    lines.extend((key + '=' + value + '\n').encode() for key, value in updates.items() if key not in seen)
    candidate = b''.join(lines)
    resulting = parse_env(candidate)
    require({k: v for k, v in resulting.items() if k not in KEYS} == {k: v for k, v in values.items() if k not in KEYS}, 'UNRELATED_ENV_CHANGE')
    return candidate, updates

def current_release():
    require((BASE / 'current').is_symlink(), 'CURRENT_RELEASE_REQUIRED')
    root = (BASE / 'current').resolve(strict=True)
    require(root.parent == BASE / 'releases' and (root / 'scripts/compose-release.sh').is_file(), 'UNEXPECTED_CURRENT_RELEASE')
    return root

def compose(root, *args, input_text=None, timeout=30):
    return run(['sh', str(root / 'scripts/compose-release.sh'), str(RELEASE_ENV), *args], cwd=root, input_text=input_text, timeout=timeout)

def no_ci_unit():
    units = run(['systemctl', 'list-units', '--all', '--type=service', '--state=active,activating', '--plain', '--no-legend', '--no-pager', 'commerce-ci-*.service'])
    require(not units, 'CI_DEPLOYMENT_IN_PROGRESS')

def mail_idle(root):
    sql = "SELECT json_build_object('disabled',NOT EXISTS(SELECT 1 FROM identity_mail_settings WHERE enabled),'pending',(SELECT count(*) FROM identity_mail_jobs WHERE status IN ('PENDING','SENDING')));"
    data = json.loads(compose(root, 'exec', '-T', 'postgres', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'commerce_owner', '-d', 'commerce', input_text=sql))
    require(data.get('disabled') is True and data.get('pending') == 0, 'IDENTITY_MAIL_MUST_BE_DISABLED_AND_IDLE')

def other_containers():
    ids = run(['docker', 'ps', '-q']).split()
    require(bool(ids), 'RUNNING_CONTAINERS_REQUIRED')
    template = '{{.Id}}\t{{.Image}}\t{{.State.StartedAt}}\t{{json .NetworkSettings.Networks}}\t{{json .Mounts}}\t{{index .Config.Labels "com.docker.compose.project"}}\t{{index .Config.Labels "com.docker.compose.service"}}'
    records = {}
    for line in run(['docker', 'inspect', '--format', template, *ids]).splitlines():
        parts = line.split('\t')
        require(len(parts) == 7, 'CONTAINER_SNAPSHOT_INVALID')
        if parts[-2:] != ['commerce-os', 'api']:
            records[parts[0]] = parts[1:]
    return records

def api_runtime_matches(root, updates):
    code = "const fs=require('fs');const expected=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(Object.entries(expected).every(([k,v])=>process.env[k]===v)?'MATCH':'MISMATCH');"
    return compose(root, 'exec', '-T', 'api', 'node', '-e', code, input_text=json.dumps(updates)) == 'MATCH'

def guards(root, original_release, expected_api):
    require(current_release() == root and snapshot(RELEASE_ENV) == original_release and snapshot(API_ENV) == expected_api, 'DEPLOYMENT_OR_CONFIG_CHANGED_CONCURRENTLY')
    no_ci_unit()

def replace_private(path, expected, content):
    require(snapshot(path) == expected, 'CONFIG_CHANGED_CONCURRENTLY')
    fd, filename = tempfile.mkstemp(prefix='.smtp-env-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        os.fchown(fd, expected[1][3], expected[1][4])
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        require(snapshot(path) == expected, 'CONFIG_CHANGED_CONCURRENTLY')
        os.replace(filename, path)
        try:
            return snapshot(path)
        except Exception:
            raise SetupError('ENV_REPLACED_VERIFICATION_REQUIRED') from None
    finally:
        Path(filename).unlink(missing_ok=True)

def apply(expected_release):
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    require(re.fullmatch(r'[A-Za-z0-9_.-]+', expected_release), 'EXPECTED_RELEASE_REQUIRED')
    with (PRIVATE / 'ci-deploy.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SetupError('CI_DEPLOYMENT_IN_PROGRESS') from None
        no_ci_unit()
        root = current_release()
        require(root.name == expected_release, 'CURRENT_RELEASE_CHANGED')
        original_release, original_api = snapshot(RELEASE_ENV), snapshot(API_ENV)
        release_values, api_values = parse_env(original_release[0]), parse_env(original_api[0])
        require(release_values.get('COMMERCE_ORIGIN') == ORIGIN and release_values.get('COMMERCE_SECRETS_DIR') == str(PRIVATE), 'UNEXPECTED_RELEASE_CONFIG')
        require(api_values.get('COMMERCE_DEPLOYMENT_STATUS') == 'DEPLOYED' and api_values.get('NODE_ENV') == 'production', 'API_NOT_DEPLOYED')
        mail_idle(root)
        before = other_containers()
        probe = preflight()
        candidate, updates = candidate_env(original_api[0], probe['verified_addresses'])
        guards(root, original_release, original_api)
        if candidate == original_api[0] and api_runtime_matches(root, updates):
            return {'status': 'UNCHANGED', 'current_release': root.name, 'preflight': probe, 'api_runtime_verified': True, 'other_services_preserved': True, 'mail_enabled': False}
        work = Path(tempfile.mkdtemp(prefix='smtp-setup-', dir=PRIVATE))
        backup = work / 'api.env.previous'
        with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
            stream.write(original_api[0])
            stream.flush()
            os.fsync(stream.fileno())
        installed = None
        try:
            guards(root, original_release, original_api)
            mail_idle(root)
            installed = replace_private(API_ENV, original_api, candidate)
            guards(root, original_release, installed)
            compose(root, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'api', timeout=210)
            guards(root, original_release, installed)
            require(api_runtime_matches(root, updates), 'API_ENV_NOT_APPLIED')
            mail_idle(root)
            require(other_containers() == before, 'OTHER_SERVICES_CHANGED')
        except Exception as failure:
            if installed is not None:
                try:
                    guards(root, original_release, installed)
                    restored = replace_private(API_ENV, installed, original_api[0])
                    compose(root, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'api', timeout=210)
                    guards(root, original_release, restored)
                    require(other_containers() == before, 'OTHER_SERVICES_CHANGED')
                except Exception:
                    raise SetupError('APPLY_FAILED_ROLLBACK_REQUIRES_REVIEW') from None
                raise SetupError('APPLY_FAILED_API_CONFIG_RESTORED') from None
            raise failure
        return {'status': 'UPDATED', 'current_release': root.name, 'changed_keys': sorted(KEYS), 'preflight': probe,
                'api_runtime_verified': True, 'other_services_preserved': True, 'mail_enabled': False,
                'private_backup_created': True, 'smtp_auth_attempted': False, 'smtp_mail_attempted': False}

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['preflight', 'apply'])
    parser.add_argument('--expected-release')
    args = parser.parse_args()
    try:
        if args.mode == 'preflight':
            result = {'status': 'PREFLIGHT_OK', 'preflight': preflight(), 'filesystem_changes': False}
            try:
                result['current_release'] = current_release().name
            except (OSError, SetupError):
                result['current_release'] = None
        else:
            require(bool(args.expected_release), 'EXPECTED_RELEASE_REQUIRED')
            result = apply(args.expected_release)
    except SetupError as error:
        print(json.dumps({'status': 'FAILED', 'error': str(error), 'smtp_auth_attempted': False, 'smtp_mail_attempted': False}))
        return 1
    except Exception:
        print(json.dumps({'status': 'FAILED', 'error': 'SETUP_CHECK_FAILED', 'smtp_auth_attempted': False, 'smtp_mail_attempted': False}))
        return 1
    print(json.dumps(result))
    return 0

if __name__ == '__main__':
    sys.exit(main())
