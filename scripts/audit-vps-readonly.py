#!/usr/bin/env python3
"""Run on the approved VPS with sudo. Read-only, allowlisted output; no raw logs or secrets."""
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess


def command(args, input_text=None):
    result = subprocess.run(args, input=input_text, text=True, capture_output=True, timeout=30, check=False)
    if result.returncode:
        raise RuntimeError('READ_COMMAND_FAILED_' + re.sub('[^A-Z_]', '', Path(args[0]).name.upper()))
    return result.stdout


def env_file(path):
    if not path.is_file():
        return {}
    return dict(line.split('=', 1) for line in path.read_text().splitlines() if line and not line.startswith('#') and '=' in line)


def flags(values):
    return {key: values.get(key, 'UNSET') if values.get(key, 'UNSET') in ('true', 'false', 'UNSET') else 'INVALID'
            for key in ('DISPATCH_FROZEN', 'REAL_SENDS_ENABLED', 'ALLOW_REAL_OPERATIONS', 'ALLOW_CHANNEL_ONBOARDING')}


if os.geteuid() != 0:
    raise SystemExit('Run the read-only inventory through the existing authorized sudo access.')
root = Path('/opt/commerce-os')
private = root / 'private'
release_env = env_file(private / 'release.env')
pilot_env = env_file(private / 'pilot/pilot-release.env')
allowed_names = ['commerce-os-' + name + '-1' for name in ['api', 'web', 'ingress', 'automation-worker', 'channel-worker', 'postgres', 'waha-01']]
allowed_names += ['vibe-conversa-app-1', 'vibe-conversa-caddy-1']
containers = []
for name in allowed_names:
    raw = subprocess.run(['docker', 'inspect', name], text=True, capture_output=True, check=False)
    if raw.returncode:
        containers.append({'name': name, 'exists': False})
        continue
    value = json.loads(raw.stdout)[0]
    environment = dict(item.split('=', 1) for item in value['Config'].get('Env', []) if '=' in item)
    containers.append({'name': name, 'exists': True, 'status': value['State']['Status'],
                       'health': value['State'].get('Health', {}).get('Status'),
                       'started_at': value['State'].get('StartedAt'), 'image_id': value['Image'],
                       'compose_files': value['Config'].get('Labels', {}).get('com.docker.compose.project.config_files'),
                       'networks': sorted(value['NetworkSettings']['Networks']),
                       'public_ports': bool(value['HostConfig'].get('PortBindings')),
                       'runtime_flags': flags(environment),
                       'gateway_configured': all(environment.get(key) for key in ['WAHA_01_URL', 'WAHA_01_API_KEY', 'WAHA_01_WEBHOOK_SECRET']) if 'channel-worker' in name else None})

database_sql = """SELECT json_build_object(
 'migrations',(SELECT count(*) FROM schema_migrations),
 'real_channel_accounts',(SELECT coalesce(json_agg(json_build_object(
   'provider',body->>'provider','status',body->>'status','sending_enabled',body->>'sending_enabled',
   'expected_gateway_ref',coalesce(body->>'gateway_ref','WAHA')='WAHA_01',
   'identity_verified',body->>'identity_verified')), '[]'::json) FROM records WHERE kind='channel_account' AND environment='REAL'),
 'real_commands',(SELECT count(*) FROM commands WHERE environment='REAL' AND kind='channel_command'),
 'real_outbox',(SELECT count(*) FROM outbox WHERE environment='REAL'),
 'inflight_or_unknown',(SELECT count(*) FROM outbox WHERE status IN ('SENDING','UNKNOWN')),
 'workspace_frozen',(SELECT coalesce(bool_and(paused),false) FROM manual_controls WHERE scope_type='workspace')
);"""
database = json.loads(command(['docker', 'exec', '-i', 'commerce-os-postgres-1', 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'commerce_owner', '-d', 'commerce'], database_sql))
known_statuses = {'NEW', 'DISCONNECTED', 'CONNECTED', 'STOPPED', 'STARTING', 'SCAN_QR_CODE', 'WORKING', 'FAILED', 'UNKNOWN', 'PASSKEY_REQUIRED', 'PASSKEY_CONFIRMATION_REQUIRED'}
for account in database.get('real_channel_accounts', []):
    account['provider'] = account['provider'] if account['provider'] in ('waha', 'cloud', 'simulator') else 'UNKNOWN'
    account['status'] = account['status'] if account['status'] in known_statuses else 'UNKNOWN'
    for field in ('sending_enabled', 'identity_verified'):
        account[field] = account[field] == 'true' if account[field] in ('true', 'false') else None
gateway_js = r"""
(async()=>{
 const base=process.env.WAHA_01_URL,key=process.env.WAHA_01_API_KEY;
 if(!base||!key){console.log(JSON.stringify({configured:false}));return;}
 const read=async path=>{const r=await fetch(base.replace(/\/$/,'')+path,{headers:{'X-Api-Key':key},redirect:'error',signal:AbortSignal.timeout(10000)});return{http_status:r.status,data:r.ok?await r.json():null};};
 const sessions=await read('/api/sessions?all=true'),version=await read('/api/server/version');
 const known=['STOPPED','STARTING','SCAN_QR_CODE','WORKING','FAILED','PASSKEY_REQUIRED','PASSKEY_CONFIRMATION_REQUIRED'];
 console.log(JSON.stringify({configured:true,sessions_http_status:sessions.http_status,sessions:Array.isArray(sessions.data)?sessions.data.map(s=>({status:known.includes(s.status)?s.status:'UNKNOWN',identity_present:!!s.me?.id})):null,version_http_status:version.http_status,version:typeof version.data?.version==='string'&&/^\d{4}\.\d+\.\d+$/.test(version.data.version)?version.data.version:'UNKNOWN',engine:['GOWS','NOWEB','WEBJS'].includes(version.data?.engine)?version.data.engine:'UNKNOWN'}));
})().catch(()=>{console.log(JSON.stringify({error:'GATEWAY_READ_UNAVAILABLE'}));process.exitCode=1;});
"""
gateway = json.loads(command(['docker', 'exec', 'commerce-os-channel-worker-1', 'node', '-e', gateway_js]))
backups = sorted((private / 'backups').glob('*.backup.aes'), key=lambda path: path.stat().st_mtime)
newest = backups[-1] if backups else None
disk = shutil.disk_usage(root)
print(json.dumps({'measured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'mode': 'VPS read-only; no lifecycle/QR request/backup/deployment',
                  'current_release': str((root / 'current').resolve()),
                  'private_core_config_present': (private / 'release.env').is_file(),
                  'pilot_overlay_config_present': (private / 'pilot/pilot-release.env').is_file(),
                  'pilot_config_path_matches': pilot_env.get('COMMERCE_GATEWAY_CONFIG_DIR') == '/opt/commerce-os/private/pilot',
                  'origin_matches': release_env.get('COMMERCE_ORIGIN') == 'https://commerce-os.inovaris.online',
                  'images': {key: value for key, value in release_env.items() if key in ['COMMERCE_IMAGE', 'COMMERCE_WEB_IMAGE', 'COMMERCE_MAINTENANCE_IMAGE'] and re.fullmatch(r'sha256:[a-f0-9]{64}', value)},
                  'channel_file_flags': flags(env_file(private / 'channel.env')),
                  'containers': containers, 'database': database, 'gateway': gateway,
                  'latest_backup': {'name': newest.name, 'bytes': newest.stat().st_size,
                                    'modified_at': datetime.datetime.fromtimestamp(newest.stat().st_mtime, datetime.timezone.utc).isoformat()} if newest else None,
                  'disk_free_bytes': disk.free, 'production_mutations': 0}, indent=2))
