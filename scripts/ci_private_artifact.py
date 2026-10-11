#!/usr/bin/env python3
"""Transport sealed CI files through drafts in the existing private repository."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from ci_release import digest, require

ROOT = Path(__file__).resolve().parent.parent
REPO = 'MarioB19/commerce-os'
MANIFEST = 'transport-manifest.json'

def gh(*args, data=None, raw=False):
    result = subprocess.run(['gh', *args], input=None if data is None else json.dumps(data),
                            check=True, capture_output=True, text=True)
    return result.stdout if raw else json.loads(result.stdout)

def identity(kind):
    require(kind in ('package', 'verification', 'deployment'), 'INVALID_ARTIFACT_KIND')
    require(os.environ.get('GITHUB_REPOSITORY') == REPO and os.environ.get('GITHUB_REF') == 'refs/heads/main', 'PRIVATE_TRANSPORT_MAIN_ONLY')
    sha = os.environ['GITHUB_SHA']; run = os.environ['GITHUB_RUN_ID']; attempt = os.environ['GITHUB_RUN_ATTEMPT']
    require(re.fullmatch('[a-f0-9]{40}', sha) and re.fullmatch('[0-9]+', run) and re.fullmatch('[0-9]+', attempt), 'INVALID_ARTIFACT_IDENTITY')
    return {'schema_version': 1, 'source_sha': sha, 'run_id': run, 'attempt': attempt, 'kind': kind}

def require_private():
    require(gh('api', 'repos/'+REPO)['private'] is True, 'PRIVATE_REPOSITORY_REQUIRED')

def validate_manifest(value, expected, folder):
    for key, item in expected.items():
        require(value.get(key) == item, 'ARTIFACT_IDENTITY_MISMATCH')
    require(isinstance(value.get('files'), dict) and value['files'], 'EMPTY_ARTIFACT')
    for name, checksum in value['files'].items():
        require(isinstance(name, str) and re.fullmatch(r'[a-zA-Z0-9_.-]+', name) and name not in ('.', '..', MANIFEST), 'INVALID_ARTIFACT_FILENAME')
        require(isinstance(checksum, str) and re.fullmatch('[a-f0-9]{64}', checksum), 'INVALID_ARTIFACT_HASH')
        path = folder/name
        require(path.is_file() and not path.is_symlink() and digest(path) == checksum, 'ARTIFACT_CHECKSUM_MISMATCH')

def download_asset(release, name, destination):
    require(len([a for a in release['assets'] if a['name'] == name and a['state'] == 'uploaded']) == 1, 'ARTIFACT_ASSET_MISSING')
    gh('release', 'download', release['tag_name'], '--repo', REPO, '--pattern', name, '--dir', str(destination), raw=True)

def store(kind):
    expected = identity(kind); require_private()
    with tempfile.TemporaryDirectory() as temporary:
        folder = Path(temporary)
        if kind == 'package':
            paths = [ROOT/'release/commerce-os.tar', ROOT/'release/commerce-os.tar.sha256']
        else:
            paths = [folder/(kind+'.tar.gz')]
            roots = ['playwright-report', 'test-results', 'docs/evidence'] if kind == 'verification' else ['release/deployment.json']
            files = []
            for name in roots:
                path = ROOT/name
                files += [path] if path.is_file() else sorted(p for p in path.rglob('*') if p.is_file())
            require(files, 'ARTIFACT_EVIDENCE_MISSING')
            with tarfile.open(paths[0], 'w:gz') as archive:
                for path in files:
                    require(not path.is_symlink(), 'ARTIFACT_SYMLINK_FORBIDDEN')
                    archive.add(path, arcname=path.relative_to(ROOT), recursive=False)
        require(all(p.is_file() and not p.is_symlink() and 0 < p.stat().st_size < 2**31 for p in paths), 'ARTIFACT_FILE_INVALID')
        manifest = {**expected, 'files': {p.name: digest(p) for p in paths}}
        metadata = folder/MANIFEST; metadata.write_text(json.dumps(manifest, sort_keys=True)+'\n')
        tag = 'ci-'+kind+'-'+expected['run_id']+'-'+expected['attempt']
        releases = gh('api', 'repos/'+REPO+'/releases?per_page=100')
        matching = [r for r in releases if r['tag_name'] == tag]
        require(len(matching) <= 1, 'AMBIGUOUS_ARTIFACT_RELEASE')
        release = matching[0] if matching else gh('api', 'repos/'+REPO+'/releases', '--input', '-', data={
            'tag_name': tag, 'target_commitish': expected['source_sha'], 'name': tag,
            'draft': True, 'prerelease': False, 'make_latest': 'false',
            'body': 'Private CI transport. '+json.dumps(expected, sort_keys=True)})
        require(release['draft'] is True and release['target_commitish'] == expected['source_sha'], 'ARTIFACT_RELEASE_MISMATCH')
        for path in [*paths, metadata]:
            if any(a['name'] == path.name for a in release['assets']):
                with tempfile.TemporaryDirectory() as prior:
                    download_asset(release, path.name, Path(prior))
                    require(digest(Path(prior)/path.name) == digest(path), 'EXISTING_ARTIFACT_DIFFERS')
            else:
                # Never clobber an existing asset or retry an uncertain upload blindly.
                gh('release', 'upload', tag, str(path), '--repo', REPO, raw=True)
        # Verify the actual stored bytes, including after a retry of this job.
        stored = gh('api', 'repos/'+REPO+'/releases/'+str(release['id']))
        with tempfile.TemporaryDirectory() as check:
            check = Path(check)
            for path in [*paths, metadata]:
                download_asset(stored, path.name, check)
                require(digest(check/path.name) == digest(path), 'UPLOADED_ARTIFACT_DIFFERS')
        output = {'release_id': str(release['id']), 'manifest_sha256': digest(metadata)}
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as target:
                for key, value in output.items(): target.write(key+'='+value+'\n')
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as target:
                target.write('Private '+kind+' artifact: release ID `'+output['release_id']+'`, manifest SHA256 `'+output['manifest_sha256']+'`.\n')
        print(json.dumps({**expected, **output}))

def download():
    expected = identity('package'); require_private()
    release_id = os.environ['PRIVATE_RELEASE_ID']; checksum = os.environ['PRIVATE_MANIFEST_SHA256']
    require(re.fullmatch('[0-9]+', release_id) and re.fullmatch('[a-f0-9]{64}', checksum), 'INVALID_ARTIFACT_REFERENCE')
    release = gh('api', 'repos/'+REPO+'/releases/'+release_id)
    require(release['draft'] is True and release['target_commitish'] == expected['source_sha'], 'ARTIFACT_RELEASE_MISMATCH')
    with tempfile.TemporaryDirectory() as temporary:
        folder = Path(temporary); download_asset(release, MANIFEST, folder)
        require(digest(folder/MANIFEST) == checksum, 'ARTIFACT_MANIFEST_CHECKSUM_MISMATCH')
        manifest = json.loads((folder/MANIFEST).read_text())
        # A failed-deploy-only rerun can consume the original successful package job.
        expected.pop('attempt')
        require(set(manifest.get('files', {})) == {'commerce-os.tar', 'commerce-os.tar.sha256'}, 'UNEXPECTED_PACKAGE_FILES')
        for name in manifest['files']: download_asset(release, name, folder)
        validate_manifest(manifest, expected, folder)
        (ROOT/'release').mkdir(exist_ok=True)
        for name in manifest['files']:
            destination = ROOT/'release'/name
            require(not destination.exists(), 'ARTIFACT_DESTINATION_EXISTS')
            shutil.copyfile(folder/name, destination)
    print('Private package identity and all downloaded hashes verified.')

if __name__ == '__main__':
    os.umask(0o077)
    if sys.argv[1] == 'download': download()
    else: store(sys.argv[1])
