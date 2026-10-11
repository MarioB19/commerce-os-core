#!/usr/bin/env python3
"""Installer-only ownership attestation. Output is counts; private evidence stays mode 0600.

The runtime cannot write receipts. A lease, a process name or a stopped container
with network access is insufficient evidence. This helper verifies Docker state
after replacement and writes only generation-matched receipts through the owner.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
UTC = dt.timezone.utc


def run(arguments, input_text=None):
    attempt=os.environ.get('COMMERCE_DEPLOYMENT_ATTEMPT','')
    if arguments[:2]==['docker','run'] and attempt:
        if not re.fullmatch(r'deploy-[a-f0-9]{32}',attempt):raise RuntimeError('DEPLOYMENT_ATTEMPT_INVALID')
        arguments=arguments[:2]+['--label','com.commerce-os.deployment-attempt='+attempt,'--env','PGAPPNAME='+attempt]+arguments[2:]
    result = subprocess.run(arguments, input=input_text, text=True, capture_output=True, cwd=ROOT, check=False)
    if result.returncode:
        if os.environ.get('COMMERCE_DEPLOYMENT_LOG_PRIVATE')=='1':
            sys.stderr.write(result.stderr or result.stdout or 'Administrative command failed without output.\n')
        raise RuntimeError('OWNERSHIP_ATTESTATION_COMMAND_FAILED')
    return result.stdout.strip()


def compose(release_env, *arguments, input_text=None):
    return run(['sh', 'scripts/compose-release.sh', str(release_env), *arguments], input_text)


def database(release_env, sql):
    attempt=os.environ.get('COMMERCE_DEPLOYMENT_ATTEMPT','')
    if attempt and not re.fullmatch(r'deploy-[a-f0-9]{32}',attempt):raise RuntimeError('DEPLOYMENT_ATTEMPT_INVALID')
    tracked=['--env','PGAPPNAME='+attempt] if attempt else []
    return compose(release_env, 'exec', '-T', *tracked, 'postgres', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'commerce_owner', '-d', 'commerce', input_text=sql)


def container_ids(release_env):
    return compose(release_env, 'ps', '-aq', 'channel-worker').split()


def inspect(container):
    if not re.fullmatch(r'[a-f0-9]{12,64}', container):
        raise RuntimeError('OWNERSHIP_CONTAINER_ID_INVALID')
    # Confirm absence using a successful inventory, never by interpreting a failed inspect.
    inventory = run(['docker', 'ps', '-aq', '--no-trunc']).split()
    matches = [item for item in inventory if item.startswith(container)]
    if not matches:
        return None
    template = '{"id":{{json .Id}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"started_at":{{json .State.StartedAt}},"finished_at":{{json .State.FinishedAt}},"restart":{{json .HostConfig.RestartPolicy.Name}},"networks":{{json .NetworkSettings.Networks}}}'
    value = json.loads(run(['docker', 'inspect', '--format', template, matches[0]]))
    value['networks'] = sorted(value['networks'])
    return value


def private_write(path, value):
    path = Path(path)
    if path.is_symlink():
        raise RuntimeError('OWNERSHIP_EVIDENCE_PATH_INVALID')
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, 'w') as file:
        json.dump(value, file, sort_keys=True)
        file.write('\n')
        file.flush()
        os.fsync(file.fileno())
    descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def validate_snapshot(snapshot, states, current_ids, now=None):
    now = now or dt.datetime.now(UTC)
    observed = dt.datetime.fromisoformat(snapshot['captured_at'].replace('Z', '+00:00'))
    if not dt.timedelta(0) <= now-observed < dt.timedelta(hours=1):
        raise RuntimeError('OWNERSHIP_CAPTURE_EXPIRED')
    containers = snapshot['containers']
    if len(containers) > 1:
        raise RuntimeError('OWNERSHIP_TOPOLOGY_AMBIGUOUS')
    if not containers:
        return False
    previous = containers[0]
    if previous['project'] != 'commerce-os' or previous['service'] != 'channel-worker':
        raise RuntimeError('OWNERSHIP_TOPOLOGY_INVALID')
    current = states.get(previous['id'])
    if previous['id'] in current_ids:
        # No replacement happened; its existing ownership does not need a handoff.
        return False
    if current and (current['running'] or current['networks'] or current['restart'] not in ('no', '')):
        raise RuntimeError('OLD_OWNER_ISOLATION_NOT_VERIFIED')
    return True


def capture(release_env, output):
    ids = container_ids(release_env)
    if len(ids) > 1:
        raise RuntimeError('OWNERSHIP_TOPOLOGY_AMBIGUOUS')
    containers = [inspect(item) for item in ids]
    if any(item is None for item in containers):
        raise RuntimeError('OWNERSHIP_CONTAINER_CHANGED_DURING_CAPTURE')
    owners = []
    if containers:
        # With one verified channel container, only its recent instance heartbeat
        # identifies an owner eligible for automatic installer attestation.
        text = database(release_env, """SELECT COALESCE(jsonb_agg(jsonb_build_object('account_id',o.account_id,'workspace_id',o.workspace_id,'previous_owner_id',o.owner_id,'generation',o.generation)),'[]') FROM session_ownership o JOIN records a ON a.id::text=o.account_id AND a.workspace_id=o.workspace_id AND a.kind='channel_account' AND a.environment='REAL' WHERE EXISTS(SELECT 1 FROM records h WHERE h.kind='service_heartbeat' AND h.workspace_id=o.workspace_id AND h.environment='REAL' AND h.body->>'service'='channel-worker' AND h.body->>'instance'=o.owner_id AND h.updated_at>now()-interval '60 seconds');""")
        owners = json.loads(text)
    api=compose(release_env,'ps','-aq','api').split()
    if len(api)>1:raise RuntimeError('RELEASE_HOLD_RUNNING_IMAGE_UNKNOWN')
    api_image=run(['docker','inspect','--format','{{.Image}}',api[0]]) if api else None
    if api_image is not None and not re.fullmatch(r'sha256:[a-f0-9]{64}',api_image):raise RuntimeError('RELEASE_HOLD_IMAGE_UNKNOWN')
    snapshot = {'schema_version': 1, 'captured_at': dt.datetime.now(UTC).isoformat(), 'containers': containers, 'owners': owners,'api_image':api_image}
    private_write(output, snapshot)
    return {'captured_containers': len(containers), 'captured_ownerships': len(owners)}


def freeze(release_env):
    if not compose(release_env, 'ps', '-q', 'postgres'):
        return {'frozen_settings': 0, 'frozen_ownerships': 0}
    exists = database(release_env, "SELECT to_regclass('public.operational_settings') IS NOT NULL;") == 't'
    policy = """BEGIN; DO $$ DECLARE workspace text; BEGIN FOR workspace IN SELECT workspace_id FROM operational_settings WHERE environment='REAL' ORDER BY workspace_id LOOP PERFORM pg_advisory_xact_lock(hashtextextended('operations:'||workspace||':REAL',0)); END LOOP; END $$; WITH frozen AS (UPDATE operational_settings SET version=version+1,body=body||'{"dispatch_frozen":true,"real_sends_enabled":false,"allow_real_operations":false}'::jsonb,updated_by='release-install',updated_at=now() WHERE environment='REAL' RETURNING workspace_id,version), evidence AS (INSERT INTO domain_events(workspace_id,environment,event_type,aggregate_id,correlation_id,actor,payload) SELECT workspace_id,'REAL','operational_settings.release_frozen',workspace_id,gen_random_uuid()::text,'{"type":"installer"}'::jsonb,jsonb_build_object('configuration_version',version,'reason','Release requires renewed owner activation') FROM frozen RETURNING id) SELECT count(*) FROM evidence; COMMIT;"""
    settings = int(database(release_env, policy)) if exists else 0
    ownerships = int(database(release_env, "WITH frozen AS (UPDATE session_ownership o SET frozen=true,updated_at=now() WHERE EXISTS(SELECT 1 FROM records a WHERE a.id::text=o.account_id AND a.workspace_id=o.workspace_id AND a.environment='REAL' AND a.kind='channel_account') RETURNING account_id) SELECT count(*) FROM frozen;"))
    if database(release_env, "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='session_ownership' AND column_name='release_frozen';") == '1':
        database(release_env, "UPDATE session_ownership o SET release_frozen=false WHERE release_frozen AND EXISTS(SELECT 1 FROM records a WHERE a.id::text=o.account_id AND a.workspace_id=o.workspace_id AND a.environment='REAL' AND a.kind='channel_account');")
    programs = 0
    if database(release_env, "SELECT to_regclass('public.warmup_programs') IS NOT NULL;") == 't':
        programs = int(database(release_env, """WITH paused_pools AS (
            UPDATE warmup_pools SET enabled=false,paused=true,version=version+1,updated_at=now()
            WHERE environment='REAL' AND program_id IS NOT NULL RETURNING id
        ), paused_programs AS (
            UPDATE warmup_programs SET status='PAUSED',review_hash=NULL,review_dependencies=NULL,version=version+1,updated_at=now()
            WHERE environment='REAL' AND status NOT IN('DRAFT','ARCHIVED','COMPLETED')
            RETURNING id
        ) SELECT count(*) FROM paused_programs;"""))
    return {'frozen_settings': settings, 'frozen_ownerships': ownerships, 'paused_number_programs': programs}


def supports_hold(release_env, recovery=False):
    """Both running and candidate workers must enforce the same database hold."""
    # A failed migration has normally stopped the API already. Its actual
    # container image still proves capability; no running/absent state proves
    # ownership isolation, which is verified separately after replacement.
    old = compose(release_env, 'ps', '-aq' if recovery else '-q', 'api').split()
    if len(old)==1:
        previous_image = run(['docker', 'inspect', '--format', '{{.Image}}', old[0]])
    elif not old and recovery:
        # force-recreate may already have removed the old API. Only a private,
        # recent capture made before the stop can supply its actual image.
        path=os.environ.get('COMMERCE_OWNERSHIP_RECOVERY_CAPTURE','')
        if not path:raise RuntimeError('RELEASE_HOLD_RUNNING_IMAGE_UNKNOWN')
        descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(descriptor) as source:
            info=os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode&0o077 or info.st_size>1024*1024:raise RuntimeError('RELEASE_HOLD_CAPTURE_INVALID')
            snapshot=json.load(source)
        captured=dt.datetime.fromisoformat(snapshot['captured_at'].replace('Z','+00:00'))
        if not dt.timedelta(0)<=dt.datetime.now(UTC)-captured<dt.timedelta(hours=1):raise RuntimeError('OWNERSHIP_CAPTURE_EXPIRED')
        previous_image=snapshot.get('api_image')
    else:raise RuntimeError('RELEASE_HOLD_RUNNING_IMAGE_UNKNOWN')
    candidate_image = next((line.split('=', 1)[1] for line in Path(release_env).read_text().splitlines()
                            if line.startswith('COMMERCE_IMAGE=')), '')
    supported = []
    for image in (previous_image, candidate_image):
        if not isinstance(image,str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
            raise RuntimeError('RELEASE_HOLD_IMAGE_UNKNOWN')
        marker = run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', image,
                      'node', '-e', "console.log(require('node:fs').existsSync('/app/packages/db/src/release-hold-capability.json')?'1':'0')"])
        if marker not in ('0', '1'):
            raise RuntimeError('RELEASE_HOLD_CAPABILITY_UNKNOWN')
        supported.append(marker == '1')
    if not all(supported):
        return False
    if database(release_env, "SELECT count(*)=3 FROM information_schema.columns WHERE table_schema='public' AND ((table_name='operational_settings' AND column_name IN ('release_hold','release_hold_at')) OR (table_name='session_ownership' AND column_name='release_frozen'));") != 't':
        raise RuntimeError('RELEASE_HOLD_SCHEMA_MISSING')
    return True


def hold(release_env, recovery=False):
    if not (supports_hold(release_env,True) if recovery else supports_hold(release_env)):
        raise RuntimeError('RELEASE_HOLD_UNSUPPORTED')
    sql = """BEGIN;
      DO $$ DECLARE workspace text; BEGIN FOR workspace IN SELECT workspace_id FROM operational_settings WHERE environment='REAL' ORDER BY workspace_id LOOP PERFORM pg_advisory_xact_lock(hashtextextended('operations:'||workspace||':REAL',0)); END LOOP; END $$;
      DO $$ BEGIN IF EXISTS(SELECT 1 FROM operational_settings WHERE environment='REAL' AND release_hold) THEN RAISE EXCEPTION 'RELEASE_HOLD_ALREADY_ACTIVE'; END IF; END $$;
      WITH held AS (UPDATE operational_settings SET release_hold=true,release_hold_at=now() WHERE environment='REAL' AND NOT release_hold RETURNING workspace_id),
      frozen AS (UPDATE session_ownership o SET release_frozen=o.release_frozen OR NOT o.frozen,frozen=true,updated_at=now() FROM records a WHERE a.id::text=o.account_id AND a.workspace_id=o.workspace_id AND a.environment='REAL' AND a.kind='channel_account' RETURNING o.account_id)
      SELECT (SELECT count(*) FROM held),(SELECT count(*) FROM frozen); COMMIT;"""
    if recovery:
        # Preserve the original boundary and every explicit freeze. Only this
        # recovery entrypoint can reuse an active hold; a new deploy still fails.
        sql=sql.replace("DO $$ BEGIN IF EXISTS(SELECT 1 FROM operational_settings WHERE environment='REAL' AND release_hold) THEN RAISE EXCEPTION 'RELEASE_HOLD_ALREADY_ACTIVE'; END IF; END $$;",'')
    return {'held_and_frozen': database(release_env, sql)}


def release_hold(release_env):
    """Clear only the deployment hold; a new fenced worker still must pass health."""
    sql = """BEGIN;
      DO $$ DECLARE workspace text; BEGIN FOR workspace IN SELECT workspace_id FROM operational_settings WHERE environment='REAL' ORDER BY workspace_id LOOP PERFORM pg_advisory_xact_lock(hashtextextended('operations:'||workspace||':REAL',0)); END LOOP; END $$;
      WITH released AS (UPDATE operational_settings SET release_hold=false WHERE environment='REAL' AND release_hold RETURNING workspace_id)
      SELECT count(*) FROM released;
      WITH eligible AS (
       SELECT o.account_id,o.workspace_id FROM session_ownership o
       JOIN records a ON a.id::text=o.account_id AND a.workspace_id=o.workspace_id AND a.kind='channel_account' AND a.environment='REAL' AND NOT(a.body?'deleted_at')
       JOIN operational_settings p ON p.workspace_id=o.workspace_id AND p.environment='REAL'
       WHERE o.release_frozen AND EXISTS(SELECT 1 FROM ownership_isolation_receipts r WHERE r.account_id::text=o.account_id AND r.workspace_id=o.workspace_id AND r.previous_owner_id=o.owner_id AND r.generation=o.generation AND r.consumed_at IS NULL AND r.verified_at>=p.release_hold_at AND r.verified_at>now()-interval '24 hours')
      ), expired AS (UPDATE session_ownership o SET lease_expires_at=now(),updated_at=now() FROM eligible e WHERE o.account_id=e.account_id RETURNING o.account_id,o.workspace_id),
      queued AS (INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key)
       SELECT e.workspace_id,'REAL','channel_command',e.account_id,'release-install',jsonb_build_object('type','check_health','reason','Verified release handoff'), 'release-health:'||e.account_id||':'||gen_random_uuid()::text FROM expired e
       WHERE NOT EXISTS(SELECT 1 FROM commands c WHERE c.workspace_id=e.workspace_id AND c.resource_id=e.account_id AND c.kind='channel_command' AND c.status='PENDING') RETURNING id)
      SELECT (SELECT count(*) FROM expired),(SELECT count(*) FROM queued); COMMIT;"""
    return {'released_and_queued': database(release_env, sql)}


def validate_historical_proof(proof, candidate, current_ids, old_state, now=None):
    """A trusted prior receipt anchors the mapping; Docker must prove removal anew."""
    now = now or dt.datetime.now(UTC)
    verified = dt.datetime.fromisoformat(candidate['verified_at'].replace('Z', '+00:00'))
    if candidate.get('consumed_at') or now-verified < dt.timedelta(hours=24):
        raise RuntimeError('HISTORICAL_RECEIPT_NOT_ELIGIBLE')
    digest = hashlib.sha256(json.dumps(proof, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    if digest != candidate['evidence_sha256']:
        raise RuntimeError('HISTORICAL_PROOF_HASH_MISMATCH')
    snapshot = proof['snapshot']
    fields = ('account_id', 'workspace_id', 'previous_owner_id', 'generation')
    if not any(all(str(owner.get(key)) == str(candidate[key]) for key in fields) for owner in snapshot['owners']):
        raise RuntimeError('HISTORICAL_OWNER_MISMATCH')
    replacements = proof['replacement_ids']
    if len(replacements) != 1 or not re.fullmatch('[a-f0-9]{64}', replacements[0]):
        raise RuntimeError('HISTORICAL_REPLACEMENT_INVALID')
    if not validate_snapshot(snapshot, proof['verified_containers'], replacements, verified):
        raise RuntimeError('HISTORICAL_ISOLATION_INVALID')
    previous = snapshot['containers'][0]['id']
    if not re.fullmatch('[a-f0-9]{64}', previous) or previous in current_ids or old_state is not None:
        raise RuntimeError('PREVIOUS_CONTAINER_NOT_REMOVED')
    return previous


def reverify_expired(release_env, directory, current):
    """Installer-only refresh with original DB-anchored evidence and a fresh Docker read.

    No lease/heartbeat inference, timestamp editing or runtime receipt-write grant.
    The old container must be absent, not merely stopped and able to restart.
    """
    if len(current) != 1 or not current[0]['running'] or current[0]['project'] != 'commerce-os' or current[0]['service'] != 'channel-worker':
        raise RuntimeError('REVERIFICATION_TOPOLOGY_INVALID')
    directory = Path(directory)
    if directory.is_symlink() or directory.stat().st_mode & 0o077:
        raise RuntimeError('OWNERSHIP_EVIDENCE_PERMISSIONS_INVALID')
    candidates = json.loads(database(release_env, """SELECT COALESCE(jsonb_agg(row_to_json(c)),'[]') FROM (
      SELECT p.* FROM ownership_isolation_receipts p
      JOIN session_ownership o ON o.account_id=p.account_id::text AND o.workspace_id=p.workspace_id AND o.owner_id=p.previous_owner_id AND o.generation=p.generation
      JOIN records a ON a.id=p.account_id AND a.workspace_id=p.workspace_id
      WHERE o.frozen AND a.environment='REAL' AND a.kind='channel_account' AND a.body->>'provider'='waha' AND NOT(a.body?'deleted_at')
      AND p.consumed_at IS NULL AND p.verified_at<=now()-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM ownership_isolation_receipts fresh WHERE fresh.account_id=p.account_id AND fresh.workspace_id=p.workspace_id AND fresh.previous_owner_id=p.previous_owner_id AND fresh.generation=p.generation AND fresh.consumed_at IS NULL AND fresh.verified_at>now()-interval '24 hours' AND fresh.verified_at<=now())
      ORDER BY p.verified_at,p.id) c;"""))
    originals = {}
    for path in sorted(directory.glob('*.attested.json')):
        if path.is_symlink() or path.stat().st_mode & 0o077 or path.stat().st_uid != os.geteuid():
            continue
        try:
            document = json.loads(path.read_text())
            proof = document['proof']
            digest = hashlib.sha256(json.dumps(proof, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            if digest == document.get('evidence_sha256'):
                originals[digest] = proof
        except (ValueError, KeyError, TypeError):
            continue
    inserted = 0
    handled = set()
    current_ids = [item['id'] for item in current]
    for candidate in candidates:
        scope = tuple(str(candidate[key]) for key in ('account_id', 'workspace_id', 'previous_owner_id', 'generation'))
        proof = originals.get(candidate['evidence_sha256'])
        if scope in handled or not proof:
            continue
        try:
            previous = proof['snapshot']['containers'][0]['id']
            # inspect confirms absence from a successful complete Docker inventory.
            observed = inspect(previous)
            now = dt.datetime.now(UTC)
            previous = validate_historical_proof(proof, candidate, current_ids, observed, now)
        except (RuntimeError, KeyError, IndexError, TypeError, ValueError):
            continue
        evidence = {'source_receipt_id': candidate['id'], 'source_evidence_sha256': candidate['evidence_sha256'],
                    'previous_container_id': previous, 'previous_container_absent': True,
                    'current_containers': current, 'verified_at': now.isoformat()}
        digest = hashlib.sha256(json.dumps(evidence, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        evidence_path = directory/('reverified-'+digest+'.json')
        # Preserve the exact proof before any receipt mutation, including uncertain DB outcomes.
        private_write(evidence_path, {'proof': evidence, 'evidence_sha256': digest, 'status': 'PREPARED'})
        source = str(candidate['id'])
        if not re.fullmatch('[a-f0-9-]{36}', source):
            raise RuntimeError('SOURCE_RECEIPT_INVALID')
        count = int(database(release_env, f"""WITH inserted AS (
          INSERT INTO ownership_isolation_receipts(account_id,workspace_id,previous_owner_id,generation,method,evidence_sha256,verified_at)
          SELECT p.account_id,p.workspace_id,p.previous_owner_id,p.generation,p.method,'{digest}',now()
          FROM ownership_isolation_receipts p JOIN session_ownership o ON o.account_id=p.account_id::text AND o.workspace_id=p.workspace_id AND o.owner_id=p.previous_owner_id AND o.generation=p.generation
          JOIN records a ON a.id=p.account_id AND a.workspace_id=p.workspace_id
          WHERE p.id='{source}' AND p.evidence_sha256='{candidate['evidence_sha256']}' AND p.consumed_at IS NULL
          AND p.verified_at<=now()-interval '24 hours' AND o.frozen AND a.environment='REAL' AND a.kind='channel_account' AND a.body->>'provider'='waha' AND NOT(a.body?'deleted_at')
          AND NOT EXISTS(SELECT 1 FROM ownership_isolation_receipts fresh WHERE fresh.account_id=p.account_id AND fresh.workspace_id=p.workspace_id AND fresh.previous_owner_id=p.previous_owner_id AND fresh.generation=p.generation AND fresh.consumed_at IS NULL AND fresh.verified_at>now()-interval '24 hours' AND fresh.verified_at<=now())
          RETURNING id,workspace_id,account_id,generation), audited AS (
          INSERT INTO domain_events(workspace_id,environment,event_type,aggregate_id,correlation_id,actor,payload)
          SELECT workspace_id,'REAL','channel.isolation_reverified',account_id::text,gen_random_uuid()::text,'{{"type":"installer"}}'::jsonb,
          jsonb_build_object('receipt_id',id,'source_receipt_id','{source}','generation',generation,'method','container_stopped_and_access_revoked','evidence_sha256','{digest}') FROM inserted RETURNING id)
          SELECT count(*) FROM audited;"""))
        private_write(evidence_path, {'proof': evidence, 'evidence_sha256': digest, 'receipts_inserted': count, 'status': 'VERIFIED'})
        inserted += count
        handled.add(scope)
    return inserted


def history_directory(evidence_path):
    configured = os.environ.get('COMMERCE_OWNERSHIP_HISTORY_DIR')
    directory = Path(configured) if configured else Path(evidence_path).parent
    if configured and not directory.is_absolute():
        raise RuntimeError('OWNERSHIP_EVIDENCE_PERMISSIONS_INVALID')
    if directory.is_symlink() or not directory.is_dir():
        raise RuntimeError('OWNERSHIP_EVIDENCE_PERMISSIONS_INVALID')
    info = directory.stat()
    if info.st_mode & 0o077 or info.st_uid != os.geteuid():
        raise RuntimeError('OWNERSHIP_EVIDENCE_PERMISSIONS_INVALID')
    return directory


def archive_proof(directory, proof, digest):
    """Keep one immutable canonical proof across deployment report directories.

    Only a matching database receipt can authorize historical reverification.
    Archiving before the insert also preserves proof of an uncertain DB result.
    """
    path = directory/('proof-'+digest+'.attested.json')
    document = {'proof': proof, 'evidence_sha256': digest}
    if path.exists() or path.is_symlink():
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor) as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid() or info.st_size > 1024*1024:
                raise RuntimeError('OWNERSHIP_EVIDENCE_PERMISSIONS_INVALID')
            if json.load(source) != document:
                raise RuntimeError('OWNERSHIP_HISTORY_PROOF_MISMATCH')
        return
    private_write(path, document)


def attest(release_env, evidence_path):
    path = Path(evidence_path)
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise RuntimeError('OWNERSHIP_EVIDENCE_PERMISSIONS_INVALID')
    history = history_directory(path)
    snapshot = json.loads(path.read_text())
    current = [inspect(item) for item in container_ids(release_env)]
    if not current or any(not item or not item['running'] for item in current):
        raise RuntimeError('REPLACEMENT_CHANNEL_NOT_RUNNING')
    states = {item['id']: inspect(item['id']) for item in snapshot['containers']}
    if not validate_snapshot(snapshot, states, [item['id'] for item in current]):
        return {'receipts_inserted': 0, 'replacement': False, 'reverified_receipts': reverify_expired(release_env, history, current)}
    proof = {'snapshot': snapshot, 'verified_containers': states, 'replacement_ids': [item['id'] for item in current]}
    digest = hashlib.sha256(json.dumps(proof, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    archive_proof(history, proof, digest)
    payload = json.dumps(snapshot['owners'], separators=(',', ':')).replace("'", "''")
    sql = f"""WITH candidates AS (SELECT * FROM jsonb_to_recordset('{payload}'::jsonb) AS r(account_id text,workspace_id text,previous_owner_id text,generation integer)), inserted AS (INSERT INTO ownership_isolation_receipts(account_id,workspace_id,previous_owner_id,generation,method,evidence_sha256,verified_at) SELECT o.account_id::uuid,o.workspace_id,o.owner_id,o.generation,'container_stopped_and_access_revoked','{digest}',now() FROM candidates r JOIN session_ownership o ON o.account_id=r.account_id AND o.workspace_id=r.workspace_id AND o.owner_id=r.previous_owner_id AND o.generation=r.generation WHERE o.frozen AND NOT EXISTS(SELECT 1 FROM ownership_isolation_receipts p WHERE p.account_id=o.account_id::uuid AND p.previous_owner_id=o.owner_id AND p.generation=o.generation AND p.evidence_sha256='{digest}') RETURNING id,workspace_id,account_id,generation), audited AS (INSERT INTO domain_events(workspace_id,environment,event_type,aggregate_id,correlation_id,actor,payload) SELECT workspace_id,'REAL','channel.isolation_attested',account_id::text,gen_random_uuid()::text,'{{"type":"installer"}}'::jsonb,jsonb_build_object('receipt_id',id,'generation',generation,'method','container_stopped_and_access_revoked','evidence_sha256','{digest}') FROM inserted RETURNING id) SELECT count(*) FROM audited;"""
    count = int(database(release_env, sql))
    private_write(path.with_suffix('.attested.json'), {'proof': proof, 'evidence_sha256': digest, 'receipts_inserted': count, 'verified_at': dt.datetime.now(UTC).isoformat()})
    return {'receipts_inserted': count, 'replacement': True, 'reverified_receipts': reverify_expired(release_env, history, current)}


def main():
    if len(sys.argv) not in (3, 4) or sys.argv[1] not in ('capture', 'freeze', 'attest', 'supports', 'supports-recovery', 'hold', 'hold-recovery', 'release'):
        raise RuntimeError('USAGE_OWNERSHIP_ATTESTATION')
    action, release_env = sys.argv[1:3]
    if action in ('supports','supports-recovery'):
        print('1' if supports_hold(release_env,action=='supports-recovery') else '0')
        return
    if action == 'freeze':
        result = freeze(release_env)
    elif action in ('hold','hold-recovery'):
        result = hold(release_env,action=='hold-recovery')
    elif action == 'release':
        result = release_hold(release_env)
    else:
        if len(sys.argv) != 4:
            raise RuntimeError('OWNERSHIP_EVIDENCE_PATH_REQUIRED')
        result = (capture if action == 'capture' else attest)(release_env, sys.argv[3])
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Docker/psql/JSON failures may contain private data. Never echo their output.
        print('Ownership attestation failed; dispatch remains frozen. Inspect protected installer evidence.', file=sys.stderr)
        sys.exit(2)
