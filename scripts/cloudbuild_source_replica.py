"""One conditional native copy to an attempt-exclusive package/publisher source.

The controller still owns custody and its fresh fence. A lost copy response is
GET-only reconciliation; neither an empty destination nor a 412 permits retry.
"""
from copy import deepcopy
import urllib.parse

import cloudbuild_admission as ledger
from cloudbuild_full_evidence import source, validate_manifest, need
from cloudbuild_gcs_store import generation
from cloudbuild_protected_storage import ProtectedStorage, validate_descriptor, ORIGIN, MAX_ARCHIVE


class SourceReplica:
    def __init__(self, token_provider, bucket, stage, *, fence, opener=None):
        need(stage in {'package', 'publisher'}, 'REPLICA_STAGE_REJECTED')
        self.origin = ProtectedStorage(token_provider, bucket, 'full', opener=opener)
        self.target = ProtectedStorage(token_provider, bucket, stage, opener=opener)
        self.stage = stage; self.fence = fence

    def bindings(self, verification, original, attempt_id):
        validate_manifest(verification); validate_descriptor(original, maximum=MAX_ARCHIVE)
        ledger.native_uuid(attempt_id)
        locator = {key: original[key] for key in ('bucket', 'object', 'generation')}
        need(locator == source(verification['storage_source']) and original['sha256'] == verification['archive_sha256']
            and original['bucket'] == self.origin.bucket, 'REPLICA_ORIGIN_CHANGED')
        self.origin._path(original['object'])
        expected = {key: original[key] for key in ('bucket', 'sha256', 'size', 'md5')}
        expected['object'] = self.target.prefix + attempt_id + '.tgz'
        need(expected['object'] != original['object'], 'REPLICA_MUST_BE_DISTINCT')
        return locator, expected

    def copy_once(self, verification, original, attempt_id, journal):
        locator, expected = self.bindings(verification, original, attempt_id)
        self.origin._confirm(original)
        payload = {'origin': deepcopy(original), 'destination': expected}
        action = 'source-replica:' + attempt_id
        intent = journal.commit_intent(action, payload)
        if intent.get('effect') != 'CREATE_ONCE': return {'state': 'RECONCILIATION_REQUIRED'}
        need(intent.get('intent_sha256') == ledger.canonical_hash(payload) and intent.get('attempt_id') == attempt_id,
            'REPLICA_INTENT_CHANGED')
        generation(intent.get('fencing_generation'))
        try:
            self.fence()
            query = urllib.parse.urlencode({'sourceGeneration': locator['generation'],
                'ifSourceGenerationMatch': locator['generation'], 'ifGenerationMatch': '0'})
            url = self.origin._path(locator['object']) + '/copyTo/b/' + self.target.bucket + '/o/' + \
                urllib.parse.quote(expected['object'], safe='') + '?' + query
            with self.target._request('POST', url) as response:
                metadata = self.target._json(response)
            need(metadata.get('bucket') == expected['bucket'] and metadata.get('name') == expected['object'],
                'REPLICA_NATIVE_IDENTITY_CHANGED')
            descriptor = {**expected, 'generation': generation(metadata.get('generation'))}
            self.target._confirm(descriptor)
            result = {'status': 'RECONCILED', 'intent_sha256': intent['intent_sha256'],
                'native_id': descriptor['generation'], 'descriptor': descriptor}
            journal.record_result(action, result)
            return self.receipt(locator, descriptor)
        except Exception:
            journal.record_result(action, {'status': 'UNKNOWN', 'intent_sha256': intent['intent_sha256']})
            return {'state': 'UNKNOWN'}

    def reconcile(self, verification, original, attempt_id, journal):
        locator, expected = self.bindings(verification, original, attempt_id)
        action = 'source-replica:' + attempt_id
        _, document = journal._load(); recorded = document['actions'].get(action)
        need(type(recorded) is dict and recorded['intent_sha256'] ==
            ledger.canonical_hash({'origin': original, 'destination': expected}), 'REPLICA_INTENT_REQUIRED')
        descriptor = self.target.reconcile_source(expected)
        journal.record_result(action, {'status': 'RECONCILED', 'intent_sha256': recorded['intent_sha256'],
            'native_id': descriptor['generation'], 'descriptor': descriptor})
        return self.receipt(locator, descriptor)

    @staticmethod
    def receipt(locator, descriptor):
        return {'state': 'SOURCE_REPLICA_VERIFIED', 'descriptor': descriptor, 'replica': {
            'origin': locator, 'storage_source': {key: descriptor[key] for key in ('bucket', 'object', 'generation')},
            'archive_sha256': descriptor['sha256']}}
