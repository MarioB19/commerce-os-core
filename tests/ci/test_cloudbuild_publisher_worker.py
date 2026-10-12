"""Publisher wiring regressions; synthetic native responses, no cloud/SSH/key."""
from copy import deepcopy
from datetime import timedelta
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_publisher_worker as m
from cloudbuild_publisher_contract import template
from test_cloudbuild_admission import NOW, BUILD, ATTEMPT, plan, approval, admission, MemoryStore, observation
from test_cloudbuild_native_package import PackageTests
from test_cloudbuild_attestation import GateTests
from test_cloudbuild_runtime import descriptor
from test_cloudbuild_native_publisher import native_fixture

ROOT = Path(__file__).resolve().parents[2]


def config():
    return {'schema_version': 1, 'role': 'publisher', 'project': m.PROJECT, 'project_number': m.PROJECT_NUMBER,
            'repository_id': m.REPOSITORY_ID,
            'github_app': {'app_id': 5276479, 'installation_id': 170342995, 'repository_id': 1414365450,
                'repository': 'MarioB19/commerce-os-core',
                'secret_version': 'projects/1065291779811/secrets/commerce-v7-publisher-github-key/versions/1',
                'public_key_sha256': 'b4b127c27cf195d527d27baf99416b56cb71fccbd15c3347ada1ba278729d2e4'},
            'ledger': {'bucket': 'fixture-custody', 'object': 'runtime/ledger.json', 'minimum_generation': '1'},
            'control': {'bucket': 'fixture-custody', 'object': 'runtime/control.json', 'minimum_generation': '1'},
            'custody': {'bucket': 'fixture-custody', 'prefix': 'runtime'},
            'host_boot': {'restore_source_sha': '1'*40, 'restore_bundle': {**descriptor({'historical':True}), 'bucket':'fixture-custody', 'object':'runtime/history/restore.json'}},
            'adoption': {'month': '2026-10', 'minimum_confirmed_seconds': 4440, 'evidence_sha256': '1' * 64}}


class WorkerTests(unittest.TestCase):
    def setUp(self):
        p = PackageTests(); p.setUp(); self.package_fixture = p
        gate = GateTests(); gate.setUp(); self.gate = gate
        value = plan(repo=m.REPOSITORY_ID, stage='publisher'); value['verifier_sha256'] = 'f' * 64
        value['runner_sha256'] = m.digest(ROOT / 'scripts/cloudbuild-publish.py')
        self.body = {'schema_version': 1, 'attempt_id': ATTEMPT, 'release_admission': p.admission,
            'full_attempt_id': '77777777-7777-4777-8777-777777777777',
            'package_attempt_id': '88888888-8888-4888-8888-888888888888',
            'gate_attempt_id': '99999999-9999-4999-8999-999999999999', 'gate_contract': gate.contract,
            'installation_attempt': '1',
            'journal': {'bucket': 'fixture-custody', 'object': 'runtime/journals/' + ATTEMPT + '.json', 'minimum_generation': '1'},
            'client_sha256': m.digest(ROOT / 'scripts/deploy-ci-client.py'),
            'collector_sha256': m.digest(ROOT / 'scripts/cloudbuild-installed-readback.py'),
            'transfer_limit_bytes': m.MAX_TRANSFER, 'expires_at': m.ledger.stamp(NOW + timedelta(hours=5))}
        contract = {'schema_version': 1, 'build_id': BUILD, 'attempt_id': ATTEMPT, 'source_sha': 'a' * 40,
            'source_tree': 'b' * 40, 'image': 'us-east1-docker.pkg.dev/' + m.PROJECT + '/commerce-ci-public/publisher@sha256:' + 'f' * 64,
            'driver_sha256': value['runner_sha256'], 'task_sha256': descriptor(self.body)['sha256'],
            'storage_source': {'bucket': 'fixture-source', 'object': 'publisher/unique.tgz', 'generation': '12'},
            'archive_sha256': '5' * 64}
        value['config_sha256'] = m.ledger.canonical_hash(template(contract))
        self.task = {'schema_version': 1, 'operation': 'PUBLISH', 'phase': 'INSTALL', 'plan': value,
            'approval': approval(value=value), 'admission': admission(value=value),
            'body_ref': descriptor(self.body), 'contract': contract, 'expires_at': self.body['expires_at']}
        self.clock = [0.0]; self.now = [NOW]
        self.worker = m.PublisherWorker(config(), clock=lambda: self.clock[0], now=lambda: self.now[0])
        self.worker.build_id = BUILD
        self.control = {'schema_version': 1, 'mode': 'active', 'expires_at': self.task['expires_at'], 'task': descriptor(self.task)}
        self.worker.control_store = Mock(); self.worker.control_store.load.side_effect = lambda: ('10', deepcopy(self.control))
        self.worker.custody = Mock()
        self.worker.custody.read_json.side_effect = lambda ref: deepcopy(self.task if ref == self.control['task'] else self.body)
        self.native = {**deepcopy(template(contract)), 'id': BUILD, 'projectId': m.PROJECT,
            'name': 'projects/' + m.PROJECT + '/locations/us-east1/builds/' + BUILD, 'status': 'WORKING',
            'source': {'storageSource': deepcopy(contract['storage_source'])}}
        store = MemoryStore(m.ledger.new_ledger())
        m.ledger.transact(store, {'op': 'account_external', 'native_verified': True,
            'observation': observation(status='FAILURE', build='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                start=NOW - timedelta(minutes=74), seconds=4440)}, now=NOW)
        for op, key in (('discover', 'plan'), ('approve_source', 'approval'), ('reserve', 'admission')):
            m.ledger.transact(store, {'op': op, 'attempt_id': ATTEMPT, key: self.task[key]}, now=NOW)
        source = {**contract['storage_source'], 'archive_sha256': contract['archive_sha256']}
        m.ledger.transact(store, {'op': 'submit_intent', 'attempt_id': ATTEMPT, 'source': source,
            'nonce': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'request_sha256': m.ledger.canonical_hash(m.create_request(contract))}, now=NOW)
        m.ledger.transact(store, {'op': 'bind', 'attempt_id': ATTEMPT, 'build_id': BUILD, 'source': source,
            'config_sha256': value['config_sha256'], 'native_evidence_sha256': '7' * 64}, now=NOW)
        self.worker.ledger_store = store; self.worker.api = Mock(); self.worker.api.build.return_value = self.native

    def test_current_and_live_native_reservation_are_both_required(self):
        task, body, doc = self.worker.active()
        self.assertEqual(task, self.task); self.assertEqual(body, self.body)
        self.assertEqual(doc['active_attempt'], ATTEMPT)
        self.native['status'] = 'SUCCESS'
        with self.assertRaises(RuntimeError): self.worker.active()

    def test_paused_control_stops_before_native_read(self):
        self.control['mode'] = 'paused'
        with self.assertRaisesRegex(RuntimeError, 'PAUSED_OR_EXPIRED'): self.worker.active()
        self.worker.api.build.assert_not_called()

    def test_custody_update_after_initial_read_is_rejected(self):
        self.worker.current(); self.control['expires_at'] = m.ledger.stamp(NOW + timedelta(hours=6))
        with self.assertRaisesRegex(RuntimeError, 'CUSTODY_CHANGED'): self.worker.current()

    def test_native_uuid_or_driver_contract_substitution_is_rejected(self):
        changed = deepcopy(self.task); changed['contract']['build_id'] = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_BINDING'): m.validate_task(changed, BUILD, NOW)
        changed = deepcopy(self.task); changed['contract']['driver_sha256'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'RELEASE_PLAN'): m.validate_body(self.body, changed, NOW)

    def test_body_descriptor_and_expiry_are_closed(self):
        for changed in (dict(self.task, expires_at=m.ledger.stamp(NOW)),
                        dict(self.task, body_ref=descriptor({'substitute': True}))):
            with self.assertRaises(RuntimeError): m.validate_task(changed, BUILD, NOW)

    def test_body_hash_precedes_native_template_and_cannot_hide_a_different_plan(self):
        # The input body has no publisher plan or native UUID, so its digest can
        # be known before the template, approval, reservation and CreateBuild.
        self.assertFalse({'plan', 'approval', 'admission'} & set(self.body))
        self.assertEqual(descriptor(self.body)['sha256'], self.task['contract']['task_sha256'])
        m.validate_task(self.task, BUILD, NOW)
        changed = deepcopy(self.task); changed['contract']['task_sha256'] = '4' * 64
        changed['body_ref']['sha256'] = '4' * 64
        with self.assertRaisesRegex(RuntimeError, 'PLAN_NATIVE_TEMPLATE'): m.validate_task(changed, BUILD, NOW)

    def test_budget_expiry_is_not_extended_by_task_expiry(self):
        with self.assertRaises(RuntimeError): m.validate_body(self.body, self.task, NOW + timedelta(hours=4, seconds=1))

    def test_missing_history_or_other_active_attempt_never_installs(self):
        self.worker.ledger_store.document['external_builds'] = {}
        with self.assertRaisesRegex(RuntimeError, 'HISTORY_NOT_ADOPTED'): self.worker.active()

    def test_preparation_counts_in_the_single_global_deadline(self):
        self.clock[0] = 809; self.assertEqual(self.worker.remaining(), 1)
        self.clock[0] = 811
        with self.assertRaisesRegex(RuntimeError, 'GLOBAL_DEADLINE'): self.worker.remaining()
        self.assertEqual(self.worker.remaining(cleanup=True), 89)

    def prepared_fixture(self):
        self.task['operation'] = 'PUBLISH_PREPARED'
        self.task['contract']['build_id'] = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        self.bound_doc = deepcopy(self.worker.ledger_store.document)
        row = self.worker.ledger_store.document['attempts'][ATTEMPT]
        row['state'] = 'SUBMIT_INTENT'; del row['build_id']; del row['bind_evidence_sha256']

    def bind_ready(self):
        self.worker.ledger_store.document = deepcopy(self.bound_doc)
        self.task['operation'] = 'PUBLISH'; self.task['contract']['build_id'] = BUILD
        self.control['task'] = descriptor(self.task)

    def test_prepared_wait_is_read_only_until_exact_native_binding(self):
        self.prepared_fixture()
        self.worker.package = Mock(); self.worker.identity = Mock()
        def sleep(seconds):
            self.assertIsNone(self.worker.task); self.clock[0] += seconds; self.bind_ready()
        self.worker.await_binding(sleep=sleep)
        self.assertEqual(self.worker.task['operation'], 'PUBLISH'); self.assertEqual(self.clock[0], 5)
        self.assertEqual(self.worker.api.build.call_count, 2)
        self.worker.package.download.assert_not_called(); self.worker.identity.token.assert_not_called()

    def test_binding_wait_has_five_observations_and_never_turns_unknown_into_ready(self):
        self.prepared_fixture()
        with self.assertRaisesRegex(RuntimeError, 'BINDING_WAIT_EXPIRED'):
            self.worker.await_binding(sleep=lambda seconds: self.clock.__setitem__(0, self.clock[0] + seconds))
        self.assertEqual(self.worker.api.build.call_count, 5); self.assertIsNone(self.worker.task)
        row = self.worker.ledger_store.document['attempts'][ATTEMPT]
        row['state'] = 'UNKNOWN'; row['uncertainty'] = {'reason': 'LOST_ACK', 'evidence_sha256': 'f' * 64}
        self.worker.api.reset_mock()
        with self.assertRaisesRegex(RuntimeError, 'PREPARED_RESERVATION_CHANGED'):
            self.worker.await_binding(sleep=lambda _seconds: self.fail('must not retry unknown'))
        self.worker.api.build.assert_not_called()

    def test_prepared_wait_rejects_pause_expiry_or_unrelated_custody_changes(self):
        self.prepared_fixture()
        def sleep(_seconds): self.control['mode'] = 'paused'
        with self.assertRaisesRegex(RuntimeError, 'PAUSED_OR_EXPIRED'): self.worker.await_binding(sleep=sleep)
        self.control['mode'] = 'active'
        def changed(_seconds): self.task['expires_at'] = m.ledger.stamp(NOW + timedelta(hours=6))
        with self.assertRaisesRegex(RuntimeError, 'PREPARED_CUSTODY_CHANGED'): self.worker.await_binding(sleep=changed)

    def test_prepared_wait_authenticates_native_before_any_sleep(self):
        self.prepared_fixture(); self.native['source']['storageSource']['generation'] = '13'
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_SOURCE_CHANGED'):
            self.worker.await_binding(sleep=lambda _seconds: self.fail('must not retry wrong build'))
        self.assertIsNone(self.worker.task)

    def test_prepared_wait_clock_bound_cannot_add_time_to_outer_budget(self):
        self.prepared_fixture()
        def slow(): self.clock[0] = 31; return ('10', deepcopy(self.control))
        self.worker.control_store.load.side_effect = slow
        with self.assertRaisesRegex(RuntimeError, 'BINDING_WAIT_EXPIRED'): self.worker.await_binding()
        self.assertEqual(self.worker.remaining(), 779)

    def test_prepared_wait_rejects_ledger_binding_rewind(self):
        self.prepared_fixture()
        unbound = deepcopy(self.worker.ledger_store.document)
        self.worker.ledger_store.document = deepcopy(self.bound_doc)
        def rewind(_seconds): self.worker.ledger_store.document = unbound
        with self.assertRaisesRegex(RuntimeError, 'RESERVATION_REWOUND'):
            self.worker.await_binding(sleep=rewind)

    def test_prepared_placeholder_is_not_mutable_while_waiting(self):
        self.prepared_fixture()
        def changed(_seconds): self.task['contract']['build_id'] = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
        with self.assertRaisesRegex(RuntimeError, 'PREPARED_CUSTODY_CHANGED'):
            self.worker.await_binding(sleep=changed)

    def test_config_forbids_dynamic_roles_public_repository_and_reset(self):
        for change in ({'role': 'controller'}, {'factory': 'candidate.module'}, {'repository_id': 1359063164}):
            with self.assertRaises(RuntimeError): m.validate_config(config() | change)
        changed = config(); changed['adoption']['minimum_confirmed_seconds'] = 0
        with self.assertRaisesRegex(RuntimeError, 'HISTORY'): m.validate_config(changed)

    def test_construction_does_not_contact_network_or_use_ambient_tokens(self):
        with patch.object(m.urllib.request.OpenerDirector, 'open', side_effect=AssertionError('network')), patch.dict(os.environ, {'GH_TOKEN': 'fixture-secret'}):
            worker = m.PublisherWorker(config())
        self.assertNotIn('fixture-secret', repr(vars(worker)))

    def admission_fixture(self):
        doc = {'attempts': {}}
        for key, stage, build in (('package_attempt_id', 'package', self.package_fixture.context['package_build_id']),
                                  ('gate_attempt_id', 'attestation', self.gate.contract['build_id'])):
            doc['attempts'][self.body[key]] = {'state': 'RECONCILED', 'plan': {'stage': stage},
                                             'build_id': build, 'terminal': {'status': 'SUCCESS'}}
        self.worker.active = Mock(return_value=(self.task, self.body, doc)); self.worker.current = Mock()
        self.worker.github_reader = Mock(); self.worker.package = Mock()
        self.worker.package.evidence.return_value = {'context': self.package_fixture.context,
            'archive_sha256': '1' * 64, 'archive_bytes': 256, 'artifact_uri': self.package_fixture.uri, 'artifact_md5': 'fixture'}
        self.patches = [patch.object(m.gate, 'full_reconciled'), patch.object(m.gate, 'validate_native_gate', return_value='SUCCESS'),
                        patch.object(m.gate, 'receipt_from_logs')]
        for p in self.patches: p.start(); self.addCleanup(p.stop)
        return doc

    def test_admission_requires_package_gate_and_full_not_just_workspace_receipt(self):
        doc = self.admission_fixture(); first = self.worker.admission()
        self.assertTrue(first['installation_run_id'].startswith('cb-'))
        doc['attempts'][self.body['package_attempt_id']]['terminal']['status'] = 'FAILURE'
        with self.assertRaisesRegex(RuntimeError, 'RECONCILED_DEPENDENCY'): self.worker.admission()

    def test_changed_package_or_pause_after_readback_blocks_publication(self):
        self.admission_fixture(); self.worker.admission()
        self.worker.package.evidence.return_value['archive_sha256'] = '2' * 64
        with self.assertRaisesRegex(RuntimeError, 'PACKAGE_CHANGED'): self.worker.admission()
        self.worker.package.evidence.return_value['archive_sha256'] = '1' * 64
        self.worker.controls = Mock(); self.worker.controls.controls.return_value = {'deploy_paused': True, 'github_actions_enabled': False}
        with self.assertRaisesRegex(RuntimeError, 'CURRENT_CONTROLS'): self.worker.admission()

    def test_expiry_during_native_package_read_prevents_returning_admission(self):
        self.admission_fixture()
        value = self.worker.package.evidence.return_value
        def slow(_admission):
            self.now[0] = NOW + timedelta(hours=4, seconds=1)
            return value
        self.worker.package.evidence.side_effect = slow
        with self.assertRaises(RuntimeError): self.worker.admission()

    def test_ledger_change_during_native_evidence_is_rechecked_before_admission(self):
        active = self.worker.active  # Exercise the real ledger/native validator.
        current = self.worker.current
        first = active()
        self.admission_fixture()
        self.worker.current = current
        self.worker.active = Mock(side_effect=active)
        original = self.worker.ledger_store.document
        doc = deepcopy(first[2])
        for key, stage, build in (('package_attempt_id', 'package', self.package_fixture.context['package_build_id']),
                                  ('gate_attempt_id', 'attestation', self.gate.contract['build_id'])):
            doc['attempts'][self.body[key]] = {'state': 'RECONCILED', 'plan': {'stage': stage},
                'build_id': build, 'terminal': {'status': 'SUCCESS'}}
        calls = [0]
        def observed():
            calls[0] += 1
            return (first[0], first[1], doc) if calls[0] == 1 else active()
        self.worker.active.side_effect = observed
        value = self.worker.package.evidence.return_value
        def changed(_admission):
            original['blocked'] = {'reason': 'EXTERNAL_PAUSE', 'evidence_sha256': 'f' * 64}
            return value
        self.worker.package.evidence.side_effect = changed
        with self.assertRaises(RuntimeError): self.worker.admission()
        self.assertEqual(calls[0], 2)

    def run_fixture(self, phase='INSTALL'):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.run_dir = Path(temp.name).resolve(); (self.run_dir / 'source').mkdir(); (self.run_dir / 'private').mkdir()
        self.task['phase'] = phase
        if phase == 'RECONCILE': self.body['origin_task_ref'] = descriptor({'historical': 'fixture'})
        admitted = native_fixture()[0]
        self.worker.active = Mock(return_value=(self.task, self.body, {})); self.worker.admission = Mock(return_value=admitted)
        self.worker.await_binding = Mock()
        self.worker.boot_inputs = Mock(return_value=b'fixed-boot-inputs' if phase == 'INSTALL' else None)
        self.worker.identity = Mock(); self.worker.source_reader = Mock()
        self.worker.verified = {'archive_bytes': 128, 'archive_sha256': admitted['archive_sha256'], 'artifact_uri': 'fixture'}
        self.worker.package = Mock()
        def download(verified, path, reserve):
            reserve(verified['artifact_uri'], verified['archive_bytes'] + 1); path.write_bytes(b'fixture')
        self.worker.package.download.side_effect = download
        journal = Mock(); journal.commit_intent.return_value = {'effect': 'CREATE_ONCE'}
        self.transport = Mock(); self.publisher = Mock()
        self.publisher.reconcile_or_publish.return_value = {'status': 'NATIVE_DEPLOYMENT_PUBLISHED', 'deployment_id': 17}
        pairs = [('ENTRYPOINT', ROOT / 'scripts/cloudbuild-publish.py'), ('private_run', Mock(return_value=self.run_dir)),
                 ('DurableEffectJournal', Mock(return_value=journal)), ('PublisherCredential', Mock()),
                 ('PublisherControls', Mock()), ('NativeInstall', Mock(return_value=self.transport)),
                 ('NativeRootReadback', Mock()), ('NativePublisher', Mock(return_value=self.publisher)),
                 ('copy_source', Mock(side_effect=lambda source, target, ctx, reserve, check: reserve(64)))]
        self.run_mocks = {}
        pairs += [('acquire_once', Mock())]
        for name, value in pairs:
            p = patch.object(m, name, value); p.start(); self.addCleanup(p.stop); self.run_mocks[name] = value
        return journal

    def test_install_wiring_reserves_bytes_and_installs_before_publication(self):
        journal = self.run_fixture(); self.clock[0] = 100
        def install(): self.assertEqual(self.publisher.reconcile_or_publish.call_count, 0)
        self.transport.install_once.side_effect = install
        result = self.worker.run(BUILD)
        acquire = self.run_mocks['acquire_once']; acquire.assert_called_once()
        self.assertIs(acquire.call_args.args[1].journal, journal)
        self.assertIs(acquire.call_args.args[1].fence, self.worker.admission)
        self.assertEqual(acquire.call_args.args[2], self.body['attempt_id'])
        self.assertEqual(result['deployment_id'], 17); self.transport.install_once.assert_called_once()
        self.transport.reconcile.assert_not_called(); self.assertEqual(self.transport.deadline, 900)
        self.assertEqual(self.run_mocks['NativeInstall'].call_args.kwargs['boot_inputs'], b'fixed-boot-inputs')
        self.assertEqual([x.args[0].split(':')[0] for x in journal.commit_intent.call_args_list],
                         ['transfer-reservation', 'package-download'])
        self.publisher.reconcile_or_publish.assert_called_once()

    def test_reconcile_wiring_never_copies_downloads_or_starts_again(self):
        current_journal = self.run_fixture('RECONCILE'); self.worker.run(BUILD)
        acquire = self.run_mocks['acquire_once']; acquire.assert_called_once()
        self.assertIs(acquire.call_args.args[1].journal, current_journal)
        self.assertIs(acquire.call_args.args[1].fence, self.worker.admission)
        self.run_mocks['copy_source'].assert_not_called(); self.worker.package.download.assert_not_called()
        self.transport.install_once.assert_not_called(); self.transport.reconcile.assert_called_once()
        self.assertIsNone(self.run_mocks['NativeInstall'].call_args.kwargs['boot_inputs'])
        api = self.run_mocks['NativePublisher'].call_args.args[3]
        self.assertIsInstance(api, m.ReconcileGitHub)
        history = self.run_mocks['NativePublisher'].call_args.args[4]
        self.assertIsInstance(history, m.HistoricalReadOnlyJournal)

    def test_boot_collection_consumes_current_intent_and_records_exact_input(self):
        self.worker.verified = {'archive_bytes': 128}
        admitted = native_fixture()[0]; journal = Mock()
        journal.commit_intent.side_effect = lambda action,payload: {'effect':'CREATE_ONCE',
            'intent_sha256':m.ledger.canonical_hash(payload),'attempt_id':ATTEMPT,'fencing_generation':'10'}
        self.worker.admission = Mock(return_value=admitted)
        def collect(**kwargs):
            kwargs['reserve'](m.BOOT_TRANSFER_RESERVATION);return b'original-input-bytes'
        with patch.object(m,'collect_boot_inputs',side_effect=collect):
            result=self.worker.boot_inputs(self.task,self.body,admitted,journal)
        self.assertEqual(result,b'original-input-bytes');self.assertEqual(journal.commit_intent.call_args.args[0],'boot-originals:'+ATTEMPT)
        self.assertEqual(journal.record_result.call_args.args[1]['input_sha256'],m.hashlib.sha256(result).hexdigest())
        self.worker.admission.assert_called()

    def test_boot_unknown_reservation_or_insufficient_bytes_precedes_acquisition(self):
        self.worker.verified = {'archive_bytes':128};admitted=native_fixture()[0];journal=Mock();journal.commit_intent.side_effect=RuntimeError('CAS_UNKNOWN')
        def collect(**kwargs):kwargs['reserve'](m.BOOT_TRANSFER_RESERVATION);raise AssertionError('provider read')
        self.worker.admission=Mock(return_value=admitted)
        with patch.object(m,'collect_boot_inputs',side_effect=collect):
            with self.assertRaisesRegex(RuntimeError,'CAS_UNKNOWN'):self.worker.boot_inputs(self.task,self.body,admitted,journal)
            self.body['transfer_limit_bytes']=1
            with self.assertRaisesRegex(RuntimeError,'TRANSFER_ADMISSION'):self.worker.boot_inputs(self.task,self.body,admitted,journal)
        journal.record_result.assert_not_called()

    def test_boot_reconcile_never_creates_new_inputs(self):
        journal=Mock()
        with patch.object(m,'collect_boot_inputs')as collect:
            self.assertIsNone(self.worker.boot_inputs({**self.task,'phase':'RECONCILE'},self.body,native_fixture()[0],journal))
        collect.assert_not_called();journal.commit_intent.assert_not_called()

    def historical_fixture(self):
        origin = deepcopy(self.task); old_body = deepcopy(self.body)
        current = deepcopy(old_body); current['attempt_id'] = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
        current['origin_task_ref'] = descriptor(origin)
        current['journal']['object'] = 'runtime/journals/' + current['attempt_id'] + '.json'
        current['expires_at'] = m.ledger.stamp(NOW + timedelta(days=1))
        admitted = native_fixture()[0]
        row = deepcopy(self.worker.ledger_store.document['attempts'][ATTEMPT])
        row['state'] = 'RECONCILED'; row['terminal'] = {'status': 'FAILURE'}
        doc = {'attempts': {ATTEMPT: row}}
        self.worker.custody.read_json.side_effect = lambda ref: deepcopy(origin if ref == current['origin_task_ref'] else old_body)
        native = deepcopy(self.native); native['status'] = 'FAILURE'; self.worker.api.build.return_value = native
        binding = {'attempt_id': ATTEMPT, 'plan_sha256': m.ledger.canonical_hash(origin['plan']), 'source_sha': admitted['source_sha']}
        history = m.ledger.canonical_hash({k: admitted[k] for k in ('context', 'source_sha', 'installation_run_id', 'archive_sha256')})
        journal = {'schema_version': 1, 'binding': binding, 'revision': 2,
                   'actions': {prefix + admitted['installation_run_id']: {'intent_sha256': history,
                       'created_at': m.ledger.stamp(NOW), 'result': None, 'history': []}
                       for prefix in ('install-transport:', 'root-start:')}}
        self.history_store = Mock(); self.history_store.load.side_effect = lambda: ('20', deepcopy(journal))
        self.worker.store = Mock(return_value=self.history_store)
        return origin, old_body, current, doc, admitted, journal

    def test_new_budget_reads_old_terminal_attempt_without_renewing_or_writing_it(self):
        origin, _old, current, doc, admitted, journal = self.historical_fixture()
        self.now[0] = NOW + timedelta(days=1)  # Original approval has expired.
        before = deepcopy((doc, journal))
        self.worker.historical_origin(self.task, current, doc, admitted)
        self.assertEqual((doc, journal), before)
        self.history_store.compare_and_swap.assert_not_called()
        self.assertNotEqual(current['attempt_id'], origin['contract']['attempt_id'])

    def test_reconcile_requires_explicit_historical_task_and_preserves_release(self):
        changed = dict(self.task, phase='RECONCILE')
        with self.assertRaisesRegex(RuntimeError, 'BODY_FIELDS'): m.validate_body(self.body, changed, NOW)
        _origin, _old, current, doc, admitted, _journal = self.historical_fixture()
        current['installation_attempt'] = '2'
        with self.assertRaisesRegex(RuntimeError, 'ORIGIN_RELEASE_CHANGED'):
            self.worker.historical_origin(self.task, current, doc, admitted)
        self.history_store.load.assert_not_called()

    def test_origin_cannot_be_running_same_attempt_or_missing_root_intent(self):
        for variant in ('running', 'same', 'missing'):
            with self.subTest(variant=variant):
                _origin, _old, current, doc, admitted, journal = self.historical_fixture()
                if variant == 'running': doc['attempts'][ATTEMPT]['state'] = 'RUNNING'
                if variant == 'same': current['attempt_id'] = ATTEMPT
                if variant == 'missing': journal['actions'].pop('root-start:' + admitted['installation_run_id'])
                with self.assertRaisesRegex(RuntimeError, 'ORIGIN_'):
                    self.worker.historical_origin(self.task, current, doc, admitted)

    def test_origin_journal_deletion_or_change_cannot_reset_or_replace_history(self):
        _origin, _old, current, doc, admitted, journal = self.historical_fixture()
        self.worker.historical_origin(self.task, current, doc, admitted)
        journal['revision'] += 1
        with self.assertRaisesRegex(RuntimeError, 'ORIGIN_HISTORY_CHANGED'):
            self.worker.historical_origin(self.task, current, doc, admitted)
        self.history_store.load.side_effect = lambda: ('0', None)
        with self.assertRaisesRegex(RuntimeError, 'MISSING_NO_RESET'):
            self.worker.historical_origin(self.task, current, doc, admitted)
        self.history_store.compare_and_swap.assert_not_called()

    def test_transfer_limit_or_consumed_reservation_precedes_download(self):
        journal = self.run_fixture(); self.body['transfer_limit_bytes'] = 1
        with self.assertRaisesRegex(RuntimeError, 'TRANSFER_LIMIT'): self.worker.run(BUILD)
        self.worker.package.download.assert_not_called(); self.transport.install_once.assert_not_called()

    def test_uncertain_install_cannot_reach_success_publication(self):
        self.run_fixture(); self.transport.install_once.side_effect = RuntimeError('UNKNOWN')
        with self.assertRaisesRegex(RuntimeError, 'UNKNOWN'): self.worker.run(BUILD)
        self.publisher.reconcile_or_publish.assert_not_called()


class BoundaryTests(unittest.TestCase):
    def test_binding_read_deadline_interrupts_slow_read_and_restores_outer_alarm(self):
        original = m.signal.setitimer
        previous = m.signal.getitimer(m.signal.ITIMER_REAL)
        self.assertEqual(previous[0], 0)
        def short(kind, seconds, interval=0): return original(kind, .03 if seconds == 30 else seconds, interval)
        with patch.object(m.signal, 'setitimer', side_effect=short):
            with self.assertRaisesRegex(RuntimeError, 'BINDING_WAIT_EXPIRED'):
                with m.binding_read_deadline(): m.time.sleep(.1)
        self.assertEqual(m.signal.getitimer(m.signal.ITIMER_REAL)[0], 0)
        try:
            original(m.signal.ITIMER_REAL, 10)
            with m.binding_read_deadline(): m.time.sleep(.01)
            self.assertTrue(9 < m.signal.getitimer(m.signal.ITIMER_REAL)[0] < 10)
        finally: original(m.signal.ITIMER_REAL, 0)

    def test_fence_is_after_confirmed_cas_and_not_called_for_replay(self):
        raw = Mock(); raw.commit_intent.return_value = {'effect': 'CREATE_ONCE'}
        fence = Mock(side_effect=RuntimeError('PAUSED')); journal = m.FencedJournal(raw, fence)
        with self.assertRaisesRegex(RuntimeError, 'PAUSED'): journal.commit_intent('action', {})
        raw.commit_intent.assert_called_once(); fence.assert_called_once()
        raw.commit_intent.return_value = {'effect': None}; fence.reset_mock()
        self.assertEqual(journal.commit_intent('action', {}), {'effect': None}); fence.assert_not_called()

    def test_reconcile_adapter_cannot_create_deployment_or_status(self):
        api = Mock(); reader = m.ReconcileGitHub(api)
        reader.request('GET', '/deployments/1')
        with self.assertRaisesRegex(RuntimeError, 'MUST_NOT_POST'): reader.request('POST', '/deployments', {})
        self.assertEqual(api.request.call_count, 1)
        history = m.HistoricalReadOnlyJournal()
        for call in (lambda: history.commit_intent('new', {}), lambda: history.record_result('old', {})):
            with self.assertRaisesRegex(RuntimeError, 'HISTORICAL_RECONCILE_MUST_NOT'): call()

    def test_real_git_source_copy_is_reserved_before_writes_and_matches_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); source = root / 'input'; target = root / 'output'
            source.mkdir(); target.mkdir()
            def git(*args): return subprocess.check_output(['git', *args], cwd=source, stderr=subprocess.DEVNULL, text=True).strip()
            git('init', '-q'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'fixture@example.invalid')
            (source / 'entry.txt').write_text('synthetic source\n'); git('add', 'entry.txt'); git('commit', '-qm', 'fixture')
            import shutil
            shutil.rmtree(source / '.git/hooks'); shutil.rmtree(source / '.git/logs')
            (source / '.git/config').write_text(m.SANITIZED_CONFIG)
            ctx = {'source_sha': git('rev-parse', 'HEAD'), 'source_tree': git('rev-parse', 'HEAD^{tree}')}
            reserved = []
            def reserve(size): self.assertEqual(list(target.iterdir()), []); reserved.append(size)
            m.copy_source(source, target, ctx, reserve, lambda: None)
            self.assertEqual((target / 'entry.txt').read_bytes(), b'synthetic source\n'); self.assertEqual(len(reserved), 1)

    def test_linked_source_is_rejected_before_reservation_or_git(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); (root / 'evil').symlink_to('/etc/passwd')
            with self.assertRaisesRegex(RuntimeError, 'LINK_OR_SPECIAL'): m.source_inventory(root)


def load_tests(loader, _tests, _pattern):
    return unittest.TestSuite(loader.loadTestsFromTestCase(cls) for cls in (WorkerTests, BoundaryTests))


if __name__ == '__main__': unittest.main()
