import copy
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_shadow_bootstrap as b


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.moment = datetime(2026, 10, 11, 17, tzinfo=timezone.utc)
        self.inventory = {'project': b.PROJECT, 'project_number': b.PROJECT_NUMBER,
            'regions': ['global', 'us-east1'], 'builds': [{'id': b.KNOWN_BUILD,
                'name': 'projects/' + b.PROJECT_NUMBER + '/locations/us-east1/builds/' + b.KNOWN_BUILD,
                'projectId': b.PROJECT, 'status': 'FAILURE', 'startTime': b.KNOWN_START,
                'finishTime': b.KNOWN_FINISH, 'native_sha256': 'a' * 64}],
            'started_at': '2026-10-11T16:59:50Z', 'observed_at': '2026-10-11T16:59:59Z',
            'response_bytes': 400, 'requests': 3, 'complete': True}
        self.rehash()

    def rehash(self):
        self.inventory['inventory_sha256'] = b.ledger.canonical_hash({key: self.inventory[key]
            for key in ('project', 'project_number', 'regions', 'builds')})

    def manifest_config(self):
        manifest = b.phase_a(self.inventory, moment=self.moment)
        readbacks = {key: {field: row[field] for field in ('bucket', 'object', 'bytes', 'sha256')} |
            {'generation': str(index + 111)} for index, (key, row) in enumerate(manifest['objects'].items())}
        return manifest, readbacks, b.sealed_config(manifest, readbacks)

    def image(self, config):
        return {'uri': b.REGION + '-docker.pkg.dev/' + b.PROJECT + '/commerce-ci-public/controller@sha256:' + 'c' * 64,
            'compressed_bytes': 1000, 'config_sha256': hashlib.sha256(b.encode(config)).hexdigest(),
            'context_sha256': 'd' * 64, 'scan_sha256': 'e' * 64, 'high': 0, 'critical': 0}

    def test_history_is_imported_and_no_build_or_service_in_a(self):
        manifest, _, _ = self.manifest_config()
        self.assertNotIn('service', manifest)
        self.assertEqual(manifest['cloud_builds_admitted'], 0)
        self.assertEqual(manifest['objects']['ledger']['document']['monthly_limit_seconds'], 28800)
        self.assertEqual(manifest['objects']['ledger']['document']['external_builds'][b.KNOWN_BUILD]
            ['observation']['status'], 'FAILURE')
        self.assertEqual(set(manifest['objects']), {'ledger', 'control', 'meter'})

    def test_iam_reads_exact_three_and_writes_only_meter(self):
        manifest, _, _ = self.manifest_config()
        roles = manifest['custom_roles']
        self.assertEqual(roles[0]['includedPermissions'], ['storage.objects.get'])
        self.assertEqual(roles[1]['includedPermissions'], ['storage.objects.create', 'storage.objects.delete'])
        bindings = manifest['bucket_bindings_to_add']
        self.assertEqual(bindings[0]['condition']['expression'].count('resource.name =='), 3)
        self.assertEqual(bindings[1]['condition']['expression'], 'resource.name == "projects/_/buckets/' +
            b.BUCKET + '/objects/' + b.OBJECTS['meter'] + '"')
        self.assertNotIn('roles/storage.admin', str(manifest))

    def test_additional_or_changed_native_history_denied(self):
        for change in ('extra', 'success', 'times', 'incomplete'):
            with self.subTest(change=change):
                self.setUp()
                if change == 'extra': self.inventory['builds'].append(copy.deepcopy(self.inventory['builds'][0]))
                if change == 'success': self.inventory['builds'][0]['status'] = 'SUCCESS'
                if change == 'times': self.inventory['builds'][0]['finishTime'] = '2026-10-10T23:40:00Z'
                if change == 'incomplete': self.inventory['complete'] = False
                self.rehash()
                with self.assertRaises(b.ledger.AdmissionError): b.phase_a(self.inventory, moment=self.moment)

    def test_inventory_timestamp_from_oldest_and_deadline(self):
        self.inventory['started_at'] = '2026-10-11T16:57:59Z'
        with self.assertRaisesRegex(b.ledger.AdmissionError, 'WINDOW_EXPIRED'):
            b.phase_a(self.inventory, moment=self.moment)
        self.setUp()
        with self.assertRaisesRegex(b.ledger.AdmissionError, 'WINDOW_EXPIRED'):
            b.phase_a(self.inventory, moment=datetime(2026, 10, 11, 18, tzinfo=timezone.utc))

    def test_native_generations_and_hashes_required(self):
        manifest, readbacks, _ = self.manifest_config()
        for key, value in (('generation', '0'), ('sha256', '0' * 64), ('bytes', 1), ('bucket', b.SOURCE_BUCKET)):
            altered = copy.deepcopy(readbacks); altered['meter'][key] = value
            with self.assertRaises(b.ledger.AdmissionError): b.sealed_config(manifest, altered)

    def test_initial_state_cannot_open_or_reset_history(self):
        for key, field, value in (('control', 'mode', 'active'), ('ledger', 'external_builds', {})):
            manifest, readbacks, _ = self.manifest_config()
            row = manifest['objects'][key]; row['document'][field] = value
            row['bytes'] = len(b.encode(row['document'])); row['sha256'] = hashlib.sha256(b.encode(row['document'])).hexdigest()
            readbacks[key].update(bytes=row['bytes'], sha256=row['sha256'])
            with self.assertRaises(b.ledger.AdmissionError): b.sealed_config(manifest, readbacks)

    def test_b_requires_exact_sealed_shadow_and_scan(self):
        _, _, config = self.manifest_config()
        for key, value in (('high', 1), ('critical', True), ('config_sha256', 'f' * 64), ('compressed_bytes', 0)):
            image = self.image(config); image[key] = value
            with self.assertRaises(b.ledger.AdmissionError): b.phase_b(config, image, moment=self.moment, operator_account='operator@example.test')
        config['mode'] = 'active'
        with self.assertRaises(b.ledger.AdmissionError): b.phase_b(config, self.image(config), moment=self.moment, operator_account='operator@example.test')

    def test_b_has_private_service_only_and_five_probes(self):
        _, _, config = self.manifest_config()
        manifest = b.phase_b(config, self.image(config), moment=self.moment, operator_account='operator@example.test')
        template = manifest['service']['template']
        self.assertEqual(template['timeout'], '60s')
        self.assertEqual(template['scaling'], {'minInstanceCount': 0, 'maxInstanceCount': 1})
        self.assertFalse(manifest['service']['invokerIamDisabled'])
        self.assertEqual(manifest['probe_contract']['count_max'], 5)
        self.assertIsNone(manifest['scheduler']); self.assertIsNone(manifest['pubsub'])
        self.assertEqual(manifest['builds_admitted'], 0)
        self.assertEqual(config['adoption']['minimum_confirmed_seconds'], 4440)

    def test_b_rejects_other_valid_storage_targets(self):
        for store, field, value in (('ledger', 'bucket', b.SOURCE_BUCKET),
                ('meter', 'object', b.PREFIX + '/other.json'), ('custody', 'prefix', 'other')):
            _, _, config = self.manifest_config()
            config[store][field] = value
            with self.assertRaisesRegex(b.ledger.AdmissionError, 'CUSTODY_CHANGED'):
                b.phase_b(config, self.image(config), moment=self.moment, operator_account='operator@example.test')


if __name__ == '__main__': unittest.main()
