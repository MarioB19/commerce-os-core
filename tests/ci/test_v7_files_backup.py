import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import v7_files_backup as m  # noqa: E402

NOW = datetime(2026, 10, 13, 9, tzinfo=timezone.utc)


class FakeStorage:
    def __init__(self):
        self.objects, self.calls = {}, []

    def list(self, prefix):
        return {k: {'size': len(v['data']), 'metadata': dict(v['metadata'])} for k, v in self.objects.items() if k.startswith(prefix + '/')}

    def upload(self, name, data, digest):
        self.calls.append(('upload', name)); self.objects[name] = {'data': data, 'metadata': {'sha256': digest}}

    def mark(self, name, metadata):
        self.calls.append(('mark', name)); self.objects[name]['metadata'] = metadata

    def delete(self, name):
        self.calls.append(('delete', name)); del self.objects[name]

    def download(self, name):
        return self.objects[name]['data']


class FilesBackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); root = Path(self.tmp.name)
        self.assets = root / 'private'; (self.assets / 'assets').mkdir(parents=True); (self.assets / 'uploads' / 'x').mkdir(parents=True)
        (self.assets / 'assets' / 'a.enc').write_bytes(b'sealed-a'); (self.assets / 'assets' / 'b.enc').write_bytes(b'sealed-b')
        (self.assets / 'uploads' / 'x' / 'part').write_bytes(b'partial upload')
        self.config = {'assets_dir': str(self.assets), 'bucket': 'commerce-v7-pitr-1', 'prefix': 'private-assets', 'grace_days': 35, 'receipt': str(root / 'r' / 'last.json')}

    def tearDown(self):
        self.tmp.cleanup()

    def test_uploads_new_files_once_and_skips_partial_uploads(self):
        s = FakeStorage()
        self.assertEqual(m.sync(self.config, s, NOW)['uploaded'], 2)
        self.assertEqual(sorted(s.objects), ['private-assets/assets/a.enc', 'private-assets/assets/b.enc'])
        self.assertEqual(s.objects['private-assets/assets/a.enc']['metadata']['sha256'], sha256(b'sealed-a').hexdigest())
        again = m.sync(self.config, s, NOW)
        self.assertEqual((again['uploaded'], again['unchanged']), (0, 2))

    def test_a_removed_file_leaves_the_copy_after_the_grace_period(self):
        s = FakeStorage(); m.sync(self.config, s, NOW)
        (self.assets / 'assets' / 'b.enc').unlink()
        self.assertEqual(m.sync(self.config, s, NOW)['marked_missing'], 1)
        self.assertEqual(m.sync(self.config, s, NOW + timedelta(days=10))['deleted_after_grace'], 0)
        self.assertEqual(m.sync(self.config, s, NOW + timedelta(days=36))['deleted_after_grace'], 1)
        self.assertNotIn('private-assets/assets/b.enc', s.objects)

    def test_restore_rebuilds_the_folder_into_an_empty_directory_with_integrity(self):
        s = FakeStorage(); m.sync(self.config, s, NOW)
        with tempfile.TemporaryDirectory() as target:
            self.assertEqual(m.restore(self.config, target, s), {'state': 'FILES_RESTORED', 'files': 2})
            self.assertEqual((Path(target) / 'assets' / 'a.enc').read_bytes(), b'sealed-a')
            with self.assertRaises(m.BackupError):
                m.restore(self.config, target, s)
        s.objects['private-assets/assets/a.enc']['data'] = b'tampered'
        with tempfile.TemporaryDirectory() as target, self.assertRaises(m.BackupError):
            m.restore(self.config, target, s)

    def test_config_is_closed(self):
        p = Path(self.tmp.name) / 'c.json'
        for change in ({'bucket': 'Bad Bucket'}, {'grace_days': 1}, {'assets_dir': 'relative'}, {'x': 1}):
            p.write_text(json.dumps({**self.config, **change}))
            with self.assertRaises(m.BackupError):
                m.load_config(str(p))


if __name__ == '__main__':
    unittest.main()
