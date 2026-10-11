/** Explicit administrative bootstrap for a real owner's personal API credential. */
import {randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {pool,withTransaction,hash,stableJson,appendEvent} from '../packages/db/src/index.js';
import {insertPersonalToken,newPersonalToken} from '../packages/db/src/personal-access-tokens.js';

export const ownerTokenInput=z.object({operation_id:z.string().uuid(),workspace_id:z.string().min(1).max(100).optional(),owner_email_sha256:z.string().regex(/^[a-f0-9]{64}$/),authorization_sha256:z.string().regex(/^[a-f0-9]{64}$/),confirmation:z.literal('CREATE_OWNER_API_TOKEN'),name:z.string().trim().min(1).max(100),reason:z.string().trim().min(20).max(1000),allowed_environments:z.array(z.enum(['REAL','SIMULATION'])).min(1).max(2),expires_at:z.string().datetime({offset:true})}).strict().refine(x=>new Set(x.allowed_environments).size===x.allowed_environments.length);
const fail=(code:string)=>Object.assign(new Error(code),{code});
async function privateFile(path:string){const s=await lstat(path);if(s.isSymbolicLink()||!s.isFile()||(s.mode&0o077))throw fail('PRIVATE_FILE_REQUIRED');return readFile(path,'utf8');}
export async function issueOwnerToken(action:'inspect'|'issue'|'readback',raw:unknown,directory:string){
 const requested=ownerTokenInput.parse(raw);
 await mkdir(directory,{recursive:true,mode:0o700});const ds=await lstat(directory);if(ds.isSymbolicLink()||!ds.isDirectory()||(ds.mode&0o077))throw fail('PRIVATE_DIRECTORY_REQUIRED');
 return withTransaction(async c=>{
  const rows=(await c.query(`SELECT u.id,m.workspace_id FROM "user" u JOIN memberships m ON m.user_id=u.id WHERE ($1::text IS NULL OR m.workspace_id=$1) AND m.active=true AND m.role='owner' AND encode(digest(lower(trim(u.email)),'sha256'),'hex')=$2 FOR SHARE OF m`,[requested.workspace_id??null,requested.owner_email_sha256])).rows;
  if(rows.length!==1)throw fail('EXACT_ACTIVE_OWNER_REQUIRED');const userId=rows[0].id,input={...requested,workspace_id:String(rows[0].workspace_id)},digest=hash(stableJson(input));
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['owner-pat:'+input.workspace_id+':'+input.operation_id]);
  const prior=(await c.query("SELECT payload,aggregate_id FROM domain_events WHERE workspace_id=$1 AND event_type='personal_access_token.bootstrap' AND payload->>'operation_id'=$2",[input.workspace_id,input.operation_id])).rows[0];
  if(prior&&prior.payload.input_sha256!==digest)throw fail('BOOTSTRAP_INPUT_CONFLICT');
  const ledgerPath=join(directory,'ledger.json');let ledger:{input_sha256:string;user_id:string;token_id:string;token:string}|undefined;
  try{ledger=JSON.parse(await privateFile(ledgerPath));}catch(e:any){if(e.code!=='ENOENT')throw e;}
  if(ledger&&(ledger.input_sha256!==digest||ledger.user_id!==userId||!/^cos_pat_[A-Za-z0-9_-]{43}$/.test(ledger.token)||!z.string().uuid().safeParse(ledger.token_id).success))throw fail('PRIVATE_LEDGER_CONFLICT');
  if(action==='inspect')return{status:'OWNER_MATCHED',previous_issue:!!prior,private_ledger_present:!!ledger,mutation:false};
  if(!ledger){if(prior||action==='readback')throw fail('PRIVATE_LEDGER_REQUIRED');ledger={input_sha256:digest,user_id:userId,token_id:randomUUID(),token:newPersonalToken()};await writeFile(ledgerPath,JSON.stringify(ledger)+'\n',{mode:0o600,flag:'wx'});}
  const existing=(await c.query('SELECT * FROM personal_access_tokens WHERE id=$1 FOR UPDATE',[ledger.token_id])).rows[0];
  if(existing){if(!prior||prior.aggregate_id!==ledger.token_id||existing.token_hash!==hash(ledger.token)||existing.workspace_id!==input.workspace_id||existing.user_id!==userId||stableJson(existing.allowed_environments)!==stableJson(input.allowed_environments)||new Date(existing.expires_at).toISOString()!==new Date(input.expires_at).toISOString())throw fail('TOKEN_READBACK_MISMATCH');if(existing.revoked_at)throw fail('TOKEN_REVOKED');if(new Date(existing.expires_at).getTime()<=Date.now())throw fail('TOKEN_EXPIRED');}
  else {
   if(action==='readback'||prior)throw fail('TOKEN_NOT_FOUND');if(Date.parse(input.expires_at)<=Date.now()||Date.parse(input.expires_at)>Date.now()+30*86400000)throw fail('BOOTSTRAP_EXPIRY_MAX_30_DAYS');
   await insertPersonalToken(c,{...input,user_id:userId},ledger.token,ledger.token_id);
   await appendEvent(c,{workspace_id:input.workspace_id,environment:input.allowed_environments[0]!,event_type:'personal_access_token.bootstrap',aggregate_id:ledger.token_id,actor:{type:'administrative_setup',id:userId,authority:'OWNER_AUTHORIZED_PERSONAL_API'},payload:{operation_id:input.operation_id,input_sha256:digest,authorization_sha256:input.authorization_sha256,reason:input.reason,allowed_environments:input.allowed_environments,expires_at:input.expires_at,commercial_activation_authorized:false}});
  }
  const tokenPath=join(directory,'personal-token');try{await writeFile(tokenPath,ledger.token+'\n',{mode:0o600,flag:'wx'});}catch(e:any){if(e.code!=='EEXIST')throw e;if((await privateFile(tokenPath)).trim()!==ledger.token)throw fail('TOKEN_FILE_CONFLICT');}
  return{status:existing?'ACTIVE_READBACK_VERIFIED':'CREATED',authentication_method:'personal_access_token',role:'owner',allowed_environments:input.allowed_environments,expires_at:input.expires_at,readback_verified:true,commercial_activation_authorized:false};
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const[action,inputPath,directory]=process.argv.slice(2);if(!['inspect','issue','readback'].includes(action??'')||!inputPath||!directory)throw fail('EXPLICIT_ARGUMENTS_REQUIRED');const result=await issueOwnerToken(action as 'inspect'|'issue'|'readback',JSON.parse(await privateFile(inputPath)),directory);await writeFile(join(directory,'receipt.json'),JSON.stringify(result)+'\n',{mode:0o600});console.log(JSON.stringify(result));}
 catch(e:any){console.error(JSON.stringify({status:'FAILED',code:/^[A-Z0-9_]+$/.test(e.code??'')?e.code:'OWNER_CREDENTIAL_OPERATION_FAILED'}));process.exitCode=1;}
 finally{await pool.end();}
}
