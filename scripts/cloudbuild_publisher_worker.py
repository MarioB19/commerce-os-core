"""Image-owned publisher wiring; candidate checkout supplies authenticated bytes only.

No candidate module, environment variable, URL or HTTP payload chooses code.
INSTALL performs one canonical installation and publication. RECONCILE never
copies/starts Root or posts to GitHub; incomplete historical effects stay blocked.
The native Build's 900 seconds include preparation, download, IAP and key cleanup.
"""
from copy import deepcopy
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
import hashlib
import os
from pathlib import Path
import re
import signal
import stat
import time
import urllib.request

import cloudbuild_admission as ledger
import cloudbuild_attestation as gate
from cloudbuild_connected_source import ConnectedSourceReader, REPOSITORY_ID, SANITIZED_CONFIG, git, MAX_TREE
from cloudbuild_controller import GoogleBuildAPI
from cloudbuild_project_inventory import InventoryRequestPacer, PacedCloudBuildReads
from cloudbuild_effect_journal import DurableEffectJournal, validate_journal
from cloudbuild_full_evidence import PROJECT, need
from cloudbuild_gcs_store import GCSAdmissionStore, SingleRequestTransport
from cloudbuild_github_reader import GitHubControlReader
from cloudbuild_native_install import NativeInstall, SECONDS, CLEANUP_SECONDS
from cloudbuild_native_package import GooglePackageReader, MAX_ARCHIVE
from cloudbuild_native_publisher import NativePublisher, GitHubDeploymentAPI
from cloudbuild_native_reader import GoogleFullReader, NoRedirect
from cloudbuild_protected_storage import ProtectedStorage, validate_descriptor
from cloudbuild_publisher_contract import validate_contract, validate_native, template, create_request
from cloudbuild_publisher_readers import PublisherIdentity, PublisherControls, NativeRootReadback, https_read
from cloudbuild_runtime import ExistingStore, location, read_installed_document, PROJECT_NUMBER
from ci_provider_evidence import cloud_installation_id, installation_enabled
from ci_release import digest
from cloudbuild_github_app_credential import GitHubAppCredential as PublisherCredential, validate_config as validate_github_app, acquire_once
from cloudbuild_boot_admission import validate_config as validate_boot_config, collect_boot_inputs, BOOT_TRANSFER_RESERVATION
import cloudbuild_release_evidence as release

BASE = Path('/var/lib/commerce-publisher')
SOURCE = Path('/workspace')
ENTRYPOINT = Path('/opt/trusted/cloudbuild-publish.py')
MAX_COPY_ENTRIES = 30000
MAX_TRANSFER = 6 * 1024**3


def validate_config(value):
    ledger.exact(value, 'schema_version role project project_number repository_id ledger control custody adoption host_boot github_app',
                 'PUBLISHER_CONFIG_FIELDS_INVALID')
    need(type(value['schema_version']) is int and value['schema_version'] == 1
         and value['role'] == 'publisher' and value['project'] == PROJECT
         and value['project_number'] == PROJECT_NUMBER and value['repository_id'] == REPOSITORY_ID,
         'PUBLISHER_CONFIG_IDENTITY_INVALID')
    for name in ('ledger', 'control'): location(value[name])
    need((value['ledger']['bucket'], value['ledger']['object']) !=
         (value['control']['bucket'], value['control']['object']), 'PUBLISHER_STORES_MUST_DIFFER')
    ledger.exact(value['custody'], 'bucket prefix', 'PUBLISHER_CUSTODY_FIELDS_INVALID')
    ProtectedStorage(None, **value['custody'])
    ledger.exact(value['adoption'], 'month minimum_confirmed_seconds evidence_sha256', 'PUBLISHER_ADOPTION_REQUIRED')
    need(value['adoption']['month'] == '2026-10' and
         type(value['adoption']['minimum_confirmed_seconds']) is int and
         value['adoption']['minimum_confirmed_seconds'] == 4440, 'PUBLISHER_HISTORY_MUST_BE_PRESERVED')
    ledger.digest(value['adoption']['evidence_sha256'])
    validate_boot_config(value['host_boot'])
    need(value['host_boot']['restore_bundle']['bucket'] == value['custody']['bucket'] and
         value['host_boot']['restore_bundle']['object'].startswith(value['custody']['prefix'] + '/'),
         'PUBLISHER_BOOT_HISTORY_CUSTODY_CHANGED')
    validate_github_app(value['github_app'])
    return deepcopy(value)


def validate_task(task, build_id, moment, *, preparing=False):
    ledger.exact(task, 'schema_version operation phase body_ref contract plan approval admission expires_at', 'PUBLISHER_TASK_FIELDS_INVALID')
    need(type(task['schema_version']) is int and task['schema_version'] == 1 and
         task['operation'] in ({'PUBLISH', 'PUBLISH_PREPARED'} if preparing else {'PUBLISH'})
         and task['phase'] in {'INSTALL', 'RECONCILE'} and moment < ledger.timestamp(task['expires_at']),
         'PUBLISHER_TASK_INVALID_OR_EXPIRED')
    validate_descriptor(task['body_ref']); validate_contract(task['contract'])
    need((task['operation'] == 'PUBLISH_PREPARED' or task['contract']['build_id'] == build_id)
         and task['contract']['task_sha256'] == task['body_ref']['sha256'],
         'PUBLISHER_TASK_NATIVE_BINDING_CHANGED')
    ledger.validate_plan(task['plan']); ledger.validate_approval(task['approval'], task['plan'], moment)
    ledger.validate_admission(task['admission'], moment, task['approval'])
    need(task['plan']['config_sha256'] == ledger.canonical_hash(template(task['contract'])),
         'PUBLISHER_PLAN_NATIVE_TEMPLATE_CHANGED')


def validate_body(body, task, moment):
    fields = 'schema_version attempt_id release_admission full_attempt_id package_attempt_id gate_attempt_id gate_contract installation_attempt journal client_sha256 collector_sha256 transfer_limit_bytes expires_at'
    if task['phase'] == 'RECONCILE': fields += ' origin_task_ref'
    ledger.exact(body, fields,
                 'PUBLISHER_BODY_FIELDS_INVALID')
    if task['phase'] == 'RECONCILE': validate_descriptor(body['origin_task_ref'])
    contract = task['contract']
    need(type(body['schema_version']) is int and body['schema_version'] == 1 and
         body['attempt_id'] == contract['attempt_id'] and moment < ledger.timestamp(body['expires_at']),
         'PUBLISHER_BODY_EXPIRED_OR_CHANGED')
    for key in ('attempt_id', 'full_attempt_id', 'package_attempt_id', 'gate_attempt_id'): ledger.native_uuid(body[key])
    ledger.validate_plan(task['plan']); ledger.validate_approval(task['approval'], task['plan'], moment)
    ledger.validate_admission(task['admission'], moment, task['approval'])
    ctx = release.validate_admission(body['release_admission']); installation_enabled(ctx)
    need(ctx['package_origin'] == 'cloud-build' and task['plan']['stage'] == 'publisher'
         and task['plan']['timeout_seconds'] == SECONDS and
         all(ctx[key] == contract[key] == task['plan']['identity'][key] for key in ('source_sha', 'source_tree'))
         and task['plan']['identity']['repository_id'] == REPOSITORY_ID
         and task['plan']['verifier_sha256'] == contract['image'].rsplit(':', 1)[1]
         and task['plan']['runner_sha256'] == contract['driver_sha256'],
         'PUBLISHER_RELEASE_PLAN_CHANGED')
    need(type(body['installation_attempt']) is str and re.fullmatch('[1-9][0-9]{0,5}', body['installation_attempt']),
         'PUBLISHER_INSTALLATION_ATTEMPT_INVALID')
    location(body['journal'])
    for key in ('client_sha256', 'collector_sha256'): ledger.digest(body[key])
    need(type(body['transfer_limit_bytes']) is int and 0 < body['transfer_limit_bytes'] <= MAX_TRANSFER,
         'PUBLISHER_TRANSFER_ADMISSION_REQUIRED')
    gate.validate_contract(body['gate_contract'])
    need(body['gate_contract']['source_sha'] == ctx['source_sha'] and
         body['gate_contract']['source_tree'] == ctx['source_tree'], 'PUBLISHER_GATE_SOURCE_CHANGED')
    return ctx


def source_inventory(source):
    source = Path(source)
    need(source.is_absolute() and source.resolve() == source and source.is_dir(), 'PUBLISHER_SOURCE_DIRECTORY_INVALID')
    rows = []; total = 0
    for path in sorted(source.rglob('*')):
        info = path.lstat()
        need(stat.S_ISDIR(info.st_mode) or (stat.S_ISREG(info.st_mode) and info.st_nlink == 1),
             'PUBLISHER_SOURCE_LINK_OR_SPECIAL')
        need(len(rows) < MAX_COPY_ENTRIES, 'PUBLISHER_SOURCE_ENTRY_BOUND')
        if stat.S_ISREG(info.st_mode): total += info.st_size
        need(total <= MAX_TREE, 'PUBLISHER_SOURCE_SIZE_BOUND')
        rows.append((path.relative_to(source), info))
    need((source / '.git/config').read_text() == SANITIZED_CONFIG, 'PUBLISHER_GIT_CONFIG_UNSAFE')
    for name in ('objects/info/alternates', 'commondir', 'gitdir', 'hooks', 'logs', 'FETCH_HEAD'):
        need(not os.path.lexists(source / '.git' / name), 'PUBLISHER_GIT_METADATA_UNSAFE')
    return rows, total


def source_identity(source, ctx):
    need(git(source, 'rev-parse', 'HEAD') == ctx['source_sha'] and
         git(source, 'rev-parse', 'HEAD^{tree}') == ctx['source_tree'] and
         not git(source, 'status', '--porcelain', '--untracked-files=all'), 'PUBLISHER_SOURCE_NOT_EXACT')
    git(source, 'fsck', '--full', '--strict')


def copy_source(source, destination, ctx, reserve, check):
    source_inventory(source); source_identity(source, ctx)
    # A legitimate Git status can refresh index metadata. Pin the copy only
    # after that authenticated read; source bytes are checked again afterwards.
    rows, total = source_inventory(source)
    need(destination.is_dir() and not any(destination.iterdir()), 'PUBLISHER_SOURCE_DESTINATION_NOT_EMPTY')
    reserve(total)
    fingerprint = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink, s.st_mode)
    for name, before in rows:
        check(); src = source / name; dst = destination / name
        need(fingerprint(src.lstat()) == fingerprint(before), 'PUBLISHER_SOURCE_CHANGED')
        if stat.S_ISDIR(before.st_mode): dst.mkdir(mode=0o700)
        else:
            fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as inp, dst.open('xb') as out:
                need(fingerprint(os.fstat(inp.fileno())) == fingerprint(before), 'PUBLISHER_SOURCE_CHANGED')
                count = 0
                while chunk := inp.read(min(1024**2, before.st_size - count + 1)):
                    check(); count += len(chunk); need(count <= before.st_size, 'PUBLISHER_SOURCE_GREW'); out.write(chunk)
                need(count == before.st_size and fingerprint(os.fstat(inp.fileno())) == fingerprint(before)
                     == fingerprint(src.lstat()), 'PUBLISHER_SOURCE_CHANGED')
            dst.chmod(0o700 if before.st_mode & 0o111 else 0o600)
    source_identity(destination, ctx)
    return total


def private_run(build_id):
    ledger.native_uuid(build_id)
    for path in (BASE, *BASE.parents):
        info = path.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
             'PUBLISHER_PRIVATE_PARENT_UNSAFE')
    need(stat.S_IMODE(BASE.stat().st_mode) == 0o700, 'PUBLISHER_PRIVATE_BASE_REQUIRED')
    root = BASE / build_id; root.mkdir(mode=0o700)
    (root / 'source').mkdir(mode=0o700); (root / 'private').mkdir(mode=0o700)
    return root


class FencedJournal:
    def __init__(self, journal, fence): self.journal = journal; self.fence = fence
    def commit_intent(self, action, payload):
        result = self.journal.commit_intent(action, payload)
        if result.get('effect') == 'CREATE_ONCE': self.fence()
        return result
    def record_result(self, action, result): return self.journal.record_result(action, result)


class ReconcileGitHub:
    def __init__(self, github): self.github = github
    def request(self, method, path, body=None):
        need(method == 'GET', 'PUBLISHER_RECONCILE_MUST_NOT_POST')
        return self.github.request(method, path, body)


class HistoricalReadOnlyJournal:
    """A new reservation cannot create or amend an old attempt's effects."""
    def commit_intent(self, _action, _payload):
        raise RuntimeError('PUBLISHER_HISTORICAL_RECONCILE_MUST_NOT_CREATE_INTENT')
    def record_result(self, _action, _result):
        raise RuntimeError('PUBLISHER_HISTORICAL_RECONCILE_MUST_NOT_REWRITE_HISTORY')


@contextmanager
def binding_read_deadline():
    """Absolute read-only acquisition bound, preserving the global alarm."""
    previous = signal.getitimer(signal.ITIMER_REAL); handler = signal.getsignal(signal.SIGALRM)
    started = time.monotonic()
    def expired(_signal, _frame): raise RuntimeError('PUBLISHER_BINDING_WAIT_EXPIRED')
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, min(30, previous[0]) if previous[0] else 30)
    try: yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0); signal.signal(signal.SIGALRM, handler)
        if previous[0]:
            signal.setitimer(signal.ITIMER_REAL, max(.001, previous[0] - (time.monotonic() - started)), previous[1])


class PublisherWorker:
    def __init__(self, config, *, clock=time.monotonic, now=lambda: datetime.now(timezone.utc)):
        self.started = clock(); self.clock = clock; self.now = now; self.config = validate_config(config)
        self.identity = PublisherIdentity(); self.source_reader = ConnectedSourceReader(self.identity.token)
        self.github_reader = GitHubControlReader(self.source_reader)
        self.full = GoogleFullReader(self.identity.token, self.source_reader.commit)
        self.package = GooglePackageReader(self.identity.token, self.full); self.api = GoogleBuildAPI(self.identity.token)
        self.read_pacer = InventoryRequestPacer()
        for reader in (self.source_reader, self.full, self.package, self.api):
            reader.opener = PacedCloudBuildReads(reader.opener, self.read_pacer)
        self.custody = ProtectedStorage(self.identity.token, **config['custody'])
        transport = SingleRequestTransport(self.identity.token)
        transport.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.transport = transport
        self.ledger_store = self.store(config['ledger']); self.control_store = self.store(config['control'])
        self.task = self.body = self.control_binding = None; self.verified = None; self.controls = None
        self.origin_binding = None

    @classmethod
    def installed(cls): return cls(read_installed_document())

    def remaining(self, *, cleanup=False):
        value = self.started + SECONDS - (0 if cleanup else CLEANUP_SECONDS) - self.clock()
        need(value > 0, 'PUBLISHER_GLOBAL_DEADLINE_RECONCILE_ONLY'); return value

    def store(self, where):
        location(where)
        return ExistingStore(GCSAdmissionStore(where['bucket'], where['object'], self.transport), where['minimum_generation'])

    def await_binding(self, *, sleep=time.sleep):
        """Only the exact prepared-to-bound custody transition may be awaited.

        At most five observations within thirty seconds, counted inside 900s.
        No write token, journal mutation, source copy, package GET or Root call.
        UNKNOWN, pause, expiry and unrelated drift stop immediately.
        """
        expected = None; provisional_uuid = None; seen_bound = False; deadline = self.clock() + 30
        with binding_read_deadline():
            for observation in range(5):
                self.remaining(); need(self.clock() < deadline, 'PUBLISHER_BINDING_WAIT_EXPIRED')
                generation, control = self.control_store.load()
                ledger.exact(control, 'schema_version mode expires_at task', 'PUBLISHER_CONTROL_FIELDS_INVALID')
                need(type(control['schema_version']) is int and control['schema_version'] == 1
                     and control['mode'] == 'active' and self.now() < ledger.timestamp(control['expires_at']),
                     'PUBLISHER_CONTROL_PAUSED_OR_EXPIRED')
                validate_descriptor(control['task'])
                task = self.custody.read_json(control['task']); validate_task(task, self.build_id, self.now(), preparing=True)
                body = self.custody.read_json(task['body_ref']); validate_body(body, task, self.now())
                if task['operation'] == 'PUBLISH_PREPARED':
                    if provisional_uuid is None: provisional_uuid = task['contract']['build_id']
                    need(task['contract']['build_id'] == provisional_uuid, 'PUBLISHER_PREPARED_CUSTODY_CHANGED')
                contract = deepcopy(task['contract']); contract['build_id'] = self.build_id
                normalized = {**deepcopy(task), 'operation': 'PUBLISH', 'contract': contract}
                binding = {'task': normalized, 'body': body, 'control_expiry': control['expires_at']}
                need(expected is None or binding == expected, 'PUBLISHER_PREPARED_CUSTODY_CHANGED')
                expected = deepcopy(binding)
                _, doc = self.ledger_store.load(); ledger.validate_ledger(doc)
                need(ledger.budget_usage(doc, now=self.now()).get('2026-10', {}).get('confirmed_seconds', 0) >= 4440,
                     'PUBLISHER_HISTORY_NOT_ADOPTED')
                attempt = doc['attempts'].get(body['attempt_id'], {})
                need(doc['blocked'] is None and doc['active_attempt'] == body['attempt_id']
                     and attempt.get('state') in {'SUBMIT_INTENT', 'UUID_BOUND', 'RUNNING'}
                     and all(attempt.get(k) == task[k] for k in ('plan', 'approval', 'admission'))
                     and attempt.get('intent', {}).get('source') == {**contract['storage_source'], 'archive_sha256': contract['archive_sha256']}
                     and attempt['intent']['request_sha256'] == ledger.canonical_hash(create_request(contract)),
                     'PUBLISHER_PREPARED_RESERVATION_CHANGED')
                if attempt['state'] != 'SUBMIT_INTENT':
                    need(attempt.get('build_id') == self.build_id, 'PUBLISHER_PREPARED_NATIVE_UUID_CHANGED')
                    seen_bound = True
                else: need(not seen_bound, 'PUBLISHER_PREPARED_RESERVATION_REWOUND')
                need(validate_native(contract, self.api.build(self.build_id), PROJECT_NUMBER) == 'WORKING',
                     'PUBLISHER_NATIVE_BUILD_NOT_RUNNING')
                ledger.validate_approval(task['approval'], task['plan'], self.now())
                ledger.validate_admission(task['admission'], self.now(), task['approval'])
                need(self.now() < ledger.timestamp(control['expires_at']) and self.now() < ledger.timestamp(task['expires_at'])
                     and self.now() < ledger.timestamp(body['expires_at']) and self.clock() < deadline,
                     'PUBLISHER_BINDING_WAIT_EXPIRED')
                if task['operation'] == 'PUBLISH' and attempt['state'] in {'UUID_BOUND', 'RUNNING'}:
                    self.task = deepcopy(task); self.body = deepcopy(body)
                    self.control_binding = (generation, ledger.canonical_hash(control))
                    return
                if observation < 4: sleep(min(5, max(0, deadline - self.clock())))
        raise RuntimeError('PUBLISHER_BINDING_WAIT_EXPIRED')

    def current(self):
        self.remaining()
        generation, control = self.control_store.load()
        ledger.exact(control, 'schema_version mode expires_at task', 'PUBLISHER_CONTROL_FIELDS_INVALID')
        need(control['schema_version'] == 1 and control['mode'] == 'active'
             and self.now() < ledger.timestamp(control['expires_at']), 'PUBLISHER_CONTROL_PAUSED_OR_EXPIRED')
        validate_descriptor(control['task'])
        task = self.custody.read_json(control['task']); validate_task(task, self.build_id, self.now())
        body = self.custody.read_json(task['body_ref']); validate_body(body, task, self.now())
        binding = (generation, ledger.canonical_hash(control))
        if self.task is not None:
            need(binding == self.control_binding and task == self.task and body == self.body,
                 'PUBLISHER_CUSTODY_CHANGED')
        self.task = deepcopy(task); self.body = deepcopy(body); self.control_binding = binding
        return task, body

    def active(self):
        task, body = self.current(); _, doc = self.ledger_store.load(); ledger.validate_ledger(doc)
        need(ledger.budget_usage(doc, now=self.now()).get('2026-10', {}).get('confirmed_seconds', 0) >= 4440,
             'PUBLISHER_HISTORY_NOT_ADOPTED')
        attempt = doc['attempts'].get(body['attempt_id'], {})
        need(doc['blocked'] is None and doc['active_attempt'] == body['attempt_id']
             and attempt.get('state') in {'UUID_BOUND', 'RUNNING'} and attempt.get('build_id') == self.build_id
             and all(attempt.get(key) == task[key] for key in ('plan', 'approval', 'admission')),
             'PUBLISHER_ACTIVE_NATIVE_RESERVATION_REQUIRED')
        need(validate_native(task['contract'], self.api.build(self.build_id), PROJECT_NUMBER) == 'WORKING',
             'PUBLISHER_NATIVE_BUILD_NOT_RUNNING')
        return task, body, doc

    def admission(self):
        task, body, doc = self.active(); admitted = body['release_admission']; ctx = release.validate_admission(admitted)
        gate.full_reconciled(doc, body['full_attempt_id'], admitted['verification_manifest'], body['gate_contract'])
        for key, stage, build in (('package_attempt_id', 'package', ctx['package_build_id']),
                                  ('gate_attempt_id', 'attestation', body['gate_contract']['build_id'])):
            row = doc['attempts'].get(body[key], {})
            need(row.get('state') == 'RECONCILED' and row.get('plan', {}).get('stage') == stage
                 and row.get('build_id') == build and row.get('terminal', {}).get('status') == 'SUCCESS',
                 'PUBLISHER_RECONCILED_DEPENDENCY_REQUIRED')
        contract = body['gate_contract']
        need(gate.validate_native_gate(contract, self.api.build(contract['build_id']), PROJECT_NUMBER) == 'SUCCESS',
             'PUBLISHER_NATIVE_GATE_REQUIRED')
        gate.receipt_from_logs(self.api.attestation_logs(contract['build_id']), contract, admitted['verification_manifest'])
        self.github_reader.check(contract, PROJECT_NUMBER)
        event = {'kind': 'main', 'repository_id': REPOSITORY_ID, 'source_sha': ctx['source_sha'],
                 'source_tree': ctx['source_tree'], 'base_sha': ctx['source_sha']}
        self.github_reader.current_event(event)
        verified = self.package.evidence(admitted)
        need(self.verified is None or verified == self.verified, 'PUBLISHER_PACKAGE_CHANGED')
        self.verified = deepcopy(verified)
        if self.controls is not None:
            need(self.controls.controls() == {'deploy_paused': False, 'github_actions_enabled': False}
                 and self.controls.main() == ctx['source_sha'], 'PUBLISHER_CURRENT_CONTROLS_CHANGED')
        # Native evidence can outlive a reservation or an external pause. Re-read
        # the actual active ledger and our native Build as the final fence.
        admitted = {'context': ctx, 'source_sha': ctx['source_sha'], 'archive_sha256': verified['archive_sha256'],
                    'artifact_uri': verified['artifact_uri'],
                    'installation_run_id': cloud_installation_id(ctx['package_build_id'], int(body['installation_attempt']))}
        if task['phase'] == 'RECONCILE': self.historical_origin(task, body, doc, admitted)
        self.active(); self.current(); ledger.validate_approval(task['approval'], task['plan'], self.now())
        ledger.validate_admission(task['admission'], self.now(), task['approval']); self.remaining()
        return admitted

    def historical_origin(self, task, body, doc, admitted):
        """Authenticate the terminal INSTALL attempt without renewing its budget.

        Current admission pays for these reads. Historical admission is checked
        only at its recorded submission instant, never used to authorize work.
        The original journal remains unchanged, including uncertain outcomes.
        """
        origin = self.custody.read_json(body['origin_task_ref'])
        origin_id = origin.get('contract', {}).get('attempt_id')
        row = doc['attempts'].get(origin_id, {})
        need(origin_id != body['attempt_id'] and origin.get('phase') == 'INSTALL'
             and origin.get('operation') == 'PUBLISH' and row.get('state') == 'RECONCILED'
             and row.get('plan', {}).get('stage') == 'publisher', 'PUBLISHER_ORIGIN_TERMINAL_INSTALL_REQUIRED')
        moment = ledger.timestamp(row['submitted_at'])
        validate_task(origin, row['build_id'], moment)
        need(all(row.get(key) == origin[key] for key in ('plan', 'approval', 'admission'))
             and origin['contract']['build_id'] == row['build_id']
             and row['intent']['source'] == {**origin['contract']['storage_source'],
                                            'archive_sha256': origin['contract']['archive_sha256']}
             and row['intent']['request_sha256'] == ledger.canonical_hash(create_request(origin['contract'])),
             'PUBLISHER_ORIGIN_LEDGER_CHANGED')
        old_body = self.custody.read_json(origin['body_ref']); validate_body(old_body, origin, moment)
        excluded = {'attempt_id', 'journal', 'expires_at', 'origin_task_ref'}
        need({k: v for k, v in body.items() if k not in excluded} ==
             {k: v for k, v in old_body.items() if k not in excluded}, 'PUBLISHER_ORIGIN_RELEASE_CHANGED')
        status = validate_native(origin['contract'], self.api.build(row['build_id']), PROJECT_NUMBER)
        need(status in ledger.TERMINAL_STATUSES and status == row['terminal']['status'],
             'PUBLISHER_ORIGIN_NATIVE_NOT_TERMINAL')
        where = old_body['journal']
        expected = self.config['custody']['prefix'].rstrip('/') + '/journals/' + origin_id + '.json'
        need(where['bucket'] == self.config['custody']['bucket'] and where['object'] == expected,
             'PUBLISHER_ORIGIN_JOURNAL_PATH_CHANGED')
        generation, history = self.store(where).load()
        binding = {'attempt_id': origin_id, 'plan_sha256': ledger.canonical_hash(origin['plan']),
                   'source_sha': admitted['source_sha']}
        need(history is not None and generation != '0', 'PUBLISHER_ORIGIN_JOURNAL_MISSING_NO_RESET')
        validate_journal(history, binding)
        payload = {k: admitted[k] for k in ('context', 'source_sha', 'installation_run_id', 'archive_sha256')}
        for action in ('install-transport:', 'root-start:'):
            need(history['actions'].get(action + admitted['installation_run_id'], {}).get('intent_sha256') ==
                 ledger.canonical_hash(payload), 'PUBLISHER_ORIGIN_ROOT_INTENT_REQUIRED')
        current = (origin, old_body, generation, ledger.canonical_hash(history))
        need(self.origin_binding is None or current == self.origin_binding, 'PUBLISHER_ORIGIN_HISTORY_CHANGED')
        self.origin_binding = deepcopy(current)

    def boot_inputs(self, task, body, admitted, raw_journal):
        if task['phase'] == 'RECONCILE': return None
        journal = FencedJournal(raw_journal, self.admission)
        action = 'boot-originals:' + body['attempt_id']; intent = None
        def reserve(amount):
            nonlocal intent
            need(amount == BOOT_TRANSFER_RESERVATION and amount +
                 2 * (self.verified['archive_bytes'] + 1) + 16 * 1024**2 <= body['transfer_limit_bytes'],
                 'PUBLISHER_BOOT_TRANSFER_ADMISSION_REQUIRED')
            payload = {'bytes': amount, 'host_boot': self.config['host_boot'],
                       'release_admission_sha256': ledger.canonical_hash(body['release_admission'])}
            intent = journal.commit_intent(action, payload)
            need(intent.get('effect') == 'CREATE_ONCE' and intent.get('intent_sha256') == ledger.canonical_hash(payload)
                 and intent.get('attempt_id') == body['attempt_id'] and type(intent.get('fencing_generation')) is str
                 and re.fullmatch('[1-9][0-9]*', intent['fencing_generation']), 'PUBLISHER_BOOT_INTENT_NOT_NEW')
        expires = min(ledger.timestamp(task['expires_at']), ledger.timestamp(body['expires_at']),
                      ledger.timestamp(task['approval']['expires_at']), ledger.timestamp(task['admission']['expires_at']),
                      self.now() + timedelta(seconds=self.remaining()))
        raw = collect_boot_inputs(config=self.config['host_boot'], custody=self.custody,
            source_reader=self.source_reader, full_reader=self.full, package_reader=self.package,
            release_admission=body['release_admission'], admitted=admitted, expected_package=self.verified,
            check=self.remaining, now=self.now, reserve=reserve, expires_at=expires)
        need(intent is not None, 'PUBLISHER_BOOT_RESERVATION_REQUIRED')
        self.admission()
        journal.record_result(action, {'status': 'RECONCILED', 'intent_sha256': intent['intent_sha256'],
            'input_sha256': hashlib.sha256(raw).hexdigest(), 'input_bytes': len(raw)})
        return raw

    def run(self, build_id):
        ledger.native_uuid(build_id); self.build_id = build_id
        self.identity.email(); self.await_binding(); task, body, _doc = self.active()
        need(digest(ENTRYPOINT) == task['contract']['driver_sha256'], 'PUBLISHER_DRIVER_CHANGED')
        self.source_reader.connect(); admitted = self.admission()
        where = body['journal']; expected = self.config['custody']['prefix'].rstrip('/') + '/journals/' + body['attempt_id'] + '.json'
        need(where['bucket'] == self.config['custody']['bucket'] and where['object'] == expected, 'PUBLISHER_JOURNAL_PATH_CHANGED')
        binding = {'attempt_id': body['attempt_id'], 'plan_sha256': ledger.canonical_hash(task['plan']), 'source_sha': admitted['source_sha']}
        raw_journal = DurableEffectJournal(self.store(where), self.ledger_store, binding, clock=self.now)
        raw_journal._load()  # Never initialize or recreate an absent journal.
        journal = (FencedJournal(raw_journal, self.admission) if task['phase'] == 'INSTALL'
                   else HistoricalReadOnlyJournal())
        run = private_run(build_id); root = run / 'source'; private = run / 'private'
        credential = PublisherCredential(self.config['github_app'], self.identity.token, self.identity.email, now=self.now)
        acquire_once(credential, FencedJournal(raw_journal, self.admission), body['attempt_id'], self.config['github_app'], self.identity.email())
        controls = PublisherControls(credential.credential); self.controls = controls
        boot_inputs = self.boot_inputs(task, body, admitted, raw_journal)
        transport = NativeInstall(root, private, boot_inputs=boot_inputs, client_sha256=body['client_sha256'], attempt_id=body['attempt_id'],
            admission_reader=self.admission, identity_reader=self.identity.email, instance_reader=self.identity.instance,
            main_reader=controls.main, controls_reader=controls.controls, token_provider=self.identity.token,
            journal=journal, report_sink=lambda raw: self.report(run, raw), clock=self.clock)
        transport.deadline = self.started + SECONDS  # Preparation never adds another 900 seconds.
        if task['phase'] == 'INSTALL':
            verified = self.verified
            def reserve_source(size):
                # Includes local checkout, archive GET, canonical SCP and bounded metadata/headroom.
                amount = size + 2 * (verified['archive_bytes'] + 1) + 16 * 1024**2 + BOOT_TRANSFER_RESERVATION
                need(amount <= body['transfer_limit_bytes'], 'PUBLISHER_TRANSFER_LIMIT')
                result = journal.commit_intent('transfer-reservation:' + body['attempt_id'], {'bytes': amount})
                need(result.get('effect') == 'CREATE_ONCE', 'PUBLISHER_TRANSFER_ALREADY_RESERVED')
            copy_source(SOURCE, root, admitted['context'], reserve_source, self.remaining)
            release_dir = root / 'release'; need(not os.path.lexists(release_dir), 'PUBLISHER_RELEASE_PATH_EXISTS'); release_dir.mkdir(mode=0o700)
            def reserve_download(uri, amount):
                need(amount == verified['archive_bytes'] + 1, 'PUBLISHER_DOWNLOAD_RESERVATION_CHANGED')
                result = journal.commit_intent('package-download:' + body['attempt_id'], {'uri': uri, 'bytes': amount})
                need(result.get('effect') == 'CREATE_ONCE', 'PUBLISHER_DOWNLOAD_ALREADY_ATTEMPTED')
            self.package.download(verified, release_dir / 'commerce-os.tar', reserve_download)
            (release_dir / 'commerce-os.tar.sha256').write_text(verified['archive_sha256'] + '  commerce-os.tar\n')
            transport.install_once()
        else:
            transport.reconcile()
        self.remaining()
        github = GitHubDeploymentAPI(credential.credential)
        if task['phase'] == 'RECONCILE': github = ReconcileGitHub(github)
        publisher = NativePublisher(self.admission, NativeRootReadback(transport, body['collector_sha256']),
                                    https_read, github, journal)
        result = publisher.reconcile_or_publish(); self.remaining(cleanup=True)
        return {'kind': 'COMMERCE_NATIVE_PUBLISHER_RECEIPT', 'schema_version': 1,
                'status': result['status'], 'publisher_build_id': build_id, 'attempt_id': body['attempt_id'],
                'source_sha': admitted['source_sha'], 'installation_run_id': admitted['installation_run_id'],
                'deployment_id': result['deployment_id'], 'physical_sales_proven': False}

    def report(self, run, raw):
        self.remaining(cleanup=True)
        path = run / ('transport-report-' + hashlib.sha256(raw).hexdigest() + '.json')
        if not path.exists():
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as stream: stream.write(raw); stream.flush(); os.fsync(stream.fileno())
