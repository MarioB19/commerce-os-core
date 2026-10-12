import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from ci_release import ReleaseError, digest, extract_release, verify_migrations
deploy_spec=importlib.util.spec_from_file_location('deploy_ci_client',Path(__file__).resolve().parents[2]/'scripts/deploy-ci-client.py')
deploy_ci_client=importlib.util.module_from_spec(deploy_spec);deploy_spec.loader.exec_module(deploy_ci_client)
spec=importlib.util.spec_from_file_location('changes',Path(__file__).resolve().parents[2]/'scripts/ci-changes.py')
changes=importlib.util.module_from_spec(spec);spec.loader.exec_module(changes)

class ReleaseTests(unittest.TestCase):
    def test_step_summary_is_optional_after_a_conclusive_remote_report(self):
        report={'status':'SUCCEEDED','stage':'complete'}
        self.assertFalse(deploy_ci_client.append_step_summary(None,report,'a'*40))
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'summary.md'
            self.assertTrue(deploy_ci_client.append_step_summary(path,report,'a'*40))
            self.assertIn('Deployment **SUCCEEDED**',path.read_text())

    def test_ephemeral_os_login_key_is_matched_by_exact_key_material(self):
        public='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixture runner@example.invalid\n'
        profile={'sshPublicKeys':{'server-fingerprint':{'fingerprint':'server-fingerprint','key':'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixture imported-comment'}}}
        self.assertTrue(deploy_ci_client.profile_contains_public_key(profile,public))
        self.assertFalse(deploy_ci_client.profile_contains_public_key({'sshPublicKeys':{}},public))

    def test_incompatible_rollback_stops_before_services_or_database_are_touched(self):
        # Execute the real shell entrypoint with an inert Docker double. No daemon is used.
        for warmup_supported in [False, True]:
            with self.subTest(warmup_supported=warmup_supported), tempfile.TemporaryDirectory() as directory:
                root=Path(directory);calls=root/'calls.jsonl';binary=root/'docker'
                binary.write_text("""#!/usr/bin/env python3
import json,os,sys
args=sys.argv[1:]
with open(os.environ['ROLLBACK_TEST_CALLS'],'a') as log: log.write(json.dumps(args)+'\\n')
if args[:2]==['image','inspect']:
    if '--format' in args: print('amd64' if '{{.Architecture}}' in args else 'linux')
    sys.exit(0)
if args[0]=='run' and 'warmup.ts' in args[-1]:
    sys.exit(0 if os.environ['ROLLBACK_TEST_WARMUP']=='yes' else 42)
if args[0]=='run' and 'operational-settings.ts' in args[-1]: sys.exit(42)
sys.exit(99)
""")
                binary.chmod(0o755)
                config=root/'release.env'
                config.write_text('COMMERCE_IMAGE=sha256:'+'a'*64+'\nCOMMERCE_WEB_IMAGE=sha256:'+'b'*64+'\nCOMMERCE_SECRETS_DIR='+str(root/'secrets')+'\nCOMMERCE_PRIVATE_ASSETS_DIR='+str(root/'assets')+'\nCOMMERCE_PROXY_NETWORK=unused-test\nCOMMERCE_ORIGIN=https://example.invalid\n')
                result=subprocess.run(['sh','scripts/release.sh','rollback',str(config)],cwd=Path(__file__).resolve().parents[2],env={**os.environ,'PATH':str(root)+os.pathsep+os.environ['PATH'],'ROLLBACK_TEST_CALLS':str(calls),'ROLLBACK_TEST_WARMUP':'yes' if warmup_supported else 'no'},capture_output=True,text=True)
                self.assertEqual(result.returncode,2,result.stderr)
                self.assertIn('database operational policy' if warmup_supported else 'internal warm-up effect compatibility',result.stderr)
                invocations=[json.loads(line) for line in calls.read_text().splitlines()]
                self.assertTrue(all(args[:2]==['image','inspect'] or args[0]=='run' and '--network' in args and args[args.index('--network')+1]=='none' for args in invocations))
                self.assertFalse((root/'secrets').exists())
                self.assertFalse((root/'assets').exists())

    def archive(self, root, entries):
        path=root/'bundle.tar'
        with tarfile.open(path,'w') as bundle:
            for name,kind in entries:
                info=tarfile.TarInfo(name);info.size=1
                if kind=='link':info.type=tarfile.SYMTYPE;info.linkname='/etc/passwd';info.size=0
                bundle.addfile(info,io.BytesIO(b'x') if kind!='link' else None)
        return path

    def test_archive_paths_rejected_before_extraction(self):
        for name,kind in [('../outside','file'),('/etc/outside','file'),('scripts/link','link'),('a\nb','file')]:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);archive=self.archive(root,[(name,kind)])
                with self.assertRaisesRegex(ReleaseError,'UNSAFE_ARCHIVE_ENTRY'):
                    extract_release(archive,root/'output',digest(archive))
                self.assertFalse((root/'output').exists())

    def test_bad_outer_hash_cannot_create_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);archive=self.archive(root,[('safe','file')])
            with self.assertRaisesRegex(ReleaseError,'ARCHIVE_HASH_MISMATCH'):
                extract_release(archive,root/'output','0'*64)
            self.assertFalse((root/'output').exists())

    def test_duplicate_member_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);archive=self.archive(root,[('safe','file'),('safe','file')])
            with self.assertRaisesRegex(ReleaseError,'DUPLICATE_ARCHIVE_ENTRY'):
                extract_release(archive,root/'output',digest(archive))

    def test_previous_release_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);archive=self.archive(root,[('safe','file')]);(root/'current').mkdir()
            with self.assertRaisesRegex(ReleaseError,'RELEASE_DIRECTORY_ALREADY_EXISTS'):
                extract_release(archive,root/'current',digest(archive))

    def test_modified_or_removed_migration_blocks_before_install(self):
        for expected in [{'0001.sql':'changed'},{}]:
            with self.assertRaisesRegex(ReleaseError,'MIGRATION_HISTORY_CHANGED'):
                verify_migrations({'0001.sql':'original'},expected)
        verify_migrations({'0001.sql':'original'},{'0001.sql':'original','0002.sql':'new'})
        with self.assertRaisesRegex(ReleaseError,'MIGRATIONS_INCOMPLETE'):
            verify_migrations({'0001.sql':'original'},{'0001.sql':'original','0002.sql':'new'},True)

    def test_only_main_runtime_or_manual_deploys(self):
        before='1'*40
        self.assertFalse(changes.should_deploy('push','refs/heads/main',before,['README.md','docs/evidence/result.json']))
        self.assertTrue(changes.should_deploy('push','refs/heads/main',before,['apps/api/src/app.ts']))
        self.assertFalse(changes.should_deploy('workflow_dispatch','refs/heads/main',before,[]))
        for event,ref in [('pull_request','refs/pull/1/merge'),('push','refs/heads/test'),('workflow_dispatch','refs/heads/test')]:
            self.assertFalse(changes.should_deploy(event,ref,before,['scripts/release.sh']))

    def test_docs_push_cannot_hide_an_undeployed_application_change(self):
        installed={'id':1,'sha':'1'*40,'payload':{'installer_status':'SUCCEEDED','source_sha':'1'*40,
                   'archive_sha256':'a'*64,'installation_run_id':'100-1','verification':'Canonical software installation verified.'}}
        responses={'deployments?environment=production&per_page=30':[{'id':2,'sha':'2'*40},installed],
                   'deployments/2/statuses?per_page=1':[{'state':'failure'}],
                   'deployments/1/statuses?per_page=1':[{'state':'success','environment_url':'https://commerce-os.inovaris.online',
                    'log_url':'https://github.com/MarioB19/commerce-os-core/actions/runs/100'}]}
        baseline=changes.deployed_baseline(responses.__getitem__,'MarioB19/commerce-os-core')
        self.assertEqual(baseline,'1'*40)
        self.assertTrue(changes.should_deploy('push','refs/heads/main',baseline,['docs/notes.md','apps/api/src/app.ts']))
        self.assertTrue(changes.should_deploy('push','refs/heads/main',changes.deployed_baseline(lambda _: [],'MarioB19/commerce-os-core'),['README.md']))

if __name__=='__main__':
    unittest.main()
