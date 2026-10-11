"""Synthetic regression fixtures, never native production approval authority."""
import contextlib
import copy
import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'scripts'))
import initial_pilot_adoption_approvals as a
from ci_release import ReleaseError
import test_b02_portal_backup as b02_tests
from test_b02_portal_backup import r as b02, put, json_raw

OP = '11111111-1111-4111-8111-111111111111'
CID = '1'*64


def bound_journals():
    now = dt.datetime.now(dt.timezone.utc)
    stamp = lambda n: (now-dt.timedelta(seconds=n)).isoformat()
    ref = {'path': '/synthetic/approved.json', 'bytes': 1, 'sha256': 'a'*64}
    approval = {'operation_id': OP, 'runtime_before_ref': ref}
    gateway = {'Id': CID, 'Image': 'sha256:'+'2'*64, 'State': {'Running': True, 'StartedAt': stamp(40)}}
    rb = {'slot': 1, 'running': True, 'image_digest': gateway['Image'], 'network_present': True,
          'volumes_preserved': True, 'session_count': 0, 'connected_sessions': 0}
    intent = {'approval_ref': ref, 'ownership': {}, 'previous_release_env_ref': ref, 'runtime_before_ref': ref}
    prepared = {'approval_ref': ref, 'services': {'waha-01': copy.deepcopy(gateway)}, 'image': gateway['Image'], 'volumes': {}, 'networks': {}}
    started = {'approval_ref': ref, 'container_id': CID}
    http = {'observed_at': stamp(30), 'container_id': CID, 'readback': rb}
    op = {'id': OP, 'workspace_id': 'synthetic-workspace', 'environment': 'REAL', 'action': 'PROVISION', 'state': 'SUCCEEDED',
          'lease_until': None, 'created_at': stamp(50), 'updated_at': stamp(50),
          'input': {'existing_account': True, 'slot_id': 'synthetic-slot', 'account_id': 'synthetic-account'}}
    slot = {'id': 'synthetic-slot', 'account_id': 'synthetic-account', 'workspace_id': op['workspace_id'],
            'environment': 'REAL', 'slot': 1, 'operation_id': OP, 'readback': dict(rb, observed_at=stamp(20))}
    audit = {'id': 'synthetic-event', 'workspace_id': op['workspace_id'], 'environment': 'REAL', 'aggregate_id': OP,
             'event_type': 'capacity.admin_readback', 'payload': {'outcome': 'VERIFIED'},
             'actor': {'type': 'service', 'id': 'synthetic-owner'}, 'occurred_at': stamp(21)}
    return [ref, approval, intent, prepared, started, http, {'waha-01': gateway}, op, slot, audit, now]


class JournalBinding(unittest.TestCase):
    def test_authentic_order_and_same_preserved_binding(self):
        a.journal_binding(*bound_journals())

    def test_missing_start_or_http_journals_never_infer_completion(self):
        for index in (2, 3, 4, 5):
            args = bound_journals(); args[index] = {}
            with self.subTest(index=index), self.assertRaisesRegex(ReleaseError, 'JOURNALS_REQUIRED'):
                a.journal_binding(*args)

    def test_changed_approval_runtime_cid_image_and_session_count_are_rejected(self):
        changes = [lambda x: x[2].update(runtime_before_ref={}), lambda x: x[4].update(approval_ref={}),
                   lambda x: x[4].update(container_id='3'*64), lambda x: x[5].update(container_id='3'*64),
                   lambda x: x[5]['readback'].update(image_digest='sha256:'+'3'*64),
                   lambda x: x[5]['readback'].update(session_count=1),
                   lambda x: x[8]['readback'].update(connected_sessions=1),
                   lambda x: x[5]['readback'].update(session_count=False)]
        for change in changes:
            args = bound_journals(); change(args)
            with self.subTest(change=change), self.assertRaises(ReleaseError): a.journal_binding(*args)

    def test_new_or_wrong_account_slot_workspace_state_or_lease_rejected(self):
        changes = [lambda x: x[7]['input'].update(existing_account=False), lambda x: x[7].update(state='UNKNOWN'),
                   lambda x: x[7].update(action='EXPAND'), lambda x: x[7].update(environment='SIMULATION'),
                   lambda x: x[7].update(lease_until=x[-1].isoformat()), lambda x: x[8].update(account_id='other'),
                   lambda x: x[8].update(workspace_id='other'), lambda x: x[8].update(slot=2),
                   lambda x: x[8].update(operation_id='other')]
        for change in changes:
            args = bound_journals(); change(args)
            with self.subTest(change=change), self.assertRaisesRegex(ReleaseError, 'CANONICAL_OPERATION_REQUIRED'):
                a.journal_binding(*args)

    def test_reordered_or_future_readbacks_fail(self):
        for change in (lambda x: x[5].update(observed_at=x[7]['created_at']),
                       lambda x: x[8]['readback'].update(observed_at=x[7]['created_at']),
                       lambda x: x[9].update(occurred_at=(x[-1]+dt.timedelta(seconds=10)).isoformat())):
            args = bound_journals(); change(args)
            with self.assertRaisesRegex(ReleaseError, 'ORDER_REQUIRED'): a.journal_binding(*args)

    def test_missing_or_foreign_audit_cannot_stand_in_for_completion(self):
        for change in (lambda x: x.__setitem__(9, None), lambda x: x[9].update(aggregate_id='other'),
                       lambda x: x[9].update(workspace_id='other'), lambda x: x[9]['payload'].update(outcome='UNKNOWN')):
            args = bound_journals(); change(args)
            with self.assertRaisesRegex(ReleaseError, 'ADMIN_AUDIT_REQUIRED'): a.journal_binding(*args)


class Synthetic:
    def __init__(self, base):
        self.base = base; self.private = base/'private'; self.private.mkdir(mode=0o700)
        ref = {'path': str(base/'synthetic.json'), 'bytes': 2, 'sha256': 'a'*64}
        tools = {name: dict(ref, path=str(base/'release/scripts'/name)) for name in a.review.TOOLS}
        self.facts = {'source_sha': 'a'*40, 'current_release': str(base/'release'), 'before_adoption_sha256': 'b'*64,
                      'before_plan_sha256': 'c'*64, 'observed_policy': {}, 'runtime_before_ref': ref,
                      'previous_release_env_ref': ref, 'current_release_env_ref': ref, 'backup_before_provision_ref': ref,
                      'gateway_provisioning': {'waha-01': {'operation_id': OP}}, 'ownership': {'held': True, 'hold_at': 'current'},
                      'tools_manifest': a.tools_manifest('a'*40, 'b'*64, 'c'*64, tools)}
        self.reads = 0; self.locks = 0; self.change = None
    @contextlib.contextmanager
    def locked(self):
        self.locks += 1
        try: yield
        finally: self.locks -= 1
    def observe_native(self, *_):
        assert self.locks == 1
        self.reads += 1
        if self.change: self.change(self.reads)
        return copy.deepcopy(self.facts)
    def compare_native(self, before, after):
        a.require(before == after, 'PILOT_ADOPTION_NATIVE_CHANGED')


class AdoptionApproval(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='commerce-adoption-review-', dir=Path.home())
        self.base = Path(self.temp.name); self.adapter = Synthetic(self.base); self.stack = contextlib.ExitStack()
        reader = a.review.read_private; directory = a.review.private_directory
        self.stack.enter_context(patch.object(a.review, 'read_private', side_effect=lambda p, **kw: reader(p, **dict(kw, uid=os.getuid()))))
        self.stack.enter_context(patch.object(a.review, 'private_directory', side_effect=lambda p, **kw: directory(p, **dict(kw, uid=os.getuid()))))
        self.ref_file = self.base/'pilot-ref.json'; self.ref_file.write_text('{}'); self.ref_file.chmod(0o600)
        self.folder = self.adapter.private/'initial-pilot-adoption-reviews/fixture'
    def tearDown(self): self.stack.close(); self.temp.cleanup()
    def observe(self): return a.observe(self.adapter, 'fixture', '123-2', self.ref_file)
    def seal(self, value): return a.seal(self.adapter, 'fixture', value['observation_sha256'])
    def rewrite(self, change):
        path = self.folder/'observation.json'; value = json.loads(path.read_bytes()); change(value)
        path.write_bytes(a.review.encoded(value)); return a.runtime.sha256(path.read_bytes())

    def test_exact_fourteen_field_approval_plus_fresh_six_field_b02_manifest(self):
        observed = self.observe(); self.assertEqual(self.adapter.reads, 2)
        self.assertFalse((self.adapter.private/'controller-approvals').exists())
        sealed = self.seal(observed); self.assertEqual(self.adapter.reads, 4)
        manifest = json.loads(a.initial.read_ref(a.initial.ref_file(sealed['approval_ref_file'])))
        self.assertEqual(set(manifest), a.FIELDS); self.assertFalse(sealed['adoption_executed'])
        tools = json.loads(a.initial.read_ref(manifest['backup_tools_manifest_ref']))
        self.assertEqual(set(tools), {'schema_version', 'source_sha', 'before_plan_sha256', 'before_adoption_sha256', 'runtime_stage', 'tools'})
        self.assertEqual(tools['runtime_stage'], 'OPERATING')
        self.assertEqual(tools['before_adoption_sha256'], manifest['before_adoption_sha256'])
        self.assertEqual(tools['before_plan_sha256'], manifest['before_plan_sha256'])
        self.assertFalse((self.adapter.private/'api-web-adoption.json').exists())
        self.assertFalse((self.adapter.private/'daily-b02').exists())
        self.assertEqual(self.seal(observed)['status'], 'SEALED_REPLAY_HISTORICAL')
        self.assertEqual(self.adapter.reads, 4)

    def test_wrong_digest_and_caducity_block_before_seal(self):
        self.observe()
        with self.assertRaisesRegex(ReleaseError, 'HASH_CHANGED'): a.seal(self.adapter, 'fixture', '0'*64)
        for timestamp in (time.time()-1900, time.time()+30):
            digest = self.rewrite(lambda v: v.update(created_at_epoch=int(timestamp)))
            with self.assertRaisesRegex(ReleaseError, 'EXPIRED'): a.seal(self.adapter, 'fixture', digest)
        self.assertEqual(self.adapter.reads, 2)

    def test_double_observation_and_second_seal_read_reject_drift(self):
        def change(n):
            if n == 2: self.adapter.facts['before_plan_sha256'] = 'd'*64
        self.adapter.change = change
        with self.assertRaisesRegex(ReleaseError, 'NATIVE_CHANGED'): self.observe()
        self.assertFalse((self.folder/'observation.json').exists())
        self.adapter.change = None; self.adapter.reads = 0
        value = self.observe()
        def change(n):
            if n == 4: self.adapter.facts['before_plan_sha256'] = 'e'*64
        self.adapter.change = change
        with self.assertRaisesRegex(ReleaseError, 'NATIVE_CHANGED'): self.seal(value)
        self.assertFalse((self.adapter.private/'controller-approvals/initial-pilot-adoption-fixture.json').exists())

    def test_operation_hold_policy_or_tool_change_cannot_be_sealed(self):
        value = self.observe(); original = copy.deepcopy(self.adapter.facts)
        for key in original:
            self.adapter.facts = copy.deepcopy(original); self.adapter.facts[key] = 'changed'
            with self.subTest(key=key), self.assertRaisesRegex(ReleaseError, 'NATIVE_CHANGED'): self.seal(value)

    def test_supplied_approval_payload_cannot_override_observation(self):
        self.observe(); digest = self.rewrite(lambda v: v['approval'].update(run_id='9-9'))
        with self.assertRaisesRegex(ReleaseError, 'APPROVAL_CHANGED'): a.seal(self.adapter, 'fixture', digest)

    def test_new_hold_observation_cannot_be_swapped(self):
        value = self.observe(); (self.folder/'ownership.json').write_text('{}')
        with self.assertRaisesRegex(ReleaseError, 'REFERENCE_CHANGED'): self.seal(value)

    def test_partial_seal_reuses_only_identical_bytes(self):
        value = self.observe(); immutable = a.review.immutable
        def fail(path, raw):
            if Path(path).name == 'seal.json': raise OSError('synthetic interruption')
            return immutable(path, raw)
        with patch.object(a.review, 'immutable', side_effect=fail), self.assertRaises(OSError): self.seal(value)
        self.assertEqual(self.seal(value)['status'], 'SEALED')

    def test_symlink_and_duplicate_observation_rejected(self):
        self.observe()
        with self.assertRaisesRegex(ReleaseError, 'OBSERVATION_EXISTS'): self.observe()
        link = self.base/'linked-ref'; link.symlink_to(self.ref_file)
        with self.assertRaises(Exception): a.observe(self.adapter, 'another', '123-2', link)


class B02Compatibility(unittest.TestCase):
    def test_actual_native_b02_helper_accepts_current_manifest(self):
        fixture = b02_tests.ReviewedTools()
        with fixture.fixture() as f:
            f.adoption['runtime_stage'] = 'OPERATING'
            for number in ('4', '5', '6', '7'): f.rows[number*64] = b02_tests.row(number*64)
            f.adoption['preserved_runtime'] = {cid: b02_tests.c.projection_digest(row, 2) for cid, row in f.rows.items()}
            manifest = a.tools_manifest('a'*40, f.old_adoption['sha256'], f.old_plan['sha256'], f.approved['tools'])
            f.approval = put(f.private/'controller-approvals/operating.json', json_raw(manifest))
            result = fixture.invoke(f)
            self.assertEqual(result['adoption']['runtime_stage'], 'OPERATING')
            self.assertEqual(result['plan']['runtime_stage'], 'OPERATING')
            self.assertFalse(result['pair_written'])

    def test_actual_native_b02_helper_rejects_previous_baseline_manifest(self):
        fixture = b02_tests.ReviewedTools()
        with fixture.fixture() as f:
            f.adoption['runtime_stage'] = 'OPERATING'
            manifest = a.tools_manifest('a'*40, '9'*64, '8'*64, f.approved['tools'])
            f.approval = put(f.private/'controller-approvals/stale.json', json_raw(manifest))
            with patch.object(b02, 'write_private') as write, self.assertRaisesRegex(RuntimeError, 'APPROVAL_MANIFEST_INVALID'):
                fixture.invoke(f)
            write.assert_not_called()


class NativeComparison(unittest.TestCase):
    def test_health_log_changes_are_allowed_but_instance_changes_are_not(self):
        from test_copy_runtime_deployment import fixture
        state, rows, _ = fixture(0)
        services = dict(zip(state['service_inventory'], rows))
        adapter = a.Native.__new__(a.Native)
        adapter.server = types.SimpleNamespace(compare_owner_auth=lambda *_: None)
        first = {'services': services, 'owner': {}, 'stable': 'same'}; after = copy.deepcopy(first)
        after['services']['api']['State']['Health'] = {'Log': [{'Output': 'synthetic health change'}]}
        adapter.compare_native(first, after)
        after['services']['api']['State']['Pid'] += 1
        with self.assertRaisesRegex(ReleaseError, 'INSTANCE_CHANGED'): adapter.compare_native(first, after)

    def test_cli_has_no_fixture_or_business_write_entrypoint(self):
        source = (ROOT/'scripts/initial-pilot-adoption-approvals.py').read_text()
        self.assertIn('approvals.Native()', source)
        self.assertNotIn('fixture', source.lower())
        for verb in ('prepare', 'start', 'apply', 'reconcile'):
            self.assertNotIn("add_parser('"+verb+"')", source)


class NativeObservation(unittest.TestCase):
    """Exercise Native orchestration with explicit synthetic read boundaries."""
    def setUp(self):
        AdoptionApproval.setUp(self)
        from test_copy_runtime_deployment import fixture
        self.folder = a.directory(self.adapter, 'fixture', True)
        self.current = self.base/'releases/runtime-synthetic'; (self.current/'scripts').mkdir(parents=True)
        (self.current/'infra/compose').mkdir(parents=True)
        def write(path, value):
            path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(value); path.chmod(0o600)
            return a.native.reference(path, value)
        state, rows, plan = fixture(0)
        state = json.loads(json.dumps(state).replace('/opt/commerce-os', str(self.base)))
        state['current_release'] = str(self.current)
        old_services = dict(zip(state['service_inventory'], rows))
        args = bound_journals()
        _, self.approval, intent, prepared, started, http, gateway, self.operation, self.slot, self.audit, self.now = args
        observed_gateway = fixture(1)[1][-1]
        observed_gateway.update(gateway['waha-01'])
        gateway['waha-01'] = observed_gateway
        self.services = dict(old_services, **gateway)
        # The pure binding helper is tested above; these boundaries represent the
        # separately tested Docker contracts, never a fixture accepted by CLI.
        prepared['services'] = copy.deepcopy(self.services)
        prepared['image'] = gateway['waha-01']['Image']
        self.http = http; self.prepared = prepared; self.http_reads = 0
        old_env = b'COMMERCE_DEPLOY_SCOPE=copy-runtime\n'
        for name in a.runtime.FILES:
            raw = b'WORKSPACE_ID=synthetic-workspace\n' if name == 'api.env' else old_env if name == 'release.env' else b'PRIVATE=SYNTHETIC\n'
            state['canonical_files'][name] = write(self.adapter.private/name, raw)
        write(self.adapter.private/'daily-b02/plan.json', plan)
        state['b02_plan_ref'] = a.native.reference(self.adapter.private/'daily-b02/plan.json', plan)
        raw_state = a.review.encoded(state); write(self.adapter.private/'api-web-adoption.json', raw_state)
        for field in ('smtp_transition_ref', 'caddy_config_ref'):
            state[field] = write(Path(state[field]['path']), b'SYNTHETIC')
        raw_state = a.review.encoded(state); write(self.adapter.private/'api-web-adoption.json', raw_state)
        new_env = old_env+b'COMMERCE_PILOT_RELEASE_ENV=/synthetic/pilot.env\n'
        write(self.adapter.private/'release.env', new_env)
        approval_path = self.adapter.private/'controller-approvals/initial-pilot-source.json'
        self.approval.update(source_sha='a'*40, run_id='123-1', current_release=str(self.current),
            before_adoption_sha256=a.runtime.sha256(raw_state), before_plan_sha256=a.runtime.sha256(plan),
            new_release_env_ref=write(self.base/'new-release.env', new_env),
            administrator_config_ref=write(self.base/'admin.json', b'{}'), credential_refs={},
            backup_before_provision_ref=write(self.base/'backup.json', b'{}'),
            backup_tools_manifest_ref=write(self.base/'tools.json', b'{}'),
            runtime_before_ref=write(self.base/'runtime-before.json', a.review.encoded({'services': old_services, 'captured_at': (self.now-dt.timedelta(seconds=60)).isoformat()})))
        self.approval_ref = write(approval_path, a.review.encoded(self.approval))
        intent.update(approval_ref=self.approval_ref, runtime_before_ref=self.approval['runtime_before_ref'],
                      previous_release_env_ref=write(self.base/'previous.env', old_env))
        prepared['approval_ref'] = started['approval_ref'] = self.approval_ref
        self.journal_dir = self.adapter.private/'initial-pilot/123-1'
        for name, value in (('intent', intent), ('prepared', prepared), ('start-intent', started), ('http-readback', http)):
            write(self.journal_dir/(name+'.json'), a.review.encoded(value))
        write(self.current/'infra/compose/pilot.yaml', b'SYNTHETIC PINNED OVERLAY\n')
        for name in a.review.TOOLS: write(self.current/'scripts'/name, b'SYNTHETIC TOOL '+name.encode())
        self.native = a.Native.__new__(a.Native); self.native.base = self.base; self.native.private = self.adapter.private
        self.native.package = lambda: (self.current, 'a'*40, 'b'*64)
        self.queries = []
        def database(root, query):
            self.queries.append(query); return json.dumps({'operation': self.operation, 'slot': self.slot, 'audit': self.audit})
        self.native.server = types.SimpleNamespace(database=database, command=lambda *_: (_ for _ in ()).throw(AssertionError('unexpected command')),
                                                  owner_auth_snapshot=lambda *_: {}, compare_owner_auth=lambda *_: None)
        self.hold = {'held': True, 'hold_at': (self.now-dt.timedelta(seconds=5)).isoformat()}
        def readback(slot): self.http_reads += 1; return copy.deepcopy(self.http['readback'])
        self.native.pilot = types.SimpleNamespace(load_approval=lambda *_: (self.approval_ref, self.approval),
            frozen_guard=lambda *_: self.hold, read_services=lambda *_: copy.deepcopy(self.services),
            gateway_guard=lambda *_: None, gateway_identity=lambda row: row['Id'], network_guard=lambda *_: {}, volume_snapshot=lambda *_: {},
            administrator=types.SimpleNamespace(Administrator=lambda config: types.SimpleNamespace(credentials=lambda *args, **kw: {}, readback=readback)))
        self.stack.enter_context(patch.object(a.runtime, 'PRIVATE', self.adapter.private))
        self.stack.enter_context(patch.object(a.native, 'read_reference', side_effect=a.initial.read_ref))
        self.stack.enter_context(patch.object(a.native, 'protected_bytes', side_effect=a.review.read_private))
        self.stack.enter_context(patch.object(a.native, 'read_portal_references'))
        self.stack.enter_context(patch.object(a.native, 'active_proxy_digest', return_value=state['active_proxy_sha256']))
        for name in ('terminal_journals', 'verify_edge', 'gateway_rendered_bindings', 'verify_gateway_provisioning'):
            self.stack.enter_context(patch.object(a.runtime, name))
        self.stack.enter_context(patch.object(a.runtime, 'policy', return_value={'policy_version': 98, 'policy_body_sha256': '9'*64}))
        self.stack.enter_context(patch.object(a.runtime, 'current_policy', return_value={'version': 98, 'body': {}}))
        self.stack.enter_context(patch.object(a.runtime, 'canonical_revision_observation', return_value=({'policy_version': 98, 'policy_body_sha256': '9'*64}, [])))
        self.stack.enter_context(patch.object(a.runtime, 'compare_live_snapshot'))
        self.stack.enter_context(patch.object(a.runtime, 'state_for_stage', return_value=state))
        self.stack.enter_context(patch.object(a.runtime, 'validate_inventory', side_effect=lambda state, rows: old_services))
        self.stack.enter_context(patch.object(a.runtime, 'gateway_continuity', return_value={'waha-01'}))
        self.stack.enter_context(patch.object(a.runtime, 'commercial_snapshot', return_value='c'*64))
        self.stack.enter_context(patch.object(a.runtime, 'reviewed_backup_module', side_effect=lambda *_: contextlib.nullcontext(None)))
        self.stack.enter_context(patch.object(a.runtime, 'prior_backup_guard', return_value=self.now-dt.timedelta(seconds=70)))
        self.params = {'run_id': '123-2', 'pilot_approval_ref_file_ref': a.initial.file_ref(self.ref_file)}
    def tearDown(self): AdoptionApproval.tearDown(self)
    def invoke(self): return self.native.observe_native(self.folder, self.params)

    def test_native_complete_observation_uses_readonly_query_and_local_http(self):
        value = self.invoke()
        self.assertEqual(value['tools_manifest']['before_adoption_sha256'], self.approval['before_adoption_sha256'])
        self.assertEqual(set(value['gateway_provisioning']), {'waha-01'})
        self.assertEqual(self.http_reads, 1); self.assertEqual(len(self.queries), 1)
        self.assertTrue(self.queries[0].startswith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT'))
        self.assertTrue(self.queries[0].endswith('ROLLBACK;'))
        self.assertFalse((self.adapter.private/'controller-approvals/initial-pilot-adoption-fixture.json').exists())

    def test_native_rejects_old_hold_unknown_operation_and_missing_start(self):
        self.hold['hold_at'] = self.operation['created_at']
        with self.assertRaisesRegex(ReleaseError, 'NEW_HOLD_REQUIRED'): self.invoke()
        self.hold['hold_at'] = self.now.isoformat(); self.operation['state'] = 'UNKNOWN'
        with self.assertRaisesRegex(ReleaseError, 'CANONICAL_OPERATION_REQUIRED'): self.invoke()
        self.operation['state'] = 'SUCCEEDED'; (self.journal_dir/'start-intent.json').unlink()
        with self.assertRaises(FileNotFoundError): self.invoke()

    def test_native_http_must_match_authentic_zero_receipt(self):
        self.native.pilot.administrator.Administrator = lambda config: types.SimpleNamespace(credentials=lambda *args, **kw: {}, readback=lambda _: dict(self.http['readback'], session_count=1))
        with self.assertRaisesRegex(ReleaseError, 'HTTP_READBACK_CHANGED'): self.invoke()


if __name__ == '__main__': unittest.main()
