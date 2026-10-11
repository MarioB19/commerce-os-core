import concurrent.futures
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('capacity',ROOT/'scripts/additional-gateways.py')
capacity=importlib.util.module_from_spec(spec);spec.loader.exec_module(capacity)

class IncrementalCapacity(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.directory=Path(self.temp.name);self.path=self.directory/'additional-gateways.json'
        for n in range(2,21):
            p=self.directory/f'waha-{n:02d}.env';p.write_text('WAHA_API_KEY=synthetic-test-only\n');p.chmod(0o600)
    def extend(self,n):
        slots=[f'{i:02d}' for i in range(2,n+1)]
        plan=capacity.incremental(self.path,self.directory,slots)
        return capacity.incremental(self.path,self.directory,slots,plan['previous_revision'],True)
    def test_growth_2_5_10_20_readback_idempotency_preserves_networks_volumes(self):
        previous={}
        for n in [2,5,10,20]:
            result=self.extend(n);value=json.loads(self.path.read_text())
            self.assertEqual(len(capacity.validate(self.path,self.directory)),n-1)
            for name,service in previous.items():
                if name.startswith('waha-'):self.assertEqual(value['services'][name],service)
            self.assertNotIn('waha-01',value['services']);self.assertEqual(result['containers_started'],0)
            for worker in ['ingress','channel-worker']:
                self.assertEqual(len(value['services'][worker]['networks']),n-1)
            self.assertTrue(self.extend(n)['replayed']);previous=value['services']
        self.assertEqual(len(list(self.directory.glob('*.backup'))),3)
    def test_concurrent_extensions_reject_stale_revision_and_converge_on_retry(self):
        self.extend(2);before=capacity.digest(self.path)
        def attempt(n):
            try:return capacity.incremental(self.path,self.directory,[f'{i:02d}' for i in range(2,n+1)],before,True)
            except ValueError as e:return str(e)
        with concurrent.futures.ThreadPoolExecutor(2) as e:results=list(e.map(attempt,[5,10]))
        self.assertEqual(sum(isinstance(r,dict) for r in results),1)
        self.assertIn('GATEWAY_REVISION_CONFLICT',results);self.extend(20)
        self.assertEqual(len(capacity.validate(self.path,self.directory)),19)
    def test_partial_failure_preserves_prior_overlay_and_private_credentials(self):
        self.extend(10);before=self.path.read_bytes();credentials=(self.directory/'waha-02.env').read_bytes()
        (self.directory/'waha-12.env').unlink()
        with self.assertRaisesRegex(ValueError,'PRIVATE_GATEWAY_CREDENTIAL_REQUIRED'):self.extend(20)
        self.assertEqual(self.path.read_bytes(),before);self.assertEqual((self.directory/'waha-02.env').read_bytes(),credentials)
        with patch.object(capacity.os,'replace',side_effect=OSError('synthetic write interruption')):
            with self.assertRaises(OSError):self.extend(11)
        self.assertEqual(self.path.read_bytes(),before);self.assertFalse(list(self.directory.glob('.gateway-*')))
    def test_larger_winner_does_not_hide_a_smaller_stale_review(self):
        self.extend(2);revision=capacity.digest(self.path)
        capacity.incremental(self.path,self.directory,[f'{i:02d}' for i in range(2,11)],revision,True)
        after=self.path.read_bytes()
        with self.assertRaisesRegex(ValueError,'GATEWAY_REVISION_CONFLICT'):
            capacity.incremental(self.path,self.directory,[f'{i:02d}' for i in range(2,6)],revision,True)
        self.assertEqual(self.path.read_bytes(),after)
        self.assertTrue(capacity.incremental(self.path,self.directory,[f'{i:02d}' for i in range(2,11)],revision,True)['replayed'])
    def test_corrupt_overlay_and_public_permissions_fail_closed(self):
        self.extend(2);value=json.loads(self.path.read_text());value['services']['waha-02']['privileged']=True;self.path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError,'ADDITIONAL_GATEWAY_OVERLAY_CHANGED'):self.extend(5)
    def test_previous_revision_backup_is_readable_and_preserves_existing_services(self):
        self.extend(2);before=self.path.read_bytes();revision=capacity.digest(self.path);self.extend(5)
        backup=self.path.with_suffix('.'+revision+'.backup');self.assertEqual(backup.read_bytes(),before)
        self.assertEqual(capacity.validate(backup,self.directory),['02'])
        # Rollback must retain added gateway overlay while reverting application images.
        self.assertEqual(capacity.validate(self.path,self.directory),['02','03','04','05'])
if __name__=='__main__':unittest.main()
