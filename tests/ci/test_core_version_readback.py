import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from ci_release import ReleaseError
spec=importlib.util.spec_from_file_location('version_deploy',ROOT/'scripts/deploy-ci-vps.py')
deploy=importlib.util.module_from_spec(spec);spec.loader.exec_module(deploy)

ORIGIN='https://commerce.example.invalid'
SHA='a'*40

class CoreVersionReadbackTests(unittest.TestCase):
    def response(self,body,status=200,content_type='application/json; charset=utf-8'):
        result=MagicMock();result.__enter__.return_value=result
        result.status=status;result.headers={'Content-Type':content_type}
        result.read.return_value=json.dumps(body).encode() if not isinstance(body,bytes) else body
        return result

    def test_binds_public_version_to_exact_release_metadata(self):
        opener=MagicMock(return_value=self.response({'service':'commerce-api','release':'ci-123-1-aaaaaaaaaa','sha':SHA,'configured':True}))
        self.assertEqual(deploy.verify_core_version(ORIGIN,SHA,opener),{'sha':SHA,'release':'ci-123-1-aaaaaaaaaa'})
        opener.assert_called_once_with(ORIGIN+'/api/version',timeout=30)

    def test_rejects_stale_unconfigured_or_malformed_readback(self):
        cases=[
            {'service':'commerce-api','release':'ci-123','sha':'b'*40,'configured':True},
            {'service':'commerce-api','release':'ci-123','sha':SHA,'configured':False},
            {'service':'other','release':'ci-123','sha':SHA,'configured':True},
            {'service':'commerce-api','release':'unsafe release','sha':SHA,'configured':True},
        ]
        for body in cases:
            with self.subTest(body=body),self.assertRaisesRegex(ReleaseError,'HTTPS_CORE_VERSION_MISMATCH'):
                deploy.verify_core_version(ORIGIN,SHA,MagicMock(return_value=self.response(body)))

    def test_rejects_wrong_transport_shape_and_oversized_body(self):
        with self.assertRaisesRegex(ReleaseError,'HTTPS_CORE_VERSION_STATUS_FAILED'):
            deploy.verify_core_version(ORIGIN,SHA,MagicMock(return_value=self.response({},status=503)))
        with self.assertRaisesRegex(ReleaseError,'HTTPS_CORE_VERSION_CONTENT_TYPE_FAILED'):
            deploy.verify_core_version(ORIGIN,SHA,MagicMock(return_value=self.response({},content_type='text/html')))
        with self.assertRaisesRegex(ReleaseError,'HTTPS_CORE_VERSION_JSON_FAILED'):
            deploy.verify_core_version(ORIGIN,SHA,MagicMock(return_value=self.response(b'<html>')))
        with self.assertRaisesRegex(ReleaseError,'HTTPS_CORE_VERSION_RESPONSE_TOO_LARGE'):
            deploy.verify_core_version(ORIGIN,SHA,MagicMock(return_value=self.response(b'x'*4097)))

if __name__=='__main__':
    unittest.main()
