#!/usr/bin/env python3
"""Administrative offline replacement. Explicit reviewed command required; never starts a container.
Retains encrypted quarantine and old volume. Does not claim WhatsApp authentication.
"""
import argparse,datetime,fcntl,json,os,re,subprocess,uuid
from pathlib import Path
BASE=Path('/opt/commerce-os');PRIVATE=BASE/'private'
def run(args,input_text=None,cwd=None):
 p=subprocess.run(args,input=input_text,text=True,capture_output=True,cwd=cwd,timeout=240)
 if p.returncode:raise RuntimeError('ADMIN_COMMAND_FAILED_RECONCILE_BEFORE_RETRY')
 return p.stdout.strip()
def data_env(p):return dict(l.split('=',1) for l in p.read_text().splitlines() if l and not l.startswith('#'))
def validate_account(s):
 if not s or s['desired_state']!='STOPPED' or not s['operational_pause'] or s['sending_enabled'] or s['uncertain'] or s['recovery_stage']!='STORAGE_REPLACEMENT_REQUESTED':raise RuntimeError('PAUSED_RECONCILED_REPLACEMENT_REQUEST_REQUIRED')
def plan(s,container):
 validate_account(s)
 if container['State']['Running'] or container['State'].get('Restarting'):raise RuntimeError('GATEWAY_MUST_ALREADY_BE_STOPPED')
 labels=container['Config'].get('Labels',{});service=labels.get('com.docker.compose.service','')
 if labels.get('com.docker.compose.project')!='commerce-os' or not re.fullmatch(r'waha-\d{2}',service):raise RuntimeError('GATEWAY_NOT_ALLOWED')
 if s['gateway_id']!='http://'+service+':3000':raise RuntimeError('GATEWAY_ACCOUNT_MISMATCH')
 mount=next((m for m in container['Mounts'] if m['Destination']=='/app/.sessions' and m['Type']=='volume'),None)
 if not mount:raise RuntimeError('PERSISTENT_VOLUME_REQUIRED')
 return {'account_id':s['account_id'],'service':service,'old_volume':mount['Name'],'old_container':container['Id'],'expected_generation':s['credential_generation'],'new_generation':s['credential_generation']+1,'session_start':False,'old_volume_deletion':False,'quarantine_retention_days':30,'authentication_verified':False}
def reject_unreconciled_journal(target,account):
 for path in target.glob('*.json'):
  item=json.loads(path.read_text())
  if item.get('account_id')==account and item.get('stage')!='OFFLINE_REPLACEMENT_VERIFIED':raise RuntimeError('PREVIOUS_REPLACEMENT_REQUIRES_RECONCILIATION')
def main():
 parser=argparse.ArgumentParser();parser.add_argument('account_id');parser.add_argument('container');parser.add_argument('--execute',choices=['PREPARE_OFFLINE_REPLACEMENT']);args=parser.parse_args()
 if os.geteuid()!=0:raise RuntimeError('ADMINISTRATOR_REQUIRED')
 account=str(uuid.UUID(args.account_id));root=(BASE/'current').resolve();release=PRIVATE/'release.env';settings=data_env(release)
 def db(sql):return run(['sh','scripts/compose-release.sh',str(release),'exec','-T','postgres','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','commerce_owner','-d','commerce'],sql,root)
 sql="SELECT row_to_json(x) FROM (SELECT s.*,COALESCE((r.body->>'sending_enabled')::boolean,false) sending_enabled,(SELECT count(*) FROM outbox WHERE account_id=s.account_id::text AND status IN('SENDING','UNKNOWN'))+(SELECT count(*) FROM commands WHERE resource_id=s.account_id::text AND kind='channel_command' AND (status='PENDING' OR (status='FAILED' AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at')))) uncertain FROM channel_sessions s JOIN records r ON r.id=s.account_id WHERE s.account_id='%s') x;"%account
 session=json.loads(db(sql));container=json.loads(run(['docker','inspect',args.container]))[0];review=plan(session,container)
 if not args.execute:print(json.dumps({'status':'REVIEW_REQUIRED','plan':review}));return
 with (PRIVATE/'waha-backup.lock').open('w') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  target=PRIVATE/'waha-quarantine';target.mkdir(mode=0o700,exist_ok=True);reject_unreconciled_journal(target,account);reference=str(uuid.uuid4());archive=target/(reference+'.waha.aes');record=target/(reference+'.json')
  volume='commerce-os-'+review['service']+'-credentials-'+str(review['new_generation'])+'-'+reference[:8]
  # Persist intent before mutation. A timeout is reconciled using this exact receipt, never replayed blindly.
  review.update({'reference':reference,'new_volume':volume,'stage':'CAPTURING','at':datetime.datetime.now(datetime.timezone.utc).isoformat()});record.write_text(json.dumps(review));record.chmod(0o600)
  command=['docker','run','--rm','--label','commerce.waha-backup=true','--network','none','--user','0:0','--security-opt','no-new-privileges:true','--env-file',str(PRIVATE/'backup.env'),'-e','WAHA_BACKUP_VOLUME='+review['old_volume'],'-e','WAHA_CREDENTIAL_GENERATION='+str(review['expected_generation']),'-v','/var/run/docker.sock:/var/run/docker.sock','-v',review['old_volume']+':/session-source:ro','-v',str(target)+':'+str(target),settings['COMMERCE_MAINTENANCE_IMAGE'],'node','scripts/waha-session-backup.mjs','backup',container['Id'],str(archive)]
  receipt=json.loads(run(command));review['quarantine_sha256']=receipt['backup_ref'];review['stage']='QUARANTINED';record.write_text(json.dumps(review))
  plan(json.loads(db(sql)),json.loads(run(['docker','inspect',args.container]))[0])
  run(['docker','volume','create','--label','commerce.session-recovery='+reference,volume])
  # Persistent override is picked up by every future compose/deploy; never change the pilot file or old volume.
  override=PRIVATE/'waha-storage-overrides.json';config=json.loads(override.read_text()) if override.exists() else {'volumes':{}}
  key=review['service']+'-sessions';config.setdefault('volumes',{})[key]={'name':volume,'external':True};tmp=override.with_suffix('.partial');tmp.write_text(json.dumps(config));tmp.chmod(0o600);tmp.replace(override)
  review['stage']='RECREATING_STOPPED';record.write_text(json.dumps(review))
  run(['sh','scripts/compose-release.sh',str(release),'create','--no-deps','--force-recreate',review['service']],cwd=root)
  ids=run(['sh','scripts/compose-release.sh',str(release),'ps','-aq',review['service']],cwd=root).split();fresh=json.loads(run(['docker','inspect',*ids]))
  if len(fresh)!=1 or fresh[0]['State']['Running'] or not any(m.get('Name')==volume and m['Destination']=='/app/.sessions' for m in fresh[0]['Mounts']):raise RuntimeError('NEW_VOLUME_MOUNT_UNCONFIRMED')
  if container['Id'] in run(['docker','ps','-aq','--no-trunc']).split():raise RuntimeError('OLD_CONTAINER_NOT_ISOLATED')
  updated=db("WITH changed AS (UPDATE channel_sessions SET credential_generation=credential_generation+1,storage_ref='%s',backup_ref='%s',backup_verified_at=now(),backup_status='QUARANTINE_VERIFIED',recovery_stage='AWAITING_NEW_QR',auth_state='UNKNOWN',observed_state='STOPPED',health_expires_at=NULL,revision=revision+1 WHERE account_id='%s' AND credential_generation=%d AND operational_pause AND desired_state='STOPPED' AND recovery_stage='STORAGE_REPLACEMENT_REQUESTED' RETURNING *), audit AS (INSERT INTO channel_session_events(session_id,workspace_id,environment,account_id,kind,actor_id,source,evidence,revision) SELECT id,workspace_id,environment,account_id,'storage_replaced','root-administrator','offline_isolation',jsonb_build_object('reference','%s','quarantine_sha256',backup_ref,'credential_generation',credential_generation,'authentication_verified',false),revision FROM changed) SELECT count(*) FROM changed;"%(volume,receipt['backup_ref'],account,review['expected_generation'],reference))
  if updated!='1':raise RuntimeError('REPLACEMENT_DATABASE_STATE_REQUIRES_RECONCILIATION')
  review['stage']='OFFLINE_REPLACEMENT_VERIFIED';review['new_container']=fresh[0]['Id'];record.write_text(json.dumps(review));print(json.dumps(review))
if __name__=='__main__':main()
