#!/usr/bin/env python3
"""Reconcile FULL + package + Root + HTTPS; GitHub writes require --publish.

This local publisher is the only Cloud Build deployment-status writer. Its
credentials never enter the verifier/packager worker. No installation is started.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import stat
import sys

from ci_release import require
import cloudbuild_release_evidence as evidence


def publish(payload, context, *, runner=evidence.command):
    prefix = 'repos/'+evidence.REPOSITORY
    # A previously attempted publication must be reconciled, never duplicated.
    rows = runner(['gh','api',prefix+'/deployments?environment=production&per_page=100'])
    require(type(rows) is list and len(rows) < 100, 'GITHUB_DEPLOYMENT_READBACK_REQUIRED')
    matches = [row for row in rows if type(row) is dict and type(row.get('payload')) is dict
               and row['payload'].get('installation_run_id') == payload['installation_run_id']]
    require(len(matches) <= 1, 'GITHUB_DEPLOYMENT_IDENTITY_AMBIGUOUS')
    status = {'state':'success','environment_url':evidence.ORIGIN,
              'log_url':evidence.build_url(context),'description':'Canonical Root and HTTPS readback verified',
              'auto_inactive':False}
    if matches:
        deployment = matches[0]
        require(deployment.get('sha') == context['source_sha'] and deployment.get('payload') == payload,
                'GITHUB_EXISTING_DEPLOYMENT_CONFLICT')
        existing = runner(['gh','api',prefix+'/deployments/'+str(deployment['id'])+'/statuses?per_page=1'])
        require(type(existing) is list and len(existing) == 1
                and evidence.software_installation(deployment,existing[0],payload,context),
                'GITHUB_PARTIAL_PUBLICATION_REQUIRES_RECONCILIATION')
        return deployment['id']
    body = {'ref':context['source_sha'],'task':'deploy','auto_merge':False,'required_contexts':[],
            'environment':'production','description':'Cloud Build FULL; canonical '+context['package_origin']+' package',
            'transient_environment':False,'production_environment':True,'payload':payload}
    deployment = runner(['gh','api','--method','POST',prefix+'/deployments','--input','-'],data=json.dumps(body).encode())
    require(type(deployment.get('id')) is int and deployment['id'] > 0, 'GITHUB_DEPLOYMENT_ID_REQUIRED')
    endpoint = prefix+'/deployments/'+str(deployment['id'])
    created = runner(['gh','api','--method','POST',endpoint+'/statuses','--input','-'],data=json.dumps(status).encode())
    require(type(created.get('id')) is int, 'GITHUB_DEPLOYMENT_STATUS_ID_REQUIRED')
    readback = runner(['gh','api',endpoint]); statuses = runner(['gh','api',endpoint+'/statuses?per_page=1'])
    require(type(statuses) is list and len(statuses) == 1 and statuses[0].get('id') == created['id']
            and evidence.software_installation(readback,statuses[0],payload,context), 'GITHUB_PUBLICATION_READBACK_MISMATCH')
    return deployment['id']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--admission',type=Path,required=True)
    parser.add_argument('--attempt',default='1')
    parser.add_argument('--publish',action='store_true')
    args = parser.parse_args(); attempted = False
    try:
        # Validate custody before creating the one publisher lock in that directory.
        evidence.protected_bytes(args.admission)
        lock_path = evidence.CUSTODY_ROOT/'publisher.lock'
        fd = os.open(lock_path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'r+') as lock:
            info = os.fstat(lock.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                    and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1, 'PUBLISHER_LOCK_CUSTODY_REQUIRED')
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            admitted = evidence.deployment_admission(args.admission,evidence.ROOT,args.attempt)
            observation = evidence.installed_readback(admitted['installation_run_id'])
            core = evidence.https_json(evidence.ORIGIN+'/api/version')
            portal = evidence.https_json('https://ciclo.inovaris.online/api/version')
            payload = evidence.deployment_payload(admitted,observation,core,portal)
            # Reread after all native requests; do not publish against changed input.
            fresh = evidence.deployment_admission(args.admission,evidence.ROOT,args.attempt)
            require(fresh == admitted, 'RELEASE_ADMISSION_CHANGED_DURING_READBACK')
            deployment_id = None
            if args.publish:
                attempted = True
                deployment_id = publish(payload,admitted['context'])
            print(json.dumps({'status':'CANONICAL_INSTALLATION_VALIDATED','published':args.publish,
                'source_sha':admitted['source_sha'],'installation_run_id':admitted['installation_run_id'],
                'deployment_id':deployment_id,'package_origin':admitted['context']['package_origin'],
                'automatic_ci_proven':False},sort_keys=True))
        return 0
    except Exception as error:
        # Do not disclose native stderr, report contents, paths or credentials.
        code = str(error) if type(error).__name__ in {'ReleaseError','EvidenceError'} else type(error).__name__
        print(json.dumps({'status':'PUBLICATION_OUTCOME_UNKNOWN' if attempted else 'EVIDENCE_REJECTED',
                          'published':None if attempted else False,'code':code},sort_keys=True))
        return 2


if __name__ == '__main__': sys.exit(main())
