"""Inert037: authenticate paginated RR originals, spool exact triple coverage.

No API/SQL/import/erasure. The injected reader must enforce native-original
custody. Spool is a new private directory; incomplete work is preserved.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import uuid

import privacy_backup_attestation as base
from ci_release import require

EXTRA = frozenset({'source_rows_before', 'source_rows_after', 'restored_rows'})
ROOT = hashlib.sha256(b'PRIVACY_BACKUP_ROWS_V1').hexdigest()
IDENTIFIER = r'[A-Za-z_][A-Za-z0-9_]*'


def page_hash(entries):
    return base.sha(''.join(f"{e['relation']}:{e['key_sha256']}:{e['source_sha256']}\n"
                            for e in entries).encode())


def chain(previous, digest):
    return base.sha((previous + '\n' + digest).encode())


def read(ref, reader, maximum):
    checked = dict(base.history.checked_reference(ref))
    require(0 < checked['bytes'] <= maximum, 'PRIVACY_ROWS_ORIGINAL_BOUND')
    raw = reader(checked)
    require(type(raw) is bytes and len(raw) == checked['bytes'] and
            base.sha(raw) == checked['sha256'], 'PRIVACY_ROWS_ORIGINAL_CHANGED')
    return base.history.decode(raw)


def consume_capture(doc, read_original, *, workspace, catalog, ingest):
    """Every page belongs to one backend capture. Empty terminal page is valid."""
    capture = base.exact(doc['capture'], {'schema_version', 'kind', 'token',
        'workspace_id', 'environment', 'catalog_sha256', 'relations'}, 'PRIVACY_ROWS_CAPTURE')
    require(type(capture['schema_version']) is int and capture['schema_version'] == 1 and
            capture['kind'] == 'PRIVATE_ROW_CAPTURE' and capture['workspace_id'] == workspace and
            capture['environment'] == 'REAL' and capture['catalog_sha256'] == catalog,
            'PRIVACY_ROWS_CAPTURE_BINDING')
    require(str(uuid.UUID(capture['token'])) == capture['token'], 'PRIVACY_ROWS_CAPTURE_ID')
    relations = capture['relations']
    require(type(relations) is list and 0 < len(relations) <= 1000 and
            all(type(x) is str and re.fullmatch(r'public\.' + IDENTIFIER, x) for x in relations) and
            len(set(relations)) == len(relations), 'PRIVACY_ROWS_RELATIONS')
    pages = doc['pages']
    require(type(pages) is list and 0 < len(pages) <= 100000 and
            len({p['path'] for p in pages}) == len(pages), 'PRIVACY_ROWS_PAGES')
    root = ROOT; count = 0; previous = None; start = None; observed = None
    for index, ref in enumerate(pages):
        p = base.exact(read(ref, read_original, 1048576), {'schema_version', 'kind',
            'capture_id', 'workspace_id', 'environment', 'catalog_sha256', 'page_index',
            'entries', 'page_sha256', 'root_sha256', 'row_count', 'complete',
            'started_at', 'observed_at'}, 'PRIVACY_ROWS_PAGE')
        require(type(p['schema_version']) is int and p['schema_version'] == 1 and
                p['kind'] == 'PRIVATE_ROW_PAGE' and p['capture_id'] == capture['token'] and
                p['workspace_id'] == workspace and p['environment'] == 'REAL' and
                p['catalog_sha256'] == catalog and type(p['page_index']) is int and
                p['page_index'] == index and type(p['complete']) is bool and
                p['complete'] == (index == len(pages) - 1), 'PRIVACY_ROWS_PAGE_BINDING')
        at = base.instant(p['started_at']); now = base.instant(p['observed_at'])
        if start is None: start = at
        require(at == start and now >= start and (observed is None or now >= observed),
                'PRIVACY_ROWS_TIME')
        observed = now; entries = p['entries']
        require(type(entries) is list and len(entries) <= 2000 and
                (p['complete'] or len(entries) == 2000), 'PRIVACY_ROWS_PAGE_BOUND')
        for e in entries:
            base.exact(e, {'relation', 'key_sha256', 'source_sha256'}, 'PRIVACY_ROWS_ENTRY')
            require(e['relation'] in relations, 'PRIVACY_ROWS_RELATION')
            base.digest(e['key_sha256']); base.digest(e['source_sha256'])
            identity = (e['relation'], e['key_sha256'])
            require(previous is None or identity > previous, 'PRIVACY_ROWS_ORDER')
            previous = identity
        digest = page_hash(entries); root = chain(root, digest); count += len(entries)
        require(p['page_sha256'] == digest and p['root_sha256'] == root and
                type(p['row_count']) is str and p['row_count'] == str(count),
                'PRIVACY_ROWS_COUNT_OR_ROOT')
        ingest(entries)
    return {'count': count, 'root_sha256': root, 'started_at': start,
            'finished_at': observed, 'relations': sorted(relations)}


def prepare_privacy_backup_rows(originals, read_original, *, backup_id, workspace_id,
                                expected_capture_sha256, expected_catalog_sha256,
                                spool_directory, **backup_args):
    require(type(originals) is dict and set(originals) == base.history.ORIGINALS | base.EXTRA | EXTRA,
            'PRIVACY_ROWS_ORIGINAL_SET')
    require(type(backup_id) is str and str(uuid.UUID(backup_id)) == backup_id,
            'PRIVACY_ROWS_BACKUP_ID')
    require(type(workspace_id) is str and 0 < len(workspace_id) <= 256 and '\0' not in workspace_id,
            'PRIVACY_ROWS_WORKSPACE')
    base.digest(expected_capture_sha256); base.digest(expected_catalog_sha256)
    refs = {k: dict(base.history.checked_reference(v)) for k, v in originals.items()}
    require(len({r['path'] for r in refs.values()}) == 23 and
            sum(r['bytes'] for r in refs.values()) <= 32 * 1024 * 1024,
            'PRIVACY_ROWS_ORIGINAL_BOUND')
    # 031 authenticates its20 originals independently; page sets stay streamed.
    prepared = base.prepare_privacy_backup({k: v for k, v in refs.items() if k not in EXTRA},
                                           read_original, **backup_args)
    execution = read(refs['execution'], read_original, 8 * 1024 * 1024)
    restore = read(refs['restore_receipt'], read_original, 8 * 1024 * 1024)
    staging = read(refs['staging_plan'], read_original, 8 * 1024 * 1024)
    spool = Path(spool_directory)
    require(spool.is_absolute() and not spool.exists(), 'PRIVACY_ROWS_NEW_SPOOL_REQUIRED')
    spool.mkdir(mode=0o700)
    db = sqlite3.connect(spool / 'intersection.sqlite');os.chmod(spool / 'intersection.sqlite', 0o600)
    db.execute('CREATE TABLE coverage(relation TEXT NOT NULL,key_sha256 TEXT NOT NULL,source_sha256 TEXT NOT NULL,seen INTEGER NOT NULL,consistent INTEGER NOT NULL,PRIMARY KEY(relation,key_sha256)) WITHOUT ROWID')
    manifests = {}; evidence_refs = dict(refs); targets = [backup_args['source_target'], backup_args['source_target'], backup_args['restored_target']]
    try:
        for mask, name, phase, target in zip([1, 2, 4], ['source_rows_before', 'source_rows_after', 'restored_rows'], ['SOURCE_BEFORE_BACKUP', 'SOURCE_AFTER_BACKUP', 'RESTORED_DATABASE'], targets):
            doc = base.exact(read(refs[name], read_original, 8 * 1024 * 1024), {
                'schema_version', 'kind', 'phase', 'run_id', 'target', 'capture_sha256',
                'source_manifest_ref', 'ciphertext_sha256', 'restore_receipt_ref', 'capture', 'pages'}, 'PRIVACY_ROWS_ENVELOPE')
            require(type(doc['schema_version']) is int and doc['schema_version'] == 1 and
                    doc['kind'] == 'D18_NATIVE_ROW_READBACK' and doc['phase'] == phase and
                    doc['target'] == target and doc['capture_sha256'] == expected_capture_sha256 and
                    doc['run_id'] == prepared['import_arguments']['native_run'] and
                    doc['source_manifest_ref'] == refs['deployed_sources'] and
                    doc['ciphertext_sha256'] == staging['files']['ciphertext.backup.aes']['sha256'] and
                    doc['restore_receipt_ref'] == (refs['restore_receipt'] if mask == 4 else None),
                    'PRIVACY_ROWS_BINDING')
            def ingest(entries):
                if mask == 1:
                    db.executemany('INSERT INTO coverage VALUES(?,?,?,1,1)',
                                   [(e['relation'], e['key_sha256'], e['source_sha256']) for e in entries])
                else:
                    db.executemany('UPDATE coverage SET seen=seen|?,consistent=consistent AND source_sha256=? WHERE relation=? AND key_sha256=?',
                                   [(mask, e['source_sha256'], e['relation'], e['key_sha256']) for e in entries])
            manifests[name] = consume_capture(doc, read_original, workspace=workspace_id,
                catalog=expected_catalog_sha256, ingest=ingest)
            db.commit()
            for i, ref in enumerate(doc['pages']): evidence_refs[name + f'.page.{i}'] = dict(base.history.checked_reference(ref))
        before, after, restored = (manifests[n] for n in ['source_rows_before', 'source_rows_after', 'restored_rows'])
        require(before['relations'] == after['relations'] == restored['relations'], 'PRIVACY_ROWS_CATALOG_CHANGED')
        require(before['finished_at'] <= base.instant(execution['createTime']) and
                base.instant(execution['completionTime']) <= after['started_at'] <= after['finished_at'] <= base.instant(restore['started_at']) and
                base.instant(restore['started_at']) <= restored['started_at'] <= restored['finished_at'] <= base.instant(restore['finished_at']), 'PRIVACY_ROWS_TIME')
        require(len({r['path'] for r in evidence_refs.values()}) == len(evidence_refs), 'PRIVACY_ROWS_REUSED_ORIGINAL')
        evidence = base.sha(base.canonical(evidence_refs)); root = ROOT; count = 0; pages = []
        cursor = db.execute('SELECT relation,key_sha256,source_sha256 FROM coverage WHERE seen=7 AND consistent=1 ORDER BY relation COLLATE BINARY,key_sha256')
        while True:
            rows = cursor.fetchmany(2000)
            if not rows and pages: break
            entries = [dict(zip(['relation', 'key_sha256', 'source_sha256'], r)) for r in rows]
            raw = base.canonical(entries); path = spool / f'rows-{len(pages):06d}.json'
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as handle: handle.write(raw);handle.flush();os.fsync(handle.fileno())
            root = chain(root, page_hash(entries)); count += len(entries)
            pages.append({'path': str(path), 'sha256': base.sha(raw), 'bytes': len(raw)})
            if not rows: break
        return {'schema_version': 1, 'status': 'PRIVACY_BACKUP_ROWS_IMPORT_PREPARED',
            'backup_arguments': prepared['import_arguments'], 'row_arguments': {
                'backup_id': backup_id, 'restore_receipt': prepared['import_arguments']['restore_receipt'],
                'evidence_sha256': evidence, 'catalog_sha256': expected_catalog_sha256,
                'row_count': str(count), 'page_count': len(pages), 'root_sha256': root, 'pages': pages},
            'captured_rows': {k: str(v['count']) for k, v in manifests.items()},
            'coverage': 'EXACT_TRIPLE_INTERSECTION', 'valid_until': prepared['valid_until'],
            'originals_sha256': evidence, 'import_authorized': False, 'erasure_authorized': False}
    finally:
        db.close()
