import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class ProductionResourceProfileTests(unittest.TestCase):
    def rendered_services(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory)
            for name in ('postgres', 'api', 'ingress', 'automation', 'channel'):
                (private / f'{name}.env').touch()
            environment = {
                **os.environ,
                'COMMERCE_IMAGE': 'sha256:' + 'a' * 64,
                'COMMERCE_WEB_IMAGE': 'sha256:' + 'b' * 64,
                'COMMERCE_SECRETS_DIR': str(private),
                'COMMERCE_PRIVATE_ASSETS_DIR': '/private-assets',
                'COMMERCE_PROXY_NETWORK': 'private-proxy',
            }
            result = subprocess.run(
                ['docker', 'compose', '-f', 'infra/compose/production.yaml', 'config', '--format', 'json'],
                cwd=ROOT,
                env=environment,
                check=True,
                capture_output=True,
                text=True,
            )
            return json.loads(result.stdout)['services']

    def test_n1_standard_4_profile_and_bounded_database_connections(self):
        services = self.rendered_services()
        expected = {
            'postgres': (1.6, 2 * 1024**3),
            'api': (0.6, 512 * 1024**2),
            'ingress': (0.4, 384 * 1024**2),
            'automation-worker': (0.8, 768 * 1024**2),
            'channel-worker': (0.7, 512 * 1024**2),
        }
        for service, (cpus, memory) in expected.items():
            with self.subTest(service=service):
                self.assertEqual(services[service]['cpus'], cpus)
                self.assertEqual(int(services[service]['mem_limit']), memory)
        self.assertEqual(services['postgres']['shm_size'], str(512 * 1024**2))
        self.assertEqual(
            services['postgres']['command'],
            ['postgres', '-c', 'max_connections=80', '-c', 'shared_buffers=512MB'],
        )
        self.assertEqual(services['api']['environment']['DB_POOL_MAX'], '5')
        self.assertEqual(services['ingress']['environment']['DB_POOL_MAX'], '3')
        self.assertEqual(services['automation-worker']['environment']['DB_POOL_MAX'], '5')
        self.assertEqual(services['channel-worker']['environment']['DB_POOL_MAX'], '5')

    def test_maintenance_entrypoint_has_valid_shell_syntax(self):
        result = subprocess.run(
            ['sh', '-n', 'scripts/apply-production-resource-profile.sh'],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
