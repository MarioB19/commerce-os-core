"""Effect ordering for the protected host adapter. Never a standalone authority.

The adapter implements authenticated reads, locks, fsynced custody, bounded
Docker commands, and current native boot identity. A start intent is persisted
before dispatch and survives every exception, including ambiguous timeouts.
"""
import copy

import runtime_boot_policy as policy
from ci_release import require


def run(adapter):
    """Execute under all four publication/backup locks supplied by the adapter."""
    with adapter.locks():
        facts = adapter.observe()
        journal = adapter.read_journal(facts)
        operations = policy.decisions(**facts, journal=journal)
        for operation in operations:
            # Reread custody, definitions, network and health before each effect;
            # an earlier gateway result is not authority for a later container.
            current = adapter.observe()
            require(current['boot_id'] == facts['boot_id'] and
                    current['policy'] == facts['policy'] and
                    current['adoption_raw'] == facts['adoption_raw'] and
                    current['plan_raw'] == facts['plan_raw'] and
                    current['host_id'] == facts['host_id'], 'BOOT_ADOPTION_CHANGED')
            journal = adapter.read_journal(current)
            choices = policy.decisions(**current, journal=journal)
            chosen = next((v for v in choices if v['service'] == operation['service']), None)
            require(chosen is not None and chosen['container_id'] == operation['container_id'],
                    'BOOT_TARGET_CHANGED')
            name, cid = chosen['service'], chosen['container_id']
            if chosen['action'] == 'PERSIST_INTENT_THEN_START_ONCE':
                intent = copy.deepcopy(journal)
                intent['gateways'][name] = {'container_id': cid, 'status': 'START_INTENT'}
                adapter.compare_and_swap_journal(journal, intent)
                # Failure cannot clear the consumed intent or trigger a retry.
                adapter.start_once(cid)
                adapter.wait_healthy(cid)
            final = adapter.observe()
            require(all(final[k] == current[k] for k in
                        ('policy', 'adoption_raw', 'plan_raw', 'host_id', 'boot_id')),
                    'BOOT_ADOPTION_CHANGED')
            journal = adapter.read_journal(final)
            choices = policy.decisions(**final, journal=journal)
            observed = next(v for v in choices if v['service'] == name)
            require(observed['action'] in {'RECONCILE_RUNNING', 'OBSERVE_RUNNING'} and
                    observed['container_id'] == cid, 'BOOT_START_NOT_CONFIRMED')
            confirmed = copy.deepcopy(journal)
            confirmed['gateways'][name] = {'container_id': cid, 'status': 'RUNNING'}
            if confirmed != journal:
                adapter.compare_and_swap_journal(journal, confirmed)
        adapter.complete(facts['boot_id'])
        return {'status': 'HOST_GATEWAY_SERVERS_HEALTHY',
                'gateways': len(operations), 'sessions_started': 0}
