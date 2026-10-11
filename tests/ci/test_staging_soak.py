import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('staging_start', ROOT / 'scripts/start-staging-soak.py')
staging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(staging)


class StagingSoakTests(unittest.TestCase):
    def test_low_capacity_does_not_create_configuration_or_start_containers(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory)
            def forbidden(*_):
                self.fail('Docker must not run without spare capacity')
            result = staging.start(ROOT, private, 'a' * 40, forbidden, 100, 2 * 1024**3)
            self.assertEqual(result['status'], 'DEFERRED_CAPACITY')
            self.assertEqual(list(private.iterdir()), [])

    def test_existing_observation_keeps_source_image_and_continuous_state(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory)
            target = private / 'staging-soak'
            target.mkdir()
            previous = {'source_sha': 'a' * 40, 'runtime_image': 'sha256:' + 'c' * 64, 'started_at': '2026-09-08T00:00:00Z'}
            manifest = target / 'observation.json'
            manifest.write_text(json.dumps(previous))
            before = manifest.read_bytes()
            def forbidden(*_):
                self.fail('A later deploy must not restart or replace existing observation')
            result = staging.start(ROOT, private, 'b' * 40, forbidden)
            self.assertEqual(result['source_sha'], previous['source_sha'])
            self.assertEqual(result['requested_source_sha'], 'b' * 40)
            self.assertEqual(manifest.read_bytes(), before)

    def test_isolated_start_uses_new_secrets_and_stops_if_network_is_not_internal(self):
        for internal in (False, True):
            with self.subTest(internal=internal), tempfile.TemporaryDirectory() as directory:
                private = Path(directory)
                (private / 'release.env').write_text('COMMERCE_IMAGE=sha256:' + 'c' * 64 + '\n')
                (private / 'api.env').write_text('PRIVATE_SENTINEL=must-never-copy\n')
                calls = []
                def execute(args, _):
                    calls.append(args)
                    if args[:3] == ['docker', 'image', 'inspect']:
                        return json.dumps([{'Id': 'sha256:' + 'c' * 64, 'Os': 'linux', 'Architecture': 'amd64'}])
                    if args[:3] == ['docker', 'network', 'inspect']:
                        return json.dumps([{'Internal': internal}])
                    if args[-3:] == ['ps', '-q', 'observer']:
                        return 'isolated-observer'
                    if args[:2] == ['docker', 'inspect']:
                        return json.dumps([{'Image': 'sha256:' + 'c' * 64, 'State': {'Running': True, 'StartedAt': '2026-09-08T00:00:00Z'}, 'HostConfig': {'PortBindings': {}}}])
                    if args[-1] == "SELECT to_regclass('public.staging_soak_state') IS NOT NULL":
                        return 't'
                    if args[-1] == 'SELECT row_to_json(s) FROM staging_soak_state s':
                        return json.dumps({'started_at': '2026-09-08T00:00:00Z', 'samples': 1, 'failures': 0, 'observed_seconds': 0, 'status': 'RUNNING'})
                    return ''
                if internal:
                    result = staging.start(ROOT, private, 'a' * 40, execute, 2 * 1024**3, 2 * 1024**3)
                    self.assertEqual(result['completion'], 'PENDING_ACTUAL_OBSERVATION')
                else:
                    with self.assertRaisesRegex(RuntimeError, 'STAGING_NETWORK_ISOLATION_FAILED'):
                        staging.start(ROOT, private, 'a' * 40, execute, 2 * 1024**3, 2 * 1024**3)
                    self.assertEqual(calls[-1][-1], 'stop')
                    self.assertFalse((private / 'staging-soak/observation.json').exists())
                config = (private / 'staging-soak/soak.env').read_text()
                self.assertIn('/commerce_staging_soak', config)
                self.assertIn('REAL_SENDS_ENABLED=false', config)
                self.assertNotIn('must-never-copy', config)
                self.assertEqual((private / 'staging-soak/soak.env').stat().st_mode & 0o777, 0o600)
                self.assertEqual((private / 'api.env').read_text(), 'PRIVATE_SENTINEL=must-never-copy\n')


if __name__ == '__main__':
    unittest.main()
