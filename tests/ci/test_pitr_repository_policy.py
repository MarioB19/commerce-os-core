import importlib.util,pathlib,unittest
spec=importlib.util.spec_from_file_location('pitr',pathlib.Path(__file__).resolve().parents[2]/'scripts/pitr_repository_policy.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Policy(unittest.TestCase):
 def config(self,**kw):return m.configuration(**dict(bucket='commerce-v7-pitr-synthetic',region='us-central1',primary_region='us-east1',cluster_id='1234567890123456789')|kw)
 def readback(self):return dict(line.split('=',1)for line in self.config().splitlines()if '='in line)
 def test_other_region_encrypted_time_retention_no_drop_limit(self):
  s=self.config();self.assertIn('repo1-retention-full-type=time\nrepo1-retention-full=7',s);self.assertIn('repo1-gcs-key-type=auto',s);self.assertNotIn('queue-max',s);self.assertNotIn('cipher-pass=',s)
 def test_running_settings_required(self):
  r=m.validate_effective(m.postgres_settings(),self.readback());self.assertFalse(r['restore_verified']);self.assertFalse(r['production_rpo_proven'])
 def test_discard_or_short_retention_not_admitted(self):
  for field,value in [('archive-push-queue-max','1GiB'),('archive-queue-max','0'),('repo1-retention-archive','1'),('repo1-retention-full','6'),('repo1-cipher-pass','synthetic-not-secret')]:
   with self.subTest(field=field),self.assertRaises(RuntimeError):m.validate_effective(m.postgres_settings(),self.readback()|{field:value})
 def test_identity_injection_or_same_region_fail(self):
  for change in [{'region':'us-east1'},{'bucket':'commerce-v7-pitr-x\nrepo1-cipher-type=none'},{'cluster_id':'../evil'}]:
   with self.assertRaises(RuntimeError):self.config(**change)
 def test_compressed_measurement_cannot_hide_large_wal(self):
  gib=1024**3;r=m.capacity(full_backup_bytes=gib,incremental_bytes_per_day=100,compressed_wal_bytes_per_day=8*gib,auth_backup_bytes=gib,retained_days=7,full_interval_days=1,cross_region_bytes_used=0,monthly_transfer_reserve_bytes=50*gib,storage_reserve_bytes=20*gib)
  self.assertFalse(r['storage_fits']);self.assertFalse(r['cross_region_fits']);self.assertFalse(r['delete_allowed']);self.assertFalse(r['production_authorized']);self.assertEqual(r['retained_window_bound_days'],8)
 def test_daily_bi_daily_weekly_full_retention_includes_all_bases(self):
  for interval,full_count in [(1,9),(2,6),(7,3)]:
   with self.subTest(interval=interval):
    r=m.capacity(full_backup_bytes=1000,incremental_bytes_per_day=0,compressed_wal_bytes_per_day=0,auth_backup_bytes=0,retained_days=7,full_interval_days=interval,cross_region_bytes_used=0,monthly_transfer_reserve_bytes=100000,storage_reserve_bytes=2000)
    self.assertEqual(r['retained_full_backup_bound'],full_count);self.assertEqual(r['storage_required_bytes'],full_count*1000);self.assertFalse(r['storage_fits'])
 def test_successful_estimate_still_not_production(self):
  r=m.capacity(full_backup_bytes=1000,incremental_bytes_per_day=100,compressed_wal_bytes_per_day=100,auth_backup_bytes=200,retained_days=7,full_interval_days=7,cross_region_bytes_used=0,monthly_transfer_reserve_bytes=100000,storage_reserve_bytes=100000)
  self.assertTrue(r['storage_fits']);self.assertTrue(r['representative_measurement_required']);self.assertFalse(r['production_authorized'])
if __name__=='__main__':unittest.main()
