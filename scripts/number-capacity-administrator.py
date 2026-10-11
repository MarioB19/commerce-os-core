#!/usr/bin/env python3
"""Bounded host-side administrator. API has no Docker socket or executable input.
Private configuration: api_origin, token_file, release_env, gateway_dir, overlay.
Commands: measure | apply OPERATION_ID | reconcile OPERATION_ID. Never connects WhatsApp.
"""
import datetime as dt
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('additional_gateways', ROOT / 'scripts/additional-gateways.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def private_file(path):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError('PRIVATE_CONFIGURATION_REQUIRED')
    return path


def run(args, *, input=None):
    result = subprocess.run(args, cwd=ROOT, input=input, capture_output=True, text=True, timeout=120, check=False)
    if result.returncode:
        raise RuntimeError('BOUNDED_HOST_COMMAND_FAILED')
    return result.stdout


def private_env(path):
    """Bounded immutable read; credential values never enter logs or command argv."""
    path=private_file(path)
    identity=lambda info:(info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns,info.st_uid,info.st_mode,info.st_nlink)
    def custody(info):
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.geteuid() or info.st_mode & 0o077:
            raise ValueError('PRIVATE_CREDENTIAL_CUSTODY_CHANGED')
    initial=path.lstat();custody(initial)
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as source:
        before=os.fstat(source.fileno());custody(before)
        if identity(initial)!=identity(before):raise ValueError('PRIVATE_CREDENTIAL_CUSTODY_CHANGED')
        raw=source.read(16385);after=os.fstat(source.fileno());custody(after)
    final=path.lstat();custody(final)
    if not 0<len(raw)<=16384 or identity(before)!=identity(after) or identity(after)!=identity(final):
        raise ValueError('PRIVATE_CREDENTIAL_CUSTODY_CHANGED')
    try:text=raw.decode('ascii')
    except UnicodeDecodeError:raise ValueError('PRIVATE_CREDENTIAL_FORMAT_INVALID') from None
    values={}
    for line in text.splitlines():
        if not line or line.startswith('#'):continue
        match=re.fullmatch(r'([A-Z][A-Z0-9_]*)=([ -~]*)',line)
        if not match or match[1] in values:raise ValueError('PRIVATE_CREDENTIAL_FORMAT_INVALID')
        values[match[1]]=match[2]
    return values


def secret_value(value):
    if not isinstance(value,str) or not re.fullmatch(r'[!-~]{1,512}',value):
        raise ValueError('PRIVATE_CREDENTIAL_INCOMPLETE')
    return value


SESSION_READBACK_JS = """
const fs=require('node:fs');
(async()=>{
 const raw=fs.readFileSync(0,'utf8');if(raw.length>4096)throw Error('INPUT');
 const input=JSON.parse(raw);if(!input||Object.keys(input).length!==1||typeof input.api_key!=='string'||input.api_key.length>512)throw Error('INPUT');
 const response=await fetch('http://127.0.0.1:3000/api/sessions?all=true',{headers:{'X-Api-Key':input.api_key},redirect:'error',signal:AbortSignal.timeout(10000)});
 input.api_key='';if(!response.ok)throw Error('HTTP');
 const sessions=await response.json();if(!Array.isArray(sessions))throw Error('SHAPE');
 process.stdout.write(JSON.stringify({count:sessions.length,connected:sessions.filter(s=>s&&s.status==='WORKING').length}));
})().catch(()=>process.exit(1));
"""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Administrator:
    def __init__(self, config):
        if not re.fullmatch(r'https://[A-Za-z0-9.:-]+', config['api_origin']):
            raise ValueError('HTTPS_ORIGIN_REQUIRED')
        self.config = config
        self.token = private_file(config['token_file']).read_text().strip()
        self.release = str(private_file(config['release_env']))
        self.directory = Path(config['gateway_dir'])
        if not self.directory.is_absolute() or self.directory.is_symlink():
            raise ValueError('PRIVATE_GATEWAY_DIRECTORY_REQUIRED')
        self.overlay = Path(config['overlay'])
        if not self.overlay.is_absolute() or self.overlay.is_symlink():
            raise ValueError('PRIVATE_OVERLAY_REQUIRED')

    def api(self, path, body=None, key=None, method=None):
        request = urllib.request.Request(self.config['api_origin'] + '/v1' + path + ('&' if '?' in path else '?') + 'environment=REAL',
            data=None if body is None else json.dumps(body).encode(), method=method or ('GET' if body is None else 'POST'),
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json', 'Idempotency-Key': key or str(uuid.uuid4())})
        # urllib's HTTPS handler validates the host certificate. No token or response is printed.
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
            return json.load(response)['data']

    def compose(self, *args):
        return run(['sh', str(ROOT / 'scripts/compose-release.sh'), self.release, *args])

    def require_gateway_absent(self, service):
        # An undeclared service can still own a stopped/orphaned container.
        # Inspect all projects so a foreign label/name/volume cannot become an
        # invented free slot. Never print this private Docker inventory.
        ids = run(['docker', 'ps', '--all', '--quiet', '--no-trunc']).strip().splitlines()
        if len(ids) != len(set(ids)) or any(not re.fullmatch(r'[a-f0-9]{64}', cid) for cid in ids):
            raise ValueError('GATEWAY_HOST_INVENTORY_REQUIRED')
        rows = json.loads(run(['docker', 'inspect', *ids])) if ids else []
        if not isinstance(rows, list) or len(rows) != len(ids) or {row.get('Id') for row in rows} != set(ids):
            raise ValueError('GATEWAY_HOST_INVENTORY_REQUIRED')
        volumes = {'commerce-os_' + service + suffix for suffix in ('-sessions', '-media')}
        for row in rows:
            labels = row['Config']['Labels'] or {}
            name = row['Name'].removeprefix('/')
            if (labels.get('com.docker.compose.service') == service
                    or name == service or re.fullmatch(r'commerce-os[-_]' + re.escape(service) + r'[-_][0-9]+', name)
                    or any(mount.get('Name') in volumes for mount in row['Mounts'])):
                raise ValueError('GATEWAY_CONFIGURATION_MISSING')
        raise ValueError('GATEWAY_NOT_PROVISIONED')

    def snapshot(self, slot):
        service = 'waha-' + str(slot).zfill(2)
        services = self.compose('config', '--services').strip().splitlines()
        if (not services or len(services) != len(set(services))
                or any(not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', name) for name in services)):
            raise ValueError('GATEWAY_COMPOSE_INVENTORY_REQUIRED')
        if service not in services:
            self.require_gateway_absent(service)
        ids = self.compose('ps', '--all', '-q', service).strip().splitlines()
        if not ids:self.require_gateway_absent(service)
        if len(ids) != 1 or not re.fullmatch(r'[a-f0-9]{12,64}', ids[0]):
            raise ValueError('GATEWAY_READBACK_REQUIRED')
        value = json.loads(run(['docker', 'inspect', ids[0]]))[0]
        mounts = {m.get('Destination'): m.get('Name') for m in value['Mounts']}
        if mounts.get('/app/.sessions') != 'commerce-os_' + service + '-sessions' or mounts.get('/app/.media') != 'commerce-os_' + service + '-media':
            raise ValueError('GATEWAY_VOLUME_CHANGED')
        if 'commerce-os_gateway-' + str(slot).zfill(2) not in value['NetworkSettings']['Networks']:
            raise ValueError('GATEWAY_NETWORK_MISSING')
        return value

    def credentials(self, slot, create=True):
        path = self.directory / ('waha-' + str(slot).zfill(2) + '.env')
        if not path.exists():
            if not create:
                raise ValueError('EXISTING_CREDENTIAL_REQUIRED')
            if slot == 1:
                raise ValueError('EXISTING_PILOT_REQUIRED')
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w') as target:
                target.write('WAHA_API_KEY=' + secrets.token_urlsafe(32) + '\nWHATSAPP_HOOK_HMAC_KEY=' + secrets.token_urlsafe(32) + '\n')
        values=private_env(path)
        key=secret_value(values.get('WAHA_API_KEY'))
        if slot==1:
            channel_path=self.directory/'channel-pilot.env';ingress_path=self.directory/'ingress-pilot.env'
            hashed=key.startswith('sha512:')
            if hashed or channel_path.exists() or ingress_path.exists():
                channel=private_env(channel_path);ingress=private_env(ingress_path)
                plaintext=secret_value(channel.get('WAHA_01_API_KEY'))
                hook=secret_value(channel.get('WAHA_01_WEBHOOK_SECRET'))
                ingress_hook=secret_value(ingress.get('WAHA_01_WEBHOOK_SECRET'))
                expected='sha512:'+hashlib.sha512(plaintext.encode('ascii')).hexdigest() if hashed else plaintext
                if not hmac.compare_digest(key,expected) or not hmac.compare_digest(hook,ingress_hook) or channel.get('WAHA_01_URL')!='http://waha-01:3000':
                    raise ValueError('PRIVATE_PILOT_CREDENTIAL_BINDING_CHANGED')
                if 'WHATSAPP_HOOK_HMAC_KEY' in values and not hmac.compare_digest(values['WHATSAPP_HOOK_HMAC_KEY'],hook):
                    raise ValueError('PRIVATE_PILOT_CREDENTIAL_BINDING_CHANGED')
                return {'WAHA_API_KEY':plaintext,'WHATSAPP_HOOK_HMAC_KEY':hook}
        if key.startswith('sha512:'):raise ValueError('PRIVATE_PILOT_PLAINTEXT_REQUIRED')
        return {'WAHA_API_KEY':key,'WHATSAPP_HOOK_HMAC_KEY':secret_value(values.get('WHATSAPP_HOOK_HMAC_KEY'))}

    def provisioning_overlay_digest(self):
        # Slot1 already exists. Its canonical pilot definition is a real digest;
        # an absent additional overlay is never a VERIFIED administration proof.
        return helper.digest(self.overlay if self.overlay.exists() else ROOT/'infra/compose/pilot.yaml')

    def readback(self, slot):
        value=self.snapshot(slot)
        if value['State'].get('Running') is not True:
            raise ValueError('GATEWAY_STOPPED_READBACK_REQUIRED')
        credentials=self.credentials(slot,create=False)
        # Fixed code + credential only through stdin/RAM, never Docker env/argv.
        sessions=json.loads(run(['docker','exec','-i',value['Id'],'node','-e',SESSION_READBACK_JS],
                               input=json.dumps({'api_key':credentials['WAHA_API_KEY']})))
        if type(sessions) is not dict or set(sessions)!={'count','connected'} or any(type(sessions[k]) is not int or sessions[k]<0 for k in sessions) or sessions['connected']>sessions['count']:
            raise ValueError('GATEWAY_SESSION_READBACK_INVALID')
        return {'slot':slot,'running':value['State']['Running'],'session_count':sessions['count'],'connected_sessions':sessions['connected'],
                'image_digest':value['Image'],'network_present':True,'volumes_preserved':True}

    def measure(self):
        # The administrative production component targets the Linux Compose host.
        mem = dict((k, int(v.strip().split()[0]) * 1024) for k, v in (line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines()))
        cpus = os.cpu_count() or 1
        def cpu_sample():
            return [int(x) for x in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
        first = cpu_sample()
        time.sleep(0.25)
        second = cpu_sample()
        delta = [b-a for a, b in zip(first, second)]
        busy = 1 - (delta[3] + delta[4]) / max(1, sum(delta))
        available = os.statvfs(self.directory)
        slots = self.api('/number-capacity?limit=100')['slots']
        readback = []
        for s in slots:
            try:
                readback.append(self.readback(s['slot']))
            except ValueError as error:
                if str(error)!='GATEWAY_NOT_PROVISIONED':raise
        memory = 0
        for item in readback:
            container = self.snapshot(item['slot'])['Id']
            value = json.loads(run(['docker','stats','--no-stream','--format','{{json .}}',container]))
            match = re.fullmatch(r'([0-9.]+)([KMGT]?i?B)', value['MemUsage'].split('/')[0].strip())
            if not match:
                raise ValueError('GATEWAY_MEMORY_MEASUREMENT_REQUIRED')
            factor = {'B':1,'KiB':1024,'MiB':1024**2,'GiB':1024**3,'TiB':1024**4,'KB':1000,'MB':1000**2,'GB':1000**3,'TB':1000**4}[match[2]]
            memory += int(float(match[1]) * factor)
        now = dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z')
        self.api('/number-capacity/inventory', {'observed_at': now, 'slots': readback})
        # CPU uses /proc/stat deltas; container memory uses Docker's reported working set.
        measurements = {'host_ref': 'primary', 'observed_at': now, 'source': 'bounded_capacity_administrator', 'metrics': {
            'cpu_cores': cpus, 'cpu_busy_ratio': busy,
            'memory_total_bytes': mem['MemTotal'], 'memory_available_bytes': mem['MemAvailable'],
            'disk_available_bytes': available.f_bavail * available.f_frsize, 'gateway_count': len(readback),
            'physical_sessions_verified': sum(s.get('connected_sessions', 0) for s in readback), 'overlay_sha': self.provisioning_overlay_digest(),
            'measured_gateway_memory_bytes': memory}}
        return self.api('/number-capacity/measurements', measurements)

    def execute(self, operation_id, reconcile=False):
        if not re.fullmatch(r'[a-f0-9-]{36}', operation_id):
            raise ValueError('OPERATION_ID_REQUIRED')
        op = self.api('/number-operations/' + operation_id)
        if reconcile:
            if op['state'] != 'UNKNOWN':
                raise ValueError('UNKNOWN_OPERATION_REQUIRED')
            slots = [s for s in self.api('/number-capacity?limit=100')['slots'] if s.get('operation_id') == operation_id or s['id'] == op['input'].get('slot_id') or s['id'] in op['input'].get('slot_ids', [])]
            claim = {'version': op['version'], 'slots': slots, 'action': op['action'], 'input': op['input']}
        else:
            claim = self.api('/number-capacity/administration/' + operation_id,
                {'action': 'claim', 'expected_version': op['version'], 'reason': 'Bounded host administrator'}, operation_id + '-claim')
        slots = [s['slot'] for s in claim['slots']]
        existing = helper.validate(self.overlay, self.directory) if self.overlay.exists() else []
        preserved = {slot: self.snapshot(int(slot)) for slot in ['01', *existing]}
        try:
            if claim['action'] == 'DRAIN':
                # Draining preserves all containers and volumes; session stop/isolation is a separate, explicit workflow.
                readback = [self.readback(slot) for slot in slots]
                if any(s['session_count'] for s in readback):
                    raise ValueError('SESSION_ISOLATION_REQUIRED')
            else:
                if not reconcile:
                    for slot in slots:
                        self.credentials(slot)
                    additional = [str(s).zfill(2) for s in slots if s != 1]
                    if additional:
                        plan = helper.incremental(self.overlay, self.directory, additional)
                        helper.incremental(self.overlay, self.directory, additional, plan['previous_revision'], True)
                    if claim['action'] == 'EXPAND' and claim['input'].get('apply'):
                        new = [s for s in slots if str(s).zfill(2) not in existing and s != 1]
                        if new:
                            self.compose('up', '-d', '--no-deps', '--no-recreate', *['waha-' + str(s).zfill(2) for s in new])
                            for slot in new:
                                network = 'commerce-os_gateway-' + str(slot).zfill(2)
                                for service in ['channel-worker', 'ingress']:
                                    container = self.compose('ps', '-q', service).strip()
                                    if not re.fullmatch(r'[a-f0-9]{12,64}', container):
                                        raise ValueError('WORKER_READBACK_REQUIRED')
                                    networks = json.loads(run(['docker', 'inspect', container]))[0]['NetworkSettings']['Networks']
                                    if network not in networks:
                                        run(['docker', 'network', 'connect', network, container])
                readback = [self.readback(slot) for slot in slots]
                if any(s['session_count'] for s in readback):
                    raise ValueError('UNEXPECTED_SESSION_STARTED')
                if claim['action'] == 'PROVISION':
                    self.api('/number-capacity/inventory', {'observed_at': dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z'), 'slots': readback})
                    profiles = self.api('/settings/integrations')['profiles']
                    for slot in slots:
                        reference = 'waha-' + str(slot).zfill(2)
                        profile_ref = claim['input'].get('gateway_profile_ref', reference) if claim['input'].get('existing_account') else reference
                        current = next((p for p in profiles if p['key'] == 'waha:' + profile_ref), None)
                        if current:
                            if current['config']['base_url'] != 'http://' + reference + ':3000':
                                raise ValueError('INTEGRATION_READBACK_CONFLICT')
                            # HTTP readback authenticates the server independently. Quarantine is preserved;
                            # enabling an existing profile remains a separate reviewed operation.
                            continue
                        if claim['input'].get('existing_account'):
                            raise ValueError('EXISTING_INTEGRATION_REVIEW_REQUIRED')
                        credentials = self.credentials(slot, create=not reconcile)
                        self.api('/settings/integrations/waha:' + reference, {'expected_version': current['version'] if current else 0,
                            'label': 'Gateway aislado ' + str(slot), 'capacity_operation_id': operation_id, 'enabled': True, 'config': {'base_url': 'http://' + reference + ':3000'},
                            'secrets': {'api_key': credentials['WAHA_API_KEY'], 'webhook_secret': credentials['WHATSAPP_HOOK_HMAC_KEY']},
                            'reason': 'Provisionamiento revisado ' + operation_id}, operation_id + '-profile-' + str(slot), 'PUT')
            for slot, before in preserved.items():
                after = self.snapshot(int(slot))
                if any(before[k] != after[k] for k in ['Id', 'Image', 'Config', 'HostConfig', 'Mounts', 'NetworkSettings']) or before['State']['StartedAt'] != after['State']['StartedAt']:
                    raise ValueError('EXISTING_GATEWAY_CHANGED')
            return self.api('/number-capacity/administration/' + operation_id,
                {'action': 'reconcile' if reconcile else 'complete', 'expected_version': claim['version'], 'outcome': 'VERIFIED',
                 'overlay_sha': self.provisioning_overlay_digest(), 'slots': readback, 'reason': 'Canonical host readback; zero sessions started'}, operation_id + '-readback')
        except Exception:
            # No automatic replay of Docker or integration mutation after an uncertain response.
            try:
                self.api('/number-capacity/administration/' + operation_id, {'action': 'complete', 'expected_version': claim['version'],
                    'outcome': 'UNKNOWN', 'reason': 'Host mutation requires readback before another attempt'}, operation_id + '-uncertain')
            except Exception:
                pass
            raise RuntimeError('ADMINISTRATION_RECONCILIATION_REQUIRED') from None


def main():
    if len(sys.argv) < 3 or sys.argv[2] not in ['measure', 'apply', 'reconcile']:
        raise ValueError('USAGE_PRIVATE_CONFIG_MEASURE_OR_APPLY_OPERATION')
    agent = Administrator(json.loads(private_file(sys.argv[1]).read_text()))
    result = agent.measure() if sys.argv[2] == 'measure' else agent.execute(sys.argv[3], sys.argv[2] == 'reconcile')
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if re.fullmatch('[A-Z_]+', str(error)) else 'CAPACITY_ADMINISTRATION_FAILED', file=sys.stderr)
        sys.exit(1)
