import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import hashlib
import subprocess
import tarfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
import ci_provider_evidence as contract
import cloudbuild_release_evidence as evidence
from ci_release import ReleaseError


def module(name,file):
    spec = importlib.util.spec_from_file_location(name,ROOT/'scripts'/file)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


changes = module('provider_changes','ci-changes.py')
client = module('provider_client','deploy-ci-client.py')
publisher = module('installation_publisher','cloudbuild-publish-installation.py')
prepare = module('local_release_prepare','cloudbuild-prepare-local-release.py')

VERIFY = '12345678-1234-1234-1234-123456789abc'
PACKAGE = '87654321-4321-4321-4321-cba987654321'
SHA = 'a'*40
TREE = 'b'*40


def context(local=True):
    value = {'schema_version':1,'provider':contract.PROVIDER,'repository':contract.REPOSITORY,
        'project':contract.PROJECT,'region':'us-east1','verification_build_id':VERIFY,'source_sha':SHA,'source_tree':TREE,
        'verification_manifest_sha256':'c'*64,'package_origin':'canonical-local' if local else 'cloud-build'}
    value.update({'packager_sha256':'d'*64} if local else {'package_build_id':PACKAGE,'package_config_sha256':'d'*64,
        'package_driver_sha256':'e'*64,'package_image':'us-east1-docker.pkg.dev/'+contract.PROJECT+'/commerce-ci-public/package@sha256:'+'f'*64})
    return value


def ref(path): return {'path':path,'bytes':50,'sha256':'f'*64}


def portal():
    return {'source_sha':'1'*40,'image':'sha256:'+'2'*64,'container_id':'3'*64,'run_id':'123-1',
        'report_ref':ref('/opt/mcl-portal/current.json'),
        'manifest_ref':ref('/opt/commerce-os/releases/portal-ci-123-1-'+'1'*12+'/portal-manifest.json')}


def observation():
    c = context(); run = contract.cloud_installation_id(VERIFY,1,local_package=True)
    metadata = {**contract.release_metadata(c,SHA,TREE),'migration_hashes':{},'platform':'linux/amd64'}
    images = {name:{'id':'sha256:'+'4'*64,'source_sha':SHA} for name in ('commerce-os:release','commerce-os-web:release')}
    binding = contract.report_binding(metadata,run,'e'*64,portal(),images)
    admitted = {'context':c,'source_sha':SHA,'installation_run_id':run,'archive_sha256':'e'*64,'artifact_uri':None}
    core = {'service':'commerce-api','configured':True,'sha':SHA,'release':'ci-cv-'+VERIFY+'-'+SHA[:10]}
    report = {'source_sha':SHA,'run_id':run,'status':'SUCCEEDED','deployment_scope':'copy-runtime',
        'runtime_stage':'OPERATING','consumers_started':True,'physical_sales_proven':False,'healthy_services':6,
        'https_web_parity':True,'core_version':{'sha':SHA,'release':core['release']},
        'release':'ci-'+run+'-'+SHA[:12],**binding}
    return admitted,{'schema_version':1,'custody':'ROOT_NATIVE_READBACK','report':report,
        'report_ref':ref('/opt/commerce-os/private/deployments/'+run+'/report.json'),'metadata_sha256':'f'*64},core,{'release':'1'*40,'activities':480}


class CloudBuildReleaseProviderTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(evidence.operator_identity, "local_account", return_value="synthetic-ci@example.invalid")
        patcher.start(); self.addCleanup(patcher.stop)

    def test_native_ids_remain_strings_and_namespaces_have_distinct_meaning(self):
        for local,identifier in ((True,VERIFY),(False,PACKAGE)):
            c = context(local); run = contract.cloud_installation_id(identifier,999999,local_package=local)
            self.assertTrue(contract.installation_id(run)); self.assertTrue(contract.unit_name('commerce-ci-'+run))
            self.assertLess(len('ci-'+run+'-'+SHA[:12]),128)
            metadata = contract.release_metadata(c,SHA,TREE)
            self.assertEqual(contract.release_identity(metadata,SHA,run,'copy-runtime'),c)
            with self.assertRaises(ReleaseError): contract.release_identity(metadata,SHA,run,'full')
        self.assertNotIn('package_build_id',context())
        self.assertFalse(contract.installation_id('cv-'+VERIFY+'-0'))
        self.assertFalse(contract.installation_id('cv-'+VERIFY+'-1000000'))
        self.assertFalse(contract.installation_id('cv-'+VERIFY+'-1;true'))

    def test_local_package_cannot_claim_a_cloud_package_build(self):
        c = context(); c['package_build_id'] = PACKAGE
        with self.assertRaises(ReleaseError): contract.validate_context(c)
        c = context(False); c['package_build_id'] = VERIFY
        with self.assertRaises(ReleaseError): contract.validate_context(c)

    def test_native_package_route_is_not_enabled_by_a_valid_json_contract(self):
        contract.publication_enabled(context())
        contract.publication_enabled(None)
        contract.installation_enabled(context(False))
        with self.assertRaisesRegex(ReleaseError,'NATIVE_CLOUD_PACKAGE_INSTALLED_READBACK_REQUIRED'):
            contract.publication_enabled(context(False))

    def test_first_native_installation_admission_does_not_require_its_future_report(self):
        c=context(False)
        # Native evaluation is the admission reader seam, not a fabricated
        # installed report. No success publication guard may run in this path.
        with patch.object(evidence,'protected_bytes',return_value=b'{}'), \
             patch.object(evidence,'validate_admission',return_value=c), \
             patch.object(evidence,'evaluate',return_value={'context':c,'archive_sha256':'e'*64}) as native, \
             patch.object(evidence,'publication_enabled',side_effect=AssertionError('future report dependency')):
            admitted=evidence.deployment_admission('/fixture',ROOT,'1')
        self.assertEqual(admitted['installation_run_id'],'cb-'+PACKAGE+'-1')
        native.assert_called_once()
        with self.assertRaises(ReleaseError): contract.publication_enabled(c)

    def test_metadata_rejects_cross_provider_source_tree_and_uuid(self):
        metadata = contract.release_metadata(context(),SHA,TREE); run = 'cv-'+VERIFY+'-1'
        for key,value in (('source_sha','2'*40),('source_tree','2'*40),('run_id','cb-'+VERIFY),('schema_version',1)):
            candidate = copy.deepcopy(metadata); candidate[key] = value
            with self.subTest(key=key),self.assertRaises(ReleaseError):
                contract.release_identity(candidate,SHA,run,'copy-runtime')
        with self.assertRaises(ReleaseError): contract.release_identity(metadata,SHA,'cv-'+PACKAGE+'-1','copy-runtime')

    def test_historical_installation_branch_does_not_gain_provider_claims(self):
        metadata = {'schema_version':1,'source_sha':SHA,'run_id':'123'}
        self.assertIsNone(contract.release_identity(metadata,SHA,'123-1','copy-runtime'))
        metadata['provider_evidence'] = context()
        with self.assertRaises(ReleaseError): contract.release_identity(metadata,SHA,'123-1','copy-runtime')

    def test_remote_unit_cleanup_stays_bounded_and_rejects_shell_input(self):
        run = 'cv-'+VERIFY+'-1'
        command = client.cleanup_staging_command('commerce-ci-'+run,'commerce-ci-'+run)
        self.assertIn('ci_provider_evidence.py',command)
        self.assertIn('systemctl show commerce-ci-'+run+'.service',command)
        with self.assertRaises(ReleaseError): client.cleanup_staging_command('commerce-ci-'+run+';true','commerce-ci-'+run)

    def test_preserved_portal_keeps_authenticated_previous_source(self):
        admitted,native,core,portal_https = observation()
        payload = evidence.deployment_payload(admitted,native,core,portal_https)
        self.assertEqual(payload['components']['portal']['source_sha'],'1'*40)
        self.assertNotEqual(payload['components']['portal']['source_sha'],payload['source_sha'])
        self.assertIsNone(payload['package_build_id'])
        self.assertEqual(payload['package_origin'],'canonical-local')
        bad = copy.deepcopy(native); bad['report']['components']['portal']['source_sha'] = SHA
        with self.assertRaises(ReleaseError): evidence.deployment_payload(admitted,bad,core,portal_https)

    def test_root_and_https_receipts_must_match_exact_candidate(self):
        admitted,native,core,portal_https = observation()
        for key,value in (('archive_sha256','0'*64),('source_tree','0'*40),('runtime_stage','CORE_PREPARED'),
                          ('consumers_started',False),('physical_sales_proven',True),('https_web_parity',False)):
            bad = copy.deepcopy(native); bad['report'][key] = value
            with self.subTest(key=key),self.assertRaises(ReleaseError):
                evidence.validate_installed(admitted,bad,core,portal_https)
        for bad in ({**core,'sha':'0'*40},{**core,'configured':False}):
            with self.assertRaises(ReleaseError): evidence.validate_installed(admitted,native,bad,portal_https)

    def test_payload_alone_never_establishes_deployed_baseline(self):
        admitted,native,core,portal_https = observation()
        payload = evidence.deployment_payload(admitted,native,core,portal_https)
        deployment = {'id':9,'sha':SHA,'payload':payload}
        status = {'state':'success','environment_url':evidence.ORIGIN,'log_url':evidence.build_url(context())}
        fetch = lambda path:None
        self.assertFalse(changes.software_installation(deployment,status,fetch,contract.REPOSITORY))
        verify = lambda deployment,status:evidence.software_installation(deployment,status,payload,context())
        self.assertTrue(changes.software_installation(deployment,status,fetch,contract.REPOSITORY,provider_verify=verify))
        deployment['payload'] = {**payload,'archive_sha256':'0'*64}
        self.assertFalse(changes.software_installation(deployment,status,fetch,contract.REPOSITORY,provider_verify=verify))

    def test_local_json_and_world_writable_ancestry_cannot_be_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'admission.json'; path.write_text('{}'); path.chmod(0o600)
            with self.assertRaises(ReleaseError): evidence.protected_bytes(path)
            link = Path(directory)/'link.json'; link.symlink_to(path)
            with self.assertRaises(ReleaseError): evidence.protected_bytes(link)

    def test_gcs_artifact_requires_exact_generation_and_native_md5_shape(self):
        prefix = 'gs://private-ci/releases/'+PACKAGE+'/'
        entry = {'location':prefix+'commerce-os.tar#123','file_hash':{'type':2,'value':'AAAAAAAAAAAAAAAAAAAAAA=='}}
        self.assertEqual(evidence.archive_record(json.dumps(entry).encode(),prefix),entry)
        for mutation in ({**entry,'location':prefix+'commerce-os.tar'},
                         {**entry,'location':prefix+'other.tar#123'},
                         {**entry,'file_hash':{'type':4,'value':'AAAAAAAAAAAAAAAAAAAAAA=='}}):
            with self.assertRaises(ReleaseError): evidence.archive_record(json.dumps(mutation).encode(),prefix)

    def test_native_package_receipt_rejects_cross_build_and_duplicate_logs(self):
        c = context(False)
        value = {'kind':evidence.PACKAGE_GATE,'schema_version':1,'status':'PACKAGED','context':c,
                 'archive_sha256':'a'*64,'archive_bytes':100}
        entry = {'resource':{'type':'build','labels':{'project_id':contract.PROJECT,'build_id':PACKAGE}},'jsonPayload':value}
        self.assertEqual(evidence.package_receipt([entry],c),value)
        with self.assertRaises(ReleaseError): evidence.package_receipt([entry,entry],c)
        bad = copy.deepcopy(entry); bad['resource']['labels']['build_id'] = VERIFY
        with self.assertRaises(ReleaseError): evidence.package_receipt([bad],c)

    def test_local_build_arguments_never_alias_github_run_or_pass_credentials(self):
        commands = prepare.build_commands(SHA)
        self.assertEqual(len(commands),4)
        self.assertTrue(all('--platform=linux/amd64' in argv for argv in commands))
        self.assertTrue(all(argv[argv.index('--build-arg')+1] == 'SOURCE_SHA='+SHA for argv in commands))
        self.assertNotIn('GITHUB',' '.join(' '.join(argv) for argv in commands))

    def test_readback_uses_the_existing_test_account_and_exact_vm_identity(self):
        self.assertIs(evidence.operator_identity, evidence.bootstrap().operator_identity)
        with patch.object(evidence.subprocess,'run') as execute:
            with self.assertRaisesRegex(ReleaseError,'PUBLISHER_VM_IDENTITY_MISMATCH'):
                evidence.installed_readback('cv-'+VERIFY+'-1',runner=lambda *_args,**_kwargs:{'id':'different-vm'})
        execute.assert_not_called()

    def test_cloud_deployment_remains_paused_until_explicitly_enabled(self):
        with patch.dict('os.environ',{'COMMERCE_CLOUD_RELEASE_ADMISSION':'/candidate.json','COMMERCE_DEPLOY_PAUSED':'true'},clear=True):
            with patch.object(evidence,'deployment_admission') as admit:
                with self.assertRaisesRegex(ReleaseError,'CLOUD_PUBLICATION_PAUSED'): client.main()
        admit.assert_not_called()

    def test_final_component_images_come_from_native_vm_not_local_store_ids(self):
        admitted,native,_,_ = observation(); report = native['report']
        services = {name:{'Image':'sha256:'+'8'*64,'Config':{'Labels':{'org.opencontainers.image.revision':SHA}}}
                    for name in ('api','ingress','automation-worker','channel-worker','web')}
        contract.installed_components(report,services)
        self.assertEqual(report['components']['runtime']['image'],'sha256:'+'8'*64)
        services['channel-worker']['Config']['Labels']['org.opencontainers.image.revision'] = '0'*40
        with self.assertRaises(ReleaseError): contract.installed_components(report,services)

    def test_partial_github_publication_is_reconciled_not_retried(self):
        admitted,native,core,portal_https = observation()
        payload = evidence.deployment_payload(admitted,native,core,portal_https); calls = []
        def runner(argv,**kwargs):
            calls.append(argv)
            if 'deployments?' in argv[-1]: return [{'id':1,'sha':SHA,'payload':payload}]
            return []
        with self.assertRaises(ReleaseError): publisher.publish(payload,context(),runner=runner)
        self.assertFalse(any('POST' in argv for argv in calls))


class LocalCanonicalPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name); self.repo = self.base/'repo'; self.repo.mkdir()
        (self.repo/'scripts').mkdir()
        (self.repo/'scripts/package-ci.py').write_text("def release_source(name): return name.startswith('scripts/')\n")
        (self.repo/'scripts/install-vps.sh').write_text('# fixture installer\n')
        (self.repo/'scripts/proof.py').write_text('approved = True\n')
        (self.repo/'.gitignore').write_text('__pycache__/\n')
        self.git('init','-q'); self.git('add','.')
        self.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture')
        self.c = context(); self.c.update(source_sha=self.git('rev-parse','HEAD').strip(),
            source_tree=self.git('rev-parse','HEAD^{tree}').strip(),
            packager_sha256=hashlib.sha256((self.repo/'scripts/package-ci.py').read_bytes()).hexdigest())

    def git(self,*args):
        return subprocess.check_output(['git',*args],cwd=self.repo,text=True,stderr=subprocess.DEVNULL)

    def archive(self, *, tampered=False, missing=False):
        directory = self.base/('tampered' if tampered else 'missing' if missing else 'package'); directory.mkdir()
        entries = {p.relative_to(self.repo).as_posix():p.read_bytes() for p in (self.repo/'scripts').glob('*') if p.is_file()}
        if tampered: entries['scripts/proof.py'] = b'approved = False\n'
        if missing: entries.pop('scripts/proof.py')
        entries.update({'images.tar.gz':b'fixture','images.sha256':b'fixture','images.json':b'{}',
            'web-manifest.json':b'{}','RELEASE.json':json.dumps(contract.release_metadata(self.c,self.c['source_sha'],self.c['source_tree'])).encode()})
        manifest = ''.join(hashlib.sha256(raw).hexdigest()+'  '+name+'\n' for name,raw in sorted(entries.items())).encode()
        entries['PACKAGE.sha256'] = manifest
        for name,raw in entries.items():
            path = directory/name; path.parent.mkdir(exist_ok=True,parents=True); path.write_bytes(raw)
        archive = directory.with_suffix('.tar')
        with tarfile.open(archive,'w:') as bundle:
            for name in entries: bundle.add(directory/name,arcname=name)
        package = {'context':self.c,'archive_sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),
                   'archive_bytes':archive.stat().st_size,'package_manifest_sha256':hashlib.sha256(manifest).hexdigest()}
        return archive,package

    def test_consistent_tar_and_sha_claim_cannot_hide_changed_source_bytes(self):
        archive,package = self.archive()
        evidence.validate_local_package(archive,package,self.repo)
        for tampered,missing in ((True,False),(False,True)):
            archive,package = self.archive(tampered=tampered,missing=missing)
            with self.subTest(tampered=tampered),self.assertRaises(ReleaseError):
                evidence.validate_local_package(archive,package,self.repo)

    def test_different_tree_or_dirty_checkout_cannot_use_prior_full(self):
        archive,package = self.archive()
        package['context']['source_tree'] = '0'*40
        with self.assertRaisesRegex(ReleaseError,'LOCAL_PACKAGE_SOURCE_NOT_EXACT'):
            evidence.validate_local_package(archive,package,self.repo)
        package['context']['source_tree'] = self.git('rev-parse','HEAD^{tree}').strip()
        (self.repo/'scripts/proof.py').write_text('dirty = True\n')
        with self.assertRaisesRegex(ReleaseError,'LOCAL_PACKAGE_SOURCE_NOT_EXACT'):
            evidence.validate_local_package(archive,package,self.repo)


if __name__ == '__main__': unittest.main()
