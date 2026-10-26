#!/usr/bin/env python3
"""Read-only public smoke after a V7 installation (V7.1, 25-oct-2026).

The 21-oct window reported "200" for routes the entry proxy did not send to the
API: the SPA fallback answered HTML 200 for /v2/me and /healthz/platform. This
smoke checks status *and* content type of each public route, and that the
served release is the expected one. It sends no credentials and changes nothing.

Usage: v7_public_smoke.py <expected-sha> [--origin https://commerce-os.inovaris.online]
Prints one JSON report; exit 0 only when every check passes.
"""
import json
import re
import sys
import urllib.error
import urllib.request

ORIGIN = 'https://commerce-os.inovaris.online'
MAX_BODY = 65536
# path -> (accepted statuses, content type family, JSON check)
CHECKS = {
    '/api/version': ({200}, 'json', 'release'),
    '/v2/me': ({401}, 'json', None),
    '/v1/me': ({401}, 'json', None),
    '/healthz/platform': ({200, 503}, 'json', 'platform'),
    '/livez': ({200}, 'json', None),
    '/readyz': ({200}, 'json', None),
    '/': ({200}, 'html', None),
}


def fetch(url, opener=urllib.request.urlopen):
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'Accept': '*/*'})
    try:
        response = opener(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    except (urllib.error.URLError, OSError, TimeoutError):
        return 0, '', b''  # unreachable: reported as STATUS_UNEXPECTED, never raised
    with response:
        return response.status, response.headers.get('Content-Type', ''), response.read(MAX_BODY + 1)


def family(content_type):
    media = content_type.split(';', 1)[0].strip().lower()
    return 'json' if media == 'application/json' else 'html' if media == 'text/html' else media or 'none'


def check(path, status, content_type, body, expected_sha):
    statuses, wanted, kind = CHECKS[path]
    result = {'path': path, 'status': status, 'content_type': family(content_type), 'ok': True, 'problems': []}
    if status not in statuses:
        result['problems'].append('STATUS_UNEXPECTED')
    if result['content_type'] != wanted:
        result['problems'].append('CONTENT_TYPE_UNEXPECTED')
    if len(body) > MAX_BODY:
        result['problems'].append('BODY_TOO_LARGE')
    if wanted == 'json' and not result['problems']:
        try:
            value = json.loads(body)
        except ValueError:
            value = None
            result['problems'].append('JSON_INVALID')
        if kind == 'release' and isinstance(value, dict):
            result['sha'] = value.get('sha')
            if value.get('sha') != expected_sha:
                result['problems'].append('SERVED_SHA_DIFFERS')
        if kind == 'platform' and isinstance(value, dict):
            result['platform_status'] = value.get('status')
            result['platform_problems'] = [p for p in value.get('problems', []) if isinstance(p, str) and re.fullmatch(r'[A-Z_]{1,64}', p)]
            if (status == 200) != (value.get('status') == 'ok'):
                result['problems'].append('PLATFORM_STATUS_INCONSISTENT')
    result['ok'] = not result['problems']
    return result


def smoke(expected_sha, origin=ORIGIN, opener=urllib.request.urlopen):
    if not re.fullmatch(r'[a-f0-9]{40}', expected_sha or ''):
        raise SystemExit('usage: v7_public_smoke.py <expected 40-hex sha> [--origin URL]')
    results = [check(path, *fetch(origin + path, opener), expected_sha) for path in CHECKS]
    healthy = next(r for r in results if r['path'] == '/healthz/platform').get('platform_status') == 'ok'
    return {'state': 'PUBLIC_SMOKE_PASSED' if all(r['ok'] for r in results) else 'PUBLIC_SMOKE_FAILED',
            'origin': origin, 'expected_sha': expected_sha, 'platform_healthy': healthy, 'checks': results}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    origin = ORIGIN
    if '--origin' in argv:
        index = argv.index('--origin')
        origin = argv[index + 1].rstrip('/')
        del argv[index:index + 2]
    report = smoke(argv[0] if argv else '', origin)
    print(json.dumps(report, sort_keys=True))
    return 0 if report['state'] == 'PUBLIC_SMOKE_PASSED' else 1


if __name__ == '__main__':
    sys.exit(main())
