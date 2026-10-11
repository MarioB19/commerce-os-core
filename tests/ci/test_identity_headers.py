import importlib.util
from pathlib import Path
import sys
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from ci_release import ReleaseError
spec=importlib.util.spec_from_file_location('identity_deploy',Path(__file__).resolve().parents[2]/'scripts/deploy-ci-vps.py')
deploy=importlib.util.module_from_spec(spec);spec.loader.exec_module(deploy)

class IdentityHeaderTests(unittest.TestCase):
    def response(self, headers, status=200):
        result=MagicMock();result.__enter__.return_value=result
        result.status=status;result.headers=headers
        return result

    def test_verifies_each_public_identity_route(self):
        opener=MagicMock(return_value=self.response({'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'}))
        self.assertTrue(deploy.verify_identity_headers('https://commerce.example.invalid',opener))
        self.assertEqual([call.args[0] for call in opener.call_args_list],[f'https://commerce.example.invalid{path}' for path in ['/login','/forgot-password','/reset-password','/account/security']])

    def test_old_proxy_policy_fails_even_with_correct_web_body(self):
        opener=MagicMock(return_value=self.response({'Cache-Control':'no-store','Referrer-Policy':'same-origin'}))
        with self.assertRaisesRegex(ReleaseError,'HTTPS_IDENTITY_HEADERS_FAILED'):
            deploy.verify_identity_headers('https://commerce.example.invalid',opener)

    def test_missing_no_store_or_unexpected_status_fails(self):
        for cache,status in [('no-cache',200),('no-store-other',200),('no-store',503)]:
            with self.subTest(cache=cache,status=status):
                opener=MagicMock(return_value=self.response({'Cache-Control':cache,'Referrer-Policy':'no-referrer'},status))
                with self.assertRaisesRegex(ReleaseError,'HTTPS_IDENTITY_HEADERS_FAILED'):
                    deploy.verify_identity_headers('https://commerce.example.invalid',opener)

    def test_creative_csp_requires_direct_r2_and_keeps_scripts_self(self):
        allowed="default-src 'self'; script-src 'self'; connect-src 'self' https://*.r2.cloudflarestorage.com; media-src 'self' blob: https://*.r2.cloudflarestorage.com"
        self.assertTrue(deploy.verify_creative_headers('https://commerce.example.invalid',MagicMock(return_value=self.response({'Content-Security-Policy':allowed}))))
        for policy in [allowed.replace("connect-src 'self' https://*.r2.cloudflarestorage.com", "connect-src 'self'"),allowed.replace("script-src 'self'",'script-src https:')]:
            with self.assertRaisesRegex(ReleaseError,'HTTPS_CREATIVE_HEADERS_FAILED'):
                deploy.verify_creative_headers('https://commerce.example.invalid',MagicMock(return_value=self.response({'Content-Security-Policy':policy})))

class IdentityProxyReportTests(unittest.TestCase):
    def runner(self, code=0, stdout='', stderr=''):
        return MagicMock(return_value=SimpleNamespace(returncode=code,stdout=stdout,stderr=stderr))

    def test_success_report_is_validated_and_sanitized(self):
        updated=deploy.update_identity_proxy('/synthetic',self.runner(stdout='{"status":"UPDATED","other_sites_preserved":true,"rollback_token":"identity-proxy-safe_123","private":"never return"}'))
        self.assertEqual(updated,{'status':'UPDATED','other_sites_preserved':True,'rollback_token':'identity-proxy-safe_123'})
        unchanged=deploy.update_identity_proxy('/synthetic',self.runner(stdout='{"status":"UNCHANGED","other_sites_preserved":true,"private":"never return"}'))
        self.assertEqual(unchanged,{'status':'UNCHANGED','other_sites_preserved':True})

    def test_only_structured_error_code_is_exposed(self):
        with self.assertRaisesRegex(ReleaseError,'^IDENTITY_PROXY_ACTIVE_DISK_CONFIG_MISMATCH$'):
            deploy.update_identity_proxy('/synthetic',self.runner(1,stderr='{"status":"FAILED","error":"ACTIVE_DISK_CONFIG_MISMATCH"}'))
        for error in ['private raw output','{"status":"FAILED","error":"secret value"}','null']:
            with self.subTest(error=error), self.assertRaisesRegex(ReleaseError,'^IDENTITY_PROXY_UPDATE_FAILED$'):
                deploy.update_identity_proxy('/synthetic',self.runner(1,stderr=error))

    def test_invalid_success_is_never_accepted(self):
        for report in ['not JSON','null','{"status":"UPDATED","other_sites_preserved":false}',
                       '{"status":"UPDATED","other_sites_preserved":true}',
                       '{"status":"UNCHANGED","other_sites_preserved":true,"rollback_token":"identity-proxy-unexpected"}']:
            with self.subTest(report=report), self.assertRaisesRegex(ReleaseError,'^IDENTITY_PROXY_INVALID_REPORT$'):
                deploy.update_identity_proxy('/synthetic',self.runner(stdout=report))

    def test_timeout_has_safe_code(self):
        with self.assertRaisesRegex(ReleaseError,'^IDENTITY_PROXY_TIMEOUT$'):
            deploy.update_identity_proxy('/synthetic',MagicMock(side_effect=subprocess.TimeoutExpired(['synthetic'],150)))

    def test_restore_uses_only_valid_receipt_and_sanitizes_result(self):
        runner=self.runner(stdout='{"status":"RESTORED","other_sites_preserved":true,"private":"never return"}')
        result=deploy.restore_identity_proxy('/synthetic',{'status':'UPDATED','rollback_token':'identity-proxy-safe_123'},runner)
        self.assertEqual(result,{'status':'RESTORED','other_sites_preserved':True})
        self.assertEqual(runner.call_args.args[0][-2:],['restore','identity-proxy-safe_123'])
        self.assertEqual(deploy.restore_identity_proxy('/synthetic',None,runner),{'status':'NOT_APPLIED','other_sites_preserved':True})

    def test_restore_failure_exposes_only_structured_code(self):
        runner=self.runner(1,stderr='{"status":"FAILED","error":"ROLLBACK_SOURCE_CHANGED","private":"hidden"}')
        with self.assertRaisesRegex(ReleaseError,'^IDENTITY_PROXY_RESTORE_ROLLBACK_SOURCE_CHANGED$'):
            deploy.restore_identity_proxy('/synthetic',{'status':'UPDATED','rollback_token':'identity-proxy-safe_123'},runner)
        with self.assertRaisesRegex(ReleaseError,'^IDENTITY_PROXY_RESTORE_RECEIPT_INVALID$'):
            deploy.restore_identity_proxy('/synthetic',{'status':'UPDATED','rollback_token':'../../private'},runner)

if __name__=='__main__':
    unittest.main()
