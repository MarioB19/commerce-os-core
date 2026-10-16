#!/usr/bin/env python3
"""Trusted package image entrypoint; source Dockerfiles run with package SA only.

The controller has already verified FULL and reserved the Build's 1800s before
dispatch. This driver neither authenticates that admission nor publishes PASS;
its receipt is accepted only with exact native Build provenance and FULL.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

from ci_release import digest, require, extract_release
from ci_provider_evidence import parse, release_identity, cloud_installation_id
import cloudbuild_native_package as native
from cloudbuild_bounded_logs import execute as bounded_execute


def environment(root, temporary):
    # The trusted package SA still exists at metadata. No production capability
    # belongs to that SA, and no inherited token/config/home enters subprocesses.
    return {'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            'HOME':str(temporary),'LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1',
            'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_SYSTEM':'/dev/null','GIT_CONFIG_GLOBAL':'/dev/null',
            'GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'safe.directory','GIT_CONFIG_VALUE_0':str(root),
            'GIT_TERMINAL_PROMPT':'0','DOCKER_HOST':'unix:///var/run/docker.sock',
            'DOCKER_CONFIG':str(temporary/'docker')}


def commands(source_sha):
    require(re.fullmatch('[a-f0-9]{40}',source_sha), 'SOURCE_SHA_REQUIRED')
    common=['docker','build','--platform=linux/amd64','--build-arg','SOURCE_SHA='+source_sha]
    return [common+['--file','infra/Dockerfile','--target',target,'--tag',tag,'.']
            for target,tag in (('runtime','commerce-os:release'),('web','commerce-os-web:release'),
                               ('maintenance','commerce-os-maintenance:release'))]+[
            common+['--file','portals/mi-ciclo-listo/Dockerfile','--tag','mi-ciclo-listo-portal:release','portals/mi-ciclo-listo']]


def execute(argv, root, env, deadline):
    require(time.monotonic()<deadline, 'PACKAGE_DEADLINE_EXPIRED')
    code=bounded_execute(argv,root,env,max(0.01,deadline-time.monotonic()),umask=0o077)
    require(code==0,'PACKAGE_COMMAND_FAILED')


def source_identity(root, inputs, env):
    root=root.resolve(strict=True)
    def git(*args):
        value=subprocess.run(['git','-c','core.hooksPath=/dev/null',*args],cwd=root,env=env,
                             stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=30)
        require(value.returncode==0 and len(value.stdout)<=1024**2,'PACKAGE_GIT_IDENTITY_FAILED')
        return value.stdout.decode().strip()
    require(Path(git('rev-parse','--show-toplevel')).resolve()==root and
            git('rev-parse','HEAD')==inputs['source_sha'] and git('rev-parse','HEAD^{tree}')==inputs['source_tree'] and
            not git('status','--porcelain','--untracked-files=all'),'PACKAGE_SOURCE_NOT_EXACT')
    require(digest(root/'scripts/package-ci.py')==inputs['packager_sha256'],'PACKAGE_SOURCE_DRIVER_CHANGED')


def package(source, inputs, build_id, *, runner=execute):
    native.validate_inputs(inputs)
    require(sys.platform=='linux','LINUX_PACKAGE_WORKER_REQUIRED')
    require(digest(Path(__file__))==inputs['package_driver_sha256'],'TRUSTED_PACKAGE_DRIVER_CHANGED')
    ctx=native.context(inputs,build_id);root=Path(source).resolve(strict=True)
    deadline=time.monotonic()+native.INNER_SECONDS
    # Private temporary HOME is outside candidate source; the build context has
    # no credentials, and importing candidate packager code is unnecessary.
    with tempfile.TemporaryDirectory(prefix='commerce-native-package-') as directory:
        temporary=Path(directory);temporary.chmod(0o700);(temporary/'docker').mkdir(mode=0o700)
        env=environment(root,temporary);source_identity(root,inputs,env)
        runner(['docker','buildx','version'],root,env,deadline)
        runner([sys.executable,'scripts/package-ci.py','--source-preflight'],root,env,deadline)
        for command in commands(inputs['source_sha']):runner(command,root,env,deadline)
        source_identity(root,inputs,env)
        context_file=temporary/'context.json'
        with context_file.open('x') as stream:stream.write(json.dumps(ctx,sort_keys=True)+'\n')
        context_file.chmod(0o600)
        runner([sys.executable,'scripts/package-ci.py'],root,{**env,'COMMERCE_RELEASE_CONTEXT':str(context_file)},deadline)
        source_identity(root,inputs,env)
        archive=root/'release/commerce-os.tar'
        require(archive.is_file() and not archive.is_symlink() and 0<archive.stat().st_size<=native.MAX_ARCHIVE,
                'PACKAGE_ARCHIVE_BOUND')
        archive_sha=digest(archive)
        extracted=temporary/'verify-package';extract_release(archive,extracted,archive_sha)
        metadata=parse((extracted/'RELEASE.json').read_bytes())
        require(release_identity(metadata,inputs['source_sha'],cloud_installation_id(build_id,1),'copy-runtime')==ctx,
                'PACKAGE_ARCHIVE_CONTEXT_CHANGED')
        require(time.monotonic()<deadline,'PACKAGE_DEADLINE_EXPIRED')
        return {'kind':native.evidence.PACKAGE_GATE,'schema_version':1,'status':'PACKAGED','context':ctx,
                'archive_sha256':archive_sha,'archive_bytes':archive.stat().st_size}


def main():
    os.umask(0o077);parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True);parser.add_argument('--build-id',required=True)
    parser.add_argument('--inputs-base64',required=True);args=parser.parse_args()
    try:
        require(len(args.inputs_base64)<=8192,'PACKAGE_INPUT_BOUND')
        inputs=parse(base64.b64decode(args.inputs_base64,validate=True))
        receipt=package(args.source,inputs,args.build_id)
        print(json.dumps(receipt,sort_keys=True),flush=True);return 0
    except Exception:
        # Candidate stdout is not evidence. This failure emits no token, source
        # path, provider response or exception text, and never emits PACKAGED.
        print(json.dumps({'kind':'COMMERCE_CLOUD_PACKAGE_FAILURE','status':'FAILED'}),flush=True);return 1


if __name__=='__main__':sys.exit(main())
