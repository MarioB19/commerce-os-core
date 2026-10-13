import {ApiError} from './api.js';
import type {ProfileFence} from './profile-request.js';
import type {VariantDocument,VariantLocale} from '../../../../packages/contracts/src/variants.js';

/** V7 F4 client for /v2/products and /v2/variants. Writes carry one
 * Idempotency-Key per user action: retrying the same action after an unclear
 * result returns the durable outcome instead of repeating the change. */
export interface MissingItem {code:string;label:string}
export interface VariantView {id:string;product:{id:string;name:string};version:number;document:VariantDocument;document_sha256:string;
 state:'NEEDS_SETUP'|'MISSING_COLLECTION'|'READY_TO_ASSIGN'|'SELLING'|'ARCHIVED';state_label:string;missing:MissingItem[];
 published:{release_id:string;revision:number}|null;unpublished_changes:boolean;archived:boolean;numbers:{account_id:string;name:string;masked:string|null}[];
 copied_from_release_id:string|null;updated_at:string}
export interface ProductSummary {id:string;version:number;name:string;description:string;archived:boolean;
 variants:{id:string;name:string;locale:VariantLocale;state:VariantView['state'];state_label:string;numbers:number;unpublished_changes:boolean}[]}
export interface VariantNumber {account_id:string;name:string;masked:string|null;status:string|null;sells_this:boolean;same_product:{variant_id:string|null;label:string}|null;others:{product:string;variant:string}[]}
export interface NumberImpact {assignment_id:string;open_conversations:number;pending_followups:number;unsent_messages:number;effect:string}
export interface HistoryView {events:{version:number;event:string;label:string;section:string|null;actor_id:string;release_id:string|null;at:string}[];releases:{id:string;revision:number;at:string}[]}
export class VariantApiError extends ApiError{constructor(message:string,status:number,code:string,readonly details?:unknown){super(message,status,code);}}

export function newOperationKey(){return crypto.randomUUID();}
export async function variantRequest<T>(fence:ProfileFence,method:'GET'|'POST'|'PUT'|'PATCH',path:string,body?:unknown,key?:string,signal?:AbortSignal):Promise<T>{
 if(!fence?.workspaceId||!Number.isSafeInteger(fence.version)||fence.version<1)throw new VariantApiError('Elige un perfil antes de continuar.',409,'PROFILE_SELECTION_REQUIRED');
 const write=method!=='GET';
 const url=path+(path.includes('?')?'&':'?')+'environment=REAL';
 let response:Response;
 try{
  response=await fetch(url,{method,credentials:'include',cache:'no-store',redirect:'error',signal,
   headers:{'X-Commerce-Profile-Id':fence.workspaceId,'X-Commerce-Profile-Version':String(fence.version),
    ...(write?{'Idempotency-Key':key??newOperationKey()}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},
   ...(body===undefined?{}:{body:JSON.stringify(body)})});
 }catch(error){
  if(signal?.aborted)throw error;
  throw new VariantApiError(write?'No se pudo confirmar el resultado. Vuelve a intentarlo: no se repetirá el cambio.':'No se pudo consultar. Vuelve a intentarlo.',0,write?'WRITE_UNCONFIRMED':'READ_FAILED');
 }
 let value:any;
 try{value=await response.json();}catch{throw new VariantApiError(write?'No se pudo confirmar el resultado. Vuelve a intentarlo: no se repetirá el cambio.':'No se pudo consultar.',response.status,'BAD_RESPONSE');}
 if(!response.ok){
  const e=value?.error??{};const code=typeof e.code==='string'?e.code:'REQUEST_FAILED';
  const message=response.status===401?'Tu sesión terminó. Vuelve a iniciar sesión.':response.status===403?(typeof e.message==='string'&&e.message!==code?e.message:'Tu rol no permite esta acción en este perfil.'):
   typeof e.message==='string'&&e.message!==code&&!/^[A-Z_]+$/.test(e.message)?e.message:write?'No se pudo guardar. Revisa los datos y vuelve a intentarlo.':'No se pudo consultar.';
  throw new VariantApiError(message,response.status,code,e.details);
 }
 return value.data as T;
}
/** Minor units shared with the server (fixed ISO table). */
const zeroDecimals=new Set(['BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','UYI','VND','VUV','XAF','XOF','XPF']);
const threeDecimals=new Set(['BHD','IQD','JOD','KWD','LYD','OMR','TND']);
export const digitsOf=(currency:string)=>zeroDecimals.has(currency)?0:threeDecimals.has(currency)?3:2;
export function toMinor(input:string,currency:string):number|null{
 const clean=input.replace(/[\s$,]/g,'').replace(/^([0-9]+)\.([0-9]+)$/,'$1.$2');
 if(!/^[0-9]+(\.[0-9]+)?$/.test(clean))return null;
 const digits=digitsOf(currency),[whole,fraction='']=clean.split('.');
 if(fraction.length>digits)return null;
 const value=Number(whole)*10**digits+Number((fraction+'0'.repeat(digits)).slice(0,digits)||'0');
 return Number.isSafeInteger(value)?value:null;
}
export function fromMinor(minor:number,currency:string){const d=digitsOf(currency);return (minor/10**d).toFixed(d);}
export function formatMoney(minor:number,currency:string,language='es-MX'){
 const d=digitsOf(currency);
 try{return new Intl.NumberFormat(language,{style:'currency',currency,minimumFractionDigits:d,maximumFractionDigits:d}).format(minor/10**d);}catch{return `${fromMinor(minor,currency)} ${currency}`;}
}
export const markets:{label:string;locale:VariantLocale}[]=[
 {label:'México',locale:{market:'México',country:'MX',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'}},
 {label:'Colombia',locale:{market:'Colombia',country:'CO',currency:'COP',language:'es-CO',timezone:'America/Bogota'}},
 {label:'Argentina',locale:{market:'Argentina',country:'AR',currency:'ARS',language:'es-AR',timezone:'America/Argentina/Buenos_Aires'}},
 {label:'Chile',locale:{market:'Chile',country:'CL',currency:'CLP',language:'es-CL',timezone:'America/Santiago'}},
 {label:'Perú',locale:{market:'Perú',country:'PE',currency:'PEN',language:'es-PE',timezone:'America/Lima'}},
 {label:'Ecuador',locale:{market:'Ecuador',country:'EC',currency:'USD',language:'es-EC',timezone:'America/Guayaquil'}},
 {label:'Guatemala',locale:{market:'Guatemala',country:'GT',currency:'GTQ',language:'es-GT',timezone:'America/Guatemala'}},
 {label:'España',locale:{market:'España',country:'ES',currency:'EUR',language:'es-ES',timezone:'Europe/Madrid'}},
 {label:'Estados Unidos (español)',locale:{market:'Estados Unidos',country:'US',currency:'USD',language:'es-US',timezone:'America/New_York'}},
 {label:'Estados Unidos (inglés)',locale:{market:'Estados Unidos',country:'US',currency:'USD',language:'en-US',timezone:'America/New_York'}},
 {label:'Brasil',locale:{market:'Brasil',country:'BR',currency:'BRL',language:'pt-BR',timezone:'America/Sao_Paulo'}},
];
export const languageLabel=(language:string)=>{try{return new Intl.DisplayNames(['es'],{type:'language'}).of(language)??language;}catch{return language;}};
