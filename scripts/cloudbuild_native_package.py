"""Native package preparation and authenticated evidence, without a personal CLI.

Only the trusted controller/publisher image imports this module. Preparation is
pure; the controller must reserve 1800s and commit its single-dispatch intent
before creating the Build. Readers never create builds or start installations.
The Root publication gate remains closed until native end-to-end validation.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import urllib.error
import urllib.parse
import urllib.request

from ci_release import require
from ci_provider_evidence import PROJECT, PROVIDER, REPOSITORY, validate_context, sha
from cloudbuild_full_evidence import canonical_hash, validate_manifest
from cloudbuild_native_reader import BUILD_ROOT, LOG_URL, NoRedirect, decode
import cloudbuild_release_evidence as evidence

MAX_JSON = 4 * 1024**2
MAX_ARCHIVE = 3 * 1024**3
PACKAGE_SECONDS = 1800
INNER_SECONDS = 1740
PACKAGE_SHELL = r'''[[ "$$EXPECTED_SHA" =~ ^[a-f0-9]{40}$$ ]] || exit 1
[[ "$$BUILD_IDENTITY" =~ ^[a-f0-9-]{36}$$ ]] || exit 1
[[ "$$PACKAGE_IMAGE" =~ ^[a-z0-9-]+-docker.pkg.dev/"$$PACKAGE_PROJECT"/commerce-ci-public/package@sha256:[a-f0-9]{64}$$ ]] || exit 1
workspace_source="$$(docker inspect "$$HOSTNAME" --format '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}')"
[[ "$$workspace_source" =~ ^/[a-zA-Z0-9_./-]+$$ ]] || exit 1
docker pull "$$PACKAGE_IMAGE"
exec docker run --rm --init --network=host \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --mount "type=bind,source=$$workspace_source,target=$$workspace_source" \
  --workdir "$$workspace_source" "$$PACKAGE_IMAGE" \
  --source "$$workspace_source" --build-id "$$BUILD_IDENTITY" \
  --inputs-base64 "$$PACKAGE_INPUTS"
'''


def package_inputs(verification, image, driver_sha256, packager_sha256, bucket):
    validate_manifest(verification)
    require(sha(driver_sha256) and sha(packager_sha256), 'PACKAGE_DRIVER_HASH_REQUIRED')
    require(type(image) is str and re.fullmatch(
        r'[a-z0-9-]+-docker\.pkg\.dev/' + re.escape(PROJECT) +
        r'/commerce-ci-public/package@sha256:[a-f0-9]{64}', image), 'PACKAGE_IMAGE_REQUIRED')
    require(type(bucket) is str and re.fullmatch(r'[a-z0-9][a-z0-9._-]{1,221}', bucket),
            'PACKAGE_BUCKET_REQUIRED')
    return {'source_sha':verification['source_sha'], 'source_tree':verification['source_tree'],
            'region':verification['region'], 'verification_build_id':verification['build_id'],
            'verification_manifest_sha256':canonical_hash(verification),
            'package_image':image, 'package_driver_sha256':driver_sha256,
            'packager_sha256':packager_sha256, 'artifact_bucket':bucket}


def validate_inputs(value):
    require(type(value) is dict and set(value) == {'source_sha','source_tree','region',
            'verification_build_id','verification_manifest_sha256','package_image',
            'package_driver_sha256','packager_sha256','artifact_bucket'}, 'PACKAGE_INPUTS_INVALID')
    # The shared contract validates all identity fields, using a distinct UUID
    # only to check shape; it is never emitted as an actual Build identity.
    from ci_provider_evidence import build_uuid
    require(build_uuid(value['verification_build_id']) and
            all(sha(value[k],40) for k in ('source_sha','source_tree')) and
            all(sha(value[k]) for k in ('verification_manifest_sha256','package_driver_sha256','packager_sha256')),
            'PACKAGE_INPUT_BINDING_INVALID')
    require(type(value['region']) is str and re.fullmatch(r'[a-z]+-[a-z]+[0-9]',value['region']) and
            type(value['package_image']) is str and re.fullmatch(r'[a-z0-9-]+-docker\.pkg\.dev/'+
            re.escape(PROJECT)+r'/commerce-ci-public/package@sha256:[a-f0-9]{64}',value['package_image']) and
            type(value['artifact_bucket']) is str and re.fullmatch(r'[a-z0-9][a-z0-9._-]{1,221}',value['artifact_bucket']),
            'PACKAGE_INPUT_SCOPE_INVALID')
    return value


def build_config(inputs):
    """Trusted inline template. No candidate YAML or mutable image reference."""
    v = validate_inputs(inputs)
    encoded = base64.b64encode(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).decode()
    return {'serviceAccount':'projects/$PROJECT_ID/serviceAccounts/commerce-v7-package-core@$PROJECT_ID.iam.gserviceaccount.com',
            'timeout':'1800s','queueTtl':'600s',
            'options':{'logging':'CLOUD_LOGGING_ONLY','sourceProvenanceHash':['SHA256'],'automapSubstitutions':False},
            'substitutions':{'COMMIT_SHA':v['source_sha'],'_PACKAGE_IMAGE':v['package_image'],
                '_VERIFY_BUILD_ID':v['verification_build_id'],'_VERIFY_MANIFEST_SHA256':v['verification_manifest_sha256'],
                '_PACKAGE_DRIVER_SHA256':v['package_driver_sha256'],'_ARTIFACT_BUCKET':v['artifact_bucket']},
            'steps':[{'id':'Commerce-V7-package','name':'gcr.io/cloud-builders/docker',
                'entrypoint':'bash','timeout':'1800s','env':['EXPECTED_SHA=$COMMIT_SHA','BUILD_IDENTITY=$BUILD_ID',
                    'PACKAGE_IMAGE=${_PACKAGE_IMAGE}','PACKAGE_PROJECT=$PROJECT_ID','PACKAGE_INPUTS='+encoded,
                    # Every declared substitution is used, so MUST_MATCH stays enabled.
                    'VERIFY_BUILD_ID=${_VERIFY_BUILD_ID}','VERIFY_MANIFEST_SHA256=${_VERIFY_MANIFEST_SHA256}',
                    'PACKAGE_DRIVER_SHA256=${_PACKAGE_DRIVER_SHA256}'], 'args':['-euc',PACKAGE_SHELL]}],
            'artifacts':{'objects':{'location':'gs://${_ARTIFACT_BUCKET}/releases/$BUILD_ID/',
                                   'paths':['release/commerce-os.tar']}}}


def context(inputs, build_id):
    v = validate_inputs(inputs)
    result = {'schema_version':1,'provider':PROVIDER,'repository':REPOSITORY,'project':PROJECT,
        **{k:v[k] for k in ('source_sha','source_tree','region','verification_build_id',
                           'verification_manifest_sha256','package_image','package_driver_sha256')},
        'package_origin':'cloud-build','package_build_id':build_id,
        'package_config_sha256':canonical_hash(build_config(v))}
    return validate_context(result)


def source_replica(verification, replica):
    """Bind an authenticated replica receipt; this pure guard is not its reader.

    The controller produces and re-reads the exclusive destination generation
    before supplying this protected receipt. Native Build provenance checks its
    actual SHA256 again. A unique locator preserves ambiguous-create recovery.
    """
    from cloudbuild_full_evidence import source
    require(type(replica) is dict and set(replica) == {'origin','storage_source','archive_sha256'},
            'PACKAGE_SOURCE_REPLICA_REQUIRED')
    origin=source(replica['origin']); target=source(replica['storage_source'])
    require(origin==source(verification['storage_source']) and target!=origin and
            (target['bucket'],target['object'])!=(origin['bucket'],origin['object']) and
            replica['archive_sha256']==verification['archive_sha256'], 'PACKAGE_SOURCE_REPLICA_CHANGED')
    return target


def admission(verification, inputs, build_id, replica):
    validate_manifest(verification)
    require(package_inputs(verification,inputs['package_image'],inputs['package_driver_sha256'],
                           inputs['packager_sha256'],inputs['artifact_bucket']) == inputs,
            'PACKAGE_VERIFICATION_BINDING_CHANGED')
    result = {'schema_version':1,'verification_manifest':verification,'package_manifest':{
        'context':context(inputs,build_id),'source_archive_sha256':verification['archive_sha256'],
        'storage_source':source_replica(verification,replica),'build_config':build_config(inputs)}}
    evidence.validate_admission(result)
    return result


def create_request(verification, inputs, replica):
    """No API call. Controller adds durable intent/reservation before POST."""
    validate_manifest(verification)
    require(package_inputs(verification,inputs['package_image'],inputs['package_driver_sha256'],
                           inputs['packager_sha256'],inputs['artifact_bucket']) == inputs,
            'PACKAGE_VERIFICATION_BINDING_CHANGED')
    return {**build_config(inputs),'source':{'storageSource':source_replica(verification,replica)}}


class GooglePackageReader:
    """Bounded ADC REST reads; source/FULL verification is injected separately."""
    def __init__(self, token_provider, full_reader, *, opener=None):
        self.token_provider = token_provider
        self.full_reader = full_reader
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())

    def _open(self, method, url, payload=None):
        allowed = (method == 'GET' and (url.startswith(BUILD_ROOT) or
                   url.startswith('https://storage.googleapis.com/storage/v1/b/'))) or (method == 'POST' and url == LOG_URL)
        require(allowed, 'PACKAGE_READ_TARGET_INVALID')
        try:
            token = self.token_provider()
            require(type(token) is str and token and not any(c.isspace() for c in token), 'PACKAGE_TOKEN_UNAVAILABLE')
            body = None if payload is None else json.dumps(payload,separators=(',',':')).encode()
            request = urllib.request.Request(url,data=body,method=method,headers={
                'Authorization':'Bearer '+token,'Accept':'application/json','Accept-Encoding':'identity',
                'Content-Type':'application/json'})
            response = self.opener.open(request,timeout=20)
        except urllib.error.HTTPError as error:
            error.close()
            raise RuntimeError('PACKAGE_READ_HTTP_ERROR') from None
        except (OSError,ValueError):
            raise RuntimeError('PACKAGE_READ_UNCERTAIN') from None
        if response.status != 200 or response.headers.get('Content-Encoding','identity') != 'identity':
            response.close()
            raise RuntimeError('PACKAGE_READ_UNCONFIRMED')
        return response

    def _json(self, method, url, payload=None):
        with self._open(method,url,payload) as response:
            return decode(response.read(MAX_JSON+1))

    @staticmethod
    def object_url(uri, *, media=False):
        evidence.object_uri(uri)
        location,generation = uri[5:].rsplit('#',1)
        bucket,name = location.split('/',1)
        return ('https://storage.googleapis.com/storage/v1/b/'+bucket+'/o/'+urllib.parse.quote(name,safe='')+
                '?'+urllib.parse.urlencode({'generation':generation,**({'alt':'media'} if media else {})}))

    def object_metadata(self, uri, maximum):
        value = self._json('GET',self.object_url(uri))
        location,generation = uri[5:].rsplit('#',1); bucket,name = location.split('/',1)
        require(value.get('bucket') == bucket and value.get('name') == name and value.get('generation') == generation
                and value.get('contentEncoding') in (None,'identity') and type(value.get('size')) is str
                and re.fullmatch('[1-9][0-9]{0,10}',value['size']) and int(value['size']) <= maximum,
                'PACKAGE_OBJECT_IDENTITY_MISMATCH')
        return value

    def object_bytes(self, uri, maximum=MAX_JSON):
        metadata = self.object_metadata(uri,maximum)
        with self._open('GET',self.object_url(uri,media=True)) as response:
            raw = response.read(int(metadata['size'])+1)
        require(len(raw) == int(metadata['size']), 'PACKAGE_OBJECT_SIZE_CHANGED')
        return raw

    def evidence(self, admitted):
        ctx = evidence.validate_admission(admitted)
        require(ctx['package_origin'] == 'cloud-build', 'NATIVE_PACKAGE_REQUIRED')
        require(self.full_reader.evaluate(admitted['verification_manifest'])['state'] == 'success', 'NATIVE_FULL_REQUIRED')
        project = self.full_reader.project()
        require(project.get('projectId') == PROJECT, 'PACKAGE_PROJECT_MISMATCH')
        build = self._json('GET',BUILD_ROOT+ctx['region']+'/builds/'+ctx['package_build_id'])
        manifest_uri,prefix = evidence.package_native(admitted,build,project.get('projectNumber'))
        artifact = evidence.archive_record(self.object_bytes(manifest_uri),prefix)
        query = ('resource.type="build" AND resource.labels.build_id="'+ctx['package_build_id']+
                 '" AND resource.labels.project_id="'+PROJECT+'" AND "'+evidence.PACKAGE_GATE+'"')
        entries=[]; seen=set(); page_token=None
        # Logging can return an empty page with a continuation token. Consume a
        # bounded complete query, preserving exactly-one receipt semantics.
        for _ in range(8):
            payload={'resourceNames':['projects/'+PROJECT],'filter':query,'pageSize':100,'orderBy':'timestamp asc'}
            if page_token: payload['pageToken']=page_token
            page=self._json('POST',LOG_URL,payload)
            require(set(page) <= {'entries','nextPageToken'} and type(page.get('entries',[])) is list,
                    'PACKAGE_LOG_RESPONSE_INVALID')
            entries.extend(page.get('entries',[]))
            require(len(entries)<=800,'PACKAGE_LOG_QUERY_BOUND')
            page_token=page.get('nextPageToken','')
            require(type(page_token) is str and len(page_token)<=4096,'PACKAGE_LOG_TOKEN_INVALID')
            if not page_token:break
            require(page_token not in seen,'PACKAGE_LOG_TOKEN_REPEATED');seen.add(page_token)
        else: raise RuntimeError('PACKAGE_LOG_QUERY_INCOMPLETE')
        receipt=evidence.package_receipt(entries,ctx)
        return {'context':ctx,'archive_sha256':receipt['archive_sha256'],'archive_bytes':receipt['archive_bytes'],
                'artifact_uri':artifact['location'],'artifact_md5':artifact['file_hash']['value'],
                'artifact_manifest_uri':manifest_uri}

    def download(self, verified, destination, reserve_transfer):
        """One GET, creation-exclusive; partial bytes/reservation survive error."""
        validate_context(verified['context'])
        require(sha(verified.get('archive_sha256')) and type(verified.get('archive_bytes')) is int and
                0<verified['archive_bytes']<=MAX_ARCHIVE,'PACKAGE_DOWNLOAD_BINDING_INVALID')
        uri=verified['artifact_uri']; metadata=self.object_metadata(uri,MAX_ARCHIVE)
        require(int(metadata['size'])==verified['archive_bytes'] and metadata.get('md5Hash')==verified['artifact_md5'],
                'PACKAGE_DOWNLOAD_METADATA_MISMATCH')
        destination=Path(destination)
        require(destination.is_absolute() and not os.path.lexists(destination),'PACKAGE_DOWNLOAD_NEW_PATH_REQUIRED')
        for parent in destination.parents:
            info=parent.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid in {0,os.geteuid()} and not info.st_mode&0o022,
                    'PACKAGE_DOWNLOAD_PARENT_UNSAFE')
        reserve_transfer(uri,verified['archive_bytes']+1)
        fd=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        total=0; digest=hashlib.sha256(); md5=hashlib.md5(); deadline=time.monotonic()+600
        with os.fdopen(fd,'wb') as output, self._open('GET',self.object_url(uri,media=True)) as response:
            while True:
                require(time.monotonic()<deadline,'PACKAGE_DOWNLOAD_TIME_BOUND')
                chunk=response.read(min(1024**2,verified['archive_bytes']+1-total))
                if not chunk:break
                total+=len(chunk)
                require(total<=verified['archive_bytes'],'PACKAGE_DOWNLOAD_OVERSIZE')
                output.write(chunk);digest.update(chunk);md5.update(chunk)
            output.flush();os.fsync(output.fileno())
        require(total==verified['archive_bytes'] and digest.hexdigest()==verified['archive_sha256'] and
                base64.b64encode(md5.digest()).decode()==verified['artifact_md5'],'PACKAGE_DOWNLOAD_HASH_MISMATCH')
        return {'path':str(destination),'bytes':total,'sha256':digest.hexdigest(),'artifact_uri':uri}
