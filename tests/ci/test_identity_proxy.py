import importlib.util
from pathlib import Path
import os
import tempfile
import unittest
from unittest import mock
import subprocess

spec = importlib.util.spec_from_file_location('identity_proxy', Path(__file__).resolve().parents[2] / 'scripts' / 'update-identity-proxy.py')
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)

OTHER = b'''# Other sites must stay byte-for-byte intact, including the same header.
other.example.invalid {
  header Referrer-Policy same-origin
  respond "A quoted { brace } and # comment"
}

'''
COMMERCE = b'''commerce-os.inovaris.online {
  header {
    X-Content-Type-Options nosniff
    Referrer-Policy same-origin # retain this comment
    Content-Security-Policy "default-src 'self'; form-action 'self'"
  }
  handle /api/auth/* {
    reverse_proxy commerce-api:3001
  }
  handle {
    reverse_proxy commerce-web:8080
  }
}
'''
COMMERCE = COMMERCE.replace(b"default-src 'self'; form-action 'self'", proxy.CSP_BEFORE)
SOURCE = OTHER + COMMERCE
DEVICE = b'''  handle /creative-device/v1/* {
    reverse_proxy commerce-api:3001
  }
'''
VERSION = b'''  handle /api/version {
    reverse_proxy commerce-api:3001
  }
'''
FALLBACK = b'''  handle {
    reverse_proxy commerce-web:8080
  }
'''
CANDIDATE = OTHER + COMMERCE.replace(b'Referrer-Policy same-origin', b'Referrer-Policy no-referrer').replace(proxy.CSP_BEFORE, proxy.CSP_CREATIVE).replace(FALLBACK, DEVICE + VERSION + FALLBACK)

CANDIDATE = CANDIDATE[:CANDIDATE.rfind(b'}')] + proxy.ASSET_PREVIEW_BLOCK + CANDIDATE[CANDIDATE.rfind(b'}'):]

def config(data):
    # A deterministic adapter double; full bytes expose unexpected changes to either site.
    return {'configuration': data.decode()}

class FakeCaddy:
    def __init__(self, source):
        self.source = source
        self.current = config(source.read_bytes())
        self.staged = None
        self.events = []
        self.reloads = 0
        self.on_validate = None
        self.on_reload = None

    def adapt(self, path):
        self.events.append('adapt')
        return config(self.source.read_bytes() if path == proxy.MOUNT else self.staged)

    def active(self):
        return self.current

    def stage(self, local, remote):
        self.events.append('stage')
        self.staged = local.read_bytes()

    def validate(self, remote):
        self.events.append('validate')
        if self.on_validate:
            self.on_validate()

    def reload(self):
        self.events.append('reload')
        self.reloads += 1
        if self.on_reload:
            self.on_reload(self.reloads)
        else:
            self.current = config(self.source.read_bytes())

    def cleanup(self, remote):
        self.events.append('cleanup')

class RewriteTests(unittest.TestCase):
    def test_preview_exception_is_exact_same_origin_and_cannot_expand(self):
        self.assertEqual(proxy.rewrite_policy(CANDIDATE), CANDIDATE)
        for changed in [CANDIDATE.replace(b'/v1/assets/*/content', b'/v1/*'),
                        CANDIDATE.replace(b"frame-ancestors 'self'", b"frame-ancestors *"),
                        CANDIDATE.replace(b'>Content-Security-Policy', b'Content-Security-Policy'),
                        CANDIDATE.replace(proxy.ASSET_PREVIEW_BLOCK, proxy.ASSET_PREVIEW_BLOCK * 2)]:
            with self.assertRaises(proxy.ProxyError):
                proxy.rewrite_policy(changed)

    def test_only_unique_commerce_header_changes_with_two_sites(self):
        self.assertEqual(proxy.rewrite_policy(SOURCE), CANDIDATE)
        self.assertTrue(CANDIDATE.startswith(OTHER))

    def test_idempotent_and_quoted_header_value_preserves_format(self):
        self.assertEqual(proxy.rewrite_policy(CANDIDATE), CANDIDATE)
        quoted = SOURCE.replace(b'same-origin # retain', b'"same-origin" # retain')
        self.assertEqual(proxy.rewrite_policy(quoted), CANDIDATE.replace(b'no-referrer # retain', b'"no-referrer" # retain'))

    def test_device_route_is_inserted_before_fallback_and_preserves_existing_auth(self):
        candidate = proxy.rewrite_policy(SOURCE)
        self.assertEqual(candidate.count(DEVICE), 1)
        self.assertLess(candidate.index(DEVICE), candidate.index(FALLBACK))
        self.assertIn(b'  handle /api/auth/* {\n    reverse_proxy commerce-api:3001\n  }', candidate)
        self.assertEqual(proxy.rewrite_policy(candidate), candidate)

    def test_version_route_is_exact_and_inserted_before_fallback(self):
        candidate = proxy.rewrite_policy(SOURCE)
        self.assertEqual(candidate.count(VERSION), 1)
        self.assertLess(candidate.index(VERSION), candidate.index(FALLBACK))
        self.assertEqual(proxy.rewrite_policy(candidate), candidate)

    def test_version_route_with_other_upstream_duplicate_or_late_order_fails_closed(self):
        for candidate, code in [
            (CANDIDATE.replace(VERSION, VERSION.replace(b'commerce-api:3001', b'commerce-web:8080')), 'UNEXPECTED_VERSION_UPSTREAM'),
            (CANDIDATE.replace(VERSION, VERSION + VERSION), 'VERSION_ROUTE_NOT_UNIQUE'),
            (CANDIDATE.replace(VERSION, VERSION.replace(b'commerce-api:3001', b'commerce-api:3001 other-api:9999')), 'UNEXPECTED_VERSION_UPSTREAM'),
            (CANDIDATE.replace(VERSION, b'').replace(FALLBACK, FALLBACK + VERSION), 'VERSION_ROUTE_AFTER_FALLBACK'),
        ]:
            with self.subTest(code=code), self.assertRaisesRegex(proxy.ProxyError, code):
                proxy.rewrite_policy(candidate)

    def test_version_route_ambiguous_syntax_fails_closed(self):
        for candidate in [
            CANDIDATE.replace(VERSION, VERSION.replace(b'handle /api/version', b'handle_path /api/version')),
            CANDIDATE.replace(VERSION, b'  route {\n' + VERSION + b'  }\n'),
            CANDIDATE.replace(VERSION, b'  @version path /api/version\n  handle @version {\n    reverse_proxy commerce-api:3001\n  }\n'),
            CANDIDATE.replace(VERSION, VERSION.replace(b'/api/version', b'"/api/version"')),
        ]:
            with self.subTest(candidate=candidate[:80]), self.assertRaisesRegex(proxy.ProxyError, 'AMBIGUOUS_VERSION_ROUTE'):
                proxy.rewrite_policy(candidate)

    def test_same_device_path_in_other_site_is_preserved_byte_exactly(self):
        other = OTHER.replace(b'  header Referrer-Policy same-origin', DEVICE.replace(b'commerce-api:3001', b'other-api:9999') + b'  header Referrer-Policy same-origin')
        result = proxy.rewrite_policy(other + COMMERCE)
        self.assertEqual(result, other + CANDIDATE[len(OTHER):])

    def test_same_version_path_in_other_site_is_preserved_byte_exactly(self):
        other = OTHER.replace(b'  header Referrer-Policy same-origin', VERSION.replace(b'commerce-api:3001', b'other-api:9999') + b'  header Referrer-Policy same-origin')
        result = proxy.rewrite_policy(other + COMMERCE)
        self.assertEqual(result, other + CANDIDATE[len(OTHER):])

    def test_device_route_with_other_upstream_or_duplicate_fails_closed(self):
        for index, candidate in enumerate([
            CANDIDATE.replace(DEVICE, DEVICE.replace(b'commerce-api:3001', b'commerce-web:8080')),
            CANDIDATE.replace(DEVICE, DEVICE + DEVICE),
            CANDIDATE.replace(DEVICE, DEVICE.replace(b'commerce-api:3001', b'commerce-api:3001 other-api:9999')),
        ]):
            with self.subTest(case=index), self.assertRaises(proxy.ProxyError):
                proxy.rewrite_policy(candidate)

    def test_device_route_handle_path_nested_and_named_matchers_fail_closed(self):
        for index, candidate in enumerate([
            CANDIDATE.replace(DEVICE, DEVICE.replace(b'handle /creative-device/', b'handle_path /creative-device/')),
            CANDIDATE.replace(DEVICE, b'  route {\n' + DEVICE + b'  }\n'),
            CANDIDATE.replace(DEVICE, b'  @device path /creative-device/v1/*\n  handle @device {\n    reverse_proxy commerce-api:3001\n  }\n'),
            CANDIDATE.replace(DEVICE, b'  handle @device /creative-device/v1/* {\n    reverse_proxy commerce-api:3001\n  }\n'),
        ]):
            with self.subTest(case=index), self.assertRaises(proxy.ProxyError):
                proxy.rewrite_policy(candidate)

    def test_creative_csp_is_narrow_and_rejects_foreign_policy_changes(self):
        candidate = proxy.rewrite_policy(SOURCE)
        self.assertIn(b"connect-src 'self' https://*.r2.cloudflarestorage.com", candidate)
        self.assertIn(b"media-src 'self' blob: https://*.r2.cloudflarestorage.com", candidate)
        self.assertNotIn(b"connect-src https:", candidate)
        for value in [SOURCE.replace(proxy.CSP_BEFORE, proxy.CSP_BEFORE + b"; connect-src https:"), SOURCE.replace(b'    Content-Security-Policy', b'    ?Content-Security-Policy')]:
            with self.assertRaises(proxy.ProxyError):
                proxy.rewrite_policy(value)

    def test_absent_duplicate_and_shared_hostname_fail_closed(self):
        for value in [OTHER, SOURCE + COMMERCE, SOURCE.replace(b'commerce-os.inovaris.online {', b'commerce-os.inovaris.online, other.example.invalid {'), SOURCE.replace(b'commerce-os.inovaris.online {', b'https://commerce-os.inovaris.online {')]:
            with self.subTest(value=value[:20]), self.assertRaises(proxy.ProxyError):
                proxy.rewrite_policy(value)

    def test_imports_heredocs_and_unbalanced_blocks_fail_closed(self):
        for value in [b'import other.conf\n' + SOURCE, b'"import" other.conf\n' + SOURCE, SOURCE.replace(b'  header {', b'  import headers\n  header {'), b'other.invalid {\n respond <<BODY\nsecret\nBODY\n}\n' + COMMERCE, SOURCE[:-2]]:
            with self.assertRaises(proxy.ProxyError):
                proxy.rewrite_policy(value)

    def test_multiple_headers_unknown_values_and_matched_headers_fail_closed(self):
        for value in [SOURCE.replace(b'    Referrer-Policy same-origin', b'    Referrer-Policy unsafe-url'), SOURCE.replace(b'  header {', b'  header @identity {'), SOURCE.replace(b'    Referrer-Policy same-origin', b'    ?Referrer-Policy same-origin'), SOURCE.replace(b'    Referrer-Policy same-origin', b'    Referrer-Policy no-referrer\n    Referrer-Policy same-origin'), SOURCE.replace(b'  header {', b'  route {\n  header {').replace(b'  handle /api/auth/* {', b'  }\n  handle /api/auth/* {')]:
            with self.assertRaises(proxy.ProxyError):
                proxy.rewrite_policy(value)

class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='identity-proxy-test-')
        self.root = Path(self.temp.name)
        self.source = self.root / 'mounted.Caddyfile'
        self.source.write_bytes(SOURCE)
        os.chmod(self.source, 0o640)
        self.info = self.source.stat()
        self.backups = self.root / 'private-backups'
        self.ops = FakeCaddy(self.source)

    def tearDown(self):
        self.temp.cleanup()

    def apply(self):
        return proxy.update_proxy(self.source, self.ops, self.backups)

    def assert_identity(self):
        info = self.source.stat()
        self.assertEqual((info.st_ino, info.st_mode, info.st_uid, info.st_gid), (self.info.st_ino, self.info.st_mode, self.info.st_uid, self.info.st_gid))

    def test_update_validates_then_preserves_inode_permissions_and_private_backup(self):
        self.ops.on_validate = lambda: self.assertEqual(self.source.read_bytes(), SOURCE)
        result = self.apply()
        self.assertEqual({k: result[k] for k in ['status', 'other_sites_preserved']},
                         {'status': 'UPDATED', 'other_sites_preserved': True})
        self.assertRegex(result['rollback_token'], r'^identity-proxy-[A-Za-z0-9._-]+$')
        self.assertEqual(self.source.read_bytes(), CANDIDATE)
        self.assertEqual(self.ops.current, config(CANDIDATE))
        self.assertEqual(self.ops.reloads, 1)
        self.assertLess(self.ops.events.index('validate'), self.ops.events.index('reload'))
        self.assert_identity()
        self.assertEqual(self.backups.stat().st_mode & 0o777, 0o700)
        for path in self.backups.rglob('*'):
            self.assertEqual(path.stat().st_mode & 0o777, 0o700 if path.is_dir() else 0o600)
        self.assertEqual((self.backups/result['rollback_token']/'original.Caddyfile').read_bytes(), SOURCE)
        self.assertEqual(self.ops.events[-1], 'cleanup')

    def test_later_restore_is_guarded_verified_and_idempotent(self):
        receipt = self.apply()
        inode = self.source.stat().st_ino
        restored = proxy.restore_proxy(self.source, self.ops, self.backups, receipt['rollback_token'])
        self.assertEqual(restored, {'status': 'RESTORED', 'other_sites_preserved': True})
        self.assertEqual(self.source.read_bytes(), SOURCE)
        self.assertEqual(self.ops.active(), config(SOURCE))
        self.assertEqual(self.source.stat().st_ino, inode)
        self.assertEqual(self.ops.reloads, 2)
        self.assertEqual(proxy.restore_proxy(self.source, self.ops, self.backups, receipt['rollback_token']),
                         {'status': 'UNCHANGED', 'other_sites_preserved': True})
        self.assertEqual(self.ops.reloads, 2)

    def test_later_restore_refuses_concurrent_disk_or_active_changes(self):
        receipt = self.apply()
        external = CANDIDATE + b'# another operator\n'
        self.source.write_bytes(external)
        self.ops.current = config(external)
        with self.assertRaisesRegex(proxy.ProxyError, 'ROLLBACK_SOURCE_CHANGED'):
            proxy.restore_proxy(self.source, self.ops, self.backups, receipt['rollback_token'])
        self.assertEqual(self.source.read_bytes(), external)
        self.source.write_bytes(CANDIDATE)
        self.ops.current = {'another': 'operator'}
        with self.assertRaisesRegex(proxy.ProxyError, 'ACTIVE_DISK_CONFIG_MISMATCH'):
            proxy.restore_proxy(self.source, self.ops, self.backups, receipt['rollback_token'])
        self.assertEqual(self.source.read_bytes(), CANDIDATE)

    def test_later_restore_reload_failure_returns_to_candidate(self):
        receipt = self.apply()
        def reload(number):
            if number == 2:
                raise proxy.ProxyError('PROXY_RELOAD_FAILED')
            self.ops.current = config(self.source.read_bytes())
        self.ops.on_reload = reload
        with self.assertRaisesRegex(proxy.ProxyError, 'PROXY_RESTORE_FAILED_ROLLED_BACK'):
            proxy.restore_proxy(self.source, self.ops, self.backups, receipt['rollback_token'])
        self.assertEqual(self.source.read_bytes(), CANDIDATE)
        self.assertEqual(self.ops.active(), config(CANDIDATE))
        self.assertEqual(self.ops.reloads, 3)

    def test_already_correct_is_noop_without_reload_or_backup(self):
        self.source.write_bytes(CANDIDATE)
        self.ops.current = config(CANDIDATE)
        self.assertEqual(self.apply(), {'status': 'UNCHANGED', 'other_sites_preserved': True})
        self.assertEqual(self.ops.reloads, 0)
        self.assertNotIn('stage', self.ops.events)
        self.assertFalse(self.backups.exists())

    def test_active_disk_drift_stops_before_staging_even_if_policy_correct(self):
        for value in [SOURCE, CANDIDATE]:
            self.source.write_bytes(value)
            self.ops.current = {'different': True}
            with self.assertRaisesRegex(proxy.ProxyError, 'ACTIVE_DISK_CONFIG_MISMATCH'):
                self.apply()
            self.assertEqual(self.source.read_bytes(), value)
        self.assertNotIn('stage', self.ops.events)

    def test_validate_failure_never_writes_or_reloads(self):
        def invalid():
            raise proxy.ProxyError('PROXY_VALIDATE_FAILED')
        self.ops.on_validate = invalid
        with self.assertRaisesRegex(proxy.ProxyError, 'PROXY_VALIDATE_FAILED'):
            self.apply()
        self.assertEqual(self.source.read_bytes(), SOURCE)
        self.assertEqual(self.ops.reloads, 0)
        self.assertEqual(self.ops.events[-1], 'cleanup')

    def test_concurrent_disk_change_is_preserved_and_not_reloaded(self):
        external = SOURCE + b'# another operator\n'
        self.ops.on_validate = lambda: self.source.write_bytes(external)
        with self.assertRaisesRegex(proxy.ProxyError, 'SOURCE_CHANGED_CONCURRENTLY'):
            self.apply()
        self.assertEqual(self.source.read_bytes(), external)
        self.assertEqual(self.ops.reloads, 0)

    def test_concurrent_active_change_stops_before_writing(self):
        self.ops.on_validate = lambda: setattr(self.ops, 'current', {'another': 'operator'})
        with self.assertRaisesRegex(proxy.ProxyError, 'ACTIVE_CONFIG_CHANGED_CONCURRENTLY'):
            self.apply()
        self.assertEqual(self.source.read_bytes(), SOURCE)
        self.assertEqual(self.ops.reloads, 0)

    def test_reload_failure_restores_original_and_confirms_active_config(self):
        def reload(number):
            if number == 1:
                raise proxy.ProxyError('PROXY_RELOAD_FAILED')
            self.ops.current = config(self.source.read_bytes())
        self.ops.on_reload = reload
        with self.assertRaisesRegex(proxy.ProxyError, 'PROXY_UPDATE_FAILED_ROLLED_BACK'):
            self.apply()
        self.assertEqual(self.source.read_bytes(), SOURCE)
        self.assertEqual(self.ops.current, config(SOURCE))
        self.assertEqual(self.ops.reloads, 2)
        self.assert_identity()

    def test_exit_zero_without_active_candidate_is_not_success_and_rolls_back(self):
        self.ops.on_reload = lambda _: None  # Keep the old active config despite an apparent successful reload.
        with self.assertRaisesRegex(proxy.ProxyError, 'PROXY_UPDATE_FAILED_ROLLED_BACK'):
            self.apply()
        self.assertEqual(self.source.read_bytes(), SOURCE)
        self.assertEqual(self.ops.current, config(SOURCE))
        self.assertEqual(self.ops.reloads, 2)

    def test_rollback_never_overwrites_another_operators_disk_change(self):
        external = CANDIDATE + b'# concurrent update\n'
        def changed(_):
            self.source.write_bytes(external)
            raise proxy.ProxyError('PROXY_RELOAD_FAILED')
        self.ops.on_reload = changed
        with self.assertRaisesRegex(proxy.ProxyError, 'PROXY_ROLLBACK_FAILED_OR_CONCURRENT_CHANGE'):
            self.apply()
        self.assertEqual(self.source.read_bytes(), external)
        self.assertEqual(self.ops.reloads, 1)

    def test_rollback_never_overwrites_another_operators_active_change(self):
        self.ops.on_reload = lambda _: setattr(self.ops, 'current', {'another': 'operator'})
        with self.assertRaisesRegex(proxy.ProxyError, 'PROXY_ROLLBACK_FAILED_OR_CONCURRENT_CHANGE'):
            self.apply()
        self.assertEqual(self.ops.current, {'another': 'operator'})
        self.assertEqual(self.ops.reloads, 1)

    def test_rollback_reload_failure_is_reported_explicitly(self):
        def broken(_):
            raise proxy.ProxyError('PROXY_RELOAD_FAILED')
        self.ops.on_reload = broken
        with self.assertRaisesRegex(proxy.ProxyError, 'PROXY_ROLLBACK_FAILED_OR_CONCURRENT_CHANGE'):
            self.apply()
        self.assertEqual(self.ops.reloads, 2)

    def test_symlink_source_is_rejected_without_writes(self):
        link = self.root / 'link.Caddyfile'
        link.symlink_to(self.source)
        with self.assertRaisesRegex(proxy.ProxyError, 'SOURCE_FILE_UNAVAILABLE'):
            proxy.update_proxy(link, self.ops, self.backups)
        self.assertEqual(self.source.read_bytes(), SOURCE)

    def test_fsync_failure_after_write_restores_original_without_replacing_inode(self):
        original_sync = os.fsync
        failed = False
        def sync(fd):
            nonlocal failed
            if os.fstat(fd).st_ino == self.info.st_ino and not failed:
                failed = True
                raise OSError('synthetic disk failure')
            return original_sync(fd)
        with mock.patch.object(proxy.os, 'fsync', side_effect=sync):
            with self.assertRaisesRegex(proxy.ProxyError, 'PROXY_UPDATE_FAILED_ROLLED_BACK'):
                self.apply()
        self.assertTrue(failed)
        self.assertEqual(self.source.read_bytes(), SOURCE)
        self.assertEqual(self.ops.current, config(SOURCE))
        self.assertEqual(self.ops.reloads, 1)
        self.assert_identity()

    def test_partial_write_failure_restores_only_the_helpers_known_partial_state(self):
        original_write = os.write
        calls = 0
        cut = CANDIDATE.index(b'Referrer-Policy no-referrer') + len(b'Referrer-Policy no-')
        def write(fd, data):
            nonlocal calls
            if os.fstat(fd).st_ino == self.info.st_ino:
                calls += 1
                if calls == 1:
                    return original_write(fd, data[:cut])
                if calls == 2:
                    raise OSError('synthetic partial write failure')
            return original_write(fd, data)
        with mock.patch.object(proxy.os, 'write', side_effect=write):
            with self.assertRaisesRegex(proxy.ProxyError, 'PROXY_UPDATE_FAILED_ROLLED_BACK'):
                self.apply()
        self.assertGreaterEqual(calls, 3)
        self.assertEqual(self.source.read_bytes(), SOURCE)
        self.assertEqual(self.ops.current, config(SOURCE))
        self.assert_identity()

class TemplateTests(unittest.TestCase):
    def test_templates_expose_exact_public_version_route_before_spa_fallback(self):
        root = Path(__file__).resolve().parents[2]
        for name in ['commerce.Caddyfile', 'commerce.Caddyfile.example']:
            with self.subTest(name=name):
                source = (root / 'infra' / 'caddy' / name).read_bytes()
                self.assertEqual(source.count(proxy.VERSION_ROUTE_BLOCK), 1)
                self.assertEqual(source.count(FALLBACK), 1)
                self.assertLess(source.index(proxy.VERSION_ROUTE_BLOCK), source.index(FALLBACK))
                if name == 'commerce.Caddyfile':
                    self.assertEqual(proxy.rewrite_policy(source), source)

class CommandTests(unittest.TestCase):
    def test_global_deadline_reserves_rollback_time_with_bounded_commands(self):
        now = [0.0]
        operations = proxy.DockerCaddy(clock=lambda: now[0])
        success = subprocess.CompletedProcess([], 0, stdout=b'{}', stderr=b'')
        with mock.patch.object(proxy.subprocess, 'run', return_value=success) as run:
            operations.command(['synthetic'], 'CHECK_FAILED')
            self.assertEqual(run.call_args.kwargs['timeout'], 15)
            now[0] = 79.5
            operations.command(['synthetic'], 'CHECK_FAILED')
            self.assertEqual(run.call_args.kwargs['timeout'], 0.5)
            now[0] = 80.1
            with self.assertRaisesRegex(proxy.ProxyError, 'CHECK_FAILED_TIMEOUT'):
                operations.command(['synthetic'], 'CHECK_FAILED')
            operations.begin_rollback()
            operations.command(['synthetic'], 'CHECK_FAILED')
            self.assertEqual(run.call_args.kwargs['timeout'], 15)
            now[0] = 109
            operations.command(['synthetic'], 'CHECK_FAILED')
            self.assertEqual(run.call_args.kwargs['timeout'], 1)
            now[0] = 110.1
            with self.assertRaisesRegex(proxy.ProxyError, 'CHECK_FAILED_TIMEOUT'):
                operations.command(['synthetic'], 'CHECK_FAILED')

    def test_staging_streams_bytes_to_private_tmp_without_docker_cp(self):
        with tempfile.TemporaryDirectory(prefix='identity-proxy-stage-') as directory:
            source = Path(directory) / 'candidate.Caddyfile'
            content = SOURCE + '# comentario privado sintético\n'.encode()
            source.write_bytes(content)
            operations = proxy.DockerCaddy()
            with mock.patch.object(operations, 'command') as command:
                operations.stage(source, '/tmp/identity-proxy-synthetic.Caddyfile')
            args, code = command.call_args.args
            self.assertEqual(args[:4], ['docker', 'exec', '-i', proxy.PROXY])
            self.assertNotIn('cp', args)
            self.assertIn('umask 077', args[6])
            self.assertIn('set -C', args[6])
            self.assertEqual(command.call_args.kwargs['input_bytes'], content)
            self.assertEqual(code, 'PROXY_STAGE_FAILED')

    def test_command_errors_never_include_captured_private_output(self):
        failure = subprocess.CompletedProcess([], 1, stdout=b'private configuration', stderr=b'private configuration')
        with mock.patch.object(proxy.subprocess, 'run', return_value=failure):
            with self.assertRaises(proxy.ProxyError) as caught:
                proxy.DockerCaddy().command(['synthetic'], 'PROXY_VALIDATE_FAILED')
            self.assertEqual(str(caught.exception), 'PROXY_VALIDATE_FAILED')

class DiscoveryTests(unittest.TestCase):
    def test_requires_exact_single_bind_mount(self):
        operations = proxy.DockerCaddy()
        for mounts in [[], [{'Destination': proxy.MOUNT, 'Type': 'volume', 'Source': '/existing'}], [{'Destination': proxy.MOUNT, 'Type': 'bind', 'Source': 'relative'}], [{'Destination': proxy.MOUNT, 'Type': 'bind', 'Source': '/a'}] * 2]:
            operations.json_command = lambda _args, _code, value=mounts: value
            with self.assertRaises(proxy.ProxyError):
                operations.source_path()
        operations.json_command = lambda _args, _code: [{'Destination': proxy.MOUNT, 'Type': 'bind', 'Source': '/existing.Caddyfile'}]
        self.assertEqual(operations.source_path(), Path('/existing.Caddyfile'))

if __name__ == '__main__':
    unittest.main()
