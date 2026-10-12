import {z} from 'zod';
import {profileIdSchema} from '../../../../packages/contracts/src/profiles.js';
import {profileSalesMutation,profileSalesPointer,type ProfileSalesMutation,type ProfileSalesPointer,type ProfileSalesCommand} from '../../../../packages/contracts/src/profile-sales-consumer.js';
import {ProfileSalesError,type ProfileSalesClient} from '../../../../packages/commerce-client/src/profile-sales.js';
export interface SalesPendingStore{load():ProfileSalesPointer|null;save(value:ProfileSalesPointer):void;clear():void}
/** Recovery pointer only: no message, customer name, review text, key or token. */
export function salesPendingStore(scope:unknown,storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>):SalesPendingStore{
 const expected=z.object({actor:profileIdSchema,workspace:profileIdSchema,environment:z.enum(['REAL','SIMULATION'])}).strict().parse(scope),key='commerce:sales-pending:v1:'+JSON.stringify(expected);
 const schema=z.object({version:z.literal(1),scope:z.object({actor:profileIdSchema,workspace:profileIdSchema,environment:z.enum(['REAL','SIMULATION'])}).strict(),pointer:profileSalesPointer}).strict();
 function parse(value:unknown){const row=schema.parse(value);if(JSON.stringify(row.scope)!==JSON.stringify(expected)||row.pointer.environment!==expected.environment)throw Error('SALES_PENDING_SCOPE_INVALID');return row.pointer;}
 return{load(){const value=storage.getItem(key);if(value===null)return null;if(value.length>4096)throw Error('SALES_PENDING_INVALID');return parse(JSON.parse(value));},
  save(pointer){const value={version:1,scope:expected,pointer};parse(value);const raw=JSON.stringify(value);storage.setItem(key,raw);if(storage.getItem(key)!==raw)throw Error('SALES_PENDING_NOT_DURABLE');},
  clear(){storage.removeItem(key);if(storage.getItem(key)!==null)throw Error('SALES_PENDING_NOT_CLEARED');}};
}
type Input=ProfileSalesMutation extends infer Q?Q extends ProfileSalesMutation?Omit<Q,'operation_id'|'environment'>:never:never;
export type SalesMutationInput=Input;
export interface SalesMutationState{status:'IDLE'|'WORKING'|'UNCERTAIN'|'CONFIRMED'|'ERROR';pending:ProfileSalesPointer|null;command:ProfileSalesCommand|null;mayResend:boolean;message:string}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
const initial:SalesMutationState=freeze({status:'IDLE',pending:null,command:null,mayResend:false,message:''});
async function pointerFor(command:ProfileSalesMutation):Promise<ProfileSalesPointer>{
 const bytes=new TextEncoder().encode(JSON.stringify(command)),digest=await crypto.subtle.digest('SHA-256',bytes);
 return profileSalesPointer.parse({operation:command.operation,operation_id:command.operation_id,resource_id:command.resource_id,environment:command.environment,request_sha256:Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('')});
}
/** All mutations retain their UUID across unknown outcomes. Recovery GET alone
 * never causes a POST. A restored pointer requires re-entry of the exact body
 * and its digest before an explicitly requested resend of that same UUID. */
export function salesMutationView(client:ProfileSalesClient,environment:'REAL'|'SIMULATION',store:SalesPendingStore,uuid:()=>string=()=>crypto.randomUUID()){
 let state:SalesMutationState=initial,active=true,epoch=0,flight:AbortController|undefined,blocked=false,memory:ProfileSalesMutation|undefined,last:ProfileSalesPointer|undefined,knownCommand:string|undefined;
 const listeners=new Set<()=>void>();
 function emit(next:SalesMutationState){if(!active)return;state=freeze(structuredClone(next));for(const listener of listeners)listener();}
 try{const pending=store.load();if(pending)state=freeze({...initial,status:'UNCERTAIN',pending,message:'Hay una solicitud pendiente. Consulta su resultado antes de continuar.'});}
 catch{blocked=true;state=freeze({...initial,status:'ERROR',message:'No se pudo validar el seguimiento guardado. No se enviarán cambios.'});}
 const busy=()=>!active||blocked||state.status==='WORKING';
 function start(){flight?.abort();flight=new AbortController();return{serial:++epoch,signal:flight.signal};}
 async function reconcile(){
  if(busy()||!(state.pending??last))return;const pending=state.pending??last!,{serial,signal}=start();emit({...initial,status:'WORKING',pending});
  try{const command=await client.reconcile(pending,signal);if(active&&serial===epoch){
   if(knownCommand&&command.id!==knownCommand)throw Error('SALES_COMMAND_MISMATCH');
   store.clear();memory=undefined;last=pending;knownCommand=command.id;
   emit({...initial,status:'CONFIRMED',command,message:command.status==='PENDING'?'Comando registrado; su aplicación sigue pendiente.':command.status==='APPLIED'?'Comando aplicado.':'El comando no se aplicó. Consulta el resultado.'});
  }}catch(error){if(active&&serial===epoch){const absent=!knownCommand&&error instanceof ProfileSalesError&&error.code==='SALES_OPERATION_NOT_FOUND';emit({...initial,status:'UNCERTAIN',pending,mayResend:absent,message:absent?'No se encontró la solicitud. Puedes consultar de nuevo o reenviar exactamente los mismos datos.':'El resultado todavía no está confirmado. No repitas la acción.'});}}
 }
 async function send(command:ProfileSalesMutation,pending:ProfileSalesPointer){
  const{serial,signal}=start();emit({...initial,status:'WORKING',pending});
  try{store.save(pending);memory=freeze(structuredClone(command));const accepted=await client.write(command,signal);if(active&&serial===epoch){knownCommand=accepted.command_id;emit({...initial,status:'UNCERTAIN',pending});await reconcile();}}
  catch{if(active&&serial===epoch)emit({...initial,status:'UNCERTAIN',pending,message:'No se pudo confirmar el resultado. Consulta la solicitud antes de continuar.'});}
 }
 return{snapshot:()=>state,subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},reconcile,
  async submit(input:Input){
   if(busy()||state.pending&&!state.mayResend)return;
   const previous=state.pending;
   // Reserve the local action before hashing, so two clicks cannot create UUIDs.
   const{serial}=start();emit({...initial,status:'WORKING',pending:previous});
   try{const command=profileSalesMutation.parse({...input,environment,operation_id:previous?.operation_id??uuid()});const pointer=await pointerFor(command);if(!active||serial!==epoch)return;if(previous&&JSON.stringify(previous)!==JSON.stringify(pointer)){emit({...initial,status:'UNCERTAIN',pending:previous,mayResend:true,message:'Los datos no coinciden con la solicitud original. No se envió ningún cambio.'});return;}if(!previous){last=undefined;knownCommand=undefined;}await send(command,pointer);}
   catch{if(active&&serial===epoch)emit({...initial,status:previous?'UNCERTAIN':'ERROR',pending:previous,message:'Revisa los datos. No se pudo preparar la solicitud.'});}
  },
  async resend(){if(busy()||!state.pending||!state.mayResend||!memory)return;await send(memory,state.pending);},
  dispose(){active=false;epoch++;flight?.abort();memory=undefined;last=undefined;knownCommand=undefined;listeners.clear();},
 };
}

/** Pagination stays within the fixed reader bound; narrower filters are required beyond it. */
export function nextSalesPage(offset:number,total:number):number|null{
 if(!Number.isSafeInteger(offset)||offset<0||offset>10000||!Number.isSafeInteger(total)||total<0)throw Error('SALES_PAGE_INVALID');
 const next=offset+20;return next<=10000&&next<total?next:null;
}
