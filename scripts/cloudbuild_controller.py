"""Trusted Cloud Build dispatch and reconciliation, with no implicit retries.

This core consumes protected manifests and the existing admission ledger. It
does not authenticate a webhook, manufacture source approval, initialize a
missing ledger, or enable deployment. HTTP delivery is only a hint; native API
readback establishes state. The hosting adapter must supply the reviewed source
and economic admission from protected custody before calling dispatch_full.
"""
from copy import deepcopy
from datetime import datetime, timezone
import json
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid

import cloudbuild_admission as ledger
from cloudbuild_connected_source import REPOSITORY_ID
from cloudbuild_full_evidence import (PROJECT, EvidenceError, canonical_hash,
    need, source, validate_manifest, validate_native, validate_full_receipt,
    receipts_from_logs)
from cloudbuild_native_reader import MAX_RESPONSE, LOG_URL, NoRedirect, decode

REGION = 'us-east1'
ROOT = 'https://cloudbuild.googleapis.com/v1/projects/' + PROJECT + '/locations/' + REGION
METADATA = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/'


def now(): return datetime.now(timezone.utc)


class ServiceIdentity:
    """Cloud Run metadata ADC only, with an exact installed service account.

    No ADC file, gcloud account, environment-selected endpoint or key fallback.
    Access tokens remain in RAM; errors contain no response or credentials.
    """
    def __init__(self, expected_email, *, opener=None):
        need(expected_email == 'commerce-v7-controller-core@' + PROJECT + '.iam.gserviceaccount.com',
             'CONTROLLER_SERVICE_IDENTITY_REQUIRED')
        self.expected_email = expected_email
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def _read(self, suffix):
        request = urllib.request.Request(METADATA + suffix, headers={'Metadata-Flavor': 'Google'})
        try:
            with self.opener.open(request, timeout=3) as response:
                need(response.status == 200 and response.headers.get('Metadata-Flavor') == 'Google',
                     'CONTROLLER_METADATA_UNCONFIRMED')
                value = response.read(16385)
        except (OSError, ValueError):
            raise EvidenceError('CONTROLLER_METADATA_UNAVAILABLE') from None
        need(len(value) <= 16384, 'CONTROLLER_METADATA_SIZE_INVALID')
        return value

    def __call__(self):
        need(self._read('email').decode().strip() == self.expected_email, 'CONTROLLER_IDENTITY_CHANGED')
        value = decode(self._read('token'))
        need(set(value) == {'access_token', 'expires_in', 'token_type'} and value['token_type'] == 'Bearer'
             and type(value['expires_in']) is int and value['expires_in'] >= 120
             and type(value['access_token']) is str and value['access_token']
             and not any(c.isspace() for c in value['access_token']), 'CONTROLLER_TOKEN_INVALID')
        return value['access_token']


class GoogleBuildAPI:
    """Regional REST transport. A mutation always makes at most one POST."""
    def __init__(self, token_provider, *, opener=None):
        self.token_provider = token_provider
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def _request(self, method, suffix, payload=None):
        allowed = ((method == 'GET' and (suffix == '/builds' or
                    re.fullmatch(r'/builds/[a-f0-9-]{36}', suffix) or
                    suffix == '/builds?pageSize=100' or
                    re.fullmatch(r'/builds\?pageSize=100&pageToken=[A-Za-z0-9%_.~+-]+', suffix))) or
                   (method == 'POST' and (suffix in {'/builds','/entries:list'} or
                    re.fullmatch(r'/builds/[a-f0-9-]{36}:approve', suffix))))
        need(allowed, 'CONTROLLER_API_TARGET_REJECTED')
        try: token = self.token_provider()
        except Exception: raise EvidenceError('CONTROLLER_TOKEN_UNAVAILABLE') from None
        need(type(token) is str and token and not any(c.isspace() for c in token), 'CONTROLLER_TOKEN_UNAVAILABLE')
        body = None if payload is None else json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
        need(body is None or len(body) <= MAX_RESPONSE, 'CONTROLLER_REQUEST_TOO_LARGE')
        request = urllib.request.Request(LOG_URL if suffix == '/entries:list' else ROOT + suffix, method=method, data=body,
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json'})
        try:
            with self.opener.open(request, timeout=20) as response:
                need(response.status == 200, 'CONTROLLER_API_UNCONFIRMED')
                raw = response.read(MAX_RESPONSE + 1)
        except urllib.error.HTTPError as error:
            error.close()
            raise EvidenceError('CONTROLLER_API_HTTP_ERROR') from None
        except (OSError, ValueError):
            raise EvidenceError('CONTROLLER_API_OUTCOME_UNKNOWN') from None
        return decode(raw)

    def build(self, build_id):
        ledger.native_uuid(build_id)
        return self._request('GET', '/builds/' + build_id)

    def create_once(self, request):
        return self._request('POST', '/builds', request)

    def approve_once(self, build_id):
        ledger.native_uuid(build_id)
        return self._request('POST', '/builds/' + build_id + ':approve', {'approvalResult': {'decision': 'APPROVED'}})

    def inventory(self):
        """Complete bounded regional inventory; truncated history fails closed."""
        values = []; tokens = set(); token = ''
        for _ in range(10):
            query = urllib.parse.urlencode({'pageSize': 100, **({'pageToken': token} if token else {})})
            page = self._request('GET', '/builds?' + query)
            need(set(page) <= {'builds', 'nextPageToken'} and type(page.get('builds', [])) is list,
                 'CONTROLLER_INVENTORY_INVALID')
            rows = page.get('builds', [])
            need(len(rows) <= 100 and all(type(row) is dict for row in rows), 'CONTROLLER_INVENTORY_INVALID')
            values.extend(rows); token = page.get('nextPageToken', '')
            need(type(token) is str and len(token) <= 4096 and token not in tokens, 'CONTROLLER_INVENTORY_TOKEN_INVALID')
            if not token: return values
            tokens.add(token)
        raise EvidenceError('CONTROLLER_INVENTORY_INCOMPLETE')

    def attestation_logs(self, build_id):
        ledger.native_uuid(build_id)
        query = 'resource.type="build" AND resource.labels.project_id="' + PROJECT + '" AND resource.labels.build_id="' + build_id + '" AND "Commerce V7 Cloud Build attestation"'
        entries=[]; tokens=set(); token=''
        for _ in range(8):
            payload={'resourceNames':['projects/'+PROJECT],'filter':query,'pageSize':100,'orderBy':'timestamp asc'}
            if token: payload['pageToken']=token
            page=self._request('POST','/entries:list',payload)
            need(set(page) <= {'entries','nextPageToken'} and type(page.get('entries',[])) is list,
                 'ATTESTATION_LOG_RESPONSE_INVALID')
            entries.extend(page.get('entries',[])); need(len(entries)<=800,'ATTESTATION_LOG_QUERY_BOUND')
            token=page.get('nextPageToken','')
            need(type(token) is str and len(token)<=4096 and token not in tokens,'ATTESTATION_LOG_TOKEN_INVALID')
            if not token:return entries
            tokens.add(token)
        raise EvidenceError('ATTESTATION_LOG_QUERY_INCOMPLETE')


def manifest_for_uuid(proposal, build_id):
    need(type(proposal) is dict and 'build_id' not in proposal, 'CONTROLLER_PROPOSAL_MUST_NOT_INVENT_UUID')
    result = {**deepcopy(proposal), 'build_id': ledger.native_uuid(build_id)}
    validate_manifest(result)
    need(result['region'] == REGION, 'CONTROLLER_REGION_CHANGED')
    return result


def validated_attempt(store, attempt_id, proposal):
    generation, document = store.load()
    ledger.need(document is not None, 'LEDGER_MISSING_NO_RESET'); ledger.validate_ledger(document)
    ledger.native_uuid(attempt_id)
    need(attempt_id in document['attempts'], 'CONTROLLER_ATTEMPT_NOT_FOUND')
    attempt = document['attempts'][attempt_id]; plan = attempt['plan']
    # This UUID checks only manifest shape. It is neither a Build ID nor a
    # persisted/emitted execution identity. Native UUIDs arrive solely by API.
    manifest_for_uuid(proposal, str(uuid.UUID(int=0)))
    need(plan['stage'] == 'full' and plan['identity']['repository_id'] == REPOSITORY_ID
         and plan['identity']['source_sha'] == proposal['source_sha']
         and plan['identity']['source_tree'] == proposal['source_tree']
         and plan['config_sha256'] == proposal['build_config_sha256']
         and plan['verifier_sha256'] == proposal['verifier_image'].rsplit(':', 1)[1]
         and plan['runner_sha256'] == proposal['runner_sha256']
         and plan['workflow_sha256'] == proposal['workflow_sha256'], 'CONTROLLER_PROPOSAL_PLAN_MISMATCH')
    if 'intent' in attempt:
        storage = source(proposal['storage_source'])
        request = {**proposal['build_config'], 'source': {'storageSource': storage}}
        need(attempt['intent']['source'] == {**storage, 'archive_sha256': proposal['archive_sha256']}
             and attempt['intent']['request_sha256'] == ledger.canonical_hash(request),
             'CONTROLLER_PROPOSAL_INTENT_MISMATCH')
    return generation, document, attempt


def validate_eligibility(eligibility, attempt, moment):
    ledger.exact(eligibility, 'approval_sha256 inventory_sha256 observed_at event_sha256',
                 'CONTROLLER_ELIGIBILITY_FIELDS_INVALID')
    need(eligibility['approval_sha256'] == ledger.canonical_hash(attempt['approval'])
         and eligibility['inventory_sha256'] == attempt['admission']['inventory_sha256'],
         'CONTROLLER_ELIGIBILITY_BINDING_CHANGED')
    ledger.digest(eligibility['event_sha256'])
    age = (moment - ledger.timestamp(eligibility['observed_at'])).total_seconds()
    need(0 <= age <= 120, 'CONTROLLER_ELIGIBILITY_STALE')


class FullController:
    """One durable submit; later invocations only reconcile its native result."""
    def __init__(self, store, api, evidence_reader, eligibility_reader, *, clock=now):
        self.store = store; self.api = api; self.reader = evidence_reader
        # Reads current protected review/economics, complete project inventory,
        # and GitHub event head/base; it must raise if any dependency is stale.
        # This is a trusted adapter, never a callback supplied by HTTP input.
        self.eligibility_reader = eligibility_reader; self.clock = clock

    def _transaction(self, op, attempt_id, **fields):
        return ledger.transact(self.store, {'op': op, 'attempt_id': attempt_id, **fields}, now=self.clock())

    def dispatch_full(self, attempt_id, proposal):
        _generation, document, attempt = validated_attempt(self.store, attempt_id, proposal)
        if 'intent' in attempt:
            return {'state': 'RECONCILIATION_REQUIRED', 'attempt_id': attempt_id}
        need(document['active_attempt'] == attempt_id and attempt['state'] == 'RESERVED', 'CONTROLLER_RESERVATION_REQUIRED')
        # Read dependencies before the CAS. The ledger independently rechecks
        # approval expiry, global exclusion and every month's pool at the CAS.
        eligibility = self.eligibility_reader(attempt, proposal)
        validate_eligibility(eligibility,attempt,self.clock())
        storage = source(proposal['storage_source'])
        source_binding = {**storage, 'archive_sha256': proposal['archive_sha256']}
        request = {**deepcopy(proposal['build_config']), 'source': {'storageSource': storage}}
        nonce = str(uuid.uuid5(uuid.UUID(attempt_id), 'commerce-full-create-v1'))
        transaction = self._transaction('submit_intent', attempt_id, source=source_binding,
            nonce=nonce, request_sha256=ledger.canonical_hash(request))
        if not transaction.effect:
            return {'state': 'RECONCILIATION_REQUIRED', 'attempt_id': attempt_id}
        need(transaction.effect['type'] == 'CREATE_ONCE', 'CONTROLLER_EFFECT_INVALID')
        try:
            validate_eligibility(eligibility,attempt,self.clock())
            ledger.validate_approval(attempt['approval'],attempt['plan'],self.clock())
            ledger.validate_admission(attempt['admission'],self.clock(),attempt['approval'])
            operation = self.api.create_once(request)
            build_id = operation.get('metadata', {}).get('build', {}).get('id')
            ledger.native_uuid(build_id)
            self._bind(attempt_id, proposal, self.api.build(build_id))
        except Exception:
            # Even an explicit non-2xx is retained. No mutation, time delay or
            # empty inventory is permission to replay this CreateBuild.
            self._transaction('unknown', attempt_id, reason='CREATE_OR_BIND_OUTCOME_UNKNOWN',
                evidence_sha256=ledger.canonical_hash({'attempt_id': attempt_id, 'request_sha256': ledger.canonical_hash(request)}))
            return {'state': 'UNKNOWN', 'attempt_id': attempt_id}
        return {'state': 'UUID_BOUND', 'attempt_id': attempt_id, 'build_id': build_id}

    def _bind(self, attempt_id, proposal, build):
        _generation, _document, attempt = validated_attempt(self.store, attempt_id, proposal)
        need(ledger.timestamp(attempt['submitted_at']) <= ledger.timestamp(build.get('createTime')) <= self.clock(),
             'CONTROLLER_NATIVE_CREATION_OUTSIDE_INTENT')
        manifest = manifest_for_uuid(proposal, build.get('id'))
        project = self.reader.project()
        need(project.get('projectId') == PROJECT, 'CONTROLLER_PROJECT_CHANGED')
        validate_native(manifest, build, self.reader.commit(manifest), project.get('projectNumber'))
        return self._transaction('bind', attempt_id, build_id=manifest['build_id'],
            source={**source(manifest['storage_source']), 'archive_sha256': manifest['archive_sha256']},
            config_sha256=manifest['build_config_sha256'], native_evidence_sha256=canonical_hash(build))

    def reconcile_full(self, attempt_id, proposal):
        _generation, _document, attempt = validated_attempt(self.store, attempt_id, proposal)
        need('intent' in attempt, 'CONTROLLER_SUBMIT_INTENT_REQUIRED')
        if 'build_id' not in attempt:
            expected = source(proposal['storage_source']); matches = []
            for candidate in self.api.inventory():
                candidate_source = candidate.get('source', {}).get('storageSource')
                if candidate_source is not None and source(candidate_source) == expected:
                    matches.append(candidate)
            if not matches:
                return {'state': 'UNKNOWN_NO_NATIVE_MATCH', 'attempt_id': attempt_id}
            if len(matches) != 1:
                ledger.transact(self.store, {'op': 'block', 'reason': 'MULTIPLE_NATIVE_SOURCE_MATCHES',
                    'evidence_sha256': canonical_hash(matches)}, now=self.clock())
                return {'state': 'BLOCKED_MULTIPLE_NATIVE_MATCHES', 'attempt_id': attempt_id}
            self._bind(attempt_id, proposal, self.api.build(matches[0].get('id')))
            _generation, _document, attempt = validated_attempt(self.store, attempt_id, proposal)
        manifest = manifest_for_uuid(proposal, attempt['build_id'])
        build = self.api.build(manifest['build_id']); project = self.reader.project()
        need(project.get('projectId') == PROJECT, 'CONTROLLER_PROJECT_CHANGED')
        state = validate_native(manifest, build, self.reader.commit(manifest), project.get('projectNumber'))
        if state == 'pending':
            self._transaction('running', attempt_id, build_id=manifest['build_id'])
            return {'state': 'PENDING', 'attempt_id': attempt_id, 'build_id': manifest['build_id']}
        # Do not infer zero billable execution from missing timing or steps.
        # Pre-worker failure/expiry requires a separate native no-execution
        # proof; the reservation stays held until that proof is implemented.
        need(type(build.get('startTime')) is str and type(build.get('finishTime')) is str,
             'CONTROLLER_NATIVE_BILLABLE_INTERVAL_REQUIRED')
        observation = {'build_id': manifest['build_id'], 'status': build['status'],
            'started_at': build['startTime'], 'finished_at': build['finishTime'],
            'execution_not_started': False, 'evidence_sha256': canonical_hash(build)}
        self._transaction('terminal', attempt_id, observation=observation)
        receipt = None
        if state == 'success':
            receipt = receipts_from_logs(self.reader.logs(manifest), manifest)
            validate_full_receipt(manifest, receipt)
        proof = canonical_hash({'manifest': manifest, 'native': build, 'receipt': receipt})
        self._transaction('reconcile', attempt_id, evidence_sha256=proof, native_verified=True)
        return {'state': 'FULL_PASSED' if state == 'success' else 'FULL_FAILED',
                'attempt_id': attempt_id, 'build_id': manifest['build_id'], 'evidence_sha256': proof,
                'deployment_proven': False, 'github_check_published': False}
