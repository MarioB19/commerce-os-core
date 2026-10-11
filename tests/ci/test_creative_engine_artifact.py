import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('creative_artifact', Path(__file__).resolve().parents[2] / 'scripts' / 'creative-engine-artifact-select.py')
artifact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifact)


class RangeResponse(io.BytesIO):
    status = 206

    def __init__(self, data, start, end):
        super().__init__(data[start:end + 1])
        self.headers = {'Content-Range': f'bytes {start}-{end}/{len(data)}'}


class ArtifactSelectionTests(unittest.TestCase):
    def archive(self, unsafe=False):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_STORED) as archive:
            archive.writestr('../manifest.json' if unsafe else 'output/product/manifest.json', '{"fixture":true}')
            archive.writestr('output/native-pilot-results.json', '[]')
            archive.writestr('output/product/master.mp4', bytes(range(256)) * 4096)
        return buffer.getvalue()

    def execute(self, root, media=False, unsafe=False):
        data = self.archive(unsafe)
        requested = []

        def read_range(request, **_kwargs):
            value = request.headers['Range'].removeprefix('bytes=')
            start, end = map(int, value.split('-'))
            requested.append((start, end))
            return RangeResponse(data, start, end)

        metadata = {'id': 123, 'name': 'native-pilot-fixture', 'digest': 'sha256:' + hashlib.sha256(data).hexdigest()}
        with patch.object(artifact, 'artifact_location', return_value=(metadata, 'https://fixture.example/archive')), patch.object(artifact.urllib.request, 'urlopen', side_effect=read_range):
            result = artifact.select('private/repository', 123, root, media)
        return result, requested

    def test_metadata_only_never_fetches_or_materializes_the_video_payload(self):
        with tempfile.TemporaryDirectory() as root:
            result, ranges = self.execute(root)
            self.assertEqual(result['selected_files'], 2)
            self.assertLess(sum(end - start + 1 for start, end in ranges), 4096)
            self.assertFalse(list(Path(root).rglob('*.mp4')))
            saved = json.loads((Path(root) / 'metadata-selection.json').read_text())
            self.assertFalse(saved['archive_digest_independently_verified'])
            self.assertEqual(saved['selected'][0]['sha256'], hashlib.sha256(b'{"fixture":true}').hexdigest())

    def test_media_phase_checks_and_records_the_selected_actual_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            result, _ = self.execute(root, media=True)
            self.assertEqual(result['selected_files'], 3)
            self.assertEqual((Path(root) / 'output/product/master.mp4').read_bytes(), bytes(range(256)) * 4096)

    def test_rejects_selected_archive_paths_that_escape_the_private_directory(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(artifact.SelectionError, 'ARTIFACT_ENTRY_UNSAFE'):
                self.execute(root, unsafe=True)


if __name__ == '__main__':
    unittest.main()
