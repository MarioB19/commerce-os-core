"""Fixed trusted runtime composition. No HTTP/candidate input selects code or IAM.

Custody/control/ledger/meter must be separately installed. This module does not
initialize them, mint personal credentials, deploy resources or retry effects.
"""
import base64
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import stat
import tempfile
import urllib.request

import cloudbuild_admission as ledger
from cloudbuild_attestation import GateController, attest, validate_native_gate
from cloudbuild_connected_source import ConnectedSourceReader, REPOSITORY_ID, prepare_archive
from cloudbuild_controller import FullController, GoogleBuildAPI, METADATA, now
from cloudbuild_effect_journal import DurableEffectJournal
from cloudbuild_full_evidence import PROJECT, REPOSITORY, need
from cloudbuild_gcs_store import GCSAdmissionStore, SingleRequestTransport, generation
from cloudbuild_github_reader import GitHubControlReader, validate_event
from cloudbuild_native_reader import GoogleFullReader, NoRedirect, decode
from cloudbuild_project_inventory import ProjectInventory, InventoryRequestPacer, PacedCloudBuildReads
from cloudbuild_protected_storage import ProtectedStorage, object_path, validate_descriptor

CONFIG = Path('/opt/trusted/runtime-config.json')
PROJECT_NUMBER = '1065291779811'
OPERATIONS = {'SOURCE', 'DISPATCH_FULL', 'RECONCILE_FULL', 'ATTEST', 'PACKAGE', 'PUBLISH'}
ROLES = {'controller', 'attestor'}


def location(value):
    ledger.exact(value, 'bucket object minimum_generation', 'RUNTIME_LOCATION_INVALID')
    # Reuse the native store's bucket/path parser without a network request.
    GCSAdmissionStore(value['bucket'], value['object'], None)
    generation(value['minimum_generation'])


def validate_config(value):
    ledger.exact(value, 'schema_version role project project_number repository_id mode ledger control meter custody sources adoption',
                 'RUNTIME_CONFIG_FIELDS_INVALID')
    need(type(value['schema_version']) is int and value['schema_version'] == 1
         and value['role'] in ROLES and value['mode'] in {'shadow', 'active'}
         and value['project'] == PROJECT and value['project_number'] == PROJECT_NUMBER
         and type(value['repository_id']) is int and value['repository_id'] == REPOSITORY_ID,
         'RUNTIME_CONFIG_IDENTITY_INVALID')
    for key in ('ledger', 'control', 'meter'): location(value[key])
    targets = [(value[k]['bucket'], value[k]['object']) for k in ('ledger', 'control', 'meter')]
    need(len(set(targets)) == 3, 'RUNTIME_STORES_MUST_BE_DISTINCT')
    for key in ('custody', 'sources'):
        ledger.exact(value[key], 'bucket prefix', 'RUNTIME_CUSTODY_INVALID')
        ProtectedStorage(None, value[key]['bucket'], value[key]['prefix'])
    # This is a floor for adoption of the existing native history, not a reset
    # or replacement of its per-build receipts. A new installation must carry it.
    ledger.exact(value['adoption'], 'month minimum_confirmed_seconds evidence_sha256', 'RUNTIME_ADOPTION_REQUIRED')
    need(value['adoption']['month'] == '2026-10'
         and type(value['adoption']['minimum_confirmed_seconds']) is int
         and value['adoption']['minimum_confirmed_seconds'] == 74 * 60,
         'RUNTIME_HISTORICAL_USAGE_MUST_BE_PRESERVED')
    ledger.digest(value['adoption']['evidence_sha256'])
    return deepcopy(value)


def read_installed_document():
    # Every ancestor is immutable to the runtime user. No env/argv path override.
    for path in (CONFIG.parent.parent, CONFIG.parent):
        info = path.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
             'RUNTIME_CONFIG_PARENT_UNTRUSTED')
    fd = os.open(CONFIG, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        need(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
             and not before.st_mode & 0o222 and 0 < before.st_size <= 32768,
             'RUNTIME_CONFIG_NOT_IMMUTABLE')
        raw = stream.read(32769); after = os.fstat(stream.fileno())
        need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
             (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
             and len(raw) == before.st_size, 'RUNTIME_CONFIG_CHANGED')
    return decode(raw)


def read_installed_config():
    return validate_config(read_installed_document())


class RoleIdentity:
    """Only a fixed role's metadata ADC; never local SDK/environment credentials."""
    def __init__(self, role, *, opener=None):
        need(role in ROLES, 'RUNTIME_ROLE_REJECTED')
        self.email = 'commerce-v7-' + role + '-core@' + PROJECT + '.iam.gserviceaccount.com'
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def _read(self, suffix):
        req = urllib.request.Request(METADATA + suffix, headers={'Metadata-Flavor': 'Google'})
        try:
            with self.opener.open(req, timeout=3) as response:
                need(response.status == 200 and response.headers.get('Metadata-Flavor') == 'Google',
                     'RUNTIME_METADATA_UNCONFIRMED')
                raw = response.read(16385)
        except (OSError, ValueError):
            raise ledger.AdmissionError('RUNTIME_METADATA_UNAVAILABLE') from None
        need(len(raw) <= 16384, 'RUNTIME_METADATA_TOO_LARGE')
        return raw

    def __call__(self):
        need(self._read('email').decode().strip() == self.email, 'RUNTIME_IDENTITY_CHANGED')
        token = decode(self._read('token'))
        ledger.exact(token, 'access_token token_type expires_in', 'RUNTIME_TOKEN_INVALID')
        need(token['token_type'] == 'Bearer' and type(token['expires_in']) is int and token['expires_in'] >= 120
             and type(token['access_token']) is str and token['access_token']
             and not any(c.isspace() for c in token['access_token']), 'RUNTIME_TOKEN_INVALID')
        return token['access_token']


class ExistingStore:
    def __init__(self, store, minimum):
        self.store = store; self.minimum = int(generation(minimum)); self.highest = self.minimum

    def load(self):
        observed, document = self.store.load()
        need(document is not None and int(generation(observed)) >= self.highest,
             'RUNTIME_STORE_MISSING_OR_REWOUND')
        self.highest = int(observed)
        return observed, document

    def compare_and_swap(self, expected, document):
        need(int(generation(expected)) >= self.highest, 'RUNTIME_STORE_GENERATION_REWOUND')
        observed = self.store.compare_and_swap(expected, document)
        need(int(generation(observed)) > int(expected), 'RUNTIME_CAS_UNCONFIRMED')
        self.highest = int(observed)
        return observed


@dataclass(frozen=True)
class Work:
    operation: str
    reservation_seconds: int
    control_generation: str
    control_sha256: str
    descriptor: dict
    task: dict
    control_expires_at: str


def validate_work_window(work, clock):
    need(clock() < ledger.timestamp(work.control_expires_at), 'RUNTIME_CONTROL_EXPIRED')
    validate_task(work.task, clock)


def validate_task(task, clock):
    ledger.exact(task, 'schema_version operation phase attempt_id plan approval admission event payload expires_at',
                 'RUNTIME_TASK_FIELDS_INVALID')
    need(type(task['schema_version']) is int and task['schema_version'] == 1 and task['operation'] in OPERATIONS,
         'RUNTIME_OPERATION_REJECTED')
    phases = {'SOURCE': {'ACQUIRE', 'RECONCILE', 'RESUME'}, 'DISPATCH_FULL': {'ADMIT', 'DISPATCH'},
              'RECONCILE_FULL': {'RECONCILE'}, 'ATTEST': {'ADMIT', 'APPROVE', 'RECONCILE', 'RUN'},
              'PACKAGE': {'ADMIT', 'REPLICA', 'REPLICA_RECONCILE', 'DISPATCH', 'RECONCILE'},
              'PUBLISH': {'ADMIT', 'REPLICA', 'REPLICA_RECONCILE', 'PREPARE', 'DISPATCH', 'RECONCILE'}}
    need(task['phase'] in phases[task['operation']], 'RUNTIME_PHASE_REJECTED')
    ledger.native_uuid(task['attempt_id']); ledger.validate_plan(task['plan']); validate_event(task['event'])
    need(type(task['payload']) is dict and clock() < ledger.timestamp(task['expires_at']), 'RUNTIME_TASK_EXPIRED')
    identity = task['plan']['identity']
    need(identity['repository_id'] == REPOSITORY_ID and all(identity[k] == task['event'][k]
         for k in ('repository_id', 'source_sha', 'source_tree')), 'RUNTIME_EVENT_PLAN_MISMATCH')
    expected_stage = {'ATTEST': 'attestation', 'PACKAGE': 'package', 'PUBLISH': 'publisher'}.get(task['operation'], 'full')
    need(task['plan']['stage'] == expected_stage,
         'RUNTIME_STAGE_MISMATCH')


class FencedBuildAPI:
    """Trusted post-CAS revalidation immediately before the only native POST."""
    def __init__(self, api, fence):
        self.api = api; self.fence = fence

    def __getattr__(self, name):
        return getattr(self.api, name)

    def create_once(self, request):
        self.fence()
        return self.api.create_once(request)

    def approve_once(self, build_id):
        self.fence()
        return self.api.approve_once(build_id)


class RuntimeFactory:
    def __init__(self, config, *, clock=now):
        self.config = validate_config(config); self.clock = clock; self.issued = None
        self.identity = RoleIdentity(config['role'])
        transport = SingleRequestTransport(self.identity)
        transport.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.transport = transport
        self.ledger_store = self._store(config['ledger'])
        self.control_store = self._store(config['control'])
        self.meter_store = self._store(config['meter'])
        self.custody = ProtectedStorage(self.identity, **{'bucket': config['custody']['bucket'], 'prefix': config['custody']['prefix']})
        self.sources = ProtectedStorage(self.identity, config['sources']['bucket'], config['sources']['prefix'])
        self.source_reader = ConnectedSourceReader(self.identity)
        self.github = GitHubControlReader(self.source_reader)
        self.api = GoogleBuildAPI(self.identity)
        self.full_reader = GoogleFullReader(self.identity, self.source_reader.commit)
        # Readers stay single-use; the issuance clock survives repeated observations.
        self.inventory_pacer = InventoryRequestPacer()
        for reader in (self.source_reader, self.api, self.full_reader):
            reader.opener = PacedCloudBuildReads(reader.opener, self.inventory_pacer)

    @classmethod
    def from_installed_config(cls):
        return cls(read_installed_config())

    def _store(self, target):
        location(target)
        return ExistingStore(GCSAdmissionStore(target['bucket'], target['object'], self.transport), target['minimum_generation'])

    def _control(self):
        observed, control = self.control_store.load()
        ledger.exact(control, 'schema_version mode expires_at task', 'RUNTIME_CONTROL_FIELDS_INVALID')
        need(type(control['schema_version']) is int and control['schema_version'] == 1
             and control['mode'] in {'shadow', 'active', 'paused'}
             and self.clock() < ledger.timestamp(control['expires_at']), 'RUNTIME_CONTROL_EXPIRED')
        if control['task'] is not None: validate_descriptor(control['task'])
        return observed, control

    def inspect_work(self):
        observed, control = self._control()
        if self.config['mode'] == 'shadow' or control['mode'] != 'active' or control['task'] is None:
            self.issued = None
            return None
        task = self.custody.read_json(control['task']); validate_task(task, self.clock)
        need((self.config['role'] == 'attestor') == (task['operation'] == 'ATTEST' and task['phase'] == 'RUN'),
             'RUNTIME_TASK_ROLE_MISMATCH')
        result = Work(task['operation'], 450 if task['operation'] in {'SOURCE', 'DISPATCH_FULL', 'ATTEST', 'PACKAGE', 'PUBLISH'} else 120,
                      observed, ledger.canonical_hash(control), deepcopy(control['task']), deepcopy(task), control['expires_at'])
        self.issued = result
        return result

    def _current(self, work):
        need(work is self.issued, 'RUNTIME_WORK_NOT_ISSUED')
        observed, control = self._control()
        need(observed == work.control_generation and ledger.canonical_hash(control) == work.control_sha256
             and control['mode'] == self.config['mode'] == 'active' and control['task'] == work.descriptor,
             'RUNTIME_CONTROL_CHANGED')
        task = self.custody.read_json(work.descriptor)
        need(task == work.task, 'RUNTIME_WORK_CHANGED'); validate_work_window(work, self.clock)
        return task

    def _ledger(self):
        generation, doc = self.ledger_store.load(); ledger.validate_ledger(doc)
        adoption = self.config['adoption']
        usage = ledger.budget_usage(doc, now=self.clock())
        need(usage.get(adoption['month'], {}).get('confirmed_seconds', 0) >= adoption['minimum_confirmed_seconds'],
             'RUNTIME_HISTORICAL_USAGE_NOT_ADOPTED')
        return generation, doc

    def inventory_snapshot(self):
        return ProjectInventory(self.identity, PROJECT_NUMBER, pacer=self.inventory_pacer).snapshot()

    def _eligibility(self, work, attempt, _proposal):
        observed = self.clock(); task = self._current(work); self._ledger()
        need(attempt['plan'] == task['plan'] and attempt['approval'] == task['approval']
             and attempt['admission'] == task['admission'], 'RUNTIME_ADMISSION_CUSTODY_CHANGED')
        ledger.validate_approval(task['approval'], task['plan'], self.clock())
        ledger.validate_admission(task['admission'], self.clock(), task['approval'])
        current = self.github.current_event(task['event'])
        inventory = self.inventory_snapshot()
        need(inventory['complete'] is True and inventory['inventory_sha256'] == task['admission']['inventory_sha256'],
             'RUNTIME_NATIVE_INVENTORY_CHANGED')
        self._current(work)
        need(0 <= (self.clock() - observed).total_seconds() <= 120, 'RUNTIME_ELIGIBILITY_EXPIRED')
        ledger.validate_approval(task['approval'], task['plan'], self.clock())
        ledger.validate_admission(task['admission'], self.clock(), task['approval'])
        return {'approval_sha256': ledger.canonical_hash(task['approval']),
                'inventory_sha256': inventory['inventory_sha256'], 'event_sha256': current['event_sha256'],
                'observed_at': ledger.stamp(observed)}

    def _admit(self, work):
        task = self._current(work); self._ledger()
        candidate = {key: task[key] for key in ('plan', 'approval', 'admission')}
        eligibility = self._eligibility(work, candidate, None)
        for op, key in (('discover', 'plan'), ('approve_source', 'approval'), ('reserve', 'admission')):
            self._current(work)
            need((self.clock() - ledger.timestamp(eligibility['observed_at'])).total_seconds() <= 120,
                 'RUNTIME_ADMISSION_EXPIRED')
            ledger.transact(self.ledger_store, {'op': op, 'attempt_id': task['attempt_id'], key: task[key]}, now=self.clock())
        self._current(work); _, observed = self._ledger()
        admitted = observed['attempts'].get(task['attempt_id'], {})
        need(admitted.get('state') == 'RESERVED' and observed['active_attempt'] == task['attempt_id'],
             'RUNTIME_ADMISSION_NOT_RESERVED')
        return {'state': admitted['state'], 'attempt_id': task['attempt_id']}

    def _source(self, work):
        self.diagnostic_phase = 'SOURCE_VALIDATE'
        task = self._current(work); payload = task['payload']
        ledger.exact(payload, 'source_approval journal' + (' recovery' if task['phase'] == 'RESUME' else ''),
                     'RUNTIME_SOURCE_PAYLOAD_INVALID')
        target = payload['journal']; location(target)
        need(target['bucket'] == self.config['custody']['bucket'] and target['object'] ==
             self.config['custody']['prefix'] + '/source-journals/' + task['attempt_id'] + '.json', 'RUNTIME_JOURNAL_PATH_CHANGED')
        _, document = self._ledger(); attempt = document['attempts'].get(task['attempt_id'], {})
        self.diagnostic_phase = 'SOURCE_ELIGIBILITY'
        self._eligibility(work, attempt, None)
        approval = payload['source_approval']
        need(type(approval) is dict and all(approval.get(k) == task['plan']['identity'][k]
             for k in ('repository_id', 'source_sha', 'source_tree'))
             and approval.get('review_sha256') == task['approval']['review_sha256']
             and approval.get('runner_sha256') == task['plan']['runner_sha256']
             and approval.get('workflow_sha256') == task['plan']['workflow_sha256'], 'RUNTIME_SOURCE_REVIEW_CHANGED')
        binding = {'attempt_id': task['attempt_id'], 'plan_sha256': ledger.canonical_hash(task['plan']),
                   'source_sha': task['plan']['identity']['source_sha']}
        journal = DurableEffectJournal(self._store(target), self.ledger_store, binding, clock=self.clock)
        raw_commit = journal.commit_intent
        post_fence = {}
        def fenced_commit(action, payload):
            result = raw_commit(action, payload)
            if result.get('effect') == 'CREATE_ONCE':
                self.diagnostic_phase = 'SOURCE_POST_INTENT_FENCE'
                post_fence['eligibility'] = self._fence(work)
            return result
        journal.commit_intent = fenced_commit
        action = 'source-acquire:' + task['attempt_id']
        if task['phase'] == 'RECONCILE':
            self.diagnostic_phase = 'SOURCE_RECONCILE'
            _, doc = journal._load(); acquired = doc['actions'].get(action, {}).get('result')
            need(type(acquired) is dict and acquired.get('status') == 'RECONCILED', 'RUNTIME_SOURCE_ACQUISITION_UNRESOLVED')
            expected = acquired['expected']; upload = doc['actions'].get('source-upload:' + task['attempt_id'])
            need(type(upload) is dict and upload['intent_sha256'] == ledger.canonical_hash(expected), 'RUNTIME_UPLOAD_INTENT_REQUIRED')
            descriptor = self.sources.reconcile_source(expected)
            journal.record_result('source-upload:' + task['attempt_id'], {'status': 'RECONCILED',
                'intent_sha256': upload['intent_sha256'], 'native_id': descriptor['generation'], 'descriptor': descriptor})
            return {'state': 'SOURCE_UPLOADED_AND_VERIFIED', 'descriptor': descriptor}
        self.diagnostic_phase = 'SOURCE_ACQUIRE_INTENT'
        resume_action = None
        if task['phase'] == 'RESUME':
            from cloudbuild_source_continuation import validate_current, ATTEMPT
            need(task['attempt_id'] == ATTEMPT, 'RUNTIME_SOURCE_RESUME_ATTEMPT_CHANGED')
            recovery_ref = payload['recovery']; validate_descriptor(recovery_ref)
            need(recovery_ref['bucket'] == self.config['custody']['bucket'] and recovery_ref['object'] ==
                self.config['custody']['prefix']+'/tasks/'+ATTEMPT+'/source-resume-recovery.json',
                'RUNTIME_SOURCE_RESUME_CUSTODY_CHANGED')
            recovery = self.custody.read_json(recovery_ref)
            need((recovery['meter_after']['bucket'], recovery['meter_after']['object']) ==
                (self.config['meter']['bucket'], self.config['meter']['object']), 'RUNTIME_SOURCE_RESUME_METER_CHANGED')
            parent_generation, parent = self._ledger(); journal_generation, journal_document = journal._load()
            meter_generation, meter_document = self.meter_store.load()
            resume_payload = validate_current(recovery, ledger_generation=parent_generation, ledger_document=parent,
                journal_generation=journal_generation, journal_document=journal_document,
                meter_generation=meter_generation, meter_document=meter_document, source_approval=approval, now=self.clock())
            self._current(work)
            resume_action = 'source-resume:'+ATTEMPT
            resume_intent = journal.commit_intent(resume_action, resume_payload)
            need(resume_intent['effect'] == 'CREATE_ONCE', 'RUNTIME_SOURCE_RESUME_ALREADY_CONSUMED')
            # The post-CAS fence can take a full inventory. Recheck the protected
            # continuation window after it, before any Git acquisition.
            self.sources.require_source_absent(task['attempt_id'])
            intent = {'intent_sha256':journal_document['actions'][action]['intent_sha256']}
        else:
            intent = journal.commit_intent(action, approval)
            need(intent['effect'] == 'CREATE_ONCE', 'RUNTIME_SOURCE_ACQUISITION_ALREADY_CONSUMED')
        self._current(work)
        if resume_action is not None:
            # No I/O follows this final time fence before prepare_archive.
            need(self.clock() < ledger.timestamp(recovery['expires_at']), 'RUNTIME_SOURCE_RESUME_EXPIRED')
            need(0 <= (self.clock()-ledger.timestamp(post_fence['eligibility']['observed_at'])).total_seconds() <= 120,
                'RUNTIME_ELIGIBILITY_EXPIRED')
            ledger.validate_approval(task['approval'], task['plan'], self.clock())
            ledger.validate_admission(task['admission'], self.clock(), task['approval'])
        self.diagnostic_phase = 'SOURCE_ACQUIRE'
        with tempfile.TemporaryDirectory(prefix='commerce-v7-source-') as folder:
            os.chmod(folder, 0o700)
            result = prepare_archive(Path(folder), approval, self.source_reader)
            path = Path(result['archive_path']); os.chmod(path, 0o600)
            digest = hashlib.md5()
            with path.open('rb') as body:
                total = 0
                while True:
                    raw = body.read(min(1024 * 1024, result['archive_bytes'] - total + 1))
                    if not raw: break
                    total += len(raw); need(total <= result['archive_bytes'], 'RUNTIME_SOURCE_GREW'); digest.update(raw)
            need(total == result['archive_bytes'], 'RUNTIME_SOURCE_TRUNCATED')
            expected = {'bucket': self.sources.bucket, 'object': self.sources.prefix + task['attempt_id'] + '.tgz',
                        'sha256': result['archive_sha256'], 'size': total, 'md5': base64.b64encode(digest.digest()).decode()}
            self.diagnostic_phase = 'SOURCE_ACQUISITION_RECORD'
            journal.record_result(action, {'status': 'RECONCILED', 'intent_sha256': intent['intent_sha256'], 'expected': expected})
            if resume_action is not None:
                journal.record_result(resume_action, {'status':'RECONCILED',
                    'intent_sha256':resume_intent['intent_sha256'], 'acquisition_intent_sha256':intent['intent_sha256'],
                    'expected':expected})
            self._current(work)
            self.diagnostic_phase = 'SOURCE_UPLOAD'
            return self.sources.upload_source_once(path, expected, journal, attempt_id=task['attempt_id'])

    def _fence(self, work):
        task = self._current(work); _, doc = self._ledger()
        need(doc['blocked'] is None and doc['active_attempt'] == task['attempt_id'],
             'RUNTIME_ACTIVE_ADMISSION_CHANGED')
        return self._eligibility(work, doc['attempts'].get(task['attempt_id'], {}), None)

    def execute(self, work):
        self.diagnostic_phase = 'WORK_VALIDATE'
        task = self._current(work); self._ledger()
        need(self.config['role'] == 'controller', 'RUNTIME_CONTROLLER_REQUIRED')
        self.diagnostic_phase = 'SOURCE_CONNECT'
        self.source_reader.connect()
        self.diagnostic_phase = 'WORK_VALIDATE'
        eligibility = lambda attempt, proposal: self._eligibility(work, attempt, proposal)
        api = FencedBuildAPI(self.api, lambda: self._fence(work))
        full = FullController(self.ledger_store, api, self.full_reader, eligibility, clock=self.clock)
        gate = GateController(self.ledger_store, api, self.full_reader, eligibility, clock=self.clock)
        if task['phase'] == 'ADMIT': result = self._admit(work)
        elif task['operation'] == 'SOURCE': result = self._source(work)
        elif task['operation'] in {'PACKAGE', 'PUBLISH'}:
            from cloudbuild_runtime_release import ReleaseRuntime
            result = ReleaseRuntime(self, work).execute()
        elif task['operation'] in {'DISPATCH_FULL', 'RECONCILE_FULL'}:
            ledger.exact(task['payload'], 'proposal', 'RUNTIME_FULL_PAYLOAD_INVALID')
            _, document = self._ledger()
            attempt = document['attempts'].get(task['attempt_id'], {})
            # Redelivery advances observation, never repeats CreateBuild.
            method = full.reconcile_full if 'intent' in attempt or task['operation'] == 'RECONCILE_FULL' else full.dispatch_full
            result = method(task['attempt_id'], task['payload']['proposal'])
        else:
            bundle = task['payload']
            ledger.exact(bundle, 'gate_attempt_id full_attempt_id full_manifest contract', 'ATTESTATION_BUNDLE_INVALID')
            need(task['attempt_id'] == bundle['gate_attempt_id'], 'RUNTIME_GATE_ATTEMPT_CHANGED')
            args = [bundle[k] for k in ('gate_attempt_id', 'full_attempt_id', 'full_manifest', 'contract')]
            _, document = self._ledger()
            attempted = 'intent' in document['attempts'].get(task['attempt_id'], {})
            if task['phase'] == 'APPROVE' and not attempted: result = gate.approve(*args)
            else: result = gate.reconcile(*args, lambda contract: self.github.check(contract, PROJECT_NUMBER))
        uncertain = result.get('state', '').startswith(('UNKNOWN', 'BLOCKED'))
        return {**result, 'request_outcome': 'UNKNOWN' if uncertain else 'CONFIRMED'}

    def run_attestor(self, build_id):
        ledger.native_uuid(build_id)
        need(self.config['role'] == 'attestor', 'RUNTIME_ATTESTOR_REQUIRED')
        work = self.inspect_work(); need(work is not None, 'RUNTIME_ATTESTOR_CUSTODY_REQUIRED')
        task = self._current(work); _, document = self._ledger(); bundle = task['payload']
        attempt = document['attempts'].get(task['attempt_id'], {})
        need(all(attempt.get(k) == task[k] for k in ('plan', 'approval', 'admission')),
             'RUNTIME_ATTESTOR_ADMISSION_CHANGED')
        ledger.validate_approval(task['approval'], task['plan'], self.clock())
        ledger.validate_admission(task['admission'], self.clock(), task['approval'])
        ledger.exact(bundle, 'gate_attempt_id full_attempt_id full_manifest contract', 'ATTESTATION_BUNDLE_INVALID')
        need(bundle['gate_attempt_id'] == task['attempt_id'] and bundle['contract']['build_id'] == build_id,
             'RUNTIME_ATTESTOR_BUILD_CHANGED')
        self.source_reader.connect()
        need(validate_native_gate(bundle['contract'], self.api.build(build_id), PROJECT_NUMBER) == 'WORKING',
             'RUNTIME_ATTESTOR_NOT_RUNNING')
        def current_event(contract):
            self._current(work)
            need(contract['source_sha'] == task['event']['source_sha'] and contract['source_tree'] == task['event']['source_tree'],
                 'RUNTIME_ATTESTOR_EVENT_CHANGED')
            return self.github.current_event(task['event'])
        receipt = attest(bundle, self.ledger_store, self.api, self.full_reader, current_event)
        # FULL/log reads can outlive the earlier authorization. No cached PASS
        # is emitted after a custody pause, expiry or superseding source event.
        self._current(work); _, document = self._ledger()
        observed = document['attempts'].get(task['attempt_id'], {})
        need(document['active_attempt'] == task['attempt_id'] and document['blocked'] is None
             and all(observed.get(k) == task[k] for k in ('plan', 'approval', 'admission')),
             'RUNTIME_ATTESTOR_ADMISSION_CHANGED')
        ledger.validate_approval(task['approval'], task['plan'], self.clock())
        ledger.validate_admission(task['admission'], self.clock(), task['approval'])
        current_event(bundle['contract'])
        self._current(work)
        ledger.validate_approval(task['approval'], task['plan'], self.clock())
        ledger.validate_admission(task['admission'], self.clock(), task['approval'])
        return receipt
