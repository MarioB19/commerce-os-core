import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from ci_release import ReleaseError
spec=importlib.util.spec_from_file_location('deploy_ci_vps',Path(__file__).resolve().parents[2]/'scripts/deploy-ci-vps.py')
deploy=importlib.util.module_from_spec(spec);spec.loader.exec_module(deploy)

class ServerPortalEnvironmentTests(unittest.TestCase):
    def fixture(self,root,content):
        release=root/'releases'/'123-1';release.mkdir(parents=True)
        (root/'current.json').write_text(json.dumps({'run_id':'123-1'}))
        (release/'runtime.env').write_text(content)

    def test_filters_only_generated_values_and_preserves_private_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            self.fixture(root,'PORTAL_ORIGIN=https://example.invalid\nMCL_ACCESS_DB=/data/old.db\nPRIVATE_TOKEN=synthetic\nMCL_RELEASE_SHA='+'a'*40+'\n')
            value=deploy.current_portal_private_env(root).decode()
            self.assertEqual(value,'PORTAL_ORIGIN=https://example.invalid\nPRIVATE_TOKEN=synthetic\n')

    def test_rejects_duplicate_or_missing_generated_values(self):
        cases=(
            'PORTAL_ORIGIN=x\nMCL_ACCESS_DB=x\nMCL_ACCESS_DB=y\nMCL_RELEASE_SHA=z\n',
            'PORTAL_ORIGIN=x\nMCL_ACCESS_DB=x\n',
        )
        for content in cases:
            with self.subTest(content=content),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);self.fixture(root,content)
                with self.assertRaisesRegex(ReleaseError,'PORTAL_RUNTIME_ENV_FILTER_INVALID'):
                    deploy.current_portal_private_env(root)

    def test_rejects_symlinked_state_or_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);outside=root/'outside';outside.write_text(json.dumps({'run_id':'123-1'}))
            (root/'current.json').symlink_to(outside)
            with self.assertRaisesRegex(ReleaseError,'PORTAL_CURRENT_STATE_INVALID'):
                deploy.current_portal_private_env(root)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);release=root/'releases'/'123-1';release.mkdir(parents=True)
            (root/'current.json').write_text(json.dumps({'run_id':'123-1'}));outside=root/'outside';outside.write_text('PORTAL_ORIGIN=x\nMCL_ACCESS_DB=x\nMCL_RELEASE_SHA=y\n')
            (release/'runtime.env').symlink_to(outside)
            with self.assertRaisesRegex(ReleaseError,'PORTAL_RUNTIME_ENV_INVALID'):
                deploy.current_portal_private_env(root)

    def test_report_publication_is_atomic_and_private(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'report.json'
            deploy._write_report(path,{'status':'SUCCEEDED','source_sha':'a'*40})
            self.assertEqual(json.loads(path.read_text())['status'],'SUCCEEDED')
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            self.assertEqual(list(Path(directory).glob('.report-*.json')),[])

    def test_sigterm_is_converted_to_a_rollback_error(self):
        with self.assertRaisesRegex(ReleaseError,'REMOTE_DEPLOYMENT_TERMINATED'):
            deploy._terminate_for_rollback(None,None)

if __name__=='__main__':
    unittest.main()
