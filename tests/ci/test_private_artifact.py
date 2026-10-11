import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'scripts'))
from ci_release import ReleaseError, digest
import ci_private_artifact as transport

class PrivateArtifactTests(unittest.TestCase):
    def test_identity_refuses_other_repo_branch_or_malformed_run(self):
        valid = {'GITHUB_REPOSITORY': transport.REPO, 'GITHUB_REF': 'refs/heads/main',
                 'GITHUB_SHA': 'a'*40, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}
        with patch.dict(os.environ, valid):
            self.assertEqual(transport.identity('package')['source_sha'], 'a'*40)
            for key, bad in [('GITHUB_REPOSITORY', 'other/repo'), ('GITHUB_REF', 'refs/heads/work'), ('GITHUB_RUN_ID', '../123')]:
                with patch.dict(os.environ, {key: bad}):
                    with self.assertRaises(ReleaseError): transport.identity('package')

    def test_downloaded_bytes_identity_traversal_and_symlink_checked(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); path = root/'package.tar'; path.write_bytes(b'verified bytes')
            expected = {'source_sha': 'a'*40, 'run_id': '123', 'kind': 'package'}
            value = {**expected, 'files': {'package.tar': digest(path)}}
            transport.validate_manifest(value, expected, root)
            with self.assertRaises(ReleaseError): transport.validate_manifest(value, {**expected, 'source_sha': 'b'*40}, root)
            path.write_bytes(b'tampered')
            with self.assertRaises(ReleaseError): transport.validate_manifest(value, expected, root)
            for name in ('../package.tar', '.', 'transport-manifest.json', 'a/b'):
                with self.assertRaises(ReleaseError): transport.validate_manifest({**expected, 'files': {name: 'a'*64}}, expected, root)
            path.unlink(); path.symlink_to(root/'missing')
            with self.assertRaises(ReleaseError): transport.validate_manifest(value, expected, root)

    def test_public_repository_and_incomplete_asset_refused(self):
        with patch.object(transport, 'gh', return_value={'private': False}):
            with self.assertRaises(ReleaseError): transport.require_private()
        for assets in ([], [{'name': 'x', 'state': 'starter'}], [{'name': 'x', 'state': 'uploaded'}]*2):
            with self.assertRaises(ReleaseError): transport.download_asset({'assets': assets}, 'x', Path('/unused'))

    def test_download_only_accepts_manifest_from_successful_package_outputs(self):
        expected = {'source_sha': 'a'*40, 'run_id': '123', 'attempt': '2', 'kind': 'package'}
        release = {'draft': True, 'target_commitish': 'a'*40}
        def download(_release, name, folder): (folder/name).write_bytes(b'changed manifest')
        with patch.dict(os.environ, {'PRIVATE_RELEASE_ID': '456', 'PRIVATE_MANIFEST_SHA256': 'f'*64}), \
             patch.object(transport, 'identity', return_value=expected), patch.object(transport, 'require_private'), \
             patch.object(transport, 'gh', return_value=release), patch.object(transport, 'download_asset', side_effect=download):
            with self.assertRaisesRegex(ReleaseError, 'ARTIFACT_MANIFEST_CHECKSUM_MISMATCH'): transport.download()

if __name__ == '__main__': unittest.main()
