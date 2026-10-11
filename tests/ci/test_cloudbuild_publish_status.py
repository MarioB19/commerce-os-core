"""Synthetic native-response contracts; no cloud calls or GitHub mutations."""
import base64
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('cloudbuild_publisher', ROOT/'scripts/cloudbuild-publish-status.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
BUILD = '12345678-1234-4234-8234-123456789abc'
NUMBER = '123456789012'


def fixture():
    image = 'us-east1-docker.pkg.dev/'+m.PROJECT+'/commerce-ci/verify@sha256:'+'d'*64
    config = {
        'serviceAccount': 'projects/$PROJECT_ID/serviceAccounts/commerce-v7-verify@$PROJECT_ID.iam.gserviceaccount.com',
        'timeout': '5700s', 'queueTtl': '600s',
        'options': {'logging': 'CLOUD_LOGGING_ONLY', 'sourceProvenanceHash': ['SHA256'], 'automapSubstitutions': False},
        'substitutions': {'COMMIT_SHA': 'a'*40, '_VERIFY_IMAGE': image},
        'steps': [{'id': 'Commerce-V7-FULL-verification', 'name': 'gcr.io/cloud-builders/docker',
                   'entrypoint': 'bash', 'timeout': '5700s',
                   'env': ['EXPECTED_SHA=$COMMIT_SHA', 'BUILD_IDENTITY=$BUILD_ID', 'VERIFY_IMAGE=${_VERIFY_IMAGE}'],
                   'args': ['-euc', 'exec docker run "$$VERIFY_IMAGE" --expected-sha "$$EXPECTED_SHA"']}],
    }
    manifest = {'schema_version': 1, 'repository': m.REPOSITORY, 'project': m.PROJECT,
                'region': 'us-east1', 'build_id': BUILD, 'source_sha': 'a'*40, 'source_tree': 'b'*40,
                'archive_sha256': 'c'*64, 'verifier_image': image, 'runner_sha256': 'e'*64,
                'workflow_sha256': 'f'*64, 'build_config': config,
                'build_config_sha256': m.canonical_hash(config),
                'storage_source': {'bucket': 'synthetic-ci-source', 'object': 'source/exact.tgz', 'generation': '23'}}
    build = {**copy.deepcopy(config), 'id': BUILD, 'projectId': m.PROJECT, 'status': 'SUCCESS',
             'name': 'projects/'+NUMBER+'/locations/us-east1/builds/'+BUILD,
             'source': {'storageSource': copy.deepcopy(manifest['storage_source'])},
             'sourceProvenance': {
                 'resolvedStorageSource': copy.deepcopy(manifest['storage_source']),
                 'fileHashes': {'gs://synthetic-ci-source/source/exact.tgz': {
                     'fileHash': [{'type': 'SHA256', 'value': base64.b64encode(bytes.fromhex('c'*64)).decode()}]}}}}
    build['steps'][0].update(status='SUCCESS', exitCode=0)
    github = {'sha': 'a'*40, 'tree': {'sha': 'b'*40}}
    receipt = {'schema_version': 1, 'provider': 'google-cloud-build', 'build_id': BUILD,
               'gate_name': m.GATE, 'scope': 'full', 'source_sha': 'a'*40, 'source_tree': 'b'*40,
               'verifier_image': image, 'runner_sha256': 'e'*64, 'workflow_sha256': 'f'*64,
               'maximum_suite_seconds': 5400, 'status': 'PASSED',
               'deployment_proven': False, 'github_check_published': False,
               'stages': [{'id': name, 'status': 'PASSED', 'exit_code': 0} for name in m.STAGES]}
    log = {'resource': {'type': 'build', 'labels': {'build_id': BUILD, 'project_id': m.PROJECT}},
           'textPayload': 'Step #0 - "Commerce-V7-FULL-verification": '+json.dumps(receipt)}
    return manifest, build, github, receipt, [log]


class NativeEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.manifest, self.build, self.github, self.receipt, self.logs = fixture()

    def native(self):
        return m.validate_native(self.manifest, self.build, self.github, NUMBER)

    def test_exact_native_source_configuration_and_full_receipt_pass(self):
        self.assertEqual(self.native(), 'success')
        m.validate_full_receipt(self.manifest, m.receipts_from_logs(self.logs, self.manifest))

    def test_expanded_native_config_and_numeric_generation_are_equivalent(self):
        values = {**self.manifest['build_config']['substitutions'], 'PROJECT_ID': m.PROJECT, 'BUILD_ID': BUILD}
        for key in ('serviceAccount', 'steps'):
            self.build[key] = m.expanded(self.build[key], values)
        self.build['source']['storageSource']['generation'] = 23
        self.assertEqual(self.native(), 'success')

    def test_github_sha_and_tree_are_both_required(self):
        for key in ('sha', 'tree'):
            self.github = {'sha': 'a'*40, 'tree': {'sha': 'b'*40}}
            self.github[key] = '0'*40 if key == 'sha' else {'sha': '0'*40}
            with self.assertRaisesRegex(m.EvidenceError, 'GITHUB_COMMIT_TREE_MISMATCH'):
                self.native()

    def test_input_and_resolved_object_generations_cannot_drift(self):
        for key in ('source', 'sourceProvenance'):
            self.build = fixture()[1]
            nested = 'storageSource' if key == 'source' else 'resolvedStorageSource'
            self.build[key][nested]['generation'] = '24'
            with self.assertRaises(m.EvidenceError):
                self.native()

    def test_archive_hash_requires_native_sha256_not_receipt_or_md5(self):
        hashes = self.build['sourceProvenance']['fileHashes']
        item = next(iter(hashes.values()))['fileHash'][0]
        for value in ({'type': 'MD5', 'value': item['value']}, {'type': 'SHA256', 'value': 'wrong'}):
            next(iter(hashes.values()))['fileHash'] = [value]
            with self.assertRaisesRegex(m.EvidenceError, 'NATIVE_ARCHIVE_HASH_MISMATCH'):
                self.native()
        self.build['sourceProvenance']['fileHashes'] = {}
        with self.assertRaises(m.EvidenceError):
            self.native()

    def test_native_step_cannot_add_command_environment_or_skip_failure(self):
        changes = [lambda b: b['steps'][0]['args'].append('bypass'),
                   lambda b: b['steps'][0]['env'].append('TOKEN=synthetic'),
                   lambda b: b['steps'][0].update(allowFailure=True),
                   lambda b: b['steps'].append(copy.deepcopy(b['steps'][0])),
                   lambda b: b['steps'][0].update(status='FAILURE', exitCode=1)]
        for mutate in changes:
            self.build = fixture()[1]
            mutate(self.build)
            with self.subTest(build=self.build['steps'][0]['id']):
                with self.assertRaises(m.EvidenceError):
                    self.native()

    def test_other_service_account_secrets_machine_or_trigger_are_rejected(self):
        changes = [lambda b: b.update(serviceAccount='projects/x/serviceAccounts/production'),
                   lambda b: b.update(availableSecrets={'secretManager': ['synthetic']}),
                   lambda b: b['options'].update(machineType='E2_HIGHCPU_32'),
                   lambda b: b['options'].update(pool={'name': 'production'}),
                   lambda b: b.update(buildTriggerId='not-a-manual-bootstrap')]
        for mutate in changes:
            self.build = fixture()[1]
            mutate(self.build)
            with self.assertRaises(m.EvidenceError):
                self.native()

    def test_build_identity_and_config_hash_cannot_be_relabelled(self):
        self.build['id'] = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        with self.assertRaisesRegex(m.EvidenceError, 'NATIVE_BUILD_IDENTITY_MISMATCH'):
            self.native()
        self.build = fixture()[1]
        self.manifest['build_config']['steps'][0]['args'].append('edited')
        with self.assertRaisesRegex(m.EvidenceError, 'TRUSTED_CONFIG_HASH_MISMATCH'):
            self.native()

    def test_failed_cancelled_and_running_native_builds_never_pass(self):
        for state, expected in [('FAILURE', 'failure'), ('TIMEOUT', 'failure'), ('CANCELLED', 'failure'),
                                ('INTERNAL_ERROR', 'failure'), ('WORKING', 'pending'), ('QUEUED', 'pending')]:
            self.build['status'] = state
            self.assertEqual(self.native(), expected)

    def test_receipt_cannot_omit_reorder_duplicate_or_fail_any_gate(self):
        variants = [lambda r: r['stages'].pop(), lambda r: r['stages'].reverse(),
                    lambda r: r['stages'].append(r['stages'][0]),
                    lambda r: r['stages'][3].update(exit_code=1),
                    lambda r: r['stages'][3].update(status='NOT_RUN'),
                    lambda r: r.update(runner_sha256='0'*64),
                    lambda r: r.update(verifier_image=r['verifier_image'].split('@')[0]),
                    lambda r: r.update(status='RUNNING')]
        for mutate in variants:
            receipt = copy.deepcopy(self.receipt)
            mutate(receipt)
            with self.assertRaises(m.EvidenceError):
                m.validate_full_receipt(self.manifest, receipt)

    def test_logs_need_native_build_labels_and_one_terminal_receipt(self):
        with self.assertRaisesRegex(m.EvidenceError, 'UNIQUE_NATIVE_RUNNER_RECEIPT_REQUIRED'):
            m.receipts_from_logs(self.logs*2, self.manifest)
        self.logs[0]['resource']['labels']['build_id'] = 'different'
        with self.assertRaisesRegex(m.EvidenceError, 'LOG_BUILD_IDENTITY_MISMATCH'):
            m.receipts_from_logs(self.logs, self.manifest)
        with self.assertRaisesRegex(m.EvidenceError, 'LOG_QUERY_INCOMPLETE'):
            m.receipts_from_logs(fixture()[4]*100, self.manifest)


class CliBoundaryTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(m.operator_identity, "local_account", return_value="synthetic-ci@example.invalid")
        patcher.start(); self.addCleanup(patcher.stop)

    def test_evaluation_performs_only_native_and_github_reads(self):
        manifest, build, github, _, logs = fixture()
        responses = [{'projectId': m.PROJECT, 'projectNumber': NUMBER}, github, build, logs]
        calls = []
        def runner(argv, data=None):
            calls.append((argv, data))
            return responses.pop(0)
        payload = m.evaluate(manifest, '/trusted/gcloud', runner)
        self.assertEqual(payload['state'], 'success')
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(data is None for _, data in calls))
        self.assertFalse(any('POST' in argv for argv, _ in calls))
        self.assertIn('--freshness=90d', calls[-1][0])

    def test_publish_targets_exact_sha_and_reads_back_created_status(self):
        manifest = fixture()[0]
        payload = {'state': 'success', 'context': m.GATE, 'target_url': 'https://console.cloud.google.com/',
                   'description': 'synthetic verified result'}
        calls = []
        def runner(argv, data=None):
            calls.append((argv, data))
            return {'id': 23} if data is not None else [{'id': 23, **payload}]
        self.assertEqual(m.publish(manifest, payload, runner), 23)
        self.assertIn('repos/'+m.REPOSITORY+'/statuses/'+'a'*40, calls[0][0])
        self.assertIn('POST', calls[0][0])
        self.assertEqual(calls[0][1], payload)
        self.assertNotIn('check-runs', str(calls))

    def test_no_publish_flag_never_writes(self):
        manifest = fixture()[0]
        with patch('sys.argv', ['publisher', '--manifest', '/trusted/manifest.json']), \
             patch.object(m, 'load_manifest', return_value=manifest), \
             patch.object(m, 'evaluate', return_value={'state': 'success'}), \
             patch.object(m, 'publish', side_effect=AssertionError('must not write')), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(m.main(), 0)
        self.assertFalse(json.loads(output.getvalue())['published'])

    def test_rejected_evidence_never_reaches_publish(self):
        with patch('sys.argv', ['publisher', '--manifest', '/trusted/manifest.json', '--publish']), \
             patch.object(m, 'load_manifest', return_value=fixture()[0]), \
             patch.object(m, 'evaluate', side_effect=m.EvidenceError('SOURCE_MISMATCH')), \
             patch.object(m, 'publish', side_effect=AssertionError('must not write')), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(m.main(), 2)
        self.assertFalse(json.loads(output.getvalue())['publication_attempted'])

    def test_uncertain_write_is_reported_without_automatic_retry(self):
        with patch('sys.argv', ['publisher', '--manifest', '/trusted/manifest.json', '--publish']), \
             patch.object(m, 'load_manifest', return_value=fixture()[0]), \
             patch.object(m, 'evaluate', return_value={'state': 'success'}), \
             patch.object(m, 'publish', side_effect=m.EvidenceError('READBACK_MISSING')) as write, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(m.main(), 2)
        self.assertEqual(write.call_count, 1)
        result = json.loads(output.getvalue())
        self.assertIsNone(result['published'])
        self.assertEqual(result['status'], 'OUTCOME_UNKNOWN')


if __name__ == '__main__':
    unittest.main()
