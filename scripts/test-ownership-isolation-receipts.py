#!/usr/bin/env python3
"""Synthetic Docker/DB-free checks of installer attestation decisions."""
import datetime as dt
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).with_name('ownership-isolation-receipts.py')
spec = importlib.util.spec_from_file_location('ownership_attestation', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class IsolationTests(unittest.TestCase):
    def setUp(self):
        self.now = dt.datetime(2026, 9, 6, 12, 0, tzinfo=dt.timezone.utc)
        self.container = {'id': 'a'*64, 'running': True, 'project': 'commerce-os', 'service': 'channel-worker', 'restart': 'unless-stopped', 'networks': ['commerce-os_core']}
        self.snapshot = {'captured_at': self.now.isoformat(), 'containers': [self.container], 'owners': []}

    def evaluate(self, state=None, current=None):
        return module.validate_snapshot(self.snapshot, {self.container['id']: state}, current or ['b'*64], self.now)

    def test_removed_container_is_isolated(self):
        self.assertTrue(self.evaluate())

    def test_stopped_container_without_network_and_restart_is_isolated(self):
        self.assertTrue(self.evaluate({**self.container, 'running': False, 'networks': [], 'restart': 'no'}))

    def test_running_old_container_is_never_isolated(self):
        with self.assertRaisesRegex(RuntimeError, 'NOT_VERIFIED'):
            self.evaluate(self.container)

    def test_stopped_but_networked_container_is_not_isolated(self):
        with self.assertRaisesRegex(RuntimeError, 'NOT_VERIFIED'):
            self.evaluate({**self.container, 'running': False, 'restart': 'no'})

    def test_stopped_auto_restart_container_is_not_isolated(self):
        with self.assertRaisesRegex(RuntimeError, 'NOT_VERIFIED'):
            self.evaluate({**self.container, 'running': False, 'networks': []})

    def test_unchanged_container_needs_no_handoff(self):
        self.assertFalse(self.evaluate(self.container, [self.container['id']]))

    def test_first_install_has_no_previous_owner_to_attest(self):
        self.snapshot['containers'] = []
        self.assertFalse(self.evaluate())

    def test_ambiguous_container_topology_is_denied(self):
        self.snapshot['containers'].append({**self.container, 'id': 'c'*64})
        with self.assertRaisesRegex(RuntimeError, 'AMBIGUOUS'):
            self.evaluate()

    def test_wrong_service_cannot_prove_channel_ownership(self):
        self.container['service'] = 'postgres'
        with self.assertRaisesRegex(RuntimeError, 'TOPOLOGY_INVALID'):
            self.evaluate()

    def test_old_or_future_capture_is_denied(self):
        for delta in [dt.timedelta(hours=-2), dt.timedelta(seconds=1)]:
            self.snapshot['captured_at'] = (self.now+delta).isoformat()
            with self.assertRaisesRegex(RuntimeError, 'CAPTURE_EXPIRED'):
                self.evaluate()

    def test_private_evidence_has_owner_only_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'evidence.json'
            module.private_write(path, self.snapshot)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            target = Path(directory)/'link.json'
            target.symlink_to(path)
            with self.assertRaisesRegex(RuntimeError, 'PATH_INVALID'):
                module.private_write(target, {})

    def test_release_hold_requires_compatible_running_and_candidate_images_and_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory)/'release.env'
            release.write_text('COMMERCE_IMAGE=sha256:'+'c'*64+'\n')
            def docker(arguments, input_text=None):
                if arguments[:3] == ['docker', 'inspect', '--format']:
                    return 'sha256:'+'b'*64
                if arguments[:2] == ['docker', 'run']:
                    if 'sha256:'+'b'*64 in arguments and blocked[0]:
                        return '0'
                    return '1'
                raise AssertionError(arguments)
            blocked=[False]
            with patch.object(module, 'compose', return_value='a'*64), patch.object(module, 'run', side_effect=docker), patch.object(module, 'database', return_value='t') as database:
                self.assertTrue(module.supports_hold(release))
                blocked[0]=True
                self.assertFalse(module.supports_hold(release))
                blocked[0]=False
                database.return_value='f'
                with self.assertRaisesRegex(RuntimeError, 'RELEASE_HOLD_SCHEMA_MISSING'):
                    module.supports_hold(release)
                database.return_value='t'
                with patch.object(module, 'run', side_effect=RuntimeError('DOCKER_UNAVAILABLE')):
                    with self.assertRaisesRegex(RuntimeError, 'DOCKER_UNAVAILABLE'):
                        module.supports_hold(release)

    def historical(self):
        owner = {'account_id': 'fixture-account', 'workspace_id': 'fixture-workspace', 'previous_owner_id': 'fixture-owner', 'generation': 3}
        self.snapshot['owners'] = [owner]
        proof = {'snapshot': self.snapshot, 'verified_containers': {self.container['id']: None}, 'replacement_ids': ['b'*64]}
        candidate = {**owner, 'verified_at': (self.now+dt.timedelta(seconds=10)).isoformat(), 'consumed_at': None,
                     'evidence_sha256': hashlib.sha256(json.dumps(proof, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}
        return proof, candidate

    def test_expired_receipt_requires_original_hash_and_new_confirmed_removal(self):
        proof, candidate = self.historical()
        self.assertEqual(module.validate_historical_proof(proof, candidate, ['c'*64], None, self.now+dt.timedelta(days=2)), 'a'*64)

    def test_historical_evidence_tampering_is_rejected(self):
        proof, candidate = self.historical()
        proof = copy.deepcopy(proof)
        proof['snapshot']['containers'][0]['id'] = 'd'*64
        with self.assertRaisesRegex(RuntimeError, 'HASH_MISMATCH'):
            module.validate_historical_proof(proof, candidate, ['c'*64], None, self.now+dt.timedelta(days=2))

    def test_historical_scope_or_generation_cannot_be_reassigned(self):
        for key in ('account_id', 'workspace_id', 'previous_owner_id', 'generation'):
            proof, candidate = self.historical()
            candidate[key] = 'different'
            with self.assertRaisesRegex(RuntimeError, 'OWNER_MISMATCH'):
                module.validate_historical_proof(proof, candidate, ['c'*64], None, self.now+dt.timedelta(days=2))

    def test_stopped_or_running_historical_container_cannot_be_reverified(self):
        for state in (self.container, {**self.container, 'running': False, 'restart': 'no', 'networks': []}):
            proof, candidate = self.historical()
            with self.assertRaisesRegex(RuntimeError, 'NOT_REMOVED'):
                module.validate_historical_proof(proof, candidate, ['c'*64], state, self.now+dt.timedelta(days=2))

    def test_current_worker_cannot_be_claimed_as_removed(self):
        proof, candidate = self.historical()
        with self.assertRaisesRegex(RuntimeError, 'NOT_REMOVED'):
            module.validate_historical_proof(proof, candidate, ['a'*64], None, self.now+dt.timedelta(days=2))

    def test_consumed_fresh_or_future_receipt_is_not_renewed(self):
        for delta, consumed in ((dt.timedelta(days=2), self.now.isoformat()), (dt.timedelta(hours=1), None), (dt.timedelta(seconds=-1), None)):
            proof, candidate = self.historical(); candidate['consumed_at'] = consumed
            with self.assertRaisesRegex(RuntimeError, 'NOT_ELIGIBLE'):
                module.validate_historical_proof(proof, candidate, ['c'*64], None, self.now+delta)

    def test_original_receipt_must_have_valid_contemporaneous_isolation(self):
        proof, candidate = self.historical()
        candidate['verified_at'] = (self.now+dt.timedelta(hours=2)).isoformat()
        with self.assertRaisesRegex(RuntimeError, 'CAPTURE_EXPIRED'):
            module.validate_historical_proof(proof, candidate, ['c'*64], None, self.now+dt.timedelta(days=2))

    def test_later_deployment_reverifies_expired_receipt_from_canonical_history(self):
        proof,candidate=self.historical();candidate['id']='11111111-1111-4111-8111-111111111111'
        clock=[self.now+dt.timedelta(seconds=10)]
        class Clock(dt.datetime):
            @classmethod
            def now(cls,tz=None):return clock[0]
        current={**self.container,'id':'b'*64}
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);history=root/'ownership-attestations';first=root/'deployments-first';later=root/'deployments-later'
            for path in (history,first,later):path.mkdir(mode=0o700)
            original=first/'ownership-before.json';module.private_write(original,self.snapshot)
            calls=[]
            def database(_release,sql):
                calls.append(sql)
                if 'row_to_json(c)' in sql:return json.dumps([candidate,candidate]) if clock[0]>self.now+dt.timedelta(days=1) else '[]'
                return '1'
            with patch.dict(os.environ,{'COMMERCE_OWNERSHIP_HISTORY_DIR':str(history)}),patch.object(module.dt,'datetime',Clock),patch.object(module,'container_ids',return_value=['b'*64]),patch.object(module,'inspect',side_effect=lambda value:current if value=='b'*64 else None),patch.object(module,'database',side_effect=database):
                module.attest('fixture.env',original)
                archived=next(history.glob('proof-*.attested.json'));before=archived.read_bytes()
                module.attest('fixture.env',original)
                self.assertEqual(len(list(history.glob('*.attested.json'))),1)
                self.assertEqual(archived.read_bytes(),before)
                self.assertEqual(json.loads(before),{'proof':proof,'evidence_sha256':candidate['evidence_sha256']})
                self.assertTrue(original.with_suffix('.attested.json').is_file())
                clock[0]=self.now+dt.timedelta(days=2)
                fresh=later/'ownership-before.json';module.private_write(fresh,{'captured_at':clock[0].isoformat(),'containers':[current],'owners':[]})
                calls.clear();result=module.attest('fixture.env',fresh)
            self.assertFalse(result['replacement']);self.assertEqual(result['reverified_receipts'],1)
            self.assertEqual(sum('WITH inserted AS' in sql for sql in calls),1)
            self.assertEqual(len(list(history.glob('reverified-*.json'))),1)
            self.assertFalse(list(later.glob('*.attested.json')))
            self.assertEqual(archived.stat().st_mode&0o777,0o600)

    def test_canonical_history_rejects_shared_or_symlink_directory_and_tampered_proof(self):
        proof,candidate=self.historical()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);history=root/'history';history.mkdir(mode=0o700)
            with patch.dict(os.environ,{'COMMERCE_OWNERSHIP_HISTORY_DIR':str(history)}):
                self.assertEqual(module.history_directory(root/'capture.json'),history)
                history.chmod(0o755)
                with self.assertRaisesRegex(RuntimeError,'PERMISSIONS_INVALID'):module.history_directory(root/'capture.json')
                history.chmod(0o700)
                link=root/'link';link.symlink_to(history)
                with patch.dict(os.environ,{'COMMERCE_OWNERSHIP_HISTORY_DIR':str(link)}):
                    with self.assertRaisesRegex(RuntimeError,'PERMISSIONS_INVALID'):module.history_directory(root/'capture.json')
            module.archive_proof(history,proof,candidate['evidence_sha256'])
            path=next(history.glob('*.attested.json'));path.write_text('{}')
            with self.assertRaisesRegex(RuntimeError,'PROOF_MISMATCH'):module.archive_proof(history,proof,candidate['evidence_sha256'])


if __name__ == '__main__':
    unittest.main()
