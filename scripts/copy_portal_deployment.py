"""Initial portal transition over a verified API/web copy; no I/O on import."""
import contextlib
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import tempfile

import api_web_deployment as guards
from ci_release import require
from mcl_portal_release import portal_env, rewrite_portal


@contextlib.contextmanager
def promote_private_input(private, source, expected_hash, sha, run_id):
    """Bridge the sealed SSH stage to Root custody without trusting its home."""
    require(os.geteuid()==0 and re.fullmatch(r'[0-9]+-[0-9]+',run_id)
            and re.fullmatch(r'[a-f0-9]{64}',expected_hash),'COPY_PORTAL_INPUT_IDENTITY_INVALID')
    source=Path(source);private=Path(private)
    require(source.is_absolute() and source.name=='mcl-portal.env'
            and source.parent.name=='commerce-ci-'+run_id
            and source.parent==Path(__file__).absolute().parent
            and source.parent.resolve(strict=True)==source.parent,'COPY_PORTAL_INPUT_STAGE_INVALID')
    parent=source.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid==0
            and stat.S_IMODE(parent.st_mode)==0o700,'COPY_PORTAL_INPUT_STAGE_UNSAFE')
    with os.fdopen(os.open(source,os.O_RDONLY|os.O_NOFOLLOW),'rb') as reader:
        info=os.fstat(reader.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1
                and stat.S_IMODE(info.st_mode)==0o600 and 0<info.st_size<=guards.MAX_PRIVATE,
                'COPY_PORTAL_INPUT_FILE_UNSAFE')
        raw=reader.read(guards.MAX_PRIVATE+1)
        identity=lambda value:(value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
        require(len(raw)==info.st_size and identity(os.fstat(reader.fileno()))==identity(info)
                and identity(source.lstat())==identity(info),'COPY_PORTAL_INPUT_STAGE_CHANGED')
    require(hashlib.sha256(raw).hexdigest()==expected_hash,'COPY_PORTAL_INPUT_HASH_MISMATCH')
    portal_env(raw.decode(),sha)
    # This existing canonical file authenticates the complete private ancestry.
    guards.protected_bytes(private/'release.env')
    directory=Path(tempfile.mkdtemp(prefix='portal-input-'+run_id+'-',dir=private))
    initial=directory.lstat();target=directory/'input.env';created=None
    try:
        with os.fdopen(os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as output:
            created=os.fstat(output.fileno())
            os.fchmod(output.fileno(),0o600)
            output.write(raw);output.flush();os.fsync(output.fileno())
        require(guards.protected_bytes(target)==raw,'COPY_PORTAL_INPUT_PROMOTION_READBACK_FAILED')
        yield target
    finally:
        actual=directory.lstat()
        require(stat.S_ISDIR(actual.st_mode) and actual.st_uid==0
                and stat.S_IMODE(actual.st_mode)==0o700
                and (actual.st_dev,actual.st_ino)==(initial.st_dev,initial.st_ino),
                'COPY_PORTAL_INPUT_CLEANUP_DIRECTORY_CHANGED')
        entries=list(directory.iterdir())
        observed=target.lstat() if entries==[target] else None
        require(created is not None and observed is not None
                and (observed.st_dev,observed.st_ino)==(created.st_dev,created.st_ino)
                and guards.protected_bytes(target)==raw,'COPY_PORTAL_INPUT_CLEANUP_CHANGED')
        target.unlink()
        directory.rmdir()


def require_installed_api_web(private, current):
    metadata=guards.unique_json((current/'RELEASE.json').read_bytes())
    reports=list((private/'deployments').glob('*/report.json'))+list((private/'deployments').glob('*/api-web-complete.json'))
    require(len(reports)<=5000,'COPY_PORTAL_REPORT_BOUND')
    for path in reports:
        value=guards.unique_json(guards.protected_bytes(path))
        if (value.get('status')=='SUCCEEDED' and value.get('deployment_scope')=='api-web'
                and value.get('release')==current.name and value.get('source_sha')==metadata.get('source_sha')
                and value.get('consumers_absent') is True and value.get('predeploy_backup_completed') is True):
            return metadata
    require(False,'COPY_PORTAL_INSTALLED_API_WEB_RECEIPT_REQUIRED')


def transition_after(before, command, current, private, root, receipt, caddy_before):
    name='mcl-portal-'+receipt['run_id']
    rows=guards.unique_json(command(['docker','inspect',name],current))
    require(isinstance(rows,list) and len(rows)==1,'COPY_PORTAL_INSPECT_REQUIRED')
    portal={'container_id':rows[0]['Id'],'image':receipt['image'],'source_sha':receipt['source_sha'],
            'run_id':receipt['run_id'],'proxy_network':receipt['proxy_network'],
            'report_ref':guards.reference(guards.PORTAL_BASE/'current.json',json.dumps(receipt,sort_keys=True).encode()),
            'runtime_env_ref':guards.reference(guards.PORTAL_BASE/'releases'/receipt['run_id']/'runtime.env',
                guards.protected_bytes(guards.PORTAL_BASE/'releases'/receipt['run_id']/'runtime.env')),
            'manifest_ref':guards.reference(root/'portal-manifest.json',guards.protected_bytes(root/'portal-manifest.json'))}
    guards.validate_portal_state(portal,private)
    after=guards.inventory(command,current,portal)
    for service in ('api','web','postgres','caddy'):
        require(guards.projection_digest(after[service])==guards.projection_digest(before['services'][service]),
                'COPY_PORTAL_CORE_RUNTIME_CHANGED')
    release=guards.env_values(before['files']['release.env'])
    require(portal['proxy_network']==release['COMMERCE_PROXY_NETWORK'],'COPY_PORTAL_PROXY_CHANGED')
    networks=guards.networks(command,current,after)
    require(networks==before['state']['network_baseline'],'COPY_PORTAL_NETWORK_CHANGED')
    guards.topology_guard(command,current,after,networks,release)
    for filename in guards.FILES:
        require(guards.protected_bytes(private/filename)==before['files'][filename],'COPY_PORTAL_PRIVATE_PROFILE_CHANGED')
    require(guards.protected_bytes(private/'api-web-adoption.json')==before['state_raw']
            and guards.protected_bytes(private/'daily-b02'/'plan.json')==before['plan_raw'],
            'COPY_PORTAL_BASELINE_CHANGED')
    path=Path(before['state']['caddy_config_ref']['path'])
    actual=guards.protected_bytes(path)
    require(actual==rewrite_portal(caddy_before,name,allow_migration_maintenance=True),
            'COPY_PORTAL_PROXY_BYTES_CHANGED')
    return after, {'portal':portal, 'caddy_config_ref':guards.reference(path,actual),
                   'active_proxy_sha256':guards.active_proxy_digest(command,current,after)}


def remove_stopped_candidate(command, current, run_id, sha, image, before):
    """Only this failed container; preserve its bind state, images and all volumes."""
    require(re.fullmatch(r'[0-9]+-[0-9]+',run_id) and re.fullmatch(r'[a-f0-9]{40}',sha)
            and re.fullmatch(r'sha256:[a-f0-9]{64}',image),'COPY_PORTAL_CLEANUP_IDENTITY_INVALID')
    ids=command(['docker','ps','-aq','--no-trunc'],current).split()
    original={row['Id'] for row in before['services'].values()}
    require(len(ids)==len(set(ids)) and set(ids).issuperset(original)
            and len(set(ids)-original)<=1 and all(re.fullmatch(r'[a-f0-9]{64}',value) for value in ids),
            'COPY_PORTAL_CLEANUP_INVENTORY_CHANGED')
    extra=set(ids)-original
    removed=bool(extra)
    if extra:
        cid=extra.pop()
        rows=guards.unique_json(command(['docker','inspect',cid],current))
        require(isinstance(rows,list) and len(rows)==1,'COPY_PORTAL_CLEANUP_INSPECT_REQUIRED')
        row=rows[0];labels=row.get('Config',{}).get('Labels') or {}
        require(row.get('Id')==cid and row.get('Name')=='/mcl-portal-'+run_id and row.get('Image')==image
                and labels.get('com.inovaris.product')=='mi-ciclo-listo-portal'
                and labels.get('com.inovaris.source-sha')==sha
                and row.get('State',{}).get('Running') is False
                and row.get('State',{}).get('Paused') is False
                and row.get('State',{}).get('Restarting') is False,'COPY_PORTAL_CLEANUP_OWN_STOPPED_REQUIRED')
        binds=[mount for mount in row.get('Mounts',[]) if mount.get('Type')=='bind']
        require(len(binds)==1 and binds[0].get('Source')==str(guards.PORTAL_BASE/'state')
                and binds[0].get('Destination')=='/data','COPY_PORTAL_CLEANUP_STATE_BOUNDARY_CHANGED')
        command(['docker','rm',cid],current)
    require(set(command(['docker','ps','-aq','--no-trunc'],current).split())==original,
            'COPY_PORTAL_CLEANUP_READBACK_FAILED')
    return {'own_stopped_container_removed':removed,
            'state_and_volumes_preserved':True}


def publish(vps, archive, archive_hash, sha, run_id, private_input, *, continue_api_web=False):
    private=vps.PRIVATE
    report_dir=private/'deployments'/run_id
    require(type(continue_api_web) is bool,'COPY_PORTAL_CONTINUATION_INVALID')
    if continue_api_web:
        previous=guards.unique_json(guards.protected_bytes(report_dir/'report.json'))
        active=(vps.BASE/'current').resolve(strict=True)
        active_metadata=guards.unique_json((active/'RELEASE.json').read_bytes())
        require(previous.get('status')=='SUCCEEDED' and previous.get('source_sha')==sha
                and previous.get('run_id')==run_id and previous.get('deployment_scope')=='api-web'
                and previous.get('release')==active.name and active_metadata.get('source_sha')==sha
                and previous.get('consumers_absent') is True and previous.get('predeploy_backup_completed') is True
                and not (report_dir/'api-web-complete.json').exists(),'COPY_PORTAL_API_WEB_CONTINUATION_REQUIRED')
        vps._write_report(report_dir/'api-web-complete.json',previous)
        require(guards.unique_json(guards.protected_bytes(report_dir/'api-web-complete.json'))==previous,
                'COPY_PORTAL_API_WEB_RECEIPT_READBACK_FAILED')
    else:
        require(not report_dir.exists(),'EXISTING_REPORT_INSPECT_OR_USE_NEW_RUN_ATTEMPT')
        report_dir.mkdir(mode=0o700,parents=True)
    report={'source_sha':sha,'run_id':run_id,'deployment_scope':'portal-copy','status':'RUNNING',
            'stage':'validate','started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'consumers_started':False,'full_runtime_started':False,'api_web_completed_in_same_run':continue_api_web}
    if continue_api_web:
        report['core_version']=previous.get('core_version')
        report['migration_count']=previous.get('migration_count')
        report['api_web_predeploy_backup']=previous.get('predeploy_backup')
    prepare_lock=None;locks=[];rebase_started=False;installation_started=False
    baseline=None;current=None;root=None;installer=None;image=None
    signal.signal(signal.SIGTERM,vps._terminate_for_rollback)
    # Preparation uses the already-approved four-service API/web contract.
    previous_scope=vps.os.environ.get('COMMERCE_DEPLOY_SCOPE')
    vps.os.environ['COMMERCE_DEPLOY_SCOPE']='api-web'
    try:
        # Validate bounded custody/input before backup or application changes.
        raw=guards.protected_bytes(Path(private_input))
        portal_env(raw.decode(),sha)
        prepare_lock=guards.acquire_locks_for_prepare(private)
        current=(vps.BASE/'current').resolve(strict=True)
        baseline=guards.snapshot(private,current,vps.command,report_dir)
        require(baseline['state']['schema_version']==1,'COPY_PORTAL_INITIAL_TRANSITION_ONLY')
        require_installed_api_web(private,current)
        vps.api_web.database_guard(vps.database,current)
        policy=vps.raw_policy_snapshot(current);auth=vps.owner_auth_snapshot(current)
        vps.verify_ciclo_maintenance()
        require(vps.shutil.disk_usage(vps.BASE).free>max(4*1024**3,Path(archive).stat().st_size*5),
                'INSUFFICIENT_FREE_DISK')
        root=vps.BASE/'releases'/('portal-ci-'+run_id+'-'+sha[:12])
        vps.extract_release(archive,root,archive_hash)
        metadata=guards.unique_json((root/'RELEASE.json').read_bytes())
        require(metadata.get('source_sha')==sha and str(metadata.get('run_id'))==run_id.split('-')[0]
                and len(metadata.get('migration_hashes',{}))==65,'COPY_PORTAL_RELEASE_IDENTITY_INVALID')
        vps.verify_migrations(vps.migrations(current),metadata['migration_hashes'],complete=True)
        prepare_dir=report_dir/'portal-prepare'
        require(not prepare_dir.exists(),'COPY_PORTAL_PREPARE_JOURNAL_ALREADY_EXISTS')
        prepare_dir.mkdir(mode=0o700)
        vps.shutil.copyfile(private/'release.env',prepare_dir/'previous-release.env')
        report['stage']='prepare';vps._write_report(report_dir/'report.json',report)
        vps.run_install_phase(root,prepare_dir,'@existing-owner','prepare')
        report['predeploy_backup']=guards.verify_predeploy_backup(private,prepare_dir)
        report['predeploy_backup_completed']=True
        prepare_lock.close();prepare_lock=None
        locks=guards.acquire_locks(private)
        fresh=guards.snapshot(private,current,vps.command,report_dir)
        require(fresh['state_raw']==baseline['state_raw'] and fresh['plan_raw']==baseline['plan_raw']
                and guards.protected_bytes(Path(private_input))==raw,'COPY_PORTAL_PREPARE_BASELINE_CHANGED')
        baseline=fresh
        caddy_before=guards.read_reference(baseline['state']['caddy_config_ref'])
        vps.api_web.database_guard(vps.database,current)
        require(vps.raw_policy_snapshot(current)==policy,'COPY_PORTAL_POLICY_CHANGED')
        vps.compare_owner_auth(auth,vps.owner_auth_snapshot(current))
        image_rows=guards.unique_json(vps.command(['docker','image','inspect','mi-ciclo-listo-portal:release'],current))
        require(isinstance(image_rows,list) and len(image_rows)==1,'COPY_PORTAL_IMAGE_INSPECT_REQUIRED')
        image=image_rows[0]['Id']
        spec=importlib.util.spec_from_file_location('initial_copy_portal_installer',root/'scripts/install-mcl-portal.py')
        installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)
        checked={}
        def verify(receipt):
            after,transition=transition_after(baseline,vps.command,current,private,root,receipt,caddy_before)
            vps.api_web.database_guard(vps.database,current)
            require(vps.raw_policy_snapshot(current)==policy,'COPY_PORTAL_POLICY_CHANGED')
            report['owner_auth_lifecycle']=vps.compare_owner_auth(auth,vps.owner_auth_snapshot(current))
            vps.verify_core_version('https://commerce-os.inovaris.online',
                                    guards.unique_json((current/'RELEASE.json').read_bytes())['source_sha'])
            vps.verify_ciclo_state({'portal':transition['portal']})
            checked.update(after=after,transition=transition)
        report['stage']='install';vps._write_report(report_dir/'report.json',report)
        installation_started=True
        receipt=installer.install(root,private_input,sha,run_id,allow_migration_maintenance=True,
            defer_public_contact_fields=True,proxy_network=guards.env_values(baseline['files']['release.env'])['COMMERCE_PROXY_NETWORK'],
            verify_before_commit=verify)
        require(checked and receipt.get('status')=='ORIGIN_READY','COPY_PORTAL_COMMIT_VERIFICATION_REQUIRED')
        require(str((vps.BASE/'current').resolve(strict=True))==baseline['state']['current_release'],
                'COPY_PORTAL_CURRENT_RELEASE_CHANGED')
        guards.read_portal_references(checked['transition']['portal'])
        report['stage']='rebase';vps._write_report(report_dir/'report.json',report);rebase_started=True
        report['backup_continuity']=guards.rebase(private,baseline,checked['after'],current,vps._write_report,
            report_dir,portal_transition=checked['transition'])
        # A fresh whole-state snapshot confirms runtime, plan, proxy and refs.
        guards.snapshot(private,current,vps.command,report_dir)
        report.update(status='SUCCEEDED',stage='complete',release=current.name,
            portal_release=root.name,portal_https_verified=True,private_pdfs_verified=10,core_pdfs=9,
            public_contact_fields_deferred=True,consumers_absent=True,
            firewall_configuration_mutations=0,physical_delivery_verified=False)
    except Exception as error:
        report.update(status='FAILED',error=vps.error_code(error))
        if rebase_started:
            report['rollback']={'status':'BLOCKED','error':'COPY_REBASE_RECONCILIATION_REQUIRED','database_restored':False}
        elif installation_started:
            try:
                require(isinstance(error,installer.PortalInstallError) and error.rollback.get('status')=='SUCCEEDED',
                        'COPY_PORTAL_ROLLBACK_UNCONFIRMED')
                cleanup=remove_stopped_candidate(vps.command,current,run_id,sha,image,baseline)
                guards.snapshot(private,current,vps.command,report_dir)
                vps.api_web.database_guard(vps.database,current)
                require(vps.raw_policy_snapshot(current)==policy,'COPY_PORTAL_ROLLBACK_POLICY_CHANGED')
                vps.compare_owner_auth(auth,vps.owner_auth_snapshot(current))
                vps.verify_ciclo_maintenance()
                report['rollback']={'status':'SUCCEEDED','database_restored':False,**cleanup}
            except Exception as recovery:
                report['rollback']={'status':'FAILED','error':vps.error_code(recovery),'database_restored':False}
        raise
    finally:
        if previous_scope is None:vps.os.environ.pop('COMMERCE_DEPLOY_SCOPE',None)
        else:vps.os.environ['COMMERCE_DEPLOY_SCOPE']=previous_scope
        if prepare_lock is not None:prepare_lock.close()
        for lock in reversed(locks):lock.close()
        report['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
        vps._write_report(report_dir/'report.json',report)
        print(json.dumps(report,sort_keys=True))
