"""Synthetic provider, package and failure tests; no Docker or cloud calls."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
import cloudbuild_native_package as m
from ci_release import ReleaseError
from test_cloudbuild_publish_status import fixture, NUMBER

spec=importlib.util.spec_from_file_location('native_package_driver',ROOT/'scripts/cloudbuild-native-package-driver.py')
driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)
PACKAGE='87654321-4321-4321-4321-cba987654321'


class Response(io.BytesIO):
    status=200
    headers={}


class Opener:
    def __init__(self, responses):self.responses=responses;self.calls=[]
    def open(self,request,timeout):
        self.calls.append(request);value=self.responses.pop(0)
        if isinstance(value,Exception):raise value
        return Response(value if type(value)is bytes else json.dumps(value).encode())


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.verify=fixture()[0]
        self.inputs=m.package_inputs(self.verify,'us-east1-docker.pkg.dev/'+m.PROJECT+'/commerce-ci-public/package@sha256:'+'f'*64,
                                     'd'*64,'e'*64,'fixture-artifacts')
        self.replica={'origin':self.verify['storage_source'],'storage_source':{
            'bucket':'synthetic-ci-source','object':'package/unique-attempt.tgz','generation':'24'},
            'archive_sha256':self.verify['archive_sha256']}
        self.admission=m.admission(self.verify,self.inputs,PACKAGE,self.replica)
        self.context=self.admission['package_manifest']['context']
        self.archive=b'synthetic artifact original bytes'
        self.md5=base64.b64encode(hashlib.md5(self.archive).digest()).decode()
        self.prefix='gs://fixture-artifacts/releases/'+PACKAGE+'/'
        self.uri=self.prefix+'commerce-os.tar#315'
        self.manifest_uri=self.prefix+'artifacts-'+PACKAGE+'.json#314'
        self.record={'location':self.uri,'file_hash':{'type':2,'value':self.md5}}
        self.manifest_raw=json.dumps(self.record).encode()
        self.receipt={'kind':m.evidence.PACKAGE_GATE,'schema_version':1,'status':'PACKAGED','context':self.context,
                      'archive_sha256':hashlib.sha256(self.archive).hexdigest(),'archive_bytes':len(self.archive)}
        self.log={'resource':{'type':'build','labels':{'project_id':m.PROJECT,'build_id':PACKAGE}},
                  'textPayload':'Step #0 - "Commerce-V7-package": '+json.dumps(self.receipt)}
        self.build={**copy.deepcopy(self.admission['package_manifest']['build_config']),
            'projectId':m.PROJECT,'id':PACKAGE,'name':'projects/'+NUMBER+'/locations/us-east1/builds/'+PACKAGE,'status':'SUCCESS',
            'source':{'storageSource':self.replica['storage_source']},
            'sourceProvenance':{'resolvedStorageSource':self.replica['storage_source'],
             'fileHashes':{'gs://synthetic-ci-source/package/unique-attempt.tgz':{'fileHash':[
              {'type':'SHA256','value':base64.b64encode(bytes.fromhex(self.verify['archive_sha256'])).decode()}]}}},
            'results':{'artifactManifest':self.manifest_uri,'numArtifacts':'1'}}
        self.build['steps'][0].update(status='SUCCESS',exitCode=0)
        self.full_calls=[]
        self.full=SimpleNamespace(evaluate=lambda v:self.full_calls.append(v)or{'state':'success'},
                                 project=lambda:{'projectId':m.PROJECT,'projectNumber':NUMBER})
    def meta(self,uri,raw):
        location,generation=uri[5:].rsplit('#',1);bucket,name=location.split('/',1)
        return {'bucket':bucket,'name':name,'generation':generation,'size':str(len(raw)),
                'md5Hash':base64.b64encode(hashlib.md5(raw).digest()).decode()}
    def reader(self,extra=None):
        values=[self.build,self.meta(self.manifest_uri,self.manifest_raw),self.manifest_raw]
        values+=extra if extra is not None else[{'entries':[self.log]}]
        opener=Opener(values);return m.GooglePackageReader(lambda:'synthetic-google',self.full,opener=opener),opener
    def test_exact_native_package_prefix_and_source_provenance(self):
        reader,opener=self.reader();result=reader.evidence(self.admission)
        self.assertEqual(result['artifact_uri'],self.uri);self.assertEqual(result['archive_sha256'],self.receipt['archive_sha256'])
        self.assertEqual(self.full_calls,[self.verify]);self.assertEqual(len(opener.calls),4)
        self.assertTrue(all('synthetic-google'in q.get_header('Authorization')for q in opener.calls))
    def test_full_failure_stops_before_package_reads(self):
        reader,opener=self.reader();self.full.evaluate=lambda _:{'state':'failure'}
        with self.assertRaisesRegex(ReleaseError,'NATIVE_FULL_REQUIRED'):reader.evidence(self.admission)
        self.assertEqual(opener.calls,[])
    def test_encoded_response_rejected_before_reading_payload(self):
        class Encoded(Response):
            headers={'Content-Encoding':'gzip'}
            def read(self,*args):raise AssertionError('encoded bytes read')
        reader,_=self.reader();response=Encoded(b'synthetic')
        reader.opener=SimpleNamespace(open=lambda *_args,**_kwargs:response)
        with self.assertRaisesRegex(RuntimeError,'PACKAGE_READ_UNCONFIRMED'):reader.evidence(self.admission)
        self.assertTrue(response.closed)
    def test_empty_logging_page_continuation_is_read_to_completion(self):
        reader,opener=self.reader([{'nextPageToken':'synthetic-page'},{'entries':[self.log]}])
        reader.evidence(self.admission)
        self.assertEqual(json.loads(opener.calls[-1].data)['pageToken'],'synthetic-page')
    def test_repeated_or_nonterminal_logging_pages_never_pass(self):
        for pages in ([{'nextPageToken':'x'}]*2,[{'nextPageToken':str(i)}for i in range(8)]):
            reader,_=self.reader(pages)
            with self.assertRaises(RuntimeError):reader.evidence(self.admission)
    def test_duplicate_prefixed_receipts_rejected(self):
        reader,_=self.reader([{'entries':[self.log,self.log]}])
        with self.assertRaisesRegex(ReleaseError,'PACKAGE_RECEIPT_UNIQUE_REQUIRED'):reader.evidence(self.admission)
    def test_cross_build_receipt_rejected(self):
        self.log['resource']['labels']['build_id']=self.verify['build_id'];reader,_=self.reader()
        with self.assertRaisesRegex(ReleaseError,'PACKAGE_LOG_IDENTITY_MISMATCH'):reader.evidence(self.admission)
    def test_wrong_native_archive_hash_rejected(self):
        self.build['sourceProvenance']['fileHashes']['gs://synthetic-ci-source/package/unique-attempt.tgz']['fileHash'][0]['value']=base64.b64encode(b'0'*32).decode()
        reader,_=self.reader()
        with self.assertRaisesRegex(ReleaseError,'PACKAGE_NATIVE_SOURCE_HASH_MISMATCH'):reader.evidence(self.admission)
    def test_unreviewed_native_step_rejected(self):
        self.build['steps'][0]['args']=['echo','forged'];reader,_=self.reader()
        with self.assertRaisesRegex(ReleaseError,'PACKAGE_NATIVE_STEP_CHANGED'):reader.evidence(self.admission)
    def test_source_replica_must_be_unique_and_same_full_bytes(self):
        for changes in ({'storage_source':self.verify['storage_source']},{'archive_sha256':'0'*64},{'origin':dict(self.verify['storage_source'],generation='99')}):
            with self.assertRaisesRegex(ReleaseError,'PACKAGE_SOURCE_REPLICA_CHANGED'):
                m.create_request(self.verify,self.inputs,{**self.replica,**changes})
    def test_create_request_has_no_build_id_and_binds_exclusive_replica(self):
        request=m.create_request(self.verify,self.inputs,self.replica)
        self.assertNotIn('id',request);self.assertEqual(request['timeout'],'1800s');self.assertEqual(request['source']['storageSource'],self.replica['storage_source'])
        self.assertNotIn('secretEnv',request['steps'][0]);self.assertNotIn('availableSecrets',request)
    def test_generation_required_no_latest_download(self):
        for uri in (self.uri.split('#')[0],self.uri.replace('#315','#0'),self.uri.replace('commerce-os.tar','../commerce-os.tar')):
            with self.assertRaises(ReleaseError):m.GooglePackageReader.object_url(uri,media=True)
    def download_fixture(self):
        reader,_=self.reader();verified=reader.evidence(self.admission)
        reader.opener=Opener([self.meta(self.uri,self.archive),self.archive])
        return reader,verified
    def private_temp(self):
        # The production custody check intentionally refuses /tmp's writable
        # ancestors. Use the current user's protected home for this small test.
        temporary=tempfile.TemporaryDirectory(prefix='.native-package-test-',dir=Path.home())
        self.addCleanup(temporary.cleanup);return Path(temporary.name)
    def test_download_reserves_before_get_and_checks_bytes_and_md5(self):
        reader,verified=self.download_fixture();target=self.private_temp()/'release.tar';reservations=[]
        def reserve(uri,size):
            self.assertEqual(len(reader.opener.calls),1);self.assertFalse(target.exists());reservations.append((uri,size))
        result=reader.download(verified,target,reserve)
        self.assertEqual(target.read_bytes(),self.archive);self.assertEqual(result['sha256'],verified['archive_sha256']);self.assertEqual(reservations,[(self.uri,len(self.archive)+1)])
    def test_failed_download_keeps_partial_and_rejects_repeat(self):
        reader,verified=self.download_fixture();target=self.private_temp()/'release.tar';reader.opener.responses[-1]=b'changed';res=[]
        with self.assertRaisesRegex(ReleaseError,'PACKAGE_DOWNLOAD_HASH_MISMATCH'):reader.download(verified,target,lambda *v:res.append(v))
        self.assertTrue(target.exists());self.assertEqual(len(res),1)
        reader.opener.responses=[self.meta(self.uri,self.archive)]
        with self.assertRaisesRegex(ReleaseError,'PACKAGE_DOWNLOAD_NEW_PATH_REQUIRED'):reader.download(verified,target,lambda *v:res.append(v))
        self.assertEqual(len(res),1)
    def test_download_metadata_mismatch_precedes_reservation_and_file(self):
        reader,verified=self.download_fixture();reader.opener.responses[0]['md5Hash']='wrong';target=self.private_temp()/'release.tar'
        with self.assertRaisesRegex(ReleaseError,'PACKAGE_DOWNLOAD_METADATA_MISMATCH'):reader.download(verified,target,lambda *_:self.fail('reserved'))
        self.assertFalse(target.exists())
    def test_driver_environment_excludes_inherited_tokens(self):
        with patch.dict(os.environ,{'GOOGLE_ACCESS_TOKEN':'secret','GITHUB_TOKEN':'secret','GH_TOKEN':'secret'}):
            env=driver.environment(Path('/source'),Path('/private-home'))
        self.assertFalse(any('TOKEN'in k for k in env));self.assertEqual(env['GIT_CONFIG_GLOBAL'],'/dev/null')
    def test_driver_four_images_keep_exact_source_and_platform(self):
        commands=driver.commands('a'*40);self.assertEqual(len(commands),4)
        self.assertTrue(all('--platform=linux/amd64'in c and 'SOURCE_SHA='+'a'*40 in c for c in commands))
        self.assertIn('mi-ciclo-listo-portal:release',commands[-1])
    def test_driver_self_hash_blocks_before_any_build(self):
        with patch.object(driver.sys,'platform','linux'):
            with self.assertRaisesRegex(ReleaseError,'TRUSTED_PACKAGE_DRIVER_CHANGED'):
                driver.package(ROOT,self.inputs,PACKAGE,runner=lambda *_:self.fail('build'))
    def test_package_stage_log_overflow_is_a_failure(self):
        from cloudbuild_bounded_logs import LogLimitExceeded
        with patch.object(driver,'bounded_execute',side_effect=LogLimitExceeded('REQUIRED_STAGE_STDOUT_LIMIT')) as bounded:
            with self.assertRaises(LogLimitExceeded):driver.execute(['synthetic-stage'],ROOT,{},time.monotonic()+10)
        self.assertEqual(bounded.call_args.kwargs['umask'],0o077)
    def test_nonzero_bounded_package_stage_still_fails(self):
        with patch.object(driver,'bounded_execute',return_value=9):
            with self.assertRaisesRegex(ReleaseError,'PACKAGE_COMMAND_FAILED'):
                driver.execute(['synthetic-stage'],ROOT,{},time.monotonic()+10)
    def test_package_alone_cannot_enable_success_publication(self):
        m.evidence.installation_enabled(self.context)
        with self.assertRaisesRegex(ReleaseError,'NATIVE_CLOUD_PACKAGE_INSTALLED_READBACK_REQUIRED'):
            m.evidence.publication_enabled(self.context)


if __name__=='__main__':unittest.main()
