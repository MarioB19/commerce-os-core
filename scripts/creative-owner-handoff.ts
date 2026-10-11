/** Explicit delegated setup for one owner's MCP token and one idle Mac. Never changes a password. */
import {randomBytes,randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile,writeFile,rename,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {pool,withTransaction,appendEvent,hash,stableJson,type QueryExecutor} from '../packages/db/src/index.js';
import {identityAudit} from '../packages/db/src/identity.js';

export const HANDOFF_AUTHORIZATION='dc6656c7b81d5af72b514a273a6d87d668642f27edba7feae3ef214c09d5aa3b';
export const HANDOFF_SCOPES=['intelligence:read','intelligence:refresh','studio:read'];
export const handoffInputSchema=z.object({schema_version:z.literal(1),workspace_id:z.string().min(1).max(100),owner_email_sha256:z.string().regex(/^[a-f0-9]{64}$/),authorization_sha256:z.literal(HANDOFF_AUTHORIZATION),pilot_id:z.uuid(),pilot_owner_id:z.string().min(1).max(100),mac_device_id:z.uuid(),project_ids:z.array(z.uuid()).min(1).max(100)}).strict().refine(v=>new Set(v.project_ids).size===v.project_ids.length,'Unique projects required');
export type HandoffInput=z.infer<typeof handoffInputSchema>;
type Ledger={schema_version:1;id:string;input_sha256:string;owner_id:string;token_id:string;token:string;expires_at:string;created_at:string};
const failure=(code:string)=>Object.assign(new Error(code),{code});
async function privateDirectory(directory:string){await mkdir(directory,{recursive:true,mode:0o700});const s=await lstat(directory);if(s.isSymbolicLink()||!s.isDirectory()||(s.mode&0o077))throw failure('HANDOFF_PRIVATE_DIRECTORY_REQUIRED');}
async function privateRead(path:string){const s=await lstat(path);if(s.isSymbolicLink()||!s.isFile()||(s.mode&0o077))throw failure('HANDOFF_PRIVATE_FILE_REQUIRED');return readFile(path,'utf8');}
async function privateWrite(path:string,value:string){try{await privateRead(path);}catch(error:any){if(error.code!=='ENOENT')throw error;}const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,value,{mode:0o600,flag:'wx'});await chmod(tmp,0o600);await rename(tmp,path);}
async function audit(c:QueryExecutor,input:HandoffInput,event:string,id:string,payload:Record<string,unknown>){const correlation=randomUUID();await identityAudit(c,event,'SUCCESS',correlation,undefined,'creative-owner-handoff');await appendEvent(c,{workspace_id:input.workspace_id,environment:'REAL',event_type:event,aggregate_id:id,correlation_id:correlation,actor:{type:'technical_setup',authority:'DELEGATED_SETUP'},payload:{authorization_sha256:HANDOFF_AUTHORIZATION,input_sha256:hash(stableJson(input)),...payload}});}
async function owner(c:QueryExecutor,input:HandoffInput){const rows=(await c.query('SELECT u.id FROM "user" u JOIN memberships m ON m.user_id=u.id WHERE m.workspace_id=$1 AND m.active=true AND m.role=\'owner\' AND encode(digest(lower(trim(u.email)),\'sha256\'),\'hex\')=$2 FOR SHARE OF m',[input.workspace_id,input.owner_email_sha256])).rows;if(rows.length!==1)throw failure('HANDOFF_OWNER_MATCH_REQUIRED');return String(rows[0].id);}
async function pilot(c:QueryExecutor,input:HandoffInput){if(!(await c.query("SELECT 1 FROM domain_events WHERE workspace_id=$1 AND event_type='creative.technical_identity.provisioned' AND payload->>'pilot_id'=$2 AND payload->>'user_id'=$3 AND payload->>'authorization_sha256'=$4",[input.workspace_id,input.pilot_id,input.pilot_owner_id,HANDOFF_AUTHORIZATION])).rowCount)throw failure('HANDOFF_PILOT_PROVENANCE_REQUIRED');}
async function readLedger(directory:string){try{return JSON.parse(await privateRead(join(directory,'handoff-ledger.json'))) as Ledger;}catch(error:any){if(error.code==='ENOENT')return null;throw error;}}
function validateLedger(ledger:Ledger,input:HandoffInput,ownerId:string){if(ledger.schema_version!==1||ledger.input_sha256!==hash(stableJson(input))||ledger.owner_id!==ownerId||!/^cosp_[A-Za-z0-9_-]{43}$/.test(ledger.token)||!z.uuid().safeParse(ledger.token_id).success||![ledger.expires_at,ledger.created_at].every(v=>z.iso.datetime().safeParse(v).success)||Date.parse(ledger.expires_at)>Date.parse(ledger.created_at)+30*86400000||Date.parse(ledger.expires_at)<=Date.now())throw failure('HANDOFF_LEDGER_CONFLICT');}

export async function executeOwnerHandoff(action:'inspect'|'token'|'transfer-mac',rawInput:unknown,directory:string){
 const input=handoffInputSchema.parse(rawInput);await privateDirectory(directory);
 return withTransaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['creative-owner-handoff:'+input.workspace_id+':'+input.owner_email_sha256]);
  const ownerId=await owner(c,input);await pilot(c,input);
  if(ownerId===input.pilot_owner_id)throw failure('HANDOFF_DISTINCT_OWNER_REQUIRED');
  if(action==='inspect')return{status:'OWNER_MATCHED',owner_id:ownerId,authorization_sha256:HANDOFF_AUTHORIZATION,authority:'DELEGATED_SETUP',mutation:false};
  if(action==='token'){
   let ledger=await readLedger(directory);
   if(!ledger){if((await c.query("SELECT 1 FROM domain_events WHERE workspace_id=$1 AND event_type='creative.owner_handoff.token_created' AND payload->>'input_sha256'=$2",[input.workspace_id,hash(stableJson(input))])).rowCount)throw failure('HANDOFF_PRIVATE_LEDGER_REQUIRED');const created=Date.now();ledger={schema_version:1,id:randomUUID(),input_sha256:hash(stableJson(input)),owner_id:ownerId,token_id:randomUUID(),token:'cosp_'+randomBytes(32).toString('base64url'),created_at:new Date(created).toISOString(),expires_at:new Date(created+30*86400000).toISOString()};await privateWrite(join(directory,'handoff-ledger.json'),JSON.stringify(ledger,null,2)+'\n');}
   validateLedger(ledger,input,ownerId);await privateWrite(join(directory,'mcp-token'),ledger.token+'\n');
   const existing=(await c.query('SELECT * FROM service_tokens WHERE id=$1 FOR UPDATE',[ledger.token_id])).rows[0];
   if(existing){const proof=(await c.query("SELECT 1 FROM domain_events WHERE workspace_id=$1 AND event_type='creative.owner_handoff.token_created' AND aggregate_id=$2 AND payload->>'input_sha256'=$3 AND payload->>'authorization_sha256'=$4",[input.workspace_id,ledger.token_id,ledger.input_sha256,HANDOFF_AUTHORIZATION])).rowCount;if(!proof||existing.actor_id!==ownerId||existing.workspace_id!==input.workspace_id||existing.token_hash!==hash(ledger.token)||existing.revoked_at||stableJson(existing.scopes)!==stableJson(HANDOFF_SCOPES)||stableJson(existing.allowed_environments)!==stableJson(['REAL'])||existing.resource_ids!==null||new Date(existing.expires_at).toISOString()!==ledger.expires_at)throw failure('HANDOFF_TOKEN_DRIFT');}
   else{await c.query('INSERT INTO service_tokens(id,workspace_id,actor_id,name,token_hash,scopes,expires_at,allowed_environments,resource_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL)',[ledger.token_id,input.workspace_id,ownerId,'Commerce OS · Codex MCP · configuración delegada',hash(ledger.token),JSON.stringify(HANDOFF_SCOPES),ledger.expires_at,JSON.stringify(['REAL'])]);await audit(c,input,'creative.owner_handoff.token_created',ledger.token_id,{owner_id:ownerId,scopes:HANDOFF_SCOPES,expires_at:ledger.expires_at,allowed_environments:['REAL'],resource_ids:null,review_authorized:false});}
   return{status:existing?'TOKEN_REUSED':'TOKEN_CREATED',owner_id:ownerId,token_id:ledger.token_id,expires_at:ledger.expires_at,scopes:HANDOFF_SCOPES,allowed_environments:['REAL'],resource_ids:null,private_token_file:join(directory,'mcp-token'),authority:'DELEGATED_SETUP'};
  }
  if(action==='transfer-mac')throw failure('PLATFORM_PRODUCTION_RETIRED');
  throw failure('HANDOFF_ACTION_REQUIRED');

 });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const[action,inputPath,directory]=process.argv.slice(2);if(!['inspect','token','transfer-mac'].includes(action??'')||!inputPath||!directory)throw failure('HANDOFF_EXPLICIT_ARGUMENTS_REQUIRED');const input=JSON.parse(await privateRead(inputPath));console.log(JSON.stringify(await executeOwnerHandoff(action as 'inspect'|'token'|'transfer-mac',input,directory)));}
 catch(error:any){console.error(JSON.stringify({status:'FAILED',code:/^[A-Z0-9_]+$/.test(error.code??'')?error.code:'OWNER_HANDOFF_FAILED'}));process.exitCode=1;}
 finally{await pool.end();}
}
