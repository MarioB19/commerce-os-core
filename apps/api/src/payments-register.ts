import type {FastifyInstance} from 'fastify';
import {createHash,randomUUID} from 'node:crypto';
import {paymentPageQuerySchema,paymentExportQuerySchema,paymentOptionQuerySchema} from '../../../packages/contracts/src/payments-register.js';
import {listPayments,exportPayments,paymentOptions} from '../../../packages/db/src/payments-register.js';
import {paymentsCsv,paymentsXlsx} from '../../../packages/domain/src/sales/payments-export.js';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';

/** Registration is separate from commercial mounting. Complete all SQL and the
 * final profile authority read before returning data or export bytes. */
export async function paymentsRegisterRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 app.get('/v2/payments/options',async(req,reply)=>{
  reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization, X-Commerce-Profile-Id, X-Commerce-Profile-Version');
  const q=paymentOptionQuerySchema.parse(req.query??{});return withProfileRequest(req,q.environment,{scope:'payments:read',mutation:false},({db})=>paymentOptions(db,q),deps);
 });
 app.get('/v2/payments',async(req,reply)=>{
  reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization, X-Commerce-Profile-Id, X-Commerce-Profile-Version');
  const q=paymentPageQuerySchema.parse(req.query??{});
  const data=await withProfileRequest(req,q.environment,{scope:'payments:read',mutation:false},({db})=>listPayments(db,q),deps);
  return{data};
 });
 app.get('/v2/payments/export',async(req,reply)=>{
  reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization, X-Commerce-Profile-Id, X-Commerce-Profile-Version');
  const {format,...q}=paymentExportQuerySchema.parse(req.query??{});
  const exported=await withProfileRequest(req,q.environment,{scope:'payments:export',mutation:false},async({db,profile})=>{
   const data=await exportPayments(db,q),result=format==='csv'?paymentsCsv(data):paymentsXlsx(data),eventId=randomUUID();
   await db.query('INSERT INTO domain_events(id,workspace_id,environment,event_type,aggregate_id,correlation_id,actor,payload) VALUES($1,$2,$3,$4,$5,$1::uuid::text,$6,$7)',
    [eventId,db.workspaceId,q.environment,'payments.export_prepared',eventId,{type:'human',id:profile.authority.membership.userId},
     {format,rows:data.total,bytes:result.length,sha256:createHash('sha256').update(result).digest('hex'),filter_sha256:createHash('sha256').update(JSON.stringify(q)).digest('hex'),observed_at:data.observedAt}]);
   return{bytes:result,workspaceId:db.workspaceId,sha256:createHash('sha256').update(result).digest('hex')};
  },deps);
  return reply.header('X-Commerce-Profile-Id',exported.workspaceId).header('X-Commerce-Export-SHA256',exported.sha256).header('Content-Type',format==='csv'?'text/csv; charset=utf-8':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
   .header('Content-Disposition',`attachment; filename="payments.${format}"`).header('X-Content-Type-Options','nosniff').send(exported.bytes);
 });
}
