import {z} from 'zod';
import type {QueryExecutor} from './index.js';
import {profileIdSchema,profileRoleSchema,profileStateSchema} from '../../contracts/src/profiles.js';
import {ProfileSessionError,type InteractiveSession,type ProfileFence} from './profile-session.js';

const rowSchema=z.object({id:profileIdSchema,business_name:z.string().min(1).max(160),state:profileStateSchema,
 timezone:z.string().min(1).max(128),role:profileRoleSchema,membership_version:z.number().int().positive(),
 selected:z.boolean(),selection_version:z.number().int().positive().nullable()}).strict()
 .refine(row=>!row.selected||row.selection_version!==null);
export type AuthenticatedProfileChoice=z.infer<typeof rowSchema>;
const known=new Map<string,number>([['PROFILE_SESSION_EXPIRED',401],['PROFILE_MEMBERSHIP_REQUIRED',403],['PROFILE_ROLE_ADOPTION_REQUIRED',403],['PROFILE_UNAVAILABLE',403],['PROFILE_SELECTION_CHANGED',409],['PROFILE_SELECTION_INVALID',400],['PROFILE_BOOTSTRAP_BOUND',503],['PROFILE_BOOTSTRAP_OUTSIDE_SCOPE_REQUIRED',409]]);
function identity(session:InteractiveSession){
 if(!profileIdSchema.safeParse(session?.id).success||!profileIdSchema.safeParse(session?.userId).success)throw new ProfileSessionError('PROFILE_SESSION_EXPIRED',401);
}
async function native<T>(work:()=>Promise<T>):Promise<T>{
 try{return await work();}catch(error){
  if(error&&typeof error==='object'&&'code'in error&&error.code==='P0001'&&'message'in error&&typeof error.message==='string'&&known.has(error.message))throw new ProfileSessionError(error.message,known.get(error.message));
  throw error;
 }
}
/** Only the already authenticated Better Auth session enters this bootstrap.
 * There is no SQL-table fallback when the cutover function is unavailable. */
export async function listProfileChoicesFromSession(db:QueryExecutor,session:InteractiveSession):Promise<AuthenticatedProfileChoice[]>{
 identity(session);
 const rows=(await native(()=>db.query('SELECT * FROM public.list_authenticated_profile_choices($1,$2)',[session.id,session.userId]))).rows;
 const parsed=z.array(rowSchema).max(3).safeParse(rows);
 if(!parsed.success||new Set(parsed.data.map(x=>x.id)).size!==parsed.data.length||parsed.data.filter(x=>x.selected).length>1||new Set(parsed.data.map(x=>x.selection_version)).size>1)throw new ProfileSessionError('PROFILE_BOOTSTRAP_INVALID',503);
 return parsed.data;
}
/** Call inside the API's ordinary identity transaction so its audit and CAS
 * commit together; this must never be joined to a commercial profile scope. */
export async function selectProfileFromSession(db:QueryExecutor,session:InteractiveSession,workspaceId:string,expectedVersion:number):Promise<ProfileFence>{
 identity(session);
 if(!profileIdSchema.safeParse(workspaceId).success||!Number.isSafeInteger(expectedVersion)||expectedVersion<0||expectedVersion>=2147483647)throw new ProfileSessionError('PROFILE_SELECTION_INVALID',400);
 const rows=(await native(()=>db.query('SELECT * FROM public.select_authenticated_profile($1,$2,$3,$4)',[session.id,session.userId,workspaceId,expectedVersion]))).rows;
 const value=z.array(z.object({workspace_id:z.literal(workspaceId),version:z.literal(expectedVersion+1)}).strict()).length(1).safeParse(rows);
 if(!value.success)throw new ProfileSessionError('PROFILE_SELECTION_CHANGED');
 return{workspaceId,version:expectedVersion+1};
}
