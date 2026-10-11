import importlib.util
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock,patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from ci_release import ReleaseError
from mcl_portal_release import (portal_env,rewrite_portal,proxy,MIGRATION_MAINTENANCE_BLOCK,
                                LEGACY_PROXY_NETWORK,portal_network_name,verify_portal_network)
install_spec=importlib.util.spec_from_file_location('mcl_portal_install_test',ROOT/'scripts'/'install-mcl-portal.py')
portal_install=importlib.util.module_from_spec(install_spec);install_spec.loader.exec_module(portal_install)

class PortalContracts(unittest.TestCase):
    def test_legacy_network_default_keeps_existing_noninternal_proxy_wiring(self):
        rows=[{'Name':LEGACY_PROXY_NETWORK,'Driver':'bridge','Internal':False,'EnableIPv6':False}]
        self.assertEqual(verify_portal_network(LEGACY_PROXY_NETWORK,rows,
                         {LEGACY_PROXY_NETWORK:{}}),LEGACY_PROXY_NETWORK)

    def test_copy_proxy_requires_explicit_migration_and_existing_internal_caddy_membership(self):
        name='synthetic-copy-proxy'
        rows=[{'Name':name,'Driver':'bridge','Internal':True,'EnableIPv6':False}]
        networks={name:{'NetworkID':'fixture'},'synthetic-edge':{}}
        before=json.dumps((rows,networks),sort_keys=True)
        with self.assertRaisesRegex(ReleaseError,'PORTAL_NETWORK_MIGRATION_REQUIRED'):
            verify_portal_network(name,rows,networks)
        self.assertEqual(verify_portal_network(name,rows,networks,
                         allow_migration_maintenance=True),name)
        self.assertEqual(json.dumps((rows,networks),sort_keys=True),before)

    def test_copy_network_selection_rejects_external_ipv6_or_nonbridge_boundary(self):
        name='synthetic-copy-proxy'
        valid={'Name':name,'Driver':'bridge','Internal':True,'EnableIPv6':False}
        for delta in ({'Internal':False},{'Internal':'true'},{'EnableIPv6':True},
                      {'EnableIPv6':'false'},{'Driver':'overlay'},{'Name':'other'}):
            with self.subTest(delta=delta):
                with self.assertRaises(ReleaseError):
                    verify_portal_network(name,[{**valid,**delta}],{name:{}},
                                          allow_migration_maintenance=True)
        for rows,networks in [([], {name:{}}),([valid,valid],{name:{}}),
                              ([valid],{'synthetic-core':{}}),([valid],{name:None})]:
            with self.subTest(rows=rows,networks=networks):
                with self.assertRaises(ReleaseError):
                    verify_portal_network(name,rows,networks,allow_migration_maintenance=True)

    def test_network_names_and_migration_option_cannot_inject_or_coerce(self):
        for name in ('host','none','bridge','--network=host','copy;command','copy:3000',
                     'copy\nproxy','copy proxy','',None,'a'*129):
            with self.subTest(name=name):
                with self.assertRaises(ReleaseError):
                    portal_network_name(name,allow_migration_maintenance=True)
        for option in ('false','true',1,None):
            with self.subTest(option=option):
                with self.assertRaises(ReleaseError):
                    portal_network_name(LEGACY_PROXY_NETWORK,allow_migration_maintenance=option)

    def test_installer_rejects_invalid_network_before_private_read_or_system_command(self):
        with patch.object(portal_install.os,'geteuid',return_value=0),patch.object(Path,'read_text') as reader,patch.object(portal_install,'run') as runner:
            for options in ({'proxy_network':'synthetic-copy-proxy'},
                            {'proxy_network':'host','allow_migration_maintenance':True}):
                with self.subTest(options=options):
                    with self.assertRaises(ReleaseError):
                        portal_install.install('/unused','/unused','d'*40,'42-1',**options)
            reader.assert_not_called();runner.assert_not_called()

    def test_deferred_contacts_leave_values_absent_and_preserve_access_guards(self):
        raw='MCL_SESSION_SECRET='+'a'*64+'\nMCL_CORE_CODES_SHA256='+'b'*64+'\nMCL_KIT_CODES_SHA256='+'c'*64+'\nNEXT_PUBLIC_SITE_URL=https://ciclo.inovaris.online\n'
        env=portal_env(raw,'d'*40,require_legal_fields=False)
        self.assertIn('MCL_CORE_CODES_SHA256='+'b'*64,env)
        self.assertIn('MCL_KIT_CODES_SHA256='+'c'*64,env)
        for key in ('MCL_SUPPORT_EMAIL','MCL_PRIVACY_NAME','MCL_PRIVACY_ADDRESS','MCL_PRIVACY_EMAIL'):
            self.assertNotIn(key+'=',env)
        for old,new in [('a'*64,'short'),('c'*64,'b'*64),
                        ('https://ciclo.inovaris.online','https://unrelated.invalid')]:
            with self.subTest(old=old):
                with self.assertRaises(ReleaseError):
                    portal_env(raw.replace(old,new),'d'*40,require_legal_fields=False)

    def test_contact_deferral_requires_explicit_boolean_and_migration(self):
        with patch.object(portal_install.os,'geteuid',return_value=0),patch.object(portal_install,'run') as runner:
            for options in ({'defer_public_contact_fields':True},
                            {'allow_migration_maintenance':True,'defer_public_contact_fields':'false'}):
                with self.subTest(options=options):
                    with self.assertRaises(ReleaseError):
                        portal_install.install('/unused','/unused','d'*40,'42-1',**options)
            runner.assert_not_called()

    def test_installer_keeps_required_contacts_by_default_and_only_defers_explicitly(self):
        raw='MCL_SESSION_SECRET='+'a'*64+'\nMCL_CORE_CODES_SHA256='+'b'*64+'\nMCL_KIT_CODES_SHA256='+'c'*64+'\nNEXT_PUBLIC_SITE_URL=https://ciclo.inovaris.online\n'
        def validate_and_stop(value,sha,**options):
            portal_env(value,sha,**options)
            raise ReleaseError('CONFIG_VALIDATED_STOP_BEFORE_SYSTEM_MUTATION')
        with patch.object(portal_install.os,'geteuid',return_value=0),patch.object(Path,'read_text',return_value=raw),patch.object(portal_install,'portal_env',side_effect=validate_and_stop),patch.object(portal_install,'run') as runner:
            with self.assertRaisesRegex(ReleaseError,'PORTAL_LEGAL_FIELDS_REQUIRED'):
                portal_install.install('/unused','/unused','d'*40,'42-1',allow_migration_maintenance=True)
            with self.assertRaisesRegex(ReleaseError,'CONFIG_VALIDATED_STOP_BEFORE_SYSTEM_MUTATION'):
                portal_install.install('/unused','/unused','d'*40,'42-1',allow_migration_maintenance=True,defer_public_contact_fields=True)
            runner.assert_not_called()

    def test_exact_migration_maintenance_requires_explicit_option(self):
        before=b'other.invalid {\n respond 200\n}\n\n'
        after=b'\n# preserve suffix\n'
        source=before+MIGRATION_MAINTENANCE_BLOCK+after
        with self.assertRaises(ReleaseError):rewrite_portal(source,'mcl-portal-42-1')
        result=rewrite_portal(source,'mcl-portal-42-1',allow_migration_maintenance=True)
        self.assertTrue(result.startswith(before));self.assertTrue(result.endswith(after))
        self.assertIn(b'reverse_proxy mcl-portal-42-1:3000',result)
        self.assertNotIn(b'maintenance-20261006',result)
        self.assertEqual(rewrite_portal(result,'mcl-portal-42-1'),result)
    def test_modified_migration_block_and_multiple_sites_refused(self):
        for old,new in [(b'Retry-After "300"',b'Retry-After "30"'),
                        (b'Cache-Control "no-store"',b'Cache-Control "public"'),
                        (b'503',b'200'),(b'  header {',b'  reverse_proxy unrelated:3000\n  header {'),
                        (b'  # managed-',b' # managed-')]:
            with self.subTest(old=old):
                with self.assertRaises(ReleaseError):
                    rewrite_portal(MIGRATION_MAINTENANCE_BLOCK.replace(old,new),'mcl-portal-42-1',allow_migration_maintenance=True)
        with self.assertRaises(ReleaseError):
            rewrite_portal(MIGRATION_MAINTENANCE_BLOCK+b'\n'+MIGRATION_MAINTENANCE_BLOCK,'mcl-portal-42-1',allow_migration_maintenance=True)
        with self.assertRaises(ReleaseError):
            rewrite_portal(MIGRATION_MAINTENANCE_BLOCK.replace(b'ciclo.inovaris.online {',b'ciclo.inovaris.online other.invalid {'),'mcl-portal-42-1',allow_migration_maintenance=True)
    def test_migration_option_cannot_be_truthy_string(self):
        with self.assertRaises(ReleaseError):
            rewrite_portal(MIGRATION_MAINTENANCE_BLOCK,'mcl-portal-42-1',allow_migration_maintenance='false')
    def test_migration_requires_four_nonplaceholder_human_fields(self):
        raw='MCL_SESSION_SECRET='+'a'*64+'\nMCL_CORE_CODES_SHA256='+'b'*64+'\nMCL_KIT_CODES_SHA256='+'c'*64+'\nNEXT_PUBLIC_SITE_URL=https://ciclo.inovaris.online\n'
        legal={'MCL_SUPPORT_EMAIL':'support@example.invalid','MCL_PRIVACY_NAME':'Synthetic fixture',
               'MCL_PRIVACY_ADDRESS':'Synthetic fixture address','MCL_PRIVACY_EMAIL':'privacy@example.invalid'}
        complete=raw+''.join(k+'='+v+'\n' for k,v in legal.items())
        self.assertIn('MCL_PRIVACY_ADDRESS=Synthetic fixture address',portal_env(complete,'d'*40,require_legal_fields=True))
        for key in legal:
            for invalid in ('','   ','TODO','PENDING','<required>'):
                with self.subTest(key=key,invalid=invalid):
                    with self.assertRaises(ReleaseError):
                        portal_env(complete.replace(key+'='+legal[key],key+'='+invalid),'d'*40,require_legal_fields=True)
        with self.assertRaises(ReleaseError):portal_env(raw,'d'*40,require_legal_fields=True)
    def test_failed_migration_reload_restores_exact_maintenance_and_inode(self):
        sys.path.insert(0,str(Path(__file__).parent))
        from test_identity_proxy import FakeCaddy,config
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'Caddyfile';original=b'other.invalid {\n respond 200\n}\n'+MIGRATION_MAINTENANCE_BLOCK+b'\n';source.write_bytes(original)
            inode=source.stat().st_ino;ops=FakeCaddy(source)
            def failed_first(count):
                if count==1:raise RuntimeError('reload failed')
                ops.current=config(source.read_bytes())
            ops.on_reload=failed_first
            with self.assertRaises(proxy.ProxyError):
                proxy.update_proxy(source,ops,Path(folder)/'backup',lambda data:rewrite_portal(data,'mcl-portal-42-1',allow_migration_maintenance=True))
            self.assertEqual(source.read_bytes(),original);self.assertEqual(source.stat().st_ino,inode)
            self.assertEqual(ops.active(),config(original))
    def test_existing_site_bytes_preserved_and_owned_replacement(self):
        source=b'other.invalid {\n respond "braces { quoted }"\n}\n\ncommerce-os.inovaris.online {\n respond "same"\n}\n'
        first=rewrite_portal(source,'mcl-portal-42-1')
        self.assertTrue(first.startswith(source))
        self.assertEqual(first.count(b'ciclo.inovaris.online {'),1)
        self.assertIn(b'header_up X-Forwarded-For {remote_host}',first)
        second=rewrite_portal(first,'mcl-portal-43-1')
        self.assertTrue(second.startswith(source))
        self.assertNotIn(b'mcl-portal-42-1',second)
        self.assertEqual(rewrite_portal(second,'mcl-portal-43-1'),second)
    def test_unknown_existing_site_multi_host_and_import_refused(self):
        for source in [b'ciclo.inovaris.online {\n reverse_proxy unrelated:3000\n}\n',b'ciclo.inovaris.online other.invalid {\n respond 200\n}\n',b'import other.conf\n']:
            with self.assertRaises((ReleaseError,proxy.ProxyError)):rewrite_portal(source,'mcl-portal-42-1')
        with self.assertRaises(ReleaseError):rewrite_portal(b'', 'injected;command')
    def test_private_environment_origin_scopes_no_unknown_integration(self):
        raw='MCL_SESSION_SECRET='+'a'*64+'\nMCL_CORE_CODES_SHA256='+'b'*64+'\nMCL_KIT_CODES_SHA256='+'c'*64+'\nNEXT_PUBLIC_SITE_URL=https://ciclo.inovaris.online\n'
        result=portal_env(raw,'d'*40)
        self.assertIn('MCL_ACCESS_DB=/data/access-attempts.sqlite',result)
        self.assertIn('MCL_RELEASE_SHA='+'d'*40,result)
        for invalid in [raw+'SALES_API_KEY=dummy\n',raw.replace('https://ciclo.inovaris.online','https://other.invalid'),raw.replace('c'*64,'b'*64),raw+'MCL_SESSION_SECRET='+'e'*64+'\n']:
            with self.assertRaises(ReleaseError):portal_env(invalid,'d'*40)
    def test_guarded_proxy_reload_failure_restores_all_bytes(self):
        # Reuse the behavioral proxy double; same rollback contract as Commerce headers.
        sys.path.insert(0,str(Path(__file__).parent))
        from test_identity_proxy import FakeCaddy,config
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'Caddyfile';original=b'other.invalid {\n respond 200\n}\n';source.write_bytes(original)
            ops=FakeCaddy(source)
            def failed_first(count):
                if count==1:raise RuntimeError('reload failed')
                ops.current=config(source.read_bytes())
            ops.on_reload=failed_first
            with self.assertRaises(proxy.ProxyError):proxy.update_proxy(source,ops,Path(folder)/'backup',lambda data:rewrite_portal(data,'mcl-portal-42-1'))
            self.assertEqual(source.read_bytes(),original)
            self.assertEqual(ops.active(),config(original))

class PortalRollbackTests(unittest.TestCase):
    def fixture(self,folder):
        sys.path.insert(0,str(Path(__file__).parent))
        from test_identity_proxy import FakeCaddy
        base=Path(folder)/'mcl-portal';base.mkdir()
        source=Path(folder)/'Caddyfile';original=b'other.invalid {\n respond 200\n}\n';source.write_bytes(original)
        operations=FakeCaddy(source)
        receipt=portal_install.proxy.update_proxy(source,operations,base/'caddy-backups',
                                                  lambda value:rewrite_portal(value,'mcl-portal-42-2'))
        previous=json.dumps({'container':'mcl-portal-42-1','status':'ORIGIN_READY'},sort_keys=True).encode()
        candidate=json.dumps({'container':'mcl-portal-42-2','status':'ORIGIN_READY'},sort_keys=True).encode()
        (base/'current.json').write_bytes(candidate)
        return base,source,original,operations,receipt,previous,candidate

    def test_post_switch_failure_restores_proxy_state_and_container(self):
        with tempfile.TemporaryDirectory() as folder:
            base,source,original,operations,receipt,previous,candidate=self.fixture(folder)
            runner=MagicMock(return_value=SimpleNamespace(returncode=0))
            with patch.object(portal_install,'BASE',base):
                result=portal_install.rollback_portal(
                    'mcl-portal-42-2',{'container':'mcl-portal-42-1'},previous,candidate,True,
                    source,operations,receipt,True,runner)
            self.assertEqual(result['status'],'SUCCEEDED')
            self.assertEqual(result['proxy']['status'],'RESTORED')
            self.assertTrue(result['current_restored']);self.assertTrue(result['candidate_stopped'])
            self.assertFalse(result['database_restored'])
            self.assertEqual(source.read_bytes(),original)
            self.assertEqual((base/'current.json').read_bytes(),previous)
            self.assertEqual([call.args[0] for call in runner.call_args_list],
                             [['docker','start','mcl-portal-42-1'],['docker','stop','mcl-portal-42-2']])

    def test_concurrent_proxy_change_fails_closed_and_keeps_candidate_live(self):
        with tempfile.TemporaryDirectory() as folder:
            base,source,_original,operations,receipt,previous,candidate=self.fixture(folder)
            external=source.read_bytes()+b'# another operator\n';source.write_bytes(external)
            operations.current={'configuration':external.decode()}
            runner=MagicMock(return_value=SimpleNamespace(returncode=0))
            with patch.object(portal_install,'BASE',base):
                result=portal_install.rollback_portal(
                    'mcl-portal-42-2',{'container':'mcl-portal-42-1'},previous,candidate,True,
                    source,operations,receipt,False,runner)
            self.assertEqual(result['status'],'FAILED')
            self.assertEqual(result['proxy']['error'],'ROLLBACK_SOURCE_CHANGED')
            self.assertFalse(result['candidate_stopped'])
            self.assertEqual(source.read_bytes(),external)
            self.assertEqual((base/'current.json').read_bytes(),candidate)
            runner.assert_not_called()
            self.assertNotIn('another operator',json.dumps(result))

    def test_unexpected_rollback_error_is_sanitized_and_cannot_replace_original(self):
        with patch.object(portal_install,'rollback_portal',
                          side_effect=RuntimeError('private token=do-not-report')):
            rollback=portal_install.attempt_portal_rollback('unused')
        error=portal_install.PortalInstallError('PORTAL_HEALTH_FAILED',rollback)
        self.assertEqual(str(error),'PORTAL_HEALTH_FAILED')
        self.assertTrue(error.rollback_failed)
        self.assertEqual(rollback['status'],'FAILED')
        self.assertEqual(rollback['error'],'PORTAL_ROLLBACK_FAILED')
        self.assertFalse(rollback['database_restored'])
        self.assertNotIn('private',json.dumps(rollback))
        self.assertNotIn('token',json.dumps(rollback))

if __name__=='__main__':unittest.main()
