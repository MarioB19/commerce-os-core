import {createHash} from 'node:crypto';
import {warmupContentSchema,warmupProfileSchema} from './policy.js';
export const QR_POLICY_ORIGIN='SYSTEM_QR_POLICY' as const;
export const QR_LIBRARY_VERSION='system-qr-checks/v1' as const;
function canonical(v:unknown):string{
 if(Array.isArray(v))return'['+v.map(canonical).join(',')+']';
 if(v&&typeof v==='object')return'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
 return JSON.stringify(v);
}
/** Own-number operational checks; no invented person, sales or provider claims. */
export const systemQrContents=Object.freeze(Array.from({length:12},(_,i)=>{
 const label=`Comprobación interna ${String(i+1).padStart(2,'0')}`;
 const body=warmupContentSchema.parse({label,ownership_confirmed:true,turns:[
  {kind:'text',text:`${label}: prueba interna entre números de este negocio.`},
  {kind:'text',text:`${label}: respuesta interna de recepción.`},
  {kind:'text',text:`${label}: comprobación del orden de los mensajes.`},
  {kind:'text',text:`${label}: respuesta interna en el orden previsto.`},
  {kind:'text',text:`${label}: fin del intercambio de comprobación.`},
  {kind:'text',text:`${label}: cierre interno del intercambio.`},
 ]});
 body.turns.forEach(Object.freeze);Object.freeze(body.turns);Object.freeze(body);
 return Object.freeze({body,content_hash:createHash('sha256').update(canonical(body)).digest('hex')});
}));
export const QR_LIBRARY_SHA256=createHash('sha256').update(canonical(systemQrContents)).digest('hex');
export function systemQrProfile(timezone:string){return warmupProfileSchema.parse({name:'Preparación automática QR',policy_version:'standard-15d/v2',timezone});}
