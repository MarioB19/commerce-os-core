"""V7 F1 Root adoption of the window's infrastructure changes (synthetic rows)."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'scripts'), str(ROOT/'tests/ci')]
import copy_runtime_deployment as runtime  # noqa: E402
import api_web_deployment as native  # noqa: E402
from ci_release import ReleaseError  # noqa: E402
import v7_infra_adoption as m  # noqa: E402
spec = importlib.util.spec_from_file_location('copy_runtime_fixture', ROOT/'tests/ci/test_copy_runtime_deployment.py')
fx = importlib.util.module_from_spec(spec); spec.loader.exec_module(fx)

DATA = {'Type': 'volume', 'Name': 'commerce-os_pg', 'Source': '/var/lib/docker/volumes/commerce-os_pg/_data',
        'Destination': '/var/lib/postgresql/data', 'Driver': 'local', 'Mode': 'z', 'RW': True, 'Propagation': ''}
PROFILES = {'api.env': b'DATABASE_URL=postgres://api\nPORT=3001\n', 'ingress.env': b'DATABASE_URL=postgres://ingress\n',
            'automation.env': b'DATABASE_URL=postgres://automation\n', 'channel.env': b'DATABASE_URL=postgres://channel\n'}


def baseline(gateways=1, unset_dns=None):
    state, rows, _ = fx.fixture(gateways)
    if unset_dns is not None:  # encoding of unset DNS lists in containers created before the window
        for row in rows:
            row['HostConfig'].update(Dns=copy.deepcopy(unset_dns), DnsOptions=copy.deepcopy(unset_dns), DnsSearch=copy.deepcopy(unset_dns))
    by = {row['Config']['Labels'].get('com.docker.compose.service') or ('caddy' if row['Name'] == '/synthetic-caddy' else 'portal'): row
          for row in rows}
    for name in ('api', 'ingress', 'automation-worker', 'channel-worker'):
        by[name]['Config']['Env'] = ['DATABASE_URL=postgres://'+name.split('-')[0], 'NODE_ENV=production']
        by[name]['Config']['Hostname'] = by[name]['Id'][:12]
        by[name]['Config']['Labels']['com.docker.compose.config-hash'] = 'a'*64
        by[name]['Config']['Labels']['com.docker.compose.project.config_files'] = '/r/infra/compose/production.yaml,/r/infra/compose/copy-runtime.yaml'
    pg = by['postgres']
    pg['Mounts'] = [copy.deepcopy(DATA)]
    pg['Config']['Env'] = ['POSTGRES_USER=commerce_owner', 'PG_MAJOR=17']
    pg['Config']['Cmd'] = ['postgres', '-c', 'max_connections=80', '-c', 'shared_buffers=512MB']
    pg['Config']['Labels']['com.docker.compose.project.config_files'] = '/r/infra/compose/production.yaml,/r/infra/compose/copy-runtime.yaml'
    files = {name: b'X=1\n' for name in runtime.FILES} | PROFILES
    state['canonical_files'] = {name: native.reference(m.PRIVATE/name, files[name]) for name in runtime.FILES}
    fx.refresh(state, rows)
    plan = {'schema_version': 3, 'runtime_stage': 'OPERATING', 'preserved_runtime': state['preserved_runtime'],
            'runtime_projection_version': 2, 'source_sha': runtime.SOURCE_SHA,
            'postgres': {'container_id': pg['Id'], 'image': pg['Image'], 'database': 'commerce', 'user': 'commerce_owner',
                         'network': 'commerce-os_core'}}
    plan_raw = m.encode(plan)
    state['b02_plan_ref'] = native.reference(m.PLAN, plan_raw)
    state['b02_plan_sha256'] = state['b02_plan_ref']['sha256']
    state_raw = m.encode(state)
    capture = {'schema_version': 1, 'state_sha256': m.digest(state_raw), 'plan_sha256': m.digest(plan_raw),
               'rows': [m.sanitized(row) for row in rows],
               'profiles': {name: m.env_digests(files[name]) for name in m.PROFILE_FILES}}
    capture['sanitized_digests'] = {row['Id']: runtime.definition_digest(row) for row in capture['rows']}
    networks = {name: {'Name': name, 'Id': fx.checksum(700+i), 'Driver': 'bridge', 'Internal': True, 'EnableIPv6': False,
                       'IPAM': {}, 'Options': {}, 'Labels': {}} for i, name in enumerate(state['network_baseline'])}
    state['network_baseline'] = networks
    state_raw = m.encode(state)
    capture['state_sha256'] = m.digest(state_raw)
    policy = runtime.sealed_bytes({'schema_version': 1, 'host_id': '1', 'adoption_ref': native.reference(m.ADOPTION, state_raw),
                                   'plan_ref': native.reference(m.PLAN, plan_raw), 'gateway_start_ids': {}, 'sessions_autostart': False})
    return {'state': state, 'state_raw': state_raw, 'plan_raw': plan_raw, 'rows': rows, 'by': by, 'files': files,
            'capture': capture, 'networks': networks, 'policy': policy}


def recreate(row, new_index, env_add=(), labels=None):
    new = copy.deepcopy(row)
    new['Id'] = fx.checksum(new_index)
    new['Config']['Hostname'] = new['Id'][:12]
    new['Config']['Env'] = row['Config']['Env'] + list(env_add)
    new['Config']['Labels']['com.docker.compose.config-hash'] = 'b'*64
    new['Config']['Labels'].update(labels or {})
    for endpoint in new['NetworkSettings']['Networks'].values():
        endpoint['EndpointID'] = fx.checksum(new_index+1000)
    new['State']['Pid'] += 77
    return new


def pitr(row, new_index):
    new = recreate(row, new_index, env_add=['PGBACKREST_REPO1_CIPHER_PASS=never-printed'],
                   labels={'org.opencontainers.image.title': 'commerce-os-postgres-pitr', 'com.inovaris.commerce.pgbackrest': '2.59.3-1.pgdg12+1'})
    new['Image'] = 'sha256:'+fx.checksum(4242)
    new['Config']['Image'] = 'commerce-os-postgres:pitr'
    new['Config']['Cmd'] = list(m.PITR_CMD)
    new['Config']['Labels']['com.docker.compose.project.config_files'] += ',/r/infra/compose/postgres-pitr.yaml'
    new['Mounts'] = row['Mounts'] + [{'Type': 'bind', 'Source': '/opt/commerce-os/private/pitr/pgbackrest.conf',
                                      'Destination': '/etc/pgbackrest/pgbackrest.conf', 'RW': False},
                                     {'Type': 'volume', 'Name': 'commerce-os_pitr-spool', 'Destination': '/var/spool/pgbackrest', 'RW': True}]
    new['NetworkSettings']['Networks'][native.PITR_NETWORK] = {'NetworkID': fx.checksum(4343), 'Aliases': ['postgres'], 'GwPriority': 1}
    receipt = {'schema_version': 1, 'state': 'PITR_ENABLED',
               'before': {'container': row['Id'], 'image': row['Image'], 'volume': 'commerce-os_pg', 'networks': sorted(row['NetworkSettings']['Networks']),
                          'system_identifier': '7400000000000000001'},
               'after': {'container': new['Id'], 'image': new['Image'], 'network': native.PITR_NETWORK}}
    return new, receipt


def run(b, rows=None, files=None, networks=None, receipt=None, policy='default'):
    return m.propose(b['capture'], b['state_raw'], b['plan_raw'], b['policy'] if policy == 'default' else policy,
                     rows if rows is not None else b['rows'], networks if networks is not None else b['networks'],
                     files if files is not None else b['files'], receipt, {})


def replace(rows, old, new):
    return [new if row['Id'] == old['Id'] else row for row in rows]


class AdoptionTests(unittest.TestCase):
    def test_no_change_is_an_identity_proposal(self):
        b = baseline()
        proposal, docs = run(b)
        self.assertEqual(proposal['summary']['recreated'], {})
        self.assertEqual(json.loads(docs['state']), json.loads(b['state_raw']) | {'b02_plan_ref': json.loads(docs['state'])['b02_plan_ref'],
                                                                                   'b02_plan_sha256': json.loads(docs['state'])['b02_plan_sha256']})

    def test_v7_settings_recreate_only_their_services_and_rebind_plan_state_and_boot(self):
        b = baseline()
        auto, channel = b['by']['automation-worker'], b['by']['channel-worker']
        new_auto = recreate(auto, 301, ['AI_DATABASE_URL=postgres://ai', 'LAB_ENGINE_DATABASE_URL=postgres://lab', 'MAIL_ENVELOPE_KEY=k'])
        new_channel = recreate(channel, 302, ['INGRESS_RELAY_URL=https://relay/x'])
        rows = replace(replace(b['rows'], auto, new_auto), channel, new_channel)
        files = dict(b['files'], **{'automation.env': PROFILES['automation.env']+b'AI_DATABASE_URL=postgres://ai\nLAB_ENGINE_DATABASE_URL=postgres://lab\nMAIL_ENVELOPE_KEY=k\n',
                                    'channel.env': PROFILES['channel.env']+b'INGRESS_RELAY_URL=https://relay/x\n'})
        proposal, docs = run(b, rows=rows, files=files)
        s = proposal['summary']
        self.assertEqual(s['recreated'], {'automation-worker': ['AI_DATABASE_URL', 'LAB_ENGINE_DATABASE_URL', 'MAIL_ENVELOPE_KEY'],
                                          'channel-worker': ['INGRESS_RELAY_URL']})
        self.assertEqual(s['profiles'], {'automation.env': ['AI_DATABASE_URL', 'LAB_ENGINE_DATABASE_URL', 'MAIL_ENVELOPE_KEY'],
                                         'channel.env': ['INGRESS_RELAY_URL']})
        state, plan = json.loads(docs['state']), json.loads(docs['plan'])
        self.assertEqual(state['service_inventory']['automation-worker'], new_auto['Id'])
        self.assertEqual(plan['preserved_runtime'], state['preserved_runtime'])
        self.assertEqual(state['b02_plan_sha256'], m.digest(docs['plan']))
        runtime.validate_state(state); runtime.validate_inventory(state, rows); runtime.validate_plan(state, docs['plan'])
        policy = json.loads(docs['policy'])
        self.assertEqual(policy['adoption_ref'], native.reference(m.ADOPTION, docs['state']))
        self.assertEqual(policy['plan_ref'], native.reference(m.PLAN, docs['plan']))
        text = json.dumps(proposal)
        for secret in ('postgres://ai', 'postgres://lab', 'https://relay/x'):
            self.assertNotIn(secret, text)

    def test_any_other_difference_is_refused(self):
        b = baseline()
        auto, web, api = b['by']['automation-worker'], b['by']['web'], b['by']['api']
        cases = {
            'unlisted setting': ([(auto, recreate(auto, 301, ['DISPATCH_FROZEN=false']))], {'automation.env': PROFILES['automation.env']+b'DISPATCH_FROZEN=false\n'}),
            'web replaced': ([(web, recreate(web, 301))], {}),
            'profile not loaded': ([], {'api.env': PROFILES['api.env']+b'AI_DATABASE_URL=x\n'}),
            'other file': ([], {'admin.env': b'X=2\n'}),
            'removed setting': ([(api, dict(recreate(api, 301), Config=dict(recreate(api, 301)['Config'], Env=['NODE_ENV=production'])))], {}),
        }
        for label, (swaps, file_changes) in cases.items():
            with self.subTest(label):
                rows = b['rows']
                for old, new in swaps:
                    rows = replace(rows, old, new)
                with self.assertRaises(ReleaseError):
                    run(b, rows=rows, files=dict(b['files'], **file_changes))
        changed = copy.deepcopy(b['rows'])
        changed[0]['HostConfig']['Privileged'] = True
        with self.assertRaises(ReleaseError):
            run(b, rows=changed)
        mount = recreate(auto, 301, ['AI_DATABASE_URL=x']); mount['Mounts'] = [{'Type': 'bind', 'Destination': '/data/laboratory'}]
        with self.assertRaises(ReleaseError):
            run(b, rows=replace(b['rows'], auto, mount), files=dict(b['files'], **{'automation.env': PROFILES['automation.env']+b'AI_DATABASE_URL=x\n'}))

    def test_postgres_with_pitr_needs_its_receipt_and_rebinds_the_b02_postgres_identity(self):
        b = baseline()
        pg = b['by']['postgres']
        new_pg, receipt = pitr(pg, 401)
        rows = replace(b['rows'], pg, new_pg)
        networks = dict(b['networks'], **{native.PITR_NETWORK: {'Name': native.PITR_NETWORK, 'Id': fx.checksum(4343), 'Driver': 'bridge',
                                                                  'Internal': False, 'EnableIPv6': False, 'IPAM': {}, 'Options': {}, 'Labels': {}}})
        with self.assertRaises(ReleaseError):
            run(b, rows=rows, networks=networks)  # no evidence
        proposal, docs = run(b, rows=rows, networks=networks, receipt=receipt)
        self.assertEqual(proposal['summary']['postgres']['transition'], 'PITR_ENABLED')
        self.assertEqual(proposal['summary']['networks_added'], [native.PITR_NETWORK])
        plan = json.loads(docs['plan'])
        self.assertEqual(plan['postgres'], {'container_id': new_pg['Id'], 'image': new_pg['Image'], 'database': 'commerce',
                                            'user': 'commerce_owner', 'network': 'commerce-os_core'})
        self.assertNotIn('never-printed', json.dumps(proposal))
        for mutate in ('volume', 'network', 'command'):
            bad = copy.deepcopy(new_pg)
            if mutate == 'volume': bad['Mounts'][0]['Name'] = 'other'
            if mutate == 'network': bad['NetworkSettings']['Networks']['extra'] = {'NetworkID': fx.checksum(1), 'Aliases': [], 'GwPriority': 0}
            if mutate == 'command': bad['Config']['Cmd'] = ['postgres', '-c', 'archive_mode=off']
            with self.subTest(mutate), self.assertRaises(ReleaseError):
                run(b, rows=replace(b['rows'], pg, bad), networks=networks, receipt=receipt)
        with self.assertRaises(ReleaseError):
            run(b, networks=networks)  # PITR network without a PITR transition

    def test_baseline_must_not_move_between_capture_and_proposal(self):
        b = baseline()
        b['capture']['state_sha256'] = '0'*64
        with self.assertRaises(ReleaseError):
            run(b)
        b = baseline()
        bad_policy = runtime.sealed_bytes({'adoption_ref': native.reference(m.ADOPTION, b'other'), 'plan_ref': native.reference(m.PLAN, b['plan_raw'])})
        with self.assertRaises(ReleaseError):
            run(b, policy=bad_policy)
        self.assertIsNone(run(b, policy=None)[1]['policy'])


if __name__ == '__main__':
    unittest.main()


class LaboratoryMountTests(unittest.TestCase):
    """The first V7 publication may add exactly one read-write lab bind to automation-worker."""

    def rows(self):
        private = {'Type': 'bind', 'Source': '/srv/commerce/assets', 'Destination': '/data/private', 'Mode': 'ro', 'RW': False, 'Propagation': 'rprivate'}
        old = {'HostConfig': {'Binds': ['/srv/commerce/assets:/data/private:ro'], 'ReadonlyRootfs': True}, 'Mounts': [private],
               'NetworkSettings': {'Networks': {'commerce-os_core': {'NetworkID': fx.checksum(1), 'Aliases': [], 'GwPriority': 0}}}}
        lab = {'Type': 'bind', 'Source': '/srv/commerce/assets/number-lab', 'Destination': '/data/laboratory', 'Mode': '', 'RW': True, 'Propagation': 'rprivate'}
        new = copy.deepcopy(old)
        new['HostConfig']['Binds'].append('/srv/commerce/assets/number-lab:/data/laboratory:rw')
        new['Mounts'].append(lab)
        return old, new

    def test_only_the_lab_bind_is_accepted_once_and_only_for_automation(self):
        old, new = self.rows()
        self.assertTrue(runtime.application_boundary_equal('automation-worker', old, new))
        self.assertTrue(runtime.application_boundary_equal('automation-worker', new, copy.deepcopy(new)))
        self.assertFalse(runtime.application_boundary_equal('api', old, new))
        self.assertFalse(runtime.application_boundary_equal('automation-worker', new, self.rows()[1] | {'Mounts': new['Mounts'] + [new['Mounts'][1]]}))
        for mutate in ('source', 'readonly', 'private_rw', 'host', 'network', 'extra_bind'):
            bad_old, bad = self.rows()
            if mutate == 'source': bad['Mounts'][1]['Source'] = '/srv/other'
            if mutate == 'readonly': bad['Mounts'][1]['RW'] = False
            if mutate == 'private_rw': bad['Mounts'][0]['RW'] = True; bad_old['Mounts'][0]['RW'] = True
            if mutate == 'host': bad['HostConfig']['Privileged'] = True
            if mutate == 'network': bad['NetworkSettings']['Networks']['x'] = {'NetworkID': fx.checksum(2), 'Aliases': [], 'GwPriority': 0}
            if mutate == 'extra_bind': bad['HostConfig']['Binds'].append('/etc:/host-etc:ro')
            with self.subTest(mutate):
                self.assertFalse(runtime.application_boundary_equal('automation-worker', bad_old, bad))

    def test_compose_definition_carries_exactly_that_mount(self):
        text = (ROOT/'infra/compose/production.yaml').read_text()
        self.assertIn("volumes: ['${COMMERCE_PRIVATE_ASSETS_DIR}:/data/private:ro', '${COMMERCE_PRIVATE_ASSETS_DIR}/number-lab:/data/laboratory']", text)
        self.assertEqual(text.count('/data/laboratory'), 1)


class EngineEncodingTests(unittest.TestCase):
    """21-oct-2026: application containers installed on 10-oct carry [] for unset DNS lists and the
    ones recreated on the same host now carry null. Same definition; nothing else is relaxed."""

    def rows(self):
        old, new = LaboratoryMountTests().rows()
        old['HostConfig'].update(Dns=[], DnsOptions=[], DnsSearch=[])
        new['HostConfig'].update(Dns=None, DnsOptions=None, DnsSearch=None)
        same = copy.deepcopy(old); same['HostConfig'].update(Dns=None, DnsOptions=None, DnsSearch=None)
        return old, new, same

    def test_unset_dns_lists_compare_equal_and_any_real_value_still_differs(self):
        old, new, same = self.rows()
        for name in ('api', 'web', 'ingress', 'channel-worker', 'automation-worker'):
            with self.subTest(name):
                self.assertTrue(runtime.application_boundary_equal(name, old, same))
        self.assertTrue(runtime.application_boundary_equal('automation-worker', old, new))
        absent = copy.deepcopy(same)
        for key in runtime.ENGINE_UNSET_HOST_LISTS:
            absent['HostConfig'].pop(key)
        self.assertTrue(runtime.application_boundary_equal('api', old, absent))
        for key, value in (('Dns', ['8.8.8.8']), ('DnsOptions', ['ndots:1']), ('DnsSearch', ['corp'])):
            for target in (same, new):
                bad = copy.deepcopy(target); bad['HostConfig'][key] = value
                with self.subTest(key=key, lab=target is new):
                    self.assertFalse(runtime.application_boundary_equal('automation-worker' if target is new else 'api', old, bad))
        other = copy.deepcopy(old); other['HostConfig']['CapAdd'] = []
        other_new = copy.deepcopy(same); other_new['HostConfig']['CapAdd'] = None
        self.assertFalse(runtime.application_boundary_equal('api', other, other_new))
        self.assertEqual(old['HostConfig']['Dns'], []); self.assertIsNone(new['HostConfig']['Dns'])
        with self.assertRaises(ReleaseError):
            runtime.engine_neutral_host(None)

    def test_pitr_postgres_created_by_the_current_host_is_adopted(self):
        b = baseline(unset_dns=[])
        pg = b['by']['postgres']
        self.assertEqual(pg['HostConfig']['Dns'], [])
        new_pg, receipt = pitr(pg, 401)
        new_pg['HostConfig'].update(Dns=None, DnsOptions=None, DnsSearch=None)
        networks = dict(b['networks'], **{native.PITR_NETWORK: {'Name': native.PITR_NETWORK, 'Id': fx.checksum(4343), 'Driver': 'bridge',
                                                                  'Internal': False, 'EnableIPv6': False, 'IPAM': {}, 'Options': {}, 'Labels': {}}})
        rows = replace(b['rows'], pg, new_pg)
        self.assertEqual(run(b, rows=rows, networks=networks, receipt=receipt)[0]['summary']['postgres']['transition'], 'PITR_ENABLED')
        bad = copy.deepcopy(new_pg); bad['HostConfig']['Dns'] = ['8.8.8.8']
        with self.assertRaises(ReleaseError):
            run(b, rows=replace(b['rows'], pg, bad), networks=networks, receipt=receipt)
