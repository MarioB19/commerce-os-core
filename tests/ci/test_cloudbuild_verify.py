"""Local contract tests only; these do not claim a FULL run or Cloud Build PASS."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO/'scripts'))
spec = importlib.util.spec_from_file_location('cloudbuild_verify', REPO/'scripts/cloudbuild-verify.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
BUILD = '12345678-1234-4234-8234-123456789abc'
IMAGE = 'us-east1-docker.pkg.dev/fixture-project/commerce-ci-public/verify@sha256:'+'d'*64


class VerificationContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root/'scripts/tests').mkdir(parents=True)
        (self.root/'scripts/tests/one.test.mjs').write_text('// fixture\n')
        (self.root/'.github/workflows').mkdir(parents=True)
        (self.root/'.github/workflows/ci.yml').write_text('fixture workflow\n')
        (self.root/'package.json').write_text(json.dumps({'packageManager': 'pnpm@10.34.5'}))
        (self.root/'.node-version').write_text('24.20.0\n')
        (self.root/'.gitignore').write_text('.runtime/\n')
        self.git('init', '--quiet')
        self.git('add', '.')
        # Only this disposable fixture repository is committed.
        self.git('-c', 'user.name=CI Fixture', '-c', 'user.email=fixture@commerce.test',
                 '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '--quiet', '-m', 'fixture')
        self.sha = self.git('rev-parse', 'HEAD').strip()

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, text=True,
                                       stderr=subprocess.PIPE)

    def run_verify(self, executor, **kwargs):
        def shared_fixture(run, root):
            directory = run/'toolchain'
            directory.mkdir()
            node = directory/'node'
            node.write_bytes(b'synthetic executable; never invoked')
            return node, m.file_sha256(node)
        with patch.object(m, 'toolchain'), patch.object(m, 'prepare_shared_node', side_effect=shared_fixture), contextlib.redirect_stdout(io.StringIO()):
            return m.verify(self.root, self.sha, BUILD, IMAGE, executor=executor, **kwargs)

    def test_exact_commit_clean_checkout_and_untracked_files(self):
        self.assertRegex(m.source_identity(self.root, self.sha), '[a-f0-9]{40}')
        with self.assertRaisesRegex(m.VerificationError, 'SOURCE_SHA_MISMATCH'):
            m.source_identity(self.root, 'a'*40)
        (self.root/'unexpected.txt').write_text('uncommitted input')
        with self.assertRaisesRegex(m.VerificationError, 'SOURCE_TREE_NOT_CLEAN'):
            m.source_identity(self.root, self.sha)

    def test_tracked_change_and_archive_without_git_are_rejected(self):
        (self.root/'.node-version').write_text('changed')
        with self.assertRaisesRegex(m.VerificationError, 'SOURCE_TREE_NOT_CLEAN'):
            m.source_identity(self.root, self.sha)
        with tempfile.TemporaryDirectory() as archive:
            with self.assertRaisesRegex(m.VerificationError, 'GIT_CHECKOUT_REQUIRED'):
                m.source_identity(Path(archive), self.sha)

    def test_unknown_identity_unpinned_image_and_timeout_are_rejected(self):
        for build, image, seconds in [('actions-123', IMAGE, 10), (BUILD, IMAGE.split('@')[0], 10),
                                      (BUILD, IMAGE, 0), (BUILD, IMAGE, 5401), (BUILD, IMAGE, True)]:
            with self.subTest(build=build, seconds=seconds):
                with self.assertRaises(m.VerificationError):
                    m.validate_request(build, image, seconds)

    def test_toolchain_drift_fails_before_any_stage(self):
        values = {'node': 'v24.20.0', 'pnpm': '10.34.5', 'docker': 'linux'}
        with patch.object(m.sys, 'platform', 'linux'), patch.object(m, 'capture', side_effect=lambda argv, root: values[argv[0]]):
            m.toolchain(self.root)
            values['node'] = 'v24.19.0'
            with self.assertRaisesRegex(m.VerificationError, 'NODE_VERSION_MISMATCH'):
                m.toolchain(self.root)

    def test_full_run_records_every_gate_and_never_claims_deployment(self):
        calls = []
        def executor(argv, cwd, env, seconds):
            calls.append((argv, cwd, env, seconds))
            return 0
        result = self.run_verify(executor)
        self.assertEqual(result['status'], 'PASSED')
        self.assertEqual(result['source_sha'], self.sha)
        self.assertEqual(result['build_id'], BUILD)
        self.assertEqual(len(calls), 21)
        self.assertTrue(all(s['status'] == 'PASSED' for s in result['stages']))
        self.assertFalse(result['deployment_proven'])
        self.assertFalse(result['github_check_published'])
        self.assertEqual(calls[9][1], self.root/'portals/mi-ciclo-listo')
        self.assertNotEqual(calls[19][2]['COMMERCE_CONFIG_DIR'], calls[0][2]['COMMERCE_CONFIG_DIR'])
        self.assertEqual(json.loads((self.root/'.runtime'/('cloudbuild-'+BUILD)/'verification.json').read_text()), result)

    def test_failed_stage_stops_and_all_later_gates_remain_not_run(self):
        calls = []
        def executor(argv, cwd, env, seconds):
            calls.append(argv)
            return 37 if argv == ['pnpm', 'test:integration'] else 0
        result = self.run_verify(executor)
        self.assertEqual(result['status'], 'FAILED')
        self.assertEqual(result['failure_code'], 'REQUIRED_STAGE_FAILED')
        self.assertEqual(result['stages'][15]['exit_code'], 37)
        self.assertTrue(all(s['status'] == 'NOT_RUN' for s in result['stages'][16:]))
        self.assertNotIn(['pnpm', 'audit', '--audit-level', 'high'], calls)

    def test_timeout_has_no_pass_and_is_not_retried(self):
        def timeout(argv, cwd, env, seconds):
            raise subprocess.TimeoutExpired(argv, seconds)
        result = self.run_verify(timeout)
        self.assertEqual(result['status'], 'TIMED_OUT')
        self.assertEqual(result['stages'][0]['status'], 'TIMED_OUT')
        self.assertTrue(all(s['status'] == 'NOT_RUN' for s in result['stages'][1:]))

    def test_cancellation_is_not_success(self):
        def cancelled(*args):
            raise KeyboardInterrupt()
        result = self.run_verify(cancelled)
        self.assertEqual(result['status'], 'CANCELLED')
        self.assertEqual(result['stages'][0]['status'], 'CANCELLED')

    def test_post_test_source_drift_invalidates_otherwise_green_gates(self):
        def mutate(argv, cwd, env, seconds):
            if argv == ['pnpm', 'audit', '--audit-level', 'high']:
                (self.root/'.node-version').write_text('changed after tests\n')
            return 0
        result = self.run_verify(mutate)
        self.assertEqual(result['status'], 'FAILED')
        self.assertEqual(result['failure_code'], 'SOURCE_TREE_NOT_CLEAN')

    def test_attempt_is_not_reused(self):
        self.run_verify(lambda *args: 0)
        with self.assertRaisesRegex(m.VerificationError, 'VERIFICATION_ATTEMPT_ALREADY_EXISTS'):
            self.run_verify(lambda *args: self.fail('must not restart tests'))

    def test_provider_credentials_and_database_are_not_forwarded(self):
        env = m.test_environment(self.root, {'PATH': '/bin', 'HOME': '/production',
            'GH_TOKEN': 'synthetic', 'GOOGLE_APPLICATION_CREDENTIALS': '/credentials',
            'OPENAI_API_KEY': 'synthetic', 'DATABASE_URL': 'postgres://production',
            'COMMERCE_CONFIG_DIR': '/production', 'REAL_SENDS_ENABLED': 'true'})
        self.assertEqual(env['PATH'], str(self.root/'toolchain')+os.pathsep+'/bin')
        self.assertEqual(env['HOME'], '/root')
        self.assertEqual(env['TMPDIR'], '/tmp')
        self.assertEqual(env['npm_config_store_dir'], str(self.root/'pnpm-store'))
        self.assertEqual(env['COMMERCE_CONFIG_DIR'], str(self.root/'local'))
        for key in ('GH_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'OPENAI_API_KEY', 'DATABASE_URL', 'REAL_SENDS_ENABLED'):
            self.assertNotIn(key, env)

    def test_general_fixtures_stay_outside_repo_and_only_linux_capsule_shares_tmp(self):
        run = m.private_run_directory(self.root, BUILD)
        env = m.test_environment(run, {})
        with tempfile.TemporaryDirectory(dir=env['TMPDIR']) as fixture:
            self.assertFalse(Path(fixture).resolve().is_relative_to(self.root))
        stages = m.full_stages(self.root, run)
        overrides = {stage['id']: stage['env']['TMPDIR'] for stage in stages if 'TMPDIR' in stage['env']}
        self.assertEqual(overrides, {'portal-capsule-linux': str(run/'tmp')})
        self.assertTrue(Path(env['npm_config_store_dir']).is_relative_to(run))
        self.assertEqual(Path(env['npm_config_store_dir']).stat().st_mode & 0o777, 0o700)

    def test_node_executable_is_copied_into_shared_runtime_for_sibling_mounts(self):
        original = self.root/'trusted-node'
        original.write_bytes(b'synthetic trusted node image bytes')
        run = m.private_run_directory(self.root, BUILD)
        with patch.object(m, 'capture', side_effect=[str(original), 'v24.20.0']) as capture:
            node, digest = m.prepare_shared_node(run, self.root)
        self.assertEqual(node, run/'toolchain/node')
        self.assertFalse(node.is_symlink())
        self.assertEqual(node.read_bytes(), original.read_bytes())
        self.assertEqual(digest, m.file_sha256(original))
        self.assertEqual(node.stat().st_mode & 0o777, 0o555)
        self.assertEqual(capture.call_args_list[1].args[0], [str(node), '--version'])

    def test_shared_node_mutation_invalidates_green_stages(self):
        def mutate(argv, cwd, env, seconds):
            if argv == ['pnpm', 'audit', '--audit-level', 'high']:
                (self.root/'.runtime'/('cloudbuild-'+BUILD)/'toolchain/node').write_bytes(b'changed')
            return 0
        result = self.run_verify(mutate)
        self.assertEqual(result['status'], 'FAILED')
        self.assertEqual(result['failure_code'], 'SHARED_NODE_CHANGED_DURING_TESTS')

    def test_runtime_symlink_cannot_point_to_existing_configuration(self):
        (self.root/'.runtime').symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(m.VerificationError, 'UNSAFE_RUNTIME_DIRECTORY'):
            m.private_run_directory(self.root, BUILD)

    def test_real_timeout_terminates_process(self):
        pidfile = self.root/'pid'
        program = 'import os,time;open('+repr(str(pidfile))+',"w").write(str(os.getpid()));time.sleep(30)'
        with self.assertRaises(subprocess.TimeoutExpired):
            m.execute([sys.executable, '-c', program], self.root, dict(os.environ), .3)
        pid = int(pidfile.read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_child_uses_standard_mask_while_runner_directory_stays_private(self):
        previous = os.umask(0o077)
        try:
            run = m.private_run_directory(self.root, BUILD)
            output = run/'tmp/child-created.txt'
            program = 'from pathlib import Path;Path('+repr(str(output))+').write_text("synthetic")'
            self.assertEqual(m.execute([sys.executable, '-c', program], self.root,
                                       dict(os.environ), 10), 0)
            self.assertEqual(output.stat().st_mode & 0o777, 0o644)
            self.assertEqual(run.stat().st_mode & 0o777, 0o700)
            self.assertEqual((run/'tmp').stat().st_mode & 0o777, 0o700)
            self.assertEqual(os.umask(0o077), 0o077)
        finally:
            os.umask(previous)


class CheckedInConfigurationTests(unittest.TestCase):
    def test_every_full_workflow_command_is_represented_in_same_order(self):
        # Extract actual verify commands, rather than mirror the driver IDs.
        block = (REPO/'.github/workflows/ci.yml').read_text().split('\n  verify:\n', 1)[1].split('\n  ci-gate:\n', 1)[0]
        lines, commands = block.splitlines(), []
        for index, line in enumerate(lines):
            match = re.match(r'^(\s*)(?:-\s+)?run:\s*(.*)$', line)
            if not match:
                continue
            value = match[2]
            if value == '|':
                value = []
                for following in lines[index+1:]:
                    if following.strip() and len(following)-len(following.lstrip()) <= len(match[1]):
                        break
                    if following.strip():
                        value.append(following.strip())
                value = '\n'.join(value)
            commands.extend(piece.strip() for piece in re.split(r'\n| && ', value) if piece.strip())
        # pnpm installation is supplied by the pinned verifier image instead.
        commands.remove('npm install --global pnpm@10.34.5')
        with tempfile.TemporaryDirectory() as run:
            stages = m.full_stages(REPO, Path(run))
            actual = [' '.join(s['argv']) for s in stages]
            actual[0] = 'git diff --check'  # The driver adds only safe.directory.
            actual[3] = 'node --test scripts/tests/*.test.mjs'  # Explicit glob expansion, no shell.
            actual[18] = 'node scripts/setup-campaign-review.mjs "$RUNNER_TEMP/campaign-review"'
        self.assertEqual([shlex.split(s) for s in actual], [shlex.split(s) for s in commands])

    def test_verify_config_is_bounded_and_has_no_release_or_secret_steps(self):
        text = (REPO/'infra/cloudbuild/verify.yaml').read_text()
        self.assertIn('timeout: 5700s', text)
        self.assertIn('--timeout-seconds 5400', text)
        self.assertIn('commerce-v7-verify-core@$PROJECT_ID.iam.gserviceaccount.com', text)
        self.assertIn('EXPECTED_SHA=$COMMIT_SHA', text)
        self.assertIn('sourceProvenanceHash: [SHA256]', text)
        for forbidden in ('availableSecrets:', 'secretEnv:', 'allowFailure:', 'allowExitCodes:',
                          'deploy-ci-client.py', 'package-ci.py', 'gh api', 'gcloud compute'):
            self.assertNotIn(forbidden, text)
        image = (REPO/'infra/cloudbuild/Dockerfile.verify').read_text()
        self.assertIn('COPY scripts/cloudbuild-verify.py /opt/commerce-ci/cloudbuild-verify.py', image)


class LinuxNonRootBoundaryTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0,
                         'supplements the existing boundary only in a Linux Root verifier')
    def test_real_cli_rejects_uid_1000_before_reading_private_paths(self):
        # The legacy Python suite skips this boundary when its parent is Root.
        # Run its real CLI under another UID with exact copies of public code.
        # /tmp is intentionally independent of a private daemon workspace path.
        names = ('copy-source-isolation-root.py', 'copy_source_isolation_root.py')
        # The public profile adds this local import to the CLI. Keep the same
        # code closure in the isolated fixture before exercising its UID gate.
        if (REPO/'scripts'/'operator_identity.py').is_file():
            names += ('operator_identity.py',)
        with tempfile.TemporaryDirectory(prefix='commerce-nonroot-', dir='/tmp') as temporary:
            root = Path(temporary)
            scripts = root/'scripts'
            scripts.mkdir(mode=0o755)
            scripts.chmod(0o755)
            digests = {}
            for name in names:
                original = (REPO/'scripts'/name).read_bytes()
                copied = scripts/name
                copied.write_bytes(original)
                copied.chmod(0o444)
                digests[name] = hashlib.sha256(original).hexdigest()
                self.assertEqual(hashlib.sha256(copied.read_bytes()).hexdigest(), digests[name])
            root.chmod(0o755)
            result = subprocess.run(
                [sys.executable, '-I', str(scripts/'copy-source-isolation-root.py')],
                input=b'{}', capture_output=True, timeout=5, cwd=root,
                user=1000, group=1000, extra_groups=[],
                env={'PATH': os.defpath, 'PYTHONDONTWRITEBYTECODE': '1'})
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr, b'')
            self.assertEqual(json.loads(result.stdout)['code'], 'ISOLATION_ROOT_LINUX_STDIN_ONLY')
            for name in names:
                self.assertEqual(hashlib.sha256((scripts/name).read_bytes()).hexdigest(), digests[name])


if __name__ == '__main__':
    unittest.main()
