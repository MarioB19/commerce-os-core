import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from ci_release import ReleaseError

def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

generator=module('public_fixture_generator',ROOT/'scripts/generate-public-portal-fixtures.py')
installer=module('public_fixture_installer',ROOT/'scripts/install-mcl-portal.py')

class PublicPortalProfile(unittest.TestCase):
    def test_synthetic_catalog_and_pdf_bytes_are_deterministic_and_sealed(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(generator,'ROOT',Path(temp)):
            generator.generate()
            root=Path(temp);before={str(p.relative_to(root)):p.read_bytes() for p in root.rglob('*') if p.is_file()}
            generator.generate();after={str(p.relative_to(root)):p.read_bytes() for p in root.rglob('*') if p.is_file()}
            self.assertEqual(before,after)
            profile=json.loads(before['PUBLIC_FIXTURE_PROFILE.json'])
            self.assertEqual(profile['production_portal_installation'],'FORBIDDEN')
            for name,digest in profile['files'].items():self.assertEqual(hashlib.sha256(before[name]).hexdigest(),digest)
            catalog=json.loads(before['data/activities.json'])
            self.assertEqual(len(catalog),480);self.assertEqual(len({x['grado'] for x in catalog}),9)
            self.assertTrue(all(x['id'].startswith('synthetic-') for x in catalog))
            self.assertEqual(len([p for p in before if p.endswith('.pdf')]),10)
            for path,data in before.items():
                if path.endswith('.pdf'):self.assertTrue(data.startswith(b'%PDF-'));self.assertIn(b'SYNTHETIC PUBLIC TEST FIXTURE',data)

    def test_fixture_marker_or_symlink_stops_installer_before_private_read_or_command(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(installer.os,'geteuid',return_value=0),patch.object(installer,'run') as command,patch.object(Path,'read_text') as reader:
            marker=Path(temp)/'portals/mi-ciclo-listo/PUBLIC_FIXTURE_PROFILE.json';marker.parent.mkdir(parents=True);marker.write_bytes(b'{}')
            for kind in ('file','dangling-symlink'):
                if kind=='dangling-symlink':marker.unlink();marker.symlink_to('missing')
                with self.assertRaisesRegex(ReleaseError,'SYNTHETIC_PORTAL_PUBLICATION_FORBIDDEN'):
                    installer.install(temp,'private-input','a'*40,'1-1')
            reader.assert_not_called();command.assert_not_called()

    def test_image_label_still_rejects_fixture_when_marker_is_removed(self):
        with tempfile.TemporaryDirectory() as temp:
            for profile in ['synthetic-public-v1','other-unrecognized-profile']:
                with self.assertRaisesRegex(ReleaseError,'SYNTHETIC_PORTAL_IMAGE_FORBIDDEN'):
                    installer.require_production_portal(temp,{'Config':{'Labels':{'org.commerce-os.content-profile':profile}}})
            installer.require_production_portal(temp,{'Config':{'Labels':{}}})

if __name__=='__main__':unittest.main()
