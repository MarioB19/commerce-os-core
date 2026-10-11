import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('additional', ROOT / 'scripts/additional-gateways.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AdditionalGateways(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.path = self.directory / 'additional-gateways.json'
        for slot in ['02', '03']:
            p = self.directory / ('waha-' + slot + '.env')
            p.write_text('WAHA_API_KEY=synthetic-private-test-key\n')
            p.chmod(0o600)
        self.value = module.overlay(['02', '03'], self.directory)
        self.save()

    def save(self):
        self.path.write_text(json.dumps(self.value))
        self.path.chmod(0o600)

    def test_isolation_and_existing_gateway_untouched(self):
        self.assertEqual(module.validate(self.path, self.directory), ['02', '03'])
        self.assertNotIn('waha-01', self.value['services'])
        a, b = [self.value['services']['waha-' + s] for s in ['02', '03']]
        self.assertTrue(set(a['networks']).isdisjoint(b['networks']))
        self.assertTrue(set(a['volumes']).isdisjoint(b['volumes']))
        self.assertNotEqual(a['env_file'], b['env_file'])
        self.assertFalse(a['environment']['WHATSAPP_START_SESSION'])
        self.assertNotIn('ports', a)

    def test_rejects_pilot_duplicates_and_out_of_range(self):
        for slots in [['01'], ['02', '02'], ['21'], [], ['02/../../01']]:
            with self.subTest(slots=slots), self.assertRaises(ValueError):
                module.overlay(slots, self.directory)

    def test_rejects_privileged_changes_or_old_gateway_mutation(self):
        for change in [lambda v: v['services']['waha-02'].update(privileged=True),
                       lambda v: v['services'].update({'waha-01': {}}),
                       lambda v: v['services']['channel-worker'].update(command=['bad']),
                       lambda v: v['services']['waha-02']['environment'].update(WHATSAPP_START_SESSION='default')]:
            self.value = module.overlay(['02', '03'], self.directory)
            change(self.value)
            self.save()
            with self.assertRaises(ValueError):
                module.validate(self.path, self.directory)

    def test_rejects_missing_or_public_credentials(self):
        p = self.directory / 'waha-02.env'
        p.chmod(0o644)
        with self.assertRaises(ValueError):
            module.validate(self.path, self.directory)
        p.unlink()
        with self.assertRaises(ValueError):
            module.validate(self.path, self.directory)

    def test_compose_boundary_includes_overlay_without_starting_services(self):
        pilot = self.directory / 'pilot-release.env'
        pilot.write_text('COMMERCE_GATEWAY_CONFIG_DIR=' + str(self.directory) + '\n')
        release = self.directory / 'release.env'
        release.write_text('COMMERCE_SECRETS_DIR=' + str(self.directory) + '\nCOMMERCE_PILOT_RELEASE_ENV=' + str(pilot) + '\n')
        for name in ['waha-01', 'channel-pilot', 'ingress-pilot']:
            (self.directory / (name + '.env')).write_text('synthetic=yes\n')
        binary = self.directory / 'docker'
        binary.write_text('#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n')
        binary.chmod(0o700)
        result = subprocess.run(['sh', str(ROOT / 'scripts/compose-release.sh'), str(release), 'config', '--quiet'],
                                env={**os.environ, 'PATH': str(self.directory) + ':' + os.environ['PATH']}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(result.stdout)
        self.assertIn(str(self.path), args)
        self.assertEqual(args[-2:], ['config', '--quiet'])
        self.assertNotIn('up', args)

    @unittest.skipUnless(shutil.which('docker'), 'Docker Compose CLI required')
    def test_real_compose_preserves_existing_gateway_and_limits_networks(self):
        for name in ['api', 'ingress', 'automation', 'channel', 'postgres', 'admin', 'waha-01', 'channel-pilot', 'ingress-pilot']:
            (self.directory / (name + '.env')).write_text('SYNTHETIC_TEST=true\n')
        release = self.directory / 'release.env'
        release.write_text('\n'.join([
            'COMMERCE_IMAGE=example/runtime@sha256:' + 'a' * 64,
            'COMMERCE_WEB_IMAGE=example/web@sha256:' + 'b' * 64,
            'COMMERCE_SECRETS_DIR=' + str(self.directory),
            'COMMERCE_PRIVATE_ASSETS_DIR=' + str(self.directory),
            'COMMERCE_GATEWAY_CONFIG_DIR=' + str(self.directory),
            'COMMERCE_PROXY_NETWORK=synthetic-proxy',
            'COMMERCE_ORIGIN=https://example.test',
        ]) + '\n')
        args = ['docker', 'compose', '--env-file', str(release), '-f', str(ROOT / 'infra/compose/production.yaml'), '-f', str(ROOT / 'infra/compose/pilot.yaml'), '--profile', 'waha-pilot']
        before = json.loads(subprocess.check_output(args + ['config', '--format', 'json']))
        after = json.loads(subprocess.check_output(args + ['-f', str(self.path), 'config', '--format', 'json']))
        self.assertEqual(before['services']['waha-01'], after['services']['waha-01'])
        for service in ['api', 'automation-worker', 'web', 'postgres']:
            self.assertEqual(before['services'][service], after['services'][service])
        for slot in ['02', '03']:
            service = after['services']['waha-' + slot]
            self.assertEqual(set(service['networks']), {'gateway-' + slot})
            self.assertNotIn('ports', service)
            self.assertEqual(int(service['mem_limit']), 768 * 1024 * 1024)
        for worker in ['channel-worker', 'ingress']:
            self.assertEqual(set(after['services'][worker]['networks']) - set(before['services'][worker]['networks']), {'gateway-02', 'gateway-03'})


if __name__ == '__main__':
    unittest.main()
