"""Proxy as code (V7.1, 25-oct-2026): every API path the web calls and every API
health route must reach commerce-api through the commerce site, never the SPA
fallback. On 21-oct the production proxy sent /v2/* to the web (HTML 200 and a
broken login), and /healthz/platform was never routed (the uptime check would
have read the SPA). The check runs on the repository template and on what
update-identity-proxy.py makes of a V5-shaped site."""
import importlib.util
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('identity_proxy_routes', ROOT/'scripts'/'update-identity-proxy.py')
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)

API = 'commerce-api:3001'
WEB = 'commerce-web:8080'
V5_SITE = b'''commerce-os.inovaris.online {
  header {
    X-Content-Type-Options nosniff
    Referrer-Policy same-origin
    Content-Security-Policy "''' + proxy.CSP_BEFORE + b'''"
  }
  handle /webhooks/cloud/* {
    reverse_proxy commerce-ingress:3002
  }
  handle /v1/* {
    reverse_proxy commerce-api:3001
  }
  handle /api/auth/* {
    reverse_proxy commerce-api:3001
  }
  @health path /livez /readyz
  handle @health {
    reverse_proxy commerce-api:3001
  }
  handle {
    reverse_proxy commerce-web:8080
  }
}
'''


def site_routes(source, host=proxy.HOST):
    """(patterns, upstream) for each handle of the one commerce site, fallback last."""
    items = proxy.tokens(source)
    depth, start = 0, None
    for i, token in enumerate(items):
        if token.kind == 'bare' and token.raw == b'{':
            if depth == 0 and i > 0 and items[i - 1].raw == host:
                start = i
            depth += 1
        elif token.kind == 'bare' and token.raw == b'}':
            depth -= 1
            if depth == 0 and start is not None:
                end = i
                break
    else:
        raise AssertionError('commerce site not found')
    matchers, routes, i = {}, [], start + 1
    while i < end:
        token = items[i]
        if token.raw.startswith(b'@') and items[i + 1].raw == b'path' and items[i + 1].line == token.line:
            j = i + 2
            while j < end and items[j].line == token.line:
                j += 1
            matchers[token.raw] = [t.raw.decode() for t in items[i + 2:j]]
            i = j
            continue
        if token.raw == b'handle':
            opening = i + 1 if items[i + 1].raw == b'{' else i + 2
            argument = None if opening == i + 1 else items[i + 1].raw
            body = []
            k = opening + 1
            while items[k].raw != b'}':
                body.append(items[k].raw.decode())
                k += 1
            upstream = body[1] if body[:1] == ['reverse_proxy'] and len(body) == 2 else ' '.join(body)
            patterns = None if argument is None else (matchers[argument] if argument.startswith(b'@') else [argument.decode()])
            routes.append((patterns, upstream))
            i = k + 1
            continue
        i += 1
    return routes


def upstream_for(routes, path):
    """Caddy's mutually exclusive handles: the most specific matching pattern wins; no matcher is the fallback."""
    best = None
    for patterns, upstream in routes:
        for pattern in patterns or []:
            hit = path.startswith(pattern[:-1]) if pattern.endswith('*') else path == pattern
            if hit and (best is None or len(pattern) > best[0]):
                best = (len(pattern), upstream)
    if best:
        return best[1]
    fallbacks = [upstream for patterns, upstream in routes if patterns is None]
    assert len(fallbacks) == 1, fallbacks
    return fallbacks[0]


def web_api_paths():
    """One sample path per API namespace the web source calls."""
    found = set()
    for path in (ROOT/'apps/web/src').rglob('*.ts*'):
        if path.name.endswith(('.test.ts', '.test.tsx')):
            continue
        # The literal up to its first interpolation or quote, e.g. /api/auth/sign-in/email or /v2/me.
        for literal in re.findall(r"""["'`](/(?:v1|v2|api)/[A-Za-z0-9_\-/.]*)""", path.read_text()):
            if literal == '/api/':  # a prefix test in lib/api.ts, not a call; the web calls /api/auth/* and /api/version
                continue
            found.add(literal if not literal.endswith('/') else literal + 'sample')
    return sorted(found)


def api_health_routes():
    routes = set()
    for path in (ROOT/'apps/api/src').rglob('*.ts'):
        routes.update(re.findall(r"""app\.get\(['"](/(?:livez|readyz|healthz[^'"]*))['"]""", path.read_text()))
    return sorted(routes)


class RouteCoverage(unittest.TestCase):
    def test_the_inventory_is_not_empty(self):
        paths, health = web_api_paths(), api_health_routes()
        self.assertTrue(any(p.startswith('/v2/') for p in paths) and any(p.startswith('/api/auth') for p in paths), paths)
        self.assertEqual(set(health) >= {'/livez', '/readyz', '/healthz/platform'}, True, health)

    def check(self, source):
        routes = site_routes(source)
        required = web_api_paths() + ['/v1/me', '/v2/me', '/api/auth/session', '/api/version'] + api_health_routes()
        for path in required:
            with self.subTest(path=path):
                self.assertEqual(upstream_for(routes, path), API)
        # The web itself still owns its pages.
        for page in ('/', '/login', '/platform', '/healthz', '/v2'):
            with self.subTest(page=page):
                self.assertEqual(upstream_for(routes, page), WEB)

    def test_repository_template(self):
        for name in ('commerce.Caddyfile', 'commerce.Caddyfile.example'):
            source = (ROOT/'infra/caddy'/name).read_bytes()
            if name.endswith('.example'):
                source = source.replace(b'commerce.example.com', proxy.HOST)
            with self.subTest(name=name):
                self.check(source)

    def test_production_site_after_the_identity_proxy_rewrite(self):
        rewritten = proxy.rewrite_policy(V5_SITE)
        self.check(rewritten)
        self.assertEqual(proxy.rewrite_policy(rewritten), rewritten)

    def test_the_v5_site_alone_is_not_enough(self):
        """Documents the two 21-oct gaps: /v2/* and /healthz/platform fell into the SPA."""
        routes = site_routes(V5_SITE)
        self.assertEqual(upstream_for(routes, '/v2/me'), WEB)
        self.assertEqual(upstream_for(routes, '/healthz/platform'), WEB)


if __name__ == '__main__':
    unittest.main()
