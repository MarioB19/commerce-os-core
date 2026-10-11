"""Authenticated readers for the local Cloud Build release publisher.

Admission files are protected operator inputs outside the candidate checkout.
Every use re-reads provider state. Neither a workspace receipt nor a GitHub
Deployment payload can replace native provenance or the protected Root report.
No infrastructure/IAM grant, installer invocation, or GitHub mutation occurs.
The installed-state reader imports and revokes its own ephemeral OS Login key.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import urllib.request

from ci_release import digest, require, extract_release
from ci_provider_evidence import (PROJECT, PROVIDER, REPOSITORY, CLOUD_RUN, parse,
    validate_context, cloud_installation_id, sha, release_identity, LOCAL_RUN, publication_enabled)

ROOT = Path(__file__).resolve().parent.parent
CUSTODY_ROOT = Path.home()/'.local/share/commerce-os-release-custody'
import operator_identity
ORIGIN = 'https://commerce-os.inovaris.online'
PACKAGE_GATE = 'COMMERCE_CLOUD_PACKAGE_RECEIPT'
MAX_JSON = 4*1024*1024


def bootstrap():
    spec = importlib.util.spec_from_file_location('cloudbuild_bootstrap_publisher',
                                                  Path(__file__).with_name('cloudbuild-publish-status.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def protected_bytes(path):
    """User/Root custody, no writable ancestors, symlinks, hardlinks or races."""
    path = Path(path)
    require(path.is_absolute() and not path.is_relative_to(ROOT) and path.parent == CUSTODY_ROOT,
            'PROTECTED_ADMISSION_OUTSIDE_SOURCE_REQUIRED')
    owners = {0, os.geteuid()}
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in owners and not info.st_mode & 0o022,
                'RELEASE_CUSTODY_PARENT_UNSAFE')
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_uid in owners
            and stat.S_IMODE(before.st_mode) == 0o600 and before.st_nlink == 1, 'RELEASE_CUSTODY_FILE_UNSAFE')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        opened = os.fstat(stream.fileno()); raw = stream.read(MAX_JSON+1)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        require(identity(before) == identity(opened) == identity(os.fstat(stream.fileno()))
                == identity(path.lstat()) and 0 < len(raw) <= MAX_JSON, 'RELEASE_CUSTODY_CHANGED')
    return raw


def command(argv, *, raw=False, data=None):
    result = subprocess.run(argv, input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=120)
    require(result.returncode == 0 and 0 < len(result.stdout) <= MAX_JSON, 'RELEASE_NATIVE_READ_FAILED')
    return result.stdout if raw else parse(result.stdout)


def gcloud():
    return os.environ.get('COMMERCE_GCLOUD', 'gcloud')


def common():
    return ['--project='+PROJECT, '--account='+operator_identity.local_account('cloud_build'), '--format=json']


def object_uri(value):
    require(type(value) is str and re.fullmatch(r'gs://[a-z0-9][a-z0-9._-]{1,221}/[A-Za-z0-9_./-]+#[1-9][0-9]*', value)
            and '..' not in value.split('/'), 'IMMUTABLE_ARTIFACT_GENERATION_REQUIRED')
    return value


def validate_admission(value):
    require(type(value) is dict and set(value) == {'schema_version', 'verification_manifest', 'package_manifest'}
            and value['schema_version'] == 1, 'RELEASE_ADMISSION_SHAPE_INVALID')
    verify = value['verification_manifest']; bootstrap().validate_manifest(verify)
    package = value['package_manifest']
    require(type(package) is dict, 'PACKAGE_ADMISSION_SHAPE_INVALID')
    context = validate_context(package['context'])
    require(context['source_sha'] == verify['source_sha'] and context['source_tree'] == verify['source_tree']
            and context['verification_build_id'] == verify['build_id']
            and context['verification_manifest_sha256'] == bootstrap().canonical_hash(verify),
            'VERIFICATION_PACKAGE_BINDING_MISMATCH')
    if context['package_origin'] == 'canonical-local':
        require(set(package) == {'context','archive_sha256','archive_bytes','package_manifest_sha256'}
                and sha(package['archive_sha256']) and sha(package['package_manifest_sha256'])
                and type(package['archive_bytes']) is int and 0 < package['archive_bytes'] <= 3*1024**3,
                'LOCAL_PACKAGE_ADMISSION_INVALID')
        return context
    require(set(package) == {'context', 'source_archive_sha256', 'storage_source', 'build_config'}
            and sha(package['source_archive_sha256']), 'PACKAGE_ADMISSION_SHAPE_INVALID')
    bootstrap().source(package['storage_source'])
    config = package['build_config']
    require(type(config) is dict and set(config) == {'steps','serviceAccount','timeout','queueTtl','options','substitutions','artifacts'}
            and bootstrap().canonical_hash(config) == context['package_config_sha256'], 'PACKAGE_CONFIG_BINDING_MISMATCH')
    require(config['timeout'] == '1800s' and config['queueTtl'] == '600s'
            and config['options'] == {'logging':'CLOUD_LOGGING_ONLY','sourceProvenanceHash':['SHA256'],'automapSubstitutions':False},
            'PACKAGE_BUILD_BOUNDS_CHANGED')
    require(config['serviceAccount'] == 'projects/$PROJECT_ID/serviceAccounts/commerce-v7-package@$PROJECT_ID.iam.gserviceaccount.com'
            and type(config['steps']) is list and len(config['steps']) == 1, 'PACKAGE_SERVICE_ACCOUNT_REQUIRED')
    step = config['steps'][0]
    require(step.get('id') == 'Commerce-V7-package' and step.get('name') == 'gcr.io/cloud-builders/docker'
            and step.get('entrypoint') == 'bash' and step.get('timeout') == '1800s', 'PACKAGE_STEP_REQUIRED')
    bootstrap().normalize_step(step)
    substitutions = config['substitutions']
    require(type(substitutions) is dict and set(substitutions) == {'COMMIT_SHA','_PACKAGE_IMAGE','_VERIFY_BUILD_ID','_VERIFY_MANIFEST_SHA256','_PACKAGE_DRIVER_SHA256','_ARTIFACT_BUCKET'}
            and substitutions['COMMIT_SHA'] == context['source_sha']
            and substitutions['_PACKAGE_IMAGE'] == context['package_image']
            and substitutions['_VERIFY_BUILD_ID'] == context['verification_build_id']
            and substitutions['_VERIFY_MANIFEST_SHA256'] == context['verification_manifest_sha256']
            and substitutions['_PACKAGE_DRIVER_SHA256'] == context['package_driver_sha256']
            and re.fullmatch(r'[a-z0-9][a-z0-9._-]{1,221}', substitutions['_ARTIFACT_BUCKET']), 'PACKAGE_SUBSTITUTIONS_MISMATCH')
    require(config['artifacts'] == {'objects':{'location':'gs://${_ARTIFACT_BUCKET}/releases/$BUILD_ID/',
            'paths':['release/commerce-os.tar']}}, 'PACKAGE_EXPORT_SCOPE_CHANGED')
    return context


def package_native(admission, build, project_number):
    context = validate_admission(admission); package = admission['package_manifest']; config = package['build_config']
    cb = bootstrap()
    require(type(build) is dict and build.get('projectId') == PROJECT and build.get('id') == context['package_build_id']
            and build.get('name') in {'projects/'+str(project)+'/locations/'+context['region']+'/builds/'+context['package_build_id']
                    for project in (PROJECT, project_number)} and build.get('status') == 'SUCCESS'
            and not build.get('buildTriggerId'), 'PACKAGE_NATIVE_BUILD_MISMATCH')
    require(not any(build.get(key) for key in ('secrets','availableSecrets','images','dependencies','gitConfig')),
            'PACKAGE_UNEXPECTED_NATIVE_INPUT')
    require(build.get('source') == {'storageSource':package['storage_source']}, 'PACKAGE_NATIVE_SOURCE_MISMATCH')
    substitutions = {**config['substitutions'], 'PROJECT_ID':PROJECT, 'BUILD_ID':context['package_build_id']}
    require(build.get('substitutions') == config['substitutions'], 'PACKAGE_NATIVE_SUBSTITUTIONS_MISMATCH')
    for key in ('serviceAccount','timeout','queueTtl','artifacts'):
        require(build.get(key) in (config[key], cb.expanded(config[key], substitutions)), 'PACKAGE_NATIVE_CONFIG_MISMATCH')
    options = build.get('options', {})
    require(type(options) is dict and set(options) <= set(cb.OPTION_DEFAULTS)
            and {key:options.get(key,default) for key,default in cb.OPTION_DEFAULTS.items()}
                == {**cb.OPTION_DEFAULTS, **config['options']}, 'PACKAGE_NATIVE_OPTIONS_MISMATCH')
    steps = build.get('steps')
    require(type(steps) is list and len(steps) == 1 and steps[0].get('status') == 'SUCCESS'
            and steps[0].get('exitCode',0) == 0, 'PACKAGE_NATIVE_STEP_FAILED')
    expected = cb.normalize_step(config['steps'][0]); actual = cb.normalize_step(steps[0])
    require(actual in (expected, cb.expanded(expected,substitutions)), 'PACKAGE_NATIVE_STEP_CHANGED')
    provenance = build.get('sourceProvenance', {})
    require(provenance.get('resolvedStorageSource') == package['storage_source'], 'PACKAGE_NATIVE_GENERATION_MISMATCH')
    hashes = provenance.get('fileHashes', {}); source = package['storage_source']
    uri = 'gs://'+source['bucket']+'/'+source['object']
    require(type(hashes) is dict and len(hashes) == 1 and next(iter(hashes)) in (uri,uri+'#'+str(source['generation'])),
            'PACKAGE_NATIVE_SOURCE_HASH_MISMATCH')
    expected = base64.b64encode(bytes.fromhex(package['source_archive_sha256'])).decode()
    require(any(item.get('type') == 'SHA256' and item.get('value') == expected
                for item in next(iter(hashes.values())).get('fileHash', [])), 'PACKAGE_NATIVE_SOURCE_HASH_MISMATCH')
    result = build.get('results', {})
    prefix = 'gs://'+config['substitutions']['_ARTIFACT_BUCKET']+'/releases/'+context['package_build_id']+'/'
    manifest = object_uri(result.get('artifactManifest'))
    require(manifest.split('#')[0] == prefix+'artifacts-'+context['package_build_id']+'.json'
            and str(result.get('numArtifacts')) == '1', 'PACKAGE_NATIVE_ARTIFACT_MANIFEST_MISMATCH')
    return manifest, prefix


def archive_record(raw, prefix):
    """Native manifests are JSON records; accept a JSON array or newline records."""
    require(type(raw) is bytes and 0 < len(raw) <= MAX_JSON, 'PACKAGE_ARTIFACT_MANIFEST_BOUND')
    try:
        value = json.loads(raw)
        entries = value if type(value) is list else [value]
    except (ValueError, UnicodeError):
        entries = [parse(line) for line in raw.splitlines() if line.strip()]
    require(len(entries) == 1 and type(entries[0]) is dict and set(entries[0]) == {'location','file_hash'},
            'PACKAGE_ARTIFACT_MANIFEST_SHAPE_INVALID')
    entry = entries[0]; uri = object_uri(entry['location']); checksum = entry['file_hash']
    require(uri.split('#')[0] == prefix+'commerce-os.tar' and type(checksum) is dict
            and set(checksum) == {'type','value'} and checksum['type'] == 2
            and type(checksum['value']) is str, 'PACKAGE_ARTIFACT_RECORD_INVALID')
    try:
        require(len(base64.b64decode(checksum['value'], validate=True)) == 16, 'PACKAGE_ARTIFACT_MD5_INVALID')
    except ValueError:
        require(False, 'PACKAGE_ARTIFACT_MD5_INVALID')
    return entry


def package_receipt(entries, context):
    matches = []
    require(type(entries) is list, 'PACKAGE_LOGS_INVALID')
    for entry in entries:
        payload = entry.get('jsonPayload')
        if payload is None and type(entry.get('textPayload')) is str:
            try: payload = json.loads(entry['textPayload'])
            except ValueError: continue
        if type(payload) is not dict or payload.get('kind') != PACKAGE_GATE: continue
        labels = entry.get('resource',{}).get('labels',{})
        require(entry.get('resource',{}).get('type') == 'build' and labels.get('project_id') == PROJECT
                and labels.get('build_id') == context['package_build_id'], 'PACKAGE_LOG_IDENTITY_MISMATCH')
        matches.append(payload)
    require(len(matches) == 1, 'PACKAGE_RECEIPT_UNIQUE_REQUIRED')
    value = matches[0]
    require(set(value) == {'kind','schema_version','status','context','archive_sha256','archive_bytes'}
            and value['schema_version'] == 1 and value['status'] == 'PACKAGED'
            and value['context'] == context and sha(value['archive_sha256'])
            and type(value['archive_bytes']) is int and 0 < value['archive_bytes'] <= 3*1024**3,
            'PACKAGE_RECEIPT_MISMATCH')
    return value


def evaluate(admission, archive, *, runner=command):
    context = validate_admission(admission); cb = bootstrap()
    # The bootstrap reader uses authenticated native calls and rechecks all FULL stages.
    def bootstrap_runner(argv, data=None):
        return runner(argv, data=None if data is None else json.dumps(data).encode())
    require(cb.evaluate(admission['verification_manifest'], gcloud(), bootstrap_runner)['state'] == 'success',
            'NATIVE_FULL_REQUIRED')
    if context['package_origin'] == 'canonical-local':
        package = admission['package_manifest']; archive = Path(archive)
        require(archive.is_file() and not archive.is_symlink()
                and archive.stat().st_size == package['archive_bytes']
                and digest(archive) == package['archive_sha256'], 'LOCAL_PACKAGE_ARCHIVE_CHANGED')
        validate_local_package(archive, package)
        return {'context':context,'archive_sha256':package['archive_sha256'],'artifact_uri':None}
    project = runner([gcloud(),'projects','describe',PROJECT,*common()])
    require(project.get('projectId') == PROJECT and re.fullmatch(r'[1-9][0-9]*',str(project.get('projectNumber'))),
            'PACKAGE_PROJECT_MISMATCH')
    build = runner([gcloud(),'builds','describe',context['package_build_id'],'--region='+context['region'],*common()])
    manifest_uri, prefix = package_native(admission, build, project['projectNumber'])
    entry = archive_record(runner([gcloud(),'storage','cat',manifest_uri,'--account='+operator_identity.local_account('cloud_build')],raw=True),prefix)
    query = 'resource.type="build" AND resource.labels.build_id="'+context['package_build_id']+'" AND resource.labels.project_id="'+PROJECT+'" AND "'+PACKAGE_GATE+'"'
    receipt = package_receipt(runner([gcloud(),'logging','read',query,'--freshness=90d','--limit=100',*common()]),context)
    archive = Path(archive)
    require(archive.is_file() and not archive.is_symlink() and archive.stat().st_size == receipt['archive_bytes']
            and digest(archive) == receipt['archive_sha256'], 'PACKAGE_LOCAL_ARCHIVE_MISMATCH')
    md5 = hashlib.md5()
    with archive.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''): md5.update(chunk)
    require(base64.b64encode(md5.digest()).decode() == entry['file_hash']['value'], 'PACKAGE_NATIVE_ARCHIVE_MISMATCH')
    return {'context':context,'archive_sha256':receipt['archive_sha256'],'artifact_uri':entry['location']}


def validate_local_package(archive, package, root=ROOT):
    """Compare shipped source bytes to the immutable Git tree, not just labels."""
    context = package['context']; root = Path(root)
    def git(*args):
        return subprocess.check_output(['git',*args],cwd=root,timeout=60)
    require(git('rev-parse','HEAD').decode().strip() == context['source_sha']
            and git('rev-parse','HEAD^{tree}').decode().strip() == context['source_tree']
            and not git('status','--porcelain','--untracked-files=all').strip(), 'LOCAL_PACKAGE_SOURCE_NOT_EXACT')
    require(digest(root/'scripts/package-ci.py') == context['packager_sha256'], 'LOCAL_PACKAGER_CHANGED')
    spec = importlib.util.spec_from_file_location('admitted_packager',root/'scripts/package-ci.py')
    packager = importlib.util.module_from_spec(spec); spec.loader.exec_module(packager)
    expected = {}
    for row in git('ls-tree','-rz',context['source_sha']).split(b'\0'):
        if not row: continue
        header,name = row.split(b'\t',1); name = name.decode(); mode,kind,blob = header.split()
        if packager.release_source(name):
            require(kind == b'blob' and mode in (b'100644',b'100755'), 'LOCAL_PACKAGE_GIT_SOURCE_INVALID')
            expected[name] = blob.decode()
    with tempfile.TemporaryDirectory(prefix='commerce-release-validation-') as directory:
        extracted = Path(directory)/'package'
        extract_release(archive,extracted,package['archive_sha256'])
        require(digest(extracted/'PACKAGE.sha256') == package['package_manifest_sha256'], 'LOCAL_PACKAGE_MANIFEST_CHANGED')
        actual = {p.relative_to(extracted).as_posix() for p in extracted.rglob('*')
                  if p.is_file() and p.relative_to(extracted).as_posix().startswith(('scripts/','infra/','packages/db/migrations/'))}
        require(actual == set(expected), 'LOCAL_PACKAGE_SHIPPED_SOURCE_SET_MISMATCH')
        for name,blob in expected.items():
            raw = (extracted/name).read_bytes()
            require(hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest() == blob,
                    'LOCAL_PACKAGE_SHIPPED_SOURCE_CHANGED')
        metadata = parse((extracted/'RELEASE.json').read_bytes())
        run_id = cloud_installation_id(context['verification_build_id'],1,local_package=True)
        require(release_identity(metadata,context['source_sha'],run_id,'copy-runtime') == context,
                'LOCAL_PACKAGE_METADATA_CHANGED')


def deployment_admission(path, root, attempt, *, runner=command):
    require(type(attempt) is str and re.fullmatch(r'[1-9][0-9]{0,5}',attempt), 'INSTALLATION_ATTEMPT_REQUIRED')
    admission = parse(protected_bytes(path))
    publication_enabled(validate_admission(admission))
    admitted = evaluate(admission, Path(root)/'release/commerce-os.tar',runner=runner)
    context = admitted['context']
    local = context['package_origin'] == 'canonical-local'
    return {**admitted,'source_sha':context['source_sha'],
        'installation_run_id':cloud_installation_id(context['verification_build_id' if local else 'package_build_id'],
            int(attempt),local_package=local)}


def installed_readback(run_id, *, runner=command):
    """IAP with one ephemeral key; the worker never receives this identity."""
    require(CLOUD_RUN.fullmatch(run_id) or LOCAL_RUN.fullmatch(run_id), 'INSTALLATION_ID_REQUIRED')
    instance = runner([gcloud(),'compute','instances','describe','commerce-os-test','--zone=us-east1-d',*common()])
    require(type(instance) is dict and str(instance.get('id')) == '6334472381123916728'
            and instance.get('name') == 'commerce-os-test'
            and instance.get('zone') == 'https://www.googleapis.com/compute/v1/projects/'+PROJECT+'/zones/us-east1-d',
            'PUBLISHER_VM_IDENTITY_MISMATCH')
    from ephemeral_os_login import remove_ephemeral_key
    with tempfile.TemporaryDirectory(prefix='commerce-publisher-read-') as directory:
        key = Path(directory)/'key'
        subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-C','commerce-release-readback','-f',str(key)],
                       check=True,timeout=30,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            collector = (ROOT/'scripts/cloudbuild-installed-readback.py').read_bytes()
            result = runner([gcloud(),'compute','ssh','commerce-os-test','--project='+PROJECT,'--account='+operator_identity.local_account('cloud_build'),
                '--zone=us-east1-d','--tunnel-through-iap','--quiet','--ssh-key-file='+str(key),
                '--ssh-key-expire-after=5m','--command=sudo /usr/bin/python3 - '+run_id,'--','-T'],data=collector)
        finally:
            public = key.with_suffix('.pub').read_text()
            def cleanup(argv):
                # The helper removes only this exact public key, never shared keys.
                argv = [gcloud(),*argv[1:],'--account='+operator_identity.local_account('cloud_build')]
                return subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=60)
            remove_ephemeral_key(public,cleanup)
    require(type(result) is dict and result.get('custody') == 'ROOT_NATIVE_READBACK', 'ROOT_NATIVE_READBACK_REQUIRED')
    return result


def https_json(url):
    require(url in {ORIGIN+'/api/version','https://ciclo.inovaris.online/api/version'}, 'PUBLIC_VERSION_URL_REQUIRED')
    with urllib.request.urlopen(urllib.request.Request(url,headers={'Cache-Control':'no-cache'}),timeout=30) as response:
        require(response.status == 200 and response.geturl() == url, 'PUBLIC_VERSION_RESPONSE_INVALID')
        return parse(response.read(65537))


def validate_installed(admitted, observation, core, portal):
    context = admitted['context']; run_id = admitted['installation_run_id']
    require(type(observation) is dict and set(observation) == {'schema_version','custody','report','report_ref','metadata_sha256'}
            and observation['schema_version'] == 1 and observation['custody'] == 'ROOT_NATIVE_READBACK',
            'ROOT_NATIVE_READBACK_REQUIRED')
    report = observation['report']; reference = observation['report_ref']
    require(type(reference) is dict and set(reference) == {'path','bytes','sha256'}
            and reference['path'] == '/opt/commerce-os/private/deployments/'+run_id+'/report.json'
            and type(reference['bytes']) is int and 0 < reference['bytes'] <= 1024*1024
            and sha(reference['sha256']) and sha(observation['metadata_sha256']), 'ROOT_REPORT_REFERENCE_INVALID')
    expected = {'source_sha':context['source_sha'],'source_tree':context['source_tree'],'run_id':run_id,
        'archive_sha256':admitted['archive_sha256'],'provider_evidence':context,'status':'SUCCEEDED',
        'deployment_scope':'copy-runtime','runtime_stage':'OPERATING','consumers_started':True,
        'physical_sales_proven':False,'healthy_services':6,'https_web_parity':True,
        'release':'ci-'+run_id+'-'+context['source_sha'][:12]}
    require(type(report) is dict and all(report.get(key) == value for key,value in expected.items()), 'INSTALLED_REPORT_BINDING_MISMATCH')
    require(type(core) is dict and core.get('service') == 'commerce-api' and core.get('configured') is True
            and core.get('sha') == context['source_sha'] and type(core.get('release')) is str
            and report.get('core_version') == {'sha':core['sha'],'release':core['release']}, 'INSTALLED_CORE_HTTPS_MISMATCH')
    components = report.get('components')
    require(type(components) is dict and set(components) == {'runtime','web','portal'}, 'INSTALLED_COMPONENTS_REQUIRED')
    for name in ('runtime','web'):
        value = components[name]
        require(type(value) is dict and set(value) == {'action','source_sha','image'}
                and value['action'] == 'REPLACED' and value['source_sha'] == context['source_sha']
                and type(value['image']) is str and re.fullmatch(r'sha256:[a-f0-9]{64}',value['image']),
                'INSTALLED_COMPONENT_SOURCE_MISMATCH')
    preserved = components['portal']
    require(type(preserved) is dict and preserved.get('action') == 'PRESERVED' and sha(preserved.get('source_sha'),40)
            and type(portal) is dict and portal.get('release') == preserved['source_sha']
            and portal.get('activities') == 480, 'PRESERVED_PORTAL_HTTPS_MISMATCH')
    return report


def deployment_payload(admitted, observation, core, portal):
    report = validate_installed(admitted,observation,core,portal)
    context = admitted['context']
    return {'schema_version':2,'provider':PROVIDER,'package_origin':context['package_origin'],
        'source_sha':context['source_sha'],'source_tree':context['source_tree'],
        'verification_build_id':context['verification_build_id'],
        'package_build_id':context.get('package_build_id'),
        'installation_run_id':admitted['installation_run_id'],'archive_sha256':admitted['archive_sha256'],
        'installer_status':'SUCCEEDED','deployment_scope':'copy-runtime','runtime_stage':'OPERATING',
        'consumers_started':True,'components':report['components'],'root_report_sha256':observation['report_ref']['sha256'],
        'metadata_sha256':observation['metadata_sha256']}


def build_url(context):
    return 'https://console.cloud.google.com/cloud-build/builds;region='+context['region']+'/'+context['verification_build_id']+'?project='+PROJECT


def software_installation(deployment, status, verified_payload, context):
    """Routing guard used only after the caller revalidated native/custody data."""
    return (type(deployment) is dict and type(status) is dict
            and deployment.get('sha') == context['source_sha'] and deployment.get('payload') == verified_payload
            and status.get('state') == 'success' and status.get('environment_url') == ORIGIN
            and status.get('log_url') == build_url(context))
