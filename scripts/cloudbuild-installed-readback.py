#!/usr/bin/env python3
"""Fixed read-only Root collector for a canonical Cloud Build installation.

Returns only public identities and hashes. No environment, customer or token
file is read. Execute via the existing authenticated IAP/Root transport.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

MAX_BYTES = 1024*1024
RUN = re.compile(r'c[bv]-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}-[1-9][0-9]{0,5}')


def need(condition):
    if not condition: raise RuntimeError('INSTALLED_NATIVE_CUSTODY_REJECTED')


def read(path, *, uid=0, exact_mode=0o600):
    path = Path(path)
    for parent in path.parents:
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and not info.st_mode & 0o022)
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1
         and (stat.S_IMODE(before.st_mode) == exact_mode if exact_mode else not before.st_mode & 0o022))
    identity = lambda value:(value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as stream:
        opened = os.fstat(stream.fileno()); raw = stream.read(MAX_BYTES+1)
        need(identity(before) == identity(opened) == identity(os.fstat(stream.fileno())) == identity(path.lstat())
             and 0 < len(raw) <= MAX_BYTES)
    return raw


def document(raw):
    def pairs(items):
        result = {}
        for key,value in items:
            need(key not in result); result[key] = value
        return result
    return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:need(False))


def ref(path, raw):
    return {'path':str(path),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}


def installed_images(components, portal_state):
    ids = subprocess.check_output(['docker','ps','-q','--no-trunc'],timeout=30).decode().split()
    need(0 < len(ids) <= 20 and all(re.fullmatch(r'[a-f0-9]{64}',item) for item in ids))
    template = '{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}'
    raw = subprocess.check_output(['docker','inspect','--format',template,*ids],timeout=30)
    need(len(raw) <= MAX_BYTES)
    rows = [document(line) for line in raw.splitlines()]
    for service in ('api','web','ingress','automation-worker','channel-worker'):
        matches = [row for row in rows if row.get('service') == service]
        component = components['web' if service == 'web' else 'runtime']
        need(len(matches) == 1 and matches[0]['running'] is True and matches[0]['image'] == component['image']
             and matches[0]['revision'] == component['source_sha'])
    portals = [row for row in rows if row.get('id') == portal_state['container_id']]
    need(len(portals) == 1 and portals[0]['running'] is True and portals[0]['image'] == portal_state['image'])


def collect(run_id, base=Path('/opt/commerce-os')):
    need(os.geteuid() == 0 and RUN.fullmatch(run_id))
    private = base/'private'; report_path = private/'deployments'/run_id/'report.json'
    unit_raw = subprocess.check_output(['systemctl','show','commerce-ci-'+run_id+'.service',
        '--property=LoadState','--property=ActiveState','--property=MainPID','--no-pager'],timeout=30).decode()
    unit = dict(line.split('=',1) for line in unit_raw.splitlines() if '=' in line)
    need(unit.get('LoadState') in {'loaded','not-found'} and unit.get('ActiveState') in {'inactive','failed'}
         and unit.get('MainPID') == '0')
    report_raw = read(report_path); report = document(report_raw)
    need(report.get('run_id') == run_id and report.get('status') == 'SUCCEEDED'
         and report.get('deployment_scope') == 'copy-runtime' and report.get('runtime_stage') == 'OPERATING'
         and report.get('consumers_started') is True and report.get('physical_sales_proven') is False
         and report.get('https_web_parity') is True)
    current_link = base/'current'; link = current_link.lstat()
    need(stat.S_ISLNK(link.st_mode) and link.st_uid == 0)
    current = current_link.resolve(strict=True)
    need(current.parent == base/'releases' and current.name == report.get('release')
         and current.name == 'ci-'+run_id+'-'+report['source_sha'][:12])
    metadata = document(read(current/'RELEASE.json'))
    need(metadata.get('schema_version') == 2 and metadata.get('source_sha') == report['source_sha']
         and metadata.get('source_tree') == report.get('source_tree')
         and metadata.get('provider_evidence') == report.get('provider_evidence'))
    components = report.get('components'); need(type(components) is dict and set(components) == {'runtime','web','portal'})
    portal = components['portal']; state = document(read(private/'api-web-adoption.json'))
    need(state.get('runtime_stage') == 'OPERATING' and state.get('current_release') == str(current)
         and type(portal) is dict and portal.get('action') == 'PRESERVED')
    expected = {key:state['portal'][key] for key in ('source_sha','image','container_id','run_id','report_ref','manifest_ref')}
    need(portal == {'action':'PRESERVED',**expected})
    installed_images(components,state['portal'])
    for key in ('report_ref','manifest_ref'):
        reference = portal[key]; path = Path(reference['path'])
        need(path == Path('/opt/mcl-portal/current.json') if key == 'report_ref' else
             path.name == 'portal-manifest.json' and path.parent.parent == base/'releases')
        need(ref(path,read(path)) == reference)
    fields = ('source_sha','source_tree','run_id','status','deployment_scope','runtime_stage','consumers_started',
              'physical_sales_proven','healthy_services','https_web_parity','core_version','release','archive_sha256',
              'provider_evidence','components')
    need(all(key in report for key in fields))
    need(read(report_path) == report_raw and current_link.resolve(strict=True) == current)
    return {'schema_version':1,'custody':'ROOT_NATIVE_READBACK','report':{key:report[key] for key in fields},
            'report_ref':ref(report_path,report_raw),'metadata_sha256':hashlib.sha256(read(current/'RELEASE.json')).hexdigest()}


if __name__ == '__main__':
    try:
        need(len(sys.argv) == 2)
        print(json.dumps(collect(sys.argv[1]),sort_keys=True))
    except (RuntimeError,OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError):
        print(json.dumps({'status':'INSTALLED_NATIVE_CUSTODY_REJECTED'}))
        sys.exit(1)
