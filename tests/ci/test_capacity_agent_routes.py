"""Every HTTP path the host capacity agent calls must exist in the installed API.

V7 F8-D retired most of /v1; the bounded administrator kept reading
GET /v1/number-operations/:id, so no reviewed capacity operation could be
applied in production. This contract reads the scripts and the API sources
statically: no network, Docker or database."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = {
    'scripts/number-capacity-administrator.py': ('/v1', re.compile(r"self\.api\('(/[^'?]*)'(\s*\+)?")),
    'scripts/gateway_supervisor.py': ('/v1', re.compile(r"admin\.api\('(/[^'?]*)'(\s*\+)?")),
}
PLATFORM_CALL = re.compile(r"self\.call\('(GET|POST|PUT|PATCH|DELETE)',\s*'(/[^'?]*)'")
ROUTE = re.compile(r"app\.(?:get|post|put|patch|delete)\('(/v[12]/[^']*)'")


def normalize(path):
    return re.sub(r':[A-Za-z_]+', ':param', path.rstrip('/'))


def api_routes():
    routes = set()
    for source in (ROOT / 'apps/api/src').glob('*.ts'):
        if source.name.endswith('.test.ts'):
            continue
        routes.update(normalize(path) for path in ROUTE.findall(source.read_text()))
    return routes


def called_paths():
    paths = set()
    for name, (prefix, pattern) in SCRIPTS.items():
        for path, concatenated in pattern.findall((ROOT / name).read_text()):
            full = prefix + path
            if concatenated:
                # '/x/' + id -> '/x/:param'; '/x/waha:' + ref -> '/x/:param' (the dynamic part completes the segment)
                full = full.rsplit('/', 1)[0] + '/:param'
            paths.add((name, normalize(full)))
    for _method, path in PLATFORM_CALL.findall((ROOT / 'scripts/gateway_supervisor.py').read_text()):
        paths.add(('scripts/gateway_supervisor.py', normalize(path)))
    return paths


class CapacityAgentRouteContract(unittest.TestCase):
    def test_every_agent_call_targets_a_registered_route(self):
        routes = api_routes()
        self.assertIn('/v1/number-capacity/administration/:param', routes)
        missing = sorted((name, path) for name, path in called_paths() if path not in routes)
        self.assertEqual(missing, [], 'capacity agent calls retired or unknown API routes')

    def test_contract_sees_the_calls_it_guards(self):
        paths = {path for _, path in called_paths()}
        for expected in ('/v1/number-capacity', '/v1/number-capacity/administration', '/v1/number-capacity/administration/:param',
                         '/v1/number-capacity/inventory', '/v1/number-capacity/measurements', '/v1/settings/integrations',
                         '/v1/settings/integrations/:param', '/v2/platform/profiles', '/v2/platform/capacity/agent-tokens'):
            self.assertIn(expected, paths)


if __name__ == '__main__':
    unittest.main()
