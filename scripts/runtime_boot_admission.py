"""Pure transport and Root approval derivation from preserved original bytes.

No filesystem, credential, process or network operation occurs here. Only the
canonical Root hook supplies host identity and previously running gateway IDs;
those values cannot be selected by the transported publisher input document.
"""
import base64
import datetime as dt
import hashlib
import json
import re

from ci_release import require
import runtime_boot_install_gate as gate

MAX_RAW = 8*1024*1024
MAX_WIRE = 12*1024*1024
FILENAME = 'host-boot-inputs.json'
FIELDS = frozenset({'schema_version','kind','source_sha','installation_run_id','archive_sha256',
    'created_at','expires_at','native_originals','history'})
HISTORY = frozenset({'schema_version','restore_source_sha','originals','blobs'})


def sealed(value):
    return (json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode()


def checksum(raw): return hashlib.sha256(raw).hexdigest()


def record(raw):
    require(type(raw) is bytes and 0 < len(raw) <= gate.restore.MAX_ORIGINAL_BYTES,
        'BOOT_INPUT_ORIGINAL_BOUND')
    return {'bytes':len(raw),'sha256':checksum(raw),'base64':base64.b64encode(raw).decode()}


def original(value):
    require(type(value) is dict and set(value)=={'bytes','sha256','base64'}
        and type(value['bytes']) is int and 0 < value['bytes'] <= gate.restore.MAX_ORIGINAL_BYTES
        and type(value['sha256']) is str and re.fullmatch('[a-f0-9]{64}',value['sha256'])
        and type(value['base64']) is str and len(value['base64']) <= (value['bytes']+2)//3*4,
        'BOOT_INPUT_ORIGINAL_FIELDS')
    try: raw=base64.b64decode(value['base64'],validate=True)
    except ValueError: raise RuntimeError('BOOT_INPUT_ORIGINAL_ENCODING') from None
    require(len(raw)==value['bytes'] and checksum(raw)==value['sha256'], 'BOOT_INPUT_ORIGINAL_CHANGED')
    return raw


def history_bytes(history):
    require(type(history) is dict and set(history)==HISTORY and type(history['schema_version']) is int
        and history['schema_version']==1 and type(history['restore_source_sha']) is str
        and re.fullmatch('[a-f0-9]{40}',history['restore_source_sha'])
        and type(history['originals']) is dict and set(history['originals'])==gate.restore.ORIGINALS,
        'BOOT_INPUT_HISTORY_FIELDS')
    refs=history['originals']
    for ref in refs.values(): gate.restore.checked_reference(ref)
    require(type(history['blobs']) is dict and set(history['blobs'])=={r['sha256']for r in refs.values()},
        'BOOT_INPUT_HISTORY_BLOB_SET')
    blobs={key:original(value)for key,value in history['blobs'].items()}
    require(all(checksum(blobs[r['sha256']])==r['sha256'] and len(blobs[r['sha256']])==r['bytes']
        for r in refs.values()),'BOOT_INPUT_HISTORY_REFERENCE_CHANGED')
    return blobs


def pack_history(originals,read_original,*,restore_source_sha,now):
    """Produce a protected historical container; this does not refresh a restore."""
    blobs={}
    def read(ref):
        raw=read_original(ref)
        require(type(raw)is bytes and checksum(raw)==ref['sha256'] and len(raw)==ref['bytes'],
            'BOOT_INPUT_HISTORY_SOURCE_CHANGED')
        blobs[ref['sha256']]=record(raw);return raw
    gate.restore.validate_historical_restore(originals,read,expected_source_sha=restore_source_sha,now=now)
    value={'schema_version':1,'restore_source_sha':restore_source_sha,'originals':originals,'blobs':blobs}
    history_bytes(value)
    require(len(sealed(value)) <= 4*1024*1024,'BOOT_INPUT_HISTORY_CONTAINER_BOUND')
    return value


def unpack(raw):
    require(type(raw)is bytes and 0 < len(raw) <= MAX_WIRE,'BOOT_INPUT_WIRE_BOUND')
    value=gate.restore.decode(raw)
    require(set(value)==FIELDS and type(value['schema_version'])is int and value['schema_version']==1
        and value['kind']=='CANONICAL_HOST_BOOT_INPUTS' and sealed(value)==raw,'BOOT_INPUT_FIELDS')
    require(type(value['source_sha'])is str and re.fullmatch('[a-f0-9]{40}',value['source_sha'])
        and type(value['archive_sha256'])is str and re.fullmatch('[a-f0-9]{64}',value['archive_sha256'])
        and type(value['installation_run_id'])is str,'BOOT_INPUT_RELEASE_FIELDS')
    issued,expires=gate.restore.stamp(value['created_at']),gate.restore.stamp(value['expires_at'])
    require(issued < expires <= issued+dt.timedelta(minutes=15),'BOOT_INPUT_WINDOW_INVALID')
    require(type(value['native_originals'])is dict and set(value['native_originals'])==gate.NATIVE,
        'BOOT_INPUT_NATIVE_SET')
    native={name:original(item)for name,item in value['native_originals'].items()}
    historical=history_bytes(value['history'])
    require(sum(map(len,native.values()))+sum(map(len,historical.values())) <= MAX_RAW,'BOOT_INPUT_RAW_BOUND')
    return value,native,historical


def pack_inputs(admitted,native_originals,history,*,created_at,expires_at):
    value={'schema_version':1,'kind':'CANONICAL_HOST_BOOT_INPUTS','source_sha':admitted['source_sha'],
        'installation_run_id':admitted['installation_run_id'],'archive_sha256':admitted['archive_sha256'],
        'created_at':created_at.isoformat(),'expires_at':expires_at.isoformat(),
        'native_originals':{name:record(raw)for name,raw in native_originals.items()},'history':history}
    raw=sealed(value);unpack(raw);return raw


def produce(raw,*,report,host_id,gateway_start_ids,candidate_migrations,candidate_restore_sources,now):
    value,native,historical=unpack(raw)
    require(gate.restore.stamp(value['created_at']) <= now < gate.restore.stamp(value['expires_at']),
        'BOOT_INPUT_EXPIRED')
    require(value['source_sha']==report.get('source_sha') and value['archive_sha256']==report.get('archive_sha256')
        and value['installation_run_id']==report.get('run_id'),'BOOT_INPUT_REPORT_CHANGED')
    originals={}
    def ref(raw):
        path=gate.EVIDENCE/(checksum(raw)+'.json');originals[str(path)]=raw
        return {'path':str(path),'bytes':len(raw),'sha256':checksum(raw)}
    history=value['history']
    approval={'schema_version':1,'source_sha':value['source_sha'],'run_id':value['installation_run_id'],
        'archive_sha256':value['archive_sha256'],'host_id':host_id,'gateway_start_ids':gateway_start_ids,
        # Never renew the caller's admission window while processing/copying.
        'created_at':value['created_at'],'expires_at':value['expires_at'],
        'native_originals':{name:ref(body)for name,body in native.items()},
        'restore_source_sha':history['restore_source_sha'],'restore_originals':history['originals'],
        'restore_custody':{r['path']:ref(historical[r['sha256']])for r in history['originals'].values()}}
    def read(reference):
        body=originals[reference['path']]
        require(len(body)==reference['bytes'] and checksum(body)==reference['sha256'],'BOOT_INPUT_DERIVATION_CHANGED')
        return body
    validated=gate.validate(approval,report=report,host_id=host_id,candidate_migrations=candidate_migrations,
        candidate_restore_sources=candidate_restore_sources,now=now,reader=read)
    return {'approval':approval,'approval_raw':sealed(approval),'originals':originals,
        'input_sha256':checksum(raw),'validated':validated,'native_effects':False}
