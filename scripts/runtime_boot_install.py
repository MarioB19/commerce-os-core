"""Prepare a pinned boot bundle and consume the canonical Root admission.

No input boolean or locally manufactured receipt can open the installation gate.
This module has no CLI that changes systemd or production files.
"""
import hashlib
import importlib.util
from pathlib import Path
import re
import stat

from ci_release import require
import copy_runtime_deployment as runtime

BASE = Path('/opt/commerce-os/private/runtime-boot')
UNIT = 'commerce-runtime-boot.service'
FILES = frozenset({'runtime-boot.py', 'runtime_boot_host.py', 'runtime_boot_runner.py',
    'runtime_boot_policy.py', 'copy_runtime_deployment.py', 'api_web_deployment.py',
    'ci_release.py', 'ci_provider_evidence.py', 'mcl_portal_release.py', 'update-identity-proxy.py'})


def service_unit(manifest_sha256):
    require(type(manifest_sha256) is str and re.fullmatch('[a-f0-9]{64}', manifest_sha256), 'BOOT_MANIFEST_HASH_REQUIRED')
    return ('[Unit]\nDescription=Commerce exact gateway server boot\n'
        'Requires=docker.service\nAfter=containerd.service docker.service network-online.target\n'
        'Wants=network-online.target\nStartLimitIntervalSec=0\n\n'
        '[Service]\nType=oneshot\nUser=root\nGroup=root\nUMask=0077\n'
        'ExecStart=/usr/bin/python3 -I ' + str(BASE / 'tools/runtime-boot.py') + ' ' + manifest_sha256 + '\n'
        'TimeoutStartSec=315\nTimeoutStopSec=5\nRestart=no\nRemainAfterExit=yes\n'
        'NoNewPrivileges=yes\nPrivateTmp=yes\nProtectHome=yes\nProtectSystem=strict\n'
        'ReadWritePaths=' + str(BASE / 'boots') + ' ' +
        ' '.join(str(BASE.parent / name) for name in runtime.native.LOCKS) + '\n'
        'StandardOutput=journal\nStandardError=journal\n\n'
        '[Install]\nWantedBy=multi-user.target\n').encode()


def prepare(source_root, source_sha):
    """Pure bundle bytes; candidate authenticity must come from native FULL."""
    require(type(source_sha) is str and re.fullmatch('[a-f0-9]{40}', source_sha), 'BOOT_SOURCE_SHA_REQUIRED')
    source_root = Path(source_root); files = {}
    for name in sorted(FILES):
        path = source_root / 'scripts' / name; info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= 1024 * 1024,
                'BOOT_BUNDLE_SOURCE_INVALID')
        raw = path.read_bytes()
        require(len(raw) == info.st_size, 'BOOT_BUNDLE_SOURCE_CHANGED'); files[name] = raw
    manifest = runtime.sealed_bytes({'schema_version': 1, 'source_sha': source_sha,
        'files': {name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()}})
    return {'sources.json': manifest, 'tools': files,
            UNIT: service_unit(hashlib.sha256(manifest).hexdigest()), 'activation': 'DISABLED_PENDING_NATIVE_FULL'}


def install(server, root, report_dir, before, report, state_raw, plan_raw, backup, locks, deadline):
    """No standalone CLI; the OPERATING publisher retains all four locks."""
    import runtime_boot_install_host as native
    import runtime_boot_install_runner as runner
    import runtime_boot_admission_host as admission
    admission.prepare(server, root, report_dir, before, report, state_raw, plan_raw, backup, locks, deadline)
    adapter = native.Installer(server, root, report_dir, report, before,
        state_raw, plan_raw, backup, locks, deadline)
    bundle = prepare(root, report['source_sha'])
    approval = adapter.approval
    policy = {'schema_version': 1, 'host_id': approval['host_id'],
        'adoption_ref': runtime.native.reference('/opt/commerce-os/private/api-web-adoption.json', state_raw),
        'plan_ref': runtime.native.reference('/opt/commerce-os/private/daily-b02/plan.json', plan_raw),
        'gateway_start_ids': approval['gateway_start_ids'], 'sessions_autostart': False}
    return runner.run(adapter, bundle, runtime.sealed_bytes(policy))


def gateway_admission(server, root, report_dir, before, services, report, locks, deadline):
    from runtime_boot_install_host import GatewayPolicy
    return GatewayPolicy(server, root, report_dir, before, services, report, locks, deadline)


def gateway_replay(server, root, report_dir, actual, report):
    """A completed adoption replay also authenticates the current boot policy."""
    from runtime_boot_install_host import installed_bundle
    import runtime_boot_policy as policy
    import runtime_boot_host as host
    prior = installed_bundle(actual, source_sha=report['source_sha'], root=root)
    require(prior['completion'] == report.get('host_boot'), 'BOOT_GATEWAY_REPLAY_RECEIPT_CHANGED')
    policy.validate_policy(runtime._parse(prior['files']['policy.json']), host_id=host.native_host_id(),
        adoption_raw=actual['state_raw'], plan_raw=actual['plan_raw'], rows=list(actual['services'].values()))
    return prior['completion']


def gateway_recover(server, root, report_dir, actual, report, locks, deadline, manifest):
    """Only finish metadata after an exact readback of an earlier policy intent."""
    import base64
    from runtime_boot_install_host import GatewayPolicy
    import runtime_boot_host as host
    journal = runtime._parse(host.protected(Path(report_dir)/'host-boot-install.json'))
    require(set(journal) == {'schema_version', 'context', 'installation_ref', 'admission_ref',
        'previous_policy_sha256', 'before_state', 'before_plan', 'previous_policy', 'policy', 'actions'}
        and journal['schema_version'] == 1 and set(journal['actions']) == {'file:policy.json'}
        and journal['actions']['file:policy.json']['status'] in {'INTENT', 'CONFIRMED'},
        'BOOT_GATEWAY_RECOVERY_INTENT_REQUIRED')
    require(journal['admission_ref']['path'] == str(Path(report_dir)/'host-boot-gateway-admission.json'),
        'BOOT_GATEWAY_RECOVERY_ADMISSION_SCOPE')
    state_raw = base64.b64decode(journal['before_state'], validate=True)
    plan_raw = base64.b64decode(journal['before_plan'], validate=True)
    state = runtime._parse(state_raw); runtime.validate_state(state); runtime.validate_plan(state, plan_raw)
    require(runtime.sha256(state_raw) == manifest['before_adoption_sha256']
        and runtime.sha256(plan_raw) == manifest['before_plan_sha256'], 'BOOT_GATEWAY_RECOVERY_BASELINE_CHANGED')
    prior_runtime = runtime._parse(runtime.native.read_reference(manifest['runtime_before_ref']))
    services = runtime.validate_inventory(state, list(prior_runtime['services'].values()))
    require(services == prior_runtime['services'], 'BOOT_GATEWAY_RECOVERY_PRIOR_INVENTORY_CHANGED')
    policy_raw = base64.b64decode(journal['policy'], validate=True)
    require(host.protected(host.BASE/'policy.json') == policy_raw, 'BOOT_GATEWAY_UNKNOWN_NO_RETRY')
    before = {'state': state, 'state_raw': state_raw, 'plan_raw': plan_raw, 'services': services,
        'workspace': state['owner_workspace_id'],
        'policy': runtime.current_policy(server, root, state['owner_workspace_id'])}
    adapter = GatewayPolicy(server, root, report_dir, before, actual['services'], report, locks, deadline, recovery=journal)
    with runtime.reviewed_backup_module(manifest['backup_tools_manifest_ref'], root, report['source_sha']) as backup:
        return adapter.apply(actual['state_raw'], actual['plan_raw'], backup)
