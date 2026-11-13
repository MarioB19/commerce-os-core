"""V7.5.2 L01: copy-runtime prepares the shared lock of each private namespace
before any reader starts. Real files, real modes, real owners; no mocks of os."""
import os
import stat
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'scripts'))
import copy_runtime_deployment as c
from ci_release import ReleaseError

LOCK = '.private-namespace.lock'


def private_dir(path):
    path.mkdir(mode=0o700)
    os.chmod(path, 0o700)
    return path


class NamespaceLock(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.assets = private_dir(self.root/'assets')
        self.owner = self.assets.lstat()

    def tearDown(self):
        self.tmp.cleanup()

    def lock(self, directory=None):
        return (directory or self.assets)/LOCK

    def test_absent_lock_is_created_empty_0600_and_owned_like_the_directory(self):
        self.assertEqual(c.ensure_namespace_lock(self.assets, self.owner), 'CREATED')
        info = self.lock().lstat()
        self.assertTrue(stat.S_ISREG(info.st_mode))
        self.assertEqual((stat.S_IMODE(info.st_mode), info.st_size, info.st_nlink, info.st_uid, info.st_gid),
                         (0o600, 0, 1, self.owner.st_uid, self.owner.st_gid))

    def test_existing_lock_is_verified_without_rewrite(self):
        c.ensure_namespace_lock(self.assets, self.owner)
        before = self.lock().lstat()
        self.assertEqual(c.ensure_namespace_lock(self.assets, self.owner), 'VERIFIED')
        after = self.lock().lstat()
        self.assertEqual((after.st_ino, after.st_mtime_ns, after.st_ctime_ns, after.st_size),
                         (before.st_ino, before.st_mtime_ns, before.st_ctime_ns, before.st_size))

    def test_unsafe_existing_locks_stop_the_publication_and_stay_untouched(self):
        cases = {}
        outside = self.root/'outside'; outside.write_text('preserve'); os.chmod(outside, 0o600)
        cases['symlink'] = lambda p: os.symlink(outside, p)
        cases['content'] = lambda p: (p.write_text('preserve'), os.chmod(p, 0o600))
        cases['mode'] = lambda p: (p.write_text(''), os.chmod(p, 0o644))
        cases['hardlink'] = lambda p: (p.write_text(''), os.chmod(p, 0o600), os.link(p, p.parent/'second'))
        cases['directory'] = lambda p: p.mkdir(mode=0o700)
        for name, make in cases.items():
            with self.subTest(name=name):
                directory = private_dir(self.root/('ns-'+name))
                path = directory/LOCK; make(path)
                before = os.lstat(path)
                with self.assertRaisesRegex(ReleaseError, 'PRIVATE_NAMESPACE_LOCK_UNSAFE'):
                    c.ensure_namespace_lock(directory, directory.lstat())
                after = os.lstat(path)
                self.assertEqual((after.st_ino, after.st_mode, after.st_size, after.st_mtime_ns),
                                 (before.st_ino, before.st_mode, before.st_size, before.st_mtime_ns))
        self.assertEqual(outside.read_text(), 'preserve')

    def test_root_must_be_the_owned_directory_and_not_a_link(self):
        link = self.root/'link'; os.symlink(self.assets, link)
        with self.assertRaises((OSError, ReleaseError)):
            c.ensure_namespace_lock(link, self.owner)
        self.assertFalse(self.lock().exists())

    @unittest.skipUnless(hasattr(os, 'geteuid') and os.geteuid() == 0, 'root creates for another owner')
    def test_root_creates_the_lock_directly_with_the_unprivileged_owner(self):
        os.chown(self.assets, 1000, 1000)
        # Like production: an intermediate root-only directory the owner cannot traverse.
        os.chmod(self.root, 0o700)
        owner = self.assets.lstat()
        self.assertEqual(c.ensure_namespace_lock(self.assets, owner), 'CREATED')
        info = self.lock().lstat()
        self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), info.st_size), (1000, 1000, 0o600, 0))
        self.assertEqual(c.ensure_namespace_lock(self.assets, owner), 'VERIFIED')
        os.chown(self.lock(), 0, 0)
        with self.assertRaisesRegex(ReleaseError, 'PRIVATE_NAMESPACE_LOCK_UNSAFE'):
            c.ensure_namespace_lock(self.assets, owner)

    def test_lab_storage_prepares_both_namespaces_for_install_and_update(self):
        (self.root/'release.env').write_text('COMMERCE_PRIVATE_ASSETS_DIR='+str(self.assets)+'\n')
        server = types.SimpleNamespace(PRIVATE=self.root)
        with patch.object(c.native, 'protected_bytes', side_effect=lambda path: Path(path).read_bytes()):
            first = c.ensure_lab_storage(server)
            # An update with no pending migration meets the locks it left and keeps them.
            second = c.ensure_lab_storage(server)
        self.assertEqual(first, {'path': str(self.assets/'number-lab'), 'namespace_locks': {'source': 'CREATED', 'laboratory': 'CREATED'}})
        self.assertEqual(second['namespace_locks'], {'source': 'VERIFIED', 'laboratory': 'VERIFIED'})
        for directory in (self.assets, self.assets/'number-lab'):
            info = (directory/LOCK).lstat()
            self.assertEqual((stat.S_IMODE(info.st_mode), info.st_size), (0o600, 0))


if __name__ == '__main__':
    unittest.main()
