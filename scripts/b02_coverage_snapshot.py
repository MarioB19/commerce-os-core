"""Read-only, bounded B02 metadata export while caller holds canonical four locks.

The canonical Root adapter calls capture() inside controller_update_locks(); this
module has no CLI or mutation route. Returned metadata is never a quota permit.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import b02_quota_coverage as coverage

MAX_JOURNAL=4*1024**2
MAX_JOURNALS=512

def need(ok,code):
    if not ok:raise RuntimeError(code)

def parsed(raw):
    def pairs(values):
        result={}
        for key,value in values:
            need(key not in result,'COVERAGE_DUPLICATE_JSON');result[key]=value
        return result
    return json.loads(raw,object_pairs_hook=pairs)

def directory(path,uid):
    s=path.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==uid and stat.S_IMODE(s.st_mode)==0o700,'COVERAGE_DIRECTORY_CUSTODY');return(s.st_dev,s.st_ino,s.st_mtime_ns,s.st_ctime_ns)

def read(path,uid):
    before=path.lstat();need(stat.S_ISREG(before.st_mode)and before.st_nlink==1 and before.st_uid==uid and stat.S_IMODE(before.st_mode)==0o600 and 0<before.st_size<=MAX_JOURNAL,'COVERAGE_JOURNAL_CUSTODY')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        opened=os.fstat(fd);need((opened.st_dev,opened.st_ino)==(before.st_dev,before.st_ino),'COVERAGE_JOURNAL_REPLACED')
        chunks=[];size=0
        while True:
            raw=os.read(fd,min(65536,MAX_JOURNAL+1-size))
            if not raw:break
            size+=len(raw);need(size<=MAX_JOURNAL,'COVERAGE_JOURNAL_LIMIT');chunks.append(raw)
        after=os.fstat(fd)
        need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'COVERAGE_JOURNAL_CHANGED')
    finally:os.close(fd)
    return b''.join(chunks)

def capture(root, *, observed_at, expected_uid=0):
    root=Path(root);need(root.is_absolute(),'COVERAGE_ABSOLUTE_ROOT_REQUIRED')
    # Validate every ancestor before any journal open, including fixed Root base.
    for p in reversed([root,*root.parents]):
        s=p.lstat();need(stat.S_ISDIR(s.st_mode)and s.st_uid==expected_uid and not stat.S_IMODE(s.st_mode)&0o022,'COVERAGE_PARENT_CUSTODY')
    identity=directory(root,expected_uid);names=sorted(p.name for p in root.iterdir())
    need(len(names)<=MAX_JOURNALS,'COVERAGE_LEDGER_TOO_LARGE')
    records=[]
    for name in names:
        need(re.fullmatch(r'(?:gcp-[a-f0-9]{32}|[0-9]+-[0-9]+)',name),'COVERAGE_FOREIGN_RUN_DIRECTORY')
        p=root/name;before=directory(p,expected_uid);raw=read(p/'journal.json',expected_uid);v=parsed(raw)
        need(v.get('run_id')==name,'COVERAGE_RUN_IDENTITY_CHANGED')
        row={'run_id':name,'started_at':v.get('started_at'),'status':v.get('status'),'sha256':hashlib.sha256(raw).hexdigest()}
        coverage.ledger([row],observed_at);need(directory(p,expected_uid)==before,'COVERAGE_RUN_DIRECTORY_CHANGED');records.append(row)
    need(directory(root,expected_uid)==identity and sorted(p.name for p in root.iterdir())==names,'COVERAGE_LEDGER_ENUMERATION_CHANGED')
    return {'schema_version':1,'state':'B02_METADATA_SNAPSHOT_ONLY','observed_at':observed_at,
        'count':len(records),'journals':records,'complete_enumeration':True,
        'journal_content_exported':False,'quota_changed':False,'execution_authorized':False}
