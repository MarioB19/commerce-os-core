import hashlib
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import api_web_deployment as guards
import copy_portal_deployment as portal
from ci_release import ReleaseError
from deployment_scope import NO_PORTAL
import test_api_web_deployment as api_fixture


class PortalInputPromotionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name).resolve()
        self.home=self.base/'oslogin-home';self.home.mkdir(mode=0o700)
        self.stage=self.home/'commerce-ci-9-1';self.stage.mkdir(mode=0o700)
        self.private=self.base/'root-private';self.private.mkdir(mode=0o700)
        self.source=self.stage/'mcl-portal.env'
        self.raw=('MCL_SESSION_SECRET='+'1'*64+'\nMCL_CORE_CODES_SHA256='+'2'*64+
                  '\nMCL_KIT_CODES_SHA256='+'3'*64+'\nNEXT_PUBLIC_SITE_URL=https://ciclo.inovaris.online\n').encode()
        self.source.write_bytes(self.raw);self.source.chmod(0o600)
        profile=self.private/'release.env';profile.write_bytes(b'FIXTURE=private\n');profile.chmod(0o600)
        self.expected=hashlib.sha256(self.raw).hexdigest()
        lstat=Path.lstat;fstat=os.fstat
        def metadata(info,uid=0,mode=None):
            return SimpleNamespace(**{name:(uid if name=='st_uid' else mode if name=='st_mode' and mode is not None else getattr(info,name))
                for name in ('st_uid','st_gid','st_mode','st_nlink','st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns')})
        # Simulate POSIX server ownership only. Bytes, modes, links, inodes,
        # bounds, FD reads/writes and cleanup use the real temporary filesystem.
        def simulated_lstat(path,*args,**kwargs):
            info=lstat(path,*args,**kwargs)
            mode=info.st_mode if path.is_relative_to(self.base) else info.st_mode&~0o022
            return metadata(info,1001 if path==self.home else 0,mode)
        for mock in (patch.object(Path,'lstat',simulated_lstat),
                     patch.object(os,'fstat',side_effect=lambda fd:metadata(fstat(fd))),
                     patch.object(os,'geteuid',return_value=0),
                     patch.object(portal,'__file__',str(self.stage/'copy_portal_deployment.py'))):
            mock.start();self.addCleanup(mock.stop)

    def promote(self,expected=None,run_id='9-1'):
        return portal.promote_private_input(self.private,self.source,expected or self.expected,'a'*40,run_id)

    def test_user_home_is_rejected_but_sealed_input_promotes_to_unchanged_root_guard(self):
        with self.assertRaisesRegex(ReleaseError,'COPY_PRIVATE_PARENT_UNSAFE'):
            guards.protected_bytes(self.source)
        with self.promote() as target:
            self.assertTrue(target.is_relative_to(self.private))
            self.assertEqual(guards.protected_bytes(target),self.raw)
            self.assertEqual(target.stat().st_mode&0o777,0o600)
            directory=target.parent
        self.assertFalse(directory.exists())
        self.assertEqual(self.source.read_bytes(),self.raw)
        self.assertEqual(sorted(p.name for p in self.private.iterdir()),['release.env'])

    def test_wrong_hash_run_or_environment_never_creates_promoted_input(self):
        for failure in ('hash','run','env'):
            self.source.write_bytes(b'INVALID=fixture\n' if failure=='env' else self.raw)
            expected=hashlib.sha256(self.source.read_bytes()).hexdigest() if failure=='env' else 'b'*64 if failure=='hash' else self.expected
            with self.subTest(failure=failure),self.assertRaises(ReleaseError):
                with self.promote(expected,run_id='10-1' if failure=='run' else '9-1'):self.fail('yielded unsafe input')
            self.assertEqual(sorted(p.name for p in self.private.iterdir()),['release.env'])

    def test_symlink_hardlink_public_mode_or_oversized_input_is_rejected(self):
        for failure in ('symlink','hardlink','mode','bound'):
            self.source.unlink();self.source.write_bytes(self.raw);self.source.chmod(0o600)
            link=self.stage/'fixture-link';link.unlink(missing_ok=True)
            if failure=='symlink':self.source.unlink();self.source.symlink_to(self.private/'release.env')
            if failure=='hardlink':os.link(self.source,link)
            if failure=='mode':self.source.chmod(0o644)
            if failure=='bound':self.source.write_bytes(b'x'*(guards.MAX_PRIVATE+1))
            with self.subTest(failure=failure),self.assertRaises((ReleaseError,OSError)):
                with self.promote():self.fail('yielded unsafe input')
            self.assertEqual(sorted(p.name for p in self.private.iterdir()),['release.env'])

    def test_valid_promotion_is_cleaned_after_publication_error(self):
        with self.assertRaisesRegex(RuntimeError,'fixture-publication-failed'):
            with self.promote() as target:
                directory=target.parent
                raise RuntimeError('fixture-publication-failed')
        self.assertFalse(directory.exists());self.assertEqual(self.source.read_bytes(),self.raw)

    def test_changed_own_input_is_preserved_and_cleanup_is_not_claimed(self):
        with self.assertRaisesRegex(ReleaseError,'COPY_PORTAL_INPUT_CLEANUP_CHANGED'):
            with self.promote() as target:target.write_bytes(b'changed-by-fixture')
        self.assertTrue(target.exists());self.assertEqual(target.read_bytes(),b'changed-by-fixture')
        self.assertEqual(self.source.read_bytes(),self.raw)

    def test_entrypoint_requires_input_digest_before_application_mutation(self):
        vps=api_fixture.vps
        args=['deploy','/sealed/archive','a'*64,'a'*40,'9-1',str(self.source),'portal-copy']
        with patch.object(sys,'argv',args),patch.object(vps.os,'umask'),patch.object(vps,'publish_api_web') as publisher:
            with self.assertRaisesRegex(ReleaseError,'COPY_PORTAL_INPUT_DIGEST_REQUIRED'):vps.main()
            publisher.assert_not_called()

    def test_entrypoint_promotes_before_api_web_and_reuses_input_for_portal_then_cleans(self):
        vps=api_fixture.vps
        (self.base/'current').symlink_to(self.stage)
        args=['deploy','/sealed/archive','a'*64,'a'*40,'9-1',str(self.source),'portal-copy',self.expected]
        calls=[]
        def api(*values):
            calls.append('api-web');self.assertEqual(values[-1],NO_PORTAL)
            self.assertEqual(len(list(self.private.glob('portal-input-9-1-*'))),1)
        def install(*values,**options):
            calls.append('portal');self.assertEqual(guards.protected_bytes(Path(values[-1])),self.raw)
            self.assertTrue(options['continue_api_web']);return 'fixture-success'
        with patch.dict(sys.modules,{vps.__name__:vps}),patch.object(sys,'argv',args),patch.object(vps.os,'umask'),patch.object(vps,'BASE',self.base),\
             patch.object(vps,'PRIVATE',self.private),patch.object(guards,'load_state',return_value=({'schema_version':1},b'fixture')),\
             patch.object(vps,'publish_api_web',side_effect=api),patch.object(portal,'publish',side_effect=install):
            self.assertEqual(vps.main(),'fixture-success')
        self.assertEqual(calls,['api-web','portal']);self.assertEqual(list(self.private.glob('portal-input-9-1-*')),[])


if __name__=='__main__':unittest.main()
