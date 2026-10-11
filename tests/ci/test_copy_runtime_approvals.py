"""Synthetic approvals only: no production Root evidence or approvals are emitted."""
import contextlib
import copy
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import tarfile
import tempfile
import time
import types
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2]/'scripts'
sys.path.insert(0, str(SCRIPTS))
import copy_runtime_approvals as a
import copy_runtime_deployment as runtime
from ci_release import ReleaseError, digest
from test_copy_runtime_adapters import network
from test_copy_runtime_deployment import fixture, checksum

SHA = 'a'*40
RUN = '123-1'


class Synthetic:
    def __init__(self, base):
        self.base = base; self.private = base/'private'; self.private.mkdir(mode=0o700)
        self.events = []; self.calls = 0; self.change = None
        self.facts = {'runtime_stage': 'CORE_PREPARED', 'current_release': str(base/'previous'),
                      'adoption_sha256': 'b'*64, 'plan_sha256': 'c'*64,
                      'edge': {'networks_sha256': 'd'*64, 'routes_sha256': 'e'*64, 'containers_sha256': 'f'*64},
                      'profile_sha256': {'api.env': '1'*64}, 'policy': {'version': 93}, 'owner': {'ids': ['synthetic']},
                      'migrations': {str(i): '2'*64 for i in range(65)}, 'service_count': 5,
                      'consumer_edge_approval_ref': None}

    @contextlib.contextmanager
    def locked(self):
        self.events.append('lock')
        try: yield
        finally: self.events.append('unlock')

    def package_readers(self, package):
        self.events.append('package')
        for name in a.READERS:
            if (SCRIPTS/name).read_bytes() != (package/'scripts'/name).read_bytes():
                raise ReleaseError('ROOT_REVIEW_LOADED_READER_MISMATCH')

    def observe_native(self, package, metadata, candidate):
        self.assert_locked()
        self.calls += 1
        if self.change: self.change(self.calls, package)
        return copy.deepcopy(self.facts)

    def assert_locked(self):
        if not self.events or self.events[-1] not in ('lock', 'read'):
            raise AssertionError('native read outside locks')
        self.events.append('read')

    def compare_native(self, before, after):
        if before != after: raise ReleaseError('ROOT_REVIEW_NATIVE_CAS_CHANGED')


class ApprovalTests(unittest.TestCase):
    def setUp(self):
        # Home ancestry is not world-writable, unlike /tmp. The test UID is
        # substituted only inside this process; the CLI has no such option.
        self.temp = tempfile.TemporaryDirectory(prefix='commerce-root-review-test-', dir=Path.home())
        self.base = Path(self.temp.name)
        self.adapter = Synthetic(self.base)
        self.stack = contextlib.ExitStack()
        reader = a.read_private; directory = a.private_directory; stage_archive = a.stage_archive
        self.stack.enter_context(patch.object(a, 'read_private', side_effect=lambda p, **kw: reader(p, **dict(kw, uid=os.getuid()))))
        self.stack.enter_context(patch.object(a, 'private_directory', side_effect=lambda p, **kw: directory(p, **dict(kw, uid=os.getuid()))))
        self.stack.enter_context(patch.object(a, 'stage_archive', side_effect=lambda src, dst, sha: stage_archive(src, dst, sha, uid=os.getuid())))
        def ref_read(ref):
            raw = a.read_private(ref['path'])
            if a.native.reference(ref['path'], raw) != ref: raise ReleaseError('COPY_REFERENCE_CHANGED')
            return raw
        self.stack.enter_context(patch.object(a.native, 'read_reference', side_effect=ref_read))
        self.archive = self.make_archive()

    def tearDown(self):
        self.stack.close(); self.temp.cleanup()

    def make_archive(self, sha=SHA, run='123', count=67):
        stage = self.base/'source'; stage.mkdir(mode=0o700, exist_ok=True)
        data = {'images.tar.gz': b'synthetic-images', 'images.sha256': b'only-a-fixture',
                'web-manifest.json': b'{}', 'scripts/install-vps.sh': b'fixture-only'}
        for name in set(a.READERS)|set(a.TOOLS): data['scripts/'+name] = (SCRIPTS/name).read_bytes()
        migrations = {}
        for i in range(1, count+1):
            name = {66: '0066_pending_channel_cancellation.sql', 67: '0067_copy_source_isolation.sql',
                    68: '0068_operational_metric_writer.sql'}.get(i, '%04d_fixture.sql'%i)
            raw = ('-- synthetic %d\n'%i).encode(); data['packages/db/migrations/'+name] = raw
            migrations[name] = runtime.sha256(raw)
        data['RELEASE.json'] = a.encoded({'schema_version': 1, 'source_sha': sha, 'run_id': run,
                                        'platform': 'linux/amd64', 'migration_hashes': migrations})
        data['images.json'] = a.encoded({name: {'source_sha': sha} for name in
                                       ('commerce-os:release', 'commerce-os-web:release', 'commerce-os-maintenance:release', 'mi-ciclo-listo-portal:release')})
        data['PACKAGE.sha256'] = ''.join(runtime.sha256(raw)+'  '+name+'\n' for name, raw in sorted(data.items())).encode()
        for name, raw in data.items():
            p = stage/name; p.parent.mkdir(mode=0o700, parents=True, exist_ok=True); p.write_bytes(raw); p.chmod(0o600)
        archive = self.base/'fixture.tar'
        with tarfile.open(archive, 'w') as tar:
            for name in data: tar.add(stage/name, arcname=name, recursive=False)
        archive.chmod(0o600)
        return archive

    def observe(self):
        return a.observe(self.adapter, self.archive, digest(self.archive), SHA, RUN, 'fixture-one')

    def seal(self, observed):
        return a.seal(self.adapter, 'fixture-one', observed['observation_sha256'])

    def test_observe_does_not_approve_and_seal_binds_future_candidate(self):
        observed = self.observe()
        self.assertEqual(observed['status'], 'OBSERVED_REVIEW_REQUIRED')
        self.assertFalse((self.adapter.private/'copy-runtime-migrations.json').exists())
        self.assertFalse((self.adapter.private/'controller-approvals').exists())
        self.assertEqual(self.adapter.calls, 2)
        self.assertEqual(self.seal(observed)['status'], 'SEALED')
        result = json.loads((self.adapter.private/'copy-runtime-migrations.json').read_bytes())
        manifest = json.loads(a.native.read_reference(result['backup_tools_manifest_ref']))
        self.assertEqual(manifest['runtime_stage'], 'CORE_PREPARED')
        self.assertEqual(set(manifest['tools']), set(a.TOOLS))
        for name, ref in manifest['tools'].items():
            self.assertEqual(ref['path'], str(self.base/'releases'/('ci-'+RUN+'-'+SHA[:12])/'scripts'/name))
            self.assertEqual(ref['sha256'], runtime.sha256((SCRIPTS/name).read_bytes()))
        self.assertFalse((self.base/'releases').exists())
        self.assertEqual(self.seal(observed)['status'], 'SEALED_REPLAY_HISTORICAL')

    def test_archive_digest_failure_never_reaches_native_or_seal(self):
        with self.assertRaisesRegex(ReleaseError, 'ARCHIVE_HASH_MISMATCH'):
            a.observe(self.adapter, self.archive, '0'*64, SHA, RUN, 'bad-hash')
        self.assertEqual(self.adapter.calls, 0)
        self.assertFalse((self.adapter.private/'controller-approvals').exists())

    def test_wrong_sha_or_run_rejected_before_native_reads(self):
        for sha, run in [('0'*40, RUN), (SHA, '456-1')]:
            with self.assertRaisesRegex(ReleaseError, 'ROOT_REVIEW_RELEASE_IDENTITY'):
                a.observe(self.adapter, self.archive, digest(self.archive), sha, run, 'bad-'+run+sha[:2])
        self.assertEqual(self.adapter.calls, 0)

    def test_no_client_supplied_observation_or_autoapprove_mode(self):
        with self.assertRaises(FileNotFoundError): a.seal(self.adapter, 'nonexistent', 'a'*64)
        with self.assertRaises(ReleaseError): a.seal(self.adapter, '../fixture', 'a'*64)
        observed = self.observe()
        with self.assertRaisesRegex(ReleaseError, 'OBSERVATION_HASH_CHANGED'):
            a.seal(self.adapter, 'fixture-one', '0'*64)
        self.assertFalse((self.adapter.private/'controller-approvals').exists())

    def test_drift_between_observe_reads_rejects_without_observation(self):
        def change(count, package):
            if count == 2: self.adapter.facts['edge']['routes_sha256'] = '9'*64
        self.adapter.change = change
        with self.assertRaisesRegex(ReleaseError, 'NATIVE_CAS_CHANGED'): self.observe()
        self.assertFalse((self.adapter.private/'copy-runtime-reviews/fixture-one/observation.json').exists())
        self.assertEqual(self.adapter.events[-1], 'unlock')

    def test_native_drift_after_review_rejects_before_any_approval(self):
        observed = self.observe(); self.adapter.facts['adoption_sha256'] = '9'*64
        with self.assertRaisesRegex(ReleaseError, 'NATIVE_CAS_CHANGED'): self.seal(observed)
        self.assertFalse((self.adapter.private/'controller-approvals').exists())

    def test_drift_during_seal_preserves_pointer_and_does_not_claim_sealed(self):
        observed = self.observe()
        def change(count, package):
            if count == 4: self.adapter.facts['plan_sha256'] = '9'*64
        self.adapter.change = change
        with self.assertRaisesRegex(ReleaseError, 'NATIVE_CAS_CHANGED'): self.seal(observed)
        self.assertFalse((self.adapter.private/'copy-runtime-migrations.json').exists())
        self.assertFalse((self.adapter.private/'copy-runtime-reviews/fixture-one/seal.json').exists())

    def test_modified_package_or_loaded_reader_never_gets_approved(self):
        observed = self.observe()
        path = self.adapter.private/'copy-runtime-reviews/fixture-one/package/scripts/b02-backup-root.py'
        path.write_bytes(b'changed')
        with self.assertRaisesRegex(ReleaseError, 'PACKAGE_HASH_MISMATCH'): self.seal(observed)
        self.assertFalse((self.adapter.private/'controller-approvals').exists())

    def test_archive_changed_after_observation_is_rejected(self):
        observed = self.observe()
        path = self.adapter.private/'copy-runtime-reviews/fixture-one/archive.tar'
        path.write_bytes(b'changed archive')
        with self.assertRaisesRegex(ReleaseError, 'ARCHIVE_CHANGED'): self.seal(observed)
        self.assertFalse((self.adapter.private/'controller-approvals').exists())

    def test_continuation_preserves_original_edge_approval_and_exact_prior_pointer(self):
        approvals = self.adapter.private/'controller-approvals'; approvals.mkdir(mode=0o700)
        edge = a.immutable(approvals/'original-edge.json', b'{"synthetic":"original"}\n')
        pointer = self.adapter.private/'copy-runtime-migrations.json'
        pointer.write_bytes(b'{ "synthetic" : "old" }\n'); pointer.chmod(0o600)
        self.adapter.facts.update(runtime_stage='OPERATING', consumer_edge_approval_ref=edge,
                                  migrations={str(i): '2'*64 for i in range(67)})
        observed = self.observe()
        self.assertEqual(self.seal(observed)['status'], 'SEALED')
        current = json.loads(pointer.read_bytes())
        self.assertEqual(current['consumer_edge_approval_ref'], edge)
        self.assertFalse((approvals/'copy-runtime-fixture-one-edge.json').exists())
        tools = json.loads(a.native.read_reference(current['backup_tools_manifest_ref']))
        self.assertEqual(tools['runtime_stage'], 'OPERATING')

    def test_prior_pointer_whitespace_drift_is_still_a_cas_conflict(self):
        pointer = self.adapter.private/'copy-runtime-migrations.json'
        pointer.write_bytes(b'{"synthetic":"old"}\n'); pointer.chmod(0o600)
        self.adapter.facts['runtime_stage'] = 'OPERATING'
        observed = self.observe()
        pointer.write_bytes(b'{ "synthetic" : "old" }\n')
        with self.assertRaisesRegex(ReleaseError, 'POINTER_CAS_CONFLICT'): self.seal(observed)

    def test_operating_correction_seals_only_0068_and_preserves_authentic_edge(self):
        self.archive = self.make_archive(count=68)
        approvals = self.adapter.private/'controller-approvals'; approvals.mkdir(mode=0o700)
        edge = a.immutable(approvals/'original-edge.json', b'{"synthetic":"original"}\n')
        self.adapter.facts.update(runtime_stage='OPERATING', consumer_edge_approval_ref=edge,
                                  migrations={str(i): '2'*64 for i in range(67)})
        self.seal(self.observe())
        pointer = json.loads((self.adapter.private/'copy-runtime-migrations.json').read_bytes())
        self.assertEqual(set(pointer['migration_hashes']), runtime.OPERATING_MIGRATION_NAMES)
        self.assertEqual(pointer['consumer_edge_approval_ref'], edge)

    def test_expired_or_future_observation_rejected(self):
        observed = self.observe()
        for delta in [a.MAX_AGE+1, -10]:
            with patch.object(a.time, 'time', return_value=time.time()+delta):
                with self.assertRaisesRegex(ReleaseError, 'OBSERVATION_EXPIRED'): self.seal(observed)
        self.assertFalse((self.adapter.private/'controller-approvals').exists())

    def test_foreign_pointer_is_never_overwritten(self):
        observed = self.observe()
        path = self.adapter.private/'copy-runtime-migrations.json'
        path.write_bytes(b'{"unrelated":true}\n'); path.chmod(0o600)
        with self.assertRaisesRegex(ReleaseError, 'POINTER_CAS_CONFLICT'): self.seal(observed)
        self.assertEqual(path.read_bytes(), b'{"unrelated":true}\n')

    def test_pointer_cas_inode_swap_after_last_read_is_detected(self):
        path = self.adapter.private/'pointer'; path.write_bytes(b'old'); path.chmod(0o600)
        real = a.pointer_bytes; calls = 0
        def swapping(p):
            nonlocal calls
            result = real(p); calls += 1
            if calls == 2:
                replacement = self.adapter.private/'replacement'; replacement.write_bytes(b'old'); replacement.chmod(0o600)
                os.replace(replacement, path)
            return result
        with patch.object(a, 'pointer_bytes', side_effect=swapping):
            with self.assertRaisesRegex(ReleaseError, 'POINTER_CAS_CONFLICT'):
                a.replace_pointer(path, b'old', b'new')
        self.assertEqual(path.read_bytes(), b'old')

    def test_interruption_after_pointer_before_receipt_recovers_only_exact_intent(self):
        observed = self.observe(); real = a.immutable
        def interrupted(path, raw):
            if Path(path).name == 'seal.json': raise KeyboardInterrupt('synthetic after CAS')
            return real(path, raw)
        with patch.object(a, 'immutable', side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt): self.seal(observed)
        pointer = self.adapter.private/'copy-runtime-migrations.json'
        applied = pointer.read_bytes(); inode = pointer.stat().st_ino
        self.assertTrue((self.adapter.private/'copy-runtime-reviews/fixture-one/seal-intent.json').exists())
        self.assertFalse((self.adapter.private/'copy-runtime-reviews/fixture-one/seal.json').exists())
        self.assertEqual(self.seal(observed)['status'], 'SEALED')
        self.assertEqual(pointer.read_bytes(), applied)
        self.assertEqual(pointer.stat().st_ino, inode, 'recovery must not rewrite an already active pointer')

    def test_interrupted_pointer_without_authentic_intent_is_not_adopted(self):
        observed = self.observe(); real = a.immutable
        def interrupted(path, raw):
            if Path(path).name == 'seal.json': raise KeyboardInterrupt()
            return real(path, raw)
        with patch.object(a, 'immutable', side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt): self.seal(observed)
        pending = self.adapter.private/'copy-runtime-reviews/fixture-one/seal-intent.json'
        pending.unlink()
        with self.assertRaisesRegex(ReleaseError, 'POINTER_CAS_CONFLICT'): self.seal(observed)

    def test_interrupted_pointer_with_changed_native_state_is_not_completed(self):
        observed = self.observe(); real = a.immutable
        def interrupted(path, raw):
            if Path(path).name == 'seal.json': raise KeyboardInterrupt()
            return real(path, raw)
        with patch.object(a, 'immutable', side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt): self.seal(observed)
        self.adapter.facts['plan_sha256'] = '9'*64
        with self.assertRaisesRegex(ReleaseError, 'NATIVE_CAS_CHANGED'): self.seal(observed)

    def test_private_symlink_hardlink_and_bad_mode_rejected(self):
        target = self.adapter.private/'target'; target.write_bytes(b'private'); target.chmod(0o600)
        link = self.adapter.private/'link'; link.symlink_to(target)
        with self.assertRaises((OSError, ReleaseError)): a.read_private(link)
        link.unlink(); os.link(target, link)
        with self.assertRaisesRegex(ReleaseError, 'FILE_CUSTODY'): a.read_private(target)
        link.unlink(); target.chmod(0o644)
        with self.assertRaisesRegex(ReleaseError, 'FILE_CUSTODY'): a.read_private(target)

    def test_private_reader_detects_real_path_replacement_during_fd_read(self):
        target = self.adapter.private/'target'; target.write_bytes(b'private'); target.chmod(0o600)
        replacement = self.adapter.private/'replacement'; replacement.write_bytes(b'private'); replacement.chmod(0o600)
        real = os.fdopen
        class SwapOnRead:
            def __init__(self, stream): self.stream = stream
            def __enter__(self): return self
            def __exit__(self, *args): self.stream.close()
            def fileno(self): return self.stream.fileno()
            def read(self, size):
                raw = self.stream.read(size); os.replace(replacement, target); return raw
        with patch.object(a.os, 'fdopen', side_effect=lambda fd, mode: SwapOnRead(real(fd, mode))):
            with self.assertRaisesRegex(ReleaseError, 'PATH_CHANGED'): a.read_private(target)

    def test_archive_copy_detects_real_source_replacement_during_fd_read(self):
        replacement = self.base/'replacement.tar'; replacement.write_bytes(self.archive.read_bytes()); replacement.chmod(0o600)
        real = os.fdopen; swapped = False
        class SwapOnRead:
            def __init__(self, stream): self.stream = stream
            def __enter__(self): return self
            def __exit__(self, *args): self.stream.close()
            def fileno(self): return self.stream.fileno()
            def read(self, size):
                nonlocal swapped
                raw = self.stream.read(size)
                if not swapped: os.replace(replacement, self_archive); swapped = True
                return raw
        self_archive = self.archive
        with patch.object(a.os, 'fdopen', side_effect=lambda fd, mode: SwapOnRead(real(fd, mode)) if mode == 'rb' else real(fd, mode)):
            with self.assertRaisesRegex(ReleaseError, 'ARCHIVE_CHANGED'): self.observe()
        self.assertEqual(self.adapter.calls, 0)

    def test_reader_rejects_a_symlink_in_ancestor_path(self):
        directory = self.adapter.private/'actual'; directory.mkdir(mode=0o700)
        target = directory/'value'; target.write_bytes(b'private'); target.chmod(0o600)
        link = self.adapter.private/'alias'; link.symlink_to(directory, target_is_directory=True)
        with self.assertRaisesRegex(ReleaseError, 'DIRECTORY_CUSTODY'): a.read_private(link/'value')

    def test_directory_creation_checks_ancestors_before_mutating(self):
        directory = self.adapter.private/'actual'; directory.mkdir(mode=0o700)
        link = self.adapter.private/'alias'; link.symlink_to(directory, target_is_directory=True)
        with self.assertRaisesRegex(ReleaseError, 'DIRECTORY_CUSTODY'):
            a.private_directory(link/'unexpected', create=True)
        self.assertFalse((directory/'unexpected').exists())

    def test_immutable_writes_replay_only_identical_bytes(self):
        path = self.adapter.private/'immutable'
        first = a.immutable(path, b'one')
        self.assertEqual(a.immutable(path, b'one'), first)
        with self.assertRaisesRegex(ReleaseError, 'IMMUTABLE_CONFLICT'): a.immutable(path, b'two')
        self.assertEqual(path.read_bytes(), b'one')

    def test_native_loaded_reader_custody_and_byte_identity(self):
        readers = self.base/'reader-source'; readers.mkdir(mode=0o700)
        package = self.base/'source'
        for name in a.READERS:
            path = readers/name; path.write_bytes((package/'scripts'/name).read_bytes()); path.chmod(0o644)
        adapter = object.__new__(a.Native)
        with patch.object(a, '__file__', str(readers/'copy_runtime_approvals.py')):
            adapter.package_readers(package)
            (readers/'ci_release.py').write_bytes(b'changed reader')
            with self.assertRaisesRegex(ReleaseError, 'LOADED_READER_MISMATCH'): adapter.package_readers(package)

    def test_stdout_never_contains_owner_or_profile_bodies(self):
        self.adapter.facts['owner'] = {'ids': ['PRIVATE_OWNER_SENTINEL']}
        self.adapter.facts['policy'] = {'private': 'PRIVATE_POLICY_SENTINEL'}
        result = json.dumps(self.observe())
        self.assertNotIn('PRIVATE_', result)


class NativeReadTests(unittest.TestCase):
    def test_native_adapter_uses_complete_preflight_and_initial_database_barriers(self):
        with tempfile.TemporaryDirectory(prefix='root-reader-synthetic-') as tmp:
            base = Path(tmp); current = base/'old'; current.mkdir(); (base/'current').symlink_to(current)
            adapter = object.__new__(a.Native); adapter.base = base; adapter.private = base/'private'
            _, rows, _ = fixture(); rows = rows[:5]
            networks = [network()]; calls = []
            def command(args, root):
                calls.append(args)
                if args[:3] == ['docker', 'network', 'ls']: return networks[0]['Id']
                if args[:3] == ['docker', 'network', 'inspect']: return json.dumps(networks)
                if args[:2] == ['ip', '-j']: return '[{"dst":"default","gateway":"10.0.0.1"}]'
                if args[:2] == ['docker', 'ps']: return ' '.join(row['Id'] for row in rows)
                if args[:2] == ['docker', 'inspect']: return json.dumps(rows)
                raise AssertionError(args)
            applied = {str(i): 'a'*64 for i in range(65)}
            adapter.server = types.SimpleNamespace(command=command, migrations=lambda root: applied,
                                                    database=lambda root, sql: None)
            before = {'state': {'schema_version': 2, 'preserved_runtime': {row['Id']: 'a'*64 for row in rows}},
                      'state_raw': b'synthetic-state', 'plan_raw': b'synthetic-plan', 'files': {'api.env': b'synthetic'},
                      'policy': {'version': 93}, 'owner': {'fixture': True}, 'services': {str(i): row for i, row in enumerate(rows)}}
            with patch.object(runtime, 'snapshot', return_value=before) as snapshot, \
                    patch.object(a.native, 'database_guard', return_value=True) as guard:
                expected = applied | {name: 'b'*64 for name in runtime.MIGRATION_NAMES}
                result = adapter.observe_native(base/'package', {'source_sha': SHA, 'migration_hashes': expected},
                                                base/'releases'/('ci-'+RUN+'-'+SHA[:12]))
            guard.assert_called_once_with(adapter.server.database, current.resolve())
            self.assertEqual(snapshot.call_args.args[3], adapter.private/'deployments'/RUN)
            self.assertEqual(result['runtime_stage'], 'CORE_PREPARED')
            self.assertIn(['ip', '-j', '-4', 'route', 'show', 'table', 'main'], calls)
            self.assertEqual(len(calls), 5)

    def test_four_locks_acquired_and_released_in_reverse_order_on_failure(self):
        adapter = object.__new__(a.Native); adapter.private = Path('/synthetic')
        events = []
        locks = [types.SimpleNamespace(close=lambda name=name: events.append(name)) for name in a.native.LOCKS]
        with patch.object(a.native, 'acquire_locks', return_value=locks) as acquire:
            with self.assertRaises(RuntimeError):
                with adapter.locked(): raise RuntimeError('synthetic')
        acquire.assert_called_once_with(adapter.private)
        self.assertEqual(events, list(reversed(a.native.LOCKS)))

    def test_complete_edge_preflight_reads_routes_all_networks_and_all_containers(self):
        _, rows, _ = fixture(); rows = rows[:5]
        networks = [network()]; routes = [{'dst': 'default', 'gateway': '10.0.0.1'}, {'dst': '10.0.0.0/24'}]
        calls = []
        def command(args, root):
            calls.append(args)
            if args[:3] == ['docker', 'network', 'ls']: return networks[0]['Id']
            if args[:3] == ['docker', 'network', 'inspect']: return json.dumps(networks)
            if args[:2] == ['ip', '-j']: return json.dumps(routes)
            if args[:2] == ['docker', 'ps']: return ' '.join(row['Id'] for row in rows)
            if args[:2] == ['docker', 'inspect']: return json.dumps(rows)
            raise AssertionError(args)
        actual = runtime.edge_preflight(command, Path('/synthetic'))
        self.assertEqual(actual['container_ids'], {row['Id'] for row in rows})
        self.assertIn(['ip', '-j', '-4', 'route', 'show', 'table', 'main'], calls)
        self.assertEqual(set(actual['hashes']), {'networks_sha256', 'routes_sha256', 'containers_sha256'})
        routes.append({'dst': '172.30.80.0/24'})
        changed = runtime.edge_preflight(command, Path('/synthetic'))
        self.assertNotEqual(actual['hashes']['routes_sha256'], changed['hashes']['routes_sha256'])
        with self.assertRaisesRegex(ReleaseError, 'HOST_ROUTE_OVERLAP'):
            runtime.edge_no_overlap(runtime.edge_definition(SHA), changed)

    def test_native_cli_requires_linux_root(self):
        with patch.object(a.os, 'geteuid', return_value=12345):
            with self.assertRaisesRegex(ReleaseError, 'LINUX_ROOT_REQUIRED'): a.Native()

    def test_bounded_command_stdin_and_output_bound(self):
        actual = a.bounded_command([sys.executable, '-c', 'import sys; print(sys.stdin.read())'], Path.cwd(), 'synthetic')
        self.assertEqual(actual, 'synthetic')
        with patch.object(a, 'MAX_COMMAND_BYTES', 1024):
            with self.assertRaisesRegex(ReleaseError, 'OUTPUT_BOUND'):
                a.bounded_command([sys.executable, '-c', 'print("a"*4096)'], Path.cwd())

    def test_packager_includes_both_approval_scripts_without_new_allowlist(self):
        spec = importlib.util.spec_from_file_location('approvals_package_ci', SCRIPTS/'package-ci.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        self.assertTrue(module.release_source('scripts/copy_runtime_approvals.py'))
        self.assertTrue(module.release_source('scripts/copy-runtime-approvals.py'))


if __name__ == '__main__': unittest.main()
