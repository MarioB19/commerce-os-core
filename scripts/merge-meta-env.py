#!/usr/bin/env python3
"""Merge an authorized Meta transfer file into the API-only env file.
No network. No dotenv execution. No credential values or token hashes emitted.
Run as the existing configuration owner (or root). Transfer deletion is separate
so the operator can verify the restarted API before removing the transfer file.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import stat

class Refusal(Exception):
    pass

def require(condition, code):
    if not condition:
        raise Refusal(code)

def private_file(path):
    require(path.is_file() and not path.is_symlink(), 'PRIVATE_REGULAR_FILE_REQUIRED')
    metadata = path.stat()
    require(stat.S_IMODE(metadata.st_mode) & 0o077 == 0, 'PRIVATE_FILE_PERMISSIONS_REQUIRED')
    require(not path.parent.is_symlink() and path.parent.stat().st_mode & 0o022 == 0, 'PRIVATE_DIRECTORY_REQUIRED')
    return metadata

def parse(data):
    result = {}
    for line in data.decode().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*', line)
        require(match is not None, 'ENV_SYNTAX_REQUIRES_REVIEW')
        key, value = match.groups()
        require(key not in result, 'DUPLICATE_ENV_KEY_REQUIRES_REVIEW')
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        result[key] = value
    return result

def incoming_values(data):
    values = parse(data)
    aliases = values.get('META_ACCOUNT_KEYS', '').split(',')
    require(len(aliases) == 2 and len(set(aliases)) == 2 and all(re.fullmatch(r'[a-z0-9_]+', alias) for alias in aliases), 'EXPECTED_TWO_CREDENTIAL_ALIASES')
    token_keys = ['META_ACCOUNT_' + alias.upper() + '_ACCESS_TOKEN' for alias in aliases]
    require(set(values) == {'META_WORKSPACE_ID', 'META_ACCOUNT_KEYS', *token_keys}, 'UNEXPECTED_TRANSFER_VARIABLES')
    require(bool(values['META_WORKSPACE_ID']), 'WORKSPACE_REQUIRED')
    require(all(re.fullmatch(r'EAA[A-Za-z0-9]{40,}', values[key]) for key in token_keys), 'UNEXPECTED_CREDENTIAL_FORMAT')
    require(len({values[key] for key in token_keys}) == 2, 'DISTINCT_CREDENTIALS_REQUIRED')
    return values

def write_exclusive(path, data, owner):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as handle:
        os.fchown(handle.fileno(), owner.st_uid, owner.st_gid)
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())

def merge(transfer, target):
    private_file(transfer)
    owner = private_file(target)
    require(transfer.resolve() != target.resolve(), 'DISTINCT_SOURCE_TARGET_REQUIRED')
    values = incoming_values(transfer.read_bytes())
    original = target.read_bytes()
    current = parse(original)
    require(current.get('WORKSPACE_ID') == values['META_WORKSPACE_ID'], 'PRODUCTION_WORKSPACE_MISMATCH')
    existing_meta = {key: value for key, value in current.items() if key.startswith('META_')}
    require(set(existing_meta).issubset(values), 'UNEXPECTED_EXISTING_META_CONFIGURATION')
    require(all(values[key] == value for key, value in existing_meta.items()), 'EXISTING_META_VALUES_DIFFER_REQUIRE_REVIEW')
    if existing_meta == values:
        return {'status': 'UNCHANGED', 'path': str(target), 'mode': format(stat.S_IMODE(target.stat().st_mode), '04o'), 'credential_count': 2, 'transfer_retained': True}
    key_pattern = re.compile(r'^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=')
    lines = []
    for line in original.decode().splitlines():
        match = key_pattern.match(line)
        if not match or match[1] not in values:
            lines.append(line)
    lines.extend(key + '=' + value for key, value in values.items())
    updated = ('\n'.join(lines) + '\n').encode()
    unchanged_keys = {key: value for key, value in current.items() if key not in values}
    require({key: value for key, value in parse(updated).items() if key not in values} == unchanged_keys, 'UNRELATED_CONFIGURATION_CHANGED')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(4)
    backup = target.with_name(target.name + '.before-meta.' + stamp + '.backup')
    pending = target.with_name('.' + target.name + '.meta-pending.' + stamp)
    write_exclusive(backup, original, owner)
    try:
        write_exclusive(pending, updated, owner)
        require(target.read_bytes() == original, 'CONCURRENT_CONFIGURATION_CHANGE')
        os.replace(pending, target)
        directory = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        require(target.read_bytes() == updated and stat.S_IMODE(target.stat().st_mode) == 0o600, 'MERGE_VERIFICATION_FAILED')
    finally:
        pending.unlink(missing_ok=True)
    return {'status': 'MERGED', 'path': str(target), 'mode': '0600', 'backup': str(backup), 'backup_mode': '0600', 'credential_count': 2, 'production_workspace_verified': True, 'unrelated_variables_preserved': len(unchanged_keys), 'transfer_retained': True}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('transfer', type=Path)
    parser.add_argument('target', type=Path)
    arguments = parser.parse_args()
    try:
        private_file(arguments.target)
        lock_path = arguments.target.with_name('.' + arguments.target.name + '.meta-provision.lock')
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'r+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            print(json.dumps(merge(arguments.transfer, arguments.target)))
    except Refusal as error:
        print(json.dumps({'status': 'REFUSED', 'category': str(error)}))
        raise SystemExit(2)
    except Exception as error:
        print(json.dumps({'status': 'ERROR', 'category': type(error).__name__}))
        raise SystemExit(1)

if __name__ == '__main__':
    main()
