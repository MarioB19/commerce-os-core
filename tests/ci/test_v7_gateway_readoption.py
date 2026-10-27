"""V7.1.1 (27-oct-2026): the Root re-adoption adopts canonical gateways added after the baseline.

The V7.1 window enabled the gateway supervisor, which keeps one prepared spare slot per
active profile. Its first cycle on 27-oct added waha-02 and waha-04 through one canonical
EXPAND (succeeded, verified, zero sessions) and rewrote the shared overlay that the
waha-03 receipt points at. From then on the installer, B02 and the durable boot refused
the host (12 containers, 9 networks, a stale overlay reference) and the re-adoption tool
could not run either. These tests fix the narrow rule that adopts exactly that.
"""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'scripts'), str(ROOT/'tests/ci')]
import api_web_deployment as native  # noqa: E402
import b02_backup_contract as contract  # noqa: E402
import copy_runtime_deployment as runtime  # noqa: E402
from ci_release import ReleaseError  # noqa: E402
import v7_infra_adoption as m  # noqa: E402

spec = importlib.util.spec_from_file_location('v7_adoption_fixture', ROOT/'tests/ci/test_v7_infra_adoption.py')
ax = importlib.util.module_from_spec(spec); spec.loader.exec_module(ax)
fx = ax.fx

OP = '00000000-0000-4000-8000-000000000265'
OVERLAY = b'{"services":{"waha-02":{"image":"synthetic"}}}\n'
OLD_OVERLAY = b'{"services":{}}\n'


def bridge_row(name, index):
    return {'Name': name, 'Id': fx.checksum(index), 'Driver': 'bridge', 'Internal': False, 'EnableIPv6': False,
            'IPAM': {}, 'Options': {}, 'Labels': {'com.docker.compose.project': 'commerce-os',
                                                   'com.docker.compose.network': name[len('commerce-os_'):]}}


def supervisor_added(b, name='waha-02', index=420):
    """The host after one canonical EXPAND: the gateway, its bridge on ingress and channel-worker."""
    bridge = 'commerce-os_gateway-'+name[-2:]
    gateway = copy.deepcopy(b['by']['waha-01'])
    gateway['Id'] = fx.checksum(index); gateway['Name'] = '/synthetic-'+name
    gateway['Config']['Labels']['com.docker.compose.service'] = name
    gateway['NetworkSettings']['Networks'] = {bridge: {'NetworkID': fx.checksum(index+1), 'Aliases': [name], 'GwPriority': 0}}
    rows = []
    for row in b['rows']:
        row = copy.deepcopy(row)
        if row['Config']['Labels'].get('com.docker.compose.service') in m.GATEWAY_CONSUMERS:
            row['NetworkSettings']['Networks'][bridge] = {'NetworkID': fx.checksum(index+1), 'Aliases': [], 'GwPriority': 0}
        rows.append(row)
    rows.append(gateway)
    networks = dict(b['networks'], **{bridge: bridge_row(bridge, index+1)})
    source = native.reference(m.SHARED_OVERLAY, OVERLAY)
    receipts = copy.deepcopy(b['state']['gateway_provisioning'])
    receipts[name] = {'operation_id': OP, 'slot': int(name[-2:]), 'overlay_ref': m.pinned_overlay(source),
                      'definition_sha256': runtime.definition_digest(gateway)}
    return rows, networks, {'receipts': receipts, 'pins': {m.pinned_overlay(source)['path']: source}, 'since_release': [name]}


def run(b, rows, networks, gateways, files=None):
    return m.propose(b['capture'], b['state_raw'], b['plan_raw'], b['policy'], rows, networks,
                     files or b['files'], None, {}, gateways=gateways)


class BoundsTests(unittest.TestCase):
    def test_six_canonical_gateways_and_their_bridges_fit_every_bound(self):
        self.assertEqual(runtime.GATEWAYS, frozenset('waha-0'+str(i) for i in range(1, 7)))
        self.assertEqual(contract.GATEWAY_NAMES, runtime.GATEWAYS)
        self.assertEqual((runtime.MAX_CONTAINERS, runtime.MAX_NETWORKS), (14, 11))
        state, rows, raw = fx.fixture(6)
        self.assertEqual(len(runtime.validate_inventory(state, rows)), 14)
        plan = json.loads(raw)
        with mock.patch.object(contract, 'validate_portal_backup', lambda value: value):
            self.assertEqual(contract.plan_version(plan), 3)
            plan['preserved_runtime']['f'*64] = 'e'*64
            with self.assertRaisesRegex(RuntimeError, 'BACKUP_RUNTIME_STAGE_COUNT_INVALID'):
                contract.plan_version(plan)
        extra = copy.deepcopy(rows[-1]); extra['Id'] = fx.checksum(3000)
        extra['Config']['Labels']['com.docker.compose.service'] = 'waha-07'
        with self.assertRaises(ReleaseError):
            runtime.inspect_inventory(rows + [extra], portal=state['portal'], caddy_id=state['service_inventory']['caddy'])

    def test_network_snapshot_accepts_one_bridge_per_gateway(self):
        services = {'a': {'Id': 'a', 'NetworkSettings': {'Networks': {'n%d' % i: {} for i in range(11)}}}}
        listing = [{'Name': 'n%d' % i, 'Id': str(i), 'Driver': 'bridge', 'Internal': False, 'EnableIPv6': False,
                    'IPAM': {}, 'Options': {}, 'Labels': {}, 'Containers': {'a': {}}} for i in range(11)]
        self.assertEqual(len(runtime.network_snapshot(lambda *_: json.dumps(listing), None, services)), 11)
        services['a']['NetworkSettings']['Networks']['n11'] = {}
        with self.assertRaises(ReleaseError):
            runtime.network_snapshot(lambda *_: json.dumps(listing), None, services)


class ProposalTests(unittest.TestCase):
    def test_supervisor_gateway_is_adopted_with_its_receipt_bridge_and_wiring(self):
        b = ax.baseline(gateways=1)
        rows, networks, gateways = supervisor_added(b)
        proposal, docs = run(b, rows, networks, gateways)
        state, plan = json.loads(docs['state']), json.loads(docs['plan'])
        runtime.validate_state(state); runtime.validate_inventory(state, rows); runtime.validate_plan(state, docs['plan'])
        self.assertEqual(set(state['service_inventory']), set(b['state']['service_inventory']) | {'waha-02'})
        self.assertEqual(state['gateway_provisioning'], gateways['receipts'])
        self.assertIn('commerce-os_gateway-02', state['network_baseline'])
        self.assertEqual(plan['preserved_runtime'], state['preserved_runtime'])
        s = proposal['summary']
        self.assertEqual((s['gateways_added'], s['gateways_since_release'], s['networks_added']),
                         (['waha-02'], ['waha-02'], ['commerce-os_gateway-02']))
        self.assertEqual(s['recreated'], {})
        self.assertIn('ingress', s['unchanged']); self.assertIn('channel-worker', s['unchanged'])
        self.assertEqual(docs['pins'], gateways['pins'])
        policy = json.loads(docs['policy'])
        self.assertEqual(policy['gateway_start_ids'], {})  # adoption never schedules a gateway start

    def test_without_verified_receipts_no_gateway_is_adopted(self):
        b = ax.baseline(gateways=1)
        rows, networks, gateways = supervisor_added(b)
        with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_GATEWAY_RECEIPT_SET_INVALID'):
            run(b, rows, networks, None)
        unpinned = copy.deepcopy(gateways); unpinned['pins'] = {}
        with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_GATEWAY_OVERLAY_NOT_PINNED'):
            run(b, rows, networks, unpinned)
        stray = copy.deepcopy(gateways); stray['pins']['/opt/commerce-os/private/other.overlay'] = native.reference(m.SHARED_OVERLAY, b'x')
        with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_GATEWAY_PIN_INVALID'):
            run(b, rows, networks, stray)

    def test_recorded_receipts_keep_operation_slot_definition_and_bytes(self):
        b = ax.baseline(gateways=1)
        rows, networks, gateways = supervisor_added(b)
        for field, value in (('operation_id', '00000000-0000-4000-8000-000000000999'), ('slot', 2), ('definition_sha256', 'e'*64)):
            bad = copy.deepcopy(gateways); bad['receipts']['waha-01'][field] = value
            with self.subTest(field), self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_GATEWAY_RECEIPT_CHANGED:waha-01'):
                run(b, rows, networks, bad)
        moved = copy.deepcopy(gateways); moved['receipts']['waha-01']['overlay_ref']['path'] = '/opt/commerce-os/private/elsewhere.json'
        with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_GATEWAY_RECEIPT_CHANGED:waha-01'):
            run(b, rows, networks, moved)
        # A pinned copy of the same bytes is the only accepted new reference.
        same = native.reference(m.SHARED_OVERLAY, b'public synthetic bytes')
        pinned = copy.deepcopy(gateways); pinned['receipts']['waha-01']['overlay_ref'] = m.pinned_overlay(same)
        pinned['pins'][m.pinned_overlay(same)['path']] = same
        state = json.loads(run(b, rows, networks, pinned)[1]['state'])
        self.assertEqual(state['gateway_provisioning']['waha-01']['overlay_ref']['path'], m.pinned_overlay(same)['path'])

    def test_any_other_container_network_or_wiring_change_is_refused(self):
        b = ax.baseline(gateways=1)
        rows, networks, gateways = supervisor_added(b)
        foreign = copy.deepcopy(rows[-1]); foreign['Id'] = fx.checksum(4444); foreign['Config']['Labels']['com.docker.compose.service'] = 'other'
        with self.assertRaises(ReleaseError):
            run(b, rows + [foreign], networks, gateways)
        gone = [row for row in rows if row['Config']['Labels'].get('com.docker.compose.service') != 'waha-01']
        with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_SERVICE_SET_CHANGED'):
            run(b, gone, networks, gateways)
        for service in ('api', 'web'):
            wired = copy.deepcopy(rows)
            for row in wired:
                if row['Config']['Labels'].get('com.docker.compose.service') == service:
                    row['NetworkSettings']['Networks']['commerce-os_gateway-02'] = {'NetworkID': fx.checksum(421), 'Aliases': [], 'GwPriority': 0}
            with self.subTest(service), self.assertRaises(ReleaseError):
                run(b, wired, networks, gateways)
        extra = copy.deepcopy(rows)
        for row in extra:
            if row['Config']['Labels'].get('com.docker.compose.service') == 'ingress':
                row['NetworkSettings']['Networks']['commerce-os_gateway-05'] = {'NetworkID': fx.checksum(9), 'Aliases': [], 'GwPriority': 0}
        with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_DEFINITION_CHANGED:ingress'):
            run(b, extra, networks, gateways)
        for key, value in (('Internal', True), ('Driver', 'macvlan'), ('Labels', {})):
            bad = copy.deepcopy(networks); bad['commerce-os_gateway-02'][key] = value
            with self.subTest(key), self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_GATEWAY_NETWORK_INVALID'):
                run(b, rows, bad, gateways)
        more = dict(networks, other=bridge_row('commerce-os_other', 99))
        with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_NETWORK_BASELINE_CHANGED'):
            run(b, rows, more, gateways)

    def test_lab_engine_and_invitation_settings_are_adoptable(self):
        b = ax.baseline(gateways=1)
        api, auto = b['by']['api'], b['by']['automation-worker']
        new_api = ax.recreate(api, 501, ['LAB_ENGINE_SHA256='+'1'*64])
        new_auto = ax.recreate(auto, 502, ['BETTER_AUTH_SECRET=never-printed', 'BETTER_AUTH_URL=https://example.invalid'])
        rows = ax.replace(ax.replace(b['rows'], api, new_api), auto, new_auto)
        files = dict(b['files'], **{'api.env': ax.PROFILES['api.env']+b'LAB_ENGINE_SHA256='+b'1'*64+b'\n',
                                    'automation.env': ax.PROFILES['automation.env']+b'BETTER_AUTH_SECRET=never-printed\nBETTER_AUTH_URL=https://example.invalid\n'})
        proposal, _docs = ax.run(b, rows=rows, files=files)
        self.assertEqual(proposal['summary']['recreated'], {'api': ['LAB_ENGINE_SHA256'],
                                                            'automation-worker': ['BETTER_AUTH_SECRET', 'BETTER_AUTH_URL']})
        self.assertNotIn('never-printed', json.dumps(proposal))
        wrong = ax.recreate(b['by']['ingress'], 503, ['BETTER_AUTH_SECRET=x'])
        with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_SETTING_NOT_ALLOWED:ingress'):
            ax.run(b, rows=ax.replace(b['rows'], b['by']['ingress'], wrong))


class FakeHost:
    def __init__(self, files, slots, overlay_sha):
        self.root = Path('/opt/commerce-os/releases/synthetic'); self.PRIVATE = m.PRIVATE
        self.files, self.slots, self.overlay_sha, self.queries = files, slots, overlay_sha, []

    def private(self, path, optional=False):
        if str(path) not in self.files:
            if optional:
                return None
            raise FileNotFoundError(path)
        return self.files[str(path)]

    def database(self, _root, sql):
        self.queries.append(sql)
        if 'number_capacity_slots' in sql:
            return json.dumps({'slots': self.slots})
        return json.dumps({'overlay_sha': self.overlay_sha})


class HostAdoptionTests(unittest.TestCase):
    def setUp(self):
        self.b = ax.baseline(gateways=1)
        self.rows, _networks, _gateways = supervisor_added(self.b)
        self.services = runtime.inspect_inventory(self.rows, portal=self.b['state']['portal'],
                                                  caddy_id=self.b['state']['service_inventory']['caddy'])
        receipt = {'service_inventory': {k: v for k, v in self.b['state']['service_inventory'].items()}}
        self.receipt_raw = json.dumps(receipt).encode()
        state = copy.deepcopy(self.b['state'])
        # waha-01 was provisioned through the shared overlay, which the EXPAND has since rewritten.
        state['gateway_provisioning']['waha-01']['overlay_ref'] = native.reference(m.SHARED_OVERLAY, OLD_OVERLAY)
        self.state = state

    def files(self, backup=True):
        files = {str(m.SHARED_OVERLAY): OVERLAY, self.b['state']['last_release_receipt_ref']['path']: self.receipt_raw}
        if backup:
            files[str(m.SHARED_OVERLAY.with_suffix('.'+native.reference('x', OLD_OVERLAY)['sha256']+'.backup'))] = OLD_OVERLAY
        return files

    def adopt(self, host):
        def read(ref):
            raw = host.private(ref['path'])
            if native.reference(ref['path'], raw) != ref:
                raise ReleaseError('COPY_REFERENCE_CHANGED')
            return raw
        receipt_ref = self.state['last_release_receipt_ref']
        host.files[receipt_ref['path']] = self.receipt_raw
        self.state['last_release_receipt_ref'] = native.reference(receipt_ref['path'], self.receipt_raw)
        with mock.patch.object(m.native, 'read_reference', side_effect=read), \
             mock.patch.object(m.runtime, 'verify_gateway_provisioning') as verify, \
             mock.patch.object(m.runtime, 'gateway_rendered_bindings') as rendered:
            result = m.gateway_adoption(host, self.state, self.services, {})
        return result, verify, rendered

    def test_added_gateway_gets_its_slot_receipt_and_stale_overlay_is_pinned(self):
        host = FakeHost(self.files(), [OP], native.reference('x', OVERLAY)['sha256'])
        result, verify, rendered = self.adopt(host)
        receipts = result['receipts']
        self.assertEqual(receipts['waha-02']['operation_id'], OP)
        self.assertEqual(receipts['waha-02']['slot'], 2)
        self.assertEqual(receipts['waha-02']['definition_sha256'], runtime.definition_digest(self.services['waha-02']))
        self.assertEqual(Path(receipts['waha-02']['overlay_ref']['path']).parent, m.GATEWAY_OVERLAYS)
        self.assertEqual(Path(receipts['waha-01']['overlay_ref']['path']).parent, m.GATEWAY_OVERLAYS)
        self.assertEqual(receipts['waha-01']['overlay_ref']['sha256'], native.reference('x', OLD_OVERLAY)['sha256'])
        self.assertEqual(result['since_release'], ['waha-02'])
        # Verified against the attested bytes where they are now, exactly like the installer.
        checked = verify.call_args[0][2]['gateway_provisioning']
        self.assertEqual(checked['waha-02']['overlay_ref']['path'], str(m.SHARED_OVERLAY))
        self.assertTrue(checked['waha-01']['overlay_ref']['path'].endswith('.backup'))
        rendered.assert_called_once()
        self.assertTrue(all('READ ONLY' in query for query in host.queries))

    def test_lost_bytes_unknown_slot_or_operation_refuse(self):
        host = FakeHost(self.files(backup=False), [OP], native.reference('x', OVERLAY)['sha256'])
        with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_GATEWAY_OVERLAY_LOST:waha-01'):
            self.adopt(host)
        for slots in ([], [OP, OP], ['not-a-uuid']):
            host = FakeHost(self.files(), slots, native.reference('x', OVERLAY)['sha256'])
            with self.subTest(slots=slots), self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_GATEWAY_SLOT_REQUIRED:waha-02'):
                self.adopt(host)
        host = FakeHost(self.files(), [OP], 'f'*64)
        with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_GATEWAY_OVERLAY_LOST:waha-02'):
            self.adopt(host)
        host = FakeHost(self.files(), [OP], None)
        with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_GATEWAY_OPERATION_REQUIRED:waha-02'):
            self.adopt(host)

    def test_no_added_gateway_and_readable_overlays_change_nothing(self):
        self.state = copy.deepcopy(self.b['state'])
        services = {k: v for k, v in self.services.items() if k != 'waha-02'}
        self.services = services
        host = FakeHost({self.b['state']['gateway_provisioning']['waha-01']['overlay_ref']['path']: b'public synthetic bytes'}, [], None)
        result, _verify, rendered = self.adopt(host)
        self.assertEqual(result['receipts'], self.b['state']['gateway_provisioning'])
        self.assertEqual((result['pins'], result['since_release']), ({}, []))
        rendered.assert_not_called()


class CaptureTests(unittest.TestCase):
    def test_capture_tolerates_canonical_additions_and_records_only_the_baseline(self):
        b = ax.baseline(gateways=1)
        rows, _networks, _gateways = supervisor_added(b)
        host = mock.Mock(rows=lambda: rows)
        host.private = lambda path, optional=False: {str(m.ADOPTION): b['state_raw'], str(m.PLAN): b['plan_raw']}.get(str(path)) \
            or b['files'][Path(path).name]
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(m, 'base_dir', return_value=Path(tmp)), \
             mock.patch.object(m.native, 'read_reference', return_value=b''), \
             mock.patch.object(m, 'write_private', side_effect=lambda path, raw: Path(path).write_bytes(raw)):
            result = m.capture(host)
            saved = json.loads((Path(tmp)/'capture.json').read_bytes())
        self.assertEqual(result['services'], sorted(b['state']['service_inventory']))
        self.assertEqual({row['Id'] for row in saved['rows']}, set(b['state']['service_inventory'].values()))
        api = [row for row in rows if row['Config']['Labels'].get('com.docker.compose.service') == 'api'][0]
        api['NetworkSettings']['Networks']['commerce-os_gateway-02'] = {'NetworkID': fx.checksum(421), 'Aliases': [], 'GwPriority': 0}
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(m, 'base_dir', return_value=Path(tmp)), \
             self.assertRaisesRegex(ReleaseError, 'COPY_RUNTIME_STATIC_DEFINITION_CHANGED'):
            m.capture(host)


class PinTests(unittest.TestCase):
    def test_pin_is_named_by_its_digest_and_never_rewritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)/'v7-infra-adoption'; base.mkdir(mode=0o700)
            written = {}
            with mock.patch.object(m, 'GATEWAY_OVERLAYS', base/'gateway-overlays'), mock.patch.object(m, 'base_dir', return_value=base), \
                 mock.patch.object(m.os, 'getuid', return_value=0), \
                 mock.patch.object(m, 'write_private', side_effect=lambda path, raw: (written.__setitem__(str(path), raw), Path(path).write_bytes(raw))), \
                 mock.patch.object(m.native, 'protected_bytes', side_effect=lambda path: Path(path).read_bytes()):
                path = base/'gateway-overlays'/(m.digest(OVERLAY)+'.overlay')
                with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_GATEWAY_PIN_INVALID'):
                    m.pin_overlay(base/'gateway-overlays'/'other.overlay', OVERLAY)
                with mock.patch.object(Path, 'lstat', lambda self: type('S', (), {'st_mode': 0o40700, 'st_uid': 0})()):
                    m.pin_overlay(path, OVERLAY)
                    m.pin_overlay(path, OVERLAY)  # idempotent
                    self.assertEqual(list(written), [str(path)])
                    path.write_bytes(b'changed')
                    with self.assertRaisesRegex(ReleaseError, 'V7_ADOPTION_GATEWAY_PIN_CHANGED'):
                        m.pin_overlay(path, OVERLAY)


class ReadoptionJournalTests(unittest.TestCase):
    STATE = {'last_release_receipt_ref': {'path': '/r', 'bytes': 1, 'sha256': 'a'*64},
             'service_inventory': {'api': 'a', 'waha-01': 'g1', 'waha-02': 'g2', 'waha-04': 'g4'}}
    RECEIPT = {'service_inventory': {'api': 'a', 'waha-01': 'g1'}}

    def journal(self, **change):
        value = {'schema_version': 1, 'status': 'APPLIED', 'state_sha256': 's'*64, 'plan_sha256': 'p'*64,
                 'base_receipt_ref': self.STATE['last_release_receipt_ref'], 'gateways_added': ['waha-02', 'waha-04']}
        value.update(change)
        return value

    def confirms(self, journal, state=None, receipt=None):
        return contract.readoption_confirms(receipt or self.RECEIPT, state or self.STATE, 's'*64, 'p'*64, journal)

    def test_exactly_the_journaled_gateways_extend_the_receipt(self):
        self.assertTrue(self.confirms(self.journal()))
        for added in (['waha-02'], ['waha-02', 'waha-04', 'waha-05'], ['waha-02', 'waha-02', 'waha-04'], ['api', 'waha-02', 'waha-04'],
                      ['waha-01', 'waha-02', 'waha-04'], ['other', 'waha-02'], 'waha-02', None):
            with self.subTest(added=added):
                self.assertFalse(self.confirms(self.journal(gateways_added=added)))
        legacy = self.journal(); legacy.pop('gateways_added')
        self.assertFalse(self.confirms(legacy))
        same = {'last_release_receipt_ref': self.STATE['last_release_receipt_ref'], 'service_inventory': {'api': 'a2', 'waha-01': 'g1'}}
        self.assertTrue(self.confirms(legacy, state=same))
        fewer = dict(self.STATE, service_inventory={'waha-01': 'g1', 'waha-02': 'g2', 'waha-04': 'g4'})
        self.assertFalse(self.confirms(self.journal(), state=fewer))


if __name__ == '__main__':
    unittest.main()
