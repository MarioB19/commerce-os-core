"""Synthetic identity inputs exercise custody and fail-before-command behavior."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'scripts'))
import operator_identity as identity


def fixture():
    return json.dumps({'schema_version':1,'accounts':{'cloud_build':'ci@example.invalid','legacy_billing':'billing@example.invalid'}}).encode()


class OperatorIdentityTests(unittest.TestCase):
    def test_explicit_roles_and_closed_config(self):
        self.assertEqual(identity.configured_account(fixture(),'cloud_build'),'ci@example.invalid')
        self.assertEqual(identity.configured_account(fixture(),'legacy_billing'),'billing@example.invalid')
        for change in (lambda x:x.update(project='other'), lambda x:x['accounts'].pop('legacy_billing'),
                       lambda x:x['accounts'].update(cloud_build=''), lambda x:x.update(schema_version=True)):
            value=json.loads(fixture()); change(value)
            with self.assertRaises(identity.OperatorIdentityError): identity.configured_account(json.dumps(value).encode(),'cloud_build')
        with self.assertRaises(identity.OperatorIdentityError): identity.configured_account(fixture(),'untrusted')
        with self.assertRaises(identity.OperatorIdentityError): identity.configured_account(b'{"accounts":{},"accounts":{}}','cloud_build')

    def test_workspace_config_cannot_supply_identity(self):
        with patch.object(identity,'CUSTODY_ROOT',ROOT/'private'):
            with self.assertRaisesRegex(identity.OperatorIdentityError,'OUTSIDE_SOURCE'):
                identity.local_account('cloud_build')

    def test_unprotected_tmp_parent_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory); (p/'operator-identity.json').write_bytes(fixture())
            (p/'operator-identity.json').chmod(0o600)
            with patch.object(identity,'CUSTODY_ROOT',p):
                with self.assertRaisesRegex(identity.OperatorIdentityError,'PARENT_UNSAFE'):
                    identity.local_account('cloud_build')

    def test_missing_identity_blocks_native_reads(self):
        spec=importlib.util.spec_from_file_location('identity_status',ROOT/'scripts/cloudbuild-publish-status.py')
        publisher=importlib.util.module_from_spec(spec);spec.loader.exec_module(publisher)
        with patch.object(identity,'local_account',side_effect=identity.OperatorIdentityError('MISSING')):
            with self.assertRaisesRegex(identity.OperatorIdentityError,'MISSING'):
                publisher.evaluate({},'gcloud',runner=lambda *a,**k:self.fail('native command started'))
        import cloudbuild_release_evidence as release
        with patch.object(identity,'local_account',side_effect=identity.OperatorIdentityError('MISSING')):
            with self.assertRaisesRegex(identity.OperatorIdentityError,'MISSING'):
                release.common()

    def test_root_reads_identity_before_lock_or_mutation(self):
        spec=importlib.util.spec_from_file_location('identity_root',ROOT/'scripts/copy-source-isolation-root.py')
        adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
        with patch.object(adapter.sys,'platform','linux'),patch.object(adapter.os,'geteuid',return_value=0), \
             patch.object(adapter.sys,'argv',['issuer']),patch.object(adapter.select,'select',return_value=([0],[],[])), \
             patch.object(adapter.os,'read',return_value=b''),patch.object(adapter,'parse',return_value={}), \
             patch.object(adapter,'validate_control',return_value={}), \
             patch.object(adapter,'protected_bytes',side_effect=FileNotFoundError), \
             patch.object(adapter,'acquire_locks',side_effect=AssertionError('must not lock')):
            with self.assertRaises(FileNotFoundError):adapter.main()
