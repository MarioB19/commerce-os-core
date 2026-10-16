"""Pure boot decisions; only a protected Root adapter may supply observations.

This module neither authenticates files nor executes Docker. A shape-valid policy
is not authorization. The adapter must verify Root custody, its exact references,
host identity and locks before using any returned decision.
"""
import re
import uuid

import copy_runtime_deployment as runtime
from ci_release import require

ADOPTION = '/opt/commerce-os/private/api-web-adoption.json'
PLAN = '/opt/commerce-os/private/daily-b02/plan.json'
POLICY_FIELDS = {'schema_version', 'host_id', 'adoption_ref', 'plan_ref',
                 'gateway_start_ids', 'sessions_autostart'}


def healthy(row):
    live = runtime.live_projection(row)
    require(live['Running'] and row['State'].get('OOMKilled') is False,
            'BOOT_PROCESS_NOT_HEALTHY')
    configured = row['Config'].get('Healthcheck', {}).get('Test')
    status = row['State'].get('Health', {}).get('Status')
    require(status in (None, 'healthy') and
            (not configured or configured == ['NONE'] or status == 'healthy'),
            'BOOT_PROCESS_NOT_HEALTHY')


def validate_policy(policy, *, host_id, adoption_raw, plan_raw, rows):
    require(type(policy) is dict and set(policy) == POLICY_FIELDS and
            type(policy['schema_version']) is int and policy['schema_version'] == 1,
            'BOOT_POLICY_INVALID')
    require(type(host_id) is str and re.fullmatch(r'[1-9][0-9]{0,19}', host_id)
            and policy['host_id'] == host_id and policy['sessions_autostart'] is False,
            'BOOT_HOST_OR_SESSION_POLICY_CHANGED')
    runtime.reference(policy['adoption_ref'], ADOPTION)
    runtime.reference(policy['plan_ref'], PLAN)
    runtime.readback(policy['adoption_ref'], adoption_raw)
    runtime.readback(policy['plan_ref'], plan_raw)
    state = runtime._parse(adoption_raw)
    runtime.validate_state(state)
    require(state['runtime_stage'] == 'OPERATING', 'BOOT_OPERATING_REQUIRED')
    runtime.validate_plan(state, plan_raw)
    services = runtime.validate_inventory(state, rows)
    gateways = policy['gateway_start_ids']
    require(type(gateways) is dict and set(gateways) <= runtime.GATEWAYS and
            all(name in services and services[name]['Id'] == cid
                for name, cid in gateways.items()), 'BOOT_GATEWAY_SCOPE_CHANGED')
    for name in runtime.CORE:
        healthy(services[name])
    # Every gateway, including excluded/stopped ones, already passed the existing
    # private network, immutable image and no-session-autostart contract above.
    return services


def validate_journal(journal, *, boot_id, policy_sha256, allowed):
    try:
        parsed = uuid.UUID(boot_id)
    except (ValueError, TypeError, AttributeError):
        raise runtime.ReleaseError('BOOT_ID_INVALID') from None
    require(str(parsed) == boot_id and parsed.version == 4, 'BOOT_ID_INVALID')
    require(runtime._hash(policy_sha256), 'BOOT_POLICY_DIGEST_INVALID')
    require(type(journal) is dict and set(journal) ==
            {'schema_version', 'boot_id', 'policy_sha256', 'gateways'} and
            type(journal['schema_version']) is int and journal['schema_version'] == 1
            and journal['boot_id'] == boot_id and journal['policy_sha256'] == policy_sha256,
            'BOOT_JOURNAL_IDENTITY_CHANGED')
    require(type(journal['gateways']) is dict and
            set(journal['gateways']) <= set(allowed), 'BOOT_JOURNAL_SCOPE_CHANGED')
    for name, item in journal['gateways'].items():
        require(type(item) is dict and set(item) == {'container_id', 'status'} and
                item['container_id'] == allowed[name] and
                item['status'] in {'START_INTENT', 'RUNNING'}, 'BOOT_JOURNAL_INVALID')


def decisions(policy, *, host_id, adoption_raw, plan_raw, rows, journal, boot_id):
    services = validate_policy(policy, host_id=host_id, adoption_raw=adoption_raw,
                               plan_raw=plan_raw, rows=rows)
    validate_journal(journal, boot_id=boot_id,
        policy_sha256=runtime.sha256(runtime.sealed_bytes(policy)),
        allowed=policy['gateway_start_ids'])
    result = []
    for name, cid in sorted(policy['gateway_start_ids'].items()):
        row = services[name]
        previous = journal['gateways'].get(name)
        if row['State']['Running']:
            healthy(row)
            action = 'RECONCILE_RUNNING' if previous else 'OBSERVE_RUNNING'
        else:
            require(previous is None, 'BOOT_START_UNCERTAIN_OR_ALREADY_CONSUMED')
            action = 'PERSIST_INTENT_THEN_START_ONCE'
        result.append({'service': name, 'container_id': cid, 'action': action})
    return result
