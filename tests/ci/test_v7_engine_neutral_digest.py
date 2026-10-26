"""Engine-neutral definition digests and update continuity (V7.1, 25-oct-2026).

Docker 29 reports an unset Dns/DnsOptions/DnsSearch list as null for a container
the running daemon created and as [] once the daemon restarted. On 21-oct the
readopción stopped on V7_ADOPTION_DEFINITION_CHANGED:api only for that. The
stored digests are mixed: the containers the V7 installer recreated were stored
with null, the preserved ones (caddy, portal, gateways, the 6-oct PostgreSQL)
with []. These tests run the previous version's stored state against the
current verifiers. See docs/adr-v7-engine-neutral-dns.md."""
import contextlib
import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'scripts'), str(ROOT/'tests/ci')]
import copy_runtime_deployment as runtime  # noqa: E402
import b02_backup_contract as b02  # noqa: E402
from ci_release import ReleaseError  # noqa: E402

spec = importlib.util.spec_from_file_location('adoption_fixture', ROOT/'tests/ci/test_v7_infra_adoption.py')
ad = importlib.util.module_from_spec(spec); spec.loader.exec_module(ad)
REAL = json.loads((ROOT/'tests/fixtures/docker-hostconfig-dns-encoding.json').read_text())
BEFORE, AFTER = 'captured_2026_10_21_before_daemon_restart', 'inspected_after_daemon_restart'
APPS = ('api', 'web', 'ingress', 'automation-worker', 'channel-worker')


def legacy_digest(row):
    """definition_digest as the V7 release (f0d71880) computed and stored it."""
    return runtime.sha256(runtime.sealed_bytes(runtime.static_projection(row)))


def encode(row, value):
    row = copy.deepcopy(row)
    for key in runtime.ENGINE_UNSET_HOST_LISTS:
        if value == 'absent':
            row['HostConfig'].pop(key, None)
        else:
            row['HostConfig'][key] = copy.deepcopy(value)
    return row


def with_host(row, host):
    return dict(copy.deepcopy(row), HostConfig=copy.deepcopy(host))


class RealInspect(unittest.TestCase):
    def setUp(self):
        _state, rows, _ = ad.fx.fixture(1)
        self.row = rows[0]

    def test_the_only_difference_after_the_restart_is_the_dns_encoding(self):
        before, after = REAL['api'][BEFORE], REAL['api'][AFTER]
        self.assertEqual({k for k in set(before) | set(after) if before.get(k) != after.get(k)}, set(runtime.ENGINE_UNSET_HOST_LISTS))
        self.assertEqual((before['Dns'], after['Dns']), (None, []))
        self.assertEqual(REAL['caddy'][BEFORE], REAL['caddy'][AFTER])

    def test_previous_digest_still_matches_and_the_canonical_one_is_shared(self):
        before, after = with_host(self.row, REAL['api'][BEFORE]), with_host(self.row, REAL['api'][AFTER])
        self.assertNotEqual(legacy_digest(before), legacy_digest(after))  # the 21-oct failure
        self.assertEqual(runtime.definition_digest(before), runtime.definition_digest(after))
        self.assertTrue(runtime.definition_digest_matches(after, legacy_digest(before)))
        self.assertTrue(runtime.definition_digest_matches(before, legacy_digest(after)))
        self.assertTrue(b02.projection_matches(after, legacy_digest(before), 2))
        self.assertEqual(b02.projection_digest(before, 2), legacy_digest(before))  # B02 v2 is the same projection
        # The canonical digest is the null encoding: the app containers' stored digests stay valid as written.
        self.assertEqual(runtime.definition_digest(after), legacy_digest(before))
        caddy = with_host(self.row, REAL['caddy'][AFTER])
        self.assertTrue(runtime.definition_digest_matches(caddy, legacy_digest(caddy)))
        self.assertNotEqual(runtime.definition_digest(caddy), legacy_digest(caddy))

    def test_a_real_dns_value_never_matches(self):
        stored = legacy_digest(with_host(self.row, REAL['api'][BEFORE]))
        for key, value in (('Dns', ['10.128.0.2']), ('DnsOptions', ['ndots:1']), ('DnsSearch', ['c.internal'])):
            host = dict(REAL['api'][AFTER], **{key: value})
            with self.subTest(key=key):
                self.assertFalse(runtime.definition_digest_matches(with_host(self.row, host), stored))
                self.assertFalse(b02.projection_matches(with_host(self.row, host), stored, 2))

    def test_every_encoding_matches_and_other_fields_still_count(self):
        stored = legacy_digest(encode(self.row, []))
        for value in (None, [], 'absent'):
            with self.subTest(encoding=value):
                self.assertTrue(runtime.definition_digest_matches(encode(self.row, value), stored))
        changed = encode(self.row, None); changed['HostConfig']['CapAdd'] = ['NET_ADMIN']
        self.assertFalse(runtime.definition_digest_matches(changed, stored))
        self.assertFalse(runtime.definition_digest_matches(self.row, None))
        mixed = encode(self.row, []); mixed['HostConfig']['DnsSearch'] = None
        self.assertTrue(runtime.definition_digest_matches(mixed, stored))

    def test_preserved_digest_keeps_a_matching_stored_value(self):
        stored = legacy_digest(encode(self.row, []))
        self.assertEqual(runtime.preserved_digest(encode(self.row, None), stored), stored)
        self.assertEqual(runtime.preserved_digest(encode(self.row, None), None), runtime.definition_digest(self.row))
        real = encode(self.row, None); real['HostConfig']['Dns'] = ['10.128.0.2']
        self.assertEqual(runtime.preserved_digest(real, stored), runtime.definition_digest(real))


def production_like_baseline():
    """The V7 install as stored on 21-oct: app containers null, the rest [], digests by the previous code."""
    original = ad.fx.fixture

    def fixture(gateways=0):
        state, rows, extra = original(gateways)
        for row in rows:
            name = row['Config']['Labels'].get('com.docker.compose.service') or ('caddy' if row['Name'] == '/synthetic-caddy' else 'portal')
            row.update(encode(row, None if name in APPS else []))
        return state, rows, extra
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.object(ad.fx, 'fixture', fixture))
        stack.enter_context(mock.patch.object(runtime, 'definition_digest', legacy_digest))
        return ad.baseline()


class UpdateContinuity(unittest.TestCase):
    """The previous version's stored state, read by this version after daemon restarts."""

    def restarted(self, b, value):
        return [encode(row, value) for row in b['rows']]

    def test_readoption_is_an_identity_after_a_daemon_restart(self):
        b = production_like_baseline()
        with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_DEFINITION_CHANGED:api'):
            with mock.patch.object(runtime, 'definition_digest_matches', lambda row, stored: legacy_digest(row) == stored):
                ad.run(b, rows=self.restarted(b, []))  # what f0d71880 did
        for value in ([], None, 'absent'):
            with self.subTest(encoding=value):
                proposal, docs = ad.run(b, rows=self.restarted(b, value))
                self.assertEqual(proposal['summary']['recreated'], {})
                self.assertEqual(json.loads(docs['state'])['preserved_runtime'], b['state']['preserved_runtime'])
                plan = json.loads(docs['plan'])
                self.assertEqual(plan['preserved_runtime'], b['state']['preserved_runtime'])

    def test_readoption_rejects_a_real_dns_change(self):
        b = production_like_baseline()
        rows = self.restarted(b, [])
        api = next(row for row in rows if row['Id'] == b['by']['api']['Id'])
        api['HostConfig']['Dns'] = ['10.128.0.2']
        with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_DEFINITION_CHANGED:api'):
            ad.run(b, rows=rows)

    def test_installer_inventory_accepts_the_previous_state_after_a_restart(self):
        b = production_like_baseline()
        state = b['state']
        for value in ([], None):
            with self.subTest(encoding=value), mock.patch.object(runtime, 'validate_state', lambda _state: None):
                services = runtime.validate_inventory(state, self.restarted(b, value))
                self.assertEqual({row['Id'] for row in services.values()}, set(state['preserved_runtime']))
        rows = self.restarted(b, [])
        next(row for row in rows if row['Id'] == b['by']['caddy']['Id'])['HostConfig']['DnsSearch'] = ['corp']
        with mock.patch.object(runtime, 'validate_state', lambda _state: None), \
                self.assertRaisesRegex(ReleaseError, 'COPY_RUNTIME_STATIC_DEFINITION_CHANGED'):
            runtime.validate_inventory(state, rows)

    def test_b02_runtime_guard_accepts_the_adopted_digests_after_a_restart(self):
        b = production_like_baseline()
        for row in self.restarted(b, []):
            with self.subTest(container=row['Name']):
                self.assertTrue(b02.projection_matches(row, b['state']['preserved_runtime'][row['Id']], 2))
                self.assertFalse(b02.projection_matches(row, b['state']['preserved_runtime'][row['Id']], 1))


if __name__ == '__main__':
    unittest.main()
