"""Shared release validation; no Docker mutations in archive checks."""
import hashlib
import re
import tarfile
from pathlib import Path, PurePosixPath

class ReleaseError(RuntimeError):
    pass

def require(condition, code):
    if not condition:
        raise ReleaseError(code)

def digest(path):
    with open(path,'rb') as source:
        return hashlib.file_digest(source,'sha256').hexdigest()

def safe_name(name):
    path=PurePosixPath(name)
    return bool(name) and not path.is_absolute() and '..' not in path.parts and str(path)==name and not any(c in name for c in '\n\r\\')

def extract_release(archive, destination, expected_hash):
    require(re.fullmatch(r'[a-f0-9]{64}',expected_hash),'INVALID_ARCHIVE_HASH')
    require(digest(archive)==expected_hash,'ARCHIVE_HASH_MISMATCH')
    destination=Path(destination)
    require(not destination.exists(),'RELEASE_DIRECTORY_ALREADY_EXISTS')
    with tarfile.open(archive,'r:') as bundle:
        members=bundle.getmembers()
        require(0<len(members)<=2000,'INVALID_ARCHIVE_ENTRY_COUNT')
        names=set()
        for member in members:
            require(safe_name(member.name) and member.isfile(),'UNSAFE_ARCHIVE_ENTRY')
            require(member.name not in names,'DUPLICATE_ARCHIVE_ENTRY')
            require(member.size<=2*1024**3,'ARCHIVE_ENTRY_TOO_LARGE')
            names.add(member.name)
        require(sum(m.size for m in members)<=3*1024**3,'ARCHIVE_TOO_LARGE')
        destination.mkdir(mode=0o700,parents=True)
        for member in members:
            target=destination/member.name
            target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            with bundle.extractfile(member) as source, target.open('xb') as output:
                while chunk:=source.read(1024*1024):
                    output.write(chunk)
            target.chmod(0o600)
    verify_package(destination)

def verify_package(root):
    root=Path(root)
    expected={}
    for line in (root/'PACKAGE.sha256').read_text().splitlines():
        match=re.fullmatch(r'([a-f0-9]{64})  (.+)',line)
        require(match is not None,'INVALID_PACKAGE_MANIFEST')
        checksum,name=match.groups()
        require(safe_name(name) and name not in expected and name!='PACKAGE.sha256','INVALID_PACKAGE_PATH')
        expected[name]=checksum
    files={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() and p.name!='PACKAGE.sha256'}
    require(files==set(expected),'PACKAGE_FILE_SET_MISMATCH')
    for name,checksum in expected.items():
        require(not (root/name).is_symlink() and digest(root/name)==checksum,'PACKAGE_HASH_MISMATCH')
    require({'images.tar.gz','images.sha256','RELEASE.json','images.json','web-manifest.json','scripts/install-vps.sh'}<=files,'INCOMPLETE_RELEASE')

def verify_migrations(applied, expected, complete=False):
    require(all(expected.get(name)==checksum for name,checksum in applied.items()),'MIGRATION_HISTORY_CHANGED')
    if complete:
        require(applied==expected,'MIGRATIONS_INCOMPLETE')
