import type {FastifyInstance} from 'fastify';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
import {marketQuerySchema,marketIdSchema} from '../../../packages/contracts/src/market-variant-store.js';
import {readMarketRelease} from '../../../packages/db/src/market-variants.js';

/** V7 F8-D: one published release, read by `variants_manage.version`. Variants
 * are created, edited and published through /v2/products and /v2/variants; the
 * F4 market draft routes they replaced were retired. */
export async function marketVariantRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 app.addHook('onRequest',async(_req,reply)=>{reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization, X-Commerce-Profile-Id, X-Commerce-Profile-Version');});
 app.get('/v2/market/releases/:id',async req=>{
  const {environment}=marketQuerySchema.parse(req.query),{id}=marketIdSchema.parse(req.params);
  return withProfileRequest(req,environment,{scope:'variants:read',mutation:false},async({db})=>({data:await readMarketRelease(db,environment,id)}),deps);
 });
}
