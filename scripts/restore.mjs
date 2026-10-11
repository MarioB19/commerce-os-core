import { createDecipheriv, randomUUID, createHash } from 'node:crypto';
import { openSync, readSync, closeSync, statSync, createReadStream, createWriteStream, unlinkSync, mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, copyFileSync, chmodSync, chownSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import pg from 'pg';
import { applyLocalEnv, configDir } from './local-env.mjs';
import {backupDatabaseUrl} from './backup-database.mjs';
import {postgresTool} from './postgres-tool.mjs';
applyLocalEnv();
const [backup,target]=process.argv.slice(2);
if(!backup||!/^commerce_restore_[a-z0-9_]+$/.test(target||''))throw new Error('Usage: restore.mjs <encrypted-backup> <commerce_restore_unique_name>. New databases only.');
if(process.env.DISPATCH_FROZEN!=='true')throw new Error('DISPATCH_FROZEN=true required');
const key=Buffer.from(process.env.BACKUP_ENCRYPTION_KEY||'','hex');if(key.length!==32)throw new Error('BACKUP_ENCRYPTION_KEY required');
const ownerValues=[process.env.RESTORE_ASSET_UID,process.env.RESTORE_ASSET_GID];
if(ownerValues.some(value=>value!==undefined)&&ownerValues.some(value=>value===undefined||!/^\d+$/.test(value)||Number(value)>2147483647))throw Error('RESTORE_ASSET_UID_AND_GID_REQUIRED_AS_VALID_INTEGERS');
const restoreOwner=ownerValues[0]===undefined?undefined:ownerValues.map(Number);
const size=statSync(backup).size;if(size<36)throw new Error('Invalid backup');
const fd=openSync(backup,'r');const header=Buffer.alloc(20),tag=Buffer.alloc(16);readSync(fd,header,0,20,0);readSync(fd,tag,0,16,size-16);closeSync(fd);
const format=header.subarray(0,8).toString();if(!['COMOSB01','COMOSB02'].includes(format))throw new Error('Unknown backup format');
const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(8));decipher.setAuthTag(tag);
const temp=join(configDir,`restore-${randomUUID()}.private`);
mkdirSync(configDir,{recursive:true,mode:0o700});
const stage=mkdtempSync(join(configDir,'restore-stage-'));let admin;let privateRoot;let assetCount=0;
const databaseUrl=backupDatabaseUrl();
try {
 await pipeline(createReadStream(backup,{start:20,end:size-17}),decipher,createWriteStream(temp,{mode:0o600}));
 // Authenticate entire encrypted archive before allowing any database write.
 let dump=temp;
 if(format==='COMOSB02'){
  const list=spawnSync('tar',['-tf',temp],{encoding:'utf8'});if(list.status!==0)throw Error('INVALID_ARCHIVE');
  const entries=list.stdout.trim().split('\n');if(entries.some(name=>!['database.pgdump','manifest.json','assets/'].includes(name)&&!/^assets\/[a-f0-9-]{36}(?:-[a-f0-9]{64})?\.enc$/.test(name)))throw Error('UNSAFE_ARCHIVE_PATH');
  if(new Set(entries).size!==entries.length)throw Error('DUPLICATE_ARCHIVE_ENTRY');
  const types=spawnSync('tar',['-tvf',temp],{encoding:'utf8'});if(types.status!==0||types.stdout.trim().split('\n').some(line=>!['-','d'].includes(line[0])))throw Error('UNSAFE_ARCHIVE_ENTRY_TYPE');
  if(spawnSync('tar',['-xf',temp,'-C',stage],{stdio:'ignore'}).status!==0)throw Error('EXTRACTION_FAILED');
  const manifest=JSON.parse(readFileSync(join(stage,'manifest.json'),'utf8'));if(manifest.version!==2)throw Error('MANIFEST_VERSION_UNSUPPORTED');
  for(const entry of manifest.assets){if(!/^[a-f0-9-]{36}(?:-[a-f0-9]{64})?\.enc$/.test(entry.file))throw Error('UNSAFE_ASSET_PATH');const bytes=readFileSync(join(stage,'assets',entry.file));if(bytes.length!==entry.size||createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error('ASSET_INTEGRITY_FAILED');}
  const expected=new Set(['database.pgdump','manifest.json','assets/',...manifest.assets.map(entry=>'assets/'+entry.file)]);
  if(entries.length!==expected.size||entries.some(entry=>!expected.has(entry)))throw Error('ARCHIVE_MANIFEST_MISMATCH');
  assetCount=manifest.assets.length;privateRoot=join(configDir,'restored',target);if(existsSync(privateRoot))throw Error('RESTORE_STORAGE_EXISTS');
  dump=join(stage,'database.pgdump');
 }

 admin=new pg.Client({connectionString:databaseUrl});await admin.connect();
 const existing=await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[target]);if(existing.rowCount)throw new Error('Target database exists; refusing overwrite');
 await admin.query(`CREATE DATABASE "${target}" TEMPLATE template0`);
 const invocation=postgresTool('pg_restore',{databaseUrl,database:target,args:['--exit-on-error','--no-owner','--no-acl']});
 const child=spawn(invocation.command,invocation.args,{env:invocation.env,stdio:['pipe','ignore','pipe']});
 let error='';child.stderr.on('data',d=>{error+=d.toString()});const exited=once(child,'exit');await pipeline(createReadStream(dump),child.stdin);const [code]=await exited;
 if(code!==0)throw new Error('Restore failed. Target retained for inspection; dispatch remains frozen. '+error.slice(0,150));
 const url=new URL(databaseUrl);url.pathname='/'+target;const restored=new pg.Client({connectionString:url.toString()});await restored.connect();
 try {
  await restored.query('BEGIN');
  await restored.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) SELECT DISTINCT workspace_id,'workspace',workspace_id,true,'RESTORE_RECONCILIATION_REQUIRED','restore-runner' FROM records ON CONFLICT(workspace_id,scope_type,scope_id) DO UPDATE SET paused=true,reason='RESTORE_RECONCILIATION_REQUIRED',version=manual_controls.version+1,updated_at=now()");
  await restored.query("UPDATE outbox SET status='UNKNOWN',result=result||'{\"reason\":\"RESTORE_UNCERTAINTY\"}'::jsonb WHERE status='SENDING'");
  await restored.query('UPDATE session_ownership SET frozen=true,updated_at=now()');
  if((await restored.query("SELECT to_regclass('channel_sessions') present")).rows[0].present)await restored.query("UPDATE channel_sessions SET recovery_enabled=false,operational_pause=true,desired_state='STOPPED',observed_state='UNKNOWN',auth_state='UNKNOWN',health_expires_at=NULL,recovery_blocker='RESTORE_REVIEW_REQUIRED',next_retry_at=NULL,revision=revision+1");
  await restored.query('UPDATE operation_authorizations SET revoked_at=COALESCE(revoked_at,now())');
  await restored.query('DELETE FROM session');
  await restored.query('UPDATE service_tokens SET revoked_at=COALESCE(revoked_at,now())');
  if((await restored.query("SELECT to_regclass('personal_access_tokens') present")).rows[0].present)await restored.query('UPDATE personal_access_tokens SET revoked_at=COALESCE(revoked_at,now()),version=version+1');
  if((await restored.query("SELECT to_regclass('warmup_pools') present")).rows[0].present){
   await restored.query("UPDATE warmup_pools SET enabled=false,paused=true,authorization_id=NULL,version=version+1,updated_at=now()");
   await restored.query("UPDATE warmup_states SET paused=true,reason='RESTORE_REVIEW_REQUIRED',version=version+1,updated_at=now() WHERE enrolled_at IS NOT NULL AND status<>'GRADUATED'");
   await restored.query("UPDATE warmup_identities SET profile_operation_status='UNKNOWN' WHERE profile_operation_status='APPLYING'");
   if((await restored.query("SELECT 1 FROM information_schema.columns WHERE table_name='warmup_identities' AND column_name='profile_review_requested_at'")).rowCount)await restored.query('UPDATE warmup_identities SET profile_review_requested_at=NULL');
  }
  if((await restored.query("SELECT to_regclass('operational_alerts') present")).rows[0].present){
   await restored.query("UPDATE operational_alerts SET status=CASE WHEN status='SENDING' THEN 'UNKNOWN' ELSE 'RESOLVED' END,updated_at=now() WHERE status IN('PENDING','SENDING')");
   await restored.query("UPDATE integration_settings SET enabled=false,updated_by='restore-runner',updated_at=now() WHERE type='alerts'");
  }

  // A restored creative database must not reconnect devices or replay paid requests.
  if((await restored.query("SELECT to_regclass('creative_settings') present")).rows[0].present){
   await restored.query('UPDATE creative_settings SET enabled=false,updated_at=now()');
   await restored.query("UPDATE creative_devices SET status='REVOKED',revoked_at=now(),version=version+1");
   await restored.query("UPDATE creative_pairings SET status='EXPIRED',token_ciphertext=NULL WHERE status IN('PENDING','APPROVED')");
   await restored.query("UPDATE creative_provider_operations SET status='UNKNOWN',error_code='RESTORE_RECONCILIATION_REQUIRED',finished_at=now() WHERE status IN('RESERVED','RUNNING')");
   await restored.query("UPDATE creative_jobs SET status='CANCELLED',active_attempt_id=NULL,fence=fence+1,version=version+1,error_code='RESTORE_REVIEW_REQUIRED',updated_at=now() WHERE status IN('QUEUED','RUNNING','RETRY')");
   await restored.query("UPDATE creative_attempts SET status='EXPIRED',lease_expires_at=now(),finished_at=now() WHERE status='RUNNING'");
  }
  if((await restored.query("SELECT to_regclass('intelligence_searches') present")).rows[0].present){
   await restored.query('UPDATE intelligence_searches SET tracking_enabled=false');
   await restored.query("UPDATE intelligence_runs SET status=CASE WHEN status='RUNNING' THEN 'UNKNOWN' ELSE 'FAILED' END,error_code='RESTORE_REVIEW_REQUIRED' WHERE status IN('QUEUED','RUNNING')");
   await restored.query("UPDATE intelligence_analyses SET status='UNKNOWN' WHERE status IN('QUEUED','RUNNING')");
  }
  if((await restored.query("SELECT to_regclass('creative_voice_operations') present")).rows[0].present){
   await restored.query("UPDATE creative_voice_operations SET status=CASE WHEN status='QUOTED' THEN 'FAILED' ELSE 'UNKNOWN' END,error_code='RESTORE_RECONCILIATION_REQUIRED',updated_at=now() WHERE status IN('QUOTED','REQUESTED','RUNNING','PAID_PENDING_STORAGE')");
  }

  // V5 state is not permission to resume an external request after restoring an earlier snapshot.
  if((await restored.query("SELECT to_regclass('integration_diagnostics') present")).rows[0].present)await restored.query("UPDATE integration_diagnostics SET status='UNKNOWN',error_code='RESTORE_RECONCILIATION_REQUIRED',updated_at=now(),finished_at=now() WHERE status='RUNNING'");
  if((await restored.query("SELECT to_regclass('provider_diagnostics') present")).rows[0].present)await restored.query("UPDATE provider_diagnostics SET status='UNKNOWN',error_code='RESTORE_RECONCILIATION_REQUIRED',finished_at=now() WHERE status='RUNNING'");
  if((await restored.query("SELECT to_regclass('intelligence_corpus_evaluations') present")).rows[0].present)await restored.query("UPDATE intelligence_corpus_evaluations SET status='UNKNOWN',outcomes=(SELECT COALESCE(jsonb_object_agg(key,CASE WHEN value->>'status'='RUNNING' THEN value||jsonb_build_object('status','UNKNOWN','error_code','RESTORE_RECONCILIATION_REQUIRED') ELSE value END),'{}'::jsonb) FROM jsonb_each(outcomes)),updated_at=now(),finished_at=now() WHERE status='RUNNING'");
  if((await restored.query("SELECT to_regclass('intelligence_analysis_batches') present")).rows[0].present)await restored.query("UPDATE intelligence_analysis_batches SET status=CASE WHEN status='RUNNING' THEN 'UNKNOWN' ELSE 'FAILED' END,updated_at=now() WHERE status IN('RUNNING','QUEUED')");
  if((await restored.query("SELECT to_regclass('creative_uploads') present")).rows[0].present)await restored.query("UPDATE creative_uploads SET status='UNKNOWN',version=version+1,error_code='RESTORE_RECONCILIATION_REQUIRED',updated_at=now() WHERE status IN('INITIATING','UPLOADING','CLOSING','VERIFYING','ABORTING')");
  // No cost or storage reservation is released here: external objects and billed results require reconciliation.
  if((await restored.query("SELECT to_regclass('commercial_assignments') present")).rows[0].present)await restored.query('UPDATE commercial_assignments SET authorization_id=NULL,updated_at=now() WHERE authorization_id IS NOT NULL');
  if((await restored.query("SELECT to_regclass('warmup_programs') present")).rows[0].present){
   await restored.query("UPDATE warmup_programs SET status=CASE WHEN status IN('ARCHIVED','COMPLETED') THEN status ELSE 'PAUSED' END,review_hash=NULL,authorization_id=NULL,version=version+1,updated_at=now()");
   await restored.query("UPDATE warmup_groups SET expires_at=LEAST(expires_at,now())");
   await restored.query("UPDATE number_operations SET state=CASE WHEN state IN('PREPARING','UNKNOWN') THEN 'UNKNOWN' ELSE 'CANCELLED' END,result=result||'{\"restore_review_required\":true}'::jsonb,lease_until=NULL,version=version+1 WHERE state NOT IN('SUCCEEDED','FAILED','CANCELLED')");
   await restored.query("UPDATE number_capacity_slots SET state=CASE WHEN state IN('PREPARING','UNKNOWN') THEN 'UNKNOWN' ELSE state END,readback=readback||'{\"verified\":false,\"restore_review_required\":true}'::jsonb,version=version+1");
  }
  if((await restored.query("SELECT to_regclass('warmup_simulation_runs') present")).rows[0].present)await restored.query("UPDATE warmup_simulation_runs SET status='PAUSED',version=version+1,result=result||'{\"restore_review_required\":true}'::jsonb,updated_at=now() WHERE status IN('RUNNING','ATTENTION')");

  // Restored reset grants could resurrect used links or re-send old mail. Fail closed.
  if((await restored.query("SELECT to_regclass('identity_reset_links') present")).rows[0].present){
   await restored.query('DELETE FROM verification WHERE identifier IN (SELECT digest FROM identity_reset_links)');
   await restored.query('DELETE FROM identity_reset_links');
   await restored.query("UPDATE identity_mail_jobs SET status=CASE WHEN status='SENDING' THEN 'UNCERTAIN' ELSE 'CANCELLED' END,payload_ciphertext=NULL,finished_at=now(),diagnostic_code='RESTORE_REVIEW_REQUIRED' WHERE status IN ('PENDING','SENDING')");
   await restored.query("UPDATE identity_mail_settings SET enabled=false,diagnostic_code='RESTORE_REVIEW_REQUIRED',diagnosed_at=now()");
   await restored.query("INSERT INTO identity_audit(event_type,outcome,correlation_id,actor_id) VALUES('identity.restore','LINKS_INVALIDATED',gen_random_uuid()::text,'restore-runner')");
  }
  await restored.query('COMMIT');
  const counts=(await restored.query('SELECT (SELECT count(*) FROM records)::int records,(SELECT count(*) FROM domain_events)::int events,(SELECT count(*) FROM outbox)::int effects,(SELECT count(*) FROM manual_controls WHERE paused)::int frozen_controls')).rows[0];
  if(privateRoot){const assetDirectory=join(privateRoot,'assets');mkdirSync(assetDirectory,{recursive:true,mode:0o700});const manifest=JSON.parse(readFileSync(join(stage,'manifest.json'),'utf8'));for(const entry of manifest.assets){const file=join(assetDirectory,entry.file);copyFileSync(join(stage,'assets',entry.file),file);chmodSync(file,0o600);if(restoreOwner)chownSync(file,restoreOwner[0],restoreOwner[1]);}for(const directory of [assetDirectory,privateRoot]){chmodSync(directory,0o700);if(restoreOwner)chownSync(directory,restoreOwner[0],restoreOwner[1]);}}
  console.log(JSON.stringify({database:target,private_storage_dir:privateRoot??null,private_assets_restored:assetCount,private_storage_owner:restoreOwner?{uid:restoreOwner[0],gid:restoreOwner[1]}:'current maintenance user',restored:true,dispatch_frozen:true,authorizations_revoked:true,...counts,remote_reconciliation_required:true}));
 }finally{await restored.end();}
}finally {try{unlinkSync(temp)}catch{/* no temporary file */}if(admin)await admin.end();rmSync(stage,{recursive:true,force:true});}
