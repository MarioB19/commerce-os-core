import type {FastifyInstance,FastifyReply} from 'fastify';
import {z} from 'zod';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
import {campaignPerformance,campaignFilterSchema} from './campaign-performance.js';

/** V7 F7 Campañas (RF-11.a/c, RF-09.k): read only. Spend, conversations and
 * the sales they brought, crossed with the payments register (receipt_sales_v1),
 * under the selected profile. Nothing here creates, pauses, edits or funds a
 * campaign: the profile's own Meta token only reads insights. */
const query=z.object({from:z.string(),to:z.string(),currency:z.string().regex(/^[A-Z]{3}$/).optional(),granularity:z.enum(['day','week','month']).optional(),
 campaign_id:z.string().regex(/^\d+$/).optional(),meta_ad_account_id:z.string().regex(/^act_\d+$/).optional(),environment:z.literal('REAL').optional()}).strict();
function headers(reply:FastifyReply){reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization');}
export async function campaignsV2Routes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 app.get('/v2/campaigns',async(req,reply)=>{headers(reply);const {environment:_,...q}=query.parse(req.query??{});
  const filters=campaignFilterSchema.parse({...q,environment:'REAL',limit:100});
  return{data:await withProfileRequest(req,'REAL',{scope:'campaigns:read',mutation:false},async({db})=>{
   const accounts=(await db.query(`SELECT meta_ad_account_id,name,currency,timezone,status,last_success_at FROM meta_insight_accounts WHERE workspace_id=$1 AND environment='REAL' ORDER BY name,meta_ad_account_id`,[db.workspaceId])).rows
    .map(a=>({id:String(a.meta_ad_account_id),name:String(a.name),currency:String(a.currency),timezone:String(a.timezone),status:String(a.status),last_success_at:a.last_success_at?new Date(a.last_success_at).toISOString():null}));
   if(!accounts.length)return{connected:false,accounts,report:null,note:'Conecta tu cuenta de Meta en Integraciones para ver tus campañas. Sólo se lee: nada cambia en tus anuncios.'};
   return{connected:true,accounts,report:await campaignPerformance(db as never,db.workspaceId,'REAL',filters),read_only:true};
  },deps)};});
}
