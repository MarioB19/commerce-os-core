import type {FastifyInstance} from 'fastify';
import {profileReadEnvironment,withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
import {profileEmployeeSchema as employee,profileOverviewSchema as summary} from '../../../packages/contracts/src/profiles.js';
import {z} from 'zod';

/** Installed only as part of the complete profile cutover, with the selector. */
export async function profileOverviewRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 app.get('/v2/profile',async(req,reply)=>{
  reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization').header('Referrer-Policy','no-referrer');
  return withProfileRequest(req,profileReadEnvironment(req),{scope:'profile:read',mutation:false},async({db})=>{
   const row=(await db.query('SELECT id,business_name,state,timezone,number_limit,product_limit,daily_conversation_limit,version FROM profiles WHERE id=$1',[db.workspaceId])).rows[0];
   const parsed=summary.safeParse(row);if(!parsed.success)throw Object.assign(new Error('PROFILE_UNAVAILABLE'),{code:'PROFILE_UNAVAILABLE',statusCode:503});
   return{data:parsed.data};
  },deps);
 });
 app.get('/v2/employees',async(req,reply)=>{
  reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization').header('Referrer-Policy','no-referrer');
  return withProfileRequest(req,profileReadEnvironment(req),{scope:'employees:read',mutation:false},async({db})=>{
   const rows=(await db.query('SELECT m.user_id,u.name,u.email,m.role,m.active,m.version FROM memberships m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.name,u.id',[db.workspaceId])).rows;
   const parsed=z.array(employee).safeParse(rows);if(!parsed.success)throw Object.assign(new Error('PROFILE_EMPLOYEE_ADOPTION_REQUIRED'),{code:'PROFILE_EMPLOYEE_ADOPTION_REQUIRED',statusCode:503});
   return{data:parsed.data};
  },deps);
 });
}
