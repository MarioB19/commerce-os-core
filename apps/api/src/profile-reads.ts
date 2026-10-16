import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {appendEvent} from '../../../packages/db/src/index.js';
import {acknowledgeProfileAlert,auditCsv,listProfileAlerts,listProfileAudit,ProfileReadError,readProfileHome,readProfileOperation,readProfileUsage} from '../../../packages/db/src/profile-reads.js';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
import {exportProfileData} from '../../../packages/db/src/profile-export.js';

/** V7 F2 read families: /v2/home (RF-04), /v2/usage (RF-01.8), /v2/audit
 * (RNF-04.b) and /v2/operations/:id (RF-15). Same authority for UI, API and MCP. */
function fail(code:string,statusCode=400):never{throw Object.assign(new Error(code),{code,statusCode});}
function headers(reply:FastifyReply){reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization').header('Referrer-Policy','no-referrer');}
function noQuery(req:FastifyRequest){if(Object.keys(req.query??{}).length)fail('PROFILE_QUERY_NOT_ALLOWED');}
async function mapped<T>(work:()=>Promise<T>){try{return await work();}catch(error){if(error instanceof ProfileReadError)fail(error.code,error.statusCode);throw error;}}
const auditQuery=z.object({before:z.iso.datetime({offset:true}).optional(),limit:z.coerce.number().int().min(1).max(200).optional()}).strict();
export async function profileReadRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 app.get('/v2/home',async(req,reply)=>{headers(reply);noQuery(req);
  return{data:await mapped(()=>withProfileRequest(req,'REAL',{scope:'home:read',mutation:false},({db,profile})=>readProfileHome(db,profile.authority),deps))};});
 app.get('/v2/usage',async(req,reply)=>{headers(reply);noQuery(req);
  return{data:await mapped(()=>withProfileRequest(req,'REAL',{scope:'usage:read',mutation:false},({db,profile})=>readProfileUsage(db,profile.authority),deps))};});
 app.get('/v2/audit',async(req,reply)=>{headers(reply);
  const q=auditQuery.safeParse(req.query??{});if(!q.success)fail('AUDIT_QUERY_INVALID');
  return{data:await mapped(()=>withProfileRequest(req,'REAL',{scope:'audit:read',mutation:false},({db,profile})=>listProfileAudit(db,profile.authority,q.data),deps))};});
 app.get('/v2/audit/export',async(req,reply)=>{headers(reply);
  const format=z.object({format:z.enum(['csv','json']).default('csv')}).strict().safeParse(req.query??{});if(!format.success)fail('AUDIT_QUERY_INVALID');
  const exported=await mapped(()=>withProfileRequest(req,'REAL',{scope:'audit:export',mutation:false},async({db,profile})=>{
   const page=await listProfileAudit(db,profile.authority,{export:true,limit:5000});
   await appendEvent(db,{workspace_id:db.workspaceId,environment:'REAL',event_type:'profile.audit.exported',aggregate_id:db.workspaceId,correlation_id:req.id,
    actor:{type:profile.authority.credential.kind==='session'?'human':'personal_api',id:profile.authority.membership.userId},payload:{status:'EXPORTED',version:page.entries.length}});
   return page.entries;
  },deps));
  if(format.data.format==='json')return{data:{entries:exported}};
  const csv=auditCsv(exported);
  return reply.header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="auditoria.csv"').send('﻿'+csv);
 });
 // RF-01.5: the owner's readable export of the profile (gzip'd NDJSON); only a
 // receipt stays (hash, rows, bytes), which a deletion request must cite.
 app.get('/v2/profile/export',async(req,reply)=>{headers(reply);noQuery(req);
  const exported=await mapped(()=>withProfileRequest(req,'REAL',{scope:'audit:export',mutation:false},async({db,profile})=>{
   const result=await exportProfileData(db,profile.authority);
   await appendEvent(db,{workspace_id:db.workspaceId,environment:'REAL',event_type:'profile.data.exported',aggregate_id:result.id,correlation_id:req.id,
    actor:{type:profile.authority.credential.kind==='session'?'human':'personal_api',id:profile.authority.membership.userId},payload:{status:'EXPORTED',rows:result.rows,bytes:result.bytes,sha256:result.sha256}});
   return{...result,workspaceId:db.workspaceId};
  },deps));
  return reply.header('Content-Type','application/gzip').header('Content-Disposition',`attachment; filename="perfil-${exported.workspaceId}.ndjson.gz"`)
   .header('X-Commerce-Export-Id',exported.id).header('X-Commerce-Export-SHA256',exported.sha256).header('X-Content-Type-Options','nosniff').send(exported.gzip);
 });
 app.get('/v2/alerts',async(req,reply)=>{headers(reply);
  const q=z.object({include:z.enum(['open','all']).default('open')}).strict().safeParse(req.query??{});if(!q.success)fail('ALERTS_QUERY_INVALID');
  return{data:await mapped(()=>withProfileRequest(req,'REAL',{scope:'alerts:read',mutation:false},({db,profile})=>listProfileAlerts(db,profile.authority,{includeResolved:q.data.include==='all'}),deps))};});
 app.post('/v2/alerts/:id/acknowledge',{bodyLimit:256},async(req,reply)=>{headers(reply);noQuery(req);
  const id=String((req.params as {id?:unknown}).id??'');
  return{data:await mapped(()=>withProfileRequest(req,'REAL',{scope:'alerts:write',mutation:true},async({db,profile})=>{
   const result=await acknowledgeProfileAlert(db,profile.authority,id);
   await appendEvent(db,{workspace_id:db.workspaceId,environment:'REAL',event_type:'profile.alert.acknowledged',aggregate_id:result.id,correlation_id:req.id,
    actor:{type:profile.authority.credential.kind==='session'?'human':'personal_api',id:profile.authority.membership.userId},payload:{status:'ACKNOWLEDGED'}});
   return result;
  },deps))};});
 app.get('/v2/operations/:id',async(req,reply)=>{headers(reply);noQuery(req);
  const id=String((req.params as {id?:unknown}).id??'');
  return{data:await mapped(()=>withProfileRequest(req,'REAL',{scope:'operations:read',mutation:false},({db,profile})=>readProfileOperation(db,profile.authority,id),deps))};});
}
