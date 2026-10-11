import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
import stat
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import b02_backup_contract as contract


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


remote = load('b02_remote', 'b02-backup-root.py')
client = load('b02_client', 'b02-backup-ci.py')
selection = load('b02_selection', 'ci-changes.py')


def env():
    return {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'B02_MODE': 'backup',
        'GITHUB_REPOSITORY': contract.REPOSITORY, 'GITHUB_REF': 'refs/heads/main',
        'GITHUB_WORKFLOW_REF': contract.WORKFLOW, 'GITHUB_SHA': 'a' * 40,
        'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'B02_BACKUP_ENABLED': 'true',
        'GCP_PROJECT_ID': contract.TARGET[0], 'GCP_INSTANCE': contract.TARGET[1], 'GCP_ZONE': contract.TARGET[2],
        'B02_TRANSPORT_JSON': json.dumps({'bucket': 'commerce-own-backups', 'plan_sha256': 'b' * 64,
            'controller_sha256': 'c' * 64, 'contract_sha256': 'd' * 64})}


def bucket_metadata():
    return {'name': 'commerce-own-backups', 'projectNumber': contract.PROJECT_NUMBER,
        'location': 'US-EAST1', 'storageClass': 'STANDARD',
        'iamConfiguration': {'publicAccessPrevention': 'enforced', 'uniformBucketLevelAccess': {'enabled': True}},
        'lifecycle': {'rule': [{'action': {'type': 'Delete'}, 'condition': {'age': 30}}]},
        'softDeletePolicy': {'retentionDurationSeconds': '604800'}}


class BackupContractTests(unittest.TestCase):
    def test_bucket_identity_privacy_and_retention_drift_are_rejected(self):
        good = bucket_metadata()
        self.assertTrue(contract.validate_bucket(good, good['name'])['configuration_verified'])
        contract.validate_bucket(good | {'versioning': {'enabled': False}, 'autoclass': {'enabled': False}}, good['name'])
        for patch in ({'name': 'other'}, {'projectNumber': '123'}, {'location': 'US'}, {'storageClass': 'NEARLINE'},
            {'iamConfiguration': {'publicAccessPrevention': 'inherited', 'uniformBucketLevelAccess': {'enabled': True}}},
            {'iamConfiguration': {'publicAccessPrevention': 'enforced', 'uniformBucketLevelAccess': {'enabled': False}}},
            {'lifecycle': {'rule': [{'action': {'type': 'Delete'}, 'condition': {'age': 31}}]}},
            {'lifecycle': {'rule': [{'action': {'type': 'Delete'}, 'condition': {'age': 30, 'matchesPrefix': ['limited/']}}]}},
            {'softDeletePolicy': {'retentionDurationSeconds': '0'}}, {'versioning': {'enabled': True}},
            {'autoclass': {'enabled': True}}, {'autoclass': None}):
            with self.subTest(patch=patch), self.assertRaisesRegex(RuntimeError, 'B02_BUCKET_'):
                contract.validate_bucket(good | patch, good['name'])

    def test_wrong_trigger_identity_or_target_never_enters_transport(self):
        self.assertEqual(contract.transport_config(env())['run_id'], '123-1')
        for key, value in [('GITHUB_EVENT_NAME', 'push'), ('B02_MODE', 'release'),
            ('GITHUB_REPOSITORY', 'other/commerce-os'), ('GITHUB_REF', 'refs/heads/feature'),
            ('GITHUB_WORKFLOW_REF', 'other.yml'), ('GCP_PROJECT_ID', 'vibe-conversa-prod'),
            ('GCP_INSTANCE', 'commerce-os-test;echo unsafe'), ('B02_BACKUP_ENABLED', ''),
            ('GITHUB_RUN_ID', '123;true'), ('GITHUB_SHA', 'not-a-sha')]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                contract.transport_config(env() | {key: value})

    def test_schedule_requires_separate_enable_and_backup_gate(self):
        values = env() | {'GITHUB_EVENT_NAME': 'schedule'}
        with self.assertRaisesRegex(RuntimeError, 'SCHEDULE_NOT_ENABLED'):
            contract.transport_config(values)
        self.assertTrue(contract.transport_config(values | {'B02_SCHEDULE_ENABLED': 'true'})['scheduled'])

    def test_duplicate_json_and_bucket_injection_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'DUPLICATE'):
            contract.unique_json('{"bucket":1,"bucket":2}')
        data = json.loads(env()['B02_TRANSPORT_JSON']); data['bucket'] = 'own-bucket/other;false'
        with self.assertRaisesRegex(RuntimeError, 'BUCKET_REQUIRED'):
            contract.transport_config(env() | {'B02_TRANSPORT_JSON': json.dumps(data)})

    def test_rolling_run_limit_counts_failed_and_pending_attempts(self):
        now = dt.datetime(2026, 10, 7, tzinfo=dt.timezone.utc)
        statuses = ('FAILED', 'SUCCEEDED', 'RUNNING', 'FAILED_RECONCILED')
        entries = [{'started_at': (now - dt.timedelta(days=1)).isoformat(),
                    'status': statuses[i % len(statuses)]} for i in range(37)]
        contract.check_run_budget(entries[:36], now)
        with self.assertRaisesRegex(RuntimeError, '30_DAY_RUN_LIMIT'):
            contract.check_run_budget(entries, now)
        cutoff = now - dt.timedelta(days=30)
        entries[-1]['started_at'] = cutoff.isoformat()
        with self.assertRaisesRegex(RuntimeError, '30_DAY_RUN_LIMIT'):
            contract.check_run_budget(entries, now)
        entries[-1]['started_at'] = (cutoff - dt.timedelta(microseconds=1)).isoformat()
        contract.check_run_budget(entries, now)
        contract.check_run_budget([{'started_at': (now - dt.timedelta(days=31)).isoformat()}] * 37, now)
        for invalid in ((now + dt.timedelta(seconds=1)).isoformat(), now.replace(tzinfo=None).isoformat()):
            with self.subTest(started_at=invalid), self.assertRaisesRegex(RuntimeError, 'LEDGER_TIME_INVALID'):
                contract.check_run_budget([{'started_at': invalid}], now)

    def test_custody_requires_exact_generation_and_independent_full_download(self):
        report = {'run_id': '123-1', 'plan_sha256': 'b' * 64,
            'exports': {name: {'bytes': 123, 'sha256': 'c' * 64} for name in ('ciphertext.backup.aes', 'source.json', 'backup.json')}}
        objects = {name: ref | {'object': 'b02/daily/123-1/' + name, 'generation': '9', 'full_download_verified': True}
            for name, ref in report['exports'].items()}
        value = {'status': 'B02_OFFHOST_CUSTODY_VERIFIED', 'run_id': '123-1', 'plan_sha256': 'b' * 64,
            'bucket': 'commerce-own-backups', 'objects': objects, 'keys_exported': False, 'plaintext_exported': False}
        contract.validate_custody(value, report, value['bucket'])
        for patch in ({'generation': '0'}, {'sha256': 'd' * 64}, {'full_download_verified': False}, {'object': 'b02/daily/other/cipher'}):
            corrupt = json.loads(json.dumps(value)); corrupt['objects']['ciphertext.backup.aes'].update(patch)
            with self.subTest(patch=patch), self.assertRaisesRegex(RuntimeError, 'DOWNLOAD_REQUIRED'):
                contract.validate_custody(corrupt, report, value['bucket'])


class BackupTransportTests(unittest.TestCase):
    def test_bucket_drift_stops_before_ssh_key_dispatch_or_upload(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = contract.transport_config(env())
            for name, key in (('b02-backup-root.py', 'controller_sha256'), ('b02_backup_contract.py', 'contract_sha256')):
                config[key] = contract.sha256((ROOT / 'scripts' / name).read_bytes())
            calls = []
            def runner(args, **kwargs):
                calls.append(args)
                if args[:4] == ['gcloud', 'compute', 'instances', 'describe']:
                    return subprocess.CompletedProcess(args, 0, json.dumps({'id': contract.VM_ID,
                        'name': contract.TARGET[1], 'status': 'RUNNING', 'zone': 'https://www.googleapis.com/compute/v1/projects/'
                        + contract.TARGET[0] + '/zones/' + contract.TARGET[2]}), '')
                self.assertEqual(args[:4], ['gcloud', 'storage', 'buckets', 'describe'])
                self.assertIn('--raw', args)
                return subprocess.CompletedProcess(args, 0, json.dumps(bucket_metadata() | {'location': 'EU'}), '')
            with mock.patch.object(client, 'transport_config', return_value=config), mock.patch.object(client, 'main_head'), \
                 mock.patch.object(client, 'command', side_effect=runner), mock.patch.dict(os.environ, {'RUNNER_TEMP': temporary}), \
                 mock.patch.object(sys, 'argv', ['b02-backup-ci.py']):
                with self.assertRaisesRegex(RuntimeError, 'BUCKET_IDENTITY_DRIFT'):
                    client.main()
            self.assertEqual(len(calls), 2)
            self.assertEqual(sum(args[:4] == ['gcloud', 'storage', 'buckets', 'describe'] for args in calls), 1)

    def test_instance_numeric_identity_is_required_not_only_display_name(self):
        value = {'id': contract.VM_ID, 'name': contract.TARGET[1], 'status': 'RUNNING',
            'zone': 'https://www.googleapis.com/compute/v1/projects/' + contract.TARGET[0] + '/zones/' + contract.TARGET[2]}
        client.verify_instance(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError, 'INSTANCE_IDENTITY_MISMATCH'):
            client.verify_instance(json.dumps(value | {'id': '123'}))

    def test_unit_absence_or_zero_pid_alone_never_proves_terminal(self):
        self.assertEqual(client.unit_state('MainPID=0\nActiveState=inactive\n'), 'UNKNOWN')
        self.assertEqual(client.unit_state('LoadState=not-found\nMainPID=0\nActiveState=inactive\n'), 'TERMINAL')
        self.assertEqual(client.unit_state('LoadState=loaded\nMainPID=44\nActiveState=failed\n'), 'RUNNING')
        self.assertEqual(client.unit_state('LoadState=loaded\nMainPID=0\nActiveState=inactive\n', 1), 'UNKNOWN')

    def test_create_precondition_then_generation_readback_even_after_unknown_create(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary); source = folder / 'ciphertext.backup.aes'
            source.write_bytes(b'COMOSB02' + b'x' * 64); source.chmod(0o600)
            calls = []
            def runner(args, **kwargs):
                calls.append(args)
                if '--if-generation-match=0' in args:
                    raise RuntimeError('B02_TRANSPORT_UNKNOWN_PRESERVE')
                if 'describe' in args:
                    return subprocess.CompletedProcess(args, 0, json.dumps({'generation': '17', 'size': source.stat().st_size}), '')
                Path(args[-2]).write_bytes(source.read_bytes()); Path(args[-2]).chmod(0o600)
                return subprocess.CompletedProcess(args, 0, '', '')
            result = client.upload_verified(source, 'gs://own-bucket/b02/daily/123-1/ciphertext.backup.aes', folder / 'readback', runner)
            self.assertTrue(result['full_download_verified']); self.assertFalse(result['create_command_succeeded'])
            self.assertEqual(sum('--if-generation-match=0' in args for args in calls), 1)
            self.assertIn('gs://own-bucket/b02/daily/123-1/ciphertext.backup.aes#17', calls[-1])

    def test_metadata_hash_and_size_cannot_substitute_for_full_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary); source = folder / 'source.json'
            source.write_bytes(b'{"proof":1}'); source.chmod(0o600)
            def runner(args, **kwargs):
                if 'describe' in args:
                    return subprocess.CompletedProcess(args, 0, json.dumps({'generation': '17', 'size': source.stat().st_size}), '')
                if '--if-generation-match=0' not in args:
                    Path(args[-2]).write_bytes(b'{"proof":0}'); Path(args[-2]).chmod(0o600)
                return subprocess.CompletedProcess(args, 0, '', '')
            with self.assertRaisesRegex(RuntimeError, 'FULL_OBJECT_HASH_MISMATCH'):
                client.upload_verified(source, 'gs://own-bucket/object', folder / 'readback', runner)

    def test_symlink_export_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'source'; source.write_bytes(b'abc'); source.chmod(0o600)
            link = Path(temporary) / 'link'; link.symlink_to(source)
            with self.assertRaises(OSError):
                client.local_reference(link)


class BackupControllerTests(unittest.TestCase):
    def test_sql_forwards_queries_through_docker_stdin_for_number_and_json_results(self):
        responses = {
            'BEGIN READ ONLY; SELECT pg_database_size(current_database()); ROLLBACK;': '4096',
            "BEGIN READ ONLY; SELECT json_build_object('transaction_read_only', current_setting('transaction_read_only')); ROLLBACK;":
                '{"transaction_read_only":"on"}',
        }
        # Model Docker's stdin attachment at the process boundary, without Docker or a database.
        docker_stdin = (
            'import json, sys\n'
            'responses = json.loads(sys.argv[1])\n'
            'args = sys.argv[2:]\n'
            "assert args[0] == 'exec' and 'psql' in args\n"
            "query = sys.stdin.read() if '-i' in args[1:args.index('psql')] else ''\n"
            'if query:\n'
            '    print(responses[query])\n'
        )
        runner = remote.BackupRunner.__new__(remote.BackupRunner)
        runner.plan = {'postgres': {'container_id': 'a' * 64, 'user': 'commerce_owner', 'database': 'commerce'}}
        runner.docker = [sys.executable, '-c', docker_stdin, json.dumps(responses)]
        results = []
        for query, expected in responses.items():
            with self.subTest(result=expected), mock.patch.object(runner, 'command', wraps=runner.command) as command:
                actual = runner.sql('123-1', query)
                args = command.call_args.args[0]
                legacy = runner.command([arg for arg in args if arg != '-i'], input=query)
            self.assertEqual(legacy, '')
            self.assertEqual(actual, expected)
            results.append(actual)
        self.assertEqual(int(results[0]), 4096)
        self.assertEqual(contract.unique_json(results[1]), {'transaction_read_only': 'on'})

    def test_storage_path_is_bound_to_authenticated_promotion_applied_plan_and_foundation(self):
        ref = lambda name: {'path': '/private/' + name, 'bytes': 12, 'sha256': 'a' * 64}
        plan = {'promotion_ref': ref('promotion'), 'applied_plan_ref': ref('applied'), 'foundation_ref': ref('foundation'),
            'source_sha': 'b' * 40, 'maintenance_image': 'sha256:' + 'c' * 64, 'storage_path': '/private/storage'}
        applied = {'foundation_receipt': {key: plan['foundation_ref'][key] for key in ('path', 'sha256')},
            'source_sha': plan['source_sha'], 'maintenance_image': plan['maintenance_image'],
            'planned_private_storage_dir': plan['storage_path']}
        promotion = {'admin_plan': plan['applied_plan_ref'], 'storage': plan['storage_path']}
        def check(promotion_value, applied_value):
            values = {plan['promotion_ref']['path']: promotion_value, plan['applied_plan_ref']['path']: applied_value}
            with mock.patch.object(remote, 'ref_read', side_effect=lambda value: json.dumps(values[value['path']]).encode()) as reader:
                result = remote.source_storage(plan)
                self.assertEqual([call.kwargs for call in reader.call_args_list], [{}, {}])
                return result
        self.assertEqual(check(promotion, applied), Path(plan['storage_path']))
        for changed_promotion, changed_applied in ((promotion | {'admin_plan': ref('other')}, applied),
            (promotion | {'storage': '/private/other'}, applied), (promotion, applied | {'planned_private_storage_dir': '/private/other'}),
            (promotion, applied | {'source_sha': 'd' * 40}), (promotion, applied | {'maintenance_image': 'sha256:' + 'd' * 64}),
            (promotion, applied | {'foundation_receipt': {'path': '/private/other', 'sha256': 'a' * 64}}),
            (promotion, applied | {'foundation_receipt': {'path': plan['foundation_ref']['path'], 'sha256': 'd' * 64}})):
            with self.subTest(promotion=changed_promotion, applied=changed_applied), self.assertRaisesRegex(RuntimeError, 'BINDING_INVALID'):
                check(changed_promotion, changed_applied)

    def test_storage_uid1000_is_scoped_to_physical_private_directories_with_mode700(self):
        with tempfile.TemporaryDirectory() as temporary:
            private = Path(temporary).resolve(); storage = private / 'storage'; storage.mkdir(mode=0o700)
            assets = storage / 'assets'; assets.mkdir(mode=0o700)
            actual_lstat = Path.lstat
            fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_uid', 'st_mode', 'st_nlink')
            for patch, permitted in (({}, True), ({'st_uid': 0}, False), ({'st_uid': 2000}, False),
                ({'st_mode': stat.S_IFDIR | 0o750}, False), ({'st_mode': stat.S_IFLNK | 0o700}, False)):
                def info(path):
                    real = actual_lstat(path)
                    return SimpleNamespace(**({key: getattr(real, key) for key in fields} | {'st_uid': 1000} | patch))
                with self.subTest(patch=patch), mock.patch.object(remote, 'PRIVATE', private), \
                     mock.patch.object(remote, 'protected_parents') as parents, mock.patch.object(Path, 'lstat', info):
                    if permitted:
                        remote.storage_custody(storage)
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'DIRECTORY_CUSTODY_INVALID'):
                            remote.storage_custody(storage)
                    parents.assert_called_once_with(assets / 'unused', uid=1000)
            link = private / 'alias'; link.symlink_to(storage, target_is_directory=True)
            with mock.patch.object(remote, 'PRIVATE', private), mock.patch.object(remote, 'protected_parents') as parents:
                with self.assertRaisesRegex(RuntimeError, 'STORAGE_SCOPE_INVALID'):
                    remote.storage_custody(link)
                with self.assertRaisesRegex(RuntimeError, 'STORAGE_SCOPE_INVALID'):
                    remote.storage_custody(private.parent / 'outside')
                parents.assert_not_called()

    def test_original_minimum_uses_only_approved_uid2000_reference(self):
        raw = ('BACKUP_ENCRYPTION_KEY=' + '1' * 64 + '\n').encode()
        ref = {'path': str(contract.ORIGINAL_MINIMUM), 'bytes': 87, 'sha256': contract.sha256(raw)}
        with mock.patch.object(remote, 'read_file', return_value=raw) as reader:
            self.assertEqual(remote.original_minimum_read(ref), raw)
            reader.assert_called_once_with(ref['path'], private=True, uid=2000)
            reader.reset_mock()
            remote.ref_read(ref)
            reader.assert_called_once_with(ref['path'], private=True, uid=0)
            reader.reset_mock()
            for wrong in (ref | {'path': '/private/other.env'}, ref | {'bytes': 88}):
                with self.assertRaisesRegex(RuntimeError, 'ORIGINAL_MINIMUM_SCOPE_INVALID'):
                    remote.original_minimum_read(wrong)
            reader.assert_not_called()

    def test_uid2000_private_reader_requires_matching_fd_path_mode_and_link_count(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / 'synthetic.env'; file.write_bytes(b'synthetic'); file.chmod(0o600)
            original = file.stat()
            fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_uid', 'st_mode', 'st_nlink')
            metadata = {key: getattr(original, key) for key in fields} | {'st_uid': 2000}
            for patch, permitted in (({}, True), ({'st_uid': 0}, False), ({'st_nlink': 2}, False),
                ({'st_mode': stat.S_IFREG | 0o644}, False)):
                info = SimpleNamespace(**(metadata | patch))
                with self.subTest(patch=patch), mock.patch.object(remote, 'protected_parents') as parents, \
                     mock.patch.object(remote.os, 'fstat', return_value=info), mock.patch.object(Path, 'lstat', return_value=info):
                    if permitted:
                        self.assertEqual(remote.read_file(file, uid=2000), b'synthetic')
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'FILE_CUSTODY_INVALID'):
                            remote.read_file(file, uid=2000)
                    parents.assert_called_once_with(file, 2000)

    def test_status_reads_running_failed_and_unknown_without_reporting_operation_failure(self):
        for status in ('RUNNING', 'FAILED', 'CLEANUP_UNKNOWN', 'LOCAL_CUSTODY_PENDING', 'SUCCEEDED'):
            output = io.StringIO()
            with self.subTest(status=status), mock.patch.object(remote, 'BackupRunner') as factory, \
                 mock.patch.object(remote.os, 'geteuid', return_value=0), mock.patch.object(remote.sys, 'platform', 'linux'), \
                 mock.patch.object(remote.sys, 'argv', ['b02-root', 'status', '--plan-sha256', 'b' * 64, '--run-id', '123-1']), \
                 mock.patch.object(remote.signal, 'signal'), contextlib.redirect_stdout(output):
                factory.return_value.report.return_value = {'run_id': '123-1', 'status': status}
                remote.main()
            self.assertEqual(json.loads(output.getvalue()), {'run_id': '123-1', 'status': status})

    def test_caller_home_parent_is_valid_only_for_that_custody_uid(self):
        caller = 1234; home = Path('/home/backup-user')
        def info(path):
            return SimpleNamespace(st_mode=stat.S_IFDIR | 0o750, st_uid=caller if path == home else 0)
        with mock.patch.object(Path, 'lstat', autospec=True, side_effect=info):
            with self.assertRaisesRegex(RuntimeError, 'PARENT_CUSTODY_INVALID'):
                remote.protected_parents(home / 'export' / 'ciphertext')
            remote.protected_parents(home / 'export' / 'ciphertext', uid=caller)

    def test_export_changes_file_owner_before_verifying_caller_custody(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary); sources = folder / 'sources'; sources.mkdir(); home = folder / 'home'; home.mkdir()
            uid = os.geteuid(); events = []
            exports = {}
            for name in ('ciphertext.backup.aes', 'source.json', 'backup.json'):
                path = sources / name; path.write_bytes(b'COMOSB02' + b'x' * 64 if name.endswith('.aes') else b'{"public":true}'); path.chmod(0o600)
                exports[name] = {'path': str(path)} | client.local_reference(path, ciphertext=name.endswith('.aes'))
            report = {'run_id': '123-1', 'status': 'LOCAL_CUSTODY_PENDING', 'exports': exports}
            runner = remote.BackupRunner.__new__(remote.BackupRunner); runner.report = mock.Mock(return_value=report)
            runner.export_path = mock.Mock(return_value=(home / 'commerce-b02-123-1', uid))
            def chown(path, owner, group):
                events.append(('chown', Path(path), owner))
            def ref(path, **kwargs):
                path = Path(path)
                if path.parent != sources:
                    self.assertEqual(kwargs.get('uid'), uid)
                    self.assertIn(('chown', path, uid), events)
                return {'path': str(path)} | client.local_reference(path, ciphertext=kwargs.get('ciphertext', False))
            account_database = SimpleNamespace(getpwuid=mock.Mock(return_value=SimpleNamespace(pw_gid=os.getegid())))
            with mock.patch.object(remote, 'file_reference', side_effect=ref), mock.patch.object(remote.os, 'chown', side_effect=chown), \
                 mock.patch.object(remote, 'pwd', account_database):
                self.assertEqual(runner.export('123-1'), report)
            self.assertEqual({path.name for path in (home / 'commerce-b02-123-1').iterdir()}, set(exports))

    def test_prepared_entrypoint_has_no_private_or_cloud_work(self):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/b02-backup-root.py')], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {'status': 'PREPARED_ONLY', 'Cloud_calls': 0, 'private_inputs_read': False, 'backup_created': False})

    def fake_runner(self, folder, entries):
        runner = remote.BackupRunner.__new__(remote.BackupRunner)
        runner.runs = Path(folder); runner.plan_sha256 = 'b' * 64; runner.plan = {'schedule_enabled': True}
        for entry in entries:
            (runner.runs / entry['run_id']).mkdir()
        runner.report = mock.Mock(side_effect=lambda run_id: next(item for item in entries if item['run_id'] == run_id))
        runner.runtime_guard = mock.Mock(); runner.command = mock.Mock(); runner.sql = mock.Mock()
        return runner

    def test_existing_same_run_is_returned_without_spawning_again(self):
        for status in ('RUNNING', 'CLEANUP_UNKNOWN', 'LOCAL_CUSTODY_PENDING', 'SUCCEEDED', 'FAILED'):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temporary, \
                 mock.patch.object(remote, 'lock', side_effect=lambda _: contextlib.nullcontext()):
                entry = {'run_id': '123-1', 'source_sha': 'a' * 40, 'plan_sha256': 'b' * 64, 'status': status}
                runner = self.fake_runner(temporary, [entry])
                self.assertEqual(runner.execute('123-1', 'a' * 40), entry)
                runner.runtime_guard.assert_not_called(); runner.command.assert_not_called(); runner.sql.assert_not_called()

    def test_unknown_or_pending_previous_run_prevents_new_backup_before_effects(self):
        for status in ('RUNNING', 'CLEANUP_UNKNOWN', 'LOCAL_CUSTODY_PENDING'):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temporary, \
                 mock.patch.object(remote, 'lock', side_effect=lambda _: contextlib.nullcontext()):
                runner = self.fake_runner(temporary, [{'run_id': '122-1', 'status': status}])
                with self.assertRaisesRegex(RuntimeError, 'PREVIOUS_TASK_REQUIRES_RECONCILIATION'):
                    runner.execute('123-1', 'a' * 40)
                runner.runtime_guard.assert_not_called(); runner.command.assert_not_called(); runner.sql.assert_not_called()
                self.assertFalse((Path(temporary) / '123-1').exists())

    def test_schedule_requires_prior_actual_custody_before_any_source_probe(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(remote, 'lock', side_effect=lambda _: contextlib.nullcontext()):
            runner = self.fake_runner(temporary, [])
            with self.assertRaisesRegex(RuntimeError, 'FIRST_CUSTODY_REQUIRED'):
                runner.execute('123-1', 'a' * 40, scheduled=True)
            runner.runtime_guard.assert_not_called(); runner.command.assert_not_called()

    def test_cleanup_cannot_target_a_preserved_runtime_container(self):
        runner = remote.BackupRunner.__new__(remote.BackupRunner)
        runner.plan = {'preserved_runtime': {'a' * 64: 'c' * 64}}
        runner.command = mock.Mock(return_value='a' * 64); runner.inspect = mock.Mock(); runner.save = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, 'CLEANUP_TARGET_INVALID'):
            runner.cleanup({'run_id': '123-1'})
        runner.inspect.assert_not_called(); runner.save.assert_not_called()

    def test_projection_detects_restart_and_configuration_drift(self):
        value = {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64, 'Config': {'Env': ['SECRET=private']},
            'HostConfig': {}, 'Mounts': [], 'NetworkSettings': {},
            'State': {'Running': True, 'Paused': False, 'Restarting': False, 'Pid': 42, 'StartedAt': 'original'}}
        before = contract.projection_digest(value)
        changed = json.loads(json.dumps(value)); changed['State']['Pid'] = 43
        self.assertNotEqual(before, contract.projection_digest(changed))
        self.assertNotIn('private', json.dumps({'projection_sha256': before}))

    def test_complete_mocked_controller_uses_canonical_scripts_and_exports_no_key(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(remote, 'lock', side_effect=lambda _: contextlib.nullcontext()):
            base = Path(temporary); runs = base / 'runs'; runs.mkdir(); storage = base / 'storage'; (storage / 'assets').mkdir(parents=True)
            runner = self.fake_runner(runs, [])
            pins = {name: {'bytes': 12, 'sha256': 'd' * 64} for name in contract.SOURCE_FILES}
            runner.plan = {'schedule_enabled': False, 'source_sha': 'c' * 40, 'maintenance_image': 'sha256:' + 'd' * 64,
                'storage_path': str(storage), 'canonical_sources': pins, 'admin_env_ref': 'admin',
                'restore_env_ref': 'restore', 'original_minimum_ref': {'path': str(contract.ORIGINAL_MINIMUM),
                    'bytes': 87, 'sha256': contract.sha256(('BACKUP_ENCRYPTION_KEY=' + '1' * 64 + '\n').encode())},
                'postgres': {'container_id': 'a' * 64, 'network': 'commerce-os_core'}}
            runner.docker = ['/usr/bin/docker', '--config', '/private-empty', '--host', 'unix:///var/run/docker.sock']
            runner.sql.return_value = '1000'
            runner.command.return_value = json.dumps({name: [ref['bytes'], ref['sha256']] for name, ref in pins.items()})
            minimum = ('BACKUP_ENCRYPTION_KEY=' + '1' * 64 + '\n').encode()
            profiles = {str(contract.ORIGINAL_MINIMUM): minimum, 'restore': minimum,
                'admin': b'DATABASE_URL=postgresql://commerce_owner:synthetic@postgres:5432/commerce\nDISPATCH_FROZEN=true\n'}
            invocations = []
            def backup(args, log, **kwargs):
                invocations.append(args)
                directory = log.parent; (directory / 'backups').mkdir()
                artifact = directory / 'backups' / 'commerce-2026-10-07T00-00-00.000Z.backup.aes'
                artifact.write_bytes(b'COMOSB02' + b'x' * 64); artifact.chmod(0o600)
                log.write_text(json.dumps({'backup': str(artifact), 'encrypted': True, 'format': 2,
                    'snapshot_consistent': True, 'private_assets': 0, 'external_copy_verified': False})); log.chmod(0o600)
                return 0
            def reference(path, **kwargs):
                return {'path': str(path)} | client.local_reference(path, ciphertext=kwargs.get('ciphertext', False))
            def cleanup(report):
                (runner.runs / report['run_id'] / 'backup.env').unlink(missing_ok=True)
                report['cleanup'] = {'owned_containers_absent': True, 'owned_postgres_sessions_absent': True,
                    'owned_plaintext_removed': True, 'runtime_preserved': True, 'ciphertext_preserved': True}
            runner.cleanup = mock.Mock(side_effect=cleanup)
            with mock.patch.object(remote, 'ref_read', side_effect=lambda ref, **kwargs: profiles[ref['path'] if isinstance(ref, dict) else ref]), \
                 mock.patch.object(remote, 'bounded', side_effect=backup), \
                 mock.patch.object(remote, 'read_file', side_effect=lambda path, **kwargs: Path(path).read_bytes()), \
                 mock.patch.object(remote, 'file_reference', side_effect=reference):
                report = runner.execute('123-1', 'a' * 40)
            self.assertEqual(report['status'], 'LOCAL_CUSTODY_PENDING')
            self.assertEqual(set(report['exports']), {'ciphertext.backup.aes', 'source.json', 'backup.json'})
            self.assertEqual(invocations[0][-2:], ['node', 'scripts/backup.mjs'])
            self.assertIn('type=bind,source=' + str(storage) + ',target=' + str(storage) + ',readonly', invocations[0])
            self.assertFalse((runs / '123-1' / 'backup.env').exists())
            public = json.dumps(remote.public_report(report)) + (runs / '123-1' / 'source.json').read_text() + (runs / '123-1' / 'backup.json').read_text()
            self.assertNotIn('1' * 64, public); self.assertNotIn('synthetic', public)
            self.assertEqual(json.loads((runs / '123-1' / 'backup.json').read_text())['private_assets'], 0)


class BackupWorkflowTests(unittest.TestCase):
    def test_backup_delivery_skips_deploy_even_with_old_deployed_baseline(self):
        baseline_paths = ['apps/api/pending.ts', 'scripts/b02-backup-ci.py']
        result = selection.select('push', 'refs/heads/main', 'a' * 40, baseline_paths,
            mode='release', push_paths=['scripts/b02-backup-ci.py', '.github/workflows/ci.yml', 'docs/backup-recovery.md'])
        self.assertEqual((result['deploy'], result['scope']), ('false', 'full'))
        fixture_delivery = ['scripts/b02-backup-ci.py', '.github/workflows/ci.yml',
            'tests/integration/number-capacity-reconciliation.test.ts',
            'tests/integration/integration-settings.test.ts']
        self.assertEqual(selection.select('push', 'refs/heads/main', 'a' * 40, baseline_paths,
            push_paths=fixture_delivery)['deploy'], 'false')
        self.assertEqual(selection.select('push', 'refs/heads/main', 'a' * 40, baseline_paths,
            push_paths=fixture_delivery + ['tests/integration/unreviewed-fixture.test.ts'])['deploy'], 'true')
        self.assertEqual(selection.select('push', 'refs/heads/main', 'a' * 40, baseline_paths,
            push_paths=fixture_delivery + ['apps/api/pending.ts'])['deploy'], 'true')
        for push in (None, ['scripts/b02-backup-ci.py', 'apps/api/pending.ts'], ['.github/workflows/ci.yml'], ['unknown-file']):
            with self.subTest(push=push):
                self.assertEqual(selection.select('push', 'refs/heads/main', 'a' * 40, baseline_paths, push_paths=push)['deploy'], 'true')
        self.assertEqual(selection.select('workflow_dispatch', 'refs/heads/main', 'a' * 40, baseline_paths,
            mode='release', push_paths=['scripts/b02-backup-ci.py'])['deploy'], 'true')

    def test_schedule_and_backup_dispatch_skip_release_graph(self):
        text = (ROOT / '.github/workflows/ci.yml').read_text()
        changes = text.split('  changes:\n', 1)[1].split('  verify:\n', 1)[0]
        gate = text.split('  ci-gate:\n', 1)[1].split('  package:\n', 1)[0]
        for job in (changes, gate):
            self.assertIn("github.event_name != 'schedule'", job)
            self.assertIn('contains(fromJSON(\'["credential","backup","copy-preflight"]\')', job)
        backup = text.split('  backup:\n', 1)[1]
        self.assertIn("vars.B02_BACKUP_ENABLED == 'true'", backup)
        self.assertIn("vars.B02_SCHEDULE_ENABLED == 'true'", backup)
        self.assertIn('timeout-minutes: 30', backup)
        self.assertIn('cancel-in-progress: false', backup)
        self.assertIn('contents: read', backup)
        self.assertNotIn('contents: write', backup)
        self.assertNotIn('MCL_PORTAL_ENV', backup)
        self.assertLess(backup.index('--preflight'), backup.index('google-github-actions/auth@'))


if __name__ == '__main__':
    unittest.main()
