import base64
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'scripts'))
import v5_token_escrow as escrow
from ci_release import ReleaseError

class CredentialEscrowTests(unittest.TestCase):
    def env(self, directory):
        return {'GITHUB_REPOSITORY': escrow.transport.REPO, 'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_WORKFLOW_REF': escrow.transport.REPO+'/.github/workflows/ci.yml@refs/heads/main', 'V5_MODE': 'credential', 'V5_EXPECTED_SHA': 'b'*40, 'GITHUB_SHA': 'b'*40, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '2', 'RUNNER_TEMP': directory}
    def envelope(self, directory):
        folder = Path(directory)/'v5-encrypted-receipt'; folder.mkdir()
        body = {'schema_version': 1, 'algorithm': 'RSA-OAEP-SHA256+A256GCM', 'recipient_sha256': 'a'*64, **{key: base64.b64encode(bytes(count)).decode() for key, count in [('encrypted_key', 512), ('nonce', 12), ('tag', 16), ('ciphertext', 250)]}}
        path = folder/'envelope.json'; path.write_text(json.dumps(body)+'\n'); return path
    def fake_transport(self, tamper=False):
        state = {'release': None, 'files': {}, 'uploads': 0, 'downloads': 0, 'private': True}
        def gh(*args, data=None, raw=False):
            if args == ('api', 'repos/'+escrow.transport.REPO): return {'private': state['private']}
            if args == ('api', 'repos/'+escrow.transport.REPO+'/releases?per_page=1'): return []
            if args[:3] == ('api', '--paginate', '--slurp'): return [[copy.deepcopy(state['release'])] if state['release'] else []]
            if data is not None:
                self.assertIsNone(state['release']); self.assertTrue(data['draft']); self.assertEqual(data['tag_name'], 'v5-credential-123-2')
                state['release'] = {**data, 'id': 456, 'assets': []}; return copy.deepcopy(state['release'])
            if args[:2] == ('release', 'upload'):
                self.assertNotIn('--clobber', args); path = Path(args[3]); self.assertNotIn(path.name, state['files'])
                state['files'][path.name] = path.read_bytes(); state['uploads'] += 1
                state['release']['assets'].append({'name': path.name, 'state': 'uploaded'}); return ''
            if args == ('api', 'repos/'+escrow.transport.REPO+'/releases/456'): return copy.deepcopy(state['release'])
            if args[:2] == ('release', 'download'):
                name = args[args.index('--pattern')+1]; folder = Path(args[args.index('--dir')+1]); state['downloads'] += 1
                (folder/name).write_bytes(b'tampered' if tamper else state['files'][name]); return ''
            raise AssertionError('Unexpected transport operation: '+str(args))
        return state, gh
    def test_store_downloads_exact_ciphertext_and_hash_then_replay_does_not_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.envelope(directory); state, gh = self.fake_transport(); output = io.StringIO()
            with patch.dict(os.environ, self.env(directory), clear=True), patch.object(escrow.transport, 'gh', side_effect=gh), redirect_stdout(output):
                escrow.store(); escrow.store()
            self.assertEqual(set(state['files']), escrow.FILES); self.assertEqual(state['files']['envelope.json'], path.read_bytes())
            self.assertEqual(state['uploads'], 2); self.assertEqual(state['downloads'], 6)
            self.assertNotIn('encrypted_key', output.getvalue()); self.assertNotIn('ciphertext"', output.getvalue())
            self.assertTrue(all(row['raw_token_exported'] is False for row in map(json.loads, output.getvalue().splitlines())))
    def test_tampered_download_is_failure_with_no_delete_or_clobber(self):
        with tempfile.TemporaryDirectory() as directory:
            self.envelope(directory); state, gh = self.fake_transport(tamper=True)
            with patch.dict(os.environ, self.env(directory), clear=True), patch.object(escrow.transport, 'gh', side_effect=gh):
                with self.assertRaisesRegex(ReleaseError, 'STORED_CREDENTIAL_CIPHERTEXT_DIFFERS'): escrow.store()
            self.assertEqual(state['uploads'], 2)
    def test_replay_with_different_ciphertext_keeps_existing_draft_immutable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.envelope(directory); state, gh = self.fake_transport()
            with patch.dict(os.environ, self.env(directory), clear=True), patch.object(escrow.transport, 'gh', side_effect=gh), redirect_stdout(io.StringIO()):
                escrow.store(); value = json.loads(path.read_text()); value['ciphertext'] = base64.b64encode(b'x'*250).decode(); path.write_text(json.dumps(value))
                with self.assertRaisesRegex(ReleaseError, 'EXISTING_CREDENTIAL_CIPHERTEXT_DIFFERS'): escrow.store()
            self.assertEqual(state['uploads'], 2)
    def test_plaintext_extra_fields_and_symlinks_never_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.envelope(directory); good = path.read_text(); state, gh = self.fake_transport()
            with patch.dict(os.environ, self.env(directory), clear=True), patch.object(escrow.transport, 'gh', side_effect=gh):
                for value in [{'token': 'synthetic-secret'}, {**json.loads(good), 'token': 'synthetic-secret'}, {**json.loads(good), 'nonce': 'raw-token'}]:
                    path.write_text(json.dumps(value))
                    with self.assertRaises((ReleaseError, ValueError)): escrow.store()
                path.unlink(); path.symlink_to(Path(directory)/'missing')
                with self.assertRaises(ReleaseError): escrow.store()
            self.assertIsNone(state['release']); self.assertEqual(state['uploads'], 0)
    def test_public_repository_wrong_workflow_and_wrong_sha_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            state, gh = self.fake_transport(); state['private'] = False
            with patch.dict(os.environ, self.env(directory), clear=True), patch.object(escrow.transport, 'gh', side_effect=gh):
                with self.assertRaisesRegex(ReleaseError, 'PRIVATE_REPOSITORY_REQUIRED'): escrow.preflight()
            for key, value in [('V5_MODE', 'release'), ('GITHUB_EVENT_NAME', 'push'), ('GITHUB_WORKFLOW_REF', 'other'), ('V5_EXPECTED_SHA', 'c'*40)]:
                with self.subTest(key=key), patch.dict(os.environ, {**self.env(directory), key: value}, clear=True):
                    with self.assertRaises(ReleaseError): escrow.identity()
    def test_draft_identity_extra_assets_and_duplicate_assets_rejected(self):
        expected = {'source_sha': 'b'*40}; release = {'draft': True, 'target_commitish': 'b'*40, 'tag_name': 'v5-credential-123-2', 'assets': []}
        for change in [{'draft': False}, {'target_commitish': 'c'*40}, {'assets': [{'name': 'service-token'}]}, {'assets': [{'name': 'envelope.json'}]*2}]:
            with self.subTest(change=change), self.assertRaises(ReleaseError): escrow.validate_release({**release, **change}, expected, 'v5-credential-123-2')

if __name__ == '__main__': unittest.main()
