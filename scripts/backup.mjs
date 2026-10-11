import {createCipheriv,randomBytes,createHash} from 'node:crypto';
import {createWriteStream,appendFileSync,mkdirSync,writeFileSync,readFileSync,renameSync,mkdtempSync,copyFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {once} from 'node:events';
import pg from 'pg';
import {applyLocalEnv,configDir} from './local-env.mjs';
import {backupDatabaseUrl} from './backup-database.mjs';
import {postgresTool} from './postgres-tool.mjs';
applyLocalEnv();
const key=Buffer.from(process.env.BACKUP_ENCRYPTION_KEY||'','hex');if(key.length!==32)throw Error('BACKUP_ENCRYPTION_KEY_REQUIRED');
const dir=process.env.BACKUP_DIR||join(configDir,'backups');mkdirSync(dir,{recursive:true,mode:0o700});
const stage=mkdtempSync(join(dir,'bundle-')),target=join(dir,'commerce-'+new Date().toISOString().replaceAll(':','-')+'.backup.aes'),partial=target+'.partial';
const db=new pg.Client({connectionString:backupDatabaseUrl()});await db.connect();
const run=async(args,output)=>{const invocation=postgresTool('pg_dump',{databaseUrl:backupDatabaseUrl(),database:process.env.POSTGRES_DB||new URL(process.env.DATABASE_URL).pathname.slice(1),args});const child=spawn(invocation.command,invocation.args,{env:invocation.env,stdio:['ignore','pipe','ignore']});const exited=once(child,'exit');await pipeline(child.stdout,createWriteStream(output,{mode:0o600}));const[code]=await exited;if(code!==0)throw Error('PG_DUMP_FAILED');};
try{
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const snapshot=(await db.query('SELECT pg_export_snapshot() snapshot')).rows[0].snapshot;
 // Number-flow tests persist receipt evidence as metadata-only records: they are
 // intentionally READY for the isolated sales engine, but have no file bytes to
 // archive. Preserve every physical asset, including SIMULATION snapshot copies,
 // and exclude only those explicit synthetic receipt placeholders.
 const assets=(await db.query("SELECT id,body->>'storage_key' storage_key FROM records WHERE kind='asset' AND body->>'kind'='file' AND body->>'status'='READY' AND NOT (environment='SIMULATION' AND COALESCE(body->>'synthetic_receipt','false')='true')")).rows;
 await run(['--format=custom','--no-owner','--no-acl','--snapshot='+snapshot],join(stage,'database.pgdump'));
 const manifest=[];mkdirSync(join(stage,'assets'),{mode:0o700});
 for(const asset of assets){if(!/^[a-f0-9-]{36}(?:-[a-f0-9]{64})?$/.test(asset.storage_key))throw Error('INVALID_ASSET_STORAGE_KEY');const name=asset.storage_key+'.enc';if(manifest.some(entry=>entry.file===name))continue;const source=join(process.env.PRIVATE_STORAGE_DIR||process.env.ASSET_STORAGE_DIR,'assets',name);const encrypted=readFileSync(source);copyFileSync(source,join(stage,'assets',name));manifest.push({file:name,sha256:createHash('sha256').update(encrypted).digest('hex'),size:encrypted.length});}
 writeFileSync(join(stage,'manifest.json'),JSON.stringify({version:2,created_at:new Date().toISOString(),snapshot_consistent:true,assets:manifest}),{mode:0o600});
 await db.query('COMMIT');
 const iv=randomBytes(12);writeFileSync(partial,Buffer.concat([Buffer.from('COMOSB02'),iv]),{mode:0o600});
 const tar=spawn('tar',['-C',stage,'-cf','-','database.pgdump','manifest.json','assets'],{stdio:['ignore','pipe','ignore']}),exit=once(tar,'exit'),cipher=createCipheriv('aes-256-gcm',key,iv);
 await pipeline(tar.stdout,cipher,createWriteStream(partial,{flags:'a',mode:0o600}));if((await exit)[0]!==0)throw Error('ARCHIVE_FAILED');appendFileSync(partial,cipher.getAuthTag());renameSync(partial,target);
 console.log(JSON.stringify({backup:target,encrypted:true,format:2,private_assets:manifest.length,snapshot_consistent:true,external_copy_verified:false}));
}finally{await db.end();rmSync(stage,{recursive:true,force:true});rmSync(partial,{force:true});}
