import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from ci_release import ReleaseError
spec = importlib.util.spec_from_file_location('device_proxy_deploy', ROOT / 'scripts/deploy-ci-vps.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

ORIGIN = 'https://commerce.example.invalid'
PATH = '/creative-device/v1/assets/00000000-0000-4000-8000-000000000000/access'

class DeviceProxySmokeTests(unittest.TestCase):
    def response(self, status=410, content_type='application/json; charset=utf-8', body=None):
        result = MagicMock()
        result.__enter__.return_value = result
        result.status = status
        result.headers = {'Content-Type': content_type}
        result.read.return_value = body if body is not None else b'{"error":{"code":"PLATFORM_PRODUCTION_RETIRED"}}'
        return result

    def test_read_only_get_reaches_device_gate_and_bounds_response(self):
        response = self.response()
        opener = MagicMock(return_value=response)
        self.assertTrue(deploy.verify_creative_device_routing(ORIGIN, opener))
        opener.assert_called_once_with(ORIGIN + PATH, timeout=30)
        response.read.assert_called_once_with(16385)

    def test_actual_urllib_410_response_is_expected_success(self):
        error = HTTPError(ORIGIN + PATH, 410, 'Gone', {'Content-Type': 'application/json'}, io.BytesIO(b'{"error":{"code":"PLATFORM_PRODUCTION_RETIRED"}}'))
        opener = MagicMock(side_effect=error)
        self.assertTrue(deploy.verify_creative_device_routing(ORIGIN, opener))
        opener.assert_called_once_with(ORIGIN + PATH, timeout=30)

    def test_spa_and_status_errors_do_not_pass_as_device_api(self):
        for status in [200, 404, 500]:
            with self.subTest(status=status), self.assertRaisesRegex(ReleaseError, 'HTTPS_DEVICE_ROUTE_STATUS_FAILED'):
                deploy.verify_creative_device_routing(ORIGIN, MagicMock(return_value=self.response(status=status, body=b'<html>SPA</html>')))
        with self.assertRaisesRegex(ReleaseError, 'HTTPS_DEVICE_ROUTE_CONTENT_TYPE_FAILED'):
            deploy.verify_creative_device_routing(ORIGIN, MagicMock(return_value=self.response(content_type='text/html')))

    def test_invalid_json_wrong_gate_and_large_bodies_fail_closed(self):
        with self.assertRaisesRegex(ReleaseError, 'HTTPS_DEVICE_ROUTE_JSON_FAILED'):
            deploy.verify_creative_device_routing(ORIGIN, MagicMock(return_value=self.response(body=b'<html>SPA</html>')))
        for body in [{}, [], None, {'error': 'PLATFORM_PRODUCTION_RETIRED'}, {'error': {'code': 'INVALID_TOKEN'}}]:
            with self.subTest(body=body), self.assertRaisesRegex(ReleaseError, 'HTTPS_DEVICE_ROUTE_GATE_FAILED'):
                deploy.verify_creative_device_routing(ORIGIN, MagicMock(return_value=self.response(body=json.dumps(body).encode())))
        with self.assertRaisesRegex(ReleaseError, 'HTTPS_DEVICE_ROUTE_RESPONSE_TOO_LARGE'):
            deploy.verify_creative_device_routing(ORIGIN, MagicMock(return_value=self.response(body=b' ' * 16385)))

    def test_templates_route_device_prefix_intact_before_spa(self):
        route = '  handle /creative-device/v1/* {\n    reverse_proxy commerce-api:3001\n  }\n'
        for name in ['commerce.Caddyfile', 'commerce.Caddyfile.example']:
            with self.subTest(name=name):
                source = (ROOT / 'infra/caddy' / name).read_text()
                self.assertEqual(source.count(route), 1)
                self.assertLess(source.index(route), source.index('  handle {\n'))
                self.assertNotIn('handle_path /creative-device', source)

if __name__ == '__main__':
    unittest.main()
