"""Pure031 import preparation from Root-authenticated originals; no effects.

read_original MUST enforce Root's native acquisition/custody allowlist. Hashes
and coherent JSON from an untrusted caller do not satisfy that trust boundary.
"""
import datetime as dt
import hashlib
import json
import re

import runtime_boot_restore_gate as history
from ci_release import require

EXTRA = frozenset({'deployed_sources', 'source_topology_before',
                  'source_topology_after', 'restored_topology'})
MAX_TOTAL_BYTES = 16 * 1024 * 1024
REQUIRED_TRANSITIONS = frozenset({'024', '025', '028', '029', '030', '031', '032'})
# Execute only through a separately reviewed native acquisition operator. This
# is the same complete role metadata covered by031's fingerprint, with no OIDs.
TOPOLOGY_SQL = """SELECT clock_timestamp() AS observed_at,
 public.privacy_runtime_fingerprint() AS topology_sha256,
 (SELECT jsonb_agg(jsonb_build_object('name',rolname,'superuser',rolsuper,
 'login',rolcanlogin,'bypass',rolbypassrls,'create_role',rolcreaterole,
 'create_db',rolcreatedb,'inherit',rolinherit,'replication',rolreplication,
 'connection_limit',rolconnlimit,'valid_until',rolvaliduntil,
 'config',COALESCE(rolconfig,ARRAY[]::text[])) ORDER BY rolname) FROM pg_roles) AS roles,
 (SELECT COALESCE(jsonb_agg(jsonb_build_object('role',r.rolname,
 'member',m.rolname,'grantor',g.rolname,
 'admin_option',a.admin_option,'inherit_option',a.inherit_option,'set_option',a.set_option)
 ORDER BY r.rolname,m.rolname,g.rolname),'[]')
 FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid
 JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor) AS memberships"""
QUERY_SHA256 = hashlib.sha256(TOPOLOGY_SQL.encode()).hexdigest()
ROLE_FLAGS = frozenset({'superuser', 'login', 'bypass', 'create_role', 'create_db',
                        'inherit', 'replication'})
ROLE_FIELDS = ROLE_FLAGS | {'name', 'connection_limit', 'valid_until', 'config'}
MEMBER_FIELDS = frozenset({'role', 'member', 'grantor', 'admin_option',
                          'inherit_option', 'set_option'})


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def exact(value, fields, code):
    require(type(value) is dict and set(value) == set(fields), code)
    return value


def digest(value):
    require(type(value) is str and re.fullmatch('[a-f0-9]{64}', value),
            'PRIVACY_BACKUP_HASH_REQUIRED')
    return value


def instant(value):
    parsed = history.stamp(value)
    require(parsed.utcoffset() == dt.timedelta(0), 'PRIVACY_BACKUP_UTC_REQUIRED')
    return parsed


def name(value):
    require(type(value) is str and 0 < len(value) <= 256 and '\x00' not in value,
            'PRIVACY_BACKUP_IDENTITY_REQUIRED')
    return value


def source_map(value):
    require(type(value) is dict and 0 < len(value) <= 512,
            'PRIVACY_BACKUP_SOURCES_REQUIRED')
    for path, hashed in value.items():
        require(type(path) is str and re.fullmatch(
            r'(?:packages/db/migrations/[0-9]{4}_[a-z0-9_]+\.sql|'
            r'packages/db/profile-transition/(?:components/)?[0-9]{3}_[a-z0-9_]+\.sql|'
            r'scripts/[a-z0-9_.-]+)', path), 'PRIVACY_BACKUP_SOURCE_PATH')
        digest(hashed)
    transitions = {path.split('/')[-1][:3] for path in value
                   if path.startswith('packages/db/profile-transition/')}
    require(REQUIRED_TRANSITIONS <= transitions, 'PRIVACY_BACKUP_V7_INCOMPLETE')
    return dict(value)


def role_manifest(roles, memberships):
    require(type(roles) is list and 0 < len(roles) <= 512 and
            type(memberships) is list and len(memberships) <= 4096,
            'PRIVACY_BACKUP_ROLE_BOUND')
    names = set()
    for row in roles:
        exact(row, ROLE_FIELDS, 'PRIVACY_BACKUP_ROLE_FIELDS')
        identity = name(row['name'])
        require(identity not in names, 'PRIVACY_BACKUP_ROLE_DUPLICATE')
        names.add(identity)
        require(all(type(row[k]) is bool for k in ROLE_FLAGS) and
                type(row['connection_limit']) is int and row['connection_limit'] >= -1 and
                type(row['config']) is list and len(row['config']) <= 128 and
                all(type(v) is str and len(v) <= 4096 for v in row['config']),
                'PRIVACY_BACKUP_ROLE_ATTRIBUTES')
        if row['valid_until'] is not None:
            # PostgreSQL also permits infinity as an explicit expiration value.
            if row['valid_until'] not in ('infinity', '-infinity'):
                instant(row['valid_until'])
    seen = set()
    for row in memberships:
        exact(row, MEMBER_FIELDS, 'PRIVACY_BACKUP_MEMBERSHIP_FIELDS')
        key = tuple(row[k] for k in ('role', 'member', 'grantor'))
        require(all(type(k) is str and k in names for k in key) and key not in seen and
                all(type(row[k]) is bool for k in
                    ('admin_option', 'inherit_option', 'set_option')),
                'PRIVACY_BACKUP_MEMBERSHIP_ATTRIBUTES')
        seen.add(key)
    # Sorting is deterministic and only changes row order, never flags/config.
    return {'roles': sorted(roles, key=lambda r: r['name']),
            'memberships': sorted(memberships, key=lambda r: (r['role'], r['member'], r['grantor']))}


def prepare_privacy_backup(originals, read_original, *, expected_backup_source_sha,
                           expected_restore_source_sha, expected_deployed_source_sha,
                           expected_readback_queries_sha256, expected_files,
                           source_target, restored_target, now):
    """Return inert031 args, after authenticating every original in this call.

    Expected source set and target identities are independently adopted by Root,
    never inferred from submitted documents. No function imports or SQL writes.
    """
    require(type(originals) is dict and set(originals) == history.ORIGINALS | EXTRA,
            'PRIVACY_BACKUP_ORIGINAL_SET')
    require(isinstance(now, dt.datetime) and now.tzinfo is not None,
            'PRIVACY_BACKUP_CLOCK_REQUIRED')
    require(all(type(value) is str and re.fullmatch('[a-f0-9]{40}', value)
                for value in (expected_backup_source_sha, expected_restore_source_sha,
                              expected_deployed_source_sha)),
            'PRIVACY_BACKUP_DEPLOYMENT_REQUIRED')
    digest(expected_readback_queries_sha256)
    name(source_target); name(restored_target)
    require(source_target != restored_target, 'PRIVACY_BACKUP_TARGET_ALIAS')
    expected = source_map(expected_files)
    refs = {k: dict(history.checked_reference(v)) for k, v in originals.items()}
    require(len({r['path'] for r in refs.values()}) == len(refs) and
            sum(r['bytes'] for r in refs.values()) <= MAX_TOTAL_BYTES,
            'PRIVACY_BACKUP_ORIGINAL_BOUND')
    raws = {}
    for key in sorted(refs):
        ref = refs[key]; raw = read_original(dict(ref))
        require(type(raw) is bytes and len(raw) == ref['bytes'] and sha(raw) == ref['sha256'],
                'PRIVACY_BACKUP_ORIGINAL_CHANGED')
        raws[ref['path']] = raw
    docs = {k: history.decode(raws[r['path']]) for k, r in refs.items()}
    historical = history.validate_historical_restore(
        {k: refs[k] for k in history.ORIGINALS}, lambda r: raws[r['path']],
        expected_source_sha=expected_restore_source_sha, now=now)
    require(historical['readback_queries_sha256'] == expected_readback_queries_sha256,
            'PRIVACY_BACKUP_READBACK_CONTRACT_CHANGED')
    for path, hashed in historical['migration_files'].items():
        require(expected.get('packages/db/migrations/' + path) == hashed,
                'PRIVACY_BACKUP_MIGRATIONS_CHANGED')
    require({p[len('packages/db/migrations/'):]: h for p, h in expected.items()
             if p.startswith('packages/db/migrations/')} == historical['migration_files'],
            'PRIVACY_BACKUP_MIGRATIONS_CHANGED')
    require(all(expected.get(p) == h for p, h in historical['restore_sources'].items()),
            'PRIVACY_BACKUP_RESTORE_SOURCES_CHANGED')
    deployed = exact(docs['deployed_sources'], {'schema_version', 'kind', 'run_id',
        'deployed_source_sha', 'backup_source_sha', 'files', 'root_report_ref'},
        'PRIVACY_BACKUP_DEPLOYMENT_FIELDS')
    require(type(deployed['schema_version']) is int and deployed['schema_version'] == 1 and
            deployed['kind'] == 'D18_DEPLOYED_SOURCE_MANIFEST' and
            deployed['run_id'] == historical['run_id'] and
            deployed['deployed_source_sha'] == expected_deployed_source_sha and
            deployed['backup_source_sha'] == docs['root_report']['backup_source_sha'] == expected_backup_source_sha and
            deployed['root_report_ref'] == refs['root_report'] and
            source_map(deployed['files']) == expected, 'PRIVACY_BACKUP_DEPLOYMENT_CHANGED')
    # Native Job creation strictly predates this authenticated run's DB snapshot.
    # Do not substitute archive completion/manifest creation/restore time.
    snapshot = instant(docs['execution']['createTime'])
    completed = instant(docs['execution']['completionTime'])
    restore_started = instant(docs['restore_receipt']['started_at'])
    restored = instant(docs['restore_receipt']['finished_at'])
    deadline = snapshot + dt.timedelta(hours=24)
    require(snapshot <= completed <= restore_started <= restored <= now < deadline,
            'PRIVACY_BACKUP_WINDOW_EXPIRED')
    ciphertext = docs['staging_plan']['files']['ciphertext.backup.aes']
    observed = {}; manifests = {}; fingerprints = {}
    for key, phase, target in (
        ('source_topology_before', 'SOURCE_BEFORE_BACKUP', source_target),
        ('source_topology_after', 'SOURCE_AFTER_BACKUP', source_target),
        ('restored_topology', 'RESTORED_DATABASE', restored_target)):
        value = exact(docs[key], {'schema_version', 'kind', 'phase', 'run_id',
            'target', 'query_sha256', 'source_manifest_ref', 'ciphertext_sha256',
            'restore_receipt_ref', 'result'}, 'PRIVACY_BACKUP_TOPOLOGY_FIELDS')
        require(type(value['schema_version']) is int and value['schema_version'] == 1 and
                value['kind'] == 'D18_NATIVE_TOPOLOGY_READBACK' and value['phase'] == phase and
                value['run_id'] == historical['run_id'] and value['target'] == target and
                value['query_sha256'] == QUERY_SHA256 and
                value['source_manifest_ref'] == refs['deployed_sources'] and
                value['ciphertext_sha256'] == ciphertext['sha256'] and
                value['restore_receipt_ref'] == (refs['restore_receipt'] if key == 'restored_topology' else None),
                'PRIVACY_BACKUP_TOPOLOGY_BINDING')
        result = exact(value['result'], {'observed_at', 'topology_sha256', 'roles', 'memberships'},
                       'PRIVACY_BACKUP_TOPOLOGY_RESULT')
        observed[key] = instant(result['observed_at'])
        fingerprints[key] = digest(result['topology_sha256'])
        manifests[key] = role_manifest(result['roles'], result['memberships'])
    require(observed['source_topology_before'] <= snapshot and
            completed <= observed['source_topology_after'] <= restore_started and
            restore_started <= observed['restored_topology'] <= restored,
            'PRIVACY_BACKUP_TOPOLOGY_TIME')
    require(len(set(fingerprints.values())) == 1 and
            all(v == manifests['source_topology_before'] for v in manifests.values()),
            'PRIVACY_BACKUP_TOPOLOGY_CHANGED')
    return {'schema_version': 1, 'status': 'PRIVACY_BACKUP_IMPORT_PREPARED',
        'import_arguments': {'native_run': historical['run_id'],
            'snapshot': snapshot.isoformat(), 'restored': restored.isoformat(),
            'originals': sha(canonical(refs)), 'restore_receipt': refs['restore_receipt']['sha256'],
            'topology': fingerprints['restored_topology']},
        'valid_until': deadline.isoformat(), 'snapshot_is_conservative_lower_bound': True,
        'deployed_source_sha': expected_deployed_source_sha,
        'source_manifest_sha256': refs['deployed_sources']['sha256'],
        'readback_queries_sha256': expected_readback_queries_sha256,
        'restore_history': {'status': historical['status'], 'historical_only': True,
                            'fresh_backup_proven': False, 'installation_authorized': False},
        'import_authorized': False, 'erasure_authorized': False}
