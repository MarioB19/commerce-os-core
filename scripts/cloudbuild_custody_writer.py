"""Bounded protected publisher custody, fenced by the existing controller journal.

No bootstrap of ledger/control/meter/controller-journal. Immutable task objects
use generation-zero CAS; the pre-existing publisher control uses exact observed
CAS. Lost writes are reconciled by reads; absence never authorizes resubmission.
"""
import base64
from copy import deepcopy
import hashlib

import cloudbuild_admission as ledger
from cloudbuild_effect_journal import initial_journal
from cloudbuild_gcs_store import encode, generation
from cloudbuild_protected_storage import ProtectedStorage, validate_descriptor

MAX_JSON = 256 * 1024
KINDS = {'body', 'prepared', 'bound', 'worker-journal'}


class PublisherCustodyWriter:
    def __init__(self, bucket, prefix, store_factory, *, fence):
        # Constructor validates paths without requesting a token or performing I/O.
        checked = ProtectedStorage(None, bucket, prefix)
        self.bucket = checked.bucket; self.prefix = checked.prefix.rstrip('/')
        self.store_factory = store_factory; self.fence = fence

    def target(self, kind, attempt_id):
        ledger.need(kind in KINDS, 'CUSTODY_WRITE_KIND_REJECTED'); ledger.native_uuid(attempt_id)
        if kind == 'worker-journal': return self.prefix + '/journals/' + attempt_id + '.json'
        return self.prefix + '/publisher/tasks/' + attempt_id + '/' + kind + '.json'

    def payload(self, kind, attempt_id, document):
        raw = encode(document)
        ledger.need(type(document) is dict and 0 < len(raw) <= MAX_JSON, 'CUSTODY_DOCUMENT_BOUND')
        return {'bucket': self.bucket, 'object': self.target(kind, attempt_id),
                'sha256': hashlib.sha256(raw).hexdigest(), 'size': len(raw),
                'md5': base64.b64encode(hashlib.md5(raw).digest()).decode()}

    def _intent(self, journal, action, expected, attempt_id):
        result = journal.commit_intent(action, expected)
        ledger.need(result.get('intent_sha256') == ledger.canonical_hash(expected)
                    and result.get('attempt_id') == attempt_id, 'CUSTODY_WRITE_INTENT_CHANGED')
        generation(result.get('fencing_generation'))
        return result

    def _write(self, store, expected_generation, document, journal, action, payload, attempt_id):
        intent = self._intent(journal, action, payload, attempt_id)
        if intent.get('effect') != 'CREATE_ONCE': return {'state': 'RECONCILIATION_REQUIRED'}
        try:
            self.fence()
            committed = generation(store.compare_and_swap(expected_generation, document))
            ledger.need(committed != expected_generation, 'CUSTODY_WRITE_GENERATION_UNCHANGED')
            # Store CAS confirms exact bytes natively. Re-read current state as
            # well to reject a concurrent writer before binding any descriptor.
            current, actual = store.load()
            ledger.need(current == committed and actual == document, 'CUSTODY_WRITE_READBACK_CHANGED')
            descriptor = {key: payload[key] for key in ('bucket', 'object', 'sha256', 'size', 'md5')}
            descriptor['generation'] = committed; validate_descriptor(descriptor)
            journal.record_result(action, {'status': 'RECONCILED', 'intent_sha256': intent['intent_sha256'],
                                          'native_id': committed, 'descriptor': descriptor})
            return {'state': 'CUSTODY_CONFIRMED', 'descriptor': descriptor}
        except Exception:
            journal.record_result(action, {'status': 'UNKNOWN', 'intent_sha256': intent['intent_sha256']})
            return {'state': 'UNKNOWN'}

    def create_once(self, kind, attempt_id, document, journal):
        payload = self.payload(kind, attempt_id, document)
        if kind == 'worker-journal':
            ledger.need(document == initial_journal(journal.binding), 'CUSTODY_WORKER_JOURNAL_BINDING_CHANGED')
        store = self.store_factory(self.bucket, payload['object'])
        return self._write(store, '0', document, journal, 'custody-' + kind + ':' + attempt_id, payload, attempt_id)

    def control_payload(self, phase, attempt_id, observed_generation, before, task_descriptor, expiry):
        ledger.need(phase in {'prepared', 'bound'}, 'CUSTODY_CONTROL_PHASE_REJECTED')
        generation(observed_generation); ledger.native_uuid(attempt_id); validate_descriptor(task_descriptor)
        ledger.need(task_descriptor['bucket'] == self.bucket
                    and task_descriptor['object'] == self.target(phase, attempt_id), 'CUSTODY_CONTROL_TASK_CHANGED')
        ledger.exact(before, 'schema_version mode expires_at task', 'CUSTODY_CONTROL_INVALID')
        ledger.need(before['schema_version'] == 1 and before['mode'] in {'active', 'paused'}, 'CUSTODY_CONTROL_INVALID')
        ledger.timestamp(before['expires_at']); ledger.timestamp(expiry)
        if phase == 'prepared':
            ledger.need(before['mode'] == 'paused' and before['task'] is None, 'CUSTODY_PREPARE_REQUIRES_EMPTY_PAUSED_CONTROL')
        else:
            old = before['task']; validate_descriptor(old)
            ledger.need(before['mode'] == 'active' and before['expires_at'] == expiry
                and old['bucket'] == self.bucket and old['object'] == self.target('prepared', attempt_id),
                'CUSTODY_BIND_REQUIRES_PREPARED_CONTROL')
        document = {'schema_version': 1, 'mode': 'active', 'expires_at': expiry, 'task': deepcopy(task_descriptor)}
        raw = encode(document); object_name = self.prefix + '/publisher-control.json'
        payload = {'bucket': self.bucket, 'object': object_name, 'sha256': hashlib.sha256(raw).hexdigest(),
                   'size': len(raw), 'md5': base64.b64encode(hashlib.md5(raw).digest()).decode(),
                   'before_generation': observed_generation, 'before_sha256': ledger.canonical_hash(before)}
        return document, payload

    def control_once(self, phase, attempt_id, observed_generation, before, task_descriptor, expiry, journal):
        document, payload = self.control_payload(phase, attempt_id, observed_generation, before, task_descriptor, expiry)
        store = self.store_factory(self.bucket, payload['object'])
        current, actual = store.load()
        ledger.need(current == observed_generation and actual == before, 'CUSTODY_CONTROL_CAS_BASE_CHANGED')
        return self._write(store, observed_generation, document, journal, 'custody-control-' + phase + ':' + attempt_id, payload, attempt_id)

    def reconcile(self, action, payload, journal):
        # Only an existing exact intent can turn a readback into a descriptor.
        _, history = journal._load(); old = history['actions'].get(action)
        ledger.need(type(old) is dict and old['intent_sha256'] == ledger.canonical_hash(payload), 'CUSTODY_WRITE_INTENT_REQUIRED')
        expected = {key: payload[key] for key in ('bucket', 'object', 'sha256', 'size', 'md5')}
        ledger.need(expected['bucket'] == self.bucket and expected['object'].startswith(self.prefix + '/'), 'CUSTODY_RECONCILE_SCOPE_CHANGED')
        validate_descriptor({**expected, 'generation': '1'}, maximum=MAX_JSON)
        store = self.store_factory(self.bucket, expected['object'])
        current, value = store.load()
        generation(current); ledger.need(value is not None, 'CUSTODY_MISSING_NO_RECREATE')
        # load() decodes JSON and cannot attest its exact original bytes. Read
        # generation-bound native media, never re-encode a semantic substitute.
        raw = store.media(current, expected['size'])
        ledger.need(type(raw) is bytes, 'CUSTODY_RECONCILE_MEDIA_REQUIRED')
        ledger.need(len(raw) == expected['size'] and hashlib.sha256(raw).hexdigest() == expected['sha256']
                    and base64.b64encode(hashlib.md5(raw).digest()).decode() == expected['md5'], 'CUSTODY_RECONCILE_CONTENT_CHANGED')
        latest, latest_value = store.load()
        ledger.need(latest == current and latest_value == value, 'CUSTODY_RECONCILE_GENERATION_CHANGED')
        descriptor = {**expected, 'generation': current}; validate_descriptor(descriptor)
        journal.record_result(action, {'status': 'RECONCILED', 'intent_sha256': old['intent_sha256'],
                                      'native_id': current, 'descriptor': descriptor})
        return {'state': 'CUSTODY_CONFIRMED', 'descriptor': descriptor}
