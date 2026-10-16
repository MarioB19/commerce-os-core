#!/usr/bin/env python3
"""V7 F1: daily copy of the private assets (materials, receipts, media) to the
recovery bucket in another region, alongside PITR for the database.

    v7_files_backup.py sync <config.json>      # Root, commerce-files-backup.timer
    v7_files_backup.py restore <config.json> <empty-dir>

The files are already sealed with the data key (`*.enc`), so they are copied
as they are; nothing is decrypted. The copy mirrors the folder: new or changed
files are uploaded; a file that disappeared locally is marked and deleted
from the copy after `grace_days` (privacy erasure reaches backups, D-18).
Authentication is the VM's own identity (metadata server); no key on disk.
Prints counts only.
"""
import json
import os
import re
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path

FIELDS = {'assets_dir', 'bucket', 'prefix', 'grace_days', 'receipt'}
NAME = re.compile(r'^[A-Za-z0-9._/-]{1,512}$')
MAX_FILE = 200 * 1024 * 1024
TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'


class BackupError(Exception):
    pass


def need(ok, code):
    if not ok:
        raise BackupError(code)


def load_config(path):
    raw = json.loads(Path(path).read_text())
    need(isinstance(raw, dict) and set(raw) == FIELDS, 'FILES_CONFIG_FIELDS')
    need(isinstance(raw['assets_dir'], str) and raw['assets_dir'].startswith('/') and '..' not in raw['assets_dir'].split('/'), 'FILES_CONFIG_ASSETS_DIR')
    need(isinstance(raw['bucket'], str) and re.fullmatch(r'[a-z0-9][a-z0-9._-]{2,62}', raw['bucket']), 'FILES_CONFIG_BUCKET')
    need(isinstance(raw['prefix'], str) and re.fullmatch(r'[a-z0-9-]{3,40}', raw['prefix']), 'FILES_CONFIG_PREFIX')
    need(isinstance(raw['grace_days'], int) and 7 <= raw['grace_days'] <= 365, 'FILES_CONFIG_GRACE')
    need(isinstance(raw['receipt'], str) and raw['receipt'].startswith('/'), 'FILES_CONFIG_RECEIPT')
    return raw


class Storage:
    """GCS JSON API with the VM identity. Injected for tests."""

    def __init__(self, bucket, opener=urllib.request.urlopen):
        self.bucket, self.opener, self.token = bucket, opener, None

    def _token(self):
        if not self.token:
            req = urllib.request.Request(TOKEN_URL, headers={'Metadata-Flavor': 'Google'})
            with self.opener(req, timeout=10) as r:
                self.token = json.loads(r.read())['access_token']
        return self.token

    def request(self, method, url, data=None, headers=None):
        req = urllib.request.Request(url, data=data, method=method, headers={'Authorization': 'Bearer ' + self._token(), **(headers or {})})
        try:
            with self.opener(req, timeout=300) as r:
                body = r.read()
                return json.loads(body) if body and r.headers.get('Content-Type', '').startswith('application/json') else body
        except urllib.error.HTTPError as e:
            raise BackupError('FILES_HTTP_%d' % e.code) from None

    def list(self, prefix):
        items, token = {}, None
        while True:
            q = {'prefix': prefix + '/', 'fields': 'items(name,size,metadata),nextPageToken', 'maxResults': '1000'}
            if token:
                q['pageToken'] = token
            page = self.request('GET', 'https://storage.googleapis.com/storage/v1/b/%s/o?%s' % (self.bucket, urllib.parse.urlencode(q)))
            for it in page.get('items', []):
                items[it['name']] = {'size': int(it['size']), 'metadata': it.get('metadata') or {}}
            token = page.get('nextPageToken')
            if not token:
                return items

    def upload(self, name, data, digest):
        meta = json.dumps({'name': name, 'metadata': {'sha256': digest}}).encode()
        boundary = 'commerce-v7-' + digest[:16]
        body = (b'--' + boundary.encode() + b'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + b'\r\n--' + boundary.encode()
                + b'\r\nContent-Type: application/octet-stream\r\n\r\n' + data + b'\r\n--' + boundary.encode() + b'--')
        self.request('POST', 'https://storage.googleapis.com/upload/storage/v1/b/%s/o?uploadType=multipart' % self.bucket,
                     data=body, headers={'Content-Type': 'multipart/related; boundary=' + boundary})

    def mark(self, name, metadata):
        self.request('PATCH', 'https://storage.googleapis.com/storage/v1/b/%s/o/%s' % (self.bucket, urllib.parse.quote(name, safe='')),
                     data=json.dumps({'metadata': metadata}).encode(), headers={'Content-Type': 'application/json'})

    def delete(self, name):
        self.request('DELETE', 'https://storage.googleapis.com/storage/v1/b/%s/o/%s' % (self.bucket, urllib.parse.quote(name, safe='')))

    def download(self, name):
        return self.request('GET', 'https://storage.googleapis.com/storage/v1/b/%s/o/%s?alt=media' % (self.bucket, urllib.parse.quote(name, safe='')))


def local_files(root):
    root = Path(root)
    need(root.is_dir() and not root.is_symlink(), 'FILES_ASSETS_DIR_INVALID')
    found = {}
    for dirpath, dirnames, filenames in os.walk(root):
        # uploads/ is temporary; number-lab/ is the laboratory's own 30-day storage (D-18).
        dirnames[:] = sorted(d for d in dirnames if not (Path(dirpath) / d).is_symlink()
                             and d != 'uploads' and not (Path(dirpath) == root and d == 'number-lab'))
        for f in sorted(filenames):
            p = Path(dirpath) / f
            st = p.lstat()
            if not stat.S_ISREG(st.st_mode):
                continue
            rel = p.relative_to(root).as_posix()
            need(NAME.match(rel) and '..' not in rel.split('/'), 'FILES_NAME_UNSAFE')
            need(st.st_size <= MAX_FILE, 'FILES_TOO_LARGE')
            found[rel] = p
    return found


def sync(config, storage=None, now=None):
    now = now or datetime.now(timezone.utc)
    storage = storage or Storage(config['bucket'])
    prefix = config['prefix']
    remote = storage.list(prefix)
    local = local_files(config['assets_dir'])
    uploaded = unchanged = marked = deleted = 0
    for rel, path in local.items():
        data = path.read_bytes()
        digest = sha256(data).hexdigest()
        name = prefix + '/' + rel
        have = remote.get(name)
        if have and have['size'] == len(data) and have['metadata'].get('sha256') == digest and not have['metadata'].get('missing_since'):
            unchanged += 1
            continue
        storage.upload(name, data, digest)
        uploaded += 1
    for name, have in remote.items():
        rel = name[len(prefix) + 1:]
        if rel in local:
            continue
        since = have['metadata'].get('missing_since')
        if not since:
            storage.mark(name, {**have['metadata'], 'missing_since': now.isoformat()})
            marked += 1
        elif datetime.fromisoformat(since) <= now - timedelta(days=config['grace_days']):
            storage.delete(name)
            deleted += 1
    receipt = {'schema_version': 1, 'at': now.isoformat(), 'files': len(local), 'uploaded': uploaded, 'unchanged': unchanged,
               'marked_missing': marked, 'deleted_after_grace': deleted, 'state': 'FILES_BACKUP_SUCCEEDED'}
    path = Path(config['receipt'])
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(receipt, sort_keys=True))
    tmp.chmod(0o600)
    tmp.replace(path)
    return receipt


def restore(config, target, storage=None):
    target = Path(target)
    need(target.is_dir() and not any(target.iterdir()), 'FILES_RESTORE_TARGET_NOT_EMPTY')
    storage = storage or Storage(config['bucket'])
    restored = 0
    for name, have in storage.list(config['prefix']).items():
        if have['metadata'].get('missing_since'):
            continue
        rel = name[len(config['prefix']) + 1:]
        need(NAME.match(rel) and '..' not in rel.split('/'), 'FILES_NAME_UNSAFE')
        data = storage.download(name)
        need(sha256(data).hexdigest() == have['metadata'].get('sha256') and len(data) == have['size'], 'FILES_RESTORE_INTEGRITY')
        out = target / rel
        out.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        restored += 1
    return {'state': 'FILES_RESTORED', 'files': restored}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(argv) == 2 and argv[0] == 'sync':
            r = sync(load_config(argv[1]))
            print(json.dumps({k: r[k] for k in ('state', 'files', 'uploaded', 'unchanged', 'marked_missing', 'deleted_after_grace')}))
            return 0
        if len(argv) == 3 and argv[0] == 'restore':
            print(json.dumps(restore(load_config(argv[1]), argv[2])))
            return 0
        raise BackupError('usage: v7_files_backup.py sync <config> | restore <config> <empty-dir>')
    except (BackupError, OSError, ValueError) as e:
        print(json.dumps({'state': 'FILES_BACKUP_FAILED', 'error': str(e)[:300]}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
