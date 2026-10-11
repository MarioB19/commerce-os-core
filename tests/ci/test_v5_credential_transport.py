import importlib.util
import json
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import patch
import subprocess
import tempfile
import io
from contextlib import redirect_stdout
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from v5_token_transport_config import validate_transport,AUTH,SCOPES,safe_remote_failure,StagedFailure
spec=importlib.util.spec_from_file_location('v5_remote',ROOT/'scripts/v5-token-remote.py');remote=importlib.util.module_from_spec(spec);spec.loader.exec_module(remote)
spec=importlib.util.spec_from_file_location('v5_client',ROOT/'scripts/v5-token-ci.py');client=importlib.util.module_from_spec(spec);spec.loader.exec_module(client)
class CredentialTransportTests(unittest.TestCase):
    def env(self):
        data={'schema_version':1,'operation_id':'a'*8+'-'+'a'*4+'-'+'4'+'a'*3+'-'+'8'+'a'*3+'-'+'a'*12,'workspace_id':'fixture','owner_email_sha256':'a'*64,'authorization_sha256':AUTH,'scopes':['reports:read'],'allowed_environments':['SIMULATION'],'resource_ids':None,'expires_at':'2099-01-01T00:00:00Z','reason':'Synthetic validation only'}
        return {'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_WORKFLOW_REF':'MarioB19/commerce-os/.github/workflows/ci.yml@refs/heads/main','V5_MODE':'credential','GITHUB_REF':'refs/heads/main','GITHUB_REPOSITORY':'MarioB19/commerce-os','GITHUB_SHA':'b'*40,'V5_EXPECTED_SHA':'b'*40,'GCP_PROJECT_ID':'vibe-conversa-prod','GCP_INSTANCE':'vibe-conversa-prod','GCP_ZONE':'us-east1-d','V5_ACTION':'inspect','GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','V5_INPUT_JSON':json.dumps(data),'V5_RETURN_PUBLIC_KEY':'-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----'}
    def test_main_sha_existing_target_and_fixed_action_are_mandatory(self):
        self.assertEqual(validate_transport(self.env())['action'],'inspect')
        for key,value in [('GITHUB_EVENT_NAME','push'),('V5_MODE','release'),('GITHUB_WORKFLOW_REF','MarioB19/commerce-os/.github/workflows/other.yml@refs/heads/main'),('GITHUB_REF','refs/heads/other'),('GITHUB_REPOSITORY','other/repo'),('V5_EXPECTED_SHA','c'*40),('GCP_INSTANCE','other'),('V5_ACTION','run-shell'),('V5_RETURN_PUBLIC_KEY','-----BEGIN PRIVATE KEY-----')]:
            with self.subTest(key=key),self.assertRaises(RuntimeError):validate_transport({**self.env(),key:value})
    def test_exact_current_authorization_and_no_credential_or_operational_input(self):
        for change in [{'authorization_sha256':'0'*64},{'scopes':['assignments:authorize']},{'scopes':['warmup:activate']},{'scopes':['unknown:scope']},{'owner_email_sha256':'person@example.invalid'},{'password':'not-accepted'}]:
            env=self.env();env['V5_INPUT_JSON']=json.dumps({**json.loads(env['V5_INPUT_JSON']),**change})
            with self.subTest(change=change),self.assertRaises(RuntimeError):validate_transport(env)
    def test_cli_and_transport_scope_allowlists_stay_equal(self):
        source=(ROOT/'scripts/v5-service-token.ts').read_text();declared=re.search(r'V5_SETUP_SCOPES=\[([^]]+)\]',source).group(1)
        self.assertEqual(set(re.findall("'([^']+)'",declared)),SCOPES)
    def test_remote_rejects_other_action_and_revision_before_execution(self):
        request=json.loads(self.env()['V5_INPUT_JSON'])
        remote.validate_request('inspect','b'*40,'123-1',request)
        for action,sha in [('shell','b'*40),('issue','$(command)')]:
            with self.assertRaises(RuntimeError):remote.validate_request(action,sha,'123-1',request)
    def test_transport_timeout_is_sanitized_and_still_removes_ephemeral_credentials(self):
        output=io.StringIO()
        with redirect_stdout(output),patch.object(client.subprocess,'run',side_effect=subprocess.TimeoutExpired(['ssh'],180,output='sensitive-provider-output')):
            with self.assertRaisesRegex(RuntimeError,'^V5_AUTHENTICATED_TRANSPORT_TIMEOUT$'):client.command(['ssh'])
        self.assertEqual(output.getvalue(),'')
        with tempfile.TemporaryDirectory() as directory:
            env={**self.env(),'RUNNER_TEMP':directory}
            calls=[]
            def simulate(args,**kwargs):
                calls.append(args)
                if args[0]=='gh':return 'b'*40
                if args[0]=='ssh-keygen':
                    key=Path(args[-1]);key.write_text('synthetic-key');key.with_suffix('.pub').write_text('ssh-ed25519 Zml4dHVyZQ== fixture');return ''
                if args[1:3]==['compute','ssh']:raise RuntimeError('V5_AUTHENTICATED_TRANSPORT_TIMEOUT')
                return ''
            with patch.dict(client.os.environ,env,clear=True),patch.object(client,'command',side_effect=simulate),redirect_stdout(output):
                with self.assertRaisesRegex(RuntimeError,'V5_AUTHENTICATED_TRANSPORT_TIMEOUT'):client.main()
            self.assertTrue(any(args[1:4]==['compute','os-login','ssh-keys'] for args in calls))
            self.assertFalse((Path(directory)/'commerce-v5-123-1'/'iap-key').exists())
            self.assertFalse((Path(directory)/'commerce-v5-123-1'/'iap-key.pub').exists())
            self.assertEqual(output.getvalue(),'')
    def test_credential_job_reuses_oidc_trust_and_cannot_run_verification_package_or_deploy(self):
        workflow=(ROOT/'.github/workflows/ci.yml').read_text();trust=(ROOT/'scripts/setup-ci-identity.py').read_text()
        def job(name):return re.search(r'^  '+re.escape(name)+r':\n(.*?)(?=^  [a-z-]+:|\Z)',workflow,re.M|re.S).group(1)
        self.assertIn('options: [verify, release, credential, backup, copy-preflight]',workflow)
        for name in ('changes','ci-gate'):
            self.assertIn("github.event_name != 'schedule'",job(name))
            self.assertIn('!contains(fromJSON(\'["credential","backup","copy-preflight"]\'), inputs.mode)',job(name))
        self.assertIn('always()',job('ci-gate'))
        self.assertIn('needs: changes',job('verify'));self.assertIn('needs: changes',job('package'))
        self.assertIn("if: needs.changes.outputs.deploy == 'true'",job('package'))
        self.assertIn('needs: [ci-gate, package, changes]',job('deploy'))
        self.assertIn("needs.changes.outputs.deploy == 'true'",job('deploy'))
        credential=job('credential')
        self.assertIn("github.event_name == 'workflow_dispatch' && inputs.mode == 'credential' && github.ref == 'refs/heads/main' && github.repository == 'MarioB19/commerce-os'",credential)
        self.assertIn('environment: production',credential);self.assertIn('group: commerce-os-production',credential)
        self.assertIn('V5_MODE: ${{ inputs.mode }}',credential)
        self.assertNotIn('deploy-ci-client.py',credential);self.assertNotIn('package-ci.py',credential)
        self.assertIn("assertion.workflow_ref == 'MarioB19/commerce-os/.github/workflows/ci.yml@refs/heads/main'",trust)
        self.assertFalse((ROOT/'.github/workflows/v5-credential-setup.yml').exists())
    def test_workflow_and_remote_use_published_fixed_issuer_and_ciphertext_only(self):
        workflow=(ROOT/'.github/workflows/ci.yml').read_text().split('\n  credential:\n',1)[1];client=(ROOT/'scripts/v5-token-ci.py').read_text();server=(ROOT/'scripts/v5-token-remote.py').read_text()
        self.assertIn('group: commerce-os-production',workflow);self.assertIn('id-token: write',workflow);self.assertIn('python3 scripts/v5_token_escrow.py store',workflow);self.assertNotIn('actions/upload-artifact@',workflow);self.assertIn('contents: write',workflow);self.assertLess(workflow.index('v5_token_escrow.py preflight'),workflow.index('google-github-actions/auth@'))
        self.assertIn('/opt/commerce-os/current/scripts/v5-token-remote.py',client);self.assertNotIn('shell=True',client+server);self.assertNotIn('/var/run/docker.sock',server)
        self.assertIn("metadata.get('source_sha')==sha",server);self.assertIn("image=verified_installed_image(sealed,installed,inspection)",server);self.assertNotIn("release.get('COMMERCE_MAINTENANCE_IMAGE')==image",server);self.assertIn("print(envelope.read_text().strip())",server)
    def image_fixture(self):
        layers=['sha256:'+'c'*64,'sha256:'+'d'*64]
        sealed={'id':'sha256:'+'a'*64,'layers':layers}
        installed='sha256:'+'b'*64
        info={'Id':installed,'Os':'linux','Architecture':'amd64','RootFS':{'Layers':layers.copy()}}
        return sealed,installed,info
    def test_oci_index_identity_uses_installed_digest_with_exact_sealed_platform_and_layers(self):
        sealed,installed,info=self.image_fixture()
        self.assertNotEqual(sealed['id'],installed)
        self.assertEqual(remote.verified_installed_image(sealed,installed,[info]),installed)
    def test_image_different_reordered_missing_layers_platform_and_mutable_tag_are_refused(self):
        sealed,installed,info=self.image_fixture()
        for change in [{'RootFS':{'Layers':['sha256:'+'e'*64]}},{'RootFS':{'Layers':list(reversed(sealed['layers']))}},{'RootFS':{}},{'Os':'windows'},{'Architecture':'arm64'},{'Id':'maintenance:latest'}]:
            with self.subTest(change=change),self.assertRaises(RuntimeError):remote.verified_installed_image(sealed,installed,[{**info,**change}])
        for bad in [[],[info,info],{}]:
            with self.subTest(inspection=bad),self.assertRaises(RuntimeError):remote.verified_installed_image(sealed,installed,bad)
        for bad in ['maintenance:release',None]:
            with self.subTest(installed=bad),self.assertRaises(RuntimeError):remote.verified_installed_image(sealed,bad,[info])
        with self.assertRaisesRegex(RuntimeError,'SEALED_IMAGE_LAYERS_REQUIRED'):remote.verified_installed_image({**sealed,'layers':[]},installed,[info])
    def test_remote_main_runs_only_proved_installed_digest_and_stops_before_any_task_on_mismatch(self):
        sealed,installed,info=self.image_fixture();data=json.loads(self.env()['V5_INPUT_JSON'])
        for mismatch in [False,True]:
            with self.subTest(mismatch=mismatch),tempfile.TemporaryDirectory() as temporary:
                base=Path(temporary);current=base/'release';current.mkdir();(base/'current').symlink_to(current,target_is_directory=True);private=base/'private';private.mkdir(mode=0o700)
                (current/'RELEASE.json').write_text(json.dumps({'source_sha':'b'*40}));(current/'images.json').write_text(json.dumps({'commerce-os-maintenance:release':sealed}));(private/'release.env').write_text('COMMERCE_MAINTENANCE_IMAGE='+installed+'\n')
                inputfile=base/'input.json';inputfile.write_text(json.dumps(data));inputfile.chmod(0o600);public=base/'public.pem';public.write_text(self.env()['V5_RETURN_PUBLIC_KEY']);public.chmod(0o600)
                calls=[];expected_envelope={'ciphertext':'synthetic-test-only'}
                def simulate(args,cwd=None,stage=None):
                    calls.append((args,stage))
                    if stage=='IMAGE_INSPECT':
                        self.assertEqual(args,['docker','image','inspect',installed]);return json.dumps([{**info,'RootFS':{'Layers':[]}} if mismatch else info])
                    self.assertEqual(args[:2],['docker','run']);self.assertIn(installed,args);self.assertNotIn(sealed['id'],args)
                    self.assertIn('--read-only',args);self.assertIn('--cap-drop',args);self.assertIn('commerce-os_core',args);self.assertNotIn('/var/run/docker.sock',' '.join(args))
                    if stage=='ISSUER_EXECUTION':return json.dumps({'status':'OWNER_MATCHED','mutation':False})
                    if stage=='RECEIPT_ENCRYPTION':
                        (private/'v5-service-tokens'/data['operation_id']/'run-123-1-inspect'/'envelope.json').write_text(json.dumps(expected_envelope))
                    return ''
                output=io.StringIO()
                with patch.object(remote,'BASE',base),patch.object(remote.sys,'argv',['issuer','inspect','b'*40,'123-1',str(inputfile),str(public)]),patch.object(remote,'run',side_effect=simulate),redirect_stdout(output):
                    if mismatch:
                        with self.assertRaisesRegex(RuntimeError,'INSTALLED_IMAGE_LAYERS_MISMATCH'):remote.main()
                    else:remote.main()
                if mismatch:
                    self.assertEqual(len(calls),1);self.assertFalse((private/'v5-service-tokens').exists());self.assertEqual(output.getvalue(),'')
                else:
                    self.assertEqual(json.loads(output.getvalue()),expected_envelope);self.assertEqual([stage for _,stage in calls],['IMAGE_INSPECT','RECIPIENT_VALIDATION','ISSUER_EXECUTION','RECEIPT_ENCRYPTION'])
    def test_only_allowlisted_remote_json_code_and_stage_cross_transport(self):
        safe={'status':'FAILED','code':'V5_ACTIVE_OWNER_MATCH_REQUIRED','stage':'issuer'}
        stderr='provider diagnostic with sensitive content\n'+json.dumps(safe)+'\n'
        with patch.object(client.subprocess,'run',return_value=subprocess.CompletedProcess(['ssh'],1,stdout='sensitive stdout',stderr=stderr)),redirect_stdout(io.StringIO()) as output:
            with self.assertRaises(StagedFailure) as failure:client.command(['ssh'],stage='REMOTE_ISSUER',remote_failure=True)
        self.assertEqual(str(failure.exception),'V5_ACTIVE_OWNER_MATCH_REQUIRED');self.assertEqual(failure.exception.stage,'issuer');self.assertEqual(output.getvalue(),'')
        self.assertEqual(safe_remote_failure(stderr),{'code':'V5_ACTIVE_OWNER_MATCH_REQUIRED','stage':'issuer'})
    def test_adversarial_remote_fields_codes_phases_and_output_never_leak(self):
        secret='cos_v5_'+'S'*43
        safe={'status':'FAILED','code':'V5_ACTIVE_OWNER_MATCH_REQUIRED','stage':'issuer'}
        for bad in [{'status':'FAILED','code':secret},{**safe,'token':secret},{**safe,'details':{'authorization':secret}},{**safe,'stage':secret},{**safe,'stage':[secret]},{**safe,'code':[secret]}]:
            encoded=json.dumps(bad)
            with self.subTest(bad=bad):
                self.assertIsNone(safe_remote_failure(encoded))
                with patch.object(client.subprocess,'run',return_value=subprocess.CompletedProcess(['ssh'],1,stdout=secret,stderr=encoded)):
                    with self.assertRaisesRegex(StagedFailure,'^V5_REMOTE_ISSUER_FAILED$') as failure:client.command(['ssh'],stage='REMOTE_ISSUER',remote_failure=True)
                self.assertNotIn(secret,str(failure.exception))
        self.assertIsNone(safe_remote_failure(json.dumps(safe)+'\n'+json.dumps(safe)))
        self.assertIsNone(safe_remote_failure(secret*2000))
        self.assertEqual(remote.failure_payload(RuntimeError(secret))['code'],'V5_REMOTE_TASK_FAILED')
    def test_remote_docker_failure_retains_only_safe_code_with_actual_execution_phase(self):
        for stage,phase in [('IMAGE_INSPECT','image'),('RECIPIENT_VALIDATION','validation'),('ISSUER_EXECUTION','issuer'),('RECEIPT_ENCRYPTION','encryption')]:
            with self.subTest(stage=stage):
                result=subprocess.CompletedProcess(['docker'],1,stdout='sensitive stdout',stderr='secret docker stderr')
                with patch.object(remote.subprocess,'run',return_value=result),redirect_stdout(io.StringIO()) as output:
                    with self.assertRaises(StagedFailure) as failure:remote.run(['docker'],stage=stage)
                self.assertEqual(remote.failure_payload(failure.exception),{'status':'FAILED','code':'V5_'+stage+'_FAILED','stage':phase});self.assertEqual(output.getvalue(),'')
                with patch.object(remote.subprocess,'run',side_effect=subprocess.TimeoutExpired(['docker'],90,output='secret stdout',stderr='secret stderr')):
                    with self.assertRaises(StagedFailure) as failure:remote.run(['docker'],stage=stage)
                self.assertEqual(remote.failure_payload(failure.exception),{'status':'FAILED','code':'V5_'+stage+'_TIMEOUT','stage':phase})
        result=subprocess.CompletedProcess(['docker'],1,stdout='',stderr=json.dumps({'status':'FAILED','code':'V5_ACTIVE_OWNER_MATCH_REQUIRED'}))
        with patch.object(remote.subprocess,'run',return_value=result):
            with self.assertRaises(StagedFailure) as failure:remote.run(['docker'],stage='ISSUER_EXECUTION')
        self.assertEqual(remote.failure_payload(failure.exception),{'status':'FAILED','code':'V5_ACTIVE_OWNER_MATCH_REQUIRED','stage':'issuer'})
if __name__=='__main__':unittest.main()
