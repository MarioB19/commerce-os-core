import {z} from 'zod';
import {profileRequest,type ProfileFence} from './profile-request.js';

export const aiProviderLabels={openai:'OpenAI',anthropic:'Anthropic',google:'Google Gemini'} as const;
export type AiProvider=keyof typeof aiProviderLabels;
const provider=z.enum(['openai','anthropic','google']);
const iso=z.string().datetime({offset:true}).nullable();
const aiProviderStatus=z.object({provider,state:z.enum(['MISSING','UNVERIFIED','VERIFYING','VERIFIED','FAILED','DISABLED']),revision:z.number().int().min(0),enabled:z.boolean(),hint:z.string().max(16).nullable(),failure:z.string().max(64).nullable(),updatedAt:iso}).strict();
export const integrationsSchema=z.object({
 ai:z.object({environment:z.enum(['REAL','SIMULATION']),providers:z.array(aiProviderStatus).length(3),
  preferences:z.object({version:z.number().int().min(0),defaultProvider:provider.nullable(),defaultModel:z.string().max(128).nullable(),monthlyLimitMicrousd:z.number().int().nullable()}).strict(),
  budget:z.object({startsAt:z.string(),endsAt:z.string(),limitMicrousd:z.number().int(),usedMicrousd:z.number().int()}).strict().nullable(),
  models:z.array(z.object({provider,model:z.string().max(128),capabilities:z.array(z.string().max(16)).max(3)}).strict()).max(100)}).strict(),
 meta:z.object({state:z.enum(['MISSING','UNVERIFIED','VERIFIED','INVALID','DISABLED']),revision:z.number().int().min(0),enabled:z.boolean(),hint:z.string().max(16).nullable(),reason:z.string().max(64).nullable(),checkedAt:iso,grantedScopes:z.array(z.string().max(64)).max(40),updatedAt:iso}).strict(),
}).strict();
export type Integrations=z.infer<typeof integrationsSchema>;
export type AiProviderStatus=z.infer<typeof aiProviderStatus>;
export const onboardingSchema=z.object({version:z.number().int().min(0),dismissed:z.boolean(),complete:z.boolean(),next:z.enum(['ai','meta','product','number']).nullable(),
 steps:z.object({ai:z.enum(['DONE','SKIPPED','PENDING']),meta:z.enum(['DONE','SKIPPED','PENDING']),product:z.enum(['DONE','SKIPPED','PENDING']),number:z.enum(['DONE','SKIPPED','PENDING'])}).strict()}).strict();
export type Onboarding=z.infer<typeof onboardingSchema>;
export const loadIntegrations=async(fence:ProfileFence,signal?:AbortSignal)=>integrationsSchema.parse(await profileRequest(fence,'GET','/v2/integrations',undefined,signal));
export async function saveAiKey(fence:ProfileFence,name:AiProvider,expectedRevision:number,key:string){
 const data=await profileRequest<{verification:{state:string;code?:string};integrations:unknown}>(fence,'PUT',`/v2/integrations/ai/${name}/key`,{operationId:crypto.randomUUID(),expectedRevision,key});
 return{verification:data.verification,integrations:integrationsSchema.parse(data.integrations)};
}
export const setAiKeyEnabled=(fence:ProfileFence,name:AiProvider,expectedRevision:number,enabled:boolean)=>profileRequest(fence,'POST',`/v2/integrations/ai/${name}/state`,{expectedRevision,enabled});
export const saveAiPreferences=(fence:ProfileFence,input:{expectedVersion:number;defaultProvider?:AiProvider|null;defaultModel?:string|null;monthlyLimitMicrousd?:number|null})=>profileRequest(fence,'PUT','/v2/integrations/ai/preferences',input);
export async function saveMetaToken(fence:ProfileFence,expectedRevision:number,token:string){
 const data=await profileRequest<{check:{state:string;reason?:string};integrations:unknown}>(fence,'PUT','/v2/integrations/meta/token',{expectedRevision,token});
 return{check:data.check,integrations:integrationsSchema.parse(data.integrations)};
}
export const setMetaEnabled=(fence:ProfileFence,expectedRevision:number,enabled:boolean)=>profileRequest(fence,'POST','/v2/integrations/meta/state',{expectedRevision,enabled});
export const loadOnboarding=async(fence:ProfileFence,signal?:AbortSignal)=>onboardingSchema.parse(await profileRequest(fence,'GET','/v2/onboarding',undefined,signal));
export const updateOnboarding=async(fence:ProfileFence,input:{expectedVersion:number;metaSkipped?:boolean;dismissed?:boolean})=>onboardingSchema.parse(await profileRequest(fence,'PATCH','/v2/onboarding',input));
/** Integer microUSD shown as dollars without floating accumulation. */
export function usd(micro:number){const cents=Math.round(micro/10000);return(cents/100).toLocaleString('es-MX',{style:'currency',currency:'USD'});}
export const aiStateText:Record<AiProviderStatus['state'],string>={MISSING:'Sin configurar',UNVERIFIED:'Guardada, sin verificar',VERIFYING:'Verificando',VERIFIED:'Verificada',FAILED:'La prueba falló',DISABLED:'Desactivada'};
export const metaStateText:Record<Integrations['meta']['state'],string>={MISSING:'Sin configurar',UNVERIFIED:'Guardado, sin verificar',VERIFIED:'Verificado',INVALID:'No válido',DISABLED:'Desactivado'};
export const failureText:Record<string,string>={
 HTTP_REJECTED:'El proveedor rechazó la clave. Revisa que esté activa y tenga saldo.',HTTP_UNKNOWN:'El proveedor no respondió de forma concluyente.',NETWORK_UNKNOWN:'No hubo respuesta del proveedor a tiempo.',
 AI_BUDGET_REQUIRED:'Define primero el límite mensual de IA para poder verificar la clave.',AI_MODEL_CATALOG_REQUIRED:'Todavía no hay un modelo revisado de este proveedor para verificar la clave.',AI_RUNTIME_UNAVAILABLE:'La verificación no está disponible en este momento; la clave quedó guardada.',
 BUDGET:'El límite mensual de IA no alcanza para la prueba.',ALREADY_ATTEMPTED:'Esta versión de la clave ya se probó. Guárdala de nuevo para repetir la prueba.',
 META_TOKEN_EXPIRED:'Meta indica que el token venció o fue revocado.',META_PERMISSION_MISSING:'El token no tiene el permiso ads_read de lectura de anuncios.',META_PERMISSION_DENIED:'Meta no permite consultar con este token.',META_REQUEST_REJECTED:'Meta rechazó la consulta con este token.',META_UPSTREAM_UNAVAILABLE:'Meta no respondió; el token quedó guardado sin verificar.',
};
