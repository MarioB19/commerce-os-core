#!/usr/bin/env python3
"""Read native bootstrap evidence; publish a GitHub commit status only with --publish.

Run from a reviewed, trusted local checkout, never as a candidate build step.
The local manifest seals source/configuration before submission and binds the
returned build identity afterward. It is not candidate-provided attestation.
No GitHub credential is sent to Cloud Build.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import uuid

REPOSITORY = 'MarioB19/commerce-os'
PROJECT = 'project-c6f43813-9ac9-47ab-9fe'
sys.path.insert(0, str(Path(__file__).resolve().parent))
import operator_identity
GATE = 'Commerce V7 Cloud Build gate'
STAGES = ['diff', 'python-ci', 'install', 'node-contracts', 'portal-capsule',
          'local-setup', 'portal-capsule-linux', 'migrate', 'bootstrap',
          'portal-install', 'portal-verify', 'typecheck', 'lint', 'build',
          'unit', 'integration', 'recovery', 'playwright-install',
          'campaign-review', 'e2e', 'audit']
STEP_DEFAULTS = {'args': [], 'env': [], 'dir': '', 'id': '', 'waitFor': [],
                 'entrypoint': '', 'volumes': [], 'timeout': '', 'script': '',
                 'automapSubstitutions': False, 'allowFailure': False,
                 'allowExitCodes': [], 'secretEnv': [], 'results': []}
STEP_OUTPUTS = {'timing', 'pullTiming', 'status', 'exitCode'}
OPTION_DEFAULTS = {'logging': 'LOGGING_UNSPECIFIED', 'sourceProvenanceHash': [],
                   'automapSubstitutions': False, 'dynamicSubstitutions': False,
                   'substitutionOption': 'MUST_MATCH',
                   'machineType': 'UNSPECIFIED'}


class EvidenceError(RuntimeError):
    pass


def need(condition, code):
    if not condition:
        raise EvidenceError(code)


def canonical_hash(document):
    return hashlib.sha256(json.dumps(document, sort_keys=True,
                                    separators=(',', ':')).encode()).hexdigest()


def digest(value, length=64):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{'+str(length)+'}', value)


def load_manifest(path):
    need(path.is_file() and not path.is_symlink(), 'TRUSTED_MANIFEST_REQUIRED')
    need(path.stat().st_size <= 1024*1024, 'MANIFEST_TOO_LARGE')
    manifest = json.loads(path.read_text())
    validate_manifest(manifest)
    return manifest


def validate_manifest(m):
    need(isinstance(m, dict), 'MANIFEST_OBJECT_REQUIRED')
    need(m.get('schema_version') == 1 and m.get('repository') == REPOSITORY
         and m.get('project') == PROJECT, 'TARGET_MISMATCH')
    need(isinstance(m.get('region'), str) and re.fullmatch(r'[a-z]+-[a-z]+[0-9]', m['region']),
         'REGION_REQUIRED')
    try:
        valid_id = str(uuid.UUID(m['build_id'])) == m['build_id']
    except (KeyError, ValueError, TypeError, AttributeError):
        valid_id = False
    need(valid_id, 'BUILD_UUID_REQUIRED')
    for key in ('source_sha', 'source_tree'):
        need(digest(m.get(key), 40), 'SOURCE_IDENTITY_REQUIRED')
    for key in ('archive_sha256', 'runner_sha256', 'workflow_sha256', 'build_config_sha256'):
        need(digest(m.get(key)), 'TRUSTED_HASH_REQUIRED')
    image = m.get('verifier_image', '')
    need(isinstance(image, str) and re.fullmatch(
        r'[a-z0-9-]+-docker\.pkg\.dev/'+re.escape(PROJECT)+
        r'/commerce-ci/verify@sha256:[a-f0-9]{64}', image), 'PINNED_VERIFIER_REQUIRED')
    source(m.get('storage_source', {}))
    config = m.get('build_config')
    need(isinstance(config, dict) and canonical_hash(config) == m['build_config_sha256'],
         'TRUSTED_CONFIG_HASH_MISMATCH')
    need(set(config) == {'steps', 'serviceAccount', 'timeout', 'queueTtl', 'options', 'substitutions'},
         'UNEXPECTED_BUILD_INPUT')
    need(config['substitutions'] == {'COMMIT_SHA': m['source_sha'], '_VERIFY_IMAGE': image},
         'TRUSTED_SUBSTITUTIONS_MISMATCH')
    need(config['timeout'] == '5700s' and config['queueTtl'] == '600s', 'BUILD_BOUNDS_CHANGED')
    need(config['options'] == {'logging': 'CLOUD_LOGGING_ONLY',
                              'sourceProvenanceHash': ['SHA256'],
                              'automapSubstitutions': False}, 'TRUSTED_OPTIONS_CHANGED')
    steps = config['steps']
    need(isinstance(steps, list) and len(steps) == 1, 'ONE_FULL_STEP_REQUIRED')
    step = steps[0]
    need(step.get('id') == 'Commerce-V7-FULL-verification'
         and step.get('name') == 'gcr.io/cloud-builders/docker'
         and step.get('entrypoint') == 'bash', 'TRUSTED_VERIFIER_STEP_REQUIRED')
    need(step.get('timeout') == '5700s', 'STEP_BOUNDS_CHANGED')
    normalize_step(step)


def source(value):
    need(isinstance(value, dict) and set(value) <= {'bucket', 'object', 'generation', 'sourceFetcher'},
         'STORAGE_SOURCE_INVALID')
    bucket, obj, generation = (value.get(key) for key in ('bucket', 'object', 'generation'))
    need(isinstance(bucket, str) and re.fullmatch(r'[a-z0-9][a-z0-9._-]{1,220}', bucket),
         'SOURCE_BUCKET_INVALID')
    need(isinstance(obj, str) and re.fullmatch(r'[a-zA-Z0-9_./-]+', obj)
         and obj.endswith(('.tgz', '.tar.gz')) and '..' not in obj.split('/'), 'SOURCE_OBJECT_INVALID')
    need(isinstance(generation, (str, int)) and not isinstance(generation, bool)
         and re.fullmatch(r'[1-9][0-9]*', str(generation)), 'SOURCE_GENERATION_REQUIRED')
    return {'bucket': bucket, 'object': obj, 'generation': str(generation)}


def expanded(value, substitutions):
    """Expand only the Cloud Build syntax used by the reviewed template."""
    if isinstance(value, list):
        return [expanded(item, substitutions) for item in value]
    if isinstance(value, dict):
        return {key: expanded(item, substitutions) for key, item in value.items()}
    if not isinstance(value, str):
        return value
    protected = value.replace('$$', '\x00')
    def replace(match):
        key = match[1] or match[2]
        need(key in substitutions, 'UNKNOWN_TRUSTED_SUBSTITUTION')
        return substitutions[key]
    return re.sub(r'\$\{([A-Z_][A-Z_0-9]*)\}|\$([A-Z_][A-Z_0-9]*)',
                  replace, protected).replace('\x00', '$')


def normalize_step(step):
    need(isinstance(step, dict) and set(step) <= set(STEP_DEFAULTS)|STEP_OUTPUTS|{'name'},
         'UNEXPECTED_STEP_INPUT')
    result = {key: step.get(key, default) for key, default in STEP_DEFAULTS.items()}
    result['name'] = step.get('name')
    need(not result['allowFailure'] and not result['allowExitCodes']
         and not result['secretEnv'] and not result['volumes']
         and not result['automapSubstitutions'], 'UNSAFE_STEP_OPTIONS')
    return result


def validate_native(m, build, github, project_number=None):
    validate_manifest(m)
    need(isinstance(build, dict) and isinstance(github, dict)
         and isinstance(github.get('tree'), dict), 'NATIVE_RESPONSE_INVALID')
    need(github.get('sha') == m['source_sha']
         and github.get('tree', {}).get('sha') == m['source_tree'], 'GITHUB_COMMIT_TREE_MISMATCH')
    project_names = {PROJECT}
    if project_number is not None:
        need(re.fullmatch(r'[1-9][0-9]*', str(project_number)), 'PROJECT_NUMBER_INVALID')
        project_names.add(str(project_number))
    resources = {'projects/'+name+'/locations/'+m['region']+'/builds/'+m['build_id']
                 for name in project_names}
    need(build.get('id') == m['build_id'] and build.get('projectId') == PROJECT
         and build.get('name') in resources, 'NATIVE_BUILD_IDENTITY_MISMATCH')
    need(not build.get('buildTriggerId'), 'BOOTSTRAP_ONLY_NOT_TRIGGER_ATTESTATION')
    need(isinstance(build.get('source'), dict), 'NATIVE_SOURCE_MISMATCH')
    need(source(build.get('source', {}).get('storageSource', {})) == source(m['storage_source'])
         and set(build.get('source', {})) == {'storageSource'}, 'NATIVE_SOURCE_MISMATCH')
    for key in ('secrets', 'availableSecrets', 'images', 'artifacts', 'dependencies', 'gitConfig'):
        need(not build.get(key), 'UNEXPECTED_NATIVE_BUILD_INPUT')
    config = m['build_config']
    substitutions = {**config['substitutions'], 'PROJECT_ID': PROJECT, 'BUILD_ID': m['build_id']}
    need(build.get('substitutions') == config['substitutions'], 'NATIVE_SUBSTITUTIONS_MISMATCH')
    for key in ('timeout', 'queueTtl', 'serviceAccount'):
        need(build.get(key) in (config[key], expanded(config[key], substitutions)),
             'NATIVE_CONFIG_MISMATCH')
    expected_sa = 'projects/'+PROJECT+'/serviceAccounts/commerce-v7-verify@'+PROJECT+'.iam.gserviceaccount.com'
    need(expanded(config['serviceAccount'], substitutions) == expected_sa, 'VERIFY_SERVICE_ACCOUNT_REQUIRED')
    options = build.get('options', {})
    need(isinstance(options, dict) and set(options) <= set(OPTION_DEFAULTS), 'UNEXPECTED_NATIVE_OPTIONS')
    normalized_options = {key: options.get(key, default) for key, default in OPTION_DEFAULTS.items()}
    expected_options = {**OPTION_DEFAULTS, **config['options']}
    need(normalized_options == expected_options, 'NATIVE_OPTIONS_MISMATCH')
    steps = build.get('steps', [])
    need(isinstance(steps, list) and len(steps) == 1, 'NATIVE_STEP_COUNT_MISMATCH')
    actual = normalize_step(steps[0])
    template = normalize_step(config['steps'][0])
    need(actual == template or actual == expanded(template, substitutions), 'NATIVE_STEP_CONFIG_MISMATCH')
    status = build.get('status')
    need(status in {'PENDING', 'QUEUED', 'WORKING', 'SUCCESS', 'FAILURE', 'INTERNAL_ERROR',
                    'TIMEOUT', 'CANCELLED', 'EXPIRED'}, 'UNKNOWN_NATIVE_STATUS')
    if status != 'SUCCESS':
        return 'pending' if status in {'PENDING', 'QUEUED', 'WORKING'} else 'failure'
    need(steps[0].get('status') == 'SUCCESS' and steps[0].get('exitCode', 0) == 0,
         'NATIVE_STEP_NOT_SUCCESSFUL')
    provenance = build.get('sourceProvenance', {})
    need(isinstance(provenance, dict), 'NATIVE_PROVENANCE_INVALID')
    need(source(provenance.get('resolvedStorageSource', {})) == source(m['storage_source']),
         'RESOLVED_SOURCE_MISMATCH')
    hashes = provenance.get('fileHashes', {})
    uri = 'gs://'+m['storage_source']['bucket']+'/'+m['storage_source']['object']
    need(isinstance(hashes, dict) and len(hashes) == 1
         and next(iter(hashes)) in (uri, uri+'#'+str(m['storage_source']['generation'])),
         'NATIVE_ARCHIVE_HASH_PATH_MISMATCH')
    archive_hashes = next(iter(hashes.values()))
    need(isinstance(archive_hashes, dict), 'NATIVE_ARCHIVE_HASH_INVALID')
    values = archive_hashes.get('fileHash', [])
    need(isinstance(values, list) and all(isinstance(item, dict) for item in values),
         'NATIVE_ARCHIVE_HASH_INVALID')
    expected = base64.b64encode(bytes.fromhex(m['archive_sha256'])).decode()
    need(any(item.get('type') == 'SHA256' and item.get('value') == expected for item in values),
         'NATIVE_ARCHIVE_HASH_MISMATCH')
    return 'success'


def receipts_from_logs(entries, m):
    need(isinstance(entries, list) and len(entries) < 100, 'LOG_QUERY_INCOMPLETE')
    receipts = []
    for entry in entries:
        need(isinstance(entry, dict) and isinstance(entry.get('resource'), dict), 'LOG_ENTRY_INVALID')
        labels = entry['resource'].get('labels', {})
        need(isinstance(labels, dict), 'LOG_ENTRY_INVALID')
        need(entry.get('resource', {}).get('type') == 'build'
             and labels.get('build_id') == m['build_id']
             and labels.get('project_id') == PROJECT, 'LOG_BUILD_IDENTITY_MISMATCH')
        value = entry.get('jsonPayload')
        if value is None:
            text = entry.get('textPayload', '')
            # Cloud Build may prefix stdout with its native step label.
            text = re.sub(r'^Step #0(?: - "Commerce-V7-FULL-verification")?: ', '', text)
            try:
                value = json.loads(text)
            except (ValueError, TypeError):
                continue
        if isinstance(value, dict) and value.get('gate_name') == GATE and value.get('schema_version') == 1:
            receipts.append(value)
    need(len(receipts) == 1, 'UNIQUE_NATIVE_RUNNER_RECEIPT_REQUIRED')
    return receipts[0]


def validate_full_receipt(m, receipt):
    need(isinstance(receipt, dict), 'FULL_RECEIPT_INVALID')
    expected = {'schema_version': 1, 'provider': 'google-cloud-build', 'build_id': m['build_id'],
                'gate_name': GATE, 'scope': 'full', 'source_sha': m['source_sha'],
                'source_tree': m['source_tree'], 'verifier_image': m['verifier_image'],
                'runner_sha256': m['runner_sha256'], 'workflow_sha256': m['workflow_sha256'],
                'status': 'PASSED', 'deployment_proven': False, 'github_check_published': False,
                'maximum_suite_seconds': 5400}
    need(all(receipt.get(key) == value for key, value in expected.items()), 'FULL_RECEIPT_IDENTITY_MISMATCH')
    stages = receipt.get('stages', [])
    need(isinstance(stages, list) and all(isinstance(s, dict) for s in stages)
         and [s.get('id') for s in stages] == STAGES,
         'FULL_STAGE_SET_MISMATCH')
    need(all(s.get('status') == 'PASSED' and type(s.get('exit_code')) is int
             and s['exit_code'] == 0 for s in stages), 'FULL_STAGE_NOT_PASSED')
    need(not receipt.get('failure_code'), 'FULL_FAILURE_CODE_PRESENT')


def run_json(argv, data=None):
    result = subprocess.run(argv, input=None if data is None else json.dumps(data),
                            text=True, capture_output=True, timeout=90)
    need(result.returncode == 0, 'EXTERNAL_COMMAND_FAILED')
    return json.loads(result.stdout)


def evaluate(m, gcloud, runner=run_json):
    common = ['--project='+PROJECT, '--account='+operator_identity.local_account('cloud_build'), '--format=json']
    project = runner([gcloud, 'projects', 'describe', PROJECT, *common])
    need(project.get('projectId') == PROJECT and project.get('projectNumber'), 'NATIVE_PROJECT_MISMATCH')
    github = runner(['gh', 'api', 'repos/'+REPOSITORY+'/git/commits/'+m['source_sha']])
    build = runner([gcloud, 'builds', 'describe', m['build_id'], '--region='+m['region'], *common])
    state = validate_native(m, build, github, project['projectNumber'])
    if state == 'success':
        query = ('resource.type="build" AND resource.labels.build_id="'+m['build_id']+
                 '" AND resource.labels.project_id="'+PROJECT+'" AND "'+GATE+'"')
        # gcloud otherwise defaults to only the last day, even for an exact UUID.
        # This query window does not extend the bucket's actual retention.
        entries = runner([gcloud, 'logging', 'read', query, '--freshness=90d', '--limit=100', *common])
        validate_full_receipt(m, receipts_from_logs(entries, m))
    url = 'https://console.cloud.google.com/cloud-build/builds;region='+m['region']+'/'+m['build_id']+'?project='+PROJECT
    return {'state': state, 'context': GATE, 'target_url': url,
            'description': {'success': 'FULL passed; native source and build verified',
                            'failure': 'Native Cloud Build did not pass',
                            'pending': 'Native Cloud Build is not complete'}[state]}


def publish(m, payload, runner=run_json):
    # This is deliberately a commit status, not a GitHub App check run.
    endpoint = 'repos/'+REPOSITORY+'/statuses/'+m['source_sha']
    result = runner(['gh', 'api', '--method', 'POST', endpoint, '--input', '-'], payload)
    need(type(result.get('id')) is int and result['id'] > 0, 'PUBLISHED_STATUS_ID_MISSING')
    rows = runner(['gh', 'api', 'repos/'+REPOSITORY+'/commits/'+m['source_sha']+'/statuses?per_page=100'])
    need(isinstance(rows, list), 'PUBLISHED_STATUS_READBACK_MISSING')
    matches = [row for row in rows if row.get('id') == result['id']]
    need(len(matches) == 1 and all(matches[0].get(key) == value for key, value in payload.items()),
         'PUBLISHED_STATUS_READBACK_MISMATCH')
    return result['id']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--gcloud', default='gcloud')
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    attempted = False
    try:
        manifest = load_manifest(args.manifest)
        payload = evaluate(manifest, args.gcloud)
        if args.publish:
            # All trust checks run immediately before the one explicit mutation.
            attempted = True
            publish(manifest, payload)
        print(json.dumps({'source_sha': manifest['source_sha'], 'build_id': manifest['build_id'],
                          'published': args.publish, 'commit_status': payload}, sort_keys=True))
        return 0 if payload['state'] == 'success' else 1
    except (EvidenceError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        code = str(error) if isinstance(error, EvidenceError) else type(error).__name__
        print(json.dumps({'published': None if attempted else False,
                          'publication_attempted': attempted,
                          'status': 'OUTCOME_UNKNOWN' if attempted else 'EVIDENCE_REJECTED', 'code': code}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
