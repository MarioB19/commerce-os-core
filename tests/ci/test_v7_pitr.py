import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import v7_pitr as m  # noqa: E402

SYSID = '7696234252839657509'
OLD, NEW = 'a' * 64, 'b' * 64
STOCK, PITR = 'sha256:' + '1' * 64, 'sha256:' + '2' * 64


class FakeDocker:
    """Just enough of docker/compose/psql/pgBackRest for the operator's paths."""

    def __init__(self, private, *, fail=None, clients=0, counts=None, restored_counts=None):
        self.private = Path(private)
        self.calls = []
        self.fail = fail or set()
        self.clients = clients
        self.cid = OLD
        self.recreations = 0
        self.network = None
        self.backups = []
        self.counts = counts or {'payments': 10, 'schema_migrations': 111}
        self.restored_counts = restored_counts or dict(self.counts)

    def enabled(self):
        return (self.private / 'enabled').exists()

    def container(self):
        networks = {'commerce-os_core': {}}
        if self.cid != OLD and self.enabled():
            networks['commerce-os_pitr-edge'] = {}
        return {'Id': self.cid, 'Image': PITR if self.cid != OLD and self.enabled() else STOCK,
                'Mounts': [{'Type': 'volume', 'Name': 'commerce-os_pg', 'Destination': m.DATA_DIR}],
                'NetworkSettings': {'Networks': networks}}

    def __call__(self, argv, *, cwd=None, input=None, timeout=None, env=None):
        self.calls.append(argv)
        joined = ' '.join(argv)
        for key in self.fail:
            if key in joined:
                raise m.PitrError('PITR_COMMAND_FAILED:' + key)
        if argv[:2] == ['sh', 'compose']:
            if 'ps' in argv:
                return self.cid + '\n'
            if 'up' in argv:
                self.recreations += 1
                self.cid = NEW if self.enabled() else 'c' * 64
                return ''
        if argv[:2] == ['docker', 'inspect']:
            ref = argv[2]
            if ref == 'commerce-os-postgres:pitr':
                return json.dumps([{'Id': PITR}])
            if ref == 'commerce-os_pitr-edge':
                if self.network is None:
                    raise m.PitrError('PITR_COMMAND_FAILED:no such network')
                return json.dumps([self.network])
            return json.dumps([self.container()])
        if argv[:3] == ['docker', 'network', 'create']:
            options = dict(arg.split('=', 1) for arg in argv if arg.startswith('com.docker.network'))
            self.network = {'Driver': 'bridge', 'Internal': False, 'EnableIPv6': False, 'Options': options, 'Containers': {}}
            return ''
        if argv[:3] == ['docker', 'run', '--rm']:
            return 'pgBackRest 2.59.3\n' if 'pgbackrest' in argv else 'postgres (PostgreSQL) 17.11 (Debian)\n'
        if argv[:2] == ['docker', 'exec'] and 'psql' in argv:
            sql = (input or b'').decode() or argv[-1]
            target = argv[argv.index('psql') - 1]
            restored = target.startswith('pitr-rehearsal')
            if 'system_identifier' in sql:
                return SYSID
            if "FROM pg_settings" in sql:
                on = self.enabled() and self.cid == NEW
                return '\n'.join([
                    'archive_command|' + ('pgbackrest --stanza=commerce archive-push %p' if on else '(disabled)'),
                    'archive_mode|' + ('on' if on else 'off'), 'archive_timeout|' + ('60s' if on else '0s'),
                    'wal_level|replica'])
            if 'pg_stat_activity' in sql:
                return str(self.clients)
            if 'to_regclass' in sql:
                return 't'
            if 'record_platform_backup_run' in sql:
                return ''
            if 'pg_database_size' in sql:
                return '1000000'
            if '\\gexec' in sql:
                counts = self.restored_counts if restored else self.counts
                return '\n'.join(k + '|' + str(v) for k, v in counts.items())
            if 'schema_migrations' in sql:
                return '111|0111_v7_platform_recovery.sql'
            if 'pg_create_restore_point' in sql or 'pg_switch_wal' in sql:
                return ''
            if 'pg_walfile_name(pg_current_wal_lsn())' in sql and 'json' not in sql:
                return '000000010000000000000005'
            if 'last_archived_wal' in sql and 'json' not in sql:
                return '000000010000000000000006'
            if 'pg_is_in_recovery' in sql:
                return 'f'
            if 'json_build_object' in sql:
                return json.dumps({'archived': 3, 'failed': 0, 'last_archived_wal': '000000010000000000000006',
                                   'last_archived_at': '2026-10-13T10:00:00+00:00', 'last_failed_wal': None,
                                   'last_failed_at': None, 'current_wal': '000000010000000000000007', 'pending': 0,
                                   'oldest_pending_age_s': None})
            raise AssertionError('unexpected SQL ' + sql[:80])
        if argv[:2] == ['docker', 'exec'] and 'pgbackrest' in argv:
            if 'backup' in argv:
                kind = next(a for a in argv if a.startswith('--type=')).split('=')[1]
                label = '20261013-100000F' if kind == 'full' else '20261013-100000F_20261013-110000I'
                self.backups.append({'label': label, 'type': kind, 'timestamp': {'start': 1, 'stop': 2},
                                     'info': {'size': 1000, 'delta': 1000, 'repository': {'size': 100, 'delta': 100}},
                                     'archive': {'start': '000000010000000000000002', 'stop': '000000010000000000000003'}})
                return ''
            if 'info' in argv:
                return json.dumps([{'name': 'commerce', 'status': {'message': 'ok'}, 'backup': self.backups,
                                    'archive': [{'min': '000000010000000000000002', 'max': '000000010000000000000006'}]}])
            return ''
        if argv[:1] == ['df']:
            return 'Avail\n' + str(100 * 1024 ** 3) + '\n'
        if argv[:2] in (['docker', 'volume'], ['docker', 'run'], ['docker', 'rm']) or argv[:2] == ['docker', 'exec']:
            return ''
        raise AssertionError('unexpected command ' + joined[:120])


class PitrOperatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.private = base / 'pitr'
        self.locks = base / 'locks'
        self.locks.mkdir(mode=0o700)
        self.config = base / 'config.json'
        self.config.write_text(json.dumps({
            'schema_version': 1, 'compose': ['sh', 'compose', '/private/release.env'], 'workdir': str(base),
            'private_dir': str(self.private), 'locks_dir': str(self.locks), 'service': 'postgres',
            'image': 'commerce-os-postgres:pitr', 'network': 'commerce-os_pitr-edge', 'bucket': 'commerce-v7-pitr-test',
            'region': 'us-central1', 'primary_region': 'us-east1', 'pg_user': 'commerce_owner', 'pg_database': 'commerce'}))

    def tearDown(self):
        self.temp.cleanup()

    def run_cli(self, fake, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = m.main([str(self.config), *args], host_factory=lambda config: m.Host(config, fake))
        return code, json.loads(out.getvalue().strip().splitlines()[-1])

    def secret(self):
        return (self.private / 'pgbackrest.env').read_text().split('=', 1)[1].strip()

    def test_render_creates_cipher_once_never_prints_it(self):
        fake = FakeDocker(self.private)
        code, first = self.run_cli(fake, 'render')
        self.assertEqual((code, first['state'], first['cipher_created'], first['cluster_id']), (0, 'PITR_RENDERED', True, SYSID))
        secret = self.secret()
        self.assertRegex(secret, '^[a-f0-9]{64}$')
        self.assertEqual(oct((self.private / 'pgbackrest.env').stat().st_mode & 0o777), '0o600')
        conf = (self.private / 'pgbackrest.conf').read_text()
        self.assertIn('repo1-path=/commerce/' + SYSID, conf)
        self.assertNotIn(secret, conf)
        code, second = self.run_cli(fake, 'render')
        self.assertFalse(second['cipher_created'])
        self.assertEqual(self.secret(), secret)
        self.assertEqual(first['cipher_sha256'], second['cipher_sha256'])
        for path in (self.private / 'evidence').iterdir():
            self.assertNotIn(secret, path.read_text())

    def test_enable_switches_with_locks_network_options_and_first_full(self):
        fake = FakeDocker(self.private)
        self.run_cli(fake, 'render')
        code, result = self.run_cli(fake, 'enable')
        self.assertEqual((code, result['state']), (0, 'PITR_ENABLED'), result)
        self.assertEqual(result['steps'], ['recreated', 'stanza', 'archive_checked', 'full_backup'])
        self.assertEqual(result['first_full']['label'], '20261013-100000F')
        self.assertTrue(result['first_full']['recorded_in_database'])
        create = next(c for c in fake.calls if c[:3] == ['docker', 'network', 'create'])
        for option in m.NETWORK_OPTIONS:
            self.assertIn(option + '=' + m.NETWORK_OPTIONS[option], create)
        backup = next(c for c in fake.calls if 'backup' in c and 'pgbackrest' in c)
        self.assertIn('--start-fast', backup)
        self.assertEqual({p.name for p in self.locks.iterdir()}, set(m.ROOT_LOCKS))
        self.assertTrue((self.private / 'enabled').exists())
        self.assertNotIn(self.secret(), json.dumps(result))
        receipt = json.loads((self.private / 'enable-receipt.json').read_text())
        self.assertEqual(oct((self.private / 'enable-receipt.json').stat().st_mode & 0o777), '0o600')
        self.assertEqual(set(receipt['before']), {'container', 'image', 'volume', 'networks', 'system_identifier'})
        self.assertNotEqual(receipt['before']['container'], receipt['after']['container'])
        self.assertEqual(receipt['after']['network'], 'commerce-os_pitr-edge')
        self.assertNotIn(self.secret(), json.dumps(receipt))

    def test_enable_failure_after_recreate_returns_to_previous_configuration(self):
        fake = FakeDocker(self.private, fail={'--stanza=commerce check'})
        self.run_cli(fake, 'render')
        code, result = self.run_cli(fake, 'enable')
        self.assertEqual(code, 2)
        self.assertIn('PITR_ENABLE_FAILED_ROLLED_BACK:recreated,stanza:ROLLED_BACK', result['error'])
        self.assertFalse((self.private / 'enabled').exists())
        self.assertFalse((self.private / 'enable-receipt.json').exists())
        self.assertEqual(fake.recreations, 2)

    def test_enable_refuses_clients_rerender_and_busy_lock(self):
        fake = FakeDocker(self.private, clients=2)
        self.run_cli(fake, 'render')
        code, result = self.run_cli(fake, 'enable')
        self.assertEqual((code, result['error']), (2, 'PITR_CLIENTS_CONNECTED'))
        self.assertEqual(fake.recreations, 0)
        self.assertFalse((self.private / 'enabled').exists())
        fake.clients = 0
        conf = self.private / 'pgbackrest.conf'
        conf.write_text(conf.read_text().replace(SYSID, '1' * 19))
        self.assertEqual(self.run_cli(fake, 'enable')[1]['error'], 'PITR_RENDER_CLUSTER_MISMATCH')
        self.run_cli(fake, 'render')
        with m.Locks(self.locks, ('ci-deploy.lock',)):
            self.assertEqual(self.run_cli(fake, 'enable')[1]['error'], 'PITR_LOCK_BUSY:ci-deploy.lock')
        self.assertEqual(fake.recreations, 0)

    def test_unsafe_or_foreign_network_is_not_used(self):
        fake = FakeDocker(self.private)
        self.run_cli(fake, 'render')
        fake.network = {'Driver': 'bridge', 'Internal': False, 'EnableIPv6': False, 'Options': {}, 'Containers': {}}
        self.assertEqual(self.run_cli(fake, 'enable')[1]['error'], 'PITR_NETWORK_UNSAFE')
        fake.network = {'Driver': 'bridge', 'Internal': False, 'EnableIPv6': False, 'Options': dict(m.NETWORK_OPTIONS),
                        'Containers': {'x' * 64: {}}}
        self.assertEqual(self.run_cli(fake, 'enable')[1]['error'], 'PITR_NETWORK_FOREIGN_ENDPOINT')
        self.assertEqual(fake.recreations, 0)

    def test_disable_returns_archive_off_same_cluster(self):
        fake = FakeDocker(self.private)
        self.run_cli(fake, 'render')
        self.run_cli(fake, 'enable')
        code, result = self.run_cli(fake, 'disable')
        self.assertEqual((code, result['state'], result['repository_preserved']), (0, 'PITR_DISABLED', True), result)
        self.assertFalse((self.private / 'enabled').exists())

    def test_backup_records_journal_and_requires_enable(self):
        fake = FakeDocker(self.private)
        self.run_cli(fake, 'render')
        self.assertEqual(self.run_cli(fake, 'backup', 'incr')[1]['error'], 'PITR_NOT_ENABLED')
        self.run_cli(fake, 'enable')
        code, result = self.run_cli(fake, 'backup', 'incr')
        self.assertEqual((code, result['status'], result['kind']), (0, 'SUCCEEDED', 'PITR_INCR'))
        # One journal per backup, rewritten from RUNNING to its terminal state.
        runs = sorted((self.private / 'runs').iterdir())
        self.assertEqual([json.loads(r.read_text())['kind'] for r in runs], ['PITR_FULL', 'PITR_INCR'])
        self.assertTrue(all(json.loads(r.read_text())['status'] == 'SUCCEEDED' for r in runs))

    def test_status_reports_problems_with_exit_three(self):
        fake = FakeDocker(self.private)
        self.run_cli(fake, 'render')
        self.run_cli(fake, 'enable')
        code, result = self.run_cli(fake, 'status')
        # The fake backup stopped at epoch 2: stale on any real clock.
        self.assertEqual(code, 3)
        self.assertIn('BACKUP_STALE', result['problems'])
        self.assertEqual(result['stanza_status'], 'ok')
        archive = {'pending': 5, 'oldest_pending_age_s': 10, 'last_failed_at': '2026-10-13T10:05:00+00:00',
                   'last_archived_at': '2026-10-13T10:00:00+00:00'}
        last = {'timestamp': {'stop': 1000}}
        self.assertEqual(m.assess(archive, last, last, 1000), ['ARCHIVE_BACKLOG', 'ARCHIVE_FAILING'])

    def test_rehearsal_exact_counts_or_refusal_and_always_cleans(self):
        fake = FakeDocker(self.private)
        self.run_cli(fake, 'render')
        self.run_cli(fake, 'enable')
        code, result = self.run_cli(fake, 'rehearse', '--create-restore-point')
        self.assertEqual((code, result['state']), (0, 'PITR_REHEARSAL_VERIFIED_EXACT'), result)
        restore = next(c for c in fake.calls if 'restore' in c and 'pgbackrest' in c)
        self.assertIn('--archive-mode=off', restore)
        self.assertTrue(any(a.startswith('--target=v7_rehearsal_') for a in restore))
        removed = [c for c in fake.calls if c[:3] == ['docker', 'rm', '-f']]
        self.assertEqual(len(removed), 1)
        fake.restored_counts = {'payments': 9, 'schema_migrations': 111}
        code, result = self.run_cli(fake, 'rehearse', '--create-restore-point')
        self.assertEqual(code, 2)
        self.assertEqual(result['error'], 'PITR_REHEARSAL_COUNTS_DIFFER:payments')
        self.assertEqual(len([c for c in fake.calls if c[:3] == ['docker', 'rm', '-f']]), 2)
        fake.fail = {'pg_ctl'}
        code, result = self.run_cli(fake, 'rehearse')
        self.assertTrue(result['error'].startswith('PITR_REHEARSAL_START_FAILED'), result)
        self.assertEqual(len([c for c in fake.calls if c[:3] == ['docker', 'rm', '-f']]), 3)

    def test_escrow_adds_one_version_with_vm_identity_without_printing(self):
        import base64
        from unittest import mock
        raw = json.loads(self.config.read_text())
        self.config.write_text(json.dumps(raw | {'escrow': {'project': 'project-c6f43813-9ac9-47ab-9fe',
                                                              'secret': 'commerce-v7-pitr-cipher'}}))
        fake = FakeDocker(self.private)
        self.run_cli(fake, 'render')
        requests = []

        def http(request, timeout=30):
            requests.append(request)
            if 'metadata.google.internal' in request.full_url:
                self.assertEqual(request.get_header('Metadata-flavor'), 'Google')
                return 200, b'{"access_token":"vm-token","expires_in":3599}'
            return 200, b'{"name":"projects/1065291779811/secrets/commerce-v7-pitr-cipher/versions/1"}'
        with mock.patch.object(m, 'default_http', http):
            code, result = self.run_cli(fake, 'escrow')
        self.assertEqual((code, result['state']), (0, 'PITR_CIPHER_ESCROWED'), result)
        post = requests[1]
        self.assertTrue(post.full_url.endswith('/secrets/commerce-v7-pitr-cipher:addVersion'))
        self.assertEqual(post.get_header('Authorization'), 'Bearer vm-token')
        self.assertEqual(base64.b64decode(json.loads(post.data)['payload']['data']).decode(), self.secret())
        self.assertNotIn(self.secret(), json.dumps(result))
        for path in (self.private / 'evidence').iterdir():
            self.assertNotIn(self.secret(), path.read_text())

    def test_config_rejects_unknown_overrides_and_injection(self):
        raw = json.loads(self.config.read_text())
        for change in ({'lab': {'PGBACKREST_REPO1_CIPHER_TYPE': 'none'}}, {'lab': {'PGBACKREST_REPO1_GCS_ENDPOINT': 'x y'}},
                       {'bucket': 'other-bucket'}, {'region': 'us-east1'}, {'pg_user': 'x\ny'}, {'extra': 1},
                       {'compose': ['sh', 'a\nb']}, {'private_dir': 'relative'},
                       {'escrow': {'project': 'p', 'secret': 'other'}}):
            with self.subTest(change=change):
                self.config.write_text(json.dumps(raw | change))
                with self.assertRaises((m.PitrError, RuntimeError)):
                    m.load_config(self.config)


class CopyRuntimeTopologyTests(unittest.TestCase):
    def test_postgres_pitr_membership_is_admitted_in_runtime_topology(self):
        import copy_runtime_deployment as runtime
        core, proxy, edge, consumer = 'commerce-os_core', 'proxy', 'edge', 'commerce-os_consumer-edge'
        gw = 'commerce-os_gateway-01'
        member = {'postgres': [core, runtime.native.PITR_NETWORK], 'web': [proxy], 'api': [core, proxy, edge],
                  'caddy': [proxy, edge], 'portal': [proxy], 'ingress': [core, proxy, gw],
                  'automation-worker': [core, consumer], 'channel-worker': [core, gw], 'waha-01': [gw]}
        services = {name: {'Id': name, 'NetworkSettings': {'Networks': {n: {'GwPriority': 1 if n in (edge, consumer) else 0}
                                                                         for n in names}},
                           'HostConfig': {'Sysctls': {'net.ipv4.ip_forward': '0', 'net.ipv6.conf.all.forwarding': '0'}}}
                    for name, names in member.items()}
        gateway = {'Gateway': '10.23.0.1'}
        networks = {name: {'Internal': name in (core, proxy), 'EnableIPv6': False, 'Driver': 'bridge',
                           'IPAM': {'Config': [gateway]}} for name in (core, proxy, edge, consumer, gw, runtime.native.PITR_NETWORK)}
        route = 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\neth0 00000000 0100170A 0003 0 0 0 00000000 0 0 0\n'
        release = {'COMMERCE_PROXY_NETWORK': proxy, 'COMMERCE_API_EDGE_NETWORK': edge, 'COMMERCE_CONSUMER_EDGE_NETWORK': consumer}
        self.assertTrue(runtime.topology(lambda *_a: route, Path('/r'), services, networks, release))
        services['channel-worker']['NetworkSettings']['Networks'][runtime.native.PITR_NETWORK] = {}
        with self.assertRaisesRegex(Exception, 'COPY_RUNTIME_NETWORK_MEMBERSHIP_CHANGED'):
            runtime.topology(lambda *_a: route, Path('/r'), services, networks, release)


if __name__ == '__main__':
    unittest.main()
