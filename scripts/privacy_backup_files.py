"""Inert036 import preparation from23 Root-authenticated originals.

The injected reader enforces native acquisition custody, just as031 does. This
module cannot authenticate arbitrary caller JSON, acquire files or import SQL.
"""
import datetime as dt
import re
import uuid

import privacy_backup_attestation as base
from ci_release import require

EXTRA = frozenset({'source_files_before', 'source_files_after', 'restored_files'})
UUID = r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'


def nanos(stamp):
    delta = base.instant(stamp) - dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
    return (delta.days * 86400 + delta.seconds) * 1000000000 + delta.microseconds * 1000


def file_set(value, snapshot):
    require(type(value) is list and len(value) <= 10000, 'PRIVACY_FILES_BOUND')
    seen = set(); keys = set(); files = []
    for row in value:
        base.exact(row, {'asset_id', 'storage_key', 'ciphertext_sha256',
                         'ciphertext_bytes', 'mtime_ns'}, 'PRIVACY_FILES_FIELDS')
        asset = row['asset_id']; key = row['storage_key']; count = row['ciphertext_bytes']
        require(type(asset) is str and re.fullmatch(UUID, asset) and asset not in seen and
                type(key) is str and re.fullmatch(re.escape(asset) + r'(?:-[a-f0-9]{64})?', key) and
                key not in keys, 'PRIVACY_FILES_IDENTITY')
        require(type(count) is str and re.fullmatch(r'[1-9][0-9]{0,8}', count) and
                int(count) <= 536870912, 'PRIVACY_FILES_SIZE')
        mtime = row['mtime_ns']
        require(type(mtime) is str and re.fullmatch(r'[1-9][0-9]{0,20}', mtime) and
                int(mtime) <= snapshot, 'PRIVACY_FILES_NEWER_THAN_BACKUP')
        base.digest(row['ciphertext_sha256']); seen.add(asset); keys.add(key)
        files.append({key: value for key, value in row.items() if key != 'mtime_ns'})
    return sorted(files, key=lambda row: row['asset_id'])


def prepare_privacy_backup_files(originals, read_original, *, backup_id,
                                 expected_capture_sha256, **backup_args):
    """Revalidate031's20 originals plus three newly acquired ciphertext scans.

    backup_id is assigned by the authenticated operator to this exact031 import.
    No object from a previous validation is accepted as authority or renewed.
    """
    require(type(originals) is dict and set(originals) == base.history.ORIGINALS | base.EXTRA | EXTRA,
            'PRIVACY_FILES_ORIGINAL_SET')
    require(type(backup_id) is str and re.fullmatch(UUID, backup_id) and
            str(uuid.UUID(backup_id)) == backup_id, 'PRIVACY_FILES_BACKUP_ID')
    base.digest(expected_capture_sha256)
    refs = {k: dict(base.history.checked_reference(v)) for k, v in originals.items()}
    require(len({r['path'] for r in refs.values()}) == 23 and
            sum(r['bytes'] for r in refs.values()) <= 32 * 1024 * 1024,
            'PRIVACY_FILES_ORIGINAL_BOUND')
    raws = {}
    for key in sorted(refs):
        ref = refs[key]; raw = read_original(dict(ref))
        require(type(raw) is bytes and len(raw) == ref['bytes'] and base.sha(raw) == ref['sha256'],
                'PRIVACY_FILES_ORIGINAL_CHANGED')
        raws[ref['path']] = raw
    prepared = base.prepare_privacy_backup({k: v for k, v in refs.items() if k not in EXTRA},
                                           lambda r: raws[r['path']], **backup_args)
    docs = {k: base.history.decode(raws[r['path']]) for k, r in refs.items()}
    snapshot = nanos(prepared['import_arguments']['snapshot'])
    execution = docs['execution']; restore = docs['restore_receipt']
    times = {}; inventories = {}
    for key, phase, target in (
            ('source_files_before', 'SOURCE_BEFORE_BACKUP', backup_args['source_target']),
            ('source_files_after', 'SOURCE_AFTER_BACKUP', backup_args['source_target']),
            ('restored_files', 'RESTORED_VOLUME', backup_args['restored_target'])):
        doc = base.exact(docs[key], {'schema_version', 'kind', 'phase', 'run_id', 'target',
            'capture_sha256', 'source_manifest_ref', 'ciphertext_sha256', 'restore_receipt_ref',
            'result'}, 'PRIVACY_FILES_ENVELOPE')
        require(type(doc['schema_version']) is int and doc['schema_version'] == 1 and
                doc['kind'] == 'D18_NATIVE_FILE_READBACK' and doc['phase'] == phase and
                doc['target'] == target and doc['capture_sha256'] == expected_capture_sha256 and
                doc['run_id'] == prepared['import_arguments']['native_run'] and
                doc['source_manifest_ref'] == refs['deployed_sources'] and
                doc['ciphertext_sha256'] == docs['staging_plan']['files']['ciphertext.backup.aes']['sha256'] and
                doc['restore_receipt_ref'] == (refs['restore_receipt'] if key == 'restored_files' else None),
                'PRIVACY_FILES_BINDING')
        result = base.exact(doc['result'], {'schema_version', 'kind', 'started_at', 'finished_at', 'files'},
                            'PRIVACY_FILES_RESULT')
        require(type(result['schema_version']) is int and result['schema_version'] == 1 and
                result['kind'] == 'PRIVATE_CIPHERTEXT_INVENTORY', 'PRIVACY_FILES_RESULT')
        start = base.instant(result['started_at']); end = base.instant(result['finished_at'])
        require(start <= end, 'PRIVACY_FILES_TIME')
        times[key] = (start, end); inventories[key] = file_set(result['files'], snapshot)
    require(times['source_files_before'][1] <= base.instant(execution['createTime']) and
            base.instant(execution['completionTime']) <= times['source_files_after'][0] <=
            times['source_files_after'][1] <= base.instant(restore['started_at']) and
            base.instant(restore['started_at']) <= times['restored_files'][0] <=
            times['restored_files'][1] <= base.instant(restore['finished_at']), 'PRIVACY_FILES_TIME')
    require(all(files == inventories['source_files_before'] for files in inventories.values()),
            'PRIVACY_FILES_RESTORE_DIFFERENCE')
    return {'schema_version': 1, 'status': 'PRIVACY_BACKUP_FILES_IMPORT_PREPARED',
        'backup_arguments': prepared['import_arguments'],
        'file_arguments': {'backup_id': backup_id,
            'restore_receipt': prepared['import_arguments']['restore_receipt'],
            'evidence_sha256': base.sha(base.canonical(refs)),
            'entries': inventories['restored_files']},
        'originals_sha256': base.sha(base.canonical(refs)), 'valid_until': prepared['valid_until'],
        'capture_sha256': expected_capture_sha256, 'import_authorized': False,
        'erasure_authorized': False}
