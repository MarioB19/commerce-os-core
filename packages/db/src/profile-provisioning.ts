import type {QueryExecutor} from './index.js';
import {profileIdSchema} from '../../contracts/src/profiles.js';

/** Default allocation for a profile provisioned after the cutover (local
 * bootstrap, isolated fixtures). The platform keeps D-14: at most 3 profiles,
 * 20 connected numbers and 300 conversations per day in total. A new profile
 * receives the numbers still unallocated (the first profile of an empty
 * installation, «Operación Brandon» per D-08, receives all 20); the platform
 * owner rebalances explicitly before admitting another profile's numbers. */
export const defaultProfileProductLimit=200;
export const defaultProfileDailyConversations=300;

/** Owner-only maintenance path (migration owner / bootstrap credentials). It
 * never moves data between profiles and is a no-op for an existing profile.
 * Must run inside a transaction: the quota baseline is sealed atomically. */
export async function ensureProfile(db:QueryExecutor,workspaceId:string,options:{businessName?:string}={}):Promise<{created:boolean}>{
 if(!profileIdSchema.safeParse(workspaceId).success)throw Object.assign(new Error('PROFILE_ID_INVALID'),{statusCode:400});
 if((await db.query('SELECT 1 FROM profiles WHERE id=$1',[workspaceId])).rows.length)return{created:false};
 const totals=(await db.query('SELECT count(*)::int AS profiles,COALESCE(sum(number_limit),0)::int AS numbers FROM profiles')).rows[0] as {profiles:number;numbers:number};
 const name=options.businessName??(totals.profiles===0?'Operación Brandon':`Perfil ${totals.profiles+1}`);
 await db.query(`INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit)
  VALUES($1,$2,'America/Mexico_City',$3,$4,$5)`,[workspaceId,name,Math.max(0,20-totals.numbers),defaultProfileProductLimit,defaultProfileDailyConversations]);
 const previous=(await db.query("SELECT current_setting('app.workspace_id',true) AS workspace")).rows[0]?.workspace??'';
 await db.query("SELECT pg_catalog.set_config('app.workspace_id',$1,true)",[workspaceId]);
 await db.query('SELECT public.adopt_profile_quota_inventory($1,public.profile_quota_inventory($1))',[workspaceId]);
 await db.query("SELECT pg_catalog.set_config('app.workspace_id',$1,true)",[previous]);
 return{created:true};
}
