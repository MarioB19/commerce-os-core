"""Real filesystem/Git regression; commands are fixtures, never a FULL claim."""
import hashlib,json,os,stat,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import test_cloudbuild_verify as fixture
m=fixture.m
class EvidenceTests(unittest.TestCase):
 def setUp(self):
  self.f=fixture.VerificationContractTests();self.f.setUp();self.addCleanup(self.f.doCleanups)
  self.dirs=[];original=m.private_evidence_directory
  def create(*a):
   p=original(*a);self.dirs.append(p);return p
  self.patcher=patch.object(m,'private_evidence_directory',side_effect=create);self.patcher.start();self.addCleanup(self.patcher.stop)
  def cleanup():
   import shutil
   for p in self.dirs:shutil.rmtree(p)
  self.addCleanup(cleanup)
 def test_external_outputs_leave_real_git_clean_and_hash_bytes(self):
  expected={'ui-latency.json':b'{"synthetic":true}\n','screens/synthetic.png':b'PNG fixture'}
  def execute(argv,cwd,env,seconds):
   out=Path(env['COMMERCE_TEST_EVIDENCE_DIR']);self.assertFalse(out.is_relative_to(self.f.root))
   if argv==['pnpm','test:e2e']:
    for name,raw in expected.items():p=out/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
   return 0
  result=self.f.run_verify(execute);self.assertEqual(result['status'],'PASSED');self.assertEqual(self.f.git('status','--porcelain'),'')
  document=json.loads((self.dirs[0]/'manifest.json').read_bytes());self.assertEqual(document['source_changes'],[])
  self.assertEqual({x['path']:x['sha256']for x in document['files']},{k:hashlib.sha256(v).hexdigest()for k,v in expected.items()})
  self.assertEqual(result['test_evidence']['manifest_sha256'],m.file_sha256(self.dirs[0]/'manifest.json'))
 def test_tracked_and_untracked_changes_still_fail_with_hashes(self):
  def execute(argv,cwd,env,seconds):
   if argv==['pnpm','audit','--audit-level','high']:
    (self.f.root/'.node-version').write_text('dirty fixture\n');(self.f.root/'generated.json').write_bytes(b'new fixture')
   return 0
  result=self.f.run_verify(execute);self.assertEqual(result['failure_code'],'SOURCE_TREE_NOT_CLEAN')
  rows=json.loads((self.dirs[0]/'manifest.json').read_bytes())['source_changes'];self.assertEqual({r['path']for r in rows},{'.node-version','generated.json'})
  for row in rows:self.assertEqual(row['sha256'],m.file_sha256(self.f.root/row['path']))
 def test_no_ignore_or_cleanup_hides_dirty_output(self):
  old=(self.f.root/'.gitignore').read_bytes()
  def execute(*args):(self.f.root/'native-dirty.txt').write_text('still here');return 0
  result=self.f.run_verify(execute);self.assertEqual(result['status'],'FAILED');self.assertEqual((self.f.root/'.gitignore').read_bytes(),old);self.assertTrue((self.f.root/'native-dirty.txt').exists())
 def test_symlink_artifact_never_reads_target_and_cannot_pass(self):
  def execute(argv,cwd,env,seconds):
   if argv==['pnpm','test:e2e']:(Path(env['COMMERCE_TEST_EVIDENCE_DIR'])/'link').symlink_to(self.f.root/'.node-version')
   return 0
  result=self.f.run_verify(execute);self.assertEqual(result['failure_code'],'TEST_EVIDENCE_MANIFEST_FAILED');self.assertTrue(result['test_evidence_capture_failed'])
 def test_parent_private_and_inherited_destination_not_used(self):
  with patch.dict(os.environ,{'TMPDIR':str(self.f.root),'COMMERCE_TEST_EVIDENCE_DIR':str(self.f.root)}):
   result=self.f.run_verify(lambda *a:0)
  self.assertEqual(result['status'],'PASSED');self.assertFalse(self.dirs[0].is_relative_to(self.f.root));self.assertEqual(stat.S_IMODE(self.dirs[0].stat().st_mode),0o700)
 def test_failure_preserves_output_evidence_and_original_failure(self):
  def execute(argv,cwd,env,seconds):
   (Path(env['COMMERCE_TEST_EVIDENCE_DIR'])/'partial.json').write_bytes(b'partial')
   return 1
  result=self.f.run_verify(execute);self.assertEqual(result['failure_code'],'REQUIRED_STAGE_FAILED');self.assertEqual(result['test_evidence']['file_count'],1)
 def test_shared_node_and_linux_capsule_paths_unchanged(self):
  calls=[];result=self.f.run_verify(lambda argv,cwd,env,seconds:calls.append((argv,env))or 0)
  self.assertEqual(result['status'],'PASSED');self.assertEqual(len(calls),21)
  self.assertTrue(all(str(self.f.root/'.runtime')in env['PATH']for _,env in calls))
  capsule=[env for argv,env in calls if 'tests/ci/test_b02_portal_capsule_linux.mjs'in argv][0];self.assertTrue(Path(capsule['TMPDIR']).is_relative_to(self.f.root/'.runtime'))
if __name__=='__main__':unittest.main()
