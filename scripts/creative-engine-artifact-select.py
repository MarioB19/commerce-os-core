#!/usr/bin/env python3
"""Read selected private GitHub artifact entries over HTTP Range, without fetching its media first."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import zipfile


class SelectionError(RuntimeError):
    pass


def require(ok, code):
    if not ok:
        raise SelectionError(code)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _req, _fp, _code, _msg, _headers, _newurl):
        return None


class RangeFile(io.RawIOBase):
    def __init__(self, url):
        self.url, self.position, self.transferred = url, 0, 0
        parsed = urllib.parse.urlparse(url)
        require(parsed.scheme == 'https' and not parsed.username and not parsed.password, 'ARTIFACT_HTTPS_REQUIRED')
        with urllib.request.urlopen(urllib.request.Request(url, headers={'Range': 'bytes=0-0'}), timeout=45) as response:
            match = re.fullmatch(r'bytes 0-0/(\d+)', response.headers.get('Content-Range', ''))
            require(response.status == 206 and match is not None, 'ARTIFACT_RANGE_REQUIRED')
            self.length = int(match.group(1))
            require(0 < self.length <= 5 * 1024**3, 'ARTIFACT_SIZE_INVALID')

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        self.position = offset if whence == 0 else self.position + offset if whence == 1 else self.length + offset
        require(0 <= self.position <= self.length, 'ARTIFACT_SEEK_INVALID')
        return self.position

    def read(self, size=-1):
        size = self.length - self.position if size < 0 else min(size, self.length - self.position)
        if not size:
            return b''
        require(size <= 16 * 1024**2, 'ARTIFACT_RANGE_TOO_LARGE')
        start, end = self.position, self.position + size - 1
        with urllib.request.urlopen(urllib.request.Request(self.url, headers={'Range': f'bytes={start}-{end}'}), timeout=45) as response:
            require(response.status == 206 and response.headers.get('Content-Range') == f'bytes {start}-{end}/{self.length}', 'ARTIFACT_RANGE_MISMATCH')
            data = response.read(size + 1)
            require(len(data) == size, 'ARTIFACT_RANGE_TRUNCATED')
        self.position += size
        self.transferred += size
        return data


def artifact_location(repo, artifact_id):
    credential = subprocess.run(['gh', 'auth', 'token', '--hostname', 'github.com'], capture_output=True, text=True, check=False)
    require(credential.returncode == 0 and len(credential.stdout.strip()) > 10, 'GITHUB_AUTH_REQUIRED')
    headers = {'Authorization': 'Bearer ' + credential.stdout.strip(), 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
    base = f'https://api.github.com/repos/{repo}/actions/artifacts/{artifact_id}'
    with urllib.request.urlopen(urllib.request.Request(base, headers=headers), timeout=45) as response:
        metadata = json.loads(response.read(1024**2))
    require(metadata['id'] == artifact_id and not metadata['expired'], 'ARTIFACT_NOT_AVAILABLE')
    try:
        urllib.request.build_opener(NoRedirect()).open(urllib.request.Request(base + '/zip', headers=headers), timeout=45)
    except urllib.error.HTTPError as error:
        require(error.code == 302 and error.headers.get('Location'), 'ARTIFACT_REDIRECT_REQUIRED')
        return metadata, error.headers['Location']
    raise SelectionError('ARTIFACT_REDIRECT_REQUIRED')


def select(repo, artifact_id, output, media=False):
    metadata, location = artifact_location(repo, artifact_id)
    output = Path(output).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(not output.is_symlink() and stat.S_IMODE(output.stat().st_mode) & 0o077 == 0, 'PRIVATE_OUTPUT_REQUIRED')
    selected = []
    allowed = {'native-pilot-results.json', 'mi-ciclo-listo-receipt.json', 'oraciones-receipt.json', 'windows-installed-doctor.json', 'manifest.json'}
    if media:
        allowed |= {'master.mp4', 'copy.json', 'captions.srt'}
    remote = RangeFile(location)
    with zipfile.ZipFile(remote) as archive:
        for entry in archive.infolist():
            name = PurePosixPath(entry.filename)
            if name.name not in allowed:
                continue
            require(not name.is_absolute() and '..' not in name.parts and '\\' not in entry.filename and ':' not in entry.filename and not stat.S_ISLNK(entry.external_attr >> 16), 'ARTIFACT_ENTRY_UNSAFE')
            require(entry.file_size <= (500 * 1024**2 if name.suffix == '.mp4' else 2 * 1024**2), 'ARTIFACT_ENTRY_TOO_LARGE')
            destination = output.joinpath(*name.parts)
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            require(destination.parent.resolve().is_relative_to(output), 'ARTIFACT_ENTRY_UNSAFE')
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with archive.open(entry) as source, os.fdopen(fd, 'wb') as target:
                shutil.copyfileobj(source, target, 1024**2)
            os.chmod(destination, 0o600)
            hasher = hashlib.sha256()
            with destination.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024**2), b''):
                    hasher.update(chunk)
            require(destination.stat().st_size == entry.file_size, 'ARTIFACT_ENTRY_SIZE_MISMATCH')
            selected.append({'entry': entry.filename, 'bytes': entry.file_size, 'sha256': hasher.hexdigest()})
    require(selected and len(selected) <= 25, 'ARTIFACT_SELECTION_INVALID')
    report = {'artifact_id': artifact_id, 'artifact_name': metadata['name'], 'artifact_archive_declared_sha256': metadata.get('digest'), 'archive_digest_independently_verified': False, 'selection_verified_by': ['HTTPS GitHub artifact redirect', 'ZIP CRC for selected entries', 'SHA256 of selected bytes'], 'archive_bytes': remote.length, 'downloaded_range_bytes': remote.transferred, 'media_requested': media, 'selected': selected}
    path = output / ('media-selection.json' if media else 'metadata-selection.json')
    path.write_text(json.dumps(report, indent=2) + '\n')
    os.chmod(path, 0o600)
    return {key: report[key] for key in ['artifact_id', 'archive_bytes', 'downloaded_range_bytes', 'media_requested']} | {'selected_files': len(selected)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', default='MarioB19/commerce-os')
    parser.add_argument('--artifact-id', type=int, required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--media', action='store_true')
    args = parser.parse_args()
    require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo), 'REPOSITORY_INVALID')
    os.umask(0o077)
    print(json.dumps(select(args.repo, args.artifact_id, args.output, args.media)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Exception text from urllib can contain expiring signed URLs; emit codes only.
        print(json.dumps({'status': 'FAILED', 'code': str(error) if isinstance(error, SelectionError) else type(error).__name__}))
        raise SystemExit(2) from None
