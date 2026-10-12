"""Pure, two-phase SHADOW installation manifest. No cloud effects or credentials.

Phase A creates custody, retaining native history. Phase B requires its genuine
object generations plus a reviewed local image. Nothing here admits a Build.
Historical expired SHADOW proposal only; OPERATING requires a new admitted manifest.
"""
from copy import deepcopy
import hashlib
import re

import cloudbuild_admission as ledger
from cloudbuild_full_evidence import PROJECT
from cloudbuild_gcs_store import encode, generation
from cloudbuild_runtime import PROJECT_NUMBER, validate_config
from cloudbuild_runtime_meter import initial_document

REGION = 'us-east1'
BUCKET = 'commerce-v7-ci-control-' + PROJECT_NUMBER
SOURCE_BUCKET = 'commerce-v7-public-sources-' + PROJECT_NUMBER
PREFIX = 'runtime/v7-20261011'
OBJECTS = {key: PREFIX + '/' + key + '.json' for key in ('ledger', 'control', 'meter')}
ACCOUNT = 'commerce-v7-controller-core@' + PROJECT + '.iam.gserviceaccount.com'
SERVICE = 'commerce-v7-controller'
KNOWN_BUILD = '24031884-e8e1-4cdf-86c1-9f39c8e842af'
KNOWN_START = '2026-10-10T22:27:33.786183647Z'
KNOWN_FINISH = '2026-10-10T23:41:25.159130Z'
DEADLINE = '2026-10-11T18:00:00Z'
ECONOMIC_SHA = 'c38becd19d2986146ae7dc19823dc347a2d47fae37ce1db90c4dadc132d8c2c1'


def initial_objects(inventory, *, moment):
    """Only the separately authenticated complete inventory is an input.

    This fixed bootstrap admits the single known failed Build, not an arbitrary
    asserted usage floor. A changed inventory requires a reviewed new proposal.
    """
    keys = 'project project_number regions builds inventory_sha256 started_at observed_at response_bytes requests complete'
    ledger.exact(inventory, keys, 'BOOTSTRAP_INVENTORY_INVALID')
    payload = {key: inventory[key] for key in ('project', 'project_number', 'regions', 'builds')}
    ledger.need(inventory['complete'] is True and inventory['project'] == PROJECT
        and inventory['project_number'] == PROJECT_NUMBER and 'global' in inventory['regions']
        and 'us-east1' in inventory['regions'] and len(set(inventory['regions'])) == len(inventory['regions'])
        and inventory['inventory_sha256'] == ledger.canonical_hash(payload), 'BOOTSTRAP_INVENTORY_UNCONFIRMED')
    oldest, newest = (ledger.timestamp(inventory[key]) for key in ('started_at', 'observed_at'))
    moment = ledger.utc(moment)
    ledger.need(oldest <= newest <= moment and 0 <= (moment - oldest).total_seconds() <= 120
        and moment < ledger.timestamp(DEADLINE), 'BOOTSTRAP_WINDOW_EXPIRED')
    ledger.need(len(inventory['builds']) == 1, 'BOOTSTRAP_NATIVE_HISTORY_CHANGED')
    row = inventory['builds'][0]
    ledger.need(row['id'] == KNOWN_BUILD and row['projectId'] == PROJECT and row['name'] in {
        'projects/' + project + '/locations/us-east1/builds/' + KNOWN_BUILD for project in (PROJECT, PROJECT_NUMBER)}
        and row['status'] == 'FAILURE' and row['startTime'] == KNOWN_START
        and row['finishTime'] == KNOWN_FINISH, 'BOOTSTRAP_NATIVE_HISTORY_CHANGED')
    ledger.digest(row['native_sha256'])
    observation = {'build_id': KNOWN_BUILD, 'status': 'FAILURE', 'started_at': row['startTime'],
        'finished_at': row['finishTime'], 'execution_not_started': False, 'evidence_sha256': row['native_sha256']}
    adopted = ledger.transition(ledger.new_ledger(), {'op': 'account_external', 'observation': observation,
        'native_verified': True}, now=moment).document
    ledger.need(ledger.budget_usage(adopted, now=moment)['2026-10'] ==
        {'confirmed_seconds': 4440, 'reserved_seconds': 0, 'total_seconds': 4440}, 'BOOTSTRAP_USAGE_CHANGED')
    return {'ledger': adopted, 'control': {'schema_version': 1, 'mode': 'shadow', 'expires_at': DEADLINE,
        'task': None}, 'meter': initial_document()}


def phase_a(inventory, *, moment):
    documents = initial_objects(inventory, moment=moment)
    resources = ['projects/_/buckets/' + BUCKET + '/objects/' + OBJECTS[key] for key in OBJECTS]
    reader = 'projects/' + PROJECT + '/roles/commerceV7ShadowRead'
    writer = 'projects/' + PROJECT + '/roles/commerceV7ShadowMeter'
    return {'schema_version': 1, 'phase': 'A_CUSTODY_ONLY', 'economic_proposal_sha256': ECONOMIC_SHA,
        'deadline': DEADLINE, 'cloud_effects_by_builder': 0, 'cloud_builds_admitted': 0,
        'inventory_sha256': inventory['inventory_sha256'],
        'bucket': {'name': BUCKET, 'location': REGION.upper(), 'storageClass': 'STANDARD',
            'iamConfiguration': {'uniformBucketLevelAccess': {'enabled': True}, 'publicAccessPrevention': 'enforced'},
            'softDeletePolicy': {'retentionDurationSeconds': '604800'}, 'versioning': {'enabled': False}},
        'service_account': {'accountId': 'commerce-v7-controller-core', 'email': ACCOUNT,
            'displayName': 'Commerce V7 SHADOW controller'},
        'custom_roles': [
            {'name': reader, 'title': 'Commerce V7 SHADOW exact custody reads', 'stage': 'GA',
             'includedPermissions': ['storage.objects.get']},
            {'name': writer, 'title': 'Commerce V7 SHADOW exact meter CAS', 'stage': 'GA',
             'includedPermissions': ['storage.objects.create', 'storage.objects.delete']}],
        'bucket_bindings_to_add': [
            {'role': reader, 'members': ['serviceAccount:' + ACCOUNT], 'condition': {
                'title': 'commerce-v7-shadow-three-objects',
                'expression': ' || '.join('resource.name == "' + name + '"' for name in resources)}},
            {'role': writer, 'members': ['serviceAccount:' + ACCOUNT], 'condition': {
                'title': 'commerce-v7-shadow-meter-only',
                'expression': 'resource.name == "' + resources[2] + '"'}}],
        'objects': {key: {'bucket': BUCKET, 'object': OBJECTS[key], 'ifGenerationMatch': '0',
            'bytes': len(encode(value)), 'sha256': hashlib.sha256(encode(value)).hexdigest(), 'document': value}
            for key, value in documents.items()},
        'operator_guards': ['fresh authenticated native inventory; do not accept caller assertions',
            'native absence before resource creation; existing identity is reconciled, never overwritten',
            'preflight project and ancestor IAM: no inherited role may broaden runtime permissions',
            'before each effect, O_EXCL intent containing request hash; unknown is GET-only reconciliation',
            'IAM merge preserves baseline bindings; policy version3 and native etag CAS required',
            'confirm exact bucket controls and effective runtime permissions before creating a service',
            'CAS0 object creation only; native generation, hash and byte readback required',
            'no service, scheduler, pubsub, build, trigger, actAs, SSH or secret grant in phase A'],
        'limits': {'gcs_class_a_operations_including_probes': 100, 'gcs_class_b_operations_including_probes': 200,
            'retained_state_gib_month': '0.01', 'native_probes': 5, 'probe_timeout_seconds': 60,
            'compute_scenario_seconds': 900, 'provider_billing_cap_claimed': False}}


def sealed_config(manifest, readbacks):
    ledger.need(manifest['phase'] == 'A_CUSTODY_ONLY' and manifest['economic_proposal_sha256'] == ECONOMIC_SHA,
                'BOOTSTRAP_MANIFEST_CHANGED')
    ledger.exact(readbacks, 'ledger control meter', 'BOOTSTRAP_READBACKS_REQUIRED')
    locations = {}
    for key in OBJECTS:
        actual, expected = readbacks[key], manifest['objects'][key]
        ledger.need(expected['bucket'] == BUCKET and expected['object'] == OBJECTS[key]
            and expected['ifGenerationMatch'] == '0' and expected['bytes'] == len(encode(expected['document']))
            and expected['sha256'] == hashlib.sha256(encode(expected['document'])).hexdigest(),
            'BOOTSTRAP_MANIFEST_OBJECT_CHANGED')
        ledger.exact(actual, 'bucket object generation bytes sha256', 'BOOTSTRAP_OBJECT_READBACK_INVALID')
        ledger.need(actual['bucket'] == BUCKET and actual['object'] == OBJECTS[key]
            and actual['bytes'] == expected['bytes'] and actual['sha256'] == expected['sha256'],
            'BOOTSTRAP_OBJECT_READBACK_CHANGED')
        locations[key] = {'bucket': BUCKET, 'object': OBJECTS[key], 'minimum_generation': generation(actual['generation'])}
    ledger.need(manifest['objects']['control']['document'] == {'schema_version': 1, 'mode': 'shadow',
        'expires_at': DEADLINE, 'task': None} and manifest['objects']['meter']['document'] == initial_document(),
        'BOOTSTRAP_INITIAL_STATE_CHANGED')
    adopted = manifest['objects']['ledger']['document']
    ledger.validate_ledger(adopted)
    ledger.need(set(adopted['external_builds']) == {KNOWN_BUILD} and not adopted['attempts']
        and adopted['active_attempt'] is None and adopted['blocked'] is None
        and ledger.budget_usage(adopted, now=ledger.timestamp(adopted['updated_at']))['2026-10'] ==
        {'confirmed_seconds': 4440, 'reserved_seconds': 0, 'total_seconds': 4440}, 'BOOTSTRAP_USAGE_CHANGED')
    return validate_config({'schema_version': 1, 'role': 'controller', 'project': PROJECT,
        'project_number': PROJECT_NUMBER, 'repository_id': 1414365450, 'mode': 'shadow', **locations,
        'custody': {'bucket': BUCKET, 'prefix': PREFIX}, 'sources': {'bucket': SOURCE_BUCKET, 'prefix': 'full'},
        'adoption': {'month': '2026-10', 'minimum_confirmed_seconds': 4440,
            'evidence_sha256': manifest['inventory_sha256']}})


def phase_b(config, image, *, moment, operator_account):
    # Local review input, never a runtime credential or cloud mutation.
    from operator_identity import account
    operator_account = account(operator_account)
    validate_config(config)
    ledger.need(config['role'] == 'controller' and config['mode'] == 'shadow'
        and ledger.utc(moment) < ledger.timestamp(DEADLINE), 'BOOTSTRAP_SHADOW_REQUIRED')
    ledger.need(all(config[key]['bucket'] == BUCKET and config[key]['object'] == OBJECTS[key] for key in OBJECTS)
        and config['custody'] == {'bucket': BUCKET, 'prefix': PREFIX}
        and config['sources'] == {'bucket': SOURCE_BUCKET, 'prefix': 'full'}, 'BOOTSTRAP_CUSTODY_CHANGED')
    ledger.exact(image, 'uri compressed_bytes config_sha256 context_sha256 scan_sha256 high critical',
                 'BOOTSTRAP_IMAGE_EVIDENCE_REQUIRED')
    ledger.need(re.fullmatch(REGION + r'-docker\.pkg\.dev/' + re.escape(PROJECT) +
        r'/commerce-ci-public/controller@sha256:[a-f0-9]{64}', image['uri'])
        and type(image['compressed_bytes']) is int and 0 < image['compressed_bytes'] <= 512 * 1024 * 1024
        and image['config_sha256'] == hashlib.sha256(encode(config)).hexdigest()
        and type(image['high']) is int and image['high'] == 0
        and type(image['critical']) is int and image['critical'] == 0, 'BOOTSTRAP_IMAGE_UNCONFIRMED')
    for key in ('context_sha256', 'scan_sha256'): ledger.digest(image[key])
    return {'schema_version': 1, 'phase': 'B_REVIEW_REQUIRED_BEFORE_SERVICE', 'deadline': DEADLINE,
        'economic_proposal_sha256': ECONOMIC_SHA, 'image': deepcopy(image),
        'parent': 'projects/' + PROJECT + '/locations/' + REGION, 'serviceId': SERVICE,
        'service': {'description': 'Commerce V7 SHADOW only; five operator probes; no delivery automation',
            'ingress': 'INGRESS_TRAFFIC_ALL', 'invokerIamDisabled': False,
            'template': {'serviceAccount': ACCOUNT, 'timeout': '60s', 'maxInstanceRequestConcurrency': 1,
                'scaling': {'minInstanceCount': 0, 'maxInstanceCount': 1},
                'containers': [{'image': image['uri'], 'ports': [{'containerPort': 8080}],
                    'resources': {'limits': {'cpu': '1', 'memory': '2Gi'}, 'cpuIdle': True, 'startupCpuBoost': False}}]}},
        'service_iam_bindings_to_add': [{'role': 'roles/run.invoker',
            'members': ['user:' + operator_account]}],
        'probe_contract': {'count_max': 5, 'method': 'POST', 'path': '/tick', 'body_bytes': 0,
            'timeout_seconds': 60, 'requires_native_IAM': True, 'expected_work': 'IDLE',
            'records_startup_latency_request_latency_meter_generations_and_native_logs': True},
        'scheduler': None, 'pubsub': None, 'builds_admitted': 0, 'publication_enabled': False}
