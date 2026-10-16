"""Pure preparation only; Root authenticates/adopts inputs before any transfer.

No filesystem, subprocess, credentials, imports of candidate code or network.
The returned argv never grants authority to run it or substitutes native gates.
"""
import ast
import datetime as dt
import hashlib
import re
import sys
import uuid

SOURCE_LIMIT = 2 * 1024 * 1024
CATALOG_LIMIT = 128
PRIVATE = '/opt/commerce-os/private'
BACKUP_TOOLS = {'b02-backup-root.py', 'b02_backup_contract.py', 'b02-portal-capsule.mjs'}
REQUIRED_READERS = {'copy-runtime-approvals.py', 'copy_runtime_approvals.py',
    'deploy-ci-vps.py', 'ci_release.py', 'copy_runtime_deployment.py',
    'api_web_deployment.py', 'ci_provider_evidence.py', 'operator_identity.py'}
REQUEST_FIELDS = {'source_sha', 'source_tree', 'package_build_id',
    'installation_attempt', 'archive_sha256', 'archive_bytes', 'review_id',
    'issued_at', 'expires_at'}


def need(value, code):
    if not value:
        raise RuntimeError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def stamp(value):
    need(type(value) is str, 'REVIEW_TIME_REQUIRED')
    try:
        result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise RuntimeError('REVIEW_TIME_INVALID') from None
    need(result.tzinfo is not None and result.utcoffset() == dt.timedelta(0),
        'REVIEW_UTC_REQUIRED')
    return result


def window(issued_at, expires_at, *, now, remaining_seconds=0):
    need(isinstance(now, dt.datetime) and now.tzinfo is not None,
        'REVIEW_CLOCK_REQUIRED')
    need(type(remaining_seconds) is int and 0 <= remaining_seconds <= 7200,
        'REVIEW_REMAINING_INVALID')
    issued, expires = stamp(issued_at), stamp(expires_at)
    need(issued <= now < expires <= issued + dt.timedelta(hours=2)
        and now + dt.timedelta(seconds=remaining_seconds) < expires,
        'REVIEW_WINDOW_EXPIRED')
    return expires


def filename(value):
    need(type(value) is str and re.fullmatch(r'[a-zA-Z0-9_-]+\.(?:py|mjs)', value),
        'REVIEW_SOURCE_NAME_INVALID')
    return value


def literal_catalogue(raw, variable):
    need(type(raw) is bytes and 0 < len(raw) <= SOURCE_LIMIT,
        'REVIEW_SOURCE_BOUND')
    try:
        tree = ast.parse(raw)
        matches = [n.value for n in tree.body if isinstance(n, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == variable for t in n.targets)]
        need(len(matches) == 1, 'REVIEW_LITERAL_CATALOGUE_REQUIRED')
        names = ast.literal_eval(matches[0])
    except (SyntaxError, ValueError, TypeError):
        raise RuntimeError('REVIEW_LITERAL_CATALOGUE_REQUIRED') from None
    need(type(names) in (tuple, list) and 0 < len(names) <= CATALOG_LIMIT,
        'REVIEW_CATALOGUE_BOUND')
    for name in names:
        filename(name)
    need(len(set(names)) == len(names), 'REVIEW_CATALOGUE_DUPLICATE')
    return tuple(names)


def catalogue(sources, expected_hashes):
    """Inputs are exact script bytes/hashes from the authenticated source bundle.

    Static analysis covers direct module-level import statements. Conditional
    and dynamic closure needs isolated import validation. Canonical dynamic
    readers are explicitly required; the existing publisher catalogue retains
    its additional lazy boot dependencies. This is not a whole-program proof.
    """
    need(type(sources) is dict and type(expected_hashes) is dict
        and 0 < len(sources) <= CATALOG_LIMIT and set(sources) == set(expected_hashes),
        'REVIEW_SOURCE_SET_REQUIRED')
    for name, raw in sources.items():
        filename(name)
        need(type(raw) is bytes and 0 < len(raw) <= SOURCE_LIMIT
            and type(expected_hashes[name]) is str
            and sha(raw) == expected_hashes[name], 'REVIEW_SOURCE_CHANGED')
    for name in ('deploy-ci-client.py', 'copy_runtime_approvals.py'):
        need(name in sources, 'REVIEW_PRODUCER_MISSING')
    staging = literal_catalogue(sources['deploy-ci-client.py'], 'STAGING_SCRIPTS')
    readers = literal_catalogue(sources['copy_runtime_approvals.py'], 'READERS')
    tools = literal_catalogue(sources['copy_runtime_approvals.py'], 'TOOLS')
    need(set(tools) == BACKUP_TOOLS, 'REVIEW_BACKUP_TOOLS_CHANGED')
    names = set(staging) | set(readers) | set(tools)
    need(REQUIRED_READERS <= names and names <= set(sources), 'REVIEW_CLOSURE_MISSING')
    for name in names:
        if not name.endswith('.py'):
            continue
        for node in ast.parse(sources[name]).body:
            modules = ([n.name.split('.')[0] for n in node.names] if isinstance(node, ast.Import)
                else [node.module.split('.')[0]] if isinstance(node, ast.ImportFrom) and node.module
                else [])
            need(not isinstance(node, ast.ImportFrom) or node.level == 0,
                'REVIEW_RELATIVE_IMPORT_UNSUPPORTED')
            for module in modules:
                need(module in sys.stdlib_module_names or module + '.py' in names,
                    'REVIEW_IMPORT_CLOSURE_MISSING')
    return {name: {'bytes': len(sources[name]), 'sha256': sha(sources[name])}
        for name in sorted(names)}


def prepare(request, sources, expected_hashes, *, now):
    need(type(request) is dict and set(request) == REQUEST_FIELDS, 'REVIEW_REQUEST_FIELDS')
    for key, size in (('source_sha', 40), ('source_tree', 40), ('archive_sha256', 64)):
        need(type(request[key]) is str and re.fullmatch('[a-f0-9]{' + str(size) + '}', request[key])
            and request[key] != '0' * size, 'REVIEW_NATIVE_IDENTITY_PENDING')
    for key in ('package_build_id',):
        try:
            value = uuid.UUID(request[key])
        except (ValueError, TypeError, AttributeError):
            raise RuntimeError('REVIEW_UUID_REQUIRED') from None
        need(str(value) == request[key] and value.int != 0, 'REVIEW_UUID_REQUIRED')
    need(type(request['installation_attempt']) is str
        and re.fullmatch(r'[1-9][0-9]{0,5}', request['installation_attempt']),
        'REVIEW_INSTALLATION_ATTEMPT_INVALID')
    review = request['review_id']
    need(type(review) is str and re.fullmatch('[a-z0-9][a-z0-9-]{0,79}', review),
        'REVIEW_ID_INVALID')
    need(type(request['archive_bytes']) is int and 0 < request['archive_bytes'] <= 3 * 1024**3,
        'REVIEW_ARCHIVE_BOUND')
    window(request['issued_at'], request['expires_at'], now=now)
    files = catalogue(sources, expected_hashes)
    root = PRIVATE + '/root-review-transfer/' + review
    run = 'cb-' + request['package_build_id'] + '-' + request['installation_attempt']
    return {'schema_version': 1, 'state': 'CANONICAL_REVIEW_PREPARED_NOT_AUTHORIZED',
        'source_sha': request['source_sha'], 'source_tree': request['source_tree'],
        'installation_run_id': run, 'review_id': review,
        'archive': {'path': root + '/commerce-os.tar', 'bytes': request['archive_bytes'],
            'sha256': request['archive_sha256']}, 'scripts': files,
        'observe_argv': ['python3', root + '/copy-runtime-approvals.py', 'observe',
            root + '/commerce-os.tar', request['archive_sha256'], request['source_sha'], run, review],
        'issued_at': request['issued_at'], 'expires_at': request['expires_at'],
        'observe_max_age_seconds': 1800, 'boot_approval_max_age_seconds': 900,
        'fresh_native_read_required_before_host_mutation': True,
        'root_adoption_required': True, 'native_full_package_required': True,
        'source_scope': 'MAIN_REQUIRED_NOT_PROVEN_BY_THIS_PLAN',
        'installation_authorized': False, 'effects': 0}


def seal_argv(plan, observation_sha256, *, now):
    """A hash is a command parameter, not proof of review or fresh observation."""
    need(type(plan) is dict and plan.get('state') == 'CANONICAL_REVIEW_PREPARED_NOT_AUTHORIZED',
        'REVIEW_PLAN_REQUIRED')
    window(plan['issued_at'], plan['expires_at'], now=now)
    need(type(observation_sha256) is str and re.fullmatch('[a-f0-9]{64}', observation_sha256)
        and observation_sha256 != '0' * 64, 'REVIEW_OBSERVATION_PIN_REQUIRED')
    review = plan['review_id']
    need(type(review) is str and re.fullmatch('[a-z0-9][a-z0-9-]{0,79}', review),
        'REVIEW_ID_INVALID')
    return ['python3', PRIVATE + '/root-review-transfer/' + review + '/copy-runtime-approvals.py',
        'seal', review, observation_sha256]
