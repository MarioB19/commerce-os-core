import {integrationPermission} from './integration-diagnostics.js';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from '../../../packages/db/src/index.js';
import {readGlobalBudget} from '../../../packages/provider-broker/src/global-budget.js';
import {expectedVersion} from './creative-security.js';
import {principal,parseBody,fail,mutate,audit} from './context.js';
export async function providerBudgetRoutes(app:FastifyInstance){
 app.get('/v1/provider-budgets/global',async req=>{integrationPermission(req,'read','provider-budget:global');return{data:await readGlobalBudget(pool,principal(req).workspace_id)};});
 app.put('/v1/provider-budgets/global',async(req,reply)=>{
  integrationPermission(req,'write','provider-budget:global');
  const b=parseBody(req),version=expectedVersion(b),input=z.object({limit_usd:z.number().min(0).max(1500),authorization_source:z.string().min(10).max(1500),expires_at:z.string().datetime(),external_status:z.enum(['NONE','KNOWN','UNKNOWN']),external_reserved_usd:z.number().min(0).max(100000),external_source:z.string().min(10).max(1500).optional(),external_expires_at:z.string().datetime().optional()}).parse(b);
  const future=(s:string)=>Date.parse(s)>Date.now()&&Date.parse(s)<=Date.now()+32*86400000;
  if(!future(input.expires_at)||input.external_status==='KNOWN'&&(!input.external_source||!input.external_expires_at||!future(input.external_expires_at)))throw fail(400,'BUDGET_EXPIRY_REQUIRED');
  if(input.external_status==='NONE'&&input.external_reserved_usd!==0)throw fail(400,'EXTERNAL_RESERVATION_CONFLICT');
  const result=await mutate(req,'provider.global-budget',async c=>{
   const p=principal(req);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`creative-provider:${p.workspace_id}`]);
   const old=await readGlobalBudget(c,p.workspace_id);if(old.version!==version)throw fail(409,'VERSION_CONFLICT');
   if(Math.round((old.spent_usd+old.reserved_usd+input.external_reserved_usd)*1e6)>Math.round(input.limit_usd*1e6))throw fail(409,'BUDGET_BELOW_COMMITTED');
   await c.query(`INSERT INTO creative_global_budgets(workspace_id,limit_usd,authorization_source,actor_id,expires_at,external_status,external_reserved_usd,external_source,external_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(workspace_id) DO UPDATE SET version=creative_global_budgets.version+1,limit_usd=EXCLUDED.limit_usd,authorization_source=EXCLUDED.authorization_source,actor_id=EXCLUDED.actor_id,expires_at=EXCLUDED.expires_at,external_status=EXCLUDED.external_status,external_reserved_usd=EXCLUDED.external_reserved_usd,external_source=EXCLUDED.external_source,external_expires_at=EXCLUDED.external_expires_at,updated_at=now()`,[p.workspace_id,input.limit_usd,input.authorization_source,p.user.id,input.expires_at,input.external_status,input.external_reserved_usd,input.external_source??null,input.external_expires_at??null]);
   await audit(c,req,'provider.global-budget.authorized',p.workspace_id,{...input,version:version+1});return{data:await readGlobalBudget(c,p.workspace_id)};
  });return reply.code(result.status??200).send(result);
 });
}
