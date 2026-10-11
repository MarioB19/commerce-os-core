import importlib.util
import os
from pathlib import Path
import sys
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from ci_release import ReleaseError

spec = importlib.util.spec_from_file_location('package_ci', ROOT / 'scripts' / 'package-ci.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PackageImageRevisionTests(unittest.TestCase):
    SHA = 'a' * 40

    def image(self, labels=None):
        return {
            'Id': 'sha256:' + 'b' * 64,
            'Os': 'linux',
            'Architecture': 'amd64',
            'Config': {'Labels': labels},
            'RootFS': {'Layers': ['sha256:' + 'c' * 64]},
        }

    def test_missing_source_revision_label_is_rejected(self):
        for labels in (None, {}, {'other.label': self.SHA}):
            with self.subTest(labels=labels), self.assertRaisesRegex(
                ReleaseError, '^IMAGE_SOURCE_SHA_LABEL_MISSING$'
            ):
                package.release_image_metadata(self.image(labels), self.SHA)

    def test_clean_source_revision_binds_head_and_rejects_dirty_bytes(self):
        with mock.patch.object(package, 'run', side_effect=[self.SHA, '']):
            self.assertEqual(package.clean_source_revision(self.SHA), self.SHA)
        with mock.patch.object(package, 'run', side_effect=[self.SHA, ' M apps/api/src/app.ts']), self.assertRaisesRegex(
            ReleaseError, '^SOURCE_TREE_DIRTY$'
        ):
            package.clean_source_revision(self.SHA)

    def test_clean_source_revision_rejects_a_different_declared_sha(self):
        with mock.patch.object(package, 'run', return_value=self.SHA), self.assertRaisesRegex(
            ReleaseError, '^SOURCE_COMMIT_MISMATCH$'
        ):
            package.clean_source_revision('d' * 40)

    def test_source_preflight_rejects_an_ignored_portal_secret_without_exposing_it(self):
        self.assertEqual(package.sensitive_build_input_count(), 0)
        marker=f'codex-release-sentinel-{os.getpid()}'
        public=ROOT/'portals'/'mi-ciclo-listo'/'public'
        secret_parent=public/'.secrets';secret_scope=secret_parent/marker
        pem=public/(marker+'.pem')
        secret_scope.mkdir(parents=True,exist_ok=True);(secret_scope/'token').write_text('synthetic-secret');pem.write_text('synthetic-certificate')
        try:
            with mock.patch.object(package, 'run', side_effect=[self.SHA, '']), self.assertRaisesRegex(
                ReleaseError, '^SENSITIVE_BUILD_INPUT_PRESENT$'
            ):
                package.release_source_preflight(self.SHA)
        finally:
            pem.unlink(missing_ok=True);(secret_scope/'token').unlink(missing_ok=True);secret_scope.rmdir()
            try: secret_parent.rmdir()
            except OSError: pass

    def test_mismatched_source_revision_label_is_rejected(self):
        labels = {package.SOURCE_REVISION_LABEL: 'd' * 40}
        with self.assertRaisesRegex(ReleaseError, '^IMAGE_SOURCE_SHA_MISMATCH$'):
            package.release_image_metadata(self.image(labels), self.SHA)

    def test_exact_source_revision_is_preserved_in_manifest_metadata(self):
        labels = {package.SOURCE_REVISION_LABEL: self.SHA}
        self.assertEqual(
            package.release_image_metadata(self.image(labels), self.SHA),
            {
                'id': 'sha256:' + 'b' * 64,
                'layers': ['sha256:' + 'c' * 64],
                'source_sha': self.SHA,
            },
        )

    def test_all_release_builds_receive_and_publish_the_source_sha(self):
        core = (ROOT / 'infra' / 'Dockerfile').read_text()
        portal = (ROOT / 'portals' / 'mi-ciclo-listo' / 'Dockerfile').read_text()
        workflow = (ROOT / '.github' / 'workflows' / 'ci.yml').read_text()
        runbook = (ROOT / 'docs' / 'commerce-resilience-release-runbook.md').read_text()
        label = 'LABEL org.opencontainers.image.revision="${SOURCE_SHA}"'

        self.assertEqual(core.count(label), 3)
        self.assertEqual(portal.count(label), 1)
        self.assertEqual(workflow.count('SOURCE_SHA=${{ github.sha }}'), 4)
        self.assertEqual(runbook.count('--build-arg SOURCE_SHA="$FINAL_SHA"'), 4)

    def test_docker_contexts_exclude_ignored_credentials_and_backups(self):
        required = {'**/*.key', '**/*.pem', '**/*.p12', '**/*.pfx', '**/*.dump', '**/*.backup', '**/*.backup.aes', '**/*.tar', '**/*.tar.gz', '**/.secrets/', '**/.secrets/**'}
        for path in (ROOT / '.dockerignore', ROOT / 'portals' / 'mi-ciclo-listo' / '.dockerignore'):
            with self.subTest(path=path):
                entries = {line.strip() for line in path.read_text().splitlines() if line.strip() and not line.startswith('#')}
                self.assertTrue(required.issubset(entries), required - entries)


if __name__ == '__main__':
    unittest.main()
