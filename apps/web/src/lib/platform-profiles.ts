import {api,ApiError} from './api.js';

/** V7 RF-02 platform administration client: identity-level calls outside
 * every profile (no fence header), aggregate data only. */
export type PlatformProfile={id:string;businessName:string;state:'ACTIVE'|'SUSPENDED';timezone:string;limits:{numbers:number;products:number;dailyConversations:number};version:number;
 owners:number;numbers:{registered:number;connected:number;disconnected:number};products:number;variants:number;offers:number;signals:string[];lastActivityAt:string|null;createdAt:string};
export type PlatformCapacity={profiles:{used:number;max:number};numbers:{allocated:number;registered:number;max:number};dailyConversationsPerProfile:number};
export type PlatformLimits=PlatformProfile['limits'];
const messages:Record<string,string>={
 PLATFORM_ADMIN_REQUIRED:'Tu cuenta no administra la plataforma.',
 PROFILE_SESSION_EXPIRED:'Tu sesión terminó. Vuelve a iniciar sesión.',
 PLATFORM_PROFILE_CHANGED:'El perfil cambió mientras lo editabas. Actualiza la lista y revisa antes de repetir.',
 PLATFORM_OPERATION_CONTENT_CHANGED:'Esta operación ya se registró con otros datos. Actualiza la lista antes de continuar.',
 PROFILE_QUOTA_ALLOCATION_EXCEEDED:'La plataforma ya usa su máximo de perfiles o de números asignados.',
 PROFILE_QUOTA_BELOW_CONSUMED:'El nuevo límite es menor que lo que el perfil ya usa.',
 PLATFORM_PROFILE_HAS_OWNER:'Este perfil ya tiene una persona Dueño; ella administra sus invitaciones.',
 INVITATION_ALREADY_PENDING:'Ya hay una invitación pendiente para ese correo.',
 PROFILE_SUSPENDED:'El perfil está suspendido. Reactívalo antes de invitar.',
 PLATFORM_PROFILE_INVALID:'Revisa el nombre, la zona horaria y los límites.',
 PLATFORM_REQUEST_INVALID:'Revisa los datos del formulario.',
 ORIGIN_REJECTED:'La solicitud no salió de Commerce OS. Recarga la página.',
 PLATFORM_TOKEN_LIMIT:'Ya tienes 10 accesos activos. Revoca uno antes de crear otro.',
 PLATFORM_TOKEN_INVALID_INPUT:'Revisa el nombre, los permisos y la vigencia (máximo 90 días).',
 PLATFORM_INTERACTIVE_SESSION_REQUIRED:'Esta acción sólo puede hacerse con tu sesión en la aplicación.',
 PLATFORM_DELETION_REQUIRES_SUSPENDED:'Suspende el perfil antes de pedir su eliminación.',
 PLATFORM_DELETION_CONFIRMATION_MISMATCH:'El nombre escrito no coincide exactamente con el nombre del negocio.',
 PLATFORM_DELETION_EXPORT_REQUIRED:'Falta una exportación de los últimos 7 días. La persona Dueño debe exportar los datos del perfil primero.',
 PROFILE_DELETION_PENDING:'Este perfil tiene una eliminación pendiente. Cancélala antes de reactivarlo o de pedir otra.',
 PLATFORM_DELETION_NOT_PENDING:'La eliminación ya no está pendiente. Actualiza la lista.',
 PLATFORM_DELETION_INVALID:'Escribe un motivo de 8 a 500 caracteres.',
 REQUEST_TIMEOUT:'La operación tardó demasiado y su resultado no es concluyente. Actualiza la lista antes de repetir.',
};
export function platformMessage(error:unknown){
 if(error instanceof ApiError)return messages[error.code]??(error.status===0?error.message:'No se pudo completar la operación. Actualiza la lista y vuelve a intentar.');
 return 'No se pudo completar la operación. Actualiza la lista y vuelve a intentar.';
}
export const signalLabels:Record<string,string>={NUMBERS_DISCONNECTED:'Números desconectados',AI_UNVERIFIED:'IA sin verificar',OWNER_MISSING:'Sin persona Dueño',NUMBER_LIMIT_REACHED:'Límite de números alcanzado',META_INVALID:'Token de Meta no válido'};
export async function loadPlatformAccess(signal?:AbortSignal){return (await api<{admin:boolean}>('/v2/platform/access',{signal})).admin;}
export async function loadPlatformProfiles(signal?:AbortSignal){return api<{profiles:PlatformProfile[];capacity:PlatformCapacity}>('/v2/platform/profiles',{signal});}
type Result={status:string;profileId:string;version?:number;invitationId?:string;replayed:boolean};
export function createPlatformProfile(input:{operationId:string;businessName:string;timezone:string;limits:PlatformLimits}){return api<Result>('/v2/platform/profiles',{method:'POST',body:JSON.stringify(input)});}
export function updatePlatformProfile(id:string,input:{operationId:string;expectedVersion:number;state:'ACTIVE'|'SUSPENDED'}|{operationId:string;expectedVersion:number;limits:PlatformLimits}){return api<Result>(`/v2/platform/profiles/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(input)});}
export function invitePlatformOwner(id:string,input:{operationId:string;email:string}){return api<Result>(`/v2/platform/profiles/${encodeURIComponent(id)}/owner-invitations`,{method:'POST',body:JSON.stringify(input)});}
export type PlatformToken={id:string;name:string;scopes:string[];expiresAt:string;revokedAt:string|null;createdAt:string};
export const platformScopeLabels:Record<string,string>={'platform:profiles':'Perfiles','platform:capacity':'Capacidad','platform:health':'Salud de servicios','platform:recovery':'Recuperación','platform:releases':'Versiones','platform:audit':'Auditoría'};
export function loadPlatformTokens(signal?:AbortSignal){return api<PlatformToken[]>('/v2/platform/tokens',{signal});}
export function issuePlatformToken(input:{name:string;scopes:string[];expiresAt:string}){return api<PlatformToken&{token:string}>('/v2/platform/tokens',{method:'POST',body:JSON.stringify(input)});}
export function revokePlatformToken(id:string){return api<{id:string;revoked:true;changed:boolean}>(`/v2/platform/tokens/${encodeURIComponent(id)}/revoke`,{method:'POST',body:'{}'});}
export type PlatformDeletionState={profileId:string;state:'ACTIVE'|'SUSPENDED';version:number;
 lastExport:{id:string;sha256:string;rows:number;bytes:number;createdAt:string;usable:boolean}|null;
 deletion:{id:string;status:'PENDING_ERASURE'|'CANCELLED';requestedAt:string;exportId:string}|null};
export function loadPlatformDeletion(id:string,signal?:AbortSignal){return api<PlatformDeletionState>(`/v2/platform/profiles/${encodeURIComponent(id)}/deletion`,{signal});}
export function requestPlatformDeletion(id:string,input:{operationId:string;expectedVersion:number;confirmation:string;exportId:string;reason:string}){return api<{status:string;deletionId:string;erased:false;replayed:boolean}>(`/v2/platform/profiles/${encodeURIComponent(id)}/deletion`,{method:'POST',body:JSON.stringify(input)});}
export function cancelPlatformDeletion(id:string,input:{operationId:string;deletionId:string;reason:string}){return api<{status:string;deletionId:string;replayed:boolean}>(`/v2/platform/profiles/${encodeURIComponent(id)}/deletion/cancel`,{method:'POST',body:JSON.stringify(input)});}
