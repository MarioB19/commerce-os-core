"""Ordered installation effects, reachable only from the canonical Root hook.

The supplied host adapter authenticates native FULL/package, the fresh backup
and restore, the same operating adoption/plan and all four locks on every fence.
This runner is not a CLI, an approval parser, or a standalone authority.
"""
import hashlib
import json

from ci_release import require
import runtime_boot_install as bundle_tools


def sealed(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)+'\n').encode()


def run(adapter, bundle, policy_raw):
    """Unknown prior effects are read-only reconciled, never blindly repeated."""
    require(type(bundle) is dict and set(bundle) == {'sources.json', 'tools', bundle_tools.UNIT, 'activation'}
            and set(bundle['tools']) == bundle_tools.FILES
            and bundle['activation'] == 'DISABLED_PENDING_NATIVE_FULL', 'BOOT_INSTALL_BUNDLE_INVALID')
    policy = json.loads(policy_raw)
    require(type(policy) is dict and type(policy_raw) is bytes and policy_raw == sealed(policy),
            'BOOT_INSTALL_POLICY_NONCANONICAL')
    context = {'manifest_sha256': hashlib.sha256(bundle['sources.json']).hexdigest(),
        'policy_sha256': hashlib.sha256(policy_raw).hexdigest(),
        'unit_sha256': hashlib.sha256(bundle[bundle_tools.UNIT]).hexdigest()}
    # Adapter validates authority before journal creation; the following fence
    # also runs after every successful intent CAS, immediately before dispatch.
    adapter.authorize(context, policy)
    journal = adapter.open_journal(context)
    require(journal['context'] == context, 'BOOT_INSTALL_JOURNAL_CHANGED')
    actions = [('directory', name, None) for name in ('base', 'tools', 'boots')]
    actions += [('file', 'tools/'+name, raw) for name, raw in sorted(bundle['tools'].items())]
    actions += [('file', 'sources.json', bundle['sources.json']), ('file', 'policy.json', policy_raw),
                ('unit-file', bundle_tools.UNIT, bundle[bundle_tools.UNIT]),
                ('reload', 'systemd', None)]
    actions += [('enable', name, None) for name in ('containerd.service', 'docker.service', bundle_tools.UNIT)]
    allowed = {kind+':'+name for kind, name, _ in actions}
    require(set(journal['actions']) <= allowed, 'BOOT_INSTALL_ACTION_SCOPE_CHANGED')
    for kind, name, raw in actions:
        action = kind+':'+name
        payload = {'kind': kind, 'name': name, 'sha256': None if raw is None else hashlib.sha256(raw).hexdigest()}
        previous = journal['actions'].get(action)
        if previous is not None:
            require(previous['payload'] == payload and previous['status'] in {'INTENT', 'CONFIRMED'},
                    'BOOT_INSTALL_ACTION_CHANGED')
            # Readback must also verify custody/ownership, not just path existence.
            require(adapter.confirm(kind, name, raw), 'BOOT_INSTALL_UNKNOWN_NO_RETRY')
        elif adapter.confirm(kind, name, raw):
            # A pre-existing exact target needs no mutation. Still record its
            # observation durably so the final report has a complete manifest.
            adapter.observe_action(action, payload)
        else:
            adapter.commit_intent(action, payload)
            adapter.authorize(context, policy)
            failed = None
            try: adapter.dispatch_once(kind, name, raw)
            except Exception as error: failed = type(error).__name__
            if not adapter.confirm(kind, name, raw):
                adapter.unknown(action, failed)
                raise RuntimeError('BOOT_INSTALL_UNKNOWN_NO_RETRY')
        adapter.confirm_action(action, payload)
        journal = adapter.read_journal()
        require(journal['context'] == context, 'BOOT_INSTALL_JOURNAL_CHANGED')
    adapter.authorize(context, policy)
    # Recheck every postcondition together; prior confirmed observations can
    # become stale while later commands run. No terminal claim until all agree.
    require(all(adapter.confirm(kind, name, raw) for kind, name, raw in actions),
            'BOOT_INSTALL_FINAL_READBACK_CHANGED')
    return adapter.complete({'status': 'HOST_BOOT_INSTALLED_REBOOT_NOT_VERIFIED',
        'context': context, 'container_starts': 0, 'sessions_started': 0,
        'core_policy': 'ADOPTED_UNLESS_STOPPED_UNCHANGED', 'reboot_verified': False})
