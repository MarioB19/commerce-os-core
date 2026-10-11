#!/usr/bin/env python3
"""Validate sanitized audit-vps-readonly.py output locally; does not connect to a server."""
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text())
containers = {item['name']: item for item in report['containers']}
core = ['api', 'web', 'ingress', 'automation-worker', 'channel-worker', 'postgres']
runtime = ['api', 'automation-worker', 'channel-worker']
checks = {}
checks['current_release_r4'] = report['current_release'].endswith('/20260906-audit-r4')
checks['sixteen_migrations'] = report['database']['migrations'] == 16
checks['core_healthy'] = all(containers.get('commerce-os-' + service + '-1', {}).get('health') == 'healthy' and containers['commerce-os-' + service + '-1']['status'] == 'running' for service in core)
checks['runtime_frozen'] = all(all(containers['commerce-os-' + service + '-1']['runtime_flags'].get(key) == value for key, value in {'DISPATCH_FROZEN': 'true', 'REAL_SENDS_ENABLED': 'false', 'ALLOW_REAL_OPERATIONS': 'false'}.items()) for service in runtime)
checks['channel_onboarding_enabled'] = containers['commerce-os-channel-worker-1']['runtime_flags']['ALLOW_CHANNEL_ONBOARDING'] == 'true'
checks['onboarding_channel_only'] = all(containers['commerce-os-' + service + '-1']['runtime_flags']['ALLOW_CHANNEL_ONBOARDING'] in ('false', 'UNSET') for service in ['api', 'automation-worker'])
checks['pilot_overlay_preserved'] = report['pilot_overlay_config_present'] and report['pilot_config_path_matches'] and all('pilot.yaml' in (containers['commerce-os-' + service + '-1'].get('compose_files') or '') and 'commerce-os_gateway-01' in containers['commerce-os-' + service + '-1']['networks'] for service in ['channel-worker', 'ingress'])
checks['gateway_private'] = containers.get('commerce-os-waha-01-1', {}).get('exists') is True and containers['commerce-os-waha-01-1']['public_ports'] is False
checks['gateway_read_ready'] = report['gateway'].get('configured') is True and report['gateway'].get('sessions_http_status') == 200
checks['real_account_isolated'] = any(account.get('provider') == 'waha' and account.get('expected_gateway_ref') and account.get('sending_enabled') is not True for account in report['database']['real_channel_accounts'])
checks['zero_inflight_or_unknown'] = report['database']['inflight_or_unknown'] == 0
checks['backup_present'] = bool((report.get('latest_backup') or {}).get('bytes', 0))
checks['no_remote_mutation_by_inventory'] = report['production_mutations'] == 0
print(json.dumps({'passed': all(checks.values()), 'checks': checks, 'observations': {'workspace_control_paused': report['database']['workspace_frozen']}, 'source_measured_at': report['measured_at'], 'limitations': ['Compare image IDs and backup timestamp with the approved release and pre-update inventory separately.', 'Migration count is checked; migration checksums remain the installer migration runner responsibility.', 'Workspace controls are optional additional pauses shared across environments; the three runtime flags above are mandatory for the REAL dispatch freeze.']}, indent=2))
sys.exit(0 if all(checks.values()) else 1)
