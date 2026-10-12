"""Capture real reader protocol with synthetic raw responses; no cloud calls."""
import base64,copy,hashlib,io,json
from datetime import timedelta
from pathlib import Path
import sys,unittest
from types import SimpleNamespace
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import cloudbuild_boot_admission as m
from cloudbuild_native_reader import GoogleFullReader
from cloudbuild_connected_source import ConnectedSourceReader
import test_cloudbuild_native_package as package_fixture
import test_cloudbuild_publish_status as full_fixture
import test_runtime_boot_admission as boot_fixture
import runtime_boot_admission as boot
from test_cloudbuild_admission import NOW

def raw(value):return (json.dumps(value,indent=1)+' \n').encode()
class Tests(unittest.TestCase):
 def setUp(self):
  self.p=package_fixture.PackageTests();self.p.setUp();self.f=full_fixture.fixture();self.b=boot_fixture.AdmissionTests();self.b.setUp()
  self.source=ConnectedSourceReader(lambda:'synthetic-google',opener=package_fixture.Opener([raw(self.f[2])]),now=lambda:NOW)
  self.source._read_token='synthetic-source';self.source._expires=NOW+timedelta(hours=1)
  project={'projectId':m.PROJECT,'projectNumber':package_fixture.NUMBER}
  self.full_raw=[raw(project),raw(self.f[1]),raw({'entries':self.f[4]}),raw(project)]
  self.full=GoogleFullReader(lambda:'synthetic-google',self.source.commit,opener=package_fixture.Opener(self.full_raw.copy()))
  self.package,self.package_opener=self.p.reader([raw({'nextPageToken':'next'}),raw({'entries':[self.p.log]})]);self.package.full_reader=self.full
  clean,_=self.p.reader();self.expected=clean.evidence(self.p.admission)
  history_raw=boot.sealed(self.b.h)
  self.config={'restore_source_sha':self.b.h['restore_source_sha'],'restore_bundle':{'bucket':'private-custody','object':'core/restore.json','generation':'5','sha256':hashlib.sha256(history_raw).hexdigest(),'size':len(history_raw),'md5':base64.b64encode(hashlib.md5(history_raw).digest()).decode()}}
  self.custody=Mock();self.custody.read_json.return_value=self.b.h;self.reserve=Mock();self.check=Mock()
  self.admitted={'source_sha':self.p.context['source_sha'],'installation_run_id':'cloudbuild-'+self.p.context['package_build_id']+'-1','archive_sha256':self.p.receipt['archive_sha256']}
 def collect(self):return m.collect_boot_inputs(config=self.config,custody=self.custody,source_reader=self.source,full_reader=self.full,package_reader=self.package,release_admission=self.p.admission,admitted=self.admitted,expected_package=self.expected,check=self.check,now=lambda:NOW,reserve=self.reserve,expires_at=NOW+timedelta(minutes=10))
 def test_real_readers_preserve_raw_bytes_and_complete_log_pages(self):
  originals=[self.source.opener,self.full.opener,self.package.opener];wire=self.collect();value,native,historical=boot.unpack(wire)
  self.assertEqual(native['full_build'],self.full_raw[1]);self.assertEqual(native['full_commit'],raw(self.f[2]));self.assertEqual(native['artifact_manifest'],self.p.manifest_raw)
  self.assertEqual(boot.gate.logs(native['package_logs'],m.Capture(self.p.admission,self.check).queries['package_logs']),[self.p.log])
  self.assertEqual(value['expires_at'],(NOW+timedelta(minutes=10)).isoformat());self.assertEqual(originals,[self.source.opener,self.full.opener,self.package.opener]);self.reserve.assert_called_once_with(58*1024*1024)
  self.assertNotIn(b'synthetic-google',wire);self.assertNotIn(b'synthetic-source',wire)
 def test_reservation_precedes_custody_or_provider_reads(self):
  self.reserve.side_effect=RuntimeError('RESERVATION_UNKNOWN')
  with self.assertRaisesRegex(RuntimeError,'RESERVATION_UNKNOWN'):self.collect()
  self.custody.read_json.assert_not_called();self.assertEqual(self.full.opener.calls,[])
 def test_native_full_failure_preserved_and_opener_restored(self):
  self.full.opener.responses[1]=raw({**self.f[1],'status':'FAILURE'})
  original=self.full.opener
  with self.assertRaisesRegex(RuntimeError,'NATIVE_FULL_REQUIRED'):self.collect()
  self.assertIs(self.full.opener,original);self.assertEqual(self.package_opener.calls,[])
 def test_changed_artifact_or_missing_package_page_never_packs(self):
  self.expected['archive_sha256']='f'*64
  with self.assertRaisesRegex(RuntimeError,'PACKAGE_READBACK_CHANGED'):self.collect()
 def test_unexpected_token_endpoint_rejected_before_request(self):
  import urllib.request
  capture=m.Capture(self.p.admission,self.check);inner=Mock();opener=m.Opener(inner,capture)
  with self.assertRaisesRegex(RuntimeError,'UNEXPECTED_RESPONSE'):opener.open(urllib.request.Request('https://secretmanager.googleapis.com/v1/secret:access'),timeout=20)
  inner.open.assert_not_called()
 def test_capture_close_does_not_swallow_byte_limit_exception(self):
  capture=m.Capture(self.p.admission,self.check);capture.total=m.MAX_CAPTURE
  response=m.Response(package_fixture.Response(b'{}'),capture,'project',None)
  with self.assertRaisesRegex(RuntimeError,'AGGREGATE_BOUND'):
   with response as body:body.read(3)
  self.assertTrue(response.closed)
 def test_expired_authorization_cannot_be_renewed_by_packaging(self):
  calls=[NOW]
  def now():return calls[0]
  def check():calls[0]+=timedelta(seconds=60)
  with self.assertRaisesRegex(RuntimeError,'AUTHORIZATION_EXPIRED'):
   m.collect_boot_inputs(config=self.config,custody=self.custody,source_reader=self.source,full_reader=self.full,package_reader=self.package,release_admission=self.p.admission,admitted=self.admitted,expected_package=self.expected,check=check,now=now,reserve=self.reserve,expires_at=NOW+timedelta(minutes=10))
if __name__=='__main__':unittest.main()
