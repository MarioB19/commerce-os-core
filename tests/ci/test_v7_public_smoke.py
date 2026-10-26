"""Public smoke: status and content type per route (V7.1, 25-oct-2026)."""
import io
import json
from pathlib import Path
import sys
import unittest
import urllib.error

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'scripts'))
import v7_public_smoke as smoke  # noqa: E402

SHA = 'f'*40


class Response(io.BytesIO):
    def __init__(self, status, content_type, body):
        super().__init__(body); self.status = status; self.headers = {'Content-Type': content_type}


def opener(table):
    def open_(request, timeout):
        path = request.full_url.removeprefix(smoke.ORIGIN)
        status, content_type, body = table[path]
        if status >= 400:
            raise urllib.error.HTTPError(request.full_url, status, 'x', {'Content-Type': content_type}, io.BytesIO(body))
        return Response(status, content_type, body)
    return open_


GOOD = {
    '/api/version': (200, 'application/json; charset=utf-8', json.dumps({'sha': SHA}).encode()),
    '/v2/me': (401, 'application/json; charset=utf-8', b'{"error":"UNAUTHENTICATED"}'),
    '/v1/me': (401, 'application/json; charset=utf-8', b'{"error":"UNAUTHENTICATED"}'),
    '/healthz/platform': (200, 'application/json; charset=utf-8', b'{"status":"ok","service":"platform","problems":[]}'),
    '/livez': (200, 'application/json; charset=utf-8', b'{"ok":true}'),
    '/readyz': (200, 'application/json; charset=utf-8', b'{"ok":true}'),
    '/': (200, 'text/html; charset=utf-8', b'<!doctype html>'),
}


class PublicSmoke(unittest.TestCase):
    def run_smoke(self, **changes):
        return smoke.smoke(SHA, opener=opener(dict(GOOD, **changes)))

    def test_all_routes_pass(self):
        report = self.run_smoke()
        self.assertEqual(report['state'], 'PUBLIC_SMOKE_PASSED'); self.assertTrue(report['platform_healthy'])

    def test_spa_fallback_html_200_is_a_failure(self):
        """21-oct: /v2/me and /healthz/platform answered the web's HTML with 200."""
        for path in ('/v2/me', '/healthz/platform'):
            with self.subTest(path=path):
                report = self.run_smoke(**{path: (200, 'text/html; charset=utf-8', b'<!doctype html>')})
                failed = next(r for r in report['checks'] if r['path'] == path)
                self.assertEqual(report['state'], 'PUBLIC_SMOKE_FAILED')
                self.assertIn('CONTENT_TYPE_UNEXPECTED', failed['problems'])

    def test_degraded_platform_is_reported_but_routed(self):
        report = self.run_smoke(**{'/healthz/platform': (503, 'application/json', b'{"status":"degraded","service":"platform","problems":["FULL_BACKUP_STALE"]}')})
        self.assertEqual(report['state'], 'PUBLIC_SMOKE_PASSED'); self.assertFalse(report['platform_healthy'])
        check = next(r for r in report['checks'] if r['path'] == '/healthz/platform')
        self.assertEqual(check['platform_problems'], ['FULL_BACKUP_STALE'])

    def test_other_served_release_fails(self):
        report = self.run_smoke(**{'/api/version': (200, 'application/json', json.dumps({'sha': 'e'*40}).encode())})
        self.assertIn('SERVED_SHA_DIFFERS', report['checks'][0]['problems'])

    def test_inconsistent_platform_body_and_bad_json_fail(self):
        self.assertEqual(self.run_smoke(**{'/healthz/platform': (200, 'application/json', b'{"status":"degraded"}')})['state'], 'PUBLIC_SMOKE_FAILED')
        self.assertEqual(self.run_smoke(**{'/v2/me': (401, 'application/json', b'<html>')})['state'], 'PUBLIC_SMOKE_FAILED')

    def test_requires_a_full_sha(self):
        with self.assertRaises(SystemExit):
            smoke.smoke('f0d71880', opener=opener(GOOD))


if __name__ == '__main__':
    unittest.main()
