"""Fixed native publisher Build contract, with a distinct source replica.

The source archive is provenance only: the privileged worker imports exclusively
its image-owned /opt/trusted modules and downloads the verified package itself.
The installation input descriptor hash is known before CreateBuild. The native
UUID is bound later in private custody; there is no circular self-hash.
"""
import base64
import re
import cloudbuild_admission as ledger
from cloudbuild_full_evidence import PROJECT, OPTION_DEFAULTS, expanded, normalize_step, need, source

REGION = 'us-east1'
SERVICE_ACCOUNT = 'projects/' + PROJECT + '/serviceAccounts/commerce-v7-publisher-core@' + PROJECT + '.iam.gserviceaccount.com'


def validate_contract(value):
    ledger.exact(value, 'schema_version build_id attempt_id source_sha source_tree image driver_sha256 task_sha256 storage_source archive_sha256',
                 'PUBLISHER_CONTRACT_FIELDS_INVALID')
    need(type(value['schema_version']) is int and value['schema_version'] == 1, 'PUBLISHER_CONTRACT_VERSION_INVALID')
    ledger.native_uuid(value['build_id']); ledger.native_uuid(value['attempt_id'])
    for key in ('source_sha', 'source_tree'): ledger.digest(value[key], size=40)
    for key in ('driver_sha256', 'task_sha256', 'archive_sha256'): ledger.digest(value[key])
    need(type(value['image']) is str and re.fullmatch(r'us-east1-docker\.pkg\.dev/' + re.escape(PROJECT) +
         r'/commerce-ci-public/publisher@sha256:[a-f0-9]{64}', value['image']), 'PUBLISHER_IMAGE_REQUIRED')
    source(value['storage_source'])


def template(contract):
    validate_contract(contract)
    return {'serviceAccount': SERVICE_ACCOUNT, 'timeout': '900s', 'queueTtl': '600s',
        'options': {'logging': 'CLOUD_LOGGING_ONLY', 'sourceProvenanceHash': ['SHA256'], 'automapSubstitutions': False},
        'substitutions': {'COMMIT_SHA': contract['source_sha'], '_ATTEMPT_ID': contract['attempt_id'],
                          '_TASK_SHA256': contract['task_sha256'], '_DRIVER_SHA256': contract['driver_sha256']},
        'steps': [{'id': 'Commerce-V7-native-publisher', 'name': contract['image'], 'entrypoint': '/usr/bin/python3',
            'timeout': '900s', 'args': ['-I', '/opt/trusted/cloudbuild-publish.py', '--publisher-build-id', '$BUILD_ID'],
            # Values are consumed by native substitution validation only. The
            # worker re-reads the native contract and custody; it never trusts env.
            'env': ['EXPECTED_SHA=$COMMIT_SHA', 'ATTEMPT_ID=${_ATTEMPT_ID}',
                    'TASK_SHA256=${_TASK_SHA256}', 'DRIVER_SHA256=${_DRIVER_SHA256}']}]}


def create_request(contract):
    return {**template(contract), 'source': {'storageSource': source(contract['storage_source'])}}


def validate_native(contract, build, project_number):
    validate_contract(contract)
    need(str(project_number) == '1065291779811', 'PUBLISHER_PROJECT_NUMBER_CHANGED')
    need(type(build) is dict and build.get('id') == contract['build_id'] and build.get('projectId') == PROJECT
         and build.get('name') in {'projects/' + p + '/locations/' + REGION + '/builds/' + contract['build_id']
                                 for p in (PROJECT, str(project_number))}, 'PUBLISHER_NATIVE_IDENTITY_CHANGED')
    need(not any(build.get(k) for k in ('buildTriggerId', 'approval', 'secrets', 'availableSecrets', 'images',
             'artifacts', 'dependencies', 'gitConfig', 'logsBucket')), 'PUBLISHER_UNEXPECTED_INPUT')
    config = template(contract)
    substitutions = {**config['substitutions'], 'PROJECT_ID': PROJECT, 'BUILD_ID': contract['build_id']}
    need(build.get('source') == {'storageSource': source(contract['storage_source'])}
         and build.get('substitutions') == config['substitutions'], 'PUBLISHER_NATIVE_SOURCE_CHANGED')
    for key in ('serviceAccount', 'timeout', 'queueTtl'):
        need(build.get(key) == config[key], 'PUBLISHER_NATIVE_CONFIG_CHANGED')
    opts = build.get('options', {})
    need(type(opts) is dict and set(opts) <= set(OPTION_DEFAULTS)
         and {k: opts.get(k, default) for k, default in OPTION_DEFAULTS.items()} == {**OPTION_DEFAULTS, **config['options']},
         'PUBLISHER_NATIVE_OPTIONS_CHANGED')
    steps = build.get('steps')
    need(type(steps) is list and len(steps) == 1, 'PUBLISHER_SINGLE_STEP_REQUIRED')
    step = normalize_step(steps[0]); expected = normalize_step(config['steps'][0])
    need(step in (expected, expanded(expected, substitutions)), 'PUBLISHER_NATIVE_STEP_CHANGED')
    status = build.get('status')
    need(status in ledger.TERMINAL_STATUSES | {'QUEUED', 'WORKING'}, 'PUBLISHER_NATIVE_STATUS_INVALID')
    if status == 'SUCCESS':
        need(steps[0].get('status') == 'SUCCESS' and steps[0].get('exitCode', 0) == 0, 'PUBLISHER_NATIVE_STEP_FAILED')
        provenance = build.get('sourceProvenance', {}); locator = source(contract['storage_source'])
        need(provenance.get('resolvedStorageSource') == locator, 'PUBLISHER_NATIVE_GENERATION_CHANGED')
        hashes = provenance.get('fileHashes', {}); uri = 'gs://' + locator['bucket'] + '/' + locator['object']
        need(type(hashes) is dict and len(hashes) == 1 and next(iter(hashes)) in (uri, uri + '#' + str(locator['generation'])),
             'PUBLISHER_NATIVE_ARCHIVE_CHANGED')
        expected_hash = base64.b64encode(bytes.fromhex(contract['archive_sha256'])).decode()
        need(any(type(row) is dict and row.get('type') == 'SHA256' and row.get('value') == expected_hash
                 for row in next(iter(hashes.values())).get('fileHash', [])), 'PUBLISHER_NATIVE_ARCHIVE_CHANGED')
    return status
