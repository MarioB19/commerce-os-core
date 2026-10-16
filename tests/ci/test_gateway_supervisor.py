"""Gateway supervisor: synthetic platform, administrator and Docker readback only.
No network, Docker or WhatsApp effect happens in these tests."""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('gateway_supervisor', ROOT / 'scripts/gateway_supervisor.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

NOW = dt.datetime(2026, 10, 13, 6, 0, tzinfo=dt.timezone.utc)
A = 'profile-a'


class FakePlatform:
    def __init__(self, profiles):
        self.list = profiles
        self.issued = []

    def profiles(self):
        return self.list

    def agent_token(self, workspace, now):
        self.issued.append(workspace)
        return 'cos_cap_' + 'x' * 43


class FakeAdmin:
    def __init__(self, slots, pending=(), containers=None, preview=None):
        self.slots = slots
        self.pending = list(pending)
        self.containers = containers or {}
        self.preview = preview or {'review': 'r' * 64, 'blockers': []}
        self.calls = []

    def api(self, path, body=None, key=None, method=None):
        self.calls.append(('api', path, body))
        if path == '/number-capacity?limit=100':
            return {'slots': self.slots}
        if path == '/number-capacity/administration':
            return self.pending
        if path == '/number-capacity' and body['action'] == 'preview':
            return self.preview
        if path == '/number-capacity' and body['action'] == 'expand':
            return {'operation_id': 'op-new', 'state': 'REQUESTED'}
        raise AssertionError(path)

    def measure(self):
        self.calls.append(('measure',))
        if any(not c['State'].get('Running') for c in self.containers.values()):
            raise ValueError('GATEWAY_STOPPED_READBACK_REQUIRED')
        return {}

    def execute(self, operation_id, reconcile=False):
        self.calls.append(('execute', operation_id, reconcile))
        return {}

    def snapshot(self, slot):
        if slot not in self.containers:
            raise ValueError('GATEWAY_NOT_PROVISIONED')
        return self.containers[slot]

    def compose(self, *args):
        self.calls.append(('compose', *args))
        number = int(args[1].split('-')[1])
        self.containers[number] = container(True, started=NOW)
        return ''


def container(running, status=None, started=NOW - dt.timedelta(hours=1)):
    return {'Id': 'a' * 64, 'State': {'Running': running, 'Status': status or ('running' if running else 'exited'),
                                      'StartedAt': started.strftime('%Y-%m-%dT%H:%M:%S.123456789Z')}}


def slot(number, state, account=None):
    return {'id': 'slot-%d' % number, 'slot': number, 'state': state, 'account_id': account, 'readback': {'verified': True}}


class FakeOwnership:
    """Synthetic channel container inventory and reviewed attestation calls."""
    def __init__(self):
        self.containers = [{'id': 'c' * 64, 'running': True, 'started_at': '2026-10-13T05:00:00.1Z'}]
        self.hold = False
        self.calls = []

    def database(self, release, sql):
        self.calls.append(('database',))
        return 't' if self.hold else 'f'

    def container_ids(self, release):
        return [c['id'] for c in self.containers]

    def inspect(self, cid):
        return next(dict(c) for c in self.containers if c['id'] == cid)

    def capture(self, release, path):
        self.calls.append(('capture', path))
        Path(path).write_text(json.dumps({'containers': [dict(c) for c in self.containers], 'owners': []}))
        os.chmod(path, 0o600)

    def attest(self, release, path):
        self.calls.append(('attest', path, os.environ.get('COMMERCE_OWNERSHIP_HISTORY_DIR')))
        return {'receipts_inserted': 2, 'replacement': True}


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.state = mod.State(os.path.join(self.dir.name, 'state.json'))
        self.now = NOW
        self.release = os.path.join(self.dir.name, 'release.env')
        Path(self.release).write_text('X=1\n')
        os.chmod(self.release, 0o600)
        self.ownership = FakeOwnership()
        self.config = {'measure_seconds': 45, 'release_env': self.release, 'state_file': os.path.join(self.dir.name, 'state.json')}

    def supervisor(self, admin, profiles=None):
        self.platform = FakePlatform(profiles or [{'id': A, 'state': 'ACTIVE', 'limits': {'numbers': 3}}])
        return mod.Supervisor(self.config, platform=self.platform, administrator=lambda token: admin,
                              state=self.state, clock=lambda: self.now, ownership=self.ownership)

    def test_requests_one_reviewed_spare_and_backs_off(self):
        admin = FakeAdmin([slot(1, 'CONNECTED', 'acc-1')], containers={1: container(True)})
        sup = self.supervisor(admin)
        report = sup.cycle()
        self.assertEqual(report['spares_requested'], 1)
        expand = [c for c in admin.calls if c[0] == 'api' and c[2] and c[2].get('action') == 'expand'][0][2]
        self.assertEqual((expand['count'], expand['review'], expand['confirmation']), (2, 'r' * 64, 'APPLY_REVIEWED_CAPACITY'))
        # Same cycle window: no second request before the backoff.
        self.now = NOW + dt.timedelta(seconds=10)
        self.assertEqual(sup.cycle()['spares_requested'], 0)
        self.assertTrue(json.loads(Path(self.dir.name, 'state.json').read_text())['spares'][A]['next_at'] > NOW.timestamp())
        self.assertEqual(os.stat(Path(self.dir.name, 'state.json')).st_mode & 0o777, 0o600)

    def test_no_spare_when_prepared_exists_quota_full_pending_or_suspended(self):
        prepared = FakeAdmin([slot(1, 'CONNECTED', 'acc-1'), slot(2, 'PREPARED')])
        self.assertEqual(self.supervisor(prepared).cycle()['spares_requested'], 0)
        full = FakeAdmin([slot(1, 'CONNECTED', 'acc-1')])
        self.assertEqual(self.supervisor(full, [{'id': A, 'state': 'ACTIVE', 'limits': {'numbers': 1}}]).cycle()['spares_requested'], 0)
        suspended = FakeAdmin([])
        self.assertEqual(self.supervisor(suspended, [{'id': A, 'state': 'SUSPENDED', 'limits': {'numbers': 3}}]).cycle()['spares_requested'], 0)
        blocked = FakeAdmin([], preview={'review': 'r' * 64, 'blockers': ['HOST_RAM_MARGIN_INSUFFICIENT']})
        report = self.supervisor(blocked).cycle()
        self.assertEqual(report['spares_requested'], 0)
        self.assertEqual(self.state.data['spares'][A]['code'], 'HOST_RAM_MARGIN_INSUFFICIENT')
        self.assertFalse([c for c in blocked.calls if c[0] == 'api' and c[2] and c[2].get('action') == 'expand'])

    def test_retries_an_unprepared_slot_instead_of_adding_another(self):
        admin = FakeAdmin([slot(1, 'CONNECTED', 'acc-1'), slot(2, 'AVAILABLE')])
        self.supervisor(admin).cycle()
        expand = [c for c in admin.calls if c[0] == 'api' and c[2] and c[2].get('action') == 'expand'][0][2]
        self.assertEqual(expand['count'], 2)

    def test_applies_pending_and_reconciles_unknown_only_by_readback(self):
        admin = FakeAdmin([slot(1, 'CONNECTED', 'acc-1')], pending=[{'id': 'op-1', 'state': 'REQUESTED', 'action': 'EXPAND'},
                                                                   {'id': 'op-2', 'state': 'UNKNOWN', 'action': 'PROVISION'},
                                                                   {'id': 'op-3', 'state': 'PREPARING', 'action': 'EXPAND'}])
        report = self.supervisor(admin).cycle()
        self.assertEqual((report['applied'], report['reconciled'], report['spares_requested']), (1, 1, 0))
        self.assertIn(('execute', 'op-1', False), admin.calls)
        self.assertIn(('execute', 'op-2', True), admin.calls)
        self.assertNotIn('op-3', [c[1] for c in admin.calls if c[0] == 'execute'])

    def test_failed_operation_backs_off_and_does_not_stop_other_profiles(self):
        class Failing(FakeAdmin):
            def execute(self, operation_id, reconcile=False):
                self.calls.append(('execute', operation_id, reconcile))
                raise RuntimeError('ADMINISTRATION_RECONCILIATION_REQUIRED')
        failing = Failing([], pending=[{'id': 'op-1', 'state': 'REQUESTED', 'action': 'EXPAND'}])
        healthy = FakeAdmin([slot(1, 'PREPARED')])
        admins = {'cos_a': failing, 'cos_b': healthy}
        platform = FakePlatform([{'id': 'a', 'state': 'ACTIVE', 'limits': {'numbers': 2}}, {'id': 'b', 'state': 'ACTIVE', 'limits': {'numbers': 2}}])
        platform.agent_token = lambda workspace, now: 'cos_' + workspace
        sup = mod.Supervisor(self.config, platform=platform, administrator=lambda token: admins[token], state=self.state, clock=lambda: self.now, ownership=self.ownership)
        report = sup.cycle()
        self.assertEqual(report['errors'][0]['code'], 'ADMINISTRATION_RECONCILIATION_REQUIRED')
        self.assertIn(('measure',), healthy.calls)
        self.now = NOW + dt.timedelta(seconds=20)
        sup.cycle()
        self.assertEqual(len([c for c in failing.calls if c[0] == 'execute']), 1)
        self.now = NOW + dt.timedelta(seconds=31)
        sup.cycle()
        self.assertEqual(len([c for c in failing.calls if c[0] == 'execute']), 2)

    def test_restarts_exited_gateway_before_measuring_with_bounded_backoff(self):
        admin = FakeAdmin([slot(1, 'CONNECTED', 'acc-1'), slot(2, 'DRAINING'), slot(3, 'PREPARED')],
                          containers={1: container(False), 2: container(False), 3: container(False, 'paused')})
        sup = self.supervisor(admin)
        report = sup.cycle()
        self.assertEqual(report['restarted'], 1)
        self.assertEqual([c for c in admin.calls if c[0] == 'compose'], [('compose', 'start', 'waha-01')])
        self.assertLess(admin.calls.index(('compose', 'start', 'waha-01')), admin.calls.index(('measure',)))
        # Running again but not yet stable: the attempt counter is kept.
        self.assertEqual(self.state.data['gateways']['01']['attempts'], 1)
        self.now = NOW + dt.timedelta(minutes=11)
        sup.cycle()
        self.assertNotIn('01', self.state.data['gateways'])

    def test_crash_loop_stops_after_five_attempts_and_reports_once(self):
        class Crashing(FakeAdmin):
            def compose(self, *args):
                self.calls.append(('compose', *args))
        admin = Crashing([slot(1, 'CONNECTED', 'acc-1')], containers={1: container(False)})
        sup = self.supervisor(admin)
        moment = NOW
        for _ in range(12):
            self.now = moment
            sup.cycle()
            moment += dt.timedelta(seconds=500)
        self.assertEqual(len([c for c in admin.calls if c[0] == 'compose']), 5)
        exhausted = [e for e in self.state.data['events'] if e['kind'] == 'GATEWAY_RESTART_EXHAUSTED']
        self.assertEqual(len(exhausted), 1)

    def test_restarted_channel_worker_is_attested_once_and_never_during_a_release_hold(self):
        sup = self.supervisor(FakeAdmin([]))
        self.assertNotIn('channel_handoff', sup.cycle())
        self.assertEqual([c[0] for c in self.ownership.calls if c[0] != 'database'], ['capture'])
        snapshot = Path(self.dir.name, 'ownership', 'channel-snapshot.json')
        self.assertEqual(os.stat(snapshot.parent).st_mode & 0o777, 0o700)
        # The same container restarted: newer StartedAt, running.
        self.ownership.containers[0]['started_at'] = '2026-10-13T05:59:00.2Z'
        report = sup.cycle()
        self.assertEqual(report['channel_handoff'], 2)
        attests = [c for c in self.ownership.calls if c[0] == 'attest']
        self.assertEqual(attests, [('attest', str(snapshot), str(snapshot.parent))])
        self.assertEqual(sum(1 for e in self.state.data['events'] if e['kind'] == 'CHANNEL_WORKER_RESTART_ATTESTED'), 1)
        sup.cycle()
        self.assertEqual(len([c for c in self.ownership.calls if c[0] == 'attest']), 1)
        # A replacement container that is not running yet is not attested.
        self.ownership.containers = [{'id': 'd' * 64, 'running': False, 'started_at': '2026-10-13T06:00:00Z'}]
        sup.cycle()
        self.assertEqual(len([c for c in self.ownership.calls if c[0] == 'attest']), 1)
        # During a release hold the installer owns the handoff: nothing captured or attested.
        self.ownership.containers = [{'id': 'e' * 64, 'running': True, 'started_at': '2026-10-13T06:01:00Z'}]
        self.ownership.hold = True
        before = list(self.ownership.calls)
        sup.cycle()
        self.assertEqual([c for c in self.ownership.calls[len(before):] if c[0] != 'database'], [])

    def test_never_starts_sessions_or_deletes_volumes(self):
        source = (ROOT / 'scripts/gateway_supervisor.py').read_text()
        for forbidden in ('/sessions/start', "'down'", "'rm'", 'volume rm', "'restart'", 'docker exec', 'channel-sessions'):
            self.assertNotIn(forbidden, source)
        unit = (ROOT / 'infra/systemd/commerce-gateway-supervisor.service').read_text()
        self.assertIn('UMask=0077', unit)
        self.assertIn('NoNewPrivileges=true', unit)
        self.assertIn('gateway_supervisor.py /etc/commerce-os/gateway-supervisor.json run', unit)

    def test_platform_client_requires_https_and_platform_token(self):
        with self.assertRaises(mod.SupervisorError):
            mod.PlatformClient('http://commerce.example', 'cos_plt_' + 'x' * 43)
        with self.assertRaises(mod.SupervisorError):
            mod.PlatformClient('https://commerce.example', 'cos_pat_' + 'x' * 43)
        self.assertEqual(mod.started_at('0001-01-01T00:00:00Z'), None)
        self.assertAlmostEqual(mod.started_at('2026-10-13T06:00:00.123456789Z'), NOW.timestamp() + 0.123456, places=5)

    def test_agent_tokens_are_cached_until_two_minutes_before_expiry(self):
        responses = []

        class Client(mod.PlatformClient):
            def call(self, method, path, body=None):
                responses.append((method, path, body))
                return {'token': 'cos_cap_' + str(len(responses)) * 43, 'workspaceId': body['workspaceId'],
                        'expiresAt': (NOW + dt.timedelta(minutes=14)).isoformat().replace('+00:00', 'Z')}
        client = Client('https://commerce.example', 'cos_plt_' + 'x' * 43)
        first = client.agent_token(A, NOW)
        self.assertEqual(client.agent_token(A, NOW + dt.timedelta(minutes=11)), first)
        self.assertNotEqual(client.agent_token(A, NOW + dt.timedelta(minutes=13)), first)
        self.assertEqual(responses[0], ('POST', '/v2/platform/capacity/agent-tokens', {'workspaceId': A}))


if __name__ == '__main__':
    unittest.main()
