"""Root-custodied boot admission, consumed only inside the canonical publisher.

The approval is an output of native release admission, never an input from the
candidate, an environment variable, a command-line flag or a receipt boolean.
Its provider originals are revalidated by the existing FULL/package contracts.
This module deliberately cannot create the approval or grant itself authority.
"""
import base64
import datetime as dt
from pathlib import Path
import re

from ci_release import require
import copy_runtime_deployment as runtime
import runtime_boot_host as host
import runtime_boot_restore_gate as restore

APPROVAL = host.PRIVATE / 'host-boot-approval.json'
EVIDENCE = host.PRIVATE / 'host-boot-evidence'
NATIVE = frozenset({'project', 'admission', 'full_build', 'full_commit', 'full_logs',
                    'package_build', 'package_logs', 'artifact_manifest'})
FIELDS = frozenset({'schema_version', 'source_sha', 'run_id', 'archive_sha256',
    'host_id', 'gateway_start_ids', 'created_at', 'expires_at', 'native_originals',
    'restore_source_sha', 'restore_originals', 'restore_custody'})


def read(ref):
    restore.checked_reference(ref)
    path = Path(ref['path'])
    require(path.parent == EVIDENCE and path.name == ref['sha256']+'.json',
            'BOOT_ADMISSION_ORIGINAL_CUSTODY_REQUIRED')
    raw = host.protected(path, maximum=restore.MAX_ORIGINAL_BYTES)
    require(runtime.native.reference(path, raw) == ref, 'BOOT_ADMISSION_ORIGINAL_CHANGED')
    return raw


def pack_log_pages(query, pages):
    """Derived envelope; provider response bytes remain individually intact."""
    require(type(query) is str and query and type(pages) is list and 0 < len(pages) <= 8,
            'BOOT_ADMISSION_LOG_PAGES_INVALID')
    value = {'schema_version': 1, 'kind': 'BOOT_LOG_PAGES', 'filter': query,
             'pages': [{'bytes': len(p), 'sha256': runtime.sha256(p),
                        'base64': base64.b64encode(p).decode()} for p in pages]}
    raw = runtime.sealed_bytes(value)
    require(len(raw) <= restore.MAX_ORIGINAL_BYTES, 'BOOT_ADMISSION_LOG_PAGES_BOUND')
    logs(raw, query)
    return raw


def logs(raw, expected_filter=None):
    value = runtime._parse(raw)
    if value.get('kind') != 'BOOT_LOG_PAGES':
        require(type(value) is dict and set(value) <= {'entries', 'nextPageToken'}
                and value.get('nextPageToken', '') == ''
                and type(value.get('entries', [])) is list and len(value.get('entries', [])) < 100,
                'BOOT_ADMISSION_LOGS_INCOMPLETE')
        return value.get('entries', [])
    require(set(value) == {'schema_version', 'kind', 'filter', 'pages'}
            and type(value['schema_version']) is int and value['schema_version'] == 1
            and expected_filter is not None and value['filter'] == expected_filter
            and type(value['pages']) is list and 0 < len(value['pages']) <= 8,
            'BOOT_ADMISSION_LOG_PAGES_INVALID')
    entries = []; seen = set()
    for index, page in enumerate(value['pages']):
        require(type(page) is dict and set(page) == {'bytes', 'sha256', 'base64'}
                and type(page['bytes']) is int and 0 < page['bytes'] <= restore.MAX_ORIGINAL_BYTES
                and type(page['base64']) is str and len(page['base64']) <= (page['bytes']+2)//3*4,
                'BOOT_ADMISSION_LOG_PAGE_BOUND')
        try: body = base64.b64decode(page['base64'], validate=True)
        except ValueError: raise RuntimeError('BOOT_ADMISSION_LOG_PAGE_ENCODING') from None
        require(len(body) == page['bytes'] and runtime.sha256(body) == page['sha256'],
                'BOOT_ADMISSION_LOG_PAGE_CHANGED')
        parsed = runtime._parse(body)
        require(type(parsed) is dict and set(parsed) <= {'entries', 'nextPageToken'}
                and type(parsed.get('entries', [])) is list and len(parsed.get('entries', [])) <= 100,
                'BOOT_ADMISSION_LOG_PAGE_INVALID')
        token = parsed.get('nextPageToken', '')
        require(type(token) is str and len(token) <= 4096 and
                (bool(token) if index < len(value['pages'])-1 else token == '') and token not in seen,
                'BOOT_ADMISSION_LOGS_INCOMPLETE')
        if token: seen.add(token)
        entries.extend(parsed.get('entries', []))
    require(len(entries) <= 800, 'BOOT_ADMISSION_LOG_ENTRY_BOUND')
    return entries


def validate(approval, *, report, host_id, candidate_migrations,
             candidate_restore_sources, now, reader=read):
    require(type(approval) is dict and set(approval) == FIELDS
            and type(approval['schema_version']) is int and approval['schema_version'] == 1,
            'BOOT_ADMISSION_FIELDS_INVALID')
    issued, expires = restore.stamp(approval['created_at']), restore.stamp(approval['expires_at'])
    require(issued <= now < expires and expires-issued <= dt.timedelta(minutes=15),
            'BOOT_ADMISSION_EXPIRED')
    require(all(approval[k] == report.get(k) for k in ('source_sha', 'run_id', 'archive_sha256'))
            and approval['host_id'] == host_id and re.fullmatch('[1-9][0-9]{0,19}', host_id),
            'BOOT_ADMISSION_RELEASE_OR_HOST_CHANGED')
    require(type(approval['gateway_start_ids']) is dict
            and set(approval['gateway_start_ids']) <= runtime.GATEWAYS
            and all(runtime._hash(cid) for cid in approval['gateway_start_ids'].values()),
            'BOOT_ADMISSION_GATEWAY_SCOPE_INVALID')
    refs = approval['native_originals']
    require(type(refs) is dict and set(refs) == NATIVE, 'BOOT_ADMISSION_NATIVE_SET_CHANGED')
    originals = {name: reader(ref) for name, ref in refs.items()}
    # Fixed imports from the same verified release. Missing F0 integration fails
    # before a journal, private-directory creation, or systemd effect.
    import cloudbuild_full_evidence as full
    import cloudbuild_release_evidence as release
    import ci_provider_evidence as provider
    admission = runtime._parse(originals['admission']); context = release.validate_admission(admission)
    require(context['package_origin'] == 'cloud-build' and context == report.get('provider_evidence')
            and context['source_sha'] == report['source_sha'] and context['source_tree'] == report.get('source_tree')
            and provider.CLOUD_RUN.fullmatch(report['run_id'])
            and provider.CLOUD_RUN.fullmatch(report['run_id'])[1] == context['package_build_id'],
            'BOOT_ADMISSION_NATIVE_PACKAGE_REQUIRED')
    project = runtime._parse(originals['project'])
    require(project.get('projectId') == full.PROJECT
            and re.fullmatch('[1-9][0-9]*', str(project.get('projectNumber'))), 'BOOT_ADMISSION_PROJECT_CHANGED')
    verify = admission['verification_manifest']
    require(full.validate_native(verify, runtime._parse(originals['full_build']),
            runtime._parse(originals['full_commit']), project['projectNumber']) == 'success',
            'BOOT_ADMISSION_FULL_REQUIRED')
    full_query = full.log_filter(verify)
    full.validate_full_receipt(verify, full.receipts_from_logs(logs(originals['full_logs'], full_query), verify))
    _manifest, prefix = release.package_native(admission, runtime._parse(originals['package_build']), project['projectNumber'])
    release.archive_record(originals['artifact_manifest'], prefix)
    package_query = ('resource.type="build" AND resource.labels.build_id="'+context['package_build_id']+
        '" AND resource.labels.project_id="'+full.PROJECT+'" AND "'+release.PACKAGE_GATE+'"')
    receipt = release.package_receipt(logs(originals['package_logs'], package_query), context)
    require(receipt['archive_sha256'] == report['archive_sha256'], 'BOOT_ADMISSION_ARCHIVE_CHANGED')
    custody = approval['restore_custody']; historical = approval['restore_originals']
    require(type(historical) is dict and set(historical) == restore.ORIGINALS
            and type(custody) is dict and set(custody) == {r['path'] for r in historical.values()},
            'BOOT_ADMISSION_RESTORE_CUSTODY_CHANGED')
    def restored(ref):
        target = custody[ref['path']]
        require(restore.linked(ref, target), 'BOOT_ADMISSION_RESTORE_COPY_CHANGED')
        return reader(target)
    compatibility = restore.validate_restore_for_candidate(historical, restored,
        expected_source_sha=approval['restore_source_sha'], now=now,
        candidate_source_sha=report['source_sha'], candidate_migrations=candidate_migrations,
        candidate_restore_sources=candidate_restore_sources)
    return {'provider_evidence': context, 'restore': compatibility,
            'approval_sha256': runtime.sha256(runtime.sealed_bytes(approval))}
