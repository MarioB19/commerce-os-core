import {encrypt} from './index.js';
import type {ProfileExecutor} from './profile-context.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';

/** V7 F2 profile Meta token (RF-11.a/b, D-06) and onboarding state (RF-13.c,
 * RF-04.d). The Meta token is the business's own system-user token used only
 * for official GET reads; the API stores ciphertext and a four-character hint
 * and never reads the secret back. */
export class IntegrationError extends Error{constructor(readonly code:string,readonly statusCode=409){super(code);}}
function need(value:unknown,code:string,status=409):asserts value{if(!value)throw new IntegrationError(code,status);}
async function moment(db:ProfileExecutor){return new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now);}
async function authorize(db:ProfileExecutor,authority:ProfileAuthority,scope:'integrations:read'|'integrations:write'|'profile:read'|'profile:write',mutation:boolean,interactiveOnly=false){
 authorizeProfileAction(authority,{scope,workspaceId:db.workspaceId,mutation,interactiveOnly},await moment(db));
}
const iso=(v:unknown)=>v===null||v===undefined?null:new Date(v as string).toISOString();
export const META_REQUIRED_PERMISSIONS=['ads_read'] as const;
export type MetaState='MISSING'|'UNVERIFIED'|'VERIFIED'|'INVALID'|'DISABLED';
export interface MetaIntegrationView {state:MetaState;revision:number;enabled:boolean;hint:string|null;reason:string|null;checkedAt:string|null;grantedScopes:string[];updatedAt:string|null}
export async function readMetaIntegration(db:ProfileExecutor,authority:ProfileAuthority):Promise<MetaIntegrationView>{
 await authorize(db,authority,'integrations:read',false);
 const row=(await db.query(`SELECT c.revision,c.enabled,c.state,c.reason,c.checked_at,c.granted_scopes,c.updated_at,v.key_hint FROM meta_profile_credentials c
  JOIN meta_profile_credential_versions v ON (v.workspace_id,v.revision)=(c.workspace_id,c.revision) WHERE c.workspace_id=$1`,[db.workspaceId])).rows[0];
 if(!row)return{state:'MISSING',revision:0,enabled:false,hint:null,reason:null,checkedAt:null,grantedScopes:[],updatedAt:null};
 return{state:row.enabled?row.state:'DISABLED',revision:row.revision,enabled:row.enabled,hint:'••••'+row.key_hint,reason:row.reason,checkedAt:iso(row.checked_at),grantedScopes:[...row.granted_scopes],updatedAt:iso(row.updated_at)};
}
const tokenPattern=/^[A-Za-z0-9_|.-]{20,4096}$/;
/** Interactive owner action: a new revision, always UNVERIFIED until checked. */
export async function saveMetaToken(db:ProfileExecutor,authority:ProfileAuthority,input:{expectedRevision:number;token:string}){
 await authorize(db,authority,'integrations:write',true,true);
 need(Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0&&typeof input.token==='string'&&tokenPattern.test(input.token),'META_TOKEN_INVALID',400);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['meta-token:'+db.workspaceId]);
 const prior=(await db.query('SELECT revision FROM meta_profile_credentials WHERE workspace_id=$1 FOR UPDATE',[db.workspaceId])).rows[0];
 need((prior?.revision??0)===input.expectedRevision,'META_TOKEN_VERSION_CONFLICT');
 const revision=input.expectedRevision+1,actor=authority.membership.userId;
 const ciphertext=encrypt({scope:'profile.meta.token.v1',workspaceId:db.workspaceId,revision,token:input.token});
 await db.query('INSERT INTO meta_profile_credential_versions(workspace_id,revision,ciphertext,key_hint,created_by) VALUES($1,$2,$3,$4,$5)',[db.workspaceId,revision,ciphertext,input.token.slice(-4),actor]);
 if(prior)await db.query("UPDATE meta_profile_credentials SET revision=$2,enabled=true,state='UNVERIFIED',reason=NULL,checked_at=NULL,granted_scopes='{}',updated_by=$3 WHERE workspace_id=$1 AND revision=$4",[db.workspaceId,revision,actor,input.expectedRevision]);
 else await db.query('INSERT INTO meta_profile_credentials(workspace_id,revision,updated_by) VALUES($1,1,$2)',[db.workspaceId,actor]);
 return{revision};
}
export type MetaCheck={state:'VERIFIED';grantedScopes:string[]}|{state:'INVALID';reason:string;grantedScopes:string[]}|{state:'UNKNOWN';reason:string};
/** Official read-only checks with the token still in memory: the token must be
 * valid and grant every read permission V7 needs. Never retried, never a write. */
export async function checkMetaToken(token:string,fetcher:typeof fetch=fetch,graph='https://graph.facebook.com/v26.0'):Promise<MetaCheck>{
 const call=async(path:string)=>{
  const response=await fetcher(graph+path,{method:'GET',headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(10000)});
  const text=await response.text();if(text.length>262144)throw Error('META_RESPONSE_LIMIT');
  let body:any;try{body=JSON.parse(text);}catch{body=null;}
  return{status:response.status,body};
 };
 try{
  const me=await call('/me?fields=id');
  if(me.status!==200){const code=Number(me.body?.error?.code);return code===190?{state:'INVALID',reason:'META_TOKEN_EXPIRED',grantedScopes:[]}:[10,200,294].includes(code)?{state:'INVALID',reason:'META_PERMISSION_DENIED',grantedScopes:[]}:me.status>=500||me.status===429?{state:'UNKNOWN',reason:'META_UPSTREAM_UNAVAILABLE'}:{state:'INVALID',reason:'META_REQUEST_REJECTED',grantedScopes:[]};}
  const permissions=await call('/me/permissions');
  if(permissions.status!==200||!Array.isArray(permissions.body?.data))return{state:'UNKNOWN',reason:'META_UPSTREAM_UNAVAILABLE'};
  const granted=[...new Set(permissions.body.data.filter((p:any)=>p&&p.status==='granted'&&typeof p.permission==='string'&&/^[a-z_]{1,60}$/.test(p.permission)).map((p:any)=>p.permission as string))].sort().slice(0,40) as string[];
  return META_REQUIRED_PERMISSIONS.every(p=>granted.includes(p))?{state:'VERIFIED',grantedScopes:granted}:{state:'INVALID',reason:'META_PERMISSION_MISSING',grantedScopes:granted};
 }catch{return{state:'UNKNOWN',reason:'META_UPSTREAM_UNAVAILABLE'};}
}
/** Records a conclusive check only for the exact revision that was checked. */
export async function recordMetaCheck(db:ProfileExecutor,authority:ProfileAuthority,revision:number,check:MetaCheck){
 await authorize(db,authority,'integrations:write',true);
 if(check.state==='UNKNOWN')return{recorded:false};
 const row=(await db.query('UPDATE meta_profile_credentials SET state=$3,reason=$4,checked_at=clock_timestamp(),granted_scopes=$5,updated_by=$6 WHERE workspace_id=$1 AND revision=$2 RETURNING revision',
  [db.workspaceId,revision,check.state,check.state==='INVALID'?check.reason:null,check.grantedScopes,authority.membership.userId])).rows[0];
 return{recorded:Boolean(row)};
}
export async function setMetaEnabled(db:ProfileExecutor,authority:ProfileAuthority,input:{expectedRevision:number;enabled:boolean}){
 await authorize(db,authority,'integrations:write',true);
 need(Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>0&&typeof input.enabled==='boolean','META_INPUT_INVALID',400);
 const row=(await db.query('UPDATE meta_profile_credentials SET enabled=$3,updated_by=$4 WHERE workspace_id=$1 AND revision=$2 RETURNING revision,enabled',[db.workspaceId,input.expectedRevision,input.enabled,authority.membership.userId])).rows[0];
 need(row,'META_TOKEN_VERSION_CONFLICT');return{revision:row.revision as number,enabled:row.enabled as boolean};
}

export type OnboardingStep='ai'|'meta'|'product'|'number';
export type StepState='DONE'|'SKIPPED'|'PENDING';
export interface OnboardingView {version:number;dismissed:boolean;complete:boolean;next:OnboardingStep|null;steps:Record<OnboardingStep,StepState>}
/** Derived from facts; only the Meta skip and the dismissal are stored. */
export async function readOnboarding(db:ProfileExecutor,authority:ProfileAuthority):Promise<OnboardingView>{
 await authorize(db,authority,'profile:read',false);
 const facts=(await db.query(`SELECT
   EXISTS(SELECT 1 FROM ai_credentials WHERE workspace_id=$1 AND environment='REAL' AND enabled AND state='VERIFIED') AS ai,
   EXISTS(SELECT 1 FROM meta_profile_credentials WHERE workspace_id=$1 AND enabled AND state='VERIFIED') AS meta,
   EXISTS(SELECT 1 FROM market_variants WHERE workspace_id=$1 AND environment='REAL') AS product,
   EXISTS(SELECT 1 FROM records WHERE workspace_id=$1 AND environment='REAL' AND kind='channel_account' AND COALESCE(body->>'status','')<>'ARCHIVED') AS number`,[db.workspaceId])).rows[0];
 const stored=(await db.query('SELECT version,meta_skipped,dismissed FROM profile_onboarding WHERE workspace_id=$1',[db.workspaceId])).rows[0];
 const steps:Record<OnboardingStep,StepState>={ai:facts.ai?'DONE':'PENDING',meta:facts.meta?'DONE':stored?.meta_skipped?'SKIPPED':'PENDING',product:facts.product?'DONE':'PENDING',number:facts.number?'DONE':'PENDING'};
 const order:OnboardingStep[]=['ai','meta','product','number'],next=order.find(step=>steps[step]==='PENDING')??null;
 return{version:stored?.version??0,dismissed:stored?.dismissed??false,complete:next===null,next,steps};
}
export async function updateOnboarding(db:ProfileExecutor,authority:ProfileAuthority,input:{expectedVersion:number;metaSkipped?:boolean;dismissed?:boolean}){
 await authorize(db,authority,'profile:write',true);
 need(Number.isSafeInteger(input.expectedVersion)&&input.expectedVersion>=0&&(input.metaSkipped===undefined||typeof input.metaSkipped==='boolean')&&(input.dismissed===undefined||typeof input.dismissed==='boolean'),'ONBOARDING_INPUT_INVALID',400);
 const prior=(await db.query('SELECT version,meta_skipped,dismissed FROM profile_onboarding WHERE workspace_id=$1 FOR UPDATE',[db.workspaceId])).rows[0];
 need((prior?.version??0)===input.expectedVersion,'ONBOARDING_VERSION_CONFLICT');
 const metaSkipped=input.metaSkipped??prior?.meta_skipped??false,dismissed=input.dismissed??prior?.dismissed??false,actor=authority.membership.userId;
 const row=prior?(await db.query('UPDATE profile_onboarding SET version=version+1,meta_skipped=$2,dismissed=$3,updated_by=$4 WHERE workspace_id=$1 AND version=$5 RETURNING version',[db.workspaceId,metaSkipped,dismissed,actor,input.expectedVersion])).rows[0]
  :(await db.query('INSERT INTO profile_onboarding(workspace_id,version,meta_skipped,dismissed,updated_by) VALUES($1,1,$2,$3,$4) RETURNING version',[db.workspaceId,metaSkipped,dismissed,actor])).rows[0];
 need(row,'ONBOARDING_VERSION_CONFLICT');
 return readOnboarding(db,authority);
}
