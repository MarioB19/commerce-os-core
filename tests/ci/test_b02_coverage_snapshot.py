import importlib.util,json,os,pathlib,sys,tempfile,unittest
from unittest.mock import patch
scripts=pathlib.Path(__file__).resolve().parents[2]/'scripts';sys.path.insert(0,str(scripts));import b02_coverage_snapshot as m
class Snapshot(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=pathlib.Path(self.tmp.name).resolve();self.root.chmod(0o700);p=self.root/'1-1';p.mkdir(mode=0o700);self.j=p/'journal.json';self.j.write_text(json.dumps({'run_id':'1-1','started_at':'2026-10-01T00:00:00Z','status':'FAILED','sensitive_test_field':'never-export-synthetic'}));self.j.chmod(0o600)
 def capture(self):
  # Fixture temp ancestors are owned by the host and /tmp is sticky; replace
  # only their stat view, preserving real fd/hash/directory IO for owned files.
  original=pathlib.Path.lstat
  def safe(p):
   s=original(p)
   if p!=self.root and self.root.is_relative_to(p):
    vals=list(s);vals[0]=(vals[0]&~0o777)|0o755;vals[4]=os.getuid();return os.stat_result(vals)
   return s
  with patch.object(pathlib.Path,'lstat',safe):return m.capture(self.root,observed_at='2026-10-11T00:00:00Z',expected_uid=os.getuid())
 def test_metadata_only_failed_count_preserved(self):
  r=self.capture();self.assertEqual(r['count'],1);self.assertEqual(r['journals'][0]['status'],'FAILED');self.assertNotIn('sensitive_test_field',json.dumps(r));self.assertFalse(r['execution_authorized'])
 def test_symlink_and_permissions_rejected(self):
  self.j.chmod(0o644)
  with self.assertRaisesRegex(RuntimeError,'CUSTODY'):self.capture()
  self.j.chmod(0o600);self.j.rename(self.j.with_suffix('.saved'));self.j.symlink_to(self.j.with_suffix('.saved'))
  with self.assertRaisesRegex(RuntimeError,'CUSTODY'):self.capture()
 def test_unknown_name_and_missing_journal_not_silently_omitted(self):
  (self.root/'foreign').mkdir(mode=0o700)
  with self.assertRaisesRegex(RuntimeError,'FOREIGN'):self.capture()
  (self.root/'foreign').rmdir();self.j.unlink()
  with self.assertRaises(FileNotFoundError):self.capture()
 def test_duplicate_json_or_future_rejected(self):
  self.j.write_text('{"run_id":"1-1","run_id":"2-1"}')
  with self.assertRaisesRegex(RuntimeError,'DUPLICATE'):self.capture()
 def test_unsafe_parent_blocks_before_open(self):
  with patch.object(m.os,'open',side_effect=AssertionError('MUST_NOT_OPEN')):
   with self.assertRaisesRegex(RuntimeError,'PARENT'):m.capture(self.root,observed_at='2026-10-11T00:00:00Z',expected_uid=os.getuid())
if __name__=='__main__':unittest.main()
