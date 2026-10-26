#!/usr/bin/env python3
"""Bounded gateway supervisor (V7 F3: RF-07.a/c/f, RNF-02.a/c).

Host-side and systemd-owned. It never receives HTTP input, never starts or
links a WhatsApp session, never deletes a volume and never repeats an uncertain
host mutation without readback. Each cycle, for every profile:

1. obtains a 15-minute capacity agent token from the platform API (its own
   platform token must hold platform:profiles and platform:capacity);
2. refreshes host measurements and gateway readback (inventory);
3. applies pending reviewed capacity operations (PROVISION/EXPAND/DRAIN)
   through the existing bounded Administrator, and reconciles UNKNOWN ones by
   readback only, with a per-operation backoff;
4. keeps one prepared spare slot for an ACTIVE profile with free number quota
   (a profile that is not ACTIVE is skipped before asking for its token: its
   capacity token is rejected with PROFILE_SUSPENDED),
   so adding a number never waits for manual provisioning;
5. before measuring, restarts an exited gateway container of a provisioned,
   non-draining slot with the same container, volume, image and network
   (backoff 30/60/120/240/480 s, at most five tries until 10 stable minutes).
   Gateways never restore sessions on boot (WHATSAPP_RESTART_ALL_SESSIONS=false);
   session ownership stays with the channel worker.

Private configuration (JSON, 0600): api_origin, platform_token_file,
release_env, gateway_dir, overlay, state_file, interval_seconds,
measure_seconds. Command: ``gateway_supervisor.py CONFIG run|once``.
"""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location('number_capacity_administrator', ROOT / 'scripts/number-capacity-administrator.py')
capacity = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(capacity)
_receipts_spec = importlib.util.spec_from_file_location('ownership_isolation_receipts', ROOT / 'scripts/ownership-isolation-receipts.py')
receipts = importlib.util.module_from_spec(_receipts_spec)
_receipts_spec.loader.exec_module(receipts)

# PREPARING/DRAINING belong to a claimed operation; AVAILABLE has no gateway yet.
RESTARTABLE_STATES = {'PREPARED', 'RESERVED', 'QR_PENDING', 'CONNECTED'}
BACKOFF = (30, 60, 120, 240, 480)
MAX_RESTARTS = len(BACKOFF)
STABLE_SECONDS = 600


def utc_now():
    return dt.datetime.now(dt.timezone.utc)


def safe_code(error, fallback):
    text = str(error)
    return text if re.fullmatch(r'[A-Z_]{3,80}', text) else fallback


def started_at(value):
    """Docker StartedAt has nanoseconds; keep microseconds for fromisoformat."""
    match = re.fullmatch(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)', str(value or ''))
    if not match or match[1].startswith('0001-'):
        return None
    zone = '+00:00' if match[3] == 'Z' else match[3]
    return dt.datetime.fromisoformat(match[1] + '.' + (match[2] or '0')[:6].ljust(6, '0') + zone).timestamp()


class SupervisorError(RuntimeError):
    pass


class State:
    """Private journal of backoff and attempts; survives restarts of the unit."""

    def __init__(self, path):
        self.path = Path(path)
        if not self.path.is_absolute() or self.path.is_symlink():
            raise SupervisorError('PRIVATE_STATE_REQUIRED')
        self.data = {'operations': {}, 'gateways': {}, 'spares': {}, 'skipped': {}, 'events': []}
        if self.path.exists():
            raw = json.loads(capacity.private_file(self.path).read_text())
            if type(raw) is dict:
                self.data.update({k: raw.get(k, v) for k, v in self.data.items()})

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.path.with_name(self.path.name + '.tmp')
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600), 'w') as target:
            json.dump(self.data, target, sort_keys=True)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, self.path)

    def event(self, kind, **fields):
        self.data['events'] = (self.data['events'] + [{'at': utc_now().isoformat(), 'kind': kind, **fields}])[-200:]

    def due(self, bucket, key, now):
        entry = self.data[bucket].get(key)
        return not entry or now.timestamp() >= entry.get('next_at', 0)

    def failed(self, bucket, key, now, code):
        entry = self.data[bucket].setdefault(key, {'attempts': 0})
        entry['attempts'] += 1
        entry['code'] = code
        entry['next_at'] = now.timestamp() + BACKOFF[min(entry['attempts'], len(BACKOFF)) - 1]
        return entry['attempts']

    def cleared(self, bucket, key):
        self.data[bucket].pop(key, None)


class PlatformClient:
    """Platform identity only: profiles list and per-profile agent tokens."""

    def __init__(self, origin, token, opener=None):
        if not re.fullmatch(r'https://[A-Za-z0-9.:-]+|http://(localhost|127\.0\.0\.1)(:[0-9]+)?', origin):
            raise SupervisorError('HTTPS_ORIGIN_REQUIRED')
        if not re.fullmatch(r'cos_plt_[A-Za-z0-9_-]{43}', token):
            raise SupervisorError('PLATFORM_TOKEN_REQUIRED')
        self.origin, self.token = origin, token
        self.opener = opener or urllib.request.build_opener(capacity.NoRedirect())
        self.agents = {}

    def call(self, method, path, body=None):
        request = urllib.request.Request(self.origin + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                         headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json', 'Accept': 'application/json'})
        with self.opener.open(request, timeout=30) as response:
            return json.load(response)['data']

    def profiles(self):
        data = self.call('GET', '/v2/platform/profiles')
        return [p for p in data['profiles'] if type(p) is dict and type(p.get('id')) is str]

    def agent_token(self, workspace, now):
        cached = self.agents.get(workspace)
        if cached and cached['expires_at'] - now.timestamp() > 120:
            return cached['token']
        issued = self.call('POST', '/v2/platform/capacity/agent-tokens', {'workspaceId': workspace})
        if issued.get('workspaceId') != workspace or not re.fullmatch(r'cos_cap_[A-Za-z0-9_-]{43}', issued.get('token', '')):
            raise SupervisorError('AGENT_TOKEN_INVALID')
        expires = dt.datetime.fromisoformat(issued['expiresAt'].replace('Z', '+00:00')).timestamp()
        self.agents[workspace] = {'token': issued['token'], 'expires_at': expires}
        return issued['token']


class Supervisor:
    def __init__(self, config, platform=None, administrator=None, state=None, clock=utc_now, ownership=None):
        self.config = config
        self.platform = platform or PlatformClient(config['api_origin'], capacity.private_file(config['platform_token_file']).read_text().strip())
        self.administrator = administrator or self._administrator
        self.state = state or State(config['state_file'])
        self.ownership = ownership or receipts
        self.clock = clock
        self.measured = {}

    def _administrator(self, token):
        admin = capacity.Administrator.__new__(capacity.Administrator)
        admin.config = {'api_origin': self.config['api_origin']}
        admin.token = token
        admin.release = str(capacity.private_file(self.config['release_env']))
        admin.directory = Path(self.config['gateway_dir'])
        admin.overlay = Path(self.config['overlay'])
        if not admin.directory.is_absolute() or admin.directory.is_symlink() or not admin.overlay.is_absolute() or admin.overlay.is_symlink():
            raise SupervisorError('PRIVATE_GATEWAY_CONFIGURATION_REQUIRED')
        return admin

    def channel_watch(self, report):
        """RNF-02.c: a crashed channel worker restarts with a new owner identity.
        Each cycle captures the running channel container and the owners of its
        current instance (the reviewed installer capture). When that container
        is replaced or restarted (newer StartedAt), the reviewed attestation
        proves the captured instance is gone and records isolation receipts, so
        the new instance takes over the same leases with fencing instead of
        waiting for a release. Never during a release hold: the installer owns
        that handoff. No session, message or container is touched here."""
        release = str(capacity.private_file(self.config['release_env']))
        directory = Path(self.config['state_file']).parent / 'ownership'
        directory.mkdir(mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)
        snapshot = directory / 'channel-snapshot.json'
        if self.ownership.database(release, "SELECT COALESCE(bool_or(release_hold),false) FROM operational_settings WHERE environment='REAL';") == 't':
            return
        current = [self.ownership.inspect(item) for item in self.ownership.container_ids(release)]
        if snapshot.exists() and current and all(item and item.get('running') for item in current):
            previous = (json.loads(snapshot.read_text()).get('containers') or [None])[0]
            replaced = previous and (previous['id'] not in [item['id'] for item in current]
                                     or any(item['id'] == previous['id'] and item.get('started_at') != previous.get('started_at') for item in current))
            if replaced:
                os.environ['COMMERCE_OWNERSHIP_HISTORY_DIR'] = str(directory)
                result = self.ownership.attest(release, str(snapshot))
                report['channel_handoff'] = int(result.get('receipts_inserted', 0))
                self.state.event('CHANNEL_WORKER_RESTART_ATTESTED', receipts=report['channel_handoff'])
        self.ownership.capture(release, str(snapshot))

    def cycle(self):
        now = self.clock()
        report = {'profiles': 0, 'skipped': 0, 'applied': 0, 'reconciled': 0, 'spares_requested': 0, 'restarted': 0, 'errors': []}
        try:
            self.channel_watch(report)
        except Exception as error:
            report['errors'].append({'code': safe_code(error, 'CHANNEL_WATCH_FAILED')})
        for profile in self.platform.profiles():
            report['profiles'] += 1
            if profile.get('state') != 'ACTIVE':
                # A suspended profile rejects its capacity token on every call
                # (PROFILE_SUSPENDED), so it is skipped without a token and the
                # change is recorded once, not as an error every 15 s. It cannot
                # operate numbers; its slots are reconciled when it is reactivated.
                self.skipped(profile, report)
                continue
            self.state.data['skipped'].pop(profile['id'], None)
            try:
                self.profile(profile, now, report)
            except Exception as error:  # one profile never stops the others
                code = safe_code(error, 'PROFILE_CYCLE_FAILED')
                report['errors'].append({'profile': profile['id'], 'code': code})
                self.state.event('PROFILE_CYCLE_FAILED', profile=profile['id'], code=code)
        self.state.save()
        return report

    def skipped(self, profile, report):
        report['skipped'] += 1
        state = profile.get('state') if type(profile.get('state')) is str and re.fullmatch(r'[A-Z_]{1,32}', profile['state']) else 'UNKNOWN'
        if self.state.data['skipped'].get(profile['id']) != state:
            self.state.data['skipped'][profile['id']] = state
            self.state.event('PROFILE_SKIPPED_NOT_ACTIVE', profile=profile['id'], state=state)

    def profile(self, profile, now, report):
        workspace = profile['id']
        admin = self.administrator(self.platform.agent_token(workspace, now))
        slots = [s for s in admin.api('/number-capacity?limit=100').get('slots', []) if type(s) is dict]
        # 1. Crashed gateways first: a stopped gateway makes the bounded
        # measurement fail, and with it every new capacity decision.
        for slot in slots:
            if slot.get('state') not in RESTARTABLE_STATES:
                continue
            self.gateway(admin, workspace, int(slot['slot']), now, report)
        # 2. Fresh host measurement and gateway readback (inventory).
        if now.timestamp() - self.measured.get(workspace, 0) >= float(self.config.get('measure_seconds', 45)):
            try:
                admin.measure()
                self.measured[workspace] = now.timestamp()
            except Exception as error:
                report['errors'].append({'profile': workspace, 'code': safe_code(error, 'MEASUREMENT_FAILED')})
        # 3. Reviewed pending operations; UNKNOWN only by readback.
        pending = admin.api('/number-capacity/administration')
        for op in pending:
            key = workspace + ':' + op['id']
            if op['state'] not in ('UNKNOWN', 'REQUESTED', 'RESERVED', 'HUMAN_ACTION_REQUIRED') or not self.state.due('operations', key, now):
                continue
            try:
                admin.execute(op['id'], reconcile=op['state'] == 'UNKNOWN')
                report['reconciled' if op['state'] == 'UNKNOWN' else 'applied'] += 1
                self.state.cleared('operations', key)
                self.state.event('OPERATION_APPLIED', profile=workspace, operation=op['id'], action=op.get('action'))
            except Exception as error:
                code = safe_code(error, 'ADMINISTRATION_FAILED')
                attempts = self.state.failed('operations', key, now, code)
                report['errors'].append({'profile': workspace, 'operation': op['id'], 'code': code, 'attempts': attempts})
        # 4. One prepared spare for an ACTIVE profile with free number quota.
        if pending or profile.get('state') != 'ACTIVE':
            return
        if any(s.get('state') == 'PREPARED' and not s.get('account_id') for s in slots):
            self.state.cleared('spares', workspace)
            return
        limit = int((profile.get('limits') or {}).get('numbers', 0))
        unprepared = [s for s in slots if s.get('state') == 'AVAILABLE' and not s.get('account_id')]
        count = len(slots) if unprepared else len(slots) + 1
        if count < 1 or count > limit or not self.state.due('spares', workspace, now):
            return
        preview = admin.api('/number-capacity', {'action': 'preview', 'count': count, 'reason': 'Supervisor: plaza de reserva'})
        if preview.get('blockers'):
            self.state.failed('spares', workspace, now, safe_code(preview['blockers'][0], 'CAPACITY_BLOCKED'))
            return
        admin.api('/number-capacity', {'action': 'expand', 'count': count, 'review': preview['review'], 'confirmation': 'APPLY_REVIEWED_CAPACITY',
                                       'reason': 'Supervisor: una plaza preparada para alta en caliente'}, str(uuid.uuid4()))
        self.state.failed('spares', workspace, now, 'SPARE_REQUESTED')
        report['spares_requested'] += 1
        self.state.event('SPARE_REQUESTED', profile=workspace, count=count)

    def gateway(self, admin, workspace, number, now, report):
        key = str(number).zfill(2)
        try:
            value = admin.snapshot(number)
        except Exception:
            return  # absent or changed configuration is reconciled by operations, never invented here
        status = value['State'].get('Status')
        if value['State'].get('Running'):
            started = started_at(value['State'].get('StartedAt'))
            if started is not None and now.timestamp() - started >= STABLE_SECONDS:
                self.state.cleared('gateways', key)
            return
        if status != 'exited':
            return  # paused or created containers are an explicit operator state
        entry = self.state.data['gateways'].get(key, {})
        if entry.get('attempts', 0) >= MAX_RESTARTS:
            if not entry.get('exhausted_reported'):
                entry['exhausted_reported'] = True
                self.state.event('GATEWAY_RESTART_EXHAUSTED', profile=workspace, slot=number)
                report['errors'].append({'profile': workspace, 'slot': number, 'code': 'GATEWAY_RESTART_EXHAUSTED'})
            return
        if not self.state.due('gateways', key, now):
            return
        try:
            admin.compose('start', 'waha-' + key)  # same container: same image, volumes and network
            self.state.failed('gateways', key, now, 'RESTARTED_PENDING_STABILITY')
            report['restarted'] += 1
            self.state.event('GATEWAY_RESTARTED', profile=workspace, slot=number)
        except Exception:
            attempts = self.state.failed('gateways', key, now, 'GATEWAY_RESTART_FAILED')
            report['errors'].append({'profile': workspace, 'slot': number, 'code': 'GATEWAY_RESTART_FAILED', 'attempts': attempts})

    def run(self):
        interval = max(5.0, float(self.config.get('interval_seconds', 15)))
        while True:
            started = time.monotonic()
            try:
                report = self.cycle()
                print(json.dumps({'at': utc_now().isoformat(), **report}, sort_keys=True), flush=True)
            except Exception as error:
                print(json.dumps({'at': utc_now().isoformat(), 'error': safe_code(error, 'SUPERVISOR_CYCLE_FAILED')}), flush=True)
            time.sleep(max(1.0, interval - (time.monotonic() - started)))


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in ('run', 'once'):
        raise SupervisorError('USAGE_PRIVATE_CONFIG_RUN_OR_ONCE')
    supervisor = Supervisor(json.loads(capacity.private_file(sys.argv[1]).read_text()))
    if sys.argv[2] == 'once':
        print(json.dumps(supervisor.cycle(), sort_keys=True))
    else:
        supervisor.run()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(safe_code(error, 'GATEWAY_SUPERVISOR_FAILED'), file=sys.stderr)
        sys.exit(1)
