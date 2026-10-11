#!/usr/bin/env python3
"""Canonical local packaging after exact-SHA native FULL; never deploys.

--package is required to build images or write admission. Without it, validate
the native FULL and print only the proposed public package context.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import stat
import sys
import tarfile
import tempfile
import time

from ci_release import digest, require
from ci_provider_evidence import PROJECT, PROVIDER, REPOSITORY, parse
import cloudbuild_release_evidence as evidence


def immutable_private(path, raw):
    path = Path(path)
    require(path.is_absolute() and not path.is_relative_to(evidence.ROOT) and path.parent == evidence.CUSTODY_ROOT,
            'ADMISSION_OUTSIDE_SOURCE_REQUIRED')
    require(path.parent.is_dir() and not path.exists() and not path.is_symlink(), 'NEW_ADMISSION_PATH_REQUIRED')
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in {0,os.geteuid()} and not info.st_mode & 0o022,
                'RELEASE_CUSTODY_PARENT_UNSAFE')
    fd = os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    require(evidence.protected_bytes(path) == raw, 'ADMISSION_WRITE_READBACK_FAILED')
    descriptor = os.open(path.parent,os.O_RDONLY); os.fsync(descriptor); os.close(descriptor)


def build_commands(sha):
    common = ['docker','build','--platform=linux/amd64','--build-arg','SOURCE_SHA='+sha]
    return [common+['--file','infra/Dockerfile','--target',target,'--tag',tag,'.']
            for target,tag in (('runtime','commerce-os:release'),('web','commerce-os-web:release'),
                               ('maintenance','commerce-os-maintenance:release'))]+[
            common+['--file','portals/mi-ciclo-listo/Dockerfile','--tag','mi-ciclo-listo-portal:release','portals/mi-ciclo-listo']]


def prepare(manifest, output, *, package=False):
    cb = evidence.bootstrap()
    require(cb.evaluate(manifest,evidence.gcloud())['state'] == 'success', 'NATIVE_FULL_REQUIRED')
    spec = importlib.util.spec_from_file_location('canonical_local_packager',evidence.ROOT/'scripts/package-ci.py')
    packager = importlib.util.module_from_spec(spec); spec.loader.exec_module(packager)
    sha = packager.release_source_preflight(manifest['source_sha'])
    tree = subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=evidence.ROOT,text=True,timeout=30).strip()
    require(tree == manifest['source_tree'], 'LOCAL_PACKAGE_TREE_MISMATCH')
    context = {'schema_version':1,'provider':PROVIDER,'repository':REPOSITORY,'project':PROJECT,
        'region':manifest['region'],'verification_build_id':manifest['build_id'],'source_sha':sha,'source_tree':tree,
        'verification_manifest_sha256':cb.canonical_hash(manifest),'package_origin':'canonical-local',
        'packager_sha256':digest(evidence.ROOT/'scripts/package-ci.py')}
    if not package: return context
    require(output is not None, 'IMMUTABLE_ADMISSION_OUTPUT_REQUIRED')
    deadline = time.monotonic()+1800
    env = {key:value for key,value in os.environ.items() if not key.startswith(('GITHUB_','GH_','COMMERCE_RELEASE_'))}
    # No cloud or GitHub credential is passed as a Docker build argument/mount.
    for argv in build_commands(sha):
        subprocess.run(argv,cwd=evidence.ROOT,env=env,check=True,timeout=max(1,deadline-time.monotonic()))
    runtime = evidence.ROOT/'.runtime'; runtime.mkdir(mode=0o700,exist_ok=True)
    require(not runtime.is_symlink(), 'LOCAL_PACKAGE_RUNTIME_DIRECTORY_UNSAFE')
    with tempfile.TemporaryDirectory(prefix='canonical-package-',dir=runtime) as directory:
        context_path = Path(directory)/'context.json'
        context_path.write_text(json.dumps(context,sort_keys=True)+'\n'); context_path.chmod(0o600)
        subprocess.run([sys.executable,'scripts/package-ci.py'],cwd=evidence.ROOT,
            env={**env,'COMMERCE_RELEASE_CONTEXT':str(context_path)},check=True,timeout=max(1,deadline-time.monotonic()))
    archive = evidence.ROOT/'release/commerce-os.tar'
    with tarfile.open(archive,'r:') as bundle:
        member = bundle.getmember('PACKAGE.sha256')
        require(member.isfile() and 0 < member.size <= 1024*1024, 'PACKAGE_MANIFEST_REQUIRED')
        import hashlib
        manifest_hash = hashlib.sha256(bundle.extractfile(member).read()).hexdigest()
    admission = {'schema_version':1,'verification_manifest':manifest,'package_manifest':{
        'context':context,'archive_sha256':digest(archive),'archive_bytes':archive.stat().st_size,
        'package_manifest_sha256':manifest_hash}}
    evidence.evaluate(admission,archive)
    immutable_private(output,(json.dumps(admission,sort_keys=True,indent=2)+'\n').encode())
    return context


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verification-manifest',type=Path,required=True)
    parser.add_argument('--admission-output',type=Path)
    parser.add_argument('--package',action='store_true')
    args = parser.parse_args(); os.umask(0o077)
    try:
        context = prepare(parse(evidence.protected_bytes(args.verification_manifest)),args.admission_output,package=args.package)
        print(json.dumps({'status':'LOCAL_PACKAGE_SEALED' if args.package else 'NATIVE_FULL_VALIDATED',
            'context':context,'deployment_started':False,'automatic_ci_proven':False},sort_keys=True))
        return 0
    except Exception as error:
        code = str(error) if type(error).__name__ in {'ReleaseError','EvidenceError'} else type(error).__name__
        print(json.dumps({'status':'LOCAL_PACKAGE_REJECTED','code':code,'deployment_started':False}))
        return 2


if __name__ == '__main__': sys.exit(main())
