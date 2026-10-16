from copy import deepcopy
from pathlib import Path
import sys,unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import cloudbuild_trigger_profile as m

class TriggerTests(unittest.TestCase):
    def setUp(self):self.image='us-east1-docker.pkg.dev/'+m.PROJECT+'/commerce-ci-public/attestor@sha256:'+'a'*64
    def test_two_inline_required_approval_triggers_no_candidate_paths(self):
        value=m.profile(self.image)
        self.assertEqual(set(value['triggers']),{'main','pull_request'})
        for row in value['triggers'].values():
            self.assertRegex(row['name'],r'^[a-z0-9-]+$')
            self.assertEqual(row['approvalConfig'],{'approvalRequired':True})
            self.assertEqual(row['build'],m.template(self.image));self.assertNotIn('filename',row)
            self.assertEqual(row['serviceAccount'],m.SERVICE_ACCOUNT)
        self.assertFalse(value['execution_admitted']);self.assertEqual(value['pending_exec_seconds'],0)
    def test_other_event_or_image_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'TRIGGER_EVENT'):m.trigger('tag',self.image)
        with self.assertRaisesRegex(RuntimeError,'ATTESTOR_IMAGE'):m.trigger('main',self.image.replace('@sha256:',':'))
    def test_observed_omitted_proto3_defaults_only(self):
        expected=m.trigger('pull_request',self.image);actual=deepcopy(expected)
        del actual['includeBuildLogs'];del actual['build']['options']['automapSubstitutions']
        self.assertTrue(m.validate_readback(actual,expected))
        for value in (True,0,None,'false'):
            changed=deepcopy(actual);changed['build']['options']['automapSubstitutions']=value
            with self.subTest(value=value),self.assertRaises(RuntimeError):m.validate_readback(changed,expected)
        changed=deepcopy(actual);changed['includeBuildLogs']='INCLUDE_BUILD_LOGS_WITH_STATUS'
        with self.assertRaises(RuntimeError):m.validate_readback(changed,expected)
    def test_native_defaults_allowed_but_extra_behavior_fails(self):
        expected=m.trigger('main',self.image);actual=deepcopy(expected)
        actual.update(id='native',resourceName='native',createTime='native',disabled=False,substitutions={})
        actual['repositoryEventConfig']['repositoryType']='GITHUB'
        self.assertTrue(m.validate_readback(actual,expected))
        for change in ({'filename':'candidate.yaml'},{'disabled':True},{'approvalConfig':{}},
                       {'substitutions':{'_EXTRA':'x'}}):
            with self.assertRaises(RuntimeError):m.validate_readback({**actual,**change},expected)

if __name__=='__main__':unittest.main()
