import {profileBootstrapSchema,profileSelectionSchema,selectProfileSchema} from '../../../../packages/contracts/src/profiles.js';
import {api,ApiError} from './api.js';

export async function loadProfiles(signal?:AbortSignal){
 const value=profileBootstrapSchema.safeParse(await api('/v2/me/profiles',{signal}));
 if(!value.success)throw new ApiError('No se pudo confirmar la lista de perfiles.',503,'PROFILE_RESPONSE_INVALID');
 return value.data;
}
/** Exactly one POST. Uncertain responses require a fresh GET, never a replay. */
export async function selectProfile(workspaceId:string,expectedVersion:number){
 const body=selectProfileSchema.parse({workspaceId,expectedVersion});
 let response:unknown;
 try{response=await api('/v2/me/profile-selection',{method:'POST',body:JSON.stringify(body)});}
 catch(error){throw new ApiError('No se pudo confirmar el cambio. Actualiza los perfiles para revisar la selección.',error instanceof ApiError?error.status:0,error instanceof ApiError?error.code:'PROFILE_SELECTION_UNCONFIRMED');}
 const value=profileSelectionSchema.safeParse(response);
 if(!value.success||value.data.workspaceId!==workspaceId||value.data.version!==expectedVersion+1)
  throw new ApiError('No se pudo confirmar el cambio. Actualiza los perfiles para revisar la selección.',409,'PROFILE_SELECTION_UNCONFIRMED');
 return {workspaceId,version:value.data.version};
}
