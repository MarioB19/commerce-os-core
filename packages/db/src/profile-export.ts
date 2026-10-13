import {createGzip} from 'node:zlib';
import {createHash,randomUUID} from 'node:crypto';
import type {ProfileExecutor} from './profile-context.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';

/** V7 RF-01.5: a readable export of the selected profile's own data (owner).
 * One gzip'd NDJSON document: a header line, one line per row of each section
 * and a closing manifest with counts. Runs inside the caller's profile
 * transaction (row policies scope every read to the profile) and records only
 * a receipt (hash, rows, bytes) in profile_data_exports, which the platform may
 * cite for a deletion request without ever reading the content.
 *
 * Keys, tokens, passwords, webhook secrets and every encrypted field are left
 * out; payment details sealed in a collection stay sealed. Bounded in size. */
const SECRET=/(ciphertext|secret|token|password|passphrase|api_?key|storage_key|webhook_secret|authorization|access_code|private_key|credential)/i;
const MAX_RAW_BYTES=120*1024*1024,BATCH=1000;
export interface ProfileExport {id:string;gzip:Buffer;sha256:string;rows:number;bytes:number;sections:Record<string,number>}

function clean(value:unknown):unknown{
 if(Array.isArray(value))return value.map(clean);
 if(value&&typeof value==='object'&&!(value instanceof Date))return Object.fromEntries(Object.entries(value).filter(([k])=>!SECRET.test(k)).map(([k,v])=>[k,clean(v)]));
 return value;
}

export async function exportProfileData(db:ProfileExecutor,authority:ProfileAuthority):Promise<ProfileExport>{
 const now=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
 authorizeProfileAction(authority,{scope:'audit:export',workspaceId:db.workspaceId,mutation:false},new Date(now));
 const actorId=authority.membership.userId;
 const gzip=createGzip({level:6}),chunks:Buffer[]=[],sections:Record<string,number>={};
 gzip.on('data',chunk=>chunks.push(chunk));
 const done=new Promise<void>((resolve,reject)=>{gzip.on('end',()=>resolve());gzip.on('error',reject);});
 let raw=0,rows=0;
 const line=(section:string,row:unknown)=>{
  const text=JSON.stringify({section,row:clean(row)})+'\n';raw+=Buffer.byteLength(text);
  if(raw>MAX_RAW_BYTES)throw Error('PROFILE_EXPORT_TOO_LARGE');
  gzip.write(text);rows++;sections[section]=(sections[section]??0)+1;
 };
 const id=randomUUID();
 line('export',{schema_version:1,export_id:id,profile_id:db.workspaceId,environment:'REAL',exported_at:new Date(now).toISOString(),
  note:'Datos propios del perfil. No incluye llaves, tokens, contraseñas ni datos sellados.'});
 for(const row of (await db.query('SELECT id,business_name,timezone,state,number_limit,product_limit,daily_conversation_limit,created_at,updated_at FROM profiles WHERE id=$1',[db.workspaceId])).rows)line('profile',row);
 for(const row of (await db.query("SELECT user_id,role,active FROM memberships WHERE workspace_id=$1 ORDER BY user_id",[db.workspaceId])).rows)line('memberships',row);
 // Every record of the profile (products, variants' published configuration,
 // numbers, contacts, conversations, messages, orders, receipts, ...), keyset paged.
 let after:{kind:string;id:string}|null=null;
 for(;;){
  const page:{kind:string;id:string;version:number;body:unknown;created_at:Date;updated_at:Date}[]=(await db.query(
   "SELECT kind,id::text AS id,version,body,created_at,updated_at FROM records WHERE workspace_id=$1 AND environment='REAL' AND ($2::text IS NULL OR (kind,id::text)>($2,$3)) ORDER BY kind,id::text LIMIT $4",
   [db.workspaceId,after?.kind??null,after?.id??null,BATCH])).rows;
  for(const row of page)line('records',row);
  if(page.length<BATCH)break;
  after={kind:page[page.length-1]!.kind,id:page[page.length-1]!.id};
 }
 for(const row of (await db.query("SELECT id,family_id,version,document,current_release_id,archived_at,created_at,updated_at FROM market_variants WHERE workspace_id=$1 AND environment='REAL' ORDER BY id",[db.workspaceId])).rows)line('variants',row);
 for(const row of (await db.query("SELECT * FROM commercial_assignments WHERE workspace_id=$1 AND environment='REAL' ORDER BY id",[db.workspaceId])).rows)line('assignments',row);
 line('manifest',{rows:rows+1,sections:{...sections,manifest:1}});
 gzip.end();await done;
 const buffer=Buffer.concat(chunks),sha256=createHash('sha256').update(buffer).digest('hex');
 await db.query('INSERT INTO profile_data_exports(id,workspace_id,environment,actor_id,sha256,row_count,byte_count) VALUES($1,$2,$3,$4,$5,$6,$7)',
  [id,db.workspaceId,'REAL',actorId,sha256,rows,buffer.length]);
 return{id,gzip:buffer,sha256,rows,bytes:buffer.length,sections};
}
