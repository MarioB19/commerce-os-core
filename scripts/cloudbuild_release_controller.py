"""Single-submit native package/publisher controller under the shared CI ledger.

Only an image-owned factory supplies adapters and protected proposals. This
module creates no resources on import, initializes no state and grants no IAM.
Every effect follows a durable intent and fresh native dependency revalidation.
"""
from copy import deepcopy
import uuid

import cloudbuild_admission as ledger
import cloudbuild_attestation as gate
import cloudbuild_native_package as package
import cloudbuild_publisher_contract as publisher
import cloudbuild_release_evidence as release
from cloudbuild_controller import validate_eligibility, now, REPOSITORY_ID
from cloudbuild_full_evidence import PROJECT, need, source

NUMBER = '1065291779811'
SHAPE_UUID = '00000000-0000-0000-0000-000000000000'


def describe(proposal, build_id=SHAPE_UUID):
    """Derive the exact native request without accepting caller-authored YAML."""
    need(type(proposal) is dict and proposal.get('kind') in {'package', 'publisher'}, 'RELEASE_KIND_REQUIRED')
    common = 'kind full_attempt_id gate_attempt_id gate_contract'
    if proposal['kind'] == 'package':
        ledger.exact(proposal, common + ' verification inputs replica', 'PACKAGE_PROPOSAL_INVALID')
        admitted = package.admission(proposal['verification'], proposal['inputs'], build_id, proposal['replica'])
        request = package.create_request(proposal['verification'], proposal['inputs'], proposal['replica'])
        return {'stage': 'package', 'verification': proposal['verification'], 'admission': admitted,
            'config': package.build_config(proposal['inputs']), 'request': request,
            'image': proposal['inputs']['package_image'], 'runner': proposal['inputs']['package_driver_sha256'],
            'source': {**source(proposal['replica']['storage_source']), 'archive_sha256': proposal['replica']['archive_sha256']}}
    ledger.exact(proposal, common + ' package_attempt_id release_admission contract', 'PUBLISHER_PROPOSAL_INVALID')
    need(type(proposal['contract']) is dict and 'build_id' not in proposal['contract'], 'RELEASE_NATIVE_UUID_MUST_NOT_BE_INVENTED')
    contract = {**deepcopy(proposal['contract']), 'build_id': ledger.native_uuid(build_id)}
    publisher.validate_contract(contract)
    context = release.validate_admission(proposal['release_admission'])
    need(context['package_origin'] == 'cloud-build' and all(contract[key] == context[key] for key in ('source_sha', 'source_tree'))
        and contract['archive_sha256'] == proposal['release_admission']['verification_manifest']['archive_sha256'],
        'PUBLISHER_VERIFICATION_SOURCE_CHANGED')
    return {'stage': 'publisher', 'verification': proposal['release_admission']['verification_manifest'],
        'admission': proposal['release_admission'], 'contract': contract, 'config': publisher.template(contract),
        'request': publisher.create_request(contract), 'image': contract['image'], 'runner': contract['driver_sha256'],
        'source': {**source(contract['storage_source']), 'archive_sha256': contract['archive_sha256']}}


class ReleaseController:
    def __init__(self, store, api, package_reader, github, eligibility_reader, *, clock=now):
        self.store = store; self.api = api; self.package_reader = package_reader
        self.full_reader = package_reader.full_reader; self.github = github
        self.eligibility_reader = eligibility_reader; self.clock = clock

    def transaction(self, op, attempt_id, **fields):
        return ledger.transact(self.store, {'op': op, 'attempt_id': attempt_id, **fields}, now=self.clock())

    def attempt(self, attempt_id, proposal):
        ledger.native_uuid(attempt_id)
        _, document = self.store.load(); need(document is not None, 'LEDGER_MISSING_NO_RESET')
        ledger.validate_ledger(document); details = describe(proposal)
        attempt = document['attempts'].get(attempt_id, {}); plan = attempt.get('plan', {})
        verification = details['verification']
        need(plan.get('stage') == details['stage'] and plan.get('identity', {}).get('repository_id') == REPOSITORY_ID
            and all(plan['identity'].get(key) == verification[key] for key in ('source_sha', 'source_tree'))
            and plan.get('timeout_seconds') == (1800 if details['stage'] == 'package' else 900)
            and plan.get('queue_seconds') == 600 and plan.get('config_sha256') == ledger.canonical_hash(details['config'])
            and plan.get('verifier_sha256') == details['image'].rsplit(':', 1)[1]
            and plan.get('runner_sha256') == details['runner'] and plan.get('workflow_sha256') == verification['workflow_sha256'],
            'RELEASE_PROPOSAL_PLAN_CHANGED')
        if details['stage'] == 'publisher':
            need(details['contract']['attempt_id'] == attempt_id, 'PUBLISHER_ATTEMPT_CHANGED')
        if 'intent' in attempt:
            need(attempt['intent']['source'] == details['source']
                and attempt['intent']['request_sha256'] == ledger.canonical_hash(details['request']), 'RELEASE_INTENT_CHANGED')
        return document, attempt, details

    def dependencies(self, attempt_id, proposal):
        document, attempt, details = self.attempt(attempt_id, proposal)
        need(document['blocked'] is None and document['active_attempt'] == attempt_id, 'RELEASE_ACTIVE_RESERVATION_REQUIRED')
        eligibility = self.eligibility_reader(attempt, proposal)
        validate_eligibility(eligibility, attempt, self.clock())
        contract = proposal['gate_contract']; gate.validate_contract(contract)
        gate.full_reconciled(document, proposal['full_attempt_id'], details['verification'], contract)
        row = document['attempts'].get(proposal['gate_attempt_id'], {})
        need(row.get('state') == 'RECONCILED' and row.get('plan', {}).get('stage') == 'attestation'
            and row.get('build_id') == contract['build_id'] and row.get('terminal', {}).get('status') == 'SUCCESS',
            'RELEASE_RECONCILED_ATTESTATION_REQUIRED')
        need(gate.validate_native_gate(contract, self.api.build(contract['build_id']), NUMBER) == 'SUCCESS',
            'RELEASE_NATIVE_ATTESTATION_REQUIRED')
        gate.receipt_from_logs(self.api.attestation_logs(contract['build_id']), contract, details['verification'])
        gate.validate_app_check(self.github.check(contract, NUMBER), contract, NUMBER)
        need(self.full_reader.evaluate(details['verification'])['state'] == 'success', 'RELEASE_NATIVE_FULL_REQUIRED')
        if details['stage'] == 'publisher':
            ctx = release.validate_admission(details['admission'])
            row = document['attempts'].get(proposal['package_attempt_id'], {})
            need(row.get('state') == 'RECONCILED' and row.get('plan', {}).get('stage') == 'package'
                and row.get('build_id') == ctx['package_build_id'] and row.get('terminal', {}).get('status') == 'SUCCESS',
                'RELEASE_RECONCILED_PACKAGE_REQUIRED')
            self.package_reader.evidence(details['admission'])
        # Native reads may take time or overlap a pause. Re-read protected
        # authorization and ledger after them; never let their old result POST.
        again, active, _ = self.attempt(attempt_id, proposal)
        need(again['blocked'] is None and again['active_attempt'] == attempt_id
            and all(active.get(key) == attempt.get(key) for key in ('plan', 'approval', 'admission')),
            'RELEASE_ADMISSION_CHANGED')
        current = self.eligibility_reader(active, proposal)
        validate_eligibility(current, active, self.clock())
        final, latest, _ = self.attempt(attempt_id, proposal)
        dependency_ids = [proposal['full_attempt_id'], proposal['gate_attempt_id']]
        if details['stage'] == 'publisher': dependency_ids.append(proposal['package_attempt_id'])
        need(final['blocked'] is None and final['active_attempt'] == attempt_id
            and latest == active and all(final['attempts'].get(key) == document['attempts'].get(key)
                for key in dependency_ids), 'RELEASE_FINAL_LEDGER_CHANGED')
        validate_eligibility(current, latest, self.clock())
        ledger.validate_approval(active['approval'], active['plan'], self.clock())
        ledger.validate_admission(active['admission'], self.clock(), active['approval'])
        return details

    def dispatch(self, attempt_id, proposal):
        document, attempt, details = self.attempt(attempt_id, proposal)
        if 'intent' in attempt: return {'state': 'RECONCILIATION_REQUIRED', 'attempt_id': attempt_id}
        need(document['active_attempt'] == attempt_id and attempt['state'] == 'RESERVED', 'RELEASE_RESERVATION_REQUIRED')
        self.dependencies(attempt_id, proposal)
        intent = self.transaction('submit_intent', attempt_id, source=details['source'],
            nonce=str(uuid.uuid5(uuid.UUID(attempt_id), 'commerce-' + details['stage'] + '-create-v1')),
            request_sha256=ledger.canonical_hash(details['request']))
        if not intent.effect: return {'state': 'RECONCILIATION_REQUIRED', 'attempt_id': attempt_id}
        need(intent.effect['type'] == 'CREATE_ONCE', 'RELEASE_EFFECT_CHANGED')
        try:
            self.dependencies(attempt_id, proposal)
            operation = self.api.create_once(details['request'])
            build_id = ledger.native_uuid(operation.get('metadata', {}).get('build', {}).get('id'))
            self.bind(attempt_id, proposal, self.api.build(build_id))
        except Exception:
            self.transaction('unknown', attempt_id, reason='RELEASE_CREATE_OR_BIND_OUTCOME_UNKNOWN',
                evidence_sha256=ledger.canonical_hash({'attempt_id': attempt_id, 'request': details['request']}))
            return {'state': 'UNKNOWN', 'attempt_id': attempt_id}
        return {'state': 'UUID_BOUND', 'attempt_id': attempt_id, 'build_id': build_id}

    def native(self, details, build):
        project = self.full_reader.project()
        need(project.get('projectId') == PROJECT and str(project.get('projectNumber')) == NUMBER, 'RELEASE_PROJECT_CHANGED')
        if details['stage'] == 'package':
            return release.package_native_identity(details['admission'], build, NUMBER)
        return publisher.validate_native(details['contract'], build, NUMBER)

    def bind(self, attempt_id, proposal, build):
        _, attempt, _ = self.attempt(attempt_id, proposal)
        need(ledger.timestamp(attempt['submitted_at']) <= ledger.timestamp(build.get('createTime')) <= self.clock(),
            'RELEASE_NATIVE_CREATION_OUTSIDE_INTENT')
        details = describe(proposal, build.get('id')); self.native(details, build)
        self.transaction('bind', attempt_id, build_id=build['id'], source=details['source'],
            config_sha256=ledger.canonical_hash(details['config']), native_evidence_sha256=ledger.canonical_hash(build))

    def reconcile(self, attempt_id, proposal):
        _, attempt, details = self.attempt(attempt_id, proposal)
        need('intent' in attempt, 'RELEASE_SUBMIT_INTENT_REQUIRED')
        if 'build_id' not in attempt:
            locator = {key: details['source'][key] for key in ('bucket', 'object', 'generation')}
            matches = [row for row in self.api.inventory() if row.get('source', {}).get('storageSource') == locator]
            if not matches: return {'state': 'UNKNOWN_NO_NATIVE_MATCH', 'attempt_id': attempt_id}
            if len(matches) != 1:
                ledger.transact(self.store, {'op': 'block', 'reason': 'MULTIPLE_NATIVE_RELEASE_SOURCE_MATCHES',
                    'evidence_sha256': ledger.canonical_hash(matches)}, now=self.clock())
                return {'state': 'BLOCKED_MULTIPLE_NATIVE_MATCHES', 'attempt_id': attempt_id}
            self.bind(attempt_id, proposal, self.api.build(matches[0].get('id')))
            _, attempt, _ = self.attempt(attempt_id, proposal)
        details = describe(proposal, attempt['build_id']); build = self.api.build(attempt['build_id'])
        status = self.native(details, build)
        if status in {'QUEUED', 'WORKING'}:
            self.transaction('running', attempt_id, build_id=build['id'])
            return {'state': 'PENDING', 'attempt_id': attempt_id, 'build_id': build['id']}
        need(type(build.get('startTime')) is str and type(build.get('finishTime')) is str,
            'RELEASE_NATIVE_BILLABLE_INTERVAL_REQUIRED')
        observation = {'build_id': build['id'], 'status': status, 'started_at': build['startTime'],
            'finished_at': build['finishTime'], 'execution_not_started': False, 'evidence_sha256': ledger.canonical_hash(build)}
        self.transaction('terminal', attempt_id, observation=observation)
        artifact = self.package_reader.evidence(details['admission']) if status == 'SUCCESS' and details['stage'] == 'package' else None
        # Publisher Build SUCCESS accounts execution only. Root+HTTPS+Deployment
        # proof remains exclusively the worker/installed-reader's responsibility.
        proof = ledger.canonical_hash({'details': details, 'native': build, 'artifact': artifact})
        self.transaction('reconcile', attempt_id, evidence_sha256=proof, native_verified=True)
        return {'state': details['stage'].upper() + ('_EXECUTION_SUCCEEDED' if status == 'SUCCESS' else '_FAILED'),
            'attempt_id': attempt_id, 'build_id': build['id'], 'evidence_sha256': proof, 'artifact': artifact,
            'deployment_proven': False}
