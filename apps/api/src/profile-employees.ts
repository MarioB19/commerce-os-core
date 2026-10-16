import type {FastifyInstance} from 'fastify';
import {profileEmployeeInputSchema as inputSchema,profileMembershipSchema as rowSchema,profileIdSchema} from '../../../packages/contracts/src/profiles.js';
import {appendEvent} from '../../../packages/db/src/index.js';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';

function fail(code:string,statusCode=409):never{throw Object.assign(new Error(code),{code,statusCode});}
/** Staged until the complete profile cutover; does not create or send invitations. */
export async function profileEmployeeRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 app.patch('/v2/employees/:userId',{bodyLimit:2048},async(req,reply)=>{
  reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization').header('Referrer-Policy','no-referrer');
  if(Object.keys(req.query??{}).length)fail('PROFILE_QUERY_NOT_ALLOWED',400);
  const body=inputSchema.safeParse(req.body),target=profileIdSchema.safeParse((req.params as {userId:unknown}).userId);
  if(!body.success||!target.success)fail('PROFILE_EMPLOYEE_INPUT_INVALID',400);
  const input=body.data,userId=target.data;
  return withProfileRequest(req,'REAL',{scope:'employees:write',mutation:true},async({db,profile})=>{
   if(userId===profile.authority.membership.userId)fail('PROFILE_CANNOT_CHANGE_OWN_ACCESS');
   const native=(await db.query('SELECT user_id,role,active,version FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[db.workspaceId,userId])).rows[0];
   if(!native)fail('PROFILE_EMPLOYEE_NOT_FOUND',404);
   const parsed=rowSchema.safeParse(native);if(!parsed.success)fail('PROFILE_EMPLOYEE_ADOPTION_REQUIRED',503);
   const before=parsed.data;if(before.version!==input.expectedVersion)fail('PROFILE_EMPLOYEE_VERSION_CONFLICT');
   if(before.role===input.role&&before.active===input.active)return{data:{...before,changed:false}};
   if(before.role==='owner'&&before.active&&(input.role!=='owner'||!input.active)){
    const other=(await db.query("SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id<>$2 AND role='owner' AND active=true LIMIT 1",[db.workspaceId,userId])).rowCount;
    if(!other)fail('PROFILE_LAST_OWNER_REQUIRED');
   }
   const row=(await db.query('UPDATE memberships SET role=$3,active=$4 WHERE workspace_id=$1 AND user_id=$2 AND version=$5 RETURNING user_id,role,active,version',[db.workspaceId,userId,input.role,input.active,input.expectedVersion])).rows[0];
   const after=rowSchema.safeParse(row);
   if(!after.success||after.data.user_id!==userId||after.data.role!==input.role||after.data.active!==input.active||after.data.version!==before.version+1)fail('PROFILE_EMPLOYEE_WRITE_UNCONFIRMED');
   const actor={type:profile.authority.credential.kind==='session'?'human':'personal_api',id:profile.authority.membership.userId,...('tokenId' in profile?{credential_id:profile.tokenId}:{})};
   await appendEvent(db,{workspace_id:db.workspaceId,environment:'REAL',event_type:'profile.employee.access.changed',aggregate_id:userId,correlation_id:req.id,actor,payload:{before:{role:before.role,active:before.active,version:before.version},after:{role:after.data.role,active:after.data.active,version:after.data.version}}});
   return{data:{...after.data,changed:true}};
  },deps);
 });
}
