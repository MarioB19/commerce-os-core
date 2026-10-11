"""Synthetic regressions for one existing account's additional gateway.

These fixtures never authorize a Root operation, contact a provider or create a
container. Production approval still comes only from native observed evidence.
"""
import copy
import contextlib
import datetime as dt
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import additional_existing_gateway as additional
import initial_pilot_adoption_approvals as adoption
from ci_release import ReleaseError
from test_copy_runtime_deployment import fixture
from test_initial_pilot_adoption_approvals import bound_journals
from test_initial_pilot_root import m as pilot
from test_b02_gcp import fixtures as gcp_fixtures, r as b02, c as b02_contract, NOW as GCP_NOW, TOKEN, UID

spec = importlib.util.spec_from_file_location('additional_root_fixture', ROOT / 'scripts/additional-existing-gateway-root.py')
actuator = importlib.util.module_from_spec(spec); spec.loader.exec_module(actuator)

NOW = dt.datetime(2026, 10, 9, 15, 30, tzinfo=dt.timezone.utc)
ACCOUNT = '22222222-2222-4222-8222-222222222222'
SLOT = '33333333-3333-4333-8333-333333333333'
OP = '11111111-1111-4111-8111-111111111111'
WORKSPACE = 'synthetic-workspace'


def baseline():
    state, rows, plan_raw = fixture(1)
    rows[-1]['State'].update(Running=True, Pid=1234)
    services = dict(zip(state['service_inventory'], rows))
    return {'state': state, 'services': services, 'plan_raw': plan_raw,
            'workspace': WORKSPACE, 'source_sha': 'a' * 40}


def operation():
    op = {'id': OP, 'workspace_id': WORKSPACE, 'environment': 'REAL',
          'action': 'PROVISION', 'state': 'HUMAN_ACTION_REQUIRED',
          'version': 2, 'lease_until': None,
          'created_at': (NOW - dt.timedelta(seconds=20)).isoformat(),
          'input': {'existing_account': True, 'slot_id': SLOT,
                    'account_id': ACCOUNT, 'gateway_profile_ref': 'WAHA_03',
                    'expected_account_version': 7, 'expected_session_version': 8}}
    slot = {'id': SLOT, 'workspace_id': WORKSPACE, 'environment': 'REAL',
            'host_ref': 'primary', 'slot': 3, 'state': 'RESERVED',
            'account_id': ACCOUNT, 'gateway_ref': 'waha-03', 'version': 4,
            'operation_id': OP,
            'readback': {'verified': False, 'source': 'legacy_gateway_reconciliation'}}
    return op, slot


def completed_journals(slot=3):
    args = bound_journals()
    gateway = args[6].pop('waha-01')
    args[6]['waha-' + str(slot).zfill(2)] = gateway
    prepared_gateway = args[3]['services'].pop('waha-01')
    args[3]['services']['waha-' + str(slot).zfill(2)] = prepared_gateway
    args[5]['readback']['slot'] = slot
    args[8]['slot'] = slot
    args[8]['readback']['slot'] = slot
    args[4]['requested_at'] = (args[-1] - dt.timedelta(seconds=45)).isoformat()
    return args


def additional_services():
    before = baseline()['services']; after = copy.deepcopy(before)
    target = copy.deepcopy(before['waha-01'])
    target.update(Id='3' * 64, Name='/synthetic-waha-03', RestartCount=0)
    target['Config']['Labels']['com.docker.compose.service'] = 'waha-03'
    target['HostConfig'].update(CapDrop=['ALL'], Init=True, PidsLimit=100,
        Memory=768 * 1024 ** 2, NanoCpus=300000000, SecurityOpt=['no-new-privileges:true'])
    target['State'].update(Running=False, Pid=0)
    target['Mounts'] = [{'Destination': '/app/.sessions', 'Name': 'commerce-os_waha-03-sessions'},
                        {'Destination': '/app/.media', 'Name': 'commerce-os_waha-03-media'}]
    target['NetworkSettings']['Networks'] = {'commerce-os_gateway-03': {'NetworkID': '', 'Aliases': ['waha-03']}}
    after['waha-03'] = target
    for name in ('channel-worker', 'ingress'):
        after[name]['NetworkSettings']['Networks']['commerce-os_gateway-03'] = {
            'NetworkID': 'd' * 64, 'EndpointID': 'e' * 64,
            'IPAddress': '192.0.2.99', 'Aliases': [name], 'GwPriority': 0}
    return before, after


def approval():
    value = {name: {'path': '/synthetic/' + name + '.json', 'bytes': 1, 'sha256': 'e' * 64}
             for name in additional.FIELDS if name.endswith('_ref')}
    value.update(schema_version=1, source_sha='a' * 40,
                 current_release='/opt/commerce-os/releases/synthetic', run_id='123-1',
                 operation_id=OP, before_adoption_sha256='b' * 64, before_plan_sha256='c' * 64,
                 compose_sha256='d' * 64, target_slot=3, volume_mode='CREATE_EMPTY',
                 credential_refs={'waha-03.env': {'path': '/synthetic/waha-03.env', 'bytes': 1, 'sha256': 'f' * 64}},
                 credential_binding={'account_id': ACCOUNT, 'account_version': 7, 'session_version': 8,
                    'profile_key': 'waha:WAHA_03', 'profile_version': 4,
                    'credentials_match': True, 'profile_disabled': True})
    return value


class ExistingGatewayBaseline(unittest.TestCase):
    def test_exact_nine_service_baseline_preserves_existing_gateway_receipt(self):
        before = baseline(); original = copy.deepcopy(before)
        additional.baseline_guard(before)
        self.assertEqual(before, original)
        self.assertEqual(set(before['state']['gateway_provisioning']), {'waha-01'})
        self.assertEqual(len(before['services']), 9)

    def test_initial_no_gateway_extra_gateway_and_missing_core_are_rejected(self):
        for change in (
            lambda b: b['services'].pop('waha-01'),
            lambda b: b['services'].update({'waha-02': copy.deepcopy(b['services']['waha-01'])}),
            lambda b: b['services'].pop('automation-worker'),
            lambda b: b['state']['gateway_provisioning'].clear(),
            lambda b: b['state']['gateway_provisioning'].update({'waha-03': {}}),
            lambda b: b['state'].update(runtime_stage='CORE_PREPARED'),
            lambda b: b['state'].update(schema_version=2),
        ):
            before = baseline(); change(before)
            with self.subTest(change=change), self.assertRaises(ReleaseError):
                additional.baseline_guard(before)


class ExistingAccountOperation(unittest.TestCase):
    def test_reserved_legacy_slot_and_same_existing_account_are_accepted_without_mutation(self):
        for reference in ('WAHA_03', 'waha-03'):
            for state in ('RESERVED', 'HUMAN_ACTION_REQUIRED'):
                with self.subTest(reference=reference, state=state):
                    op, slot = operation(); op['state'] = state
                    slot['gateway_ref'] = reference
                    original = copy.deepcopy((op, slot))
                    additional.operation_guard(op, slot, WORKSPACE, NOW)
                    self.assertEqual((op, slot), original)

    def test_only_exact_slot3_references_and_profile_are_accepted(self):
        for reference in ('WAHA_01', 'WAHA_02', 'WAHA_04', 'waha-01', 'waha-02',
                          'waha-04', 'waha_03', 'WAHA-03', 'waha-3', 'WAHA_3',
                          'prefix-WAHA_03', 'http://waha-03:3000', ' WAHA_03',
                          'waha-03 ', '', None):
            op, slot = operation(); slot['gateway_ref'] = reference
            with self.subTest(reference=reference), self.assertRaises(ReleaseError):
                additional.operation_guard(op, slot, WORKSPACE, NOW)
        for reference in ('WAHA_03', 'waha-03'):
            for profile in ('WAHA_01', 'WAHA_02', 'WAHA_04', 'waha-03',
                            'waha:WAHA_03', 'prefix-WAHA_03', None):
                op, slot = operation(); slot['gateway_ref'] = reference
                op['input']['gateway_profile_ref'] = profile
                with self.subTest(reference=reference, profile=profile), self.assertRaises(ReleaseError):
                    additional.operation_guard(op, slot, WORKSPACE, NOW)

    def test_never_substitutes_expand_new_account_other_slot_or_binding(self):
        mutations = (
            lambda o, s: o.update(action='EXPAND'),
            lambda o, s: o['input'].update(existing_account=False),
            lambda o, s: o['input'].update(existing_account='true'),
            lambda o, s: o.update(environment='SIMULATION'),
            lambda o, s: s.update(environment='SIMULATION'),
            lambda o, s: s.update(gateway_ref='waha-01'),
            lambda o, s: s.update(workspace_id='other-workspace'),
            lambda o, s: o.update(workspace_id='other-workspace'),
            lambda o, s: s.update(account_id='44444444-4444-4444-8444-444444444444'),
            lambda o, s: s.update(operation_id='55555555-5555-4555-8555-555555555555'),
            lambda o, s: s.update(id='66666666-6666-4666-8666-666666666666'),
        )
        for change in mutations:
            op, slot = operation(); change(op, slot)
            with self.subTest(change=change), self.assertRaises(ReleaseError):
                additional.operation_guard(op, slot, WORKSPACE, NOW)
        for reference in ('WAHA_03', 'waha-03'):
            for wrong_slot in (1, 2, 4, True, '3'):
                op, slot = operation(); slot['slot'] = wrong_slot
                slot['gateway_ref'] = reference
                with self.subTest(reference=reference, slot=wrong_slot), self.assertRaises(ReleaseError):
                    additional.operation_guard(op, slot, WORKSPACE, NOW)

    def test_unknown_inflight_terminal_and_live_lease_cannot_authorize_creation(self):
        for state in ('REQUESTED', 'PREPARING', 'UNKNOWN', 'FAILED', 'SUCCEEDED'):
            op, slot = operation(); op['state'] = state
            with self.subTest(state=state), self.assertRaises(ReleaseError):
                additional.operation_guard(op, slot, WORKSPACE, NOW)
        op, slot = operation(); op['lease_until'] = (NOW + dt.timedelta(seconds=1)).isoformat()
        with self.assertRaises(ReleaseError): additional.operation_guard(op, slot, WORKSPACE, NOW)

    def test_elapsed_lease_is_not_remote_isolation_or_a_phone_attestation(self):
        op, slot = operation(); op['lease_until'] = (NOW - dt.timedelta(seconds=1)).isoformat()
        original = copy.deepcopy((op, slot))
        additional.operation_guard(op, slot, WORKSPACE, NOW)
        self.assertEqual((op, slot), original)
        self.assertNotIn('source_isolation', op)
        self.assertNotIn('authentication_verified', slot['readback'])


class ExactApprovalAndCredentials(unittest.TestCase):
    def test_closed_approval_references_only_slot3(self):
        value = approval(); original = copy.deepcopy(value)
        additional.approval_guard(value)
        self.assertEqual(value, original)

    def test_wrong_slot_schema_credential_or_reference_is_rejected(self):
        changes = (
            lambda v: v.update(target_slot=1), lambda v: v.update(target_slot=2),
            lambda v: v.update(target_slot=True), lambda v: v.update(extra='unreviewed'),
            lambda v: v.pop('gcp_binding_ref'), lambda v: v.update(schema_version=True),
            lambda v: v['credential_refs'].update({'waha-01.env': v['credential_refs']['waha-03.env']}),
            lambda v: v['additional_overlay_ref'].update(sha256='bad'),
            lambda v: v.update(volume_mode='ASSUME_EMPTY'),
        )
        for change in changes:
            value = approval(); change(value)
            with self.subTest(change=change), self.assertRaises(ReleaseError): additional.approval_guard(value)

    def test_existing_credentials_use_only_stdin_and_return_boolean_metadata(self):
        op, _ = operation(); commands = []
        secret = {'WAHA_API_KEY': 'synthetic-private-api-key', 'WHATSAPP_HOOK_HMAC_KEY': 'synthetic-private-hook'}
        def credentials(slot, create):
            self.assertEqual(slot, 3); self.assertIs(create, False)
            return secret
        def command(argv, root, payload):
            commands.append(argv)
            self.assertNotIn('synthetic-private-api-key', ' '.join(argv))
            self.assertNotIn('synthetic-private-hook', ' '.join(argv))
            self.assertEqual(json.loads(payload)['account_id'], ACCOUNT)
            self.assertEqual(json.loads(payload)['profile_key'], 'waha:WAHA_03')
            return json.dumps(approval()['credential_binding'])
        server = SimpleNamespace(PRIVATE=Path('/synthetic/private'), command=command)
        result = additional.credential_binding(server, Path('/synthetic/release'), SimpleNamespace(credentials=credentials), op, WORKSPACE, 'a' * 40)
        self.assertEqual(result, approval()['credential_binding'])
        self.assertEqual(secret, {})
        self.assertEqual(len(commands), 1)
        self.assertIn('READ ONLY', additional.CREDENTIAL_JS)

    def test_credential_mismatch_or_another_account_never_counts_as_binding(self):
        op, _ = operation()
        for change in ({'credentials_match': False}, {'profile_disabled': False},
                       {'account_id': 'another-account'}, {'profile_version': False},
                       {'profile_key': 'waha:WAHA_01'}, {'session_version': 9}):
            result = approval()['credential_binding'] | change
            server = SimpleNamespace(PRIVATE=Path('/synthetic/private'), command=lambda *args: json.dumps(result))
            agent = SimpleNamespace(credentials=lambda *args, **kwargs: {
                'WAHA_API_KEY': 'synthetic-api-key', 'WHATSAPP_HOOK_HMAC_KEY': 'synthetic-hook'})
            with self.subTest(change=change), self.assertRaises(ReleaseError):
                additional.credential_binding(server, Path('/synthetic/release'), agent, op, WORKSPACE, 'a' * 40)


class PreservedNativeDefinitions(unittest.TestCase):
    def test_only_worker_network_attachment_is_added_to_the_nine_existing_services(self):
        before, after = additional_services(); original = copy.deepcopy((before, after))
        pilot.preserved(before, after, slot=3)
        self.assertEqual((before, after), original)
        self.assertEqual(before['waha-01'], after['waha-01'])
        self.assertNotIn('waha-02', after)

    def test_existing_cid_image_config_mount_network_or_restart_drift_is_rejected(self):
        changes = (
            lambda a: a['waha-01'].update(Id='a' * 64),
            lambda a: a['waha-01'].update(Image='sha256:' + 'b' * 64),
            lambda a: a['waha-01']['Config'].update(Cmd=['different']),
            lambda a: a['waha-01']['Mounts'].append({'Destination': '/foreign', 'Name': 'foreign'}),
            lambda a: a['waha-01']['State'].update(StartedAt='2026-10-09T15:00:00Z'),
            lambda a: a['channel-worker']['NetworkSettings']['Networks'].pop('synthetic-core'),
            lambda a: a['ingress']['NetworkSettings']['Networks'].update({'foreign': {'NetworkID': 'c' * 64}}),
            lambda a: a.update({'waha-02': copy.deepcopy(a['waha-03'])}),
        )
        for change in changes:
            before, after = additional_services(); change(after)
            with self.subTest(change=change), self.assertRaises(ReleaseError): pilot.preserved(before, after, slot=3)

    def test_created_slot3_is_private_bounded_and_never_borrows_slot1_storage(self):
        _, services = additional_services(); target = services['waha-03']
        pilot.gateway_guard(target, target['Image'], slot=3)
        for change in (
            lambda t: t['Mounts'][0].update(Name='commerce-os_waha-01-sessions'),
            lambda t: t['HostConfig'].update(PortBindings={'3000/tcp': [{'HostPort': '3000'}]}),
            lambda t: t['HostConfig'].update(Privileged=True),
            lambda t: t['HostConfig'].update(Memory=2 * 1024 ** 3),
            lambda t: t['Config']['Env'].append('WHATSAPP_START_SESSION=default'),
        ):
            row = copy.deepcopy(target); change(row)
            with self.subTest(change=change), self.assertRaises(ReleaseError): pilot.gateway_guard(row, row['Image'], slot=3)

    def test_created_network_id_is_observed_empty_until_start(self):
        state = baseline()['state']; _, services = additional_services()
        rows = list(services.values())
        def command(argv, *_):
            if argv[:3] == ['docker', 'ps', '-aq']: return ' '.join(r['Id'] for r in rows)
            if argv[:2] == ['docker', 'inspect']: return json.dumps(rows)
            raise AssertionError(argv)
        with patch.object(pilot.server, 'command', side_effect=command):
            actual = pilot.read_services(Path('/synthetic/release'), state, slot=3)
        self.assertEqual(actual['waha-03']['NetworkSettings']['Networks']['commerce-os_gateway-03']['NetworkID'], '')
        self.assertEqual(actual['waha-01'], services['waha-01'])

    def test_partial_volume_presence_never_allows_empty_creation(self):
        for present in ('commerce-os_waha-03-sessions', 'commerce-os_waha-03-media'):
            with self.subTest(present=present), patch.object(pilot.server, 'command', return_value=present) as command:
                with self.assertRaisesRegex(ReleaseError, 'PARTIAL_VOLUME'): pilot.volume_snapshot(Path('/synthetic'), slot=3)
                self.assertEqual(command.call_count, 1)


class AdditionalHttpAndCanonicalReceipt(unittest.TestCase):
    def test_slot3_uses_its_own_start_http_slot_and_provision_event(self):
        args = completed_journals(); original = copy.deepcopy(args)
        adoption.journal_binding(*args, slot=3)
        self.assertEqual(args, original)

    def test_pilot_default_slot1_remains_closed_and_compatible(self):
        adoption.journal_binding(*bound_journals())
        with self.assertRaises(ReleaseError): adoption.journal_binding(*completed_journals())
        with self.assertRaises(ReleaseError): adoption.journal_binding(*bound_journals(), slot=3)

    def test_slot1_http_cannot_authorize_slot3_even_if_cid_matches(self):
        for change in (
            lambda a: a[5]['readback'].update(slot=1),
            lambda a: a[8].update(slot=1),
            lambda a: a[8].update(account_id='another-account'),
            lambda a: a[8].update(operation_id='another-operation'),
            lambda a: a[9].update(aggregate_id='another-operation'),
            lambda a: a[9]['payload'].update(outcome='UNKNOWN'),
        ):
            args = completed_journals(); change(args)
            with self.subTest(change=change), self.assertRaises(ReleaseError):
                adoption.journal_binding(*args, slot=3)


    def test_missing_http_does_not_become_zero_sessions(self):
        for change in (
            lambda a: a.__setitem__(5, {}),
            lambda a: a[5]['readback'].pop('session_count'),
            lambda a: a[5]['readback'].update(session_count=False),
            lambda a: a[5]['readback'].update(session_count=1),
            lambda a: a[8]['readback'].update(connected_sessions=1),
            lambda a: a[4].update(container_id='f' * 64),
            lambda a: a[5].update(container_id='e' * 64),
            lambda a: a[6]['waha-03']['State'].update(Running=False),
        ):
            args = completed_journals(); change(args)
            with self.subTest(change=change), self.assertRaises(ReleaseError):
                adoption.journal_binding(*args, slot=3)

    def test_http_and_verified_audit_cannot_precede_the_same_operation(self):
        for change in (
            lambda a: a[5].update(observed_at=a[7]['created_at']),
            lambda a: a[8]['readback'].update(observed_at=a[7]['created_at']),
            lambda a: a[9].update(occurred_at=a[7]['created_at']),
        ):
            args = completed_journals(); change(args)
            with self.subTest(change=change), self.assertRaises(ReleaseError):
                adoption.journal_binding(*args, slot=3)

class AdditionalActuator(unittest.TestCase):
    """Execute the real control flow with synthetic host I/O, never Docker/API."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='commerce-additional-fixture-')
        self.root = Path(self.tmp.name); self.private = self.root / 'private'; self.private.mkdir(mode=0o700)
        (self.root / 'infra/compose').mkdir(parents=True)
        (self.root / 'infra/compose/pilot.yaml').write_bytes((ROOT / 'infra/compose/pilot.yaml').read_bytes())
        (self.private / 'daily-b02').mkdir(mode=0o700)
        b = baseline(); self.state = b['state']
        self.plan = actuator.runtime.sealed_bytes(json.loads(b['plan_raw']) | {'schedule_enabled': False})
        self.state['b02_plan_sha256'] = actuator.runtime.sha256(self.plan)
        self.state['b02_plan_ref'].update(bytes=len(self.plan), sha256=self.state['b02_plan_sha256'])
        self.before, added = additional_services(); self.services = copy.deepcopy(self.before)
        self.gateway = added['waha-03']; self.gateway['State']['Status'] = 'created'
        self.state_raw = actuator.runtime.sealed_bytes(self.state)
        (self.private / 'api-web-adoption.json').write_bytes(self.state_raw)
        (self.private / 'daily-b02/plan.json').write_bytes(self.plan)
        self.env = b'COMMERCE_PILOT_RELEASE_ENV=/synthetic/pilot-release.env\n'
        (self.private / 'release.env').write_bytes(self.env)
        self.config = {'api_origin': 'https://synthetic.invalid', 'token_file': '/synthetic/token',
            'release_env': str(self.private / 'release.env'), 'gateway_dir': '/synthetic/gateways',
            'overlay': str(self.private / 'additional-gateways.json')}
        self.overlay = actuator.runtime.sealed_bytes(actuator.pilot.administrator.helper.overlay(['03'], self.config['gateway_dir']))
        self.volumes = [{'Name': name, 'Driver': 'local',
            'Mountpoint': str(self.root / 'volumes' / name / '_data'),
            'Labels': {'com.docker.compose.project': 'commerce-os',
                'com.docker.compose.volume': name.removeprefix('commerce-os_')}} for name in actuator.pilot.gateway_volumes(3)]
        self.volume_names = sorted(['commerce-os_pg', *actuator.pilot.gateway_volumes(1), *actuator.pilot.gateway_volumes(3)])
        self.new_volumes = copy.deepcopy(self.volumes)
        now = dt.datetime.now(dt.timezone.utc)
        self.backup = now - dt.timedelta(seconds=4)
        self.op, self.slot = operation(); self.op['created_at'] = (now - dt.timedelta(seconds=2)).isoformat()
        self.ownership = {'held': True, 'hold_at': now.isoformat(), 'ownerships': [], 'proofs': [], 'challenges': []}
        self.approval = approval(); self.approval.update(current_release=str(self.root), volume_mode='PRESERVE_EXISTING',
            before_adoption_sha256=actuator.runtime.sha256(self.state_raw), before_plan_sha256=actuator.runtime.sha256(self.plan))
        self.approval['pilot_release_env_ref']['path'] = '/synthetic/pilot-release.env'
        self.approval['credential_refs']['waha-03.env']['path'] = '/synthetic/gateways/waha-03.env'
        pinned = actuator.re.search(r'^    image: (.+)$', (self.root / 'infra/compose/pilot.yaml').read_text(), actuator.re.M).group(1)
        self.rendered = json.dumps({'name': 'commerce-os', 'services': {'waha-03': {
            'image': pinned, 'restart': 'no', 'init': True, 'cap_drop': ['ALL'], 'pids_limit': 100,
            'mem_limit': 768 * 1024**2, 'cpus': 0.3, 'security_opt': ['no-new-privileges:true'],
            'networks': {'gateway-03': {}}, 'environment': actuator.native.env_values(('\n'.join(self.gateway['Config']['Env']) + '\n').encode()),
            'volumes': [{'type': 'volume', 'source': 'sessions', 'target': '/app/.sessions'},
                {'type': 'volume', 'source': 'media', 'target': '/app/.media'}]}},
            'volumes': {'sessions': {'name': actuator.pilot.gateway_volumes(3)[0]}, 'media': {'name': actuator.pilot.gateway_volumes(3)[1]}},
            'networks': {'gateway-03': {'name': 'commerce-os_gateway-03'}}})
        self.approval['compose_sha256'] = actuator.runtime.sha256(self.rendered.encode())
        self.ref = {'path': '/synthetic/approval.json', 'bytes': 1, 'sha256': 'a' * 64}
        self.refs = {self.approval[name]['path']: raw for name, raw in (
            ('administrator_config_ref', actuator.runtime.sealed_bytes(self.config)),
            ('pilot_release_env_ref', b'COMMERCE_GATEWAY_CONFIG_DIR=/synthetic/gateways\n'),
            ('new_release_env_ref', self.env), ('additional_overlay_ref', self.overlay),
            ('gcp_binding_ref', b'synthetic-manual-binding'),
            ('volume_inventory_ref', actuator.runtime.sealed_bytes({'names': self.volume_names, 'volumes': self.volumes})),
            ('runtime_before_ref', actuator.runtime.sealed_bytes({'captured_at': (now - dt.timedelta(seconds=3)).isoformat(), 'services': self.before})))}
        self.refs[self.approval['credential_refs']['waha-03.env']['path']] = b'synthetic-secret-not-a-credential'
        self.commands = []; self.http_calls = 0; self.http_failure = False; self.sessions = 0; self.start_failure = False
        owner = self
        class Agent:
            def __init__(self, config): owner.assertEqual(config, owner.config)
            def compose(self, *argv):
                owner.commands.append(('compose', *argv))
                if argv == ('config', '--format', 'json'): return owner.rendered
                owner.assertEqual(argv, ('create', '--no-build', '--no-recreate', '--pull', 'never', 'waha-03'))
                owner.services['waha-03'] = copy.deepcopy(owner.gateway)
                if owner.approval['volume_mode'] == 'CREATE_EMPTY':
                    owner.volumes = copy.deepcopy(owner.new_volumes)
                    owner.volume_names = sorted(set(owner.volume_names) | set(actuator.pilot.gateway_volumes(3)))
                    for row in owner.volumes: Path(row['Mountpoint']).mkdir(parents=True)
                return ''
            def snapshot(self, slot): owner.assertEqual(slot, 3); return copy.deepcopy(owner.services['waha-03'])
            def readback(self, slot):
                owner.assertEqual(slot, 3); owner.http_calls += 1
                if owner.http_failure: raise ReleaseError('BOUNDED_HOST_COMMAND_FAILED')
                return {'slot': 3, 'running': owner.services['waha-03']['State']['Running'],
                    'session_count': owner.sessions, 'connected_sessions': 0, 'image_digest': owner.gateway['Image'],
                    'network_present': True, 'volumes_preserved': True}
        self.stack = contextlib.ExitStack()
        def p(obj, name, **kw): return self.stack.enter_context(patch.object(obj, name, **kw))
        p(actuator, 'ROOT', new=self.root); p(actuator.server, 'PRIVATE', new=self.private)
        p(actuator.os, 'geteuid', return_value=0); p(actuator.sys, 'platform', new='linux')
        p(additional, 'load_approval', side_effect=lambda _: (self.ref, self.approval))
        p(additional, 'read_operation', side_effect=lambda *_: {'operation': self.op, 'slot': self.slot})
        self.binding = p(additional, 'credential_binding', side_effect=lambda *_: copy.deepcopy(self.approval['credential_binding']))
        p(additional, 'manual_binding', side_effect=lambda *_: self.approval['gcp_binding_ref'])
        p(actuator.native, 'protected_bytes', side_effect=lambda path: Path(path).read_bytes())
        p(actuator.native, 'read_reference', side_effect=lambda ref: self.refs[ref['path']])
        p(actuator.native, 'acquire_locks', return_value=[])
        p(actuator.review, 'private_directory', side_effect=lambda path, create=False: (Path(path).mkdir(mode=0o700, exist_ok=True) if create else None) or Path(path))
        p(actuator.initial, 'file_ref', side_effect=lambda path: actuator.native.reference(Path(path), Path(path).read_bytes()))
        p(actuator.pilot, 'read_services', side_effect=lambda *_: copy.deepcopy(self.services))
        p(actuator.pilot, 'network_guard', return_value={'synthetic-existing-and-target': 'sealed'})
        p(actuator.pilot, 'frozen_guard', side_effect=lambda *_: copy.deepcopy(self.ownership))
        p(actuator.pilot.administrator, 'Administrator', new=Agent)
        p(actuator.pilot.administrator.helper, 'validate', side_effect=lambda *_: ['03'])
        p(actuator.runtime, 'snapshot', side_effect=lambda *_: {'state': self.state, 'services': copy.deepcopy(self.before), 'files': {'release.env': self.env}})
        p(actuator.runtime, 'reviewed_backup_module', side_effect=lambda *_: contextlib.nullcontext(None))
        p(actuator.runtime, 'prior_backup_guard', side_effect=lambda *_: self.backup)
        p(actuator.runtime, 'gateway_rendered_bindings', return_value=True)
        p(actuator.server, 'command', side_effect=self.command)
        # Volume helpers belong to the independently loaded initial controller.
        p(actuator.pilot.server, 'command', side_effect=self.command)

    def tearDown(self): self.stack.close(); self.tmp.cleanup()
    @property
    def directory(self): return self.private / 'additional-existing-gateway' / self.approval['run_id']
    def command(self, argv, *_):
        self.commands.append(tuple(argv))
        if argv[:3] == ['docker', 'volume', 'ls']: return '\n'.join(self.volume_names)
        if argv[:3] == ['docker', 'volume', 'inspect']: return json.dumps(self.volumes)
        if argv[:3] == ['docker', 'image', 'inspect']: return json.dumps([{'Id': self.gateway['Image']}])
        if argv[0] == 'sh': return self.rendered
        if argv[:3] == ['docker', 'network', 'connect']:
            row = next(row for row in self.services.values() if row['Id'] == argv[-1])
            aliases = [argv[i+1] for i in range(len(argv)-1) if argv[i] == '--alias']
            self.assertEqual(aliases, sorted({row['Name'].removeprefix('/'), row['Config']['Labels']['com.docker.compose.service']}))
            row['NetworkSettings']['Networks']['commerce-os_gateway-03'] = {'NetworkID': 'd' * 64, 'Aliases': aliases}
            return ''
        if argv[:2] == ['docker', 'start']:
            self.assertTrue((self.directory / 'start-intent.json').exists())
            self.assertEqual(argv[-1], self.gateway['Id'])
            self.services['waha-03']['State'].update(Status='running', Running=True, Pid=987,
                StartedAt=dt.datetime.now(dt.timezone.utc).isoformat())
            self.services['waha-03']['NetworkSettings']['Networks']['commerce-os_gateway-03']['NetworkID'] = 'd' * 64
            if self.start_failure: raise ReleaseError('BOUNDED_HOST_COMMAND_FAILED')
            return ''
        raise AssertionError(argv)
    def mutations(self):
        return [c for c in self.commands if c[:2] == ('compose', 'create') or c[:3] == ('docker', 'network', 'connect') or c[:2] == ('docker', 'start')]
    def execute(self, action): return actuator.execute(action, '/synthetic/ref-file.json')

    def test_prepare_creates_only_slot3_and_preserves_nine_and_release_bytes(self):
        before = copy.deepcopy(self.before); original_op = copy.deepcopy((self.op, self.slot))
        result = self.execute('prepare')
        self.assertEqual(result['status'], 'PREPARED_STOPPED'); self.assertEqual(result['servers_started'], 0)
        self.assertFalse(result['adopted']); self.assertFalse(self.services['waha-03']['State']['Running'])
        self.assertEqual(len(self.mutations()), 3)
        self.assertEqual(self.services['waha-01'], before['waha-01'])
        self.assertEqual((self.op, self.slot), original_op)
        self.assertEqual((self.private / 'release.env').read_bytes(), self.env)
        actuator.pilot.preserved(before, self.services, slot=3)

    def test_prepare_empty_requires_both_names_absent_and_creates_owned_pair(self):
        self.approval['volume_mode'] = 'CREATE_EMPTY'; self.volumes = []
        self.volume_names = sorted(['commerce-os_pg', *actuator.pilot.gateway_volumes(1)])
        self.refs[self.approval['volume_inventory_ref']['path']] = actuator.runtime.sealed_bytes({'names': self.volume_names, 'volumes': []})
        self.execute('prepare'); self.execute('start')
        self.assertEqual(len(self.volumes), 2)
        self.assertTrue(all(not any(Path(v['Mountpoint']).iterdir()) for v in self.volumes))
        self.assertEqual(self.services['waha-01'], self.before['waha-01'])

    def test_start_is_single_cid_and_later_readback_has_no_mutation(self):
        self.execute('prepare'); result = self.execute('start'); commands = self.mutations()
        self.assertEqual(result['status'], 'HTTP_VERIFIED_ADOPTION_REQUIRED')
        self.assertFalse(result['hold_released']); self.assertTrue(result['new_backup_required'])
        self.assertEqual([x for x in commands if x[:2] == ('docker', 'start')], [('docker', 'start', self.gateway['Id'])])
        self.execute('readback'); self.assertEqual(self.mutations(), commands)
        with self.assertRaisesRegex(ReleaseError, 'START_REQUIRES_READBACK'): self.execute('start')
        self.assertEqual(self.mutations(), commands)

    def test_late_http_requires_two_real_reads_and_never_a_second_start(self):
        self.execute('prepare'); self.http_failure = True
        with self.assertRaisesRegex(ReleaseError, 'BOUNDED_HOST_COMMAND_FAILED'): self.execute('start')
        self.assertFalse((self.directory / 'http-readback.json').exists())
        old = (self.directory / 'start-intent.json').read_bytes(); prior = self.mutations(); reads = self.http_calls
        self.http_failure = False; result = self.execute('complete-http')
        self.assertEqual(result['status'], 'HTTP_VERIFIED_ADOPTION_REQUIRED')
        self.assertEqual(self.http_calls - reads, 2); self.assertEqual(self.mutations(), prior)
        self.assertEqual((self.directory / 'start-intent.json').read_bytes(), old)
        completion = json.loads((self.directory / 'http-completion.json').read_bytes())
        self.assertEqual(completion['docker_mutations'], 0); self.assertEqual(len(completion['reads']), 2)
        with self.assertRaisesRegex(ReleaseError, 'HTTP_ALREADY_RECORDED'): self.execute('complete-http')

    def test_unknown_start_is_preserved_and_reconciled_without_dispatch_retry(self):
        self.execute('prepare'); self.start_failure = True
        with self.assertRaisesRegex(ReleaseError, 'BOUNDED_HOST_COMMAND_FAILED'): self.execute('start')
        prior = self.mutations()
        with self.assertRaisesRegex(ReleaseError, 'START_REQUIRES_READBACK'): self.execute('start')
        self.execute('complete-http'); self.assertEqual(self.mutations(), prior)

    def test_without_start_intent_http_cannot_infer_a_start_or_create_one(self):
        self.execute('prepare'); prior = self.mutations()
        with self.assertRaises(FileNotFoundError): self.execute('complete-http')
        self.assertEqual(self.http_calls, 0); self.assertEqual(self.mutations(), prior)

    def test_nonzero_sessions_stop_without_logout_or_container_removal(self):
        self.execute('prepare'); self.sessions = 1
        with self.assertRaisesRegex(ReleaseError, 'ZERO_SESSIONS_REQUIRED'): self.execute('start')
        self.assertTrue((self.directory / 'start-intent.json').exists())
        self.assertFalse((self.directory / 'http-readback.json').exists())
        self.assertFalse(any(any(x in c for x in ('stop', 'rm', 'logout')) for c in self.commands))

    def test_changed_baseline_backup_profile_or_compose_blocks_before_effects(self):
        original = copy.deepcopy(self.approval)
        for key in ('before_adoption_sha256', 'before_plan_sha256', 'compose_sha256'):
            self.approval[key] = 'f' * 64
            with self.subTest(key=key), self.assertRaises(ReleaseError): self.execute('prepare')
            self.assertEqual(self.mutations(), []); self.approval = copy.deepcopy(original)
        self.backup = dt.datetime.now(dt.timezone.utc)
        with self.assertRaisesRegex(ReleaseError, 'BACKUP_OPERATION_ORDER'): self.execute('prepare')
        self.assertEqual(self.mutations(), [])
        self.binding.side_effect = ReleaseError('ADDITIONAL_EXISTING_PRIVATE_BINDING_CHANGED')
        with self.assertRaisesRegex(ReleaseError, 'PRIVATE_BINDING_CHANGED'): self.execute('prepare')
        self.assertEqual(self.mutations(), [])

    def test_changed_prior_gateway_or_network_blocks_before_start_intent(self):
        self.execute('prepare'); original = copy.deepcopy(self.services)
        self.services['waha-01']['Id'] = 'f' * 64
        with self.assertRaises(ReleaseError): self.execute('start')
        self.assertFalse((self.directory / 'start-intent.json').exists())
        self.services = original
        with patch.object(actuator.pilot, 'network_guard', return_value={'changed': 'network'}):
            with self.assertRaisesRegex(ReleaseError, 'GATEWAY_CHANGED'): self.execute('start')
        self.assertFalse((self.directory / 'start-intent.json').exists())

    def test_existing_intent_or_volume_drift_does_not_replay_prepare(self):
        self.execute('prepare'); prior = self.mutations()
        with self.assertRaisesRegex(ReleaseError, 'PREPARATION_ALREADY_STARTED'): self.execute('prepare')
        self.volumes[0]['Mountpoint'] = '/foreign'
        with self.assertRaisesRegex(ReleaseError, 'VOLUMES_CHANGED'): self.execute('start')
        self.assertEqual(self.mutations(), prior)

    def test_parent_entries_are_durable_before_intent_and_any_docker_effect(self):
        trace = []; fsync = actuator.fsync_directory; write = actuator.write_new
        def sync(path): trace.append(('sync', Path(path))); return fsync(path)
        def save(path, raw): trace.append(('write', Path(path))); return write(path, raw)
        with patch.object(actuator, 'fsync_directory', side_effect=sync), patch.object(actuator, 'write_new', side_effect=save):
            self.execute('prepare')
        intent = trace.index(('write', self.directory / 'intent.json'))
        self.assertLess(trace.index(('sync', self.private)), intent)
        self.assertLess(trace.index(('sync', self.directory.parent)), intent)

    def test_frozen_hold_or_pending_channel_guard_blocks_before_effects(self):
        with patch.object(actuator.pilot, 'frozen_guard', side_effect=ReleaseError('INITIAL_PILOT_CHANNEL_BARRIERS_REQUIRED')):
            with self.assertRaisesRegex(ReleaseError, 'CHANNEL_BARRIERS_REQUIRED'): self.execute('prepare')
        self.assertEqual(self.mutations(), []); self.assertFalse(self.directory.exists())

    def test_external_start_before_our_intent_cannot_be_reconciled(self):
        self.execute('prepare'); self.http_failure = True
        with self.assertRaises(ReleaseError): self.execute('start')
        self.http_failure = False
        self.services['waha-03']['State']['StartedAt'] = self.op['created_at']
        with self.assertRaisesRegex(ReleaseError, 'GATEWAY_CHANGED'): self.execute('complete-http')
        self.assertFalse((self.directory / 'http-readback.json').exists())
        self.assertEqual(len([c for c in self.mutations() if c[:2] == ('docker', 'start')]), 1)



class ExistingSecretMaterialization(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='commerce-existing-secret-fixture-')
        self.base = Path(self.tmp.name); self.private = self.base / 'private'; self.private.mkdir(mode=0o700)
        self.folder = self.private / 'additional-existing-gateway-reviews' / 'synthetic'
        self.folder.mkdir(parents=True, mode=0o700)
        self.capture_raw = b'{"synthetic":"capture"}\n'; (self.folder / 'capture.json').write_bytes(self.capture_raw)
        self.target = self.private / 'pilot' / 'waha-03.env'; self.target.parent.mkdir(mode=0o700)
        self.match = approval()['credential_binding']
        self.profile = {k: v for k, v in self.match.items() if k != 'credentials_match'} | {'secrets_present': True, 'secrets_valid': True}
        self.op, self.slot = operation()
        self.facts = {'source_sha': 'a' * 40, 'current_release': str(self.base / 'release'), 'workspace': WORKSPACE,
            'operation': self.op, 'slot': self.slot, 'profile': self.profile, 'target': str(self.target)}
        self.ref = {'path': str(self.private / 'controller-approvals' / 'synthetic.json'), 'sha256': 'a' * 64, 'bytes': 1}
        self.capture_ref = {'path': '/synthetic/capture', 'sha256': 'b' * 64, 'bytes': 1}
        self.config_ref = {'path': '/synthetic/config', 'sha256': 'c' * 64, 'bytes': 1}
        self.value = {'schema_version': 1, 'kind': 'ADDITIONAL_EXISTING_CREDENTIALS', 'review_id': 'synthetic',
            'capture_ref': self.capture_ref, 'params': {'operation_id': OP, 'administrator_config_ref': self.config_ref}, 'native': self.facts}
        self.secret_bytes = b'WAHA_API_KEY=synthetic-existing-api-secret\nWHATSAPP_HOOK_HMAC_KEY=synthetic-existing-hook-secret\n'
        self.exported = dict(self.profile, credential_env=self.secret_bytes.decode())
        self.directory = self.private / 'additional-existing-credentials' / 'synthetic'
        self.reads = 0; self.change = None; self.locks = 0
        owner = self
        class Adapter:
            private = owner.private; server = SimpleNamespace()
            pilot = SimpleNamespace(administrator=SimpleNamespace(Administrator=lambda _: SimpleNamespace()))
            @contextlib.contextmanager
            def locked(self):
                owner.locks += 1
                try: yield
                finally: owner.locks -= 1
            def credentials_native(self, *_):
                owner.assertEqual(owner.locks, 1); owner.reads += 1
                facts = copy.deepcopy(owner.facts)
                if owner.change: owner.change(owner.reads, facts)
                return facts
        self.stack = contextlib.ExitStack()
        def p(obj, name, **kw): return self.stack.enter_context(patch.object(obj, name, **kw))
        p(actuator.os, 'geteuid', return_value=0); p(actuator.sys, 'platform', new='linux')
        p(additional, 'Native', new=Adapter)
        p(additional, 'directory', return_value=self.folder); p(additional, 'load_capture', return_value={'synthetic': 'capture'})
        p(additional.initial, 'ref_file', return_value=self.ref)
        p(additional.initial, 'read_ref', side_effect=lambda ref: actuator.runtime.sealed_bytes(self.value) if ref == self.ref else self.capture_raw if ref == self.capture_ref else b'{}')
        p(actuator.review, 'read_private', side_effect=lambda path: Path(path).read_bytes())
        p(actuator.review, 'private_directory', side_effect=lambda path, create=False: (Path(path).mkdir(mode=0o700, exist_ok=True) if create else None) or Path(path))
        p(actuator.native, 'protected_bytes', side_effect=lambda path: Path(path).read_bytes())
        self.export = p(additional, 'profile_binding', side_effect=self.export_profile)
        self.compare = p(additional, 'credential_binding', side_effect=lambda *_: copy.deepcopy(self.match))
    def tearDown(self): self.stack.close(); self.tmp.cleanup()
    def export_profile(self, *args, **kwargs):
        self.assertEqual(kwargs, {'export': True}); self.assertEqual(self.locks, 1)
        self.assertTrue((self.directory / 'intent.json').exists())
        self.assertEqual(args[2], self.op)
        return self.exported
    def execute(self): return actuator.materialize_credentials('/synthetic/ref.json')

    def test_materializes_exact_existing_bytes_root_mode_with_no_secrets_in_journals(self):
        original = copy.deepcopy((self.op, self.slot, self.profile)); result = self.execute()
        self.assertEqual(result['status'], 'EXISTING_CREDENTIAL_MATERIALIZED')
        self.assertEqual(self.target.read_bytes(), self.secret_bytes)
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o600)
        self.assertFalse(result['credentials_generated']); self.assertFalse(result['credentials_rotated'])
        self.assertEqual(result['containers_created'], 0); self.assertEqual(self.export.call_count, 1)
        self.assertEqual((self.op, self.slot, self.profile), original); self.assertEqual(self.exported['credential_env'], '')
        journals = b''.join(path.read_bytes() for path in self.directory.glob('*.json'))
        self.assertNotIn(b'synthetic-existing-api-secret', journals); self.assertNotIn(b'synthetic-existing-hook-secret', journals)
        self.assertNotIn(b'credential_env', journals); self.assertNotIn(b'WAHA_API_KEY=', journals)
        self.assertEqual(self.reads, 2); self.assertEqual(self.compare.call_count, 1)

    def test_profile_version_change_during_export_cannot_write_target(self):
        self.exported['profile_version'] += 1
        with self.assertRaisesRegex(ReleaseError, 'CREDENTIAL_OBSERVATION_CHANGED'): self.execute()
        self.assertFalse(self.target.exists()); self.assertTrue((self.directory / 'intent.json').exists())
        self.assertEqual(self.exported['credential_env'], '')

    def test_second_read_drift_preserves_intent_and_blocks_without_automatic_retry(self):
        self.change = lambda n, facts: facts['profile'].update(profile_version=5) if n == 2 else None
        with self.assertRaisesRegex(ReleaseError, 'CREDENTIAL_OBSERVATION_CHANGED'): self.execute()
        self.assertFalse(self.target.exists()); self.assertEqual(self.export.call_count, 1)
        self.change = None
        with self.assertRaisesRegex(ReleaseError, 'MATERIALIZATION_STARTED'): self.execute()
        self.assertEqual(self.export.call_count, 1)

    def test_existing_target_is_never_overwritten_even_if_created_after_observation(self):
        self.change = lambda n, facts: self.target.write_bytes(b'foreign-preserve') if n == 2 else None
        with self.assertRaisesRegex(ReleaseError, 'EXISTING_JOURNAL_REQUIRES_READBACK'): self.execute()
        self.assertEqual(self.target.read_bytes(), b'foreign-preserve')
        self.assertFalse((self.directory / 'materialized.json').exists())

    def test_malformed_export_is_not_a_way_to_add_an_environment_setting(self):
        self.exported['credential_env'] += 'WHATSAPP_START_SESSION=default\n'
        with self.assertRaisesRegex(ReleaseError, 'CREDENTIAL_FORMAT_REQUIRED'): self.execute()
        self.assertFalse(self.target.exists()); self.assertEqual(self.exported['credential_env'], '')

    def test_hashed_api_key_cannot_be_materialized_as_authentication_secret(self):
        self.exported['credential_env'] = 'WAHA_API_KEY=sha512:' + 'a' * 128 + '\nWHATSAPP_HOOK_HMAC_KEY=synthetic-hook\n'
        with self.assertRaisesRegex(ReleaseError, 'PLAINTEXT_CREDENTIAL_REQUIRED'): self.execute()
        self.assertFalse(self.target.exists()); self.assertEqual(self.exported['credential_env'], '')
        self.assertTrue((self.directory / 'intent.json').exists())
        self.assertFalse((self.directory / 'materialized.json').exists())

    def test_postwrite_profile_mismatch_never_claims_completed_or_rotates_again(self):
        self.compare.side_effect = ReleaseError('ADDITIONAL_EXISTING_PRIVATE_BINDING_CHANGED')
        with self.assertRaisesRegex(ReleaseError, 'PRIVATE_BINDING_CHANGED'): self.execute()
        self.assertEqual(self.target.read_bytes(), self.secret_bytes)
        self.assertFalse((self.directory / 'materialized.json').exists())
        with self.assertRaisesRegex(ReleaseError, 'MATERIALIZATION_STARTED'): self.execute()
        self.assertEqual(self.export.call_count, 1)



class ScheduledBackupCoverage(unittest.TestCase):
    """The installed cutover guards reject plausible but stale plan authority."""
    def exercise(self, drift=None):
        _, binding, *_ = gcp_fixtures()
        plan = {'schedule_enabled': False, 'preserved_runtime': {'new-ten-service-baseline': 'a' * 64}}
        raw = (json.dumps(plan, sort_keys=True) + '\n').encode()
        binding['plan_sha256'] = b02_contract.sha256(raw)
        if drift == 'already_scheduled':
            binding.update(mode='SCHEDULED', first_custody_ref={
                'path': '/synthetic/old-journal.json', 'bytes': 5, 'sha256': 'e' * 64})

        class Clock(dt.datetime):
            @classmethod
            def now(cls, tz=None): return GCP_NOW

        with tempfile.TemporaryDirectory() as temporary, contextlib.ExitStack() as stack:
            private = Path(temporary); daily = private / 'daily-b02'; daily.mkdir()
            runs = daily / 'runs'; runs.mkdir()
            directory = runs / b02_contract.gcp_run_identity(UID); directory.mkdir()
            pointer = daily / 'gcp-binding.json'; pointer.write_bytes(b02_contract.canonical(binding))
            (daily / 'plan.json').write_bytes(raw)
            state_raw = b02_contract.canonical({'b02_plan_sha256': b02_contract.sha256(raw), 'sentinel': 'preserved'})
            (private / 'api-web-adoption.json').write_bytes(state_raw)
            first = {'kind': 'DAILY_B02', 'run_id': directory.name,
                     'status': 'SUCCEEDED', 'external_copy_verified': True,
                     'source_sha': binding['source_sha'], 'plan_sha256': b02_contract.sha256(raw),
                     'cleanup': {'runtime_preserved': True, 'owned_plaintext_removed': True},
                     'trigger': {'synthetic_fixture_only': True},
                     'exports': {name: {'bytes': 10, 'sha256': 'a' * 64} for name in b02_contract.BASE_EXPORTS}}
            if drift == 'custody_for_old_nine_service_plan': first['plan_sha256'] = 'f' * 64
            if drift == 'custody_for_old_source': first['source_sha'] = 'b' * 40
            if drift == 'custody_without_ack': first['external_copy_verified'] = False
            path = directory / 'journal.json'; path.write_bytes(b02_contract.canonical(first))
            def ref(path):
                data = Path(path).read_bytes()
                return {'path': str(path), 'bytes': len(data), 'sha256': b02_contract.sha256(data)}
            candidate = binding | {'mode': 'SCHEDULED', 'activation_id': 'synthetic-ten-service-cutover',
                'first_custody_ref': ref(path),
                'plan_sha256': b02_contract.sha256((json.dumps(dict(plan, schedule_enabled=True), sort_keys=True) + '\n').encode())}
            if drift == 'expanded_financial_window': candidate['valid_until'] = '2026-11-05T00:00:00Z'
            if drift == 'different_hour': candidate['schedule_utc'] = '11:00'
            runner = SimpleNamespace(runs=runs, plan=plan, plan_sha256=b02_contract.sha256(raw), report=lambda _: first)
            for name, value in (('PRIVATE', private), ('DAILY', daily), ('GCP_BINDING_PATH', pointer), ('GCP_PERMITS', daily / 'absent')):
                stack.enter_context(patch.object(b02, name, value))
            stack.enter_context(patch.object(b02.dt, 'datetime', Clock))
            stack.enter_context(patch.object(b02, 'schedule_terminal_guard'))
            stack.enter_context(patch.object(b02, 'gcp_pair', return_value=state_raw))
            stack.enter_context(patch.object(b02, 'read_file', side_effect=lambda p: Path(p).read_bytes()))
            stack.enter_context(patch.object(b02, 'ref_read', side_effect=lambda r: Path(r['path']).read_bytes()))
            stack.enter_context(patch.object(b02, 'file_reference', side_effect=ref))
            stack.enter_context(patch.object(b02, 'verify_trigger_journal', return_value={
                'context': {'mode': 'MANUAL', 'binding_sha256': b02_contract.sha256(b02_contract.canonical(binding))}}))
            observed = stack.enter_context(patch.object(b02, 'google_observation', return_value={'synthetic_only': True}))
            saved = {p: p.read_bytes() for p in (pointer, path, daily / 'plan.json', private / 'api-web-adoption.json')}
            if drift:
                with self.assertRaises(RuntimeError): b02.cutover_facts(runner, candidate, TOKEN)
                observed.assert_not_called()
            else:
                facts = b02.cutover_facts(runner, candidate, TOKEN)
                self.assertEqual(facts['plan_after'], dict(plan, schedule_enabled=True))
                self.assertEqual(facts['state_after']['sentinel'], 'preserved')
                self.assertIs(observed.call_args.kwargs['paused'], True)
            self.assertEqual({p: p.read_bytes() for p in saved}, saved)

    def test_new_plan_custody_manual_epoch_is_required_before_scheduled(self):
        self.exercise()

    def test_old_scheduled_binding_or_old_custody_cannot_cover_slot3(self):
        for drift in ('already_scheduled', 'custody_for_old_nine_service_plan',
                      'custody_for_old_source', 'custody_without_ack',
                      'expanded_financial_window', 'different_hour'):
            with self.subTest(drift=drift): self.exercise(drift)


if __name__ == '__main__':
    unittest.main()
