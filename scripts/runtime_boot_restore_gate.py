"""Pure validation of historical restore originals and candidate compatibility.

The canonical installer supplies an immutable reference allowlist acquired by
Root and a custody-checking reader. Coherent caller-authored JSON is not native
acquisition evidence. This module performs no reads, imports of supplied code,
network requests, writes, restoration, or authorization to install. Historical
restore time is not renewed; current admission and predeploy backup are separate
mandatory gates in the installer.
"""
import datetime as dt
import hashlib
import json
from pathlib import PurePosixPath
import re

import b02_backup_contract as contract
from ci_release import require

MAX_ORIGINAL_BYTES = 4 * 1024 * 1024
ORIGINALS = frozenset({'root_report', 'staging_plan', 'execution', 'download',
    'custody', 'restore_control', 'restore_receipt', 'restore_export',
    'trigger_relay', 'authorization', 'claim', 'terminal_log', 'source', 'backup',
    'source_manifest', 'readback_queries'})
RUNTIME = frozenset({'scripts/restore.mjs', 'scripts/postgres-tool.mjs',
    'scripts/backup-database.mjs', 'scripts/local-env.mjs', 'scripts/backup.mjs',
    'scripts/b02-portal-capsule.mjs', 'scripts/b02_backup_contract.py',
    'scripts/b02-backup-root.py'})


def sha(raw): return hashlib.sha256(raw).hexdigest()


def decode(raw):
    def pairs(rows):
        value = {}
        for name, item in rows:
            require(name not in value, 'BOOT_RESTORE_DUPLICATE_JSON'); value[name] = item
        return value
    value = json.loads(raw, object_pairs_hook=pairs,
        parse_constant=lambda _: require(False, 'BOOT_RESTORE_NONFINITE'))
    require(type(value) is dict, 'BOOT_RESTORE_OBJECT_REQUIRED')
    return value


def checked_reference(ref):
    require(type(ref) is dict and set(ref) == {'path', 'bytes', 'sha256'}, 'BOOT_RESTORE_REFERENCE_FIELDS')
    path = ref['path']
    require(type(path) is str and path.startswith('/') and str(PurePosixPath(path)) == path
            and '..' not in PurePosixPath(path).parts and '\x00' not in path,
            'BOOT_RESTORE_REFERENCE_PATH')
    require(type(ref['bytes']) is int and 0 < ref['bytes'] <= MAX_ORIGINAL_BYTES
            and type(ref['sha256']) is str and re.fullmatch('[a-f0-9]{64}', ref['sha256']),
            'BOOT_RESTORE_REFERENCE_BOUND')
    return ref


def linked(first, second):
    return (type(first) is dict and type(second) is dict and
            all(first.get(k) == second.get(k) for k in ('bytes', 'sha256')))


def stamp(value):
    require(type(value) is str, 'BOOT_RESTORE_TIME_REQUIRED')
    result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(result.tzinfo is not None, 'BOOT_RESTORE_TIMEZONE_REQUIRED')
    return result


def hashes(value, *, migrations=False):
    require(type(value) is dict and value, 'BOOT_RESTORE_SOURCE_MAP_REQUIRED')
    pattern = r'[0-9]{4}_[a-z0-9_]+\.sql' if migrations else r'scripts/[a-z0-9_.-]+'
    require(all(type(k) is str and re.fullmatch(pattern, k) and type(v) is str
                and re.fullmatch('[a-f0-9]{64}', v) for k, v in value.items()),
            'BOOT_RESTORE_SOURCE_MAP_INVALID')
    return value


def trigger(report, auth, claim, execution, terminal, refs, source):
    """Archived identity remains tied to its old binding, never the live pointer."""
    run = report['run_id']; binding = contract.gcp_binding(auth['binding']); context = auth['context']
    binding_raw = contract.canonical(binding)
    require(auth.get('schema_version') == 1 and auth.get('kind') == 'B02_GCP_AUTHORIZATION'
            and context.get('kind') == 'GCP_CLOUD_RUN' and context.get('mode') == binding['mode']
            and context.get('binding_sha256') == sha(binding_raw)
            and linked(auth['binding_ref'], {'bytes': len(binding_raw), 'sha256': sha(binding_raw)})
            and auth.get('caller') == {'name': binding['executor_id'], 'uid': binding['oslogin_uid'],
                                     'username': binding['oslogin_username']}, 'BOOT_RESTORE_AUTHORIZATION_CHANGED')
    require(context.get('run_id') == run == contract.gcp_run_identity(context.get('execution_uid'))
            and context.get('source_sha') == binding['source_sha'] == source
            and context.get('plan_sha256') == binding['plan_sha256'] == report['plan_sha256']
            and context.get('scheduled_delivery_proven') is False, 'BOOT_RESTORE_TRIGGER_IDENTITY_CHANGED')
    created = stamp(context['created_at']); issued = stamp(auth['issued_at']); expires = stamp(auth['expires_at'])
    require(dt.timedelta(0) <= issued-created <= dt.timedelta(minutes=5)
            and expires-issued == dt.timedelta(seconds=120), 'BOOT_RESTORE_PERMIT_TIME_CHANGED')
    if binding['mode'] == 'SCHEDULED':
        hour, minute = map(int, binding['schedule_utc'].split(':'))
        slot = created.replace(hour=hour, minute=minute, second=0, microsecond=0)
        require(context.get('slot') == slot.isoformat() and dt.timedelta(0) <= created-slot < dt.timedelta(minutes=30), 'BOOT_RESTORE_SLOT_CHANGED')
        slot_key = binding['scheduler']+':'+slot.isoformat()
    else:
        require(context.get('slot') is None, 'BOOT_RESTORE_SLOT_CHANGED'); slot_key = 'manual:'+context['execution_uid']
    require(claim == {'schema_version': 1, 'slot_key': slot_key,
        'authorization_ref': report['trigger']['authorization_ref'], 'run_id': run}, 'BOOT_RESTORE_CLAIM_CHANGED')
    require(report['trigger']['authorization_ref']['path'] == str(contract.PRIVATE/'daily-b02/gcp-authorizations'/(run+'.json'))
            and report['trigger']['claim_ref']['path'] == str(contract.PRIVATE/'daily-b02/schedule-claims'/(sha(slot_key.encode())+'.json'))
            and auth['binding_ref']['path'] == str(contract.PRIVATE/'daily-b02/gcp-binding.json'), 'BOOT_RESTORE_TRIGGER_PATH_CHANGED')
    for name in ('authorization', 'claim'):
        require(linked(report['trigger'][name+'_ref'], refs[name]), 'BOOT_RESTORE_ROOT_TRIGGER_LINK')
    require(execution.get('uid') == context['execution_uid'] and execution.get('name') == context['execution']
            and execution.get('job') == binding['job'].rsplit('/', 1)[-1]
            and execution.get('creator') == context['creator'] and execution.get('createTime') == context['created_at'],
            'BOOT_RESTORE_EXECUTION_IDENTITY_CHANGED')
    template = {k: execution.get(k) for k in ('taskCount', 'parallelism', 'template')}
    require(sha(contract.canonical(template)) == binding['template_sha256'], 'BOOT_RESTORE_EXECUTION_TEMPLATE_CHANGED')
    require(type(execution.get('succeededCount')) is int and execution['succeededCount'] == 1
            and all(type(execution.get(k, 0)) is int and execution.get(k, 0) == 0
                    for k in ('failedCount', 'cancelledCount', 'retriedCount', 'runningCount'))
            and not execution.get('deleteTime'), 'BOOT_RESTORE_EXECUTION_NOT_SUCCEEDED')
    started = stamp(execution['startTime']); completed = stamp(execution['completionTime'])
    require(created <= started <= completed <= stamp(binding['valid_until'])
            and completed-started <= dt.timedelta(seconds=1800), 'BOOT_RESTORE_EXECUTION_TIME_CHANGED')
    project = contract.TARGET[0]
    require(terminal.get('resource') == {'type': 'cloud_run_job', 'labels': {
        'project_id': project, 'job_name': binding['job'].rsplit('/', 1)[-1], 'location': 'us-east1'}}
        and terminal.get('logName') == 'projects/'+project+'/logs/run.googleapis.com%2Fstdout'
        and terminal.get('labels', {}).get('run.googleapis.com/execution_name') == context['execution'].rsplit('/', 1)[-1]
        and type(terminal.get('insertId')) is str and 0 < len(terminal['insertId']) <= 256
        and created <= stamp(terminal['timestamp']) <= completed, 'BOOT_RESTORE_TERMINAL_ORIGIN_CHANGED')
    result = terminal['jsonPayload']
    require(result.get('status') == 'B02_GCP_OFFSITE_VERIFIED' and result.get('run_id') == run
            and result.get('source_sha') == source and result.get('execution') == context['execution']
            and result.get('execution_uid') == context['execution_uid'] and result.get('external_copy_verified') is True
            and result.get('restore_verified') is False and result.get('scheduled_delivery_proven') is False,
            'BOOT_RESTORE_TERMINAL_CHANGED')
    require(result.get('root_ack') == {'status':'SUCCEEDED','run_id':run,'source_sha':source,'external_copy_verified':True}
            and result.get('export_discard_command_succeeded') is True, 'BOOT_RESTORE_TERMINAL_ACK_CHANGED')
    clean=result.get('ephemeral_key_cleanup',{})
    require(clean.get('key_absent_verified') is True and type(clean.get('remove_calls')) is int
            and type(clean.get('profile_reads')) is int and (clean['remove_calls'],clean['profile_reads']) in ((0,1),(1,2)), 'BOOT_RESTORE_TERMINAL_CLEANUP_CHANGED')
    return completed


def validate_historical_restore(originals, read_original, *, expected_source_sha, now):
    """Validate Root-pinned originals; reader enforces custody and allowlist.

    Original embedded paths are compared as metadata and are never followed.
    The reader can map a pinned ref to identical bytes in new Root custody.
    It must not accept arbitrary caller-provided files merely because they hash.
    """
    require(type(originals) is dict and set(originals) == ORIGINALS, 'BOOT_RESTORE_ORIGINAL_SET')
    require(type(expected_source_sha) is str and re.fullmatch('[a-f0-9]{40}', expected_source_sha), 'BOOT_RESTORE_SOURCE_REQUIRED')
    require(isinstance(now, dt.datetime) and now.tzinfo is not None, 'BOOT_RESTORE_NOW_REQUIRED')
    refs = {}; docs = {}
    for name in sorted(ORIGINALS):
        ref = checked_reference(originals[name]); refs[name] = dict(ref)
        raw = read_original(dict(ref))
        require(type(raw) is bytes and len(raw) == ref['bytes'] and sha(raw) == ref['sha256'], 'BOOT_RESTORE_ORIGINAL_CHANGED')
        docs[name] = decode(raw)
    require(len({r['path'] for r in refs.values()}) == len(refs), 'BOOT_RESTORE_ORIGINAL_ALIAS')
    report, plan, control, receipt, export = (docs[n] for n in ('root_report', 'staging_plan', 'restore_control', 'restore_receipt', 'restore_export'))
    source = expected_source_sha; run = report.get('run_id')
    require(type(run) is str and re.fullmatch('gcp-[a-f0-9]{32}', run), 'BOOT_RESTORE_RUN_REQUIRED')
    require(report.get('status') == 'SUCCEEDED' and report.get('external_copy_verified') is True
            and report.get('restore_verified') is False and report.get('source_sha') == source
            and report.get('backup_contract_version') == 2, 'BOOT_RESTORE_ROOT_NOT_SUCCEEDED')
    require(plan.get('status') == 'FRESH_STAGING_PLAN_VERIFIED_NO_RESTORE' and plan.get('source_sha') == source
            and plan.get('run_id') == run and plan.get('native_report_sha256') == refs['root_report']['sha256'], 'BOOT_RESTORE_PLAN_CHANGED')
    for name, filename in {'root_report': 'root-report.json', 'execution': 'trigger-execution.json',
        'download': 'relay-download-receipt.json', 'custody': 'custody.json', 'trigger_relay': 'trigger-relay.json',
        'authorization': 'trigger-authorization.json', 'claim': 'trigger-claim.json',
        'terminal_log': 'trigger-terminal-log.json', 'source': 'source.json', 'backup': 'backup.json'}.items():
        require(linked(plan['files'][filename], refs[name]), 'BOOT_RESTORE_PLAN_ORIGINAL_LINK')
    completed = trigger(report, docs['authorization'], docs['claim'], docs['execution'], docs['terminal_log'], refs, source)
    begin, end = (stamp(plan['native_window'][k]) for k in ('not_before', 'not_after'))
    require(begin <= stamp(docs['execution']['createTime']) <= completed <= end <= now
            and end-begin <= dt.timedelta(hours=2), 'BOOT_RESTORE_NATIVE_WINDOW_CHANGED')
    custody, download = docs['custody'], docs['download']; bucket = download.get('bucket')
    contract.validate_custody(custody, report, bucket)
    require(download.get('status') == 'B02_LOCAL_OFFHOST_DOWNLOAD_VERIFIED' and download.get('proof_scope') == 'AUTHENTIC_ROOT_OFFHOST'
            and download.get('run_id') == run and download.get('plan_sha256') == report['plan_sha256'], 'BOOT_RESTORE_DOWNLOAD_CHANGED')
    names = {'source.json', 'backup.json', 'ciphertext.backup.aes', 'portal.backup.aes', 'custody.json'}
    require(set(download['objects']) == set(download['files']) == names and set(control['files']) == names, 'BOOT_RESTORE_OBJECT_SET')
    for name in names:
        obj, file = download['objects'][name], plan['files'][name]
        require(obj.get('bucket', bucket) == bucket and (name != 'custody.json' or obj.get('bucket') == bucket)
                and obj.get('object') == 'b02/daily/'+run+'/'+name and type(obj.get('generation')) is str
                and re.fullmatch('[1-9][0-9]*', obj['generation']) and obj.get('full_download_verified') is True
                and linked(obj, file) and linked(download['files'][name], file) and linked(control['files'][name], file),
                'BOOT_RESTORE_OBJECT_LINK_CHANGED')
        if name != 'custody.json':
            require(obj == custody['objects'][name] and linked(file, report['exports'][name]), 'BOOT_RESTORE_CUSTODY_CHANGED')
    fifth = download['objects']['custody.json']
    require(docs['terminal_log']['jsonPayload'].get('custody_object') == fifth, 'BOOT_RESTORE_FIFTH_CHANGED')
    relay = docs['trigger_relay']
    require(relay.get('status') == 'GCP_TRIGGER_EVIDENCE_COPIED_LOCAL' and relay.get('source_sha') == source
            and relay.get('run_id') == run and relay.get('plan_sha256') == report['plan_sha256']
            and relay.get('custody_object') == fifth and linked(relay['root_report_ref'], refs['root_report'])
            and linked(relay['custody_ref'], refs['custody']), 'BOOT_RESTORE_RELAY_CHANGED')
    require(control.get('run_id') == run and control.get('caller_source_sha') == source
            and control.get('plan_sha256') == report['plan_sha256'] and control.get('bucket') == bucket
            and control.get('backup_source_sha') == report.get('backup_source_sha')
            and control.get('proof_scope') == 'AUTHENTIC_ROOT_OFFHOST'
            and linked(control['root_report_ref'], refs['root_report'])
            and linked(control['source_manifest_ref'], refs['source_manifest'])
            and linked(control['relay_receipt_ref'], refs['download'])
            and linked(control['trigger_relay_ref'], refs['trigger_relay']), 'BOOT_RESTORE_CONTROL_CHANGED')
    evidence=control['gcp_evidence']
    for name in ('authorization','claim'):
        require(evidence[name]['root_ref']==report['trigger'][name+'_ref'] and linked(evidence[name]['local_ref'],refs[name]), 'BOOT_RESTORE_CONTROL_TRIGGER_LINK')
    require(linked(evidence['execution_ref'],refs['execution']) and linked(evidence['terminal_log_ref'],refs['terminal_log']), 'BOOT_RESTORE_CONTROL_TRIGGER_LINK')
    manifest, queries = docs['source_manifest'], docs['readback_queries']
    migrations = hashes(manifest.get('migration_files'), migrations=True)
    runtime = hashes(manifest.get('runtime_files'))
    require(set(runtime) == RUNTIME and manifest.get('source_sha') == source
            and manifest.get('backup_source_sha') == report['backup_source_sha']
            and manifest['adapter_files'].get('readback-queries.json') == refs['readback_queries']['sha256'], 'BOOT_RESTORE_SOURCE_MANIFEST_CHANGED')
    require(set(control['canonical_refs'])=={'root','contract'} and set(relay['canonical_refs'])=={'root','contract'}, 'BOOT_RESTORE_CANONICAL_SOURCE_SET')
    for name,filename in (('root','scripts/b02-backup-root.py'),('contract','scripts/b02_backup_contract.py')):
        require(control['canonical_refs'][name]['sha256']==runtime[filename] and linked(control['canonical_refs'][name],relay['canonical_refs'][name]), 'BOOT_RESTORE_CANONICAL_SOURCE_LINK')
    require(type(queries.get('zero_barriers')) is dict and queries['zero_barriers'], 'BOOT_RESTORE_READBACK_CONTRACT_REQUIRED')
    for name in ('source', 'backup'):
        value = docs[name]
        require(value.get('run_id') == run and value.get('plan_sha256') == report['plan_sha256']
                and value.get('backup_source_sha') == report['backup_source_sha'] and value.get('backup_contract_version') == 2
                and value.get('portal_capsule') == report['portal_capsule'] and value.get('keys_exported') is False, 'BOOT_RESTORE_SOURCE_BACKUP_CHANGED')
    require(docs['source'].get('status') == 'B02_SOURCE_VERIFIED' and docs['source'].get('original_key_compared_in_RAM') is True
            and docs['source'].get('canonical_sources') == manifest.get('backup_canonical_sources')
            and docs['backup'].get('status') == 'B02_LOCAL_CIPHERTEXT_VERIFIED' and docs['backup'].get('encrypted') is True
            and docs['backup'].get('format') == 2 and docs['backup'].get('snapshot_consistent') is True, 'BOOT_RESTORE_CIPHERTEXT_NOT_VERIFIED')
    require(receipt.get('schema_version') == 1 and receipt.get('status') == 'RESTORE_VERIFIED_PLAINTEXT_RETAINED'
            and receipt.get('run_id') == run and receipt.get('source_sha') == receipt.get('restore_source_sha') == receipt.get('root_caller_source_sha') == source
            and receipt.get('backup_source_sha') == report['backup_source_sha']
            and receipt.get('proof_scope') == 'AUTHENTIC_ROOT_OFFHOST' and receipt.get('restore_environment') == 'LOCAL_COLIMA'
            and receipt.get('production_access') is False and receipt.get('external_effects') is False
            and receipt.get('control_sha256') == sha(json.dumps(control, sort_keys=True, separators=(',', ':')).encode()), 'BOOT_RESTORE_RECEIPT_CHANGED')
    proof = receipt['backup_trigger_proof']
    require(proof.get('kind') == 'GCP_ROOT_AND_PROVIDER_TERMINAL' and proof.get('run_id') == run
            and proof.get('execution_uid') == docs['execution']['uid'] and proof.get('custody_object') == fifth, 'BOOT_RESTORE_RECEIPT_TRIGGER_CHANGED')
    require(completed <= stamp(receipt['started_at']) <= stamp(receipt['finished_at']) <= now, 'BOOT_RESTORE_RECEIPT_TIME_CHANGED')
    isolation=receipt['local_isolation'];cluster=receipt['checks']['cluster']
    require(isolation.get('environment')=='LOCAL_COLIMA' and isolation.get('network')=='LOOPBACK_ONLY_NO_ROUTES'
            and all(isolation.get(k)is True for k in ('effective_capabilities_zero','no_new_privileges','external_homes_and_container_state_hidden'))
            and all(cluster.get(k)is True for k in ('durability_enabled','loopback_only','unix_socket_disabled')), 'BOOT_RESTORE_ISOLATION_CHANGED')
    checks = receipt['checks']; readback = checks['readback']; assets = checks['assets']; portal = checks['portal']
    require(checks.get('authenticated_before_database_write') is True
            and readback.get('exact_migration_hashes') is True and readback.get('integration_secrets_rls_exact') is True
            and readback.get('closed_roles') is True and type(readback.get('migration_count')) is int
            and readback['migration_count'] == len(migrations) and type(readback.get('zero_safety_barriers')) is int
            and readback['zero_safety_barriers'] == len(queries['zero_barriers'])
            and all(type(readback.get(k)) is int and readback[k] >= 0 for k in ('records', 'events', 'effects')), 'BOOT_RESTORE_READBACK_INCOMPLETE')
    require(assets.get('final_assets_stream_hash_verified') is True and type(assets.get('private_assets')) is int
            and assets['private_assets'] == docs['backup']['private_assets'] and assets['private_assets'] >= 0
            and type(assets.get('private_asset_bytes')) is int and assets['private_asset_bytes'] >= 0
            and type(assets.get('authenticated_manifest_sha256')) is str
            and re.fullmatch('[a-f0-9]{64}', assets['authenticated_manifest_sha256'])
            and all(portal.get(k) is True for k in ('verify', 'restore', 'owned_plaintext_removed'))
            and portal.get('production_promoted') is False, 'BOOT_RESTORE_ASSETS_PORTAL_INCOMPLETE')
    require(all(receipt['cleanup'].get(k) is True for k in ('postgres_stopped', 'processes_stopped', 'ciphertext_preserved', 'own_plaintext_retained')), 'BOOT_RESTORE_CLEANUP_INCOMPLETE')
    require(export.get('status') == 'AUTHENTIC_LOCAL_COLIMA_RESTORE_EXPORTED' and export.get('source_sha') == source
            and export.get('original_bytes_preserved') is True and export.get('production_access') is False
            and linked(export['local_receipt_ref'], refs['restore_receipt']) and linked(export['remote_receipt_ref'], refs['restore_receipt'])
            and linked(export['local_control_ref'], refs['restore_control']) and linked(export['remote_control_ref'], refs['restore_control']), 'BOOT_RESTORE_EXPORT_CHANGED')
    return {'status': 'HISTORICAL_RESTORE_ORIGINALS_VERIFIED', 'source_sha': source, 'run_id': run,
        'finished_at': receipt['finished_at'], 'originals': refs, 'migration_files': dict(migrations),
        'restore_sources': dict(runtime), 'readback_queries_sha256': refs['readback_queries']['sha256'],
        'historical_only': True, 'fresh_backup_proven': False, 'candidate_compatible': False,
        'installation_authorized': False}


def validate_candidate_compatibility(history, *, candidate_source_sha, candidate_migrations, candidate_restore_sources):
    """Inputs are derived from the already authenticated native FULL package.

    Call only on this invocation's validate_historical_restore return value;
    accepting an arbitrary stored summary bypasses original authentication.
    Changed schemas/tools require a corresponding restore, not a true flag.
    """
    require(history.get('status') == 'HISTORICAL_RESTORE_ORIGINALS_VERIFIED'
            and history.get('historical_only') is True, 'BOOT_RESTORE_HISTORY_REQUIRED')
    require(type(candidate_source_sha) is str and re.fullmatch('[a-f0-9]{40}', candidate_source_sha), 'BOOT_RESTORE_CANDIDATE_REQUIRED')
    require(hashes(candidate_migrations, migrations=True) == history['migration_files'], 'BOOT_RESTORE_CANDIDATE_MIGRATIONS_CHANGED')
    require(hashes(candidate_restore_sources) == history['restore_sources'], 'BOOT_RESTORE_CANDIDATE_TOOLS_CHANGED')
    return {'status': 'HISTORICAL_RESTORE_CANDIDATE_COMPATIBLE', 'candidate_source_sha': candidate_source_sha,
        'restored_source_sha': history['source_sha'], 'run_id': history['run_id'], 'restore_finished_at': history['finished_at'],
        'originals': history['originals'], 'historical_only': True, 'fresh_backup_proven': False,
        'installation_authorized': False}


def validate_restore_for_candidate(originals, read_original, *, expected_source_sha, now,
        candidate_source_sha, candidate_migrations, candidate_restore_sources):
    """Installer entry: always authenticate originals again before compatibility."""
    history = validate_historical_restore(originals, read_original,
        expected_source_sha=expected_source_sha, now=now)
    return validate_candidate_compatibility(history, candidate_source_sha=candidate_source_sha,
        candidate_migrations=candidate_migrations, candidate_restore_sources=candidate_restore_sources)
