#!/usr/bin/env python3
"""Update only owned Commerce headers and API routes; never emit proxy configuration."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time
from typing import NamedTuple

HOST = b'commerce-os.inovaris.online'
PROXY = 'vibe-conversa-caddy-1'
MOUNT = '/etc/caddy/Caddyfile'
MAX_CONFIG = 2 * 1024 * 1024
CSP_BEFORE = b"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
CSP_CREATIVE = b"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.r2.cloudflarestorage.com; media-src 'self' blob: https://*.r2.cloudflarestorage.com; connect-src 'self' https://*.r2.cloudflarestorage.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

ASSET_PREVIEW_POLICY = b"default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
ASSET_PREVIEW_BLOCK = (b'  @commerce_asset_content path /v1/assets/*/content\n'
                       b'  header @commerce_asset_content >Content-Security-Policy "' + ASSET_PREVIEW_POLICY + b'"\n')
DEVICE_PATH = b'/creative-device/v1/*'
DEVICE_ROUTE_BLOCK = (b'  handle ' + DEVICE_PATH + b' {\n'
                      b'    reverse_proxy commerce-api:3001\n'
                      b'  }\n')
VERSION_PATH = b'/api/version'
VERSION_ROUTE_BLOCK = (b'  handle ' + VERSION_PATH + b' {\n'
                       b'    reverse_proxy commerce-api:3001\n'
                       b'  }\n')

class ProxyError(RuntimeError):
    pass

def require(value, code):
    if not value:
        raise ProxyError(code)

class Token(NamedTuple):
    raw: bytes
    start: int
    end: int
    line: int
    kind: str

    @property
    def value(self):
        return self.raw[1:-1] if self.kind in ('quoted', 'raw') else self.raw

def tokens(source):
    require(isinstance(source, bytes) and len(source) <= MAX_CONFIG, 'CONFIG_SIZE_INVALID')
    result = []
    i, line = 0, 1
    while i < len(source):
        c = source[i]
        if c in b' \t\r\n':
            line += c == 10
            i += 1
            continue
        if c == 35:
            while i < len(source) and source[i] != 10:
                i += 1
            continue
        start, first_line = i, line
        if c in (34, 96):
            quote = c
            i += 1
            while i < len(source):
                if source[i] == quote:
                    i += 1
                    break
                if quote == 34 and source[i] == 92:
                    require(i + 1 < len(source), 'UNSUPPORTED_CADDY_SYNTAX')
                    line += source[i + 1] == 10
                    i += 2
                else:
                    line += source[i] == 10
                    i += 1
            else:
                raise ProxyError('UNSUPPORTED_CADDY_SYNTAX')
            require(i == len(source) or source[i] in b' \t\r\n#', 'UNSUPPORTED_CADDY_SYNTAX')
            kind = 'quoted' if quote == 34 else 'raw'
        else:
            while i < len(source) and source[i] not in b' \t\r\n#':
                require(source[i] not in (34, 96), 'UNSUPPORTED_CADDY_SYNTAX')
                i += 1
            kind = 'bare'
        token = Token(source[start:i], start, i, first_line, kind)
        require(token.value != b'import' and not (kind == 'bare' and token.raw.startswith(b'<<')), 'IMPORT_OR_HEREDOC_UNSUPPORTED')
        result.append(token)
    return result

def rewrite_policy(source):
    """Return new bytes; reject syntax whose ownership cannot be established narrowly."""
    items = tokens(source)
    stack, parents, pairs, top_blocks = [], {}, {}, []
    top_start = 0
    for i, token in enumerate(items):
        parents[i] = stack[-1] if stack else None
        if token.kind == 'bare' and token.raw == b'{':
            if not stack:
                top_blocks.append((i, items[top_start:i]))
            stack.append(i)
        elif token.kind == 'bare' and token.raw == b'}':
            require(bool(stack), 'UNBALANCED_CADDY_BLOCKS')
            pairs[stack.pop()] = i
            if not stack:
                top_start = i + 1
    require(not stack and top_start == len(items), 'UNSUPPORTED_TOP_LEVEL_SYNTAX')
    candidates = []
    for opening, header in top_blocks:
        if any(HOST in token.value for token in header):
            require(len(header) == 1 and header[0].kind == 'bare' and header[0].raw == HOST, 'AMBIGUOUS_COMMERCE_SITE')
            candidates.append(opening)
    require(len(candidates) == 1, 'COMMERCE_SITE_NOT_UNIQUE')
    opening = candidates[0]
    closing = pairs[opening]
    replacements = []
    # Only exact authenticated asset content may be framed by this same origin.
    # The deferred Set replaces the site-wide header, rather than adding a second CSP.
    preview = [i for i in range(opening + 1, closing) if items[i].value == b'@commerce_asset_content']
    preview_field = None
    if preview:
        first = preview[0]
        expected = tokens(ASSET_PREVIEW_BLOCK)
        actual = items[first:first + len(expected)]
        require(len(preview) == 2 and preview == [first, first + 4]
                and [t.raw for t in actual] == [t.raw for t in expected]
                and all(parents[i] == opening for i in range(first, first + len(expected)))
                and len({t.line for t in actual[:3]}) == 1
                and len({t.line for t in actual[3:]}) == 1
                and actual[0].line != actual[3].line, 'AMBIGUOUS_ASSET_PREVIEW_POLICY')
        preview_field = first + 5
    else:
        start = source.rfind(b'\n', 0, items[closing].start) + 1
        require(not source[start:items[closing].start].strip(), 'AMBIGUOUS_COMMERCE_CLOSING')
        replacements.append((start, start, ASSET_PREVIEW_BLOCK))
    for field_name, accepted, replacement_value in [
        (b'referrer-policy', (b'same-origin', b'no-referrer'), b'no-referrer'),
        (b'content-security-policy', (CSP_BEFORE, CSP_CREATIVE), CSP_CREATIVE),
    ]:
        code = field_name.upper().replace(b'-', b'_').decode()
        fields = [i for i in range(opening + 1, closing)
                  if items[i].value.lstrip(b'+-?>').lower() == field_name and i != preview_field]
        require(len(fields) == 1, code + '_NOT_UNIQUE')
        field = fields[0]
        token = items[field]
        require(token.kind == 'bare' and token.raw.lower() == field_name, 'AMBIGUOUS_' + code)
        parent = parents[field]
        require(parent is not None and parents[parent] == opening, 'AMBIGUOUS_' + code)
        # A plain site-wide header only: no matchers, nested routes, or extra directives.
        declaration = [item for item in items[:parent] if item.line == items[parent].line]
        require(len(declaration) == 1 and declaration[0].raw == b'header' and declaration[0].kind == 'bare', 'AMBIGUOUS_HEADER_SCOPE')
        line_fields = [i for i in range(parent + 1, pairs[parent]) if items[i].line == token.line]
        require(line_fields == [field, field + 1], 'AMBIGUOUS_' + code)
        value = items[field + 1]
        require(value.kind in ('bare', 'quoted') and value.value in accepted, 'UNEXPECTED_' + code)
        if value.value != replacement_value:
            replacement = b'"' + replacement_value + b'"' if value.kind == 'quoted' else replacement_value
            replacements.append((value.start, value.end, replacement))
    # Identify the one exact site-wide SPA fallback before placing API routes.
    fallbacks = []
    for route_open, route_close in pairs.items():
        if parents[route_open] != opening:
            continue
        declaration = [i for i in range(opening + 1, route_open)
                       if items[i].line == items[route_open].line]
        if len(declaration) == 1 and items[declaration[0]].raw == b'handle':
            body = items[route_open + 1:route_close]
            require(len(body) == 2 and all(t.kind == 'bare' for t in body)
                    and [t.raw for t in body] == [b'reverse_proxy', b'commerce-web:8080'],
                    'AMBIGUOUS_COMMERCE_FALLBACK')
            fallbacks.append(declaration[0])
    require(len(fallbacks) == 1, 'COMMERCE_FALLBACK_NOT_UNIQUE')
    fallback_index = fallbacks[0]
    fallback = items[fallback_index]
    fallback_start = source.rfind(b'\n', 0, fallback.start) + 1
    indent = source[fallback_start:fallback.start]
    require(not indent.strip(), 'AMBIGUOUS_COMMERCE_FALLBACK')
    route_insertions = []

    # The device API namespace must retain its prefix and reach the API, never the SPA.
    mentions = [i for i in range(opening + 1, closing) if b'/creative-device' in items[i].value]
    if mentions:
        require(len(mentions) == 1, 'DEVICE_ROUTE_NOT_UNIQUE')
        route = mentions[0]
        require(items[route].kind == 'bare' and items[route].raw == DEVICE_PATH
                and parents[route] == opening, 'AMBIGUOUS_DEVICE_ROUTE')
        route_open = route + 1
        require(route > opening + 1 and route_open in pairs
                and parents[route_open] == opening, 'AMBIGUOUS_DEVICE_ROUTE')
        declaration = [i for i in range(opening + 1, route_open)
                       if items[i].line == items[route_open].line]
        require(declaration == [route - 1, route]
                and items[route - 1].kind == 'bare'
                and items[route - 1].raw == b'handle', 'AMBIGUOUS_DEVICE_ROUTE')
        body = items[route_open + 1:pairs[route_open]]
        require(len(body) == 2 and all(t.kind == 'bare' for t in body)
                and [t.raw for t in body] == [b'reverse_proxy', b'commerce-api:3001'],
                'UNEXPECTED_DEVICE_UPSTREAM')
    else:
        route_insertions.append(DEVICE_ROUTE_BLOCK)

    # The public release readback must be an exact API route before the SPA fallback.
    mentions = [i for i in range(opening + 1, closing) if VERSION_PATH in items[i].value]
    if mentions:
        require(len(mentions) == 1, 'VERSION_ROUTE_NOT_UNIQUE')
        route = mentions[0]
        require(items[route].kind == 'bare' and items[route].raw == VERSION_PATH
                and parents[route] == opening, 'AMBIGUOUS_VERSION_ROUTE')
        route_open = route + 1
        require(route > opening + 1 and route_open in pairs
                and parents[route_open] == opening, 'AMBIGUOUS_VERSION_ROUTE')
        declaration = [i for i in range(opening + 1, route_open)
                       if items[i].line == items[route_open].line]
        require(declaration == [route - 1, route]
                and items[route - 1].kind == 'bare'
                and items[route - 1].raw == b'handle', 'AMBIGUOUS_VERSION_ROUTE')
        body = items[route_open + 1:pairs[route_open]]
        require(len(body) == 2 and all(t.kind == 'bare' for t in body)
                and [t.raw for t in body] == [b'reverse_proxy', b'commerce-api:3001'],
                'UNEXPECTED_VERSION_UPSTREAM')
        require(pairs[route_open] < fallback_index, 'VERSION_ROUTE_AFTER_FALLBACK')
    else:
        route_insertions.append(VERSION_ROUTE_BLOCK)
    if route_insertions:
        replacements.append((fallback_start, fallback_start, b''.join(route_insertions)))
    for start, end, replacement in sorted(replacements, reverse=True):
        source = source[:start] + replacement + source[end:]
    return source

class Metadata(NamedTuple):
    device: int
    inode: int
    mode: int
    uid: int
    gid: int
    size: int
    modified: int
    changed: int

def metadata(info):
    return Metadata(info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                    info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def snapshot(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as stream:
            before = metadata(os.fstat(stream.fileno()))
            require(stat.S_ISREG(before.mode), 'SOURCE_NOT_REGULAR')
            require(before.size <= MAX_CONFIG, 'CONFIG_SIZE_INVALID')
            data = stream.read(MAX_CONFIG + 1)
            after = metadata(os.fstat(stream.fileno()))
        require(before == after and len(data) <= MAX_CONFIG, 'SOURCE_CHANGED_CONCURRENTLY')
        require(metadata(os.stat(path, follow_symlinks=False)) == after, 'SOURCE_CHANGED_CONCURRENTLY')
        return data, after
    except OSError:
        raise ProxyError('SOURCE_FILE_UNAVAILABLE') from None

def unchanged(path, expected, info):
    current, current_info = snapshot(path)
    require(current == expected and current_info == info, 'SOURCE_CHANGED_CONCURRENTLY')

def private_file(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(path, 0o600)

def write_guarded(path, expected, info, replacement, journal=None):
    """Record partial writes so a later failure can restore only our own unchanged bytes."""
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(fd, 'r+b', buffering=0) as stream:
        require(metadata(os.fstat(stream.fileno())) == info, 'SOURCE_CHANGED_CONCURRENTLY')
        require(metadata(os.stat(path, follow_symlinks=False)) == info, 'SOURCE_CHANGED_CONCURRENTLY')
        require(stream.read(MAX_CONFIG + 1) == expected, 'SOURCE_CHANGED_CONCURRENTLY')
        stream.seek(0)
        written_bytes = bytearray(expected)
        offset = 0
        while offset < len(replacement):
            count = os.write(stream.fileno(), replacement[offset:])
            require(count > 0, 'SOURCE_WRITE_FAILED')
            written_bytes[offset:offset + count] = replacement[offset:offset + count]
            offset += count
            if journal is not None:
                journal['changed'] = True
                journal['content'] = bytes(written_bytes)
                journal['info'] = metadata(os.fstat(stream.fileno()))
        os.ftruncate(stream.fileno(), len(replacement))
        if journal is not None:
            journal['changed'] = True
            journal['content'] = replacement
            journal['info'] = metadata(os.fstat(stream.fileno()))
        os.fsync(stream.fileno())
        updated = metadata(os.fstat(stream.fileno()))
    require(updated[:5] == info[:5], 'SOURCE_IDENTITY_CHANGED')
    unchanged(path, replacement, updated)
    return updated

class DockerCaddy:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        started = clock()
        # Finish normal work by 80s and reserve up to 110s for guarded rollback/cleanup.
        # The caller's 150s timeout must not terminate an ordinary recovery sequence.
        self.deadline = started + 80
        self.rollback_deadline = started + 110

    def begin_rollback(self):
        self.deadline = self.rollback_deadline

    def command(self, args, code, input_bytes=None):
        remaining = self.deadline - self.clock()
        require(remaining > 0, code + '_TIMEOUT')
        try:
            result = subprocess.run(args, capture_output=True, input=input_bytes, timeout=min(15, remaining))
        except subprocess.TimeoutExpired:
            raise ProxyError(code + '_TIMEOUT') from None
        except OSError:
            raise ProxyError(code) from None
        require(result.returncode == 0, code)
        return result.stdout

    def json_command(self, args, code):
        raw = self.command(args, code)
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            raise ProxyError(code) from None

    def source_path(self):
        mounts = self.json_command(['docker', 'inspect', PROXY, '--format', '{{json .Mounts}}'], 'PROXY_MOUNT_DISCOVERY_FAILED')
        require(isinstance(mounts, list), 'PROXY_MOUNT_DISCOVERY_FAILED')
        selected = [m for m in mounts if m.get('Destination') == MOUNT]
        require(len(selected) == 1 and selected[0].get('Type') == 'bind', 'PROXY_BIND_MOUNT_REQUIRED')
        path = Path(selected[0].get('Source', ''))
        require(path.is_absolute(), 'PROXY_BIND_MOUNT_REQUIRED')
        return path

    def adapt(self, path):
        return self.json_command(['docker', 'exec', PROXY, 'caddy', 'adapt', '--config', path, '--adapter', 'caddyfile'], 'PROXY_ADAPT_FAILED')

    def active(self):
        return self.json_command(['docker', 'exec', PROXY, 'wget', '-qO-', 'http://127.0.0.1:2019/config/'], 'ACTIVE_CONFIG_READ_FAILED')

    def stage(self, local, remote):
        self.command(['docker', 'exec', '-i', PROXY, 'sh', '-c', 'set -C; umask 077; cat > \"$1\"', 'sh', remote], 'PROXY_STAGE_FAILED', input_bytes=local.read_bytes())

    def validate(self, remote):
        self.command(['docker', 'exec', PROXY, 'caddy', 'validate', '--config', remote, '--adapter', 'caddyfile'], 'PROXY_VALIDATE_FAILED')

    def reload(self):
        self.command(['docker', 'exec', PROXY, 'caddy', 'reload', '--config', MOUNT, '--adapter', 'caddyfile'], 'PROXY_RELOAD_FAILED')

    def cleanup(self, remote):
        self.command(['docker', 'exec', PROXY, 'rm', '-f', remote], 'PROXY_STAGE_CLEANUP_FAILED')

def update_proxy(source, operations, backup_root, rewriter=rewrite_policy):
    """Operations is injectable. No live configuration or private path is returned or logged."""
    source, backup_root = Path(source), Path(backup_root)
    old, original_info = snapshot(source)
    candidate = rewriter(old)
    disk = operations.adapt(MOUNT)
    require(operations.active() == disk, 'ACTIVE_DISK_CONFIG_MISMATCH')
    unchanged(source, old, original_info)
    if candidate == old:
        return {'status': 'UNCHANGED', 'other_sites_preserved': True}
    backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(not backup_root.is_symlink() and backup_root.is_dir(), 'BACKUP_DIRECTORY_INVALID')
    os.chmod(backup_root, 0o700)
    work = Path(tempfile.mkdtemp(prefix='identity-proxy-', dir=backup_root))
    private_file(work / 'original.Caddyfile', old)
    private_file(work / 'candidate.Caddyfile', candidate)
    remote = '/tmp/' + work.name + '.Caddyfile'
    journal = {'changed': False, 'content': old, 'info': original_info}
    try:
        operations.stage(work / 'candidate.Caddyfile', remote)
        operations.validate(remote)
        expected_active = operations.adapt(remote)
        require(operations.active() == disk, 'ACTIVE_CONFIG_CHANGED_CONCURRENTLY')
        unchanged(source, old, original_info)
        try:
            written_info = write_guarded(source, old, original_info, candidate, journal)
            operations.reload()
            require(operations.active() == expected_active, 'RELOADED_CONFIG_MISMATCH')
            unchanged(source, candidate, written_info)
        except Exception:
            if not journal['changed']:
                raise
            # Includes failures during/after write, before write_guarded returns.
            # Refuse to overwrite another actor's file or active configuration during rollback.
            try:
                if hasattr(operations, 'begin_rollback'):
                    operations.begin_rollback()
                unchanged(source, journal['content'], journal['info'])
                active_now = operations.active()
                require(active_now == disk or active_now == expected_active, 'ACTIVE_CONFIG_CHANGED_CONCURRENTLY')
                restored_info = write_guarded(source, journal['content'], journal['info'], old)
                operations.reload()
                require(operations.active() == disk, 'ROLLBACK_ACTIVE_CONFIG_MISMATCH')
                unchanged(source, old, restored_info)
            except Exception:
                raise ProxyError('PROXY_ROLLBACK_FAILED_OR_CONCURRENT_CHANGE') from None
            raise ProxyError('PROXY_UPDATE_FAILED_ROLLED_BACK') from None
        return {'status': 'UPDATED', 'other_sites_preserved': True,
                'rollback_token': work.name}
    except ProxyError:
        raise
    except Exception:
        raise ProxyError('PROXY_UPDATE_FAILED_AFTER_WRITE' if journal['changed'] else 'PROXY_UPDATE_FAILED_BEFORE_WRITE') from None

    finally:
        # Keep the private backup and candidate on the host for incident/rollback evidence.
        try:
            operations.cleanup(remote)
        except Exception:
            pass

def restore_proxy(source, operations, backup_root, rollback_token):
    """Restore one exact prior config without overwriting concurrent changes."""
    require(isinstance(rollback_token, str)
            and re.fullmatch(r'identity-proxy-[A-Za-z0-9._-]{1,80}', rollback_token),
            'ROLLBACK_TOKEN_INVALID')
    source, backup_root = Path(source), Path(backup_root)
    try:
        require(not backup_root.is_symlink() and backup_root.is_dir(),
                'ROLLBACK_BACKUP_UNAVAILABLE')
        backup_root = backup_root.resolve(strict=True)
        raw_work = backup_root / rollback_token
        require(not raw_work.is_symlink() and raw_work.is_dir(),
                'ROLLBACK_BACKUP_UNAVAILABLE')
        work = raw_work.resolve(strict=True)
    except OSError:
        raise ProxyError('ROLLBACK_BACKUP_UNAVAILABLE') from None
    require(work.parent == backup_root and work.is_dir() and not work.is_symlink(),
            'ROLLBACK_BACKUP_UNAVAILABLE')
    original, original_info = snapshot(work / 'original.Caddyfile')
    candidate, candidate_info = snapshot(work / 'candidate.Caddyfile')
    require(original_info.mode & 0o777 == 0o600
            and candidate_info.mode & 0o777 == 0o600
            and original != candidate, 'ROLLBACK_BACKUP_INVALID')
    current, current_info = snapshot(source)
    active = operations.active()
    disk = operations.adapt(MOUNT)
    require(active == disk, 'ACTIVE_DISK_CONFIG_MISMATCH')
    if current == original:
        return {'status': 'UNCHANGED', 'other_sites_preserved': True}
    require(current == candidate, 'ROLLBACK_SOURCE_CHANGED')
    unchanged(source, candidate, current_info)
    remote = '/tmp/' + rollback_token + '-restore.Caddyfile'
    journal = {'changed': False, 'content': candidate, 'info': current_info}
    try:
        operations.stage(work / 'original.Caddyfile', remote)
        operations.validate(remote)
        expected_active = operations.adapt(remote)
        require(operations.active() == active, 'ACTIVE_CONFIG_CHANGED_CONCURRENTLY')
        unchanged(source, candidate, current_info)
        try:
            restored_info = write_guarded(source, candidate, current_info, original, journal)
            operations.reload()
            require(operations.active() == expected_active, 'RESTORED_CONFIG_MISMATCH')
            unchanged(source, original, restored_info)
        except Exception:
            if not journal['changed']:
                raise
            try:
                if hasattr(operations, 'begin_rollback'):
                    operations.begin_rollback()
                unchanged(source, journal['content'], journal['info'])
                active_now = operations.active()
                require(active_now == active or active_now == expected_active,
                        'ACTIVE_CONFIG_CHANGED_CONCURRENTLY')
                candidate_info = write_guarded(source, journal['content'], journal['info'], candidate)
                operations.reload()
                require(operations.active() == active, 'ROLLBACK_ACTIVE_CONFIG_MISMATCH')
                unchanged(source, candidate, candidate_info)
            except Exception:
                raise ProxyError('PROXY_RESTORE_ROLLBACK_FAILED_OR_CONCURRENT_CHANGE') from None
            raise ProxyError('PROXY_RESTORE_FAILED_ROLLED_BACK') from None
        return {'status': 'RESTORED', 'other_sites_preserved': True}
    except ProxyError:
        raise
    except Exception:
        raise ProxyError('PROXY_RESTORE_FAILED_AFTER_WRITE' if journal['changed']
                         else 'PROXY_RESTORE_FAILED_BEFORE_WRITE') from None
    finally:
        try:
            operations.cleanup(remote)
        except Exception:
            pass

def main():
    os.umask(0o077)
    try:
        require(os.geteuid() == 0, 'ROOT_REQUIRED')
        operations = DockerCaddy()
        arguments = sys.argv[1:]
        require(not arguments or len(arguments) == 2 and arguments[0] == 'restore',
                'ARGUMENTS_INVALID')
        source = operations.source_path()
        backup_root = '/opt/commerce-os/private/caddy-backups'
        result = (restore_proxy(source, operations, backup_root, arguments[1])
                  if arguments else update_proxy(source, operations, backup_root))
    except ProxyError as error:
        print(json.dumps({'status': 'FAILED', 'error': str(error)}), file=sys.stderr)
        return 1
    except Exception:
        print(json.dumps({'status': 'FAILED', 'error': 'PROXY_UPDATE_FAILED'}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0

if __name__ == '__main__':
    sys.exit(main())
