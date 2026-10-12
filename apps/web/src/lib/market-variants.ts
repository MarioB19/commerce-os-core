import type {MarketPendingStore} from './market-variant-pending.js';
import {marketCommandSchema,marketCommandResult,type MarketCommand,type MarketCommandResult} from '../../../../packages/contracts/src/market-variant-client.js';
import {MarketClientError,type MarketClient} from '../../../../packages/commerce-client/src/market-variants.js';
import type {MarketEnvironment} from '../../../../packages/contracts/src/market-variant-store.js';

function currencyDigits(currency:string){
 const digits=new Intl.NumberFormat('es-MX',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
 if(typeof digits!=='number'||!Number.isSafeInteger(digits)||digits<0||digits>6)throw Error('MARKET_PRICE_INVALID');return digits;
}
export function marketPriceText(amount:number,currency:string):string{
 if(!Number.isSafeInteger(amount)||amount<0)throw Error('MARKET_PRICE_INVALID');
 const digits=currencyDigits(currency);
 const raw=String(amount).padStart(digits+1,'0');return digits?raw.slice(0,-digits)+'.'+raw.slice(-digits):raw;
}
export function marketPriceMinor(text:string,currency:string):number{
 const digits=currencyDigits(currency);
 if(!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text))throw Error('MARKET_PRICE_INVALID');
 const[whole,fraction='']=text.split('.');if(fraction.length>digits)throw Error('MARKET_PRICE_INVALID');
 const amount=BigInt(whole!)*10n**BigInt(digits)+BigInt(fraction.padEnd(digits,'0')||'0');
 if(amount>BigInt(Number.MAX_SAFE_INTEGER))throw Error('MARKET_PRICE_INVALID');return Number(amount);
}

type Mutation=Extract<MarketCommand,{operation_id:string}>;
type MutationInput=Mutation extends infer C?C extends Mutation?Omit<C,'operation_id'|'environment'>:never:never;
type Read=Exclude<MarketCommand,Mutation>;
type ReadInput=Read extends infer C?C extends Read?Omit<C,'environment'>:never:never;
export type MarketViewState={status:'IDLE'|'LOADING'|'READY'|'WRITING'|'UNCERTAIN'|'ERROR';
 result:MarketCommandResult|null;pending:Mutation|null;mayResend:boolean;message:string};
const initial:MarketViewState={status:'IDLE',result:null,pending:null,mayResend:false,message:''};
function freeze<T>(value:T):T{
 if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;
}

/** One selected view in RAM. Disposal hides stale responses, never rolls back a write. */
export function marketVariantsView(client:MarketClient,environment:MarketEnvironment,workspace:string,uuid:()=>string=()=>crypto.randomUUID(),persistence?:MarketPendingStore){
 let state:MarketViewState=initial,disposed=false,epoch=0,flight:AbortController|undefined,storageBlocked=false;
 try{const pending=persistence?.load();if(pending)state=freeze({...initial,status:'UNCERTAIN',pending,message:'Hay una operación pendiente. Comprueba su resultado antes de continuar.'});}
 catch{storageBlocked=true;state={...initial,status:'ERROR',message:'No se pudo validar la operación guardada. No se enviarán cambios.'};}
 const listeners=new Set<()=>void>();
 const emit=(next:MarketViewState)=>{if(disposed)return;state=freeze(next);for(const listener of listeners)listener();};
 const busy=()=>disposed||storageBlocked||state.status==='LOADING'||state.status==='WRITING';
 function start(){const serial=++epoch;flight?.abort();flight=new AbortController();return{serial,signal:flight.signal};}
 async function read(input:ReadInput){
  if(busy()||state.pending)return;
  const command=marketCommandSchema.parse({...input,environment});
  if('operation_id'in command)throw Error('MARKET_READ_REQUIRED');
  const {serial,signal}=start();emit({...initial,status:'LOADING'});
  try{const result=await client(command,signal);if(!disposed&&serial===epoch)emit({...initial,status:'READY',result});}
  catch{if(!disposed&&serial===epoch)emit({...initial,status:'ERROR',message:'No se pudo confirmar la consulta. Puedes volver a consultar.'});}
 }
 async function send(command:Mutation){
  const {serial,signal}=start();emit({...initial,status:'WRITING',pending:command});
  try{persistence?.save(command);const result=marketCommandResult(await client(command,signal),command,workspace);if(!disposed&&serial===epoch){persistence?.clear();emit({...initial,status:'READY',result});}}
  catch{if(!disposed&&serial===epoch)emit({...initial,status:'UNCERTAIN',pending:command,message:'El resultado no está confirmado. Consulta esta operación antes de continuar.'});}
 }
 async function write(input:MutationInput){
  if(busy()||state.pending)return;
  const command=marketCommandSchema.parse({...input,environment,operation_id:uuid()});
  if(!('operation_id'in command))throw Error('MARKET_WRITE_REQUIRED');
  await send(freeze(command));
 }
 async function reconcile(){
  if(busy()||!state.pending)return;
  const pending=state.pending,{serial,signal}=start();emit({...initial,status:'LOADING',pending});
  try{
   const observed=await client({operation:'reconcile',environment,id:pending.operation_id},signal);
   const result=marketCommandResult(observed,pending,workspace);
   if(!disposed&&serial===epoch){persistence?.clear();emit({...initial,status:'READY',result,message:'Operación confirmada.'});}
  }catch(error){
   if(!disposed&&serial===epoch)emit({...initial,status:'UNCERTAIN',pending,
    mayResend:error instanceof MarketClientError&&error.code==='MARKET_OPERATION_NOT_FOUND'&&error.status===404,
    message:error instanceof MarketClientError&&error.code==='MARKET_OPERATION_NOT_FOUND'&&error.status===404?'La consulta no encontró el recibo. Puedes consultar de nuevo o reenviar la misma solicitud.':'Todavía no se pudo confirmar la operación.'});
  }
 }
 return{snapshot:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},read,write,reconcile,
  resend:async()=>{if(!busy()&&state.pending&&state.mayResend)await send(state.pending);},
  dispose:()=>{disposed=true;epoch++;flight?.abort();listeners.clear();}};
}
