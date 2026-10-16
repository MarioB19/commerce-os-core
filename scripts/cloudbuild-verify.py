#!/usr/bin/env python3
"""Bounded FULL verification only. No deployment, GitHub check, or cloud mutation.

The trusted verifier image carries this driver; candidate source supplies tests.
Its receipt must be joined to the native Cloud Build identity and terminal status
by a separate trusted check publisher. A workspace JSON file is not attestation.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid

from cloudbuild_bounded_logs import execute as execute_with_log_limits, LogLimitExceeded

NODE_VERSION = '24.20.0'
PNPM_VERSION = '10.34.5'
MAX_SUITE_SECONDS = 5400
GATE_NAME = 'Commerce V7 Cloud Build gate'
IMAGE_PATTERN = re.compile(r'[a-z0-9-]+-docker\.pkg\.dev/[a-z0-9.-]+/commerce-ci-public/verify@sha256:[a-f0-9]{64}')


class VerificationError(RuntimeError):
    pass


def require(value, code):
    if not value:
        raise VerificationError(code)


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def capture(argv, root):
    result = subprocess.run(argv, cwd=root, check=True, capture_output=True,
                            text=True, timeout=30)
    return result.stdout.strip()


def git(root, *args):
    # Root in the disposable verifier may differ from the source-fetch owner.
    # Scope safe.directory to this invocation, never rewrite the source config.
    return capture(['git', '-c', 'safe.directory='+str(root), *args], root)


def source_identity(root, expected_sha):
    root = root.resolve(strict=True)
    require(bool(re.fullmatch(r'[a-f0-9]{40}', expected_sha)), 'SOURCE_SHA_REQUIRED')
    require((root/'.git').exists(), 'GIT_CHECKOUT_REQUIRED')
    require(Path(git(root, 'rev-parse', '--show-toplevel')).resolve() == root,
            'SOURCE_ROOT_MISMATCH')
    require(git(root, 'rev-parse', 'HEAD') == expected_sha, 'SOURCE_SHA_MISMATCH')
    require(not git(root, 'status', '--porcelain', '--untracked-files=all'),
            'SOURCE_TREE_NOT_CLEAN')
    return git(root, 'rev-parse', 'HEAD^{tree}')


def validate_request(build_id, image, seconds):
    try:
        valid_id = str(uuid.UUID(build_id)) == build_id
    except (ValueError, AttributeError):
        valid_id = False
    require(valid_id, 'CLOUD_BUILD_ID_REQUIRED')
    require(bool(IMAGE_PATTERN.fullmatch(image)), 'PINNED_VERIFIER_IMAGE_REQUIRED')
    require(type(seconds) is int and 1 <= seconds <= MAX_SUITE_SECONDS,
            'SUITE_TIMEOUT_OUT_OF_BOUNDS')


def toolchain(root):
    require((root/'.node-version').read_text().strip() == NODE_VERSION,
            'NODE_CONTRACT_CHANGED')
    require(json.loads((root/'package.json').read_text())['packageManager'] == 'pnpm@'+PNPM_VERSION,
            'PNPM_CONTRACT_CHANGED')
    require(capture(['node', '--version'], root) == 'v'+NODE_VERSION, 'NODE_VERSION_MISMATCH')
    require(capture(['pnpm', '--version'], root) == PNPM_VERSION, 'PNPM_VERSION_MISMATCH')
    require(sys.platform == 'linux', 'LINUX_VERIFIER_REQUIRED')
    require(capture(['docker', 'info', '--format', '{{.OSType}}'], root) == 'linux',
            'LINUX_DOCKER_REQUIRED')
    capture(['docker', 'compose', 'version', '--short'], root)


def private_run_directory(root, build_id):
    parent = root/'.runtime'
    require(not parent.is_symlink(), 'UNSAFE_RUNTIME_DIRECTORY')
    parent.mkdir(mode=0o700, exist_ok=True)
    run = parent/('cloudbuild-'+build_id)
    require(not run.exists() and not run.is_symlink(), 'VERIFICATION_ATTEMPT_ALREADY_EXISTS')
    run.mkdir(mode=0o700)
    for name in ('tmp', 'local', 'playwright', 'pnpm-store'):
        (run/name).mkdir(mode=0o700)
    return run


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_shared_node(run, root):
    # The Linux capsule proof bind-mounts process.execPath into sibling Docker
    # containers. A path inside the verifier image is not a daemon-host path.
    original = Path(capture(['node', '-p', 'process.execPath'], root)).resolve(strict=True)
    require(original.is_file(), 'NODE_EXECUTABLE_REQUIRED')
    directory = run/'toolchain'
    directory.mkdir(mode=0o700)
    shared = directory/'node'
    with original.open('rb') as source, shared.open('xb') as destination:
        shutil.copyfileobj(source, destination, 1024*1024)
    shared.chmod(0o555)
    digest = file_sha256(original)
    require(file_sha256(shared) == digest, 'SHARED_NODE_COPY_MISMATCH')
    require(capture([str(shared), '--version'], root) == 'v'+NODE_VERSION,
            'SHARED_NODE_VERSION_MISMATCH')
    return shared, digest


def test_environment(run, inherited):
    # Do not forward provider keys, DATABASE_URL, gcloud, or GitHub credentials.
    # This is configuration hygiene, NOT a security boundary against metadata or
    # Docker-daemon access. The build SA must have no production permissions.
    env = {k: inherited[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TERM') if k in inherited}
    env['PATH'] = str(run/'toolchain')+os.pathsep+env.get('PATH', os.defpath)
    # This is /root in the fresh verifier container, never a mounted builder or
    # workstation home. Custody fixtures require non-writable ancestors, which
    # Cloud Build's shared workspace volume does not promise.
    env.update(HOME='/root', TMPDIR='/tmp',
               CI='true', PYTHONDONTWRITEBYTECODE='1',
               npm_config_store_dir=str(run/'pnpm-store'),
               COMMERCE_CONFIG_DIR=str(run/'local'),
               PLAYWRIGHT_BROWSERS_PATH=str(run/'playwright'),
               RECOVERY_EVIDENCE_PATH=str(run/'recovery.json'))
    return env


def full_stages(root, run):
    """The existing ci.yml FULL sequence, with each command recorded separately."""
    node_contracts = sorted(str(p.relative_to(root)) for p in (root/'scripts/tests').glob('*.test.mjs'))
    require(bool(node_contracts), 'NODE_CONTRACT_TESTS_MISSING')
    portal = root/'portals/mi-ciclo-listo'
    specs = [
        ('diff', ['git', '-c', 'safe.directory='+str(root), 'diff', '--check'], root, {}),
        ('python-ci', ['python3', '-m', 'unittest', 'discover', '-s', 'tests/ci', '-p', 'test_*.py'], root, {}),
        ('install', ['pnpm', 'install', '--frozen-lockfile'], root, {}),
        ('node-contracts', ['node', '--test', *node_contracts], root, {}),
        ('portal-capsule', ['node', '--disable-warning=ExperimentalWarning', '--test', 'tests/ci/test_b02_portal_capsule.mjs'], root, {}),
        ('local-setup', ['pnpm', 'local:setup'], root, {}),
        ('portal-capsule-linux', ['node', '--disable-warning=ExperimentalWarning', '--test', 'tests/ci/test_b02_portal_capsule_linux.mjs'], root, {'TMPDIR': str(run/'tmp')}),
        ('migrate', ['pnpm', 'db:migrate'], root, {}),
        ('bootstrap', ['pnpm', 'bootstrap'], root, {}),
        ('portal-install', ['npm', 'ci'], portal, {}),
        ('portal-verify', ['npm', 'run', 'verify'], portal, {}),
        ('typecheck', ['pnpm', 'typecheck'], root, {}),
        ('lint', ['pnpm', 'lint'], root, {}),
        ('build', ['pnpm', 'build'], root, {}),
        ('unit', ['pnpm', 'test'], root, {}),
        ('integration', ['pnpm', 'test:integration'], root, {}),
        ('recovery', ['pnpm', 'test:recovery'], root, {}),
        ('playwright-install', ['pnpm', 'exec', 'playwright', 'install', '--with-deps', 'chromium'], root, {}),
        ('campaign-review', ['node', 'scripts/setup-campaign-review.mjs', str(run/'campaign-review')], root, {}),
        ('e2e', ['pnpm', 'test:e2e'], root, {'COMMERCE_CONFIG_DIR': str(run/'campaign-review')}),
        ('audit', ['pnpm', 'audit', '--audit-level', 'high'], root, {}),
    ]
    return [{'id': name, 'argv': argv, 'cwd': cwd, 'env': env} for name, argv, cwd, env in specs]


def stop_group(process):
    # A timed-out parent can leave descendants. Kill its whole process group,
    # including when the parent has already exited; never retry a test blindly.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=5)


def execute(argv, cwd, env, seconds):
    # Individual fixtures retain their normal 022 mask; the driver keeps 077.
    # Each required stage emits at most 4MiB stdout + 1MiB stderr. Exceeding
    # either ceiling kills only its own process group and fails that stage.
    return execute_with_log_limits(argv, cwd, env, seconds, umask=0o022)


def save_receipt(path, document):
    temporary = path.with_suffix('.tmp')
    with temporary.open('x') as stream:
        json.dump(document, stream, indent=2, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def verify(root, expected_sha, build_id, image, seconds=MAX_SUITE_SECONDS, *, executor=execute):
    validate_request(build_id, image, seconds)
    root = root.resolve(strict=True)
    tree = source_identity(root, expected_sha)
    toolchain(root)
    run = private_run_directory(root, build_id)
    shared_node, shared_node_sha256 = prepare_shared_node(run, root)
    stages = full_stages(root, run)
    env = test_environment(run, os.environ)
    receipt = {
        'schema_version': 1, 'provider': 'google-cloud-build', 'build_id': build_id,
        'gate_name': GATE_NAME, 'scope': 'full', 'source_sha': expected_sha,
        'source_tree': tree, 'verifier_image': image,
        'shared_node_sha256': shared_node_sha256,
        'runner_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'workflow_sha256': hashlib.sha256((root/'.github/workflows/ci.yml').read_bytes()).hexdigest(),
        'maximum_suite_seconds': seconds, 'started_at': utc(), 'status': 'RUNNING',
        'deployment_proven': False, 'github_check_published': False,
        'stages': [{'id': s['id'], 'status': 'NOT_RUN'} for s in stages],
    }
    path = run/'verification.json'
    save_receipt(path, receipt)
    deadline = time.monotonic()+seconds
    current = None
    try:
        for stage, entry in zip(stages, receipt['stages']):
            current = entry
            remaining = deadline-time.monotonic()
            require(remaining > 0, 'SUITE_DEADLINE_EXCEEDED')
            entry.update(status='RUNNING', started_at=utc())
            save_receipt(path, receipt)
            print(json.dumps({'gate': GATE_NAME, 'stage': stage['id'], 'status': 'RUNNING'}), flush=True)
            code = executor(stage['argv'], stage['cwd'], {**env, **stage['env']}, remaining)
            entry.update(exit_code=code, finished_at=utc(), status='PASSED' if code == 0 else 'FAILED')
            save_receipt(path, receipt)
            require(code == 0, 'REQUIRED_STAGE_FAILED')
        require(time.monotonic() <= deadline, 'SUITE_DEADLINE_EXCEEDED')
        require(source_identity(root, expected_sha) == tree, 'SOURCE_TREE_CHANGED_DURING_TESTS')
        require(file_sha256(shared_node) == shared_node_sha256, 'SHARED_NODE_CHANGED_DURING_TESTS')
        require(all(s['status'] == 'PASSED' for s in receipt['stages']), 'INCOMPLETE_FULL_VERIFICATION')
        receipt['status'] = 'PASSED'
    except BaseException as error:
        if isinstance(error, subprocess.TimeoutExpired):
            status, reason = 'TIMED_OUT', 'REQUIRED_STAGE_TIMED_OUT'
        elif isinstance(error, KeyboardInterrupt):
            status, reason = 'CANCELLED', 'VERIFICATION_INTERRUPTED'
        else:
            status = 'FAILED'
            reason = str(error) if isinstance(error, (VerificationError, LogLimitExceeded)) else type(error).__name__
        if current is not None and current['status'] == 'RUNNING':
            current.update(status=status, finished_at=utc())
        receipt.update(status=status, failure_code=reason)
    finally:
        receipt['finished_at'] = utc()
        save_receipt(path, receipt)
        # The complete safe receipt survives in Cloud Logging even after the
        # ephemeral workspace disappears. It contains no test fixture secrets.
        print(json.dumps(receipt, sort_keys=True), flush=True)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path.cwd())
    parser.add_argument('--expected-sha', required=True)
    parser.add_argument('--build-id', required=True)
    parser.add_argument('--verifier-image', required=True)
    parser.add_argument('--timeout-seconds', type=int, default=MAX_SUITE_SECONDS)
    args = parser.parse_args()
    os.umask(0o077)
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        result = verify(args.source, args.expected_sha, args.build_id,
                        args.verifier_image, args.timeout_seconds)
    except (VerificationError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        code = str(error) if isinstance(error, VerificationError) else type(error).__name__
        print(json.dumps({'gate_name': GATE_NAME, 'status': 'FAILED', 'failure_code': code}), flush=True)
        return 1
    return 0 if result['status'] == 'PASSED' else 1


if __name__ == '__main__':
    sys.exit(main())
