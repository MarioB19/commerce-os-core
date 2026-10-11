#!/usr/bin/env python3
"""Root-only, stdin-only adapter for the closed source-isolation issuer.

Run the installed candidate with python3 -I. No CLI argument, environment flag,
API proof boolean or fixture can waive Root custody or human source evidence.
"""
import datetime as dt
import fcntl
import hashlib
import os
from pathlib import Path
import signal
import select
import stat
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
from copy_source_isolation_root import (IsolationError, MAX_INPUT, MIGRATION, PRIVATE as PRIVATE_TEXT,
    canonical, digest, evidence_reference, intent, parse, reference, require, sql_payload,
    transaction_sql, validate_billing, validate_control, validate_human)

from operator_identity import configured_account

PRIVATE = Path(PRIVATE_TEXT)
LOCKS = ('daily-b02-controller.lock', 'ci-deploy.lock', 'backup-schedule.lock',
         'maintenance-backup.lock', 'source-isolation.lock')
DB_WRITE_STARTED = False


def protected_parents(path):
    require(path.is_absolute() and '..' not in path.parts, 'ISOLATION_PATH_INVALID')
    for parent in (path.parent, *path.parent.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'ISOLATION_PARENT_UNSAFE')


def protected_bytes(path, private=True, maximum=MAX_INPUT):
    path = Path(path); protected_parents(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
                and (stat.S_IMODE(before.st_mode) == 0o600 if private else not before.st_mode & 0o022)
                and 0 < before.st_size <= maximum, 'ISOLATION_FILE_UNSAFE')
        raw = b''
        while len(raw) <= maximum:
            chunk = os.read(fd, min(65536, maximum + 1 - len(raw)))
            if not chunk: break
            raw += chunk
        after = os.fstat(fd); named = path.lstat()
        fields = ('st_dev', 'st_ino', 'st_uid', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        require(len(raw) == before.st_size and all(getattr(before, key) == getattr(after, key) == getattr(named, key) for key in fields),
                'ISOLATION_FILE_CHANGED')
        return raw
    finally:
        os.close(fd)


def read_reference(ref):
    reference(ref)
    raw = protected_bytes(ref['path'])
    require(len(raw) == ref['bytes'] and digest(raw) == ref['sha256'], 'ISOLATION_REFERENCE_CHANGED')
    return raw


def private_directory(path, create=False):
    protected_parents(path)
    if create:
        try: path.mkdir(mode=0o700)
        except FileExistsError: pass
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
            'ISOLATION_PRIVATE_DIRECTORY_UNSAFE')


def write_once(path, raw):
    protected_parents(path)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        require(protected_bytes(path) == raw, 'ISOLATION_PRIVATE_CAS_CHANGED')
        return
    try:
        view = memoryview(raw)
        while view:
            count = os.write(fd, view); require(count > 0, 'ISOLATION_PRIVATE_WRITE_FAILED'); view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)
    require(protected_bytes(path) == raw, 'ISOLATION_PRIVATE_READBACK_FAILED')
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(directory)
    finally: os.close(directory)


def acquire_locks():
    held = []
    try:
        for name in LOCKS:
            path = PRIVATE / name; protected_parents(path)
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            stream = os.fdopen(fd, 'a+b'); held.append(stream)
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600
                    and info.st_nlink == 1, 'ISOLATION_LOCK_UNSAFE')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return held
    except BaseException:
        for stream in reversed(held): stream.close()
        raise


def root_context(control):
    """Authenticate the installed candidate and the existing Root manifest.

    This is not a deployment, complete runtime inventory or sales-health check.
    Native manifest validators remain authoritative for each supported version.
    """
    require(ROOT.parent == PRIVATE.parent / 'releases' and not ROOT.is_symlink(), 'ISOLATION_INSTALLED_RELEASE_REQUIRED')
    metadata = parse(protected_bytes(ROOT / 'RELEASE.json', private=False))
    require(metadata.get('source_sha') == control['candidate_sha']
            and metadata.get('migration_hashes', {}).get(MIGRATION) == control['migration67_sha256'],
            'ISOLATION_CANDIDATE_CHANGED')
    migration = protected_bytes(ROOT / 'packages/db/migrations' / MIGRATION, private=False)
    require(digest(migration) == control['migration67_sha256'], 'ISOLATION_PACKAGED_MIGRATION_CHANGED')
    raw = read_reference(control['adoption_ref']); state = parse(raw)
    require(type(state) is dict and state.get('current_release') == str(ROOT), 'ISOLATION_ROOT_RELEASE_CHANGED')
    current = PRIVATE.parent / 'current'
    require(current.is_symlink() and current.resolve(strict=True) == ROOT, 'ISOLATION_CURRENT_RELEASE_CHANGED')
    import api_web_deployment as native
    if state.get('schema_version') == 2:
        native.validate_state(state, PRIVATE)
    elif state.get('schema_version') == 3:
        import copy_runtime_deployment as runtime
        runtime.validate_state(state)
        require(state.get('owner_workspace_id') == control['binding']['workspace_id'], 'ISOLATION_ROOT_WORKSPACE_CHANGED')
        # Read the accepted deployment reference; a bare shape/hash is not proof.
        native.read_reference(state['last_release_receipt_ref'])
    else:
        raise IsolationError('ISOLATION_ROOT_SCHEMA_UNSUPPORTED')
    for ref in state['canonical_files'].values(): native.read_reference(ref)
    native.read_reference(state['smtp_transition_ref']); native.read_reference(state['caddy_config_ref'])
    native.read_portal_references(state['portal'])
    plan = native.protected_bytes(PRIVATE / 'daily-b02/plan.json')
    require(hashlib.sha256(plan).hexdigest() == state['b02_plan_sha256'], 'ISOLATION_B02_PLAN_CHANGED')
    profiles = native.env_values(native.protected_bytes(PRIVATE / 'release.env'))
    require(profiles.get('COMMERCE_DEPLOY_SCOPE') == state['scope']
            and profiles.get('COMMERCE_SECRETS_DIR') == str(PRIVATE), 'ISOLATION_COMPOSE_SCOPE_CHANGED')
    require(native.env_values(native.protected_bytes(PRIVATE / 'api.env')).get('WORKSPACE_ID') == control['binding']['workspace_id'],
            'ISOLATION_API_WORKSPACE_CHANGED')
    return raw


def database(sql, run_dir):
    """Bounded native psql; credentials stay in the canonical private profile.

    Stdout/stderr remain Root-private. The public result never includes SQL,
    native diagnostic text, account metadata, principals or secret env values.
    """
    command = ['/bin/sh', str(ROOT / 'scripts/compose-release.sh'), str(PRIVATE / 'release.env'),
               'exec', '-T', 'postgres', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
               '-U', 'commerce_owner', '-d', 'commerce']
    with tempfile.TemporaryFile(dir=run_dir) as output, tempfile.TemporaryFile(dir=run_dir) as errors:
        process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.PIPE, stdout=output, stderr=errors,
            start_new_session=True, env={'PATH': '/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'})
        try:
            process.communicate(sql.encode(), timeout=35)
        except BaseException:
            try: os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try: os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                process.wait(timeout=2)
            raise IsolationError('ISOLATION_DATABASE_DEADLINE') from None
        output.seek(0); raw = output.read(MAX_INPUT + 1)
        require(process.returncode == 0 and 0 < len(raw) <= MAX_INPUT, 'ISOLATION_DATABASE_REJECTED')
        result = parse(raw.strip())
        require(type(result) is dict and result.get('status') in {'CHALLENGE_PREPARED', 'ROOT_RECEIPT_READY'}
                and result.get('authorizes_operations') is False, 'ISOLATION_DATABASE_RESULT_INVALID')
        return result


def main():
    global DB_WRITE_STARTED
    require(sys.platform == 'linux' and os.geteuid() == 0 and len(sys.argv) == 1, 'ISOLATION_ROOT_LINUX_STDIN_ONLY')
    os.umask(0o077)
    raw = b''; deadline = time.monotonic() + 10
    while len(raw) <= MAX_INPUT:
        remaining = deadline - time.monotonic()
        require(remaining > 0 and bool(select.select([sys.stdin.fileno()], [], [], remaining)[0]), 'ISOLATION_STDIN_DEADLINE')
        chunk = os.read(sys.stdin.fileno(), min(65536, MAX_INPUT + 1 - len(raw)))
        if not chunk: break
        raw += chunk
    control = validate_control(parse(raw))
    actor = configured_account(protected_bytes(PRIVATE / 'operator-identity.json'), 'legacy_billing')
    held = acquire_locks()
    try:
        before = root_context(control)
        base = PRIVATE / 'source-isolation'; private_directory(base, create=True)
        private_directory(base / 'evidence')
        challenges = base / 'challenges'; private_directory(challenges, create=True)
        directory = challenges / control['challenge_id']; private_directory(directory, create=True)
        billing_raw = read_reference(control['billing_ref'])
        technical = validate_billing(billing_raw, control['billing_ref'], dt.datetime.now(dt.timezone.utc), expected_actor=actor)
        # An immutable prewrite tuple permits safe retry after a lost DB answer.
        sealed = canonical({'schema_version': 1, 'intent': intent(control), 'technical': technical})
        if control['action'] == 'prepare': write_once(directory / 'intent.json', sealed)
        else: require(protected_bytes(directory / 'intent.json') == sealed, 'ISOLATION_PREPARED_INTENT_CHANGED')
        human = None
        if control['action'] == 'finalize':
            human_raw = read_reference(control['human_ref']); human_doc = parse(human_raw)
            require(type(human_doc) is dict and 'source_message_ref' in human_doc, 'ISOLATION_EXPLICIT_HUMAN_EVIDENCE_REQUIRED')
            evidence_reference(human_doc['source_message_ref'])
            message_raw = read_reference(human_doc['source_message_ref'])
            human = validate_human(human_raw, control['human_ref'], message_raw, control, dt.datetime.now(dt.timezone.utc))
        payload = sql_payload(control, technical, human)
        require(root_context(control) == before, 'ISOLATION_ROOT_CAS_CHANGED')
        DB_WRITE_STARTED = True
        result = database(transaction_sql(payload), directory)
        require(root_context(control) == before, 'ISOLATION_ROOT_CAS_CHANGED')
        require(result['challenge_id'] == control['challenge_id']
                and result['status'] == ('CHALLENGE_PREPARED' if control['action'] == 'prepare' else 'ROOT_RECEIPT_READY'),
                'ISOLATION_DATABASE_RESULT_CHANGED')
        # The DB commits the challenge/receipt atomically. A failed private
        # readback suppresses public success; exact retry reuses that DB tuple.
        write_once(directory / ('prepared.json' if control['action'] == 'prepare' else 'completed.json'), canonical(result))
        print(canonical(result).decode())
    finally:
        for stream in reversed(held): stream.close()


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        code = str(error) if isinstance(error, IsolationError) else 'ISOLATION_ROOT_FAILED'
        print(canonical({'status': 'REJECTED', 'code': code,
                         'root_receipt_issued': 'UNKNOWN_REQUIRES_READBACK' if DB_WRITE_STARTED else False,
                         'authorizes_operations': False}).decode())
        sys.exit(1)
