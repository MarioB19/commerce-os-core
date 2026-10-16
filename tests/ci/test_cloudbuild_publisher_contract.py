import base64
from copy import deepcopy
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'scripts'))
import cloudbuild_publisher_contract as m


def fixture():
    contract = {'schema_version': 1, 'build_id': '11111111-1111-4111-8111-111111111111',
        'attempt_id': '22222222-2222-4222-8222-222222222222', 'source_sha': 'a'*40, 'source_tree': 'b'*40,
        'image': 'us-east1-docker.pkg.dev/'+m.PROJECT+'/commerce-ci-public/publisher@sha256:'+'c'*64,
        'driver_sha256': 'd'*64, 'task_sha256': 'e'*64, 'archive_sha256': 'f'*64,
        'storage_source': {'bucket': 'private-source', 'object': 'publisher/attempt.tgz', 'generation': '3'}}
    build = {**m.create_request(contract), 'id': contract['build_id'], 'projectId': m.PROJECT,
        'name': 'projects/'+m.PROJECT+'/locations/us-east1/builds/'+contract['build_id'], 'status': 'WORKING'}
    return contract, build


class ContractTests(unittest.TestCase):
    def test_fixed_native_running_contract_and_template(self):
        contract, build = fixture()
        self.assertEqual(m.validate_native(contract, build, '1065291779811'), 'WORKING')
        self.assertEqual(build['timeout'], '900s')
        self.assertEqual(build['steps'][0]['args'], ['-I','/opt/trusted/cloudbuild-publish.py','--publisher-build-id','$BUILD_ID'])

    def test_candidate_entrypoint_identity_or_credential_inputs_reject(self):
        mutations = [lambda b: b['steps'][0].update(args=['/workspace/candidate.py']),
            lambda b: b.update(serviceAccount='personal@example.test'),
            lambda b: b.update(availableSecrets={'secretManager': ['x']}),
            lambda b: b.update(approval={'state':'APPROVED'}),
            lambda b: b.update(buildTriggerId='unexpected'),
            lambda b: b['options'].update(pool={'name':'other'}),
            lambda b: b['steps'][0].update(allowFailure=True),
            lambda b: b['substitutions'].update(_ATTEMPT_ID='other')]
        for change in mutations:
            contract, build = fixture(); change(build)
            with self.assertRaises(RuntimeError): m.validate_native(contract, build, '1065291779811')

    def test_wrong_project_uuid_or_generation_reject(self):
        for key, value in [('id','33333333-3333-4333-8333-333333333333'),('projectId','other'),('name','wrong')]:
            contract, build = fixture(); build[key] = value
            with self.assertRaises(RuntimeError): m.validate_native(contract, build, '1065291779811')
        contract, build = fixture(); build['source']['storageSource']['generation'] = '4'
        with self.assertRaises(RuntimeError): m.validate_native(contract, build, '1065291779811')

    def test_success_requires_native_provenance_and_zero_exit(self):
        contract, build = fixture(); build['status'] = 'SUCCESS'
        with self.assertRaises(RuntimeError): m.validate_native(contract, build, '1065291779811')
        build['steps'][0].update(status='SUCCESS', exitCode=0)
        locator = contract['storage_source']; uri = 'gs://'+locator['bucket']+'/'+locator['object']
        build['sourceProvenance'] = {'resolvedStorageSource':deepcopy(locator),
            'fileHashes': {uri: {'fileHash': [{'type':'SHA256','value':base64.b64encode(bytes.fromhex(contract['archive_sha256'])).decode()}]}}}
        self.assertEqual(m.validate_native(contract, build, '1065291779811'), 'SUCCESS')
        build['sourceProvenance']['fileHashes'][uri]['fileHash'][0]['value'] = base64.b64encode(b'0'*32).decode()
        with self.assertRaisesRegex(RuntimeError,'ARCHIVE_CHANGED'): m.validate_native(contract, build, '1065291779811')

    def test_timeout_failure_is_accountable_but_never_success(self):
        contract, build = fixture(); build['status'] = 'TIMEOUT'
        self.assertEqual(m.validate_native(contract, build, '1065291779811'), 'TIMEOUT')

    def test_config_hash_does_not_depend_on_future_native_uuid(self):
        contract, _ = fixture(); original = m.template(contract)
        contract['build_id'] = '33333333-3333-4333-8333-333333333333'
        self.assertEqual(m.template(contract), original)


if __name__ == '__main__': unittest.main()
