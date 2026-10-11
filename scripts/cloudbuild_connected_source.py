"""Trusted public-repository reader using its exact Cloud Build connection.

Only the fixed trusted controller, attestor and publisher may receive the
repository-scoped accessReadToken permission. Verify/package receive no token.
Credentials remain in memory and never enter candidate archives or receipts.
This reader cannot create a connection/repository/build, push Git, or mutate IAM.
Its fixed public profile cannot read or admit the private bootstrap repository.
"""
from datetime import datetime, timedelta, timezone
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.request

from cloudbuild_full_evidence import EvidenceError, PROJECT, REPOSITORY, need
from cloudbuild_native_reader import decode, MAX_RESPONSE, NoRedirect
from cloudbuild_source_limits import AcquisitionBudget, BudgetReader, CURRENT, LimitedWriter, run_git

REPOSITORY_ID = 1414365450
INSTALLATION_ID = '170087481'
CONNECTION = ('projects/' + PROJECT + '/locations/us-east1/connections/commerce-v7-github-core')
CONNECTED_REPOSITORY = CONNECTION + '/repositories/commerce-os-core'
REMOTE = 'https://github.com/' + REPOSITORY + '.git'
GOOGLE_ROOT = 'https://cloudbuild.googleapis.com/v2/'
GITHUB_ROOT = 'https://api.github.com/repos/' + REPOSITORY
SANITIZED_CONFIG = ('[core]\nrepositoryformatversion = 0\nfilemode = true\nbare = false\n'
                    'logallrefupdates = false\nhooksPath = /dev/null\n')
MAX_ARCHIVE = 200 * 1024 * 1024
MAX_TREE = 256 * 1024 * 1024
MAX_TRACKED_BYTES = 128 * 1024 * 1024
MAX_ENTRIES = 10000


def clock():
    return datetime.now(timezone.utc)


def sha(value, code):
    need(type(value) is str and re.fullmatch('[a-f0-9]{40}', value), code)
    return value


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        need(parsed.tzinfo is not None and parsed.utcoffset() == timedelta(0), 'SOURCE_TOKEN_EXPIRY_INVALID')
        return parsed
    except (ValueError, TypeError, AttributeError):
        raise EvidenceError('SOURCE_TOKEN_EXPIRY_INVALID') from None


def validate_approval(value, *, now=None):
    need(type(value) is dict and set(value) == {
        'repository_id', 'repository', 'source_sha', 'source_tree', 'runner_sha256',
        'workflow_sha256', 'expires_at', 'review_sha256'}, 'SOURCE_APPROVAL_FIELDS_INVALID')
    need(type(value['repository_id']) is int and value['repository_id'] == REPOSITORY_ID
         and value['repository'] == REPOSITORY, 'SOURCE_PUBLIC_PROFILE_REQUIRED')
    sha(value['source_sha'], 'SOURCE_SHA_REQUIRED'); sha(value['source_tree'], 'SOURCE_TREE_REQUIRED')
    for key in ('runner_sha256', 'workflow_sha256', 'review_sha256'):
        need(type(value[key]) is str and re.fullmatch('[a-f0-9]{64}', value[key]), 'SOURCE_APPROVAL_DIGEST_INVALID')
    need((now or clock()) < timestamp(value['expires_at']), 'SOURCE_APPROVAL_EXPIRED')


class ConnectedSourceReader:
    """Fixed-endpoint reads with separate Google and GitHub bearer scopes.

    The caller authenticates its protected SourceApproval before invoking this
    reader. A matching digest is not proof of review. No token refresh/retry is
    implicit: an expired/uncertain credential closes the current operation.
    """
    def __init__(self, google_token_provider, *, opener=None, now=clock):
        self.google_token_provider = google_token_provider
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.now = now
        self._read_token = None
        self._expires = None

    def _request(self, method, url, token, *, body=None):
        allowed = {GOOGLE_ROOT + CONNECTION, GOOGLE_ROOT + CONNECTED_REPOSITORY,
                   GOOGLE_ROOT + CONNECTED_REPOSITORY + ':accessReadToken', GITHUB_ROOT}
        valid_commit = re.fullmatch(re.escape(GITHUB_ROOT) + r'/git/commits/[a-f0-9]{40}', url or '')
        valid_tree = re.fullmatch(re.escape(GITHUB_ROOT) + r'/git/trees/[a-f0-9]{40}\?recursive=1', url or '')
        need(url in allowed or valid_commit or valid_tree, 'SOURCE_ENDPOINT_REJECTED')
        expected_method = 'POST' if url.endswith(':accessReadToken') else 'GET'
        need(method == expected_method and ((method == 'POST' and body == b'{}') or
             (method == 'GET' and body is None)), 'SOURCE_METHOD_REJECTED')
        need(type(token) is str and token and not any(c.isspace() for c in token), 'SOURCE_TOKEN_UNAVAILABLE')
        headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json'}
        if url.startswith(GITHUB_ROOT):
            headers.update({'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Commerce-OS-source-controller'})
        if body is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(url, method=method, data=body, headers=headers)
        try:
            with self.opener.open(request, timeout=30) as response:
                need(response.status == 200, 'SOURCE_READ_UNCONFIRMED')
                raw = response.read(MAX_RESPONSE + 1)
        except urllib.error.HTTPError as error:
            error.close(); raise EvidenceError('SOURCE_READ_HTTP_ERROR') from None
        except (OSError, ValueError):
            raise EvidenceError('SOURCE_READ_UNCERTAIN') from None
        return decode(raw)

    def connect(self):
        need(self._read_token is None, 'SOURCE_CREDENTIAL_ALREADY_ACQUIRED')
        try:
            google_token = self.google_token_provider()
        except Exception:
            raise EvidenceError('SOURCE_GOOGLE_TOKEN_UNAVAILABLE') from None
        connection = self._request('GET', GOOGLE_ROOT + CONNECTION, google_token)
        need(connection.get('name') == CONNECTION and not connection.get('disabled', False)
             and not connection.get('reconciling', False)
             and connection.get('installationState', {}).get('stage') == 'COMPLETE'
             and connection.get('githubConfig', {}).get('appInstallationId') == INSTALLATION_ID,
             'SOURCE_CONNECTION_NOT_READY')
        repository = self._request('GET', GOOGLE_ROOT + CONNECTED_REPOSITORY, google_token)
        need(repository.get('name') == CONNECTED_REPOSITORY and repository.get('remoteUri') == REMOTE,
             'SOURCE_CONNECTED_REPOSITORY_CHANGED')
        credential = self._request('POST', GOOGLE_ROOT + CONNECTED_REPOSITORY + ':accessReadToken',
                                   google_token, body=b'{}')
        need(set(credential) == {'token', 'expirationTime'}, 'SOURCE_CREDENTIAL_FIELDS_INVALID')
        token = credential['token']; expires = timestamp(credential['expirationTime'])
        need(type(token) is str and token and not any(c.isspace() for c in token)
             and self.now() + timedelta(minutes=10) <= expires <= self.now() + timedelta(hours=24),
             'SOURCE_CREDENTIAL_LIFETIME_INVALID')
        # Verify numeric GitHub identity/privacy, not only a recyclable name.
        observed = self._request('GET', GITHUB_ROOT, token)
        need(type(observed.get('id')) is int and observed['id'] == REPOSITORY_ID
             and observed.get('full_name') == REPOSITORY and observed.get('private') is False
             and observed.get('archived') is False and observed.get('disabled', False) is False,
             'SOURCE_GITHUB_REPOSITORY_CHANGED')
        self._read_token = token; self._expires = expires

    def credential(self, *, remaining_seconds=300):
        need(self._read_token is not None and self.now() + timedelta(seconds=remaining_seconds) < self._expires,
             'SOURCE_CREDENTIAL_EXPIRED')
        return self._read_token

    def commit(self, repository, commit_sha):
        need(repository == REPOSITORY, 'SOURCE_PUBLIC_PROFILE_REQUIRED'); sha(commit_sha, 'SOURCE_SHA_REQUIRED')
        value = self._request('GET', GITHUB_ROOT + '/git/commits/' + commit_sha, self.credential())
        need(value.get('sha') == commit_sha and type(value.get('tree')) is dict,
             'SOURCE_COMMIT_IDENTITY_CHANGED')
        sha(value['tree'].get('sha'), 'SOURCE_TREE_REQUIRED')
        return value

    def tree(self, tree_sha):
        sha(tree_sha, 'SOURCE_TREE_REQUIRED')
        return self._request('GET', GITHUB_ROOT + '/git/trees/' + tree_sha + '?recursive=1', self.credential())


def preflight_tree(value, tree_sha):
    need(type(value) is dict and value.get('sha') == tree_sha and value.get('truncated') is False
         and type(value.get('tree')) is list and 0 < len(value['tree']) <= MAX_ENTRIES,
         'SOURCE_PREFLIGHT_TREE_INCOMPLETE')
    names = set(); blobs = {}; total = 0
    for entry in value['tree']:
        need(type(entry) is dict, 'SOURCE_PREFLIGHT_ENTRY_INVALID')
        path = entry.get('path')
        need(type(path) is str and path and not path.startswith('/') and '\\' not in path
             and not any(ord(c) < 32 or ord(c) == 127 for c in path)
             and all(part not in ('', '.', '..', '.git') for part in path.split('/'))
             and path not in names, 'SOURCE_PREFLIGHT_PATH_INVALID')
        names.add(path); sha(entry.get('sha'), 'SOURCE_PREFLIGHT_OBJECT_INVALID')
        if entry.get('type') == 'tree':
            need(entry.get('mode') == '040000', 'SOURCE_PREFLIGHT_MODE_INVALID')
            continue
        need(entry.get('type') == 'blob' and entry.get('mode') in {'100644', '100755'},
             'SOURCE_NON_REGULAR_TRACKED_ENTRY')
        size = entry.get('size')
        need(type(size) is int and size >= 0, 'SOURCE_PREFLIGHT_SIZE_INVALID')
        total += size
        need(total <= MAX_TRACKED_BYTES, 'SOURCE_TRACKED_SIZE_REQUIRES_ADMISSION')
        blobs[path] = {'mode': entry['mode'], 'sha': entry['sha'], 'size': size}
    need(blobs, 'SOURCE_PREFLIGHT_NO_BLOBS')
    return blobs, {'tracked_files': len(blobs), 'tracked_bytes': total,
                   'tree_response_sha256': hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}


def verify_fetched_tree(raw, expected):
    observed = {}
    for entry in raw.split('\0'):
        if not entry: continue
        try:
            fields, path = entry.split('\t', 1)
            mode, kind, object_sha, size = fields.split()
        except ValueError:
            raise EvidenceError('SOURCE_FETCHED_TREE_INVALID') from None
        need(kind == 'blob' and mode in {'100644', '100755'} and size.isdecimal()
             and path not in observed, 'SOURCE_FETCHED_TREE_INVALID')
        observed[path] = {'mode': mode, 'sha': object_sha, 'size': int(size)}
    need(observed == expected, 'SOURCE_FETCHED_TREE_DIFFERS_FROM_PREFLIGHT')


def private_directory(path):
    root = Path(path)
    need(root.is_absolute() and root.resolve() == root, 'SOURCE_DIRECTORY_UNSAFE')
    value = root.lstat()
    need(stat.S_ISDIR(value.st_mode) and value.st_uid == os.getuid()
         and stat.S_IMODE(value.st_mode) == 0o700, 'SOURCE_PRIVATE_DIRECTORY_REQUIRED')
    return root


def git(root, *args, credential=None):
    # Do not inherit user configs, hooks, credential helpers, proxies or Git
    # environment injection. Authentication lives only in child process memory.
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8',
                   'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null',
                   'GIT_CONFIG_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0', 'GIT_ATTR_NOSYSTEM': '1'}
    command = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=',
               '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true',
               '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
               '-c', 'submodule.recurse=false', '-c', 'pack.threads=1']
    if credential is not None:
        need(args and args[0] == 'fetch', 'SOURCE_CREDENTIAL_OPERATION_REJECTED')
        environment['COMMERCE_SOURCE_AUTH_HEADER'] = 'Authorization: Basic ' + base64.b64encode(
            ('x-access-token:' + credential).encode()).decode()
        command += ['--config-env=http.https://github.com/.extraHeader=COMMERCE_SOURCE_AUTH_HEADER']
    try:
        result = run_git([*command, *args], cwd=root, environment=environment)
    except (OSError, subprocess.TimeoutExpired):
        raise EvidenceError('SOURCE_GIT_UNCERTAIN') from None
    need(result.returncode == 0, 'SOURCE_GIT_FAILED')
    need(len(result.stdout) <= MAX_RESPONSE, 'SOURCE_GIT_OUTPUT_TOO_LARGE')
    return result.stdout.decode().strip()


def verify_archive(archive, approval, parent):
    # Read back the actual packaged bytes with the same self-contained Git
    # checks as the bootstrap. Never accept a receipt about an unverified TAR.
    with tempfile.TemporaryDirectory(prefix='source-readback-', dir=parent) as folder:
        extracted = Path(folder)
        with archive.open('rb') as stream, tarfile.open(fileobj=BudgetReader(stream), mode='r:gz') as bundle:
            members = bundle.getmembers(); names = set(); total = 0
            for member in members:
                relative = Path(member.name)
                need(not relative.is_absolute() and '..' not in relative.parts
                     and (member.isfile() or member.isdir()) and str(relative) not in names,
                     'SOURCE_ARCHIVE_MEMBER_UNSAFE')
                names.add(str(relative)); total += member.size
                need(total <= MAX_TREE, 'SOURCE_ARCHIVE_EXPANSION_TOO_LARGE')
            bundle.extractall(extracted, filter='data')
        need((extracted / '.git/config').read_text() == SANITIZED_CONFIG
             and (extracted / '.git/shallow').read_text().strip() == approval['source_sha'],
             'SOURCE_ARCHIVE_GIT_CUSTODY_CHANGED')
        for name in ('objects/info/alternates', 'commondir', 'gitdir', 'hooks', 'logs', 'FETCH_HEAD'):
            need(not os.path.lexists(extracted / '.git' / name), 'SOURCE_ARCHIVE_GIT_METADATA_UNSAFE')
        need(git(extracted, 'rev-parse', 'HEAD') == approval['source_sha']
             and git(extracted, 'rev-parse', 'HEAD^{tree}') == approval['source_tree']
             and not git(extracted, 'status', '--porcelain', '--untracked-files=all'),
             'SOURCE_ARCHIVE_CHECKOUT_DRIFT')
        git(extracted, 'fsck', '--full', '--strict')
        for relative, key in [('scripts/cloudbuild-verify.py', 'runner_sha256'), ('.github/workflows/ci.yml', 'workflow_sha256')]:
            need(hashlib.sha256((extracted / relative).read_bytes()).hexdigest() == approval[key],
                 'SOURCE_ARCHIVE_RUNNER_OR_WORKFLOW_CHANGED')


def prepare_archive(destination, approval, reader):
    """Build reviewed source with authentic, sanitized, shallow Git metadata.

    destination is a caller-owned empty 0700 directory on ephemeral controller
    storage. It is preserved on failure for reconciliation; no cleanup of other
    paths. No checkout script, npm lifecycle, hook, build or test is executed.
    The caller uploads the returned archive with GCS generation=0, then binds
    the native generation to the existing admission ledger before CreateBuild.
    """
    validate_approval(approval); root = private_directory(destination)
    need(not any(root.iterdir()), 'SOURCE_DESTINATION_NOT_EMPTY')
    budget = AcquisitionBudget(root); context = CURRENT.set(budget)
    try:
        result = _prepare_archive(root, approval, reader)
        result['acquisition_resources'] = budget.receipt()
        return result
    finally:
        CURRENT.reset(context)


def _prepare_archive(root, approval, reader):
    commit = reader.commit(REPOSITORY, approval['source_sha'])
    need(commit['tree']['sha'] == approval['source_tree'], 'SOURCE_APPROVED_TREE_CHANGED')
    expected, preflight = preflight_tree(reader.tree(approval['source_tree']), approval['source_tree'])
    CURRENT.get().check()
    source = root / 'source'; source.mkdir(mode=0o700)
    git(source, 'init', '--quiet')
    git(source, 'fetch', '--quiet', '--no-tags', '--depth=1', '--no-recurse-submodules',
        REMOTE, approval['source_sha'], credential=reader.credential())
    # Reject submodules, links/devices and unexpected modes before checkout.
    verify_fetched_tree(git(source, 'ls-tree', '-rlz', '--full-tree', approval['source_sha']), expected)
    git(source, 'checkout', '--quiet', '--detach', approval['source_sha'])
    for name in ('hooks', 'logs', 'info', 'description', 'FETCH_HEAD'):
        path = source / '.git' / name
        if path.is_dir(): shutil.rmtree(path)
        elif path.exists(): path.unlink()
    (source / '.git/config').write_text(SANITIZED_CONFIG)
    need((source / '.git/shallow').read_text().strip() == approval['source_sha'], 'SOURCE_SHALLOW_IDENTITY_CHANGED')
    for name in ('objects/info/alternates', 'commondir', 'gitdir', 'hooks', 'logs', 'FETCH_HEAD'):
        need(not os.path.lexists(source / '.git' / name), 'SOURCE_GIT_METADATA_UNSAFE')
    need(git(source, 'rev-parse', 'HEAD') == approval['source_sha']
         and git(source, 'rev-parse', 'HEAD^{tree}') == approval['source_tree']
         and not git(source, 'status', '--porcelain', '--untracked-files=all'), 'SOURCE_CHECKOUT_DRIFT')
    git(source, 'fsck', '--full', '--strict')
    for relative, key in [('scripts/cloudbuild-verify.py', 'runner_sha256'), ('.github/workflows/ci.yml', 'workflow_sha256')]:
        need(hashlib.sha256((source / relative).read_bytes()).hexdigest() == approval[key], 'SOURCE_RUNNER_OR_WORKFLOW_CHANGED')
    total = 0
    for path in source.rglob('*'):
        value = path.lstat()
        need(stat.S_ISDIR(value.st_mode) or (stat.S_ISREG(value.st_mode) and value.st_nlink == 1),
             'SOURCE_SPECIAL_OR_LINKED_FILE')
        if stat.S_ISREG(value.st_mode): total += value.st_size
        need(total <= MAX_TREE, 'SOURCE_TREE_SIZE_REQUIRES_ADMISSION')
    archive = root / 'source.tgz'
    descriptor = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        with tarfile.open(fileobj=LimitedWriter(output, MAX_ARCHIVE), mode='w:gz', compresslevel=6) as bundle:
            bundle.add(source, arcname='.', recursive=True)
        output.flush(); os.fsync(output.fileno())
    need(archive.stat().st_size <= MAX_ARCHIVE, 'SOURCE_ARCHIVE_SIZE_REQUIRES_ADMISSION')
    verify_archive(archive, approval, root)
    validate_approval(approval)
    need(not git(source, 'status', '--porcelain', '--untracked-files=all'), 'SOURCE_CHANGED_AFTER_ARCHIVE')
    archive_hash = hashlib.sha256()
    with archive.open('rb') as stream:
        while data := stream.read(1024 * 1024):
            CURRENT.get().check(); archive_hash.update(data)
    archive_sha = archive_hash.hexdigest()
    return {'source_sha': approval['source_sha'], 'source_tree': approval['source_tree'],
            'archive_path': str(archive), 'archive_bytes': archive.stat().st_size,
            'archive_sha256': archive_sha, 'runner_sha256': approval['runner_sha256'],
            'workflow_sha256': approval['workflow_sha256'], 'repository_id': REPOSITORY_ID,
            'git_config_sanitized': True, 'self_contained_shallow_git': True,
            'archive_extracted_and_fsck_verified': True, 'preflight': preflight}
