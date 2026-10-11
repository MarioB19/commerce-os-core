#!/usr/bin/env python3
"""Cold copies only. No stop/start/reset and no network contact with WhatsApp."""
import datetime,fcntl,json,os,re,subprocess
from pathlib import Path
BASE=Path('/opt/commerce-os'); PRIVATE=BASE/'private'
def env(path): return dict(l.split('=',1) for l in path.read_text().splitlines() if l and not l.startswith('#'))
def run(args): return subprocess.check_output(args,text=True,stderr=subprocess.DEVNULL).strip()
def main():
 PRIVATE.mkdir(mode=0o700,exist_ok=True)
 with (PRIVATE/'waha-backup.lock').open('w') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  settings=env(PRIVATE/'release.env'); root=BASE/'current'; target=PRIVATE/'waha-backups';target.mkdir(mode=0o700,exist_ok=True)
  def db(sql):
   result=subprocess.run(['sh','scripts/compose-release.sh',str(PRIVATE/'release.env'),'exec','-T','postgres','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','commerce_owner','-d','commerce'],cwd=root,input=sql,text=True,check=True,capture_output=True,timeout=60)
   return result.stdout.strip()
  ids=run(['docker','ps','-aq','--filter','label=com.docker.compose.project=commerce-os']).split()
  items=json.loads(run(['docker','inspect',*ids])) if ids else []
  report=[]
  for item in items:
   service=item['Config'].get('Labels',{}).get('com.docker.compose.service','')
   if not re.fullmatch(r'waha-\d{2}',service): continue
   if item['State']['Running']:
    report.append({'service':service,'status':'AWAITING_AUTHORIZED_COLD_WINDOW'});continue
   mount=next((m for m in item['Mounts'] if m['Destination']=='/app/.sessions' and m['Type']=='volume'),None)
   if not mount: report.append({'service':service,'status':'VOLUME_UNCONFIRMED'});continue
   generation=db("SELECT credential_generation FROM channel_sessions WHERE gateway_id='http://%s:3000' AND archived_at IS NULL;"%service)
   if not generation.isdigit():report.append({'service':service,'status':'ACCOUNT_MAPPING_UNCONFIRMED'});continue
   stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')
   file=target/(service+'-'+stamp+'.waha.aes')
   args=['docker','run','--rm','--label','commerce.waha-backup=true','--network','none','--user','0:0','--security-opt','no-new-privileges:true','--env-file',str(PRIVATE/'backup.env'),'-e','WAHA_BACKUP_VOLUME='+mount['Name'],'-e','WAHA_CREDENTIAL_GENERATION='+generation,'-v','/var/run/docker.sock:/var/run/docker.sock','-v',mount['Name']+':/session-source:ro','-v',str(target)+':'+str(target),settings['COMMERCE_MAINTENANCE_IMAGE'],'node','scripts/waha-session-backup.mjs','backup',item['Id'],str(file)]
   result=subprocess.run(args,text=True,capture_output=True,timeout=240)
   if result.returncode: report.append({'service':service,'status':'BACKUP_FAILED'});continue
   receipt=json.loads(result.stdout);report.append(receipt)
   # Persist only hashes and consistency evidence through the administrator-owned DB interface.
   safe={k:receipt[k] for k in ['backup_ref','created_at','service','volume','files','total_bytes']}
   # Account maps to fixed gateway hostname. Values are generated/validated, never operator SQL.
   if not re.fullmatch(r'[a-f0-9]{64}',safe['backup_ref']): raise RuntimeError('INVALID_RECEIPT')
   sql="UPDATE channel_sessions SET backup_ref='%s',backup_verified_at=now(),backup_status='VERIFIED_COLD_BACKUP',storage_ref='%s' WHERE gateway_id='http://%s:3000' AND archived_at IS NULL;"%(safe['backup_ref'],safe['volume'].replace("'","''"),service)
   db(sql)
  output={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'gateways':report,'session_mutations':0,'authentication_verified':False}
  temp=target/'latest.json.partial';temp.write_text(json.dumps(output));temp.chmod(0o600);temp.replace(target/'latest.json')
  print(json.dumps(output))
if __name__=='__main__':main()
