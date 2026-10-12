import {readMarketCatalog} from '../../../packages/db/src/market-catalog.js';
import type {FastifyInstance} from 'fastify';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
import {marketQuerySchema,marketIdSchema,marketFamilyCreateSchema,marketDraftCreateSchema,
 marketDraftReplaceSchema,marketPublishSchema,marketCopySchema,marketOperationHeaderSchema,marketVariantListSchema} from '../../../packages/contracts/src/market-variant-store.js';
import {adoptMarketFamily,createMarketDraft,replaceMarketDraft,readMarketVariant,readMarketRelease,
 publishMarketRelease,copyMarketDraft,marketOperation,readMarketOperation,listMarketVariants} from '../../../packages/db/src/market-variants.js';

/** Mounted through the fixed profile runtime; no legacy principal fallback. */
export async function marketVariantRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 app.addHook('onRequest',async(_req,reply)=>{reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization, X-Commerce-Profile-Id, X-Commerce-Profile-Version');});
 app.get('/v2/market/products/:id/options',async req=>{
  const {environment}=marketQuerySchema.parse(req.query),{id}=marketIdSchema.parse(req.params);
  return withProfileRequest(req,environment,{scope:'variants:read',mutation:false},async({db})=>({data:await readMarketCatalog(db,environment,id)}),deps);
 });
 app.post('/v2/market/families',async req=>{
  const {environment}=marketQuerySchema.parse(req.query),body=marketFamilyCreateSchema.parse(req.body);
  const op=marketOperationHeaderSchema.parse(req.headers['idempotency-key']);
  return withProfileRequest(req,environment,{scope:'products:write',mutation:true},async({db,profile})=>({data:await marketOperation(db,environment,profile.authority.membership.userId,op,{operation:'family',body},()=>adoptMarketFamily(db,environment,body))}),deps);
 });
 app.post('/v2/market/variants',async req=>{
  const {environment}=marketQuerySchema.parse(req.query),body=marketDraftCreateSchema.parse(req.body);
  const op=marketOperationHeaderSchema.parse(req.headers['idempotency-key']);
  return withProfileRequest(req,environment,{scope:'variants:write',mutation:true},async({db,profile})=>({data:await marketOperation(db,environment,profile.authority.membership.userId,op,{operation:'create',body},()=>createMarketDraft(db,environment,body,profile.authority.membership.userId))}),deps);
 });
 app.post('/v2/market/variants/copy',async req=>{
  const {environment}=marketQuerySchema.parse(req.query),body=marketCopySchema.parse(req.body);
  const op=marketOperationHeaderSchema.parse(req.headers['idempotency-key']);
  return withProfileRequest(req,environment,{scope:'variants:write',mutation:true},async({db,profile})=>({data:await marketOperation(db,environment,profile.authority.membership.userId,op,{operation:'copy',body},()=>copyMarketDraft(db,environment,body,profile.authority.membership.userId))}),deps);
 });
 app.get('/v2/market/variants/:id',async req=>{
  const {environment}=marketQuerySchema.parse(req.query),{id}=marketIdSchema.parse(req.params);
  return withProfileRequest(req,environment,{scope:'variants:read',mutation:false},async({db})=>({data:await readMarketVariant(db,environment,id)}),deps);
 });
 app.get('/v2/market/variants',async req=>{
  const q=marketVariantListSchema.parse(req.query);
  return withProfileRequest(req,q.environment,{scope:'variants:read',mutation:false},async({db})=>listMarketVariants(db,q),deps);
 });
 app.put('/v2/market/variants/:id/draft',async req=>{
  const {environment}=marketQuerySchema.parse(req.query),{id}=marketIdSchema.parse(req.params),body=marketDraftReplaceSchema.parse(req.body);
  const op=marketOperationHeaderSchema.parse(req.headers['idempotency-key']);
  return withProfileRequest(req,environment,{scope:'variants:write',mutation:true},async({db,profile})=>({data:await marketOperation(db,environment,profile.authority.membership.userId,op,{operation:'replace',id,body},()=>replaceMarketDraft(db,environment,id,body,profile.authority.membership.userId))}),deps);
 });
 app.post('/v2/market/variants/:id/releases',async req=>{
  const {environment}=marketQuerySchema.parse(req.query),{id}=marketIdSchema.parse(req.params),body=marketPublishSchema.parse(req.body);
  const op=marketOperationHeaderSchema.parse(req.headers['idempotency-key']);
  return withProfileRequest(req,environment,{scope:'variants:write',mutation:true},async({db,profile})=>({data:await marketOperation(db,environment,profile.authority.membership.userId,op,{operation:'publish',id,body},()=>publishMarketRelease(db,environment,id,body,profile.authority.membership.userId))}),deps);
 });
 app.get('/v2/market/releases/:id',async req=>{
  const {environment}=marketQuerySchema.parse(req.query),{id}=marketIdSchema.parse(req.params);
  return withProfileRequest(req,environment,{scope:'variants:read',mutation:false},async({db})=>({data:await readMarketRelease(db,environment,id)}),deps);
 });
 app.get('/v2/market/operations/:id',async req=>{
  const {environment}=marketQuerySchema.parse(req.query),{id}=marketIdSchema.parse(req.params);
  return withProfileRequest(req,environment,{scope:'variants:read',mutation:false},async({db,profile})=>({data:await readMarketOperation(db,environment,profile.authority.membership.userId,id)}),deps);
 });
}
