#!/usr/bin/env python3
"""Escrow only an encrypted V5 receipt in the existing private draft transport."""
import base64
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from ci_release import digest, require
import ci_private_artifact as transport

FILES = {'envelope.json', 'envelope.json.sha256'}

def identity():
    require(os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and os.environ.get('V5_MODE') == 'credential', 'CREDENTIAL_MANUAL_MODE_REQUIRED')
    require(os.environ.get('GITHUB_WORKFLOW_REF') == transport.REPO+'/.github/workflows/ci.yml@refs/heads/main', 'EXISTING_CI_TRUST_REQUIRED')
    value = transport.identity('verification')
    require(os.environ.get('V5_EXPECTED_SHA') == value['source_sha'], 'CREDENTIAL_SHA_MISMATCH')
    return {**value, 'kind': 'credential'}

def preflight():
    expected = identity()
    transport.require_private()
    # Reading existing drafts proves the token can reach the private release API.
    transport.gh('api', 'repos/'+transport.REPO+'/releases?per_page=1')
    return expected

def encrypted_file(path):
    require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= 2**20, 'CREDENTIAL_CIPHERTEXT_FILE_REQUIRED')
    value = json.loads(path.read_text())
    require(set(value) == {'schema_version', 'algorithm', 'recipient_sha256', 'encrypted_key', 'nonce', 'tag', 'ciphertext'}, 'CREDENTIAL_ENVELOPE_FIELDS_INVALID')
    require(value['schema_version'] == 1 and value['algorithm'] == 'RSA-OAEP-SHA256+A256GCM' and re.fullmatch('[a-f0-9]{64}', value['recipient_sha256']), 'CREDENTIAL_ENVELOPE_INVALID')
    for key, minimum, maximum in [('encrypted_key', 384, 1024), ('nonce', 12, 12), ('tag', 16, 16), ('ciphertext', 1, 2**20)]:
        require(isinstance(value[key], str), 'CREDENTIAL_CIPHERTEXT_ENCODING_INVALID')
        decoded = base64.b64decode(value[key], validate=True)
        require(minimum <= len(decoded) <= maximum and base64.b64encode(decoded).decode() == value[key], 'CREDENTIAL_CIPHERTEXT_ENCODING_INVALID')

def matching_release(tag):
    # Paginate so retries can find an older draft without creating another one.
    pages = transport.gh('api', '--paginate', '--slurp', 'repos/'+transport.REPO+'/releases?per_page=100')
    matching = [release for page in pages for release in page if release['tag_name'] == tag]
    require(len(matching) <= 1, 'AMBIGUOUS_CREDENTIAL_DRAFT')
    return matching[0] if matching else None

def validate_release(release, expected, tag):
    require(release['draft'] is True and release['target_commitish'] == expected['source_sha'] and release['tag_name'] == tag, 'CREDENTIAL_DRAFT_IDENTITY_MISMATCH')
    names = [asset['name'] for asset in release['assets']]
    require(len(names) == len(set(names)) and set(names) <= FILES, 'CREDENTIAL_DRAFT_UNEXPECTED_FILES')

def store():
    expected = preflight()
    source = Path(os.environ['RUNNER_TEMP'])/'v5-encrypted-receipt'/'envelope.json'
    encrypted_file(source)
    with tempfile.TemporaryDirectory() as temporary:
        folder = Path(temporary)
        envelope = folder/'envelope.json'; envelope.write_bytes(source.read_bytes()); envelope.chmod(0o600)
        checksum = folder/'envelope.json.sha256'; checksum.write_text(digest(envelope)+'  envelope.json\n'); checksum.chmod(0o600)
        paths = [envelope, checksum]
        tag = 'v5-credential-'+expected['run_id']+'-'+expected['attempt']
        release = matching_release(tag)
        if release is None:
            release = transport.gh('api', 'repos/'+transport.REPO+'/releases', '--input', '-', data={
                'tag_name': tag, 'target_commitish': expected['source_sha'], 'name': tag,
                'draft': True, 'prerelease': False, 'make_latest': 'false',
                'body': 'Private encrypted V5 credential receipt. '+json.dumps(expected, sort_keys=True)})
        validate_release(release, expected, tag)
        for path in paths:
            if any(asset['name'] == path.name for asset in release['assets']):
                with tempfile.TemporaryDirectory() as previous:
                    transport.download_asset(release, path.name, Path(previous))
                    require(digest(Path(previous)/path.name) == digest(path), 'EXISTING_CREDENTIAL_CIPHERTEXT_DIFFERS')
            else:
                # An uncertain upload is inspected on retry; never clobber or delete.
                transport.gh('release', 'upload', tag, str(path), '--repo', transport.REPO, raw=True)
        stored = transport.gh('api', 'repos/'+transport.REPO+'/releases/'+str(release['id']))
        validate_release(stored, expected, tag)
        require({asset['name'] for asset in stored['assets']} == FILES, 'CREDENTIAL_DRAFT_INCOMPLETE')
        with tempfile.TemporaryDirectory() as downloaded:
            for path in paths:
                transport.download_asset(stored, path.name, Path(downloaded))
                require(digest(Path(downloaded)/path.name) == digest(path), 'STORED_CREDENTIAL_CIPHERTEXT_DIFFERS')
        output = {'status': 'ENCRYPTED_RECEIPT_ESCROW_VERIFIED', 'source_sha': expected['source_sha'], 'release_id': str(release['id']), 'tag': tag, 'ciphertext_sha256': digest(envelope), 'raw_token_exported': False}
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as target:
                for key in ['release_id', 'tag', 'ciphertext_sha256']: target.write(key+'='+output[key]+'\n')
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as target:
                target.write('Encrypted credential draft `'+tag+'`, release ID `'+output['release_id']+'`, ciphertext SHA256 `'+output['ciphertext_sha256']+'`. Download and SHA256 readback verified; no automatic expiration or deletion.\n')
        print(json.dumps(output))

if __name__ == '__main__':
    os.umask(0o077)
    try:
        require(len(sys.argv) == 2 and sys.argv[1] in ('preflight', 'store'), 'FIXED_ESCROW_ACTION_REQUIRED')
        if sys.argv[1] == 'preflight': preflight(); print('PRIVATE_CREDENTIAL_ESCROW_REACHABLE')
        else: store()
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch('[A-Z0-9_]+', str(error)) else 'V5_CREDENTIAL_ESCROW_FAILED'
        print(json.dumps({'status': 'FAILED', 'code': code})); raise SystemExit(1)
