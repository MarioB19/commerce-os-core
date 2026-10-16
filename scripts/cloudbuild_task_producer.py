"""Pure task composition from already authenticated operator custody inputs.

No network, credentials, effects, clock refresh or trust assertion is introduced.
Review/economic inputs must be authenticated by the protected installer before
using this module; matching hashes alone never prove that external review.
"""
from copy import deepcopy
from datetime import timedelta
import uuid

import cloudbuild_admission as ledger
import cloudbuild_attestation as gate
from cloudbuild_connected_source import REPOSITORY_ID, validate_approval as source_approval
from cloudbuild_controller import manifest_for_uuid
from cloudbuild_full_evidence import REPOSITORY, need, validate_manifest
from cloudbuild_github_reader import validate_event
from cloudbuild_runtime import validate_task, location

MAX_TTL = timedelta(hours=4)


def window(expires_at, moment):
    now = ledger.utc(moment); expiry = ledger.timestamp(expires_at)
    need(now < expiry <= now + MAX_TTL, 'TASK_PRODUCER_WINDOW_INVALID')
    return expiry


def paused_control(*, expires_at, moment):
    window(expires_at, moment)
    return {'schema_version': 1, 'mode': 'paused', 'expires_at': expires_at, 'task': None}


def full_plan(event, *, event_id, build_config, verifier_image, runner_sha256, workflow_sha256):
    validate_event(event)
    plan = {'identity': {k: event[k] for k in ('repository_id', 'source_sha', 'source_tree')},
            'stage': 'full', 'timeout_seconds': 5700, 'queue_seconds': 600,
            'config_sha256': ledger.canonical_hash(build_config),
            'verifier_sha256': verifier_image.rsplit(':', 1)[-1],
            'runner_sha256': runner_sha256, 'workflow_sha256': workflow_sha256}
    plan['identity']['event_id'] = event_id
    ledger.validate_plan(plan)
    # Validate all fixed template fields with a local shape-only placeholder.
    # No placeholder Build identity or storage locator escapes this function.
    shape = {'schema_version': 1, 'repository': REPOSITORY,
             'project': gate.PROJECT, 'region': 'us-east1',
             'source_sha': event['source_sha'], 'source_tree': event['source_tree'],
             'archive_sha256': '0' * 64, 'storage_source': {'bucket': 'shape-only', 'object': 'shape.tgz', 'generation': '1'},
             'verifier_image': verifier_image, 'runner_sha256': runner_sha256,
             'workflow_sha256': workflow_sha256, 'build_config': deepcopy(build_config),
             'build_config_sha256': plan['config_sha256']}
    manifest_for_uuid(shape, str(uuid.UUID(int=0)))
    return plan


def authorization(plan, *, review_sha256, economic, expires_at, moment):
    ledger.validate_plan(plan); expiry = window(expires_at, moment)
    ledger.exact(economic, 'inventory_sha256 expires_at projected_gross_microusd credit_verified inventory_complete',
                 'TASK_PRODUCER_ECONOMIC_FIELDS_INVALID')
    need(expiry <= window(economic['expires_at'], moment), 'TASK_PRODUCER_ECONOMIC_WINDOW')
    approval = {'plan_sha256': ledger.canonical_hash(plan), 'review_sha256': ledger.digest(review_sha256),
                'expires_at': expires_at}
    admission = {**deepcopy(economic), 'approval_sha256': ledger.canonical_hash(approval)}
    # Never silently extend or truncate an adopted economic authorization.
    ledger.validate_approval(approval, plan, ledger.utc(moment))
    ledger.validate_admission(admission, ledger.utc(moment), approval)
    return {'plan': deepcopy(plan), 'approval': approval, 'admission': admission}


def task(operation, phase, attempt_id, event, authorized, payload, *, expires_at, moment):
    ledger.exact(authorized, 'plan approval admission', 'TASK_PRODUCER_AUTHORIZATION_FIELDS_INVALID')
    expiry = window(expires_at, moment)
    need(expiry <= ledger.timestamp(authorized['approval']['expires_at'])
         and expiry <= ledger.timestamp(authorized['admission']['expires_at']), 'TASK_PRODUCER_AUTHORIZATION_WINDOW')
    ledger.validate_approval(authorized['approval'], authorized['plan'], ledger.utc(moment))
    ledger.validate_admission(authorized['admission'], ledger.utc(moment), authorized['approval'])
    value = {'schema_version': 1, 'operation': operation, 'phase': phase, 'attempt_id': attempt_id,
             **deepcopy(authorized), 'event': deepcopy(event), 'payload': deepcopy(payload), 'expires_at': expires_at}
    validate_task(value, lambda: ledger.utc(moment))
    return value


def source_task(attempt_id, event, authorized, journal, *, custody, expires_at, moment, reconcile=False):
    location(journal)
    ledger.exact(custody, 'bucket prefix', 'TASK_PRODUCER_CUSTODY_FIELDS_INVALID')
    need(journal['bucket'] == custody['bucket'] and journal['object'] ==
         custody['prefix'] + '/source-journals/' + ledger.native_uuid(attempt_id) + '.json',
         'TASK_PRODUCER_SOURCE_JOURNAL_CHANGED')
    plan = authorized['plan']
    approval = {'repository_id': REPOSITORY_ID, 'repository': REPOSITORY,
                **{k: plan['identity'][k] for k in ('source_sha', 'source_tree')},
                **{k: plan[k] for k in ('runner_sha256', 'workflow_sha256')},
                'expires_at': authorized['approval']['expires_at'],
                'review_sha256': authorized['approval']['review_sha256']}
    source_approval(approval, now=ledger.utc(moment))
    return task('SOURCE', 'RECONCILE' if reconcile else 'ACQUIRE', attempt_id, event, authorized,
                {'source_approval': approval, 'journal': deepcopy(journal)}, expires_at=expires_at, moment=moment)


def full_task(phase, attempt_id, event, authorized, *, proposal=None, expires_at, moment):
    need(phase in {'ADMIT', 'DISPATCH', 'RECONCILE'}, 'TASK_PRODUCER_FULL_PHASE_INVALID')
    payload = {}
    if phase != 'ADMIT':
        manifest_for_uuid(proposal, str(uuid.UUID(int=0)))
        p = authorized['plan']
        need(p['stage'] == 'full' and all(p['identity'][k] == proposal[k] for k in ('source_sha', 'source_tree'))
             and p['config_sha256'] == proposal['build_config_sha256']
             and p['verifier_sha256'] == proposal['verifier_image'].rsplit(':', 1)[1]
             and all(p[k] == proposal[k] for k in ('runner_sha256', 'workflow_sha256')),
             'TASK_PRODUCER_PROPOSAL_PLAN_CHANGED')
        payload = {'proposal': deepcopy(proposal)}
    else:
        need(proposal is None, 'TASK_PRODUCER_ADMIT_HAS_NO_SOURCE_YET')
    return task('RECONCILE_FULL' if phase == 'RECONCILE' else 'DISPATCH_FULL', phase,
                attempt_id, event, authorized, payload, expires_at=expires_at, moment=moment)


def attestation_plan(event, *, event_id, contract, driver_sha256, workflow_sha256):
    validate_event(event); gate.validate_contract(contract)
    need(all(event[k] == contract[k] for k in ('repository_id', 'source_sha', 'source_tree')),
         'TASK_PRODUCER_GATE_EVENT_CHANGED')
    result = {'identity': {k: event[k] for k in ('repository_id', 'source_sha', 'source_tree')},
              'stage': 'attestation', 'timeout_seconds': 120, 'queue_seconds': 14400,
              'config_sha256': ledger.canonical_hash(gate.template(contract['image'])),
              'verifier_sha256': contract['image'].rsplit(':', 1)[1],
              'runner_sha256': driver_sha256, 'workflow_sha256': workflow_sha256}
    result['identity']['event_id'] = event_id; ledger.validate_plan(result)
    return result


def attestation_task(phase, attempt_id, event, authorized, *, full_attempt_id, full_manifest,
                     contract, native_build, document, project_number, expires_at, moment):
    need(phase in {'ADMIT', 'APPROVE', 'RUN', 'RECONCILE'}, 'TASK_PRODUCER_GATE_PHASE_INVALID')
    gate.full_reconciled(document, full_attempt_id, full_manifest, contract)
    gate.validate_native_gate(contract, native_build, project_number, require_pending=phase in {'ADMIT', 'APPROVE'})
    p = authorized['plan']
    ledger.validate_gate(gate.gate_binding(contract), p)
    need(p['stage'] == 'attestation' and p['config_sha256'] == ledger.canonical_hash(gate.template(contract['image']))
         and p['verifier_sha256'] == contract['image'].rsplit(':', 1)[1], 'TASK_PRODUCER_GATE_PLAN_CHANGED')
    payload = {'gate_attempt_id': attempt_id, 'full_attempt_id': full_attempt_id,
               'full_manifest': deepcopy(full_manifest), 'contract': deepcopy(contract)}
    return task('ATTEST', phase, attempt_id, event, authorized, payload, expires_at=expires_at, moment=moment)
