#!/usr/bin/env python3
"""Fixed-path boot entrypoint. Authenticate the complete source closure first."""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys

BASE = Path('/opt/commerce-os/private/runtime-boot')
TOOLS = BASE / 'tools'
FILES = frozenset({'runtime-boot.py', 'runtime_boot_host.py', 'runtime_boot_runner.py',
    'runtime_boot_policy.py', 'copy_runtime_deployment.py', 'api_web_deployment.py',
    'ci_release.py', 'ci_provider_evidence.py', 'mcl_portal_release.py', 'update-identity-proxy.py'})


def need(value, code):
    if not value: raise RuntimeError(code)


def read(path):
    for parent in path.parents:
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
             'BOOT_SOURCE_PARENT_UNSAFE')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        before = os.fstat(stream.fileno())
        need(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
             and stat.S_IMODE(before.st_mode) == 0o600 and 0 < before.st_size <= 1024 * 1024,
             'BOOT_SOURCE_FILE_UNSAFE')
        raw = stream.read(1024 * 1024 + 1)
        sig = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode, s.st_nlink)
        need(len(raw) == before.st_size and sig(before) == sig(os.fstat(stream.fileno())) == sig(path.lstat()),
             'BOOT_SOURCE_CHANGED')
    return raw


def unique(raw):
    def pairs(rows):
        result = {}
        for key, value in rows:
            need(key not in result, 'BOOT_SOURCE_DUPLICATE_FIELD'); result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs)


def authenticate(expected):
    need(os.geteuid() == 0 and Path(__file__) == TOOLS / 'runtime-boot.py'
         and type(expected) is str and re.fullmatch('[a-f0-9]{64}', expected), 'BOOT_ENTRYPOINT_SCOPE_INVALID')
    raw = read(BASE / 'sources.json')
    need(hashlib.sha256(raw).hexdigest() == expected, 'BOOT_SOURCE_MANIFEST_CHANGED')
    value = unique(raw)
    need(type(value) is dict and set(value) == {'schema_version', 'source_sha', 'files'}
         and type(value['schema_version']) is int and value['schema_version'] == 1
         and re.fullmatch('[a-f0-9]{40}', value['source_sha'])
         and type(value['files']) is dict and set(value['files']) == FILES, 'BOOT_SOURCE_MANIFEST_INVALID')
    need({p.name for p in TOOLS.iterdir()} == FILES, 'BOOT_SOURCE_DIRECTORY_CHANGED')
    for name, checksum in value['files'].items():
        need(type(checksum) is str and re.fullmatch('[a-f0-9]{64}', checksum)
             and hashlib.sha256(read(TOOLS / name)).hexdigest() == checksum, 'BOOT_SOURCE_HASH_CHANGED')


def main():
    need(len(sys.argv) == 2, 'BOOT_MANIFEST_ARGUMENT_REQUIRED')
    os.umask(0o077); sys.dont_write_bytecode = True
    def timeout(_signal, _frame): raise RuntimeError('BOOT_ABSOLUTE_DEADLINE')
    signal.signal(signal.SIGALRM, timeout); signal.alarm(305)
    authenticate(sys.argv[1]); sys.path.insert(0, str(TOOLS))
    import runtime_boot_host
    import runtime_boot_runner
    result = runtime_boot_runner.run(runtime_boot_host.HostAdapter())
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try: main()
    except (Exception, KeyboardInterrupt) as error:
        code = str(error) if re.fullmatch('[A-Z0-9_]{1,100}', str(error)) else type(error).__name__
        print(json.dumps({'status': 'BOOT_FAILED_PRESERVE_NO_RETRY', 'code': code})); sys.exit(1)
