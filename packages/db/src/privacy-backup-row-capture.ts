import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {ProfilePool} from './profile-context.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/),relation=z.string().regex(/^public\.[A-Za-z_][A-Za-z0-9_]*$/);
const ref=z.strictObject({path:z.string().startsWith('/').max(4096),sha256:sha,bytes:z.number().int().positive().max(1048576)});
const start=z.strictObject({schema_version:z.literal(1),kind:z.literal('PRIVATE_ROW_CAPTURE'),token:z.uuid(),workspace_id:z.string().min(1).max(256),environment:z.literal('REAL'),catalog_sha256:sha,relations:z.array(relation).min(1).max(1000)});
const page=z.strictObject({schema_version:z.literal(1),kind:z.literal('PRIVATE_ROW_PAGE'),capture_id:z.uuid(),workspace_id:z.string(),environment:z.literal('REAL'),catalog_sha256:sha,page_index:z.number().int().nonnegative(),entries:z.array(z.strictObject({relation,key_sha256:sha,source_sha256:sha})).max(2000),page_sha256:sha,root_sha256:sha,row_count:z.string().regex(/^(0|[1-9]\d*)$/),complete:z.boolean(),started_at:z.iso.datetime({offset:true}),observed_at:z.iso.datetime({offset:true})});
export type PrivacyRowPageReference=z.infer<typeof ref>;
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
function need(v:unknown):asserts v{if(!v)throw Error('PRIVACY_ROW_CAPTURE_BINDING');}
/** Private backup operator only. The pool has the dedicated attestor login;
 * caller has no relation, PK, offset or SQL selector. The sink must retain each
 * original in private custody. One RR backend spans every page; no importer,
 * backup grant, purge lease or erasure is performed. ROLLBACK destroys temp state. */
export async function capturePrivacyBackupRows(pool:ProfilePool,workspaceId:string,writePage:(raw:Buffer,index:number)=>Promise<PrivacyRowPageReference>){
 need(workspaceId.length>0&&workspaceId.length<=256&&!workspaceId.includes('\0'));
 const c=await pool.connect();let begun=false,discard=false;
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');begun=true;
  await c.query('SET LOCAL ROLE commerce_privacy_attestor');
  await c.query("SET LOCAL statement_timeout='120s'");await c.query("SET LOCAL idle_in_transaction_session_timeout='60s'");
  await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[workspaceId]);
  const capture=start.parse((await c.query('SELECT begin_privacy_backup_row_capture() AS result')).rows[0]?.result);need(capture.workspace_id===workspaceId&&new Set(capture.relations).size===capture.relations.length);
  const pages:PrivacyRowPageReference[]=[];const paths=new Set<string>();let root=hash('PRIVACY_BACKUP_ROWS_V1'),count=0n,previous:readonly[string,string]|undefined,started:string|undefined,observed=0;
  for(let index=0;index<100000;index++){
   const value=page.parse((await c.query('SELECT read_privacy_backup_row_page($1) AS result',[capture.token])).rows[0]?.result);
   need(value.capture_id===capture.token&&value.workspace_id===workspaceId&&value.catalog_sha256===capture.catalog_sha256&&value.page_index===index&&(value.complete||value.entries.length===2000));
   for(const entry of value.entries){need(capture.relations.includes(entry.relation)&&(!previous||entry.relation>previous[0]||(entry.relation===previous[0]&&entry.key_sha256>previous[1])));previous=[entry.relation,entry.key_sha256];}
   const at=Date.parse(value.started_at),now=Date.parse(value.observed_at);started??=value.started_at;need(value.started_at===started&&at<=now&&now>=observed);observed=now;
   const digest=hash(value.entries.map(e=>`${e.relation}:${e.key_sha256}:${e.source_sha256}\n`).join(''));root=hash(root+'\n'+digest);count+=BigInt(value.entries.length);need(value.page_sha256===digest&&value.root_sha256===root&&value.row_count===String(count));
   const raw=Buffer.from(JSON.stringify(value));need(raw.length<=1048576);const expected={sha256:hash(raw),bytes:raw.length},saved=ref.parse(await writePage(raw,index));need(saved.sha256===expected.sha256&&saved.bytes===expected.bytes&&!paths.has(saved.path));paths.add(saved.path);pages.push(saved);
   if(value.complete){await c.query('ROLLBACK');begun=false;return{capture,pages,import_authorized:false as const,erasure_authorized:false as const};}
  }
  throw Error('PRIVACY_ROW_CAPTURE_PAGE_BOUND');
 }catch(error){if(begun){try{await c.query('ROLLBACK');}catch{discard=true;}}else discard=true;throw error;
 }finally{c.release(discard||undefined);}
}
