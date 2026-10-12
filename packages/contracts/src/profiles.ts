import {z} from 'zod';
export const profileRoles=['owner','operator','viewer'] as const;
export type ProfileRole=typeof profileRoles[number];
export const profileRoleLabels:Record<ProfileRole,string>={owner:'Dueño',operator:'Operador',viewer:'Solo lectura'};
export const profileScopes=[
  'profiles:read','profiles:switch','home:read','employees:read','employees:write','tokens:read','tokens:write',
  'products:read','products:write','variants:read','variants:write','offers:read','offers:write',
  'materials:read','materials:write','flows:read','flows:write','sellers:read','sellers:write',
  'collections:read','collections:write','receipt-rules:read','receipt-rules:write',
  'numbers:read','numbers:write','numbers:connect','assignments:read','assignments:write','warmup:read','warmup:write',
  'conversations:read','conversations:write','orders:read','orders:write','receipts:read','receipts:review',
  'payments:read','payments:write','payments:export','remarketing:read','remarketing:write',
  'campaigns:read','results:read','goals:read','goals:write','tests:read','tests:run',
  'operations:read','alerts:read','alerts:write','help:read','audit:read','audit:export',
  'privacy:read','privacy:write','profile:read','profile:write','usage:read','account:read','account:write',
  'integrations:read','integrations:write',
] as const;
export type ProfileScope=typeof profileScopes[number];
export const profileScopeSchema=z.enum(profileScopes);
export const profileRoleSchema=z.enum(profileRoles);
export const personalProfileScopeSchema=profileScopeSchema.refine(scope=>scope!=='profiles:switch',{message:'Un token de perfil no cambia la sesión interactiva.'});
export const profileLimitsSchema=z.object({numbers:z.number().int().min(0).max(20),products:z.number().int().min(0),conversations_per_day:z.number().int().min(0)}).strict();
export const profileStateSchema=z.enum(['ACTIVE','SUSPENDED']);
export type ProfileState=z.infer<typeof profileStateSchema>;
export const profileIdSchema=z.string().min(1).max(256).refine(value=>!value.includes('\0'));
const selectionVersion=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const selectProfileSchema=z.object({workspaceId:profileIdSchema,expectedVersion:selectionVersion}).strict();
export const profileSelectionSchema=z.object({workspaceId:profileIdSchema.nullable(),version:selectionVersion}).strict();
export const profileChoiceSchema=z.object({id:profileIdSchema,businessName:z.string().min(1).max(160),state:profileStateSchema,
 timezone:z.string().min(1).max(128),role:profileRoleSchema,membershipVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),selected:z.boolean()}).strict();
export const profileBootstrapSchema=z.object({profiles:z.array(profileChoiceSchema),selection:profileSelectionSchema}).strict().superRefine((value,ctx)=>{
 const selected=value.profiles.filter(profile=>profile.selected);
 if(new Set(value.profiles.map(profile=>profile.id)).size!==value.profiles.length||
  (value.selection.workspaceId===null?selected.length!==0:selected.length!==1||selected[0]?.id!==value.selection.workspaceId||value.selection.version===0))
  ctx.addIssue({code:'custom',message:'La selección debe coincidir con un único perfil autorizado.'});
});
export type ProfileBootstrap=z.infer<typeof profileBootstrapSchema>;
export const profileSettingsInputSchema=z.object({expectedVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 businessName:z.string().trim().min(1).max(160),timezone:z.string().min(1).max(128).refine(value=>{
  if(value!=='UTC'&&!/^[A-Za-z_]+\/[A-Za-z0-9_+/-]+$/.test(value))return false;
  try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}
 })}).strict();
export const profileSavedSettingsSchema=z.object({id:profileIdSchema,business_name:z.string().min(1).max(160),timezone:z.string().min(1).max(128),version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
export const profileOverviewSchema=profileSavedSettingsSchema.extend({state:profileStateSchema,number_limit:z.number().int().min(0).max(20),product_limit:z.number().int().min(0),daily_conversation_limit:z.number().int().min(0)}).strict();
export const profileSettingsResultSchema=profileSavedSettingsSchema.extend({changed:z.boolean()}).strict();
export type ProfileOverview=z.infer<typeof profileOverviewSchema>;
export type ProfileSettingsResult=z.infer<typeof profileSettingsResultSchema>;


const ownerOnly=new Set<ProfileScope>(['employees:read','employees:write','tokens:read','tokens:write','integrations:write','profile:write','privacy:write','payments:export','audit:export']);
const viewerExcluded=new Set<ProfileScope>(['employees:read','tokens:read','integrations:read','privacy:read']);
export const profileRoleScopes:Readonly<Record<ProfileRole,readonly ProfileScope[]>>=Object.freeze({
  owner:Object.freeze([...profileScopes]),
  operator:Object.freeze(profileScopes.filter(s=>!ownerOnly.has(s))),
  viewer:Object.freeze(profileScopes.filter(s=>(s.endsWith(':read')||s==='profiles:switch'||s==='account:write')&&!viewerExcluded.has(s))),
});

export const profileMembershipSchema=z.object({user_id:profileIdSchema,role:profileRoleSchema,active:z.boolean(),version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
export const profileEmployeeInputSchema=z.object({expectedVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),role:profileRoleSchema,active:z.boolean()}).strict();
export const profileEmployeeResultSchema=profileMembershipSchema.extend({changed:z.boolean()}).strict();
export type ProfileMembership=z.infer<typeof profileMembershipSchema>;
export type ProfileEmployeeResult=z.infer<typeof profileEmployeeResultSchema>;
export const profileEmployeeSchema=profileMembershipSchema.extend({name:z.string(),email:z.string()}).strict();
export type ProfileEmployee=z.infer<typeof profileEmployeeSchema>;

/** Browser identity is returned separately from session credentials and profile authority. */
export const profileBrowserIdentitySchema=z.object({id:profileIdSchema,name:z.string().max(160),email:z.string().email().max(254)}).strict();
export const profileBrowserBootstrapSchema=z.object({user:profileBrowserIdentitySchema,profile:profileBootstrapSchema}).strict();
export type ProfileBrowserBootstrap=z.infer<typeof profileBrowserBootstrapSchema>;
