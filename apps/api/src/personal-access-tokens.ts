import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {pool} from '../../../packages/db/src/index.js';
import {insertPersonalToken} from '../../../packages/db/src/personal-access-tokens.js';
import {principal,parseBody,envOf,mutate,audit,fail} from './context.js';

const grant=z.object({name:z.string().trim().min(1).max(100),allowed_environments:z.array(z.enum(['REAL','SIMULATION'])).min(1).max(2),expires_at:z.string().datetime({offset:true}),reason:z.string().trim().min(8).max(1000)});
const revision={expected_version:z.number().int().positive(),reason:z.string().trim().min(8).max(1000)};
const metadata='id,user_id,name,allowed_environments,expires_at,revoked_at,version,created_at';
function owner(req:FastifyRequest){const p=principal(req);if(p.service||p.role!=='owner')throw fail(403,'FORBIDDEN');return p;}
function validGrant(req:FastifyRequest,input:z.infer<typeof grant>,renewal=false) {
 const p=owner(req),expiry=Date.parse(input.expires_at);
 if(expiry<=Date.now()||expiry>Date.now()+90*86400000)throw fail(400,'INVALID_EXPIRY');
 if(new Set(input.allowed_environments).size!==input.allowed_environments.length||!input.allowed_environments.includes(envOf(req)))throw fail(400,'INVALID_TOKEN_ENVIRONMENTS');
 if(p.authentication_method==='personal_access_token'&&(!renewal&&expiry>Date.parse(p.token_expires_at!)||input.allowed_environments.some(e=>!p.allowed_environments?.includes(e))))throw fail(403,'TOKEN_GRANT_EXCEEDS_ISSUER');
}

export async function personalAccessTokenRoutes(app:FastifyInstance) {
 app.get('/v1/personal-access-tokens',async req=>{const p=owner(req);return{data:(await pool.query(`SELECT ${metadata} FROM personal_access_tokens WHERE workspace_id=$1 ORDER BY created_at DESC`,[p.workspace_id])).rows};});
 app.post('/v1/personal-access-tokens',async(req,reply)=>{
  const p=owner(req),input=grant.extend({confirmation:z.literal('CREATE_OWNER_API_TOKEN')}).strict().parse(parseBody(req));validGrant(req,input);
  const result=await mutate(req,'personal-token.create',async c=>{
   const membership=(await c.query("SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND active=true AND role='owner' FOR SHARE",[p.workspace_id,p.user.id])).rows[0];if(!membership)throw fail(403,'NO_OWNER_MEMBERSHIP');
   const data=await insertPersonalToken(c,{...input,workspace_id:p.workspace_id,user_id:p.user.id});
   await audit(c,req,'personal_access_token.created',data.id,{reason:input.reason,allowed_environments:input.allowed_environments,expires_at:input.expires_at,role:'owner',commercial_activation_authorized:false});
   return{data,status:201,private:true};
  });reply.code(result.status??201).header('Cache-Control','no-store');return{data:result.data};
 });
 app.delete<{Params:{id:string}}>('/v1/personal-access-tokens/:id',async req=>{
  const p=owner(req),input=z.object({...revision,confirmation:z.literal('REVOKE_OWNER_API_TOKEN')}).strict().parse(parseBody(req));
  const result=await mutate(req,'personal-token.revoke:'+req.params.id,async c=>{
   const old=(await c.query('SELECT * FROM personal_access_tokens WHERE id::text=$1 AND workspace_id=$2 FOR UPDATE',[req.params.id,p.workspace_id])).rows[0];if(!old)throw fail(404,'NOT_FOUND');if(old.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
   await c.query('UPDATE personal_access_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1',[old.id]);
   await audit(c,req,'personal_access_token.revoked',old.id,{reason:input.reason});return{data:{revoked:true,version:old.version+1}};
  });return{data:result.data};
 });
 app.post<{Params:{id:string}}>('/v1/personal-access-tokens/:id/rotate',async(req,reply)=>{
  const p=owner(req),input=grant.extend({expected_version:revision.expected_version,confirmation:z.literal('ROTATE_OWNER_API_TOKEN')}).strict().parse(parseBody(req));validGrant(req,input,true);
  const result=await mutate(req,'personal-token.rotate:'+req.params.id,async c=>{
   const old=(await c.query('SELECT * FROM personal_access_tokens WHERE id::text=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE',[req.params.id,p.workspace_id,p.user.id])).rows[0];if(!old)throw fail(404,'NOT_FOUND');if(old.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');if(old.revoked_at||Date.parse(old.expires_at)<=Date.now())throw fail(409,'TOKEN_NOT_ACTIVE');
   const data=await insertPersonalToken(c,{...input,workspace_id:p.workspace_id,user_id:p.user.id});
   await c.query('UPDATE personal_access_tokens SET revoked_at=now() WHERE id=$1',[old.id]);
   await audit(c,req,'personal_access_token.rotated',old.id,{replacement_id:data.id,reason:input.reason,allowed_environments:input.allowed_environments,expires_at:input.expires_at,commercial_activation_authorized:false});
   return{data,status:201,private:true};
  });reply.code(result.status??201).header('Cache-Control','no-store');return{data:result.data};
 });
}

export function documentPersonalAccessTokens(spec:any) {
 spec.components??={};spec.components.securitySchemes??={};spec.components.securitySchemes.ownerPersonalToken={type:'http',scheme:'bearer',description:'Token personal cos_pat_ de un owner vigente; authentication_method=personal_access_token. No es un token de servicio. Mantiene las autorizaciones operativas independientes.'};
 for(const [path,methods] of Object.entries(spec.paths??{}) as [string,any][]){if(!path.startsWith('/v1/'))continue;for(const [method,op] of Object.entries(methods) as [string,any][]){if(!['get','post','put','patch','delete'].includes(method))continue;op.security??=[{session:[]}];op.security.push({ownerPersonalToken:[]});op['x-owner-personal-token']=true;}}
 const body=(schema:z.ZodType)=>({required:true,content:{'application/json':{schema:z.toJSONSchema(schema,{target:'openapi-3.0'})}}});
 const environment={environment:z.enum(['REAL','SIMULATION'])};
 spec.paths['/v1/personal-access-tokens'].post.requestBody=body(grant.extend({...environment,confirmation:z.literal('CREATE_OWNER_API_TOKEN')}).strict());
 spec.paths['/v1/personal-access-tokens/{id}'].delete.requestBody=body(z.object({...environment,...revision,confirmation:z.literal('REVOKE_OWNER_API_TOKEN')}).strict());
 spec.paths['/v1/personal-access-tokens/{id}/rotate'].post.requestBody=body(grant.extend({...environment,expected_version:revision.expected_version,confirmation:z.literal('ROTATE_OWNER_API_TOKEN')}).strict());
 for(const path of ['/v1/personal-access-tokens','/v1/personal-access-tokens/{id}','/v1/personal-access-tokens/{id}/rotate'])for(const [method,op] of Object.entries(spec.paths[path]) as [string,any][]){op.tags=['Personal API access'];op['x-required-service-scopes']=['human-owner-only'];op.description='Administración del owner vigente. Secreto sólo en alta/rotación y replay cifrado; nunca al listar. La credencial delega permisos, no autoriza operación comercial.';if(['post','delete'].includes(method)){op.parameters??=[];op.parameters.push({name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:8,maxLength:160}});}}
}
