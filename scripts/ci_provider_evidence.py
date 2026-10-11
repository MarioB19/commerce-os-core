"""Provider identity bindings, never an attestation from caller-supplied JSON.

Native API/custody readers establish provenance separately. These pure guards
bind an already authenticated package to the existing Root installer.
"""
import json
from pathlib import Path
import re
import uuid

from ci_release import require

REPOSITORY = 'MarioB19/commerce-os'
PROJECT = 'project-c6f43813-9ac9-47ab-9fe'
PROVIDER = 'google-cloud-build'
UUID_PATTERN = r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}'
CLOUD_RUN = re.compile(r'cb-('+UUID_PATTERN+r')-([1-9][0-9]{0,5})')
LOCAL_RUN = re.compile(r'cv-('+UUID_PATTERN+r')-([1-9][0-9]{0,5})')
LEGACY_RUN = re.compile(r'[0-9]+-[0-9]+')
CONTEXT_FIELDS = {'schema_version', 'provider', 'repository', 'project', 'region',
    'verification_build_id', 'source_sha', 'source_tree', 'verification_manifest_sha256', 'package_origin'}
CLOUD_FIELDS = {'package_build_id', 'package_config_sha256', 'package_driver_sha256', 'package_image'}
LOCAL_FIELDS = {'packager_sha256'}
COMPONENT_POLICY = {'runtime': 'REPLACE', 'web': 'REPLACE', 'portal': 'PRESERVE_EXISTING'}


def sha(value, length=64):
    return type(value) is str and re.fullmatch(r'[a-f0-9]{'+str(length)+'}', value) is not None


def build_uuid(value):
    try:
        return type(value) is str and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def installation_id(value, *, legacy=True):
    return (type(value) is str and len(value) <= 80
            and bool(CLOUD_RUN.fullmatch(value) or LOCAL_RUN.fullmatch(value) or (legacy and LEGACY_RUN.fullmatch(value))))


def cloud_installation_id(build_id, attempt, *, local_package=False):
    require(build_uuid(build_id) and type(attempt) is int and 1 <= attempt <= 999999,
            'CLOUD_INSTALLATION_ID_INVALID')
    return ('cv-' if local_package else 'cb-')+build_id+'-'+str(attempt)


def unit_name(value):
    return (type(value) is str and value.startswith('commerce-ci-')
            and installation_id(value.removeprefix('commerce-ci-')))


def validate_context(value):
    require(type(value) is dict and value.get('package_origin') in {'cloud-build','canonical-local'},
            'CLOUD_PACKAGE_ORIGIN_REQUIRED')
    local = value['package_origin'] == 'canonical-local'
    require(set(value) == CONTEXT_FIELDS | (LOCAL_FIELDS if local else CLOUD_FIELDS)
            and type(value['schema_version']) is int and value['schema_version'] == 1
            and value['provider'] == PROVIDER and value['repository'] == REPOSITORY
            and value['project'] == PROJECT, 'CLOUD_RELEASE_CONTEXT_INVALID')
    require(type(value['region']) is str and re.fullmatch(r'[a-z]+-[a-z]+[0-9]', value['region'])
            and build_uuid(value['verification_build_id']), 'CLOUD_BUILD_IDENTITY_INVALID')
    require(all(sha(value[key], 40) for key in ('source_sha', 'source_tree'))
            and sha(value['verification_manifest_sha256']), 'CLOUD_SOURCE_BINDING_INVALID')
    if local:
        require(sha(value['packager_sha256']), 'CANONICAL_PACKAGER_HASH_REQUIRED')
        return value
    require(build_uuid(value['package_build_id']) and value['verification_build_id'] != value['package_build_id']
            and all(sha(value[key]) for key in ('package_config_sha256','package_driver_sha256')),
            'CLOUD_PACKAGE_IDENTITY_INVALID')
    require(type(value['package_image']) is str and re.fullmatch(
        r'[a-z0-9-]+-docker\.pkg\.dev/'+re.escape(PROJECT)+r'/commerce-ci/package@sha256:[a-f0-9]{64}',
        value['package_image']), 'CLOUD_PACKAGE_IMAGE_REQUIRED')
    return value


def parse(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, 'CLOUD_DUPLICATE_JSON_KEY')
            value[key] = item
        return value
    require(type(raw) is bytes and 0 < len(raw) <= 1024*1024, 'CLOUD_JSON_BOUND')
    try:
        return json.loads(raw, object_pairs_hook=pairs,
            parse_constant=lambda _: require(False, 'CLOUD_JSON_INVALID'))
    except (ValueError, UnicodeError, RecursionError):
        require(False, 'CLOUD_JSON_INVALID')


def package_context(path):
    """Read an input binding only; this function does not trust its claims."""
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), 'CLOUD_CONTEXT_FILE_REQUIRED')
    return validate_context(parse(path.read_bytes()))


def release_identity(metadata, source_sha, run_id, scope):
    require(type(metadata) is dict and metadata.get('source_sha') == source_sha
            and installation_id(run_id), 'RELEASE_SOURCE_MISMATCH')
    match = CLOUD_RUN.fullmatch(run_id) or LOCAL_RUN.fullmatch(run_id)
    if match:
        require(scope == 'copy-runtime' and metadata.get('schema_version') == 2,
                'CLOUD_COPY_RUNTIME_REQUIRED')
        context = validate_context(metadata.get('provider_evidence'))
        local = context['package_origin'] == 'canonical-local'
        require(context['source_sha'] == source_sha
                and context['verification_build_id' if local else 'package_build_id'] == match[1]
                and run_id.startswith('cv-' if local else 'cb-')
                and metadata.get('source_tree') == context['source_tree']
                and metadata.get('run_id') == ('cv-' if local else 'cb-')+match[1]
                and metadata.get('component_policy') == COMPONENT_POLICY,
                'CLOUD_RELEASE_IDENTITY_MISMATCH')
        return context
    require(metadata.get('schema_version',1) == 1 and not metadata.get('provider_evidence')
            and str(metadata.get('run_id')) == run_id.split('-')[0], 'RELEASE_SOURCE_MISMATCH')
    return None


def release_metadata(context, source_sha, source_tree):
    validate_context(context)
    require(context['source_sha'] == source_sha and context['source_tree'] == source_tree,
            'CLOUD_PACKAGE_SOURCE_MISMATCH')
    local = context['package_origin'] == 'canonical-local'
    return {'schema_version': 2, 'source_sha': source_sha, 'source_tree': source_tree,
            'run_id': ('cv-' if local else 'cb-')+context['verification_build_id' if local else 'package_build_id'], 'provider_evidence': context,
            'component_policy': dict(COMPONENT_POLICY)}


def publication_enabled(context):
    require(context is None or context['package_origin'] == 'canonical-local',
            'NATIVE_CLOUD_PACKAGE_PUBLICATION_NOT_ENABLED')


def report_binding(metadata, run_id, archive_sha256, portal, images):
    """Called only after Root's native snapshot authenticated portal references."""
    context = release_identity(metadata, metadata['source_sha'], run_id, 'copy-runtime')
    if context is None:
        return {}
    require(sha(archive_sha256) and type(portal) is dict
            and sha(portal.get('source_sha'), 40) and sha(portal.get('container_id'))
            and type(portal.get('image')) is str
            and re.fullmatch(r'sha256:[a-f0-9]{64}', portal['image']), 'CLOUD_PRESERVED_PORTAL_REQUIRED')
    require(type(images) is dict, 'CLOUD_IMAGE_MANIFEST_REQUIRED')
    components = {}
    for component, image_name in (('runtime', 'commerce-os:release'), ('web', 'commerce-os-web:release')):
        image = images.get(image_name, {})
        require(image.get('source_sha') == context['source_sha'] and type(image.get('id')) is str
                and re.fullmatch(r'sha256:[a-f0-9]{64}', image['id']), 'CLOUD_COMPONENT_IMAGE_MISMATCH')
        components[component] = {'action': 'REPLACED', 'source_sha': context['source_sha'], 'image': image['id']}
    components['portal'] = {'action': 'PRESERVED', **{key: portal[key] for key in
        ('source_sha', 'image', 'container_id', 'run_id', 'report_ref', 'manifest_ref')}}
    return {'provider_evidence': context, 'source_tree': context['source_tree'],
            'archive_sha256': archive_sha256, 'components': components}


def installed_components(report, services):
    """After native smoke, bind actual VM image IDs (stores may change OCI IDs)."""
    if not report.get('provider_evidence'): return
    for component,names in (('runtime',('api','ingress','automation-worker','channel-worker')),('web',('web',))):
        rows = [services[name] for name in names]
        actual = rows[0]['Image']
        require(type(actual) is str and re.fullmatch(r'sha256:[a-f0-9]{64}',actual)
                and all(row['Image'] == actual and row.get('Config',{}).get('Labels',{}).get(
                    'org.opencontainers.image.revision') == report['source_sha'] for row in rows),
                'CLOUD_INSTALLED_IMAGE_IDENTITY_MISMATCH')
        report['components'][component]['image'] = actual
