import type {FastifyInstance} from 'fastify';
import {profileCatalogResources,profileCatalogIdSchema,profileCatalogListSchema,
 profileCatalogDetailQuerySchema,profileCatalogVersionsQuerySchema} from '../../../packages/contracts/src/profile-catalog.js';
import {listProfileCatalog,readProfileCatalog,listProfileCatalogVersions} from '../../../packages/db/src/profile-catalog.js';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
import {present} from './record-presentation.js';

/** Explicit profile consumer; never falls back to legacy principal/pool. */
export async function profileCatalogRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 for(const[path,{kind,scope}]of Object.entries(profileCatalogResources)){
  app.get('/v2/catalog/'+path,async(req,reply)=>{
   reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization, X-Commerce-Profile-Id, X-Commerce-Profile-Version');
   const query=profileCatalogListSchema.parse(req.query??{});
   return withProfileRequest(req,query.environment,{scope,mutation:false},async({db})=>{
    const result=await listProfileCatalog(db,kind,query);
    return{data:result.records.map(present),meta:{hasMore:result.hasMore,limit:query.limit,offset:query.offset}};
   },deps);
  });
  app.get('/v2/catalog/'+path+'/:id',async(req,reply)=>{
   reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization, X-Commerce-Profile-Id, X-Commerce-Profile-Version');
   const query=profileCatalogDetailQuerySchema.parse(req.query??{}),{id}=profileCatalogIdSchema.parse(req.params);
   return withProfileRequest(req,query.environment,{scope,mutation:false},async({db})=>({data:present(await readProfileCatalog(db,kind,id,query.environment))}),deps);
  });
  app.get('/v2/catalog/'+path+'/:id/versions',async(req,reply)=>{
   reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization, X-Commerce-Profile-Id, X-Commerce-Profile-Version');
   const query=profileCatalogVersionsQuerySchema.parse(req.query??{}),{id}=profileCatalogIdSchema.parse(req.params);
   return withProfileRequest(req,query.environment,{scope,mutation:false},async({db})=>{
    const result=await listProfileCatalogVersions(db,kind,id,query);
    return{data:result.records.map(present),meta:{hasMore:result.hasMore,limit:query.limit}};
   },deps);
  });
 }
}
