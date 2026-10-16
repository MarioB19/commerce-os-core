#!/usr/bin/env python3
"""Package the four validated, loaded images from this checkout; never reads private env."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import sys
from ci_release import digest, require, verify_package
from ci_provider_evidence import package_context, release_metadata

ROOT=Path(__file__).resolve().parent.parent
SOURCE_REVISION_LABEL='org.opencontainers.image.revision'
SENSITIVE_SOURCE_SUFFIXES=('.key','.pem','.p12','.pfx','.dump','.backup','.backup.aes','.tar','.tar.gz')
# V7 F8: the local creative factory and its drivers were retired from the repository.
LOCAL_FACTORY_SCRIPTS=frozenset()
def release_source(name):
    return name.startswith(('scripts/','infra/','packages/db/migrations/')) and name!='scripts/rotate-local-test-credential.mjs' and not(name.startswith('scripts/') and Path(name).name in LOCAL_FACTORY_SCRIPTS)

def run(*args):
    return subprocess.check_output(args,cwd=ROOT,text=True).strip()

def clean_source_revision(expected_sha=None):
    """Refuse to label or package bytes that are not the exact clean commit."""
    sha=run('git','rev-parse','HEAD')
    require(expected_sha in (None,sha),'SOURCE_COMMIT_MISMATCH')
    require(run('git','status','--porcelain')=='','SOURCE_TREE_DIRTY')
    return sha

def sensitive_build_input_count(root=ROOT):
    """Count local high-risk inputs without ever exposing their paths or bytes."""
    count=0
    skipped={'.git','node_modules','dist','release','docs','coverage','playwright-report','test-results','.local','.runtime','__pycache__','.next','.vercel','evidence','target','binaries','gen'}
    for directory,children,files in os.walk(root):
        children[:]=[name for name in children if name not in skipped]
        if '.secrets' in children:
            count+=1;children.remove('.secrets')
        for name in files:
            lower=name.lower()
            if (lower.startswith('.env') and lower!='.env.example') or lower.endswith(SENSITIVE_SOURCE_SUFFIXES):
                count+=1
    return count

def release_source_preflight(expected_sha=None):
    sha=clean_source_revision(expected_sha)
    require(sensitive_build_input_count()==0,'SENSITIVE_BUILD_INPUT_PRESENT')
    return sha

def release_image_metadata(info,expected_sha):
    """Bind every packaged image config to the exact source commit."""
    require(info.get('Os')=='linux' and info.get('Architecture')=='amd64','IMAGE_PLATFORM_INVALID')
    labels=(info.get('Config') or {}).get('Labels')
    require(isinstance(labels,dict) and SOURCE_REVISION_LABEL in labels,'IMAGE_SOURCE_SHA_LABEL_MISSING')
    revision=labels[SOURCE_REVISION_LABEL]
    require(isinstance(revision,str) and revision==expected_sha,'IMAGE_SOURCE_SHA_MISMATCH')
    return {'id':info['Id'],'layers':info['RootFS']['Layers'],'source_sha':revision}

def main():
    os.umask(0o077)
    context_path=os.environ.get('COMMERCE_RELEASE_CONTEXT')
    context=package_context(context_path) if context_path else None
    require(not context or not any(os.environ.get(key) for key in ('GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT')),
            'MIXED_RELEASE_PROVIDERS')
    sha=release_source_preflight(context['source_sha'] if context else os.environ.get('GITHUB_SHA'))
    if '--source-preflight' in sys.argv[1:]:
        print(json.dumps({'source_sha':sha,'clean':True,'sensitive_build_inputs':0}))
        return
    output=ROOT/'release'
    output.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        stage=Path(temporary)/'package';stage.mkdir()
        tracked=run('git','ls-files').splitlines()
        for name in tracked:
            if release_source(name):
                require(not (ROOT/name).is_symlink(),'SOURCE_SYMLINK_FORBIDDEN')
                destination=stage/name;destination.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(ROOT/name,destination)
        images={}
        for name in ['commerce-os:release','commerce-os-web:release','commerce-os-maintenance:release','mi-ciclo-listo-portal:release']:
            info=json.loads(run('docker','image','inspect',name))[0]
            images[name]=release_image_metadata(info,sha)
        run('docker','run','--rm','--read-only','--network','none','--cap-drop','ALL','commerce-os:release','node','-e',"if(!require('node:fs').existsSync('/app/packages/db/src/operational-settings.ts'))process.exit(42)")
        container=run('docker','create','--network','none','commerce-os-web:release')
        web=Path(temporary)/'web'
        try:
            run('docker','cp',container+':/srv',str(web))
        finally:
            run('docker','rm',container)
        web_manifest={p.relative_to(web).as_posix():digest(p) for p in web.rglob('*') if p.is_file()}
        require('index.html' in web_manifest,'WEB_BUILD_MISSING')
        container=run('docker','create','--network','none','commerce-os:release')
        migrations=Path(temporary)/'migrations'
        try:
            run('docker','cp',container+':/app/packages/db/migrations',str(migrations))
        finally:
            run('docker','rm',container)
        expected={p.name:digest(p) for p in (ROOT/'packages/db/migrations').glob('*.sql')}
        require(expected=={p.name:digest(p) for p in migrations.glob('*.sql')},'IMAGE_MIGRATIONS_DIFFER_FROM_SOURCE')
        portal_pdfs=ROOT/'portals/mi-ciclo-listo/private/pdfs'
        portal_manifest={'source_sha':sha,'origin':'https://ciclo.inovaris.online','pdfs':{p.name:digest(p) for p in sorted(portal_pdfs.glob('*.pdf'))}}
        require(len(portal_manifest['pdfs'])==10,'PORTAL_PDFS_INCOMPLETE')
        (stage/'portal-manifest.json').write_text(json.dumps(portal_manifest,sort_keys=True)+'\n')
        with (stage/'images.tar.gz').open('wb') as destination:
            save=subprocess.Popen(['docker','save',*images],stdout=subprocess.PIPE)
            gzip=subprocess.Popen(['gzip','-1'],stdin=save.stdout,stdout=destination)
            save.stdout.close()
            require(gzip.wait()==0 and save.wait()==0,'IMAGE_ARCHIVE_FAILED')
        (stage/'images.sha256').write_text(digest(stage/'images.tar.gz')+'  images.tar.gz\n')
        metadata={'schema_version':1,'source_sha':sha,'run_id':os.environ.get('GITHUB_RUN_ID'),'migration_hashes':expected,'platform':'linux/amd64'}
        if context:
            metadata.update(release_metadata(context,sha,run('git','rev-parse','HEAD^{tree}')))
        for filename,value in [('RELEASE.json',metadata),('images.json',images),('web-manifest.json',web_manifest)]:
            (stage/filename).write_text(json.dumps(value,sort_keys=True)+'\n')
        files=sorted(p for p in stage.rglob('*') if p.is_file())
        (stage/'PACKAGE.sha256').write_text(''.join(digest(p)+'  '+p.relative_to(stage).as_posix()+'\n' for p in files))
        verify_package(stage)
        archive=output/'commerce-os.tar'
        with tarfile.open(archive,'w') as bundle:
            for p in sorted(stage.rglob('*')):
                if p.is_file():
                    info=bundle.gettarinfo(str(p),arcname=p.relative_to(stage).as_posix())
                    info.uid=info.gid=0;info.uname=info.gname='';info.mode=0o600
                    with p.open('rb') as source:
                        bundle.addfile(info,source)
        (output/'commerce-os.tar.sha256').write_text(digest(archive)+'  commerce-os.tar\n')
        print(json.dumps({'source_sha':sha,'archive_bytes':archive.stat().st_size,'images':len(images),'web_files':len(web_manifest),'migrations':len(expected)}))

if __name__=='__main__':
    main()
