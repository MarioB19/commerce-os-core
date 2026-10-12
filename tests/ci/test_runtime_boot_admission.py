"""Pure approval derivation with linked synthetic originals; no cloud effects."""
import copy
import datetime as dt
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path[:0]=[str(Path(__file__).resolve().parents[2]/'scripts'),str(Path(__file__).parent)]
import runtime_boot_admission as a
import test_runtime_boot_install_gate as fixtures
from test_runtime_boot_restore_gate import NOW,SOURCE,raw

class AdmissionTests(unittest.TestCase):
 def setUp(self):
  self.f=fixtures.InstallGateTests();self.f.setUp()
  self.h=a.pack_history(self.f.f.refs,self.f.f.read,restore_source_sha=SOURCE,now=NOW)
  self.native={name:self.f.data[r['path']] for name,r in self.f.approval['native_originals'].items()}
  self.admitted={'source_sha':self.f.report['source_sha'],'installation_run_id':self.f.report['run_id'],'archive_sha256':self.f.report['archive_sha256']}
 def packed(self):return a.pack_inputs(self.admitted,self.native,self.h,created_at=NOW-dt.timedelta(seconds=10),expires_at=NOW+dt.timedelta(minutes=10))
 def produce(self,wire=None,**kw):
  opts={'report':self.f.report,'host_id':'123456','gateway_start_ids':{'waha-01':'8'*64},'candidate_migrations':self.f.history['migration_files'],'candidate_restore_sources':self.f.history['restore_sources'],'now':NOW};opts.update(kw)
  with patch.dict(sys.modules,{'cloudbuild_full_evidence':self.f.full,'cloudbuild_release_evidence':self.f.release,'ci_provider_evidence':self.f.provider}):return a.produce(wire or self.packed(),**opts)
 def test_preserves_every_original_and_all_native_gates(self):
  # Formatting intentionally differs from canonical JSON, yet original stays identical.
  self.native['full_build']=b'{  "fixture": true }\n'
  out=self.produce();self.assertFalse(out['native_effects'])
  for value in [*self.native.values(),*self.f.f.raws.values()]:self.assertIn(value,out['originals'].values())
  self.assertEqual(len(out['approval']['native_originals']),8)
  self.assertEqual(len(out['approval']['restore_originals']),16)
  self.assertEqual(out['approval']['expires_at'],(NOW+dt.timedelta(minutes=10)).isoformat())
  self.f.full.validate_native.assert_called_once();self.f.release.package_native.assert_called_once()
  self.assertFalse(out['validated']['restore']['installation_authorized'])
 def test_host_and_gateway_authority_not_accepted_from_transport(self):
  for k,v in [('host_id','123'),('gateway_start_ids',{}),('full',True)]:
   doc=a.gate.restore.decode(self.packed());doc[k]=v
   with self.subTest(k=k),self.assertRaisesRegex(RuntimeError,'BOOT_INPUT_FIELDS'):self.produce(a.sealed(doc))
 def test_expired_future_and_window_extension_fail_before_native_gate(self):
  for edits in ({'expires_at':NOW.isoformat()},{'created_at':(NOW+dt.timedelta(seconds=1)).isoformat()},{'expires_at':(NOW+dt.timedelta(hours=1)).isoformat()}):
   doc=a.gate.restore.decode(self.packed());doc.update(edits)
   with self.assertRaises(RuntimeError):self.produce(a.sealed(doc))
  self.f.full.validate_native.assert_not_called()
 def test_original_changed_reserialized_missing_duplicate_and_oversized_fail(self):
  doc=a.gate.restore.decode(self.packed());doc['native_originals']['full_build']['sha256']='f'*64
  with self.assertRaisesRegex(RuntimeError,'ORIGINAL_CHANGED'):self.produce(a.sealed(doc))
  for mutate in (lambda d:d['history']['originals'].pop('claim'),lambda d:d['native_originals'].pop('full_logs'),lambda d:d['native_originals']['full_logs'].update(bytes=a.MAX_RAW)):
   doc=a.gate.restore.decode(self.packed());mutate(doc)
   with self.assertRaises(Exception):self.produce(a.sealed(doc))
  with self.assertRaises(Exception):self.produce(self.packed()+b' ')
  with self.assertRaises(Exception):a.unpack(b'{"a":1,"a":2}')
 def test_candidate_schema_restore_source_and_release_binding_cannot_change(self):
  migration=dict(self.f.history['migration_files']);migration[next(iter(migration))]='f'*64
  with self.assertRaisesRegex(RuntimeError,'MIGRATIONS_CHANGED'):self.produce(candidate_migrations=migration)
  report=dict(self.f.report,source_sha='b'*40)
  with self.assertRaisesRegex(RuntimeError,'REPORT_CHANGED'):self.produce(report=report)
  self.f.full.validate_native.return_value='failure'
  with self.assertRaisesRegex(RuntimeError,'FULL_REQUIRED'):self.produce()
 def test_no_effects_or_filesystem_reads_in_derivation(self):
  wire=self.packed()
  with patch('builtins.open',side_effect=AssertionError('no filesystem')),patch.object(Path,'read_bytes',side_effect=AssertionError('no filesystem')):
   self.assertFalse(self.produce(wire)['native_effects'])
 def test_bounded_complete_logs_preserve_raw_pages_and_query(self):
  pages=[b'{ "nextPageToken":"next" }',b'{"entries":[{"test":1}]}']
  packed=a.gate.pack_log_pages('fixed query',pages)
  self.assertEqual(a.gate.logs(packed,'fixed query'),[{'test':1}])
  with self.assertRaisesRegex(RuntimeError,'PAGES_INVALID'):a.gate.logs(packed,'foreign')
  for bad in ([raw({'nextPageToken':'next'})],[raw({'nextPageToken':'next'}),raw({'nextPageToken':'next'})],[raw({'entries':[]}),raw({'entries':[]})]):
   with self.assertRaisesRegex(RuntimeError,'LOGS_INCOMPLETE'):a.gate.pack_log_pages('fixed query',bad)
  doc=a.gate.restore.decode(packed);doc['pages'][0]['sha256']='f'*64
  with self.assertRaisesRegex(RuntimeError,'PAGE_CHANGED'):a.gate.logs(a.sealed(doc),'fixed query')

if __name__=='__main__':unittest.main()
