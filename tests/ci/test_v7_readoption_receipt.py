"""V7.1: the Root re-adoption extends the installation receipt (26-oct-2026).

The laboratory rehearsal of the V7.1 window found that after
`v7_infra_adoption.py apply` (PITR PostgreSQL, proxy, V7 settings) the canonical
installer refused the next publication with COPY_RUNTIME_CURRENT_PAIR_NOT_CONFIRMED:
the installation receipt keeps the inventory it validated. The same comparison
guarded B02 and the durable boot. These tests fix the narrow rule that accepts that
difference only through the APPLIED re-adoption journal of exactly this pair.
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
sys.path[:0] = [str(ROOT / 'scripts'), str(ROOT / 'tests/ci')]
import b02_backup_contract as contract  # noqa: E402
import copy_runtime_deployment as runtime  # noqa: E402
import v7_infra_adoption as adoption  # noqa: E402

RECEIPT_REF = {'path': '/opt/commerce-os/private/deployments/cv-11111111-1111-4111-8111-111111111111-1/adoption-receipt.json',
               'bytes': 10, 'sha256': 'a' * 64}
STATE = {'schema_version': 3, 'runtime_stage': 'OPERATING', 'last_release_receipt_ref': RECEIPT_REF,
         'service_inventory': {'api': 'a1', 'postgres': 'p2', 'web': 'w1'},
         'preserved_runtime': {'web': {'definition': 'new'}}}
RECEIPT = {'status': 'VALIDATED_FOR_PAIR_CAS', 'runtime_stage': 'OPERATING', 'run_id': 'cv-x', 'source_sha': 'b' * 40,
           'service_inventory': {'api': 'a1', 'postgres': 'p1', 'web': 'w1'},
           'preserved_runtime': {'web': {'definition': 'old'}}}
STATE_RAW = json.dumps(STATE, sort_keys=True).encode()
PLAN_RAW = b'{"plan":1}\n'


def journal(**change):
    value = {'schema_version': 1, 'status': 'APPLIED', 'proposal_sha256': 'c' * 64,
             'state_sha256': contract.sha256(STATE_RAW), 'plan_sha256': contract.sha256(PLAN_RAW), 'policy_sha256': None,
             'base_receipt_ref': copy.deepcopy(RECEIPT_REF), 'applied_at': '2026-10-26T12:00:00+00:00'}
    value.update(change)
    return value


class ReadoptionRuleTests(unittest.TestCase):
    def confirms(self, receipt=RECEIPT, state=STATE, value=None):
        return contract.readoption_confirms(receipt, state, contract.sha256(STATE_RAW), contract.sha256(PLAN_RAW),
                                            journal() if value is None else value)

    def test_applied_journal_of_this_exact_pair_extends_the_receipt(self):
        self.assertTrue(self.confirms())

    def test_any_other_journal_or_pair_is_refused(self):
        self.assertFalse(self.confirms(value=journal(status='PREWRITE')))
        self.assertFalse(self.confirms(value=journal(state_sha256='0' * 64)))
        self.assertFalse(self.confirms(value=journal(plan_sha256='0' * 64)))
        self.assertFalse(self.confirms(value=journal(schema_version=2)))
        other = dict(RECEIPT_REF, sha256='d' * 64)
        self.assertFalse(self.confirms(value=journal(base_receipt_ref=other)))
        legacy = journal(); legacy.pop('base_receipt_ref')  # journals written before V7.1 do not name a receipt
        self.assertFalse(self.confirms(value=legacy))
        self.assertFalse(contract.readoption_confirms(RECEIPT, STATE, contract.sha256(STATE_RAW), contract.sha256(PLAN_RAW), None))

    def test_the_service_set_itself_never_changes_through_readoption(self):
        receipt = copy.deepcopy(RECEIPT); receipt['service_inventory']['waha-02'] = 'g2'
        self.assertFalse(self.confirms(receipt=receipt))


class InstallerPairTests(unittest.TestCase):
    def test_exact_receipt_needs_no_journal(self):
        receipt = dict(RECEIPT, service_inventory=STATE['service_inventory'], preserved_runtime=STATE['preserved_runtime'])
        self.assertTrue(runtime.pair_confirmed(receipt, STATE, STATE_RAW, PLAN_RAW, lambda p: self.fail('no read'),
                                               journal_path='/nonexistent/journal.json'))

    def test_difference_without_journal_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(runtime.pair_confirmed(RECEIPT, STATE, STATE_RAW, PLAN_RAW, lambda p: Path(p).read_bytes(),
                                                    journal_path=Path(tmp) / 'journal.json'))

    def test_difference_bound_by_the_applied_readoption_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'journal.json'
            path.write_text(json.dumps(journal()))
            self.assertTrue(runtime.pair_confirmed(RECEIPT, STATE, STATE_RAW, PLAN_RAW, lambda p: Path(p).read_bytes(),
                                                   journal_path=path))
            path.write_text(json.dumps(journal(state_sha256='0' * 64)))
            self.assertFalse(runtime.pair_confirmed(RECEIPT, STATE, STATE_RAW, PLAN_RAW, lambda p: Path(p).read_bytes(),
                                                    journal_path=path))


def load_b02():
    spec = importlib.util.spec_from_file_location('b02_root_readoption', ROOT / 'scripts/b02-backup-root.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


class B02PairTests(unittest.TestCase):
    def run_pair(self, journal_value):
        b02 = load_b02()
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp); private = base / 'private'; release = base / 'releases/r1'
            private.mkdir(); release.mkdir(parents=True); (base / 'current').symlink_to(release)
            state = dict(STATE, scope='copy-runtime', b02_plan_sha256=contract.sha256(PLAN_RAW), current_release=str(release))
            state_raw = json.dumps(state, sort_keys=True).encode()
            files = {str(private / 'api-web-adoption.json'): state_raw,
                     str(release / 'RELEASE.json'): json.dumps({'source_sha': 'b' * 40}).encode(),
                     str(Path(RECEIPT_REF['path']).parent / 'copy-runtime-transition.json'): b'{"status":"APPLIED"}',
                     str(Path(RECEIPT_REF['path']).parent / 'report.json'): json.dumps({'status': 'SUCCEEDED', 'source_sha': 'b' * 40}).encode()}
            runner = mock.Mock(plan_sha256=contract.sha256(PLAN_RAW), plan={'preserved_runtime': STATE['preserved_runtime'], 'bucket': 'b'})
            value = None if journal_value is None else dict(journal_value, state_sha256=contract.sha256(state_raw))
            with mock.patch.object(b02, 'PRIVATE', private), \
                 mock.patch.object(b02, 'read_file', side_effect=lambda path, **_: files[str(path)]), \
                 mock.patch.object(b02, 'ref_read', return_value=json.dumps(RECEIPT).encode()), \
                 mock.patch.object(b02, 'readoption_journal', return_value=value):
                return b02.gcp_pair(runner, {'source_sha': 'b' * 40, 'bucket': 'b'}), runner

    def test_b02_accepts_the_readopted_runtime_and_still_runs_its_runtime_guard(self):
        raw, runner = self.run_pair(journal())
        self.assertTrue(raw); runner.runtime_guard.assert_called_once()

    def test_b02_refuses_the_difference_without_the_journal(self):
        with self.assertRaisesRegex(RuntimeError, 'B02_GCP_RUNTIME_NOT_ADOPTED'):
            self.run_pair(None)
        with self.assertRaisesRegex(RuntimeError, 'B02_GCP_RUNTIME_NOT_ADOPTED'):
            self.run_pair(journal(status='PREWRITE'))


class ApplyJournalTests(unittest.TestCase):
    def test_apply_journal_names_the_receipt_it_extends(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            files = {'state': base / 'api-web-adoption.json', 'plan': base / 'plan.json'}
            files['state'].write_bytes(STATE_RAW); files['plan'].write_bytes(PLAN_RAW)
            documents = {'state': b'{"new":"state"}\n', 'plan': b'{"new":"plan"}\n', 'policy': None}
            proposal = {'after': {'state_sha256': contract.sha256(documents['state']),
                                  'plan_sha256': contract.sha256(documents['plan']), 'policy_sha256': None},
                        'summary': {}}
            old = {'state': STATE_RAW, 'plan': PLAN_RAW, 'policy': None}
            written = {}

            def write(path, raw):
                Path(path).parent.mkdir(parents=True, exist_ok=True); Path(path).write_bytes(raw); written[str(path)] = raw
            host = mock.Mock(private=lambda path, optional=False: Path(path).read_bytes())
            digest = contract.sha256(json.dumps(proposal, sort_keys=True).encode())
            with mock.patch.object(adoption.native, 'acquire_locks', return_value=[]), \
                 mock.patch.object(adoption.native, 'protected_bytes', side_effect=lambda p: Path(p).read_bytes()), \
                 mock.patch.object(adoption, 'observe', return_value=(proposal, documents, old)), \
                 mock.patch.object(adoption, 'digest', return_value=digest), \
                 mock.patch.object(adoption, 'base_dir', return_value=base / 'v7-infra-adoption'), \
                 mock.patch.object(adoption, 'write_private', side_effect=write), \
                 mock.patch.object(adoption, 'PRIVATE', base), \
                 mock.patch.object(adoption, 'ADOPTION', files['state']), \
                 mock.patch.object(adoption, 'PLAN', files['plan']):
                (base / 'v7-infra-adoption').mkdir(); (base / 'daily-b02').mkdir()
                result = adoption.apply(host, digest)
            self.assertEqual(result['state'], 'ADOPTED')
            final = json.loads(written[str(base / 'v7-infra-adoption/journal.json')])
            self.assertEqual(final['status'], 'APPLIED')
            self.assertEqual(final['base_receipt_ref'], RECEIPT_REF)
            self.assertEqual(final['state_sha256'], proposal['after']['state_sha256'])


if __name__ == '__main__':
    unittest.main()
