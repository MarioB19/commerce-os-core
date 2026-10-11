/** Explicit administrative maintenance for two synthetic pilot identities; never bootstraps owners. */
import {mkdir,readFile,writeFile,rename,chmod,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {provisionUser} from '../apps/api/src/auth.js';
import {pool,withTransaction,appendEvent,type QueryExecutor} from '../packages/db/src/index.js';
import {identityAudit} from '../packages/db/src/identity.js';

const AUTHORIZATION='dc6656c7b81d5af72b514a273a6d87d668642f27edba7feae3ef214c09d5aa3b';
const administratorScopes=['intelligence:read','intelligence:write','intelligence:refresh','intelligence:analyze','studio:read','studio:write','studio:produce','studio:admin'];
const readerScopes=['intelligence:read','studio:read'];
type Identity={kind:'administrator'|'reader';email:string;password:string;name:string;id?:string};
type Ledger={schema_version:1;pilot_id:string;workspace_id:string;origin:string;created_at:string;expires_at:string;authorization_sha256:string;identities:Identity[]};
const fail=(code:string)=>Object.assign(new Error(code),{code});
const folder=process.env.CREATIVE_PILOT_PRIVATE_DIR??'/pilot-private';
const ledgerPath=join(folder,'technical-identities.json');
const action=process.argv[2];
async function save(ledger:Ledger){await writeFile(ledgerPath+'.tmp',JSON.stringify(ledger,null,2)+'\n',{mode:0o600});await chmod(ledgerPath+'.tmp',0o600);await rename(ledgerPath+'.tmp',ledgerPath);}
async function ledger(create:boolean):Promise<Ledger>{
 await mkdir(folder,{recursive:true,mode:0o700});if((await stat(folder)).mode&0o077)throw fail('PRIVATE_DIRECTORY_REQUIRED');
 try{if((await stat(ledgerPath)).mode&0o077)throw fail('PRIVATE_FILE_REQUIRED');return JSON.parse(await readFile(ledgerPath,'utf8'));}
 catch(error:any){if(error.code!=='ENOENT'||!create)throw error;}
 const workspace=process.env.WORKSPACE_ID;if(!workspace)throw fail('WORKSPACE_REQUIRED');
 const origin=process.env.BETTER_AUTH_URL;if(!origin||new URL(origin).protocol!=='https:')throw fail('HTTPS_ORIGIN_REQUIRED');
 const id=randomUUID();const result:Ledger={schema_version:1,pilot_id:id,workspace_id:workspace,origin:new URL(origin).origin,created_at:new Date().toISOString(),expires_at:new Date(Date.now()+86400000).toISOString(),authorization_sha256:AUTHORIZATION,identities:['administrator','reader'].map((kind:any)=>({kind,email:`creative-pilot-${kind}-${id}@commerce-os.invalid`,password:randomBytes(36).toString('base64url'),name:`Piloto técnico temporal · ${kind}`}))};
 await save(result);return result;
}
async function proof(c:QueryExecutor,data:Ledger,identity:Identity){
 const found=(await c.query('SELECT u.id,m.role,m.active FROM "user" u JOIN memberships m ON m.user_id=u.id AND m.workspace_id=$2 WHERE u.email=$1',[identity.email,data.workspace_id])).rows[0];
 if(!found)return null;
 const event=(await c.query("SELECT id FROM domain_events WHERE workspace_id=$1 AND event_type='creative.technical_identity.provisioned' AND payload->>'pilot_id'=$2 AND payload->>'user_id'=$3 AND payload->>'authorization_sha256'=$4",[data.workspace_id,data.pilot_id,found.id,AUTHORIZATION])).rows[0];
 if(!event||identity.id&&identity.id!==found.id||found.role!=='viewer')throw fail('IDENTITY_OWNERSHIP_CHECK_FAILED');
 return found;
}
async function audit(c:QueryExecutor,data:Ledger,identity:Identity,event:string,payload:Record<string,any>={}){
 const correlation=randomUUID();await identityAudit(c,'creative.technical_identity.'+event,'SUCCESS',correlation,identity.id);
 await appendEvent(c,{workspace_id:data.workspace_id,environment:'REAL',event_type:'creative.technical_identity.'+event,aggregate_id:data.pilot_id,correlation_id:correlation,actor:{type:'technical_provisioner',authority:'DELEGATED_PILOT'},payload:{pilot_id:data.pilot_id,user_id:identity.id,kind:identity.kind,role:'viewer',authorization_sha256:AUTHORIZATION,expires_at:data.expires_at,...payload}});
}
async function run(){
 if(!['prepare','provision','grants','revoke','status'].includes(action))throw fail('EXPLICIT_ACTION_REQUIRED');
 const data=await ledger(action==='prepare'||action==='provision');
 if(data.authorization_sha256!==AUTHORIZATION||data.workspace_id!==process.env.WORKSPACE_ID||data.schema_version!==1||data.identities.length!==2||data.identities.some(i=>!i.email.endsWith('@commerce-os.invalid')||!i.email.includes(data.pilot_id)))throw fail('LEDGER_VALIDATION_FAILED');
 if(!['revoke','status'].includes(action)&&Date.parse(data.expires_at)<=Date.now())throw fail('PILOT_EXPIRED');
 if(action==='prepare')return {status:'PREPARED',pilot_id:data.pilot_id,expires_at:data.expires_at};
 const result=await withTransaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['creative.technical_pilot:'+data.pilot_id]);
  const creative=!!(await c.query("SELECT to_regclass('public.creative_members') IS NOT NULL AS present")).rows[0].present;
  const statuses=[];
  for(const identity of data.identities){
   let found=await proof(c,data,identity);
   if(action==='provision'&&!found){
    const user=await provisionUser({email:identity.email,password:identity.password,name:identity.name,workspace_id:data.workspace_id,role:'viewer'},c);identity.id=user.id;await audit(c,data,identity,'provisioned');found={id:user.id,role:'viewer',active:true};
   }
   if(!found)throw fail('TECHNICAL_IDENTITY_MISSING');identity.id=found.id;
   if(action==='grants'){
    if(!found.active)throw fail('TECHNICAL_IDENTITY_INACTIVE');
    if(!creative)throw fail('CREATIVE_MIGRATION_REQUIRED');
    const scopes=identity.kind==='administrator'?administratorScopes:readerScopes;
    const existing=(await c.query('SELECT scopes,project_ids FROM creative_members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[data.workspace_id,identity.id])).rows[0];
    if(!existing){await c.query('INSERT INTO creative_members(workspace_id,user_id,scopes,project_ids) VALUES($1,$2,$3,$4)',[data.workspace_id,identity.id,scopes,identity.kind==='administrator'?null:[]]);await audit(c,data,identity,'granted',{scopes,projects:identity.kind==='administrator'?'PILOT_CREATION':[]});}
    else if(JSON.stringify([...existing.scopes].sort())!==JSON.stringify([...scopes].sort()))throw fail('CREATIVE_GRANT_DRIFT');
   }
   if(action==='revoke'&&found.active){
    await c.query('UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2',[identity.id,data.workspace_id]);
    await c.query('DELETE FROM session WHERE "userId"=$1',[identity.id]);
    await c.query('UPDATE service_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE actor_id=$1 AND workspace_id=$2',[identity.id,data.workspace_id]);
    if(creative){await c.query('UPDATE creative_members SET scopes=ARRAY[]::text[],project_ids=ARRAY[]::uuid[],version=version+1,updated_at=now() WHERE user_id=$1 AND workspace_id=$2',[identity.id,data.workspace_id]);await c.query("UPDATE creative_devices SET status='REVOKED',revoked_at=COALESCE(revoked_at,now()),version=version+1 WHERE owner_id=$1 AND workspace_id=$2 AND status<>'REVOKED'",[identity.id,data.workspace_id]);}
    await audit(c,data,identity,'revoked');
   }
   statuses.push({kind:identity.kind,user_id:identity.id,role:'viewer',active:action==='revoke'?false:found.active});
  }
  return {status:action.toUpperCase(),pilot_id:data.pilot_id,expires_at:data.expires_at,creative_schema:creative,identities:statuses};
 });
 await save(data);
 if(action==='provision')for(const identity of data.identities){await writeFile(join(folder,`login-${identity.kind}.env`),`BOOTSTRAP_EMAIL=${identity.email}\nBOOTSTRAP_PASSWORD=${identity.password}\nBETTER_AUTH_URL=${data.origin}\n`,{mode:0o600});await chmod(join(folder,`login-${identity.kind}.env`),0o600);}
 return result;
}
try{console.log(JSON.stringify(await run()));}catch(error:any){console.error(JSON.stringify({status:'FAILED',code:/^[A-Z0-9_]+$/.test(error.code??'')?error.code:'TECHNICAL_PILOT_FAILED'}));process.exitCode=1;}finally{await pool.end();}
