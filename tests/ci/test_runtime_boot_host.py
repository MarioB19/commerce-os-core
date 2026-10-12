"""Synthetic host boundaries and real bounded processes; no Docker or cloud."""
from contextlib import contextmanager
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path[:0] = [str(Path(__file__).resolve().parents[2] / 'scripts'), str(Path(__file__).parent)]
import runtime_boot_host as host
import runtime_boot_install as install
import runtime_boot_policy as policy
import copy_runtime_deployment as runtime
from test_runtime_boot_policy import BootPolicyTests, BOOT

ROOT = Path(__file__).resolve().parents[2]


class HostTests(unittest.TestCase):
    def setUp(self):
        fixture = BootPolicyTests(); fixture.setUp(); self.fixture = fixture
        self.facts = {'policy': fixture.policy, 'adoption_raw': fixture.raw, 'plan_raw': fixture.plan,
                      'rows': fixture.rows, 'boot_id': BOOT, 'host_id': '123456'}
        with patch.object(host.os, 'geteuid', return_value=0): self.adapter = host.HostAdapter()
        self.adapter.locked = True

    def networks(self):
        services = copy.deepcopy(runtime.validate_inventory(self.fixture.state, self.fixture.rows))
        services['api']['NetworkSettings']['Networks']['synthetic-edge'] = {'NetworkID': 'e' * 64}
        names = set().union(*(set(row['NetworkSettings']['Networks']) for row in services.values()))
        rows = []
        for name in sorted(names):
            rows.append({'Name': name, 'Id': '9' * 64, 'Driver': 'bridge', 'Internal': False,
                'EnableIPv6': False, 'IPAM': {}, 'Options': {}, 'Labels': {},
                'Containers': {row['Id']: {} for row in services.values()
                               if row['State']['Running'] and name in row['NetworkSettings']['Networks']}})
        return services, rows

    def test_stopped_membership_is_not_a_live_endpoint_or_new_baseline(self):
        services, rows = self.networks(); before = copy.deepcopy(services)
        command = Mock(return_value=json.dumps(rows))
        result = host.network_snapshot(command, ROOT, services)
        self.assertEqual(services, before); self.assertEqual(len(result), len(rows))
        stopped = next(row for row in services.values() if not row['State']['Running'])
        name = next(iter(stopped['NetworkSettings']['Networks']))
        next(row for row in rows if row['Name'] == name)['Containers'][stopped['Id']] = {}
        command.return_value = json.dumps(rows)
        with self.assertRaisesRegex(RuntimeError, 'ACTIVE_ENDPOINT'): host.network_snapshot(command, ROOT, services)

    def test_foreign_missing_or_duplicate_networks_fail(self):
        services, rows = self.networks()
        for change in ('foreign', 'missing', 'duplicate'):
            bad = copy.deepcopy(rows)
            if change == 'foreign': bad[0]['Containers']['f' * 64] = {}
            elif change == 'missing': next(row for row in bad if row['Containers'])['Containers'].clear()
            else: bad[-1] = copy.deepcopy(bad[0])
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                host.network_snapshot(lambda *_: json.dumps(bad), ROOT, services)

    @contextmanager
    def journal_disk(self):
        # Local fixture substitutes only custody ownership reads. O_EXCL,
        # atomic rename, fsync and physical journal bytes remain real.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); (base / 'boots').mkdir(mode=0o700)
            with patch.object(host, 'BASE', base), patch.object(host, 'protected_parents'), patch.object(host, 'protected', side_effect=lambda p, **_: Path(p).read_bytes()):
                yield base

    def test_real_journal_cas_is_durable_and_deleted_history_never_resets(self):
        with self.journal_disk():
            original = self.adapter.read_journal(self.facts)
            changed = copy.deepcopy(original); cid = self.fixture.rows[-2]['Id']
            changed['gateways']['waha-01'] = {'container_id': cid, 'status': 'START_INTENT'}
            self.adapter.compare_and_swap_journal(original, changed)
            self.assertEqual(self.adapter.read_journal(self.facts), changed)
            self.assertEqual(self.adapter.allowed_starts, {cid})
            self.adapter.journal_path.unlink()
            with self.assertRaisesRegex(RuntimeError, 'MISSING_NO_RESET'): self.adapter.read_journal(self.facts)

    def test_crash_after_once_marker_does_not_invent_empty_journal(self):
        with self.journal_disk():
            real = host.durable_write
            def crash(path, raw, **kwargs):
                if path.name == BOOT + '.json': raise OSError('synthetic crash')
                return real(path, raw, **kwargs)
            with patch.object(host, 'durable_write', side_effect=crash), self.assertRaises(OSError):
                self.adapter.read_journal(self.facts)
            with self.assertRaisesRegex(RuntimeError, 'MISSING_NO_RESET'): self.adapter.read_journal(self.facts)

    def test_completion_rechecks_gateway_health_after_final_running_journal(self):
        journal = copy.deepcopy(self.fixture.journal)
        journal['gateways']['waha-01'] = {'container_id': self.fixture.rows[-2]['Id'], 'status': 'RUNNING'}
        self.adapter.observe = Mock(return_value=self.facts)
        self.adapter.read_journal = Mock(return_value=journal)
        with patch.object(host, 'durable_write') as write:
            for running in (False, True):
                with self.subTest(running=running):
                    self.fixture.rows[-2]['State'].update(Running=running, Pid=777 if running else 0,
                        Health={'Status': 'unhealthy'})
                    with self.assertRaises(RuntimeError): self.adapter.complete(BOOT)
            write.assert_not_called()

    def test_unsafe_parent_rejected_before_any_create_or_cas_write(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); unsafe = base / 'boots'; unsafe.mkdir(mode=0o700)
            real = Path.lstat
            def root_owned(path):
                observed = real(path)
                mode = observed.st_mode if path == unsafe else observed.st_mode & ~0o022
                return SimpleNamespace(st_uid=0, st_mode=mode)
            with patch.object(Path, 'lstat', root_owned), patch.object(host.os, 'open') as opened:
                unsafe.chmod(0o777)
                for previous in (None, b'old'):
                    with self.assertRaisesRegex(RuntimeError, 'PARENT_UNSAFE'):
                        host.durable_write(unsafe / 'journal.json', b'new', previous=previous)
                unsafe.chmod(0o700); unsafe.rmdir(); unsafe.symlink_to(base, target_is_directory=True)
                with self.assertRaisesRegex(RuntimeError, 'PARENT_UNSAFE'):
                    host.durable_write(unsafe / 'journal.json', b'new')
                opened.assert_not_called()
            self.assertFalse((base / 'journal.json').exists())

    def test_only_a_cas_confirmed_in_this_process_can_start(self):
        cid = self.fixture.rows[-2]['Id']
        self.adapter.observe = Mock(return_value=self.facts)
        self.adapter.read_journal = Mock(return_value={'gateways': {'waha-01': {'container_id': cid, 'status': 'START_INTENT'}}})
        self.adapter.docker = ['/usr/bin/docker']
        with patch.object(host, 'bounded', side_effect=TimeoutError('unknown')) as command:
            with self.assertRaisesRegex(RuntimeError, 'ALREADY_DISPATCHED'): self.adapter.start_once(cid)
            self.adapter.allowed_starts.add(cid)
            with self.assertRaises(TimeoutError): self.adapter.start_once(cid)
            with self.assertRaisesRegex(RuntimeError, 'ALREADY_DISPATCHED'): self.adapter.start_once(cid)
            self.assertEqual(command.call_count, 1)
            self.assertEqual(command.call_args.args[0], ['/usr/bin/docker', 'start', cid])

    def test_core_wait_retries_health_only_and_has_a_deadline(self):
        self.adapter.raw_observation = Mock(return_value=(self.facts, {}, {}))
        self.adapter.canonical_guards = Mock()
        with patch.object(policy, 'validate_policy', side_effect=[runtime.ReleaseError('COPY_RUNTIME_CORE_NOT_RUNNING'), None]), patch.object(host.time, 'sleep') as sleep:
            self.adapter.observe(); sleep.assert_called_once_with(2)
        self.adapter.core_ready = False
        with patch.object(policy, 'validate_policy', side_effect=runtime.ReleaseError('COPY_RUNTIME_STATIC_DEFINITION_CHANGED')), patch.object(host.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'STATIC_DEFINITION'): self.adapter.observe()
            sleep.assert_not_called()
        self.adapter.deadline = 0
        with patch.object(policy, 'validate_policy', side_effect=runtime.ReleaseError('BOOT_PROCESS_NOT_HEALTHY')):
            with self.assertRaisesRegex(RuntimeError, 'HEALTH_TIMEOUT'): self.adapter.observe()

    def test_read_command_allowlist_has_no_start_create_sessions_or_network_write(self):
        self.adapter.release = ROOT; self.adapter.docker = ['/usr/bin/docker']; self.adapter.known_ids = {'a' * 64}
        with patch.object(host, 'bounded', return_value='safe') as command:
            self.adapter.command(['docker', 'inspect', 'a' * 64], ROOT)
            for argv in (['docker', 'start', 'a' * 64], ['docker', 'compose', 'up'],
                         ['docker', 'network', 'connect', 'x', 'a' * 64],
                         ['docker', 'exec', 'a' * 64, 'curl', 'http://sessions/start']):
                with self.assertRaisesRegex(RuntimeError, 'READ_COMMAND'): self.adapter.command(argv, ROOT)
            self.assertEqual(command.call_count, 1)

    def test_four_existing_locks_exclude_concurrent_adapter_and_release_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory)
            for name in runtime.native.LOCKS:
                path = private / name; path.write_bytes(b''); path.chmod(0o600)
            real = host.os.fstat
            def owned(fd):
                from types import SimpleNamespace
                observed = real(fd)
                return SimpleNamespace(st_mode=observed.st_mode, st_uid=0, st_nlink=observed.st_nlink)
            self.adapter.locked = False
            with patch.object(host, 'PRIVATE', private), patch.object(host.os, 'fstat', side_effect=owned), patch.object(host.os, 'geteuid', return_value=0):
                other = host.HostAdapter()
                with self.adapter.locks():
                    self.assertTrue(self.adapter.locked)
                    with self.assertRaises(BlockingIOError):
                        with other.locks(): self.fail('lock overlap')
                with other.locks(): self.assertTrue(other.locked)
                (private / runtime.native.LOCKS[-1]).unlink()
                with self.assertRaises(FileNotFoundError):
                    with other.locks(): self.fail('missing lock invented')
                self.assertFalse(other.locked)

    def test_entrypoint_rejects_missing_or_foreign_source_before_import(self):
        bundle = install.prepare(ROOT, 'a' * 40)
        spec = importlib.util.spec_from_file_location('boot_entry_fixture', ROOT / 'scripts/runtime-boot.py')
        entry = importlib.util.module_from_spec(spec); spec.loader.exec_module(entry)
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); tools = base / 'tools'; tools.mkdir()
            (base / 'sources.json').write_bytes(bundle['sources.json'])
            for name, raw in bundle['tools'].items(): (tools / name).write_bytes(raw)
            checksum = host.runtime.sha256(bundle['sources.json'])
            with patch.object(entry, 'BASE', base), patch.object(entry, 'TOOLS', tools), patch.object(entry, '__file__', str(tools / 'runtime-boot.py')), patch.object(entry.os, 'geteuid', return_value=0), patch.object(entry, 'read', side_effect=lambda p: p.read_bytes()):
                entry.authenticate(checksum)
                (tools / 'candidate.py').write_text('raise Exception("must never import")')
                with self.assertRaisesRegex(RuntimeError, 'DIRECTORY_CHANGED'): entry.authenticate(checksum)
                (tools / 'candidate.py').unlink(); (tools / 'runtime_boot_runner.py').write_text('changed')
                with self.assertRaisesRegex(RuntimeError, 'HASH_CHANGED'): entry.authenticate(checksum)

    def test_real_process_timeout_and_overflow_are_closed(self):
        self.assertEqual(host.bounded([sys.executable, '-c', 'print("synthetic")'], 2), 'synthetic')
        with self.assertRaisesRegex(RuntimeError, 'TIMEOUT_UNKNOWN'):
            host.bounded([sys.executable, '-c', 'import time; time.sleep(2)'], .05)
        with patch.object(host, 'MAX_OUTPUT', 128), self.assertRaisesRegex(RuntimeError, 'OUTPUT_BOUND'):
            host.bounded([sys.executable, '-c', 'print("x"*512)'], 2)

    def test_bundle_covers_exact_import_closure_and_unit_never_retries(self):
        bundle = install.prepare(ROOT, 'a' * 40)
        entry = ROOT / 'scripts/runtime-boot.py'
        spec = importlib.util.spec_from_file_location('boot_entry_fixture', entry)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        self.assertEqual(set(bundle['tools']), module.FILES)
        unit = bundle[install.UNIT].decode()
        self.assertIn('Restart=no\n', unit); self.assertIn('TimeoutStartSec=315\n', unit)
        self.assertNotIn('Restart=always', unit); self.assertNotIn('docker start', unit)
        self.assertEqual(bundle['activation'], 'DISABLED_PENDING_NATIVE_FULL')
        with self.assertRaises(TypeError):
            install.install(full=True, backup=True, reviewed=True)

    def test_real_boot_bundle_imports_without_checkout_or_pythonpath(self):
        bundle = install.prepare(ROOT, 'a' * 40)
        self.assertEqual(len(bundle['tools']), 10)
        self.assertIn('ci_provider_evidence.py', bundle['tools'])
        with tempfile.TemporaryDirectory() as directory:
            tools = Path(directory)/'tools'; tools.mkdir()
            for name, raw in bundle['tools'].items(): (tools/name).write_bytes(raw)
            code = ('import sys; sys.path.insert(0,sys.argv[1]); '
                'import runtime_boot_host,runtime_boot_runner; '
                'assert runtime_boot_host.runtime.provider_evidence.__file__.startswith(sys.argv[1]+"/")')
            result = subprocess.run([sys.executable, '-I', '-c', code, str(tools)],
                cwd=directory, env={}, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            (tools/'ci_provider_evidence.py').unlink()
            missing = subprocess.run([sys.executable, '-I', '-c', code, str(tools)],
                cwd=directory, env={}, capture_output=True, timeout=10)
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn(b'ci_provider_evidence', missing.stderr)


def load_tests(loader, _tests, _pattern):
    return loader.loadTestsFromTestCase(HostTests)


if __name__ == '__main__': unittest.main()
