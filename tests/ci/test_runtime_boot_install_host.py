"""Native file/CAS mechanics with synthetic authority; no systemd or Docker."""
import base64
import copy
import contextlib
import datetime as dt
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
sys.path[:0] = [str(Path(__file__).resolve().parents[2]/'scripts')]
import runtime_boot_install_host as h
import copy_runtime_deployment as runtime


class InstallHostTests(unittest.TestCase):
    def fixture(self):
        # Synthetic adapter state, never a production constructor or authority.
        a = object.__new__(h.Installer)
        a.permits = set(); a.context = {'synthetic': True}; a.policy = {}
        a.journal = {'actions': {}, 'previous': {}}
        a.read_journal = lambda: copy.deepcopy(a.journal)
        a.update = lambda v: setattr(a, 'journal', copy.deepcopy(v))
        a.authorize = lambda *_: None; a.remaining = lambda: 30
        return a

    def synthetic_file(self, path, **_kwargs):
        return Path(path).read_bytes()

    def test_directory_requires_new_durable_intent_not_old_json(self):
        a = self.fixture(); a.journal['actions']['directory:base'] = {'status': 'INTENT'}
        with patch.object(Path, 'mkdir', side_effect=AssertionError('no effect')):
            with self.assertRaisesRegex(RuntimeError, 'NEW_INTENT_REQUIRED'):
                a.dispatch_once('directory', 'base', None)

    def test_post_dispatched_cas_revalidates_before_native_effect(self):
        a = self.fixture(); p = {'kind': 'reload', 'name': 'systemd', 'sha256': None}
        a.commit_intent('reload:systemd', p)
        def reject(*_): raise RuntimeError('SYNTHETIC_EXPIRED_AFTER_CAS')
        a.authorize = reject
        with patch.object(h.host, 'bounded', side_effect=AssertionError('no command')):
            with self.assertRaisesRegex(RuntimeError, 'EXPIRED_AFTER_CAS'):
                a.dispatch_once('reload', 'systemd', None)
        self.assertFalse(a.permits); self.assertTrue(a.journal['actions']['reload:systemd']['dispatched'])

    def test_enable_exact_unit_without_now_and_single_process(self):
        a = self.fixture(); a.unit_identity = lambda _: {}
        a.commit_intent('enable:docker.service', {'kind': 'enable', 'name': 'docker.service', 'sha256': None})
        with patch.object(h.host, 'bounded', return_value='') as run:
            a.dispatch_once('enable', 'docker.service', None)
            run.assert_called_once_with(['/usr/bin/systemctl', 'enable', '--', 'docker.service'], 30)
            with self.assertRaisesRegex(RuntimeError, 'NEW_INTENT_REQUIRED'):
                a.dispatch_once('enable', 'docker.service', None)

    def test_outside_path_and_session_effect_never_dispatch(self):
        a = self.fixture()
        for kind, name in (('file', '../secret'), ('file', 'tools/foreign.py'), ('unit-file', 'ssh.service')):
            with self.subTest(kind=kind, name=name), self.assertRaisesRegex(RuntimeError, 'TARGET_SCOPE'):
                a.path(kind, name)
        a.commit_intent('enable:ssh.service', {})
        with patch.object(h.host, 'bounded', side_effect=AssertionError('no command')):
            with self.assertRaisesRegex(RuntimeError, 'EFFECT_SCOPE'): a.dispatch_once('enable', 'ssh.service', None)

    def test_atomic_file_replacement_preserves_original_and_exact_mode(self):
        with tempfile.TemporaryDirectory() as d, patch.object(h.host, 'protected_parents'), patch.object(h.host, 'protected', self.synthetic_file):
            p = Path(d)/'unit'; p.write_bytes(b'old'); p.chmod(0o644)
            h.replace_file(p, b'new', b'old', 0o644)
            self.assertEqual(p.read_bytes(), b'new'); self.assertEqual(p.stat().st_mode & 0o777, 0o644)
            self.assertFalse((p.parent/'.commerce-boot-unit.pending').exists())

    def test_file_cas_change_or_pending_unknown_never_overwrites(self):
        with tempfile.TemporaryDirectory() as d, patch.object(h.host, 'protected_parents'), patch.object(h.host, 'protected', self.synthetic_file):
            p = Path(d)/'unit'; p.write_bytes(b'changed')
            with self.assertRaisesRegex(RuntimeError, 'CAS_CHANGED'): h.replace_file(p, b'new', b'old', 0o644)
            self.assertEqual(p.read_bytes(), b'changed')
            p.write_bytes(b'old'); (p.parent/'.commerce-boot-unit.pending').write_bytes(b'uncertain')
            with self.assertRaises(FileExistsError): h.replace_file(p, b'new', b'old', 0o644)
            self.assertEqual(p.read_bytes(), b'old')

    def test_unsafe_parent_rejected_before_open(self):
        with tempfile.TemporaryDirectory() as d, patch.object(h.host, 'protected_parents', side_effect=RuntimeError('UNSAFE')):
            p = Path(d)/'unit'
            with self.assertRaisesRegex(RuntimeError, 'UNSAFE'): h.replace_file(p, b'new', None, 0o644)
            self.assertFalse(p.exists())

    def test_appearing_file_not_adopted_or_replaced(self):
        with tempfile.TemporaryDirectory() as d, patch.object(h.host, 'protected_parents'):
            p = Path(d)/'unit'; p.write_bytes(b'foreign')
            with self.assertRaisesRegex(RuntimeError, 'TARGET_APPEARED'): h.replace_file(p, b'new', None, 0o644)
            self.assertEqual(p.read_bytes(), b'foreign')

    def test_previous_original_bytes_supply_cas_from_durable_journal(self):
        a = self.fixture(); a.journal['previous']['policy.json'] = base64.b64encode(b'original').decode()
        a.commit_intent('file:policy.json', {'kind': 'file', 'name': 'policy.json', 'sha256': runtime.sha256(b'new')})
        with patch.object(h, 'replace_file') as replace:
            a.dispatch_once('file', 'policy.json', b'new')
            replace.assert_called_once_with(h.host.BASE/'policy.json', b'new', b'original', 0o600)
        self.assertEqual(a.journal['previous']['policy.json'], base64.b64encode(b'original').decode())

    def test_systemd_readback_requires_closed_fields(self):
        a = self.fixture()
        with patch.object(h.host, 'bounded', return_value='LoadState=loaded\nFragmentPath=/evil\n'):
            with self.assertRaisesRegex(RuntimeError, 'READBACK_INVALID'): a.show('docker.service')
        with patch.object(h.host, 'bounded', side_effect=AssertionError('no command')):
            with self.assertRaisesRegex(RuntimeError, 'UNIT_SCOPE'): a.show('foreign.service')

    def test_reload_confirmation_requires_loaded_exact_own_fragment(self):
        a = self.fixture(); a.show = lambda _: {'LoadState': 'loaded', 'FragmentPath': '/foreign/unit', 'NeedDaemonReload': 'no', 'DropInPaths': ''}
        self.assertFalse(a.confirm('reload', 'systemd', None))
        a.show = lambda _: {'LoadState': 'loaded', 'FragmentPath': str(h.UNIT_PATH), 'NeedDaemonReload': 'no', 'DropInPaths': ''}
        self.assertTrue(a.confirm('reload', 'systemd', None))

    def test_systemd_dropins_are_not_silently_adopted(self):
        a = self.fixture()
        a.show = lambda name: {'LoadState': 'loaded', 'FragmentPath': str(h.UNIT_PATH) if name == h.bundle_tools.UNIT else '/usr/lib/systemd/system/'+name,
            'NeedDaemonReload': 'no', 'UnitFileState': 'enabled', 'DropInPaths': '/etc/systemd/system/'+name+'.d/foreign.conf'}
        for name in h.UNITS:
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'UNIT_IDENTITY_CHANGED'):
                a.unit_identity(name)
        self.assertFalse(a.confirm('reload', 'systemd', None))

    def test_approval_expiry_during_native_readbacks_keeps_intent_without_dispatch(self):
        a = self.fixture(); moment = [dt.datetime(2026, 10, 11, 18, 0, tzinfo=dt.timezone.utc)]
        expiry = moment[0]+dt.timedelta(seconds=1)
        class Clock(dt.datetime):
            @classmethod
            def now(cls, _tz=None): return moment[0]
        a.approval = {'created_at': moment[0].isoformat(), 'expires_at': expiry.isoformat(), 'gateway_start_ids': {}}
        a.policy = {'gateway_start_ids': {}}
        a.approval_raw = runtime.sealed_bytes(a.approval); a.state_raw = b'{}'; a.plan_raw = b'{}'
        a.report = {'source_sha': 'a'*40, 'run_id': 'synthetic', 'predeploy_backup': {}}
        a.root = Path('/synthetic/root'); a.report_dir = h.host.PRIVATE/'deployments/synthetic'
        a.state = {'runtime_stage': 'OPERATING', 'current_release': str(a.root), 'canonical_files': {},
            'smtp_transition_ref': {}, 'caddy_config_ref': {}, 'portal': {}, 'network_baseline': {}, 'active_proxy_sha256': 'b'*64}
        a.locks = {}; a.reader = types.SimpleNamespace(known_ids={'c'*64})
        a.command = lambda argv, _root: 'c'*64 if argv[1] == 'ps' else '[]'
        class BackupRunner:
            def __init__(self, _expected): pass
            def runtime_guard(self): pass
            def portal_guard(self): pass
        a.backup = types.SimpleNamespace(BackupRunner=BackupRunner, controller_update_locks=lambda _: contextlib.nullcontext())
        a.backup_evidence = {}; a.backup_fingerprints = {}; a.migrations = {}; a.restore_sources = {}
        a.journal_raw = b'synthetic'; a.journal['core_units'] = {n:{} for n in ('containerd.service', 'docker.service')}
        def unit_read(_): moment[0] = expiry; return {}
        a.unit_identity = unit_read
        raw_applied = runtime.sealed_bytes({'status': 'APPLIED', 'source_sha': 'a'*40, 'run_id': 'synthetic',
            'actual_state_sha256': runtime.sha256(a.state_raw), 'actual_plan_sha256': runtime.sha256(a.plan_raw)})
        def protected(path, **_):
            return {h.gate.APPROVAL:a.approval_raw, h.host.PRIVATE/'api-web-adoption.json':a.state_raw,
                h.host.PRIVATE/'daily-b02/plan.json':a.plan_raw, a.report_dir/'copy-runtime-transition.json':raw_applied,
                h.host.PRIVATE/'release.env':b'SYNTHETIC=true\n'}[Path(path)]
        services = {n:{'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped'}}} for n in runtime.CORE}
        a.authorize = h.Installer.authorize.__get__(a)
        a.commit_intent('reload:systemd', {'kind': 'reload', 'name': 'systemd', 'sha256': None})
        with contextlib.ExitStack() as stack:
            targets = {(h.host, 'protected'):protected, (h.host, 'native_host_id'):lambda:'123456',
                (h, 'directory'):lambda *_:None,
                (h.host, 'network_snapshot'):lambda *_:{}, (h.policy_tools, 'validate_policy'):lambda *_args, **_kwargs:services,
                (runtime.native, 'read_reference'):lambda *_:b'{}', (runtime.native, 'read_portal_references'):lambda *_:None,
                (runtime.native, 'active_proxy_digest'):lambda *_:'b'*64, (runtime, 'topology'):lambda *_:None,
                (runtime, 'verify_edge'):lambda *_:None, (runtime, 'terminal_journals'):lambda *_:None,
                (h.gate, 'validate'):lambda *_args, **_kwargs:{}, (Path, 'resolve'):lambda *_args, **_kwargs:a.root}
            for (module, name), value in targets.items(): stack.enter_context(patch.object(module, name, value))
            stack.enter_context(patch.object(h.dt, 'datetime', Clock))
            run = stack.enter_context(patch.object(h.host, 'bounded', side_effect=AssertionError('no native effect')))
            with self.assertRaisesRegex(RuntimeError, 'APPROVAL_EXPIRED_AFTER_READS'):
                a.dispatch_once('reload', 'systemd', None)
            run.assert_not_called()
        self.assertTrue(a.journal['actions']['reload:systemd']['dispatched']); self.assertFalse(a.permits)

if __name__ == '__main__': unittest.main()
