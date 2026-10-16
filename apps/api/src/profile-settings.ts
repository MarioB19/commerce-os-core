import type {FastifyInstance} from 'fastify';
import {profileSettingsInputSchema as inputSchema,profileSavedSettingsSchema as savedSchema} from '../../../packages/contracts/src/profiles.js';
import {appendEvent} from '../../../packages/db/src/index.js';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';

function fail(code:string,statusCode=409):never{throw Object.assign(new Error(code),{code,statusCode});}

/** Prepared separately from the active application until all profile consumers
 * and the final database cutover are admitted together. */
export async function profileSettingsRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 app.patch('/v2/profile',{bodyLimit:4096},async(req,reply)=>{
  reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization').header('Referrer-Policy','no-referrer');
  if(Object.keys(req.query??{}).length)fail('PROFILE_QUERY_NOT_ALLOWED',400);
  const parsed=inputSchema.safeParse(req.body);if(!parsed.success)fail('PROFILE_SETTINGS_INVALID',400);
  const input=parsed.data;
  return withProfileRequest(req,'REAL',{scope:'profile:write',mutation:true},async({db,profile})=>{
   const current=(await db.query('SELECT id,business_name,timezone,version FROM profiles WHERE id=$1 FOR UPDATE',[db.workspaceId])).rows[0];
   const before=savedSchema.safeParse(current);if(!before.success)fail('PROFILE_UNAVAILABLE',503);
   if(before.data.version!==input.expectedVersion)fail('PROFILE_VERSION_CONFLICT');
   if(before.data.business_name===input.businessName&&before.data.timezone===input.timezone)return{data:{...before.data,changed:false}};
   const row=(await db.query('UPDATE profiles SET business_name=$2,timezone=$3 WHERE id=$1 AND version=$4 RETURNING id,business_name,timezone,version',[db.workspaceId,input.businessName,input.timezone,input.expectedVersion])).rows[0];
   const after=savedSchema.safeParse(row);if(!after.success||after.data.id!==db.workspaceId||after.data.version!==input.expectedVersion+1)fail('PROFILE_SETTINGS_WRITE_UNCONFIRMED');
   const actor={type:profile.authority.credential.kind==='session'?'human':'personal_api',id:profile.authority.membership.userId,
    ...('tokenId' in profile?{credential_id:profile.tokenId}:{})};
   await appendEvent(db,{workspace_id:db.workspaceId,environment:'REAL',event_type:'profile.settings.changed',aggregate_id:db.workspaceId,correlation_id:req.id,actor,payload:{previous_version:input.expectedVersion,version:after.data.version,fields:(['business_name','timezone'] as const).filter(field=>before.data[field]!==after.data[field])}});
   return{data:{...after.data,changed:true}};
  },deps);
 });
}
