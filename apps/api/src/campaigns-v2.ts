import type {FastifyInstance,FastifyReply} from 'fastify';
import {z} from 'zod';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
import {campaignPerformance,campaignFilterSchema} from './campaign-performance.js';
import {appendEvent} from '../../../packages/db/src/index.js';
import {readMetaSyncState,requestMetaProfileSync} from '../../../packages/db/src/meta-profile-sync.js';

/** V7 F7 Campañas (RF-11.a/c, RF-09.k): read only. Spend, conversations and
 * the sales they brought, crossed with the payments register (receipt_sales_v1),
 * under the selected profile. Nothing here creates, pauses, edits or funds a
 * campaign: the profile's own Meta token only reads insights. The owner may ask
 * for a fresh read (POST /v2/campaigns/sync); the worker performs it with GET
 * calls only, otherwise hourly. */
const query=z.object({from:z.string(),to:z.string(),currency:z.string().regex(/^[A-Z]{3}$/).optional(),granularity:z.enum(['day','week','month']).optional(),
 campaign_id:z.string().regex(/^\d+$/).optional(),meta_ad_account_id:z.string().regex(/^act_\d+$/).optional(),environment:z.literal('REAL').optional()}).strict();
function headers(reply:FastifyReply){reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization');}
export async function campaignsV2Routes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 app.get('/v2/campaigns',async(req,reply)=>{headers(reply);const {environment:_,...q}=query.parse(req.query??{});
  const filters=campaignFilterSchema.parse({...q,environment:'REAL',limit:100});
  return{data:await withProfileRequest(req,'REAL',{scope:'campaigns:read',mutation:false},async({db})=>{
   const sync=await readMetaSyncState(db);
   const accounts=(await db.query(`SELECT meta_ad_account_id,name,currency,timezone,status,last_success_at FROM meta_insight_accounts WHERE workspace_id=$1 AND environment='REAL' ORDER BY name,meta_ad_account_id`,[db.workspaceId])).rows
    .map(a=>({id:String(a.meta_ad_account_id),name:String(a.name),currency:String(a.currency),timezone:String(a.timezone),status:String(a.status),last_success_at:a.last_success_at?new Date(a.last_success_at).toISOString():null}));
   const connected=sync.credential==='VERIFIED';
   if(!accounts.length)return{connected,accounts,report:null,sync,read_only:true,note:connected?(sync.last_sync?.status==='SYNCED'||sync.last_sync?.status==='PARTIAL'?'Tu token de Meta no tiene cuentas publicitarias con datos de lectura.':'Leyendo tus cuentas de Meta por primera vez. Vuelve en unos minutos.'):'Conecta tu cuenta de Meta en Integraciones para ver tus campañas. Sólo se lee: nada cambia en tus anuncios.'};
   return{connected,accounts,report:await campaignPerformance(db as never,db.workspaceId,'REAL',filters),sync,read_only:true};
  },deps)};});
 app.post('/v2/campaigns/sync',{bodyLimit:256},async(req,reply)=>{headers(reply);
  const extra=Object.entries((req.query??{}) as Record<string,unknown>).filter(([k,v])=>!(k==='environment'&&v==='REAL'));
  if(extra.length)throw Object.assign(new Error('PROFILE_QUERY_NOT_ALLOWED'),{code:'PROFILE_QUERY_NOT_ALLOWED',statusCode:400});
  if(req.body!==undefined&&req.body!==null&&!(typeof req.body==='object'&&!Array.isArray(req.body)&&Object.keys(req.body).length===0))throw Object.assign(new Error('META_SYNC_INPUT_INVALID'),{code:'META_SYNC_INPUT_INVALID',statusCode:400});
  return{data:await withProfileRequest(req,'REAL',{scope:'integrations:write',mutation:true},async({db,profile})=>{
   const result=await requestMetaProfileSync(db,{actorId:profile.authority.membership.userId,scheduled:false});
   if(result.status==='NOT_CONNECTED')throw Object.assign(new Error('META_NOT_CONNECTED'),{code:'META_NOT_CONNECTED',statusCode:409});
   if(result.status==='QUEUED')await appendEvent(db,{workspace_id:db.workspaceId,environment:'REAL',event_type:'profile.campaigns.sync_requested',aggregate_id:result.jobId,correlation_id:req.id,
    actor:{type:profile.authority.credential.kind==='session'?'human':'personal_api',id:profile.authority.membership.userId},payload:{job_id:result.jobId,read_only:true}});
   return{...result,read_only:true};
  },deps)};});
}
