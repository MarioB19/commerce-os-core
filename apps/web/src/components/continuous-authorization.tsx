import {useEffect,useRef,useState} from 'react';
import {sessionContinuity,ContinuityClientError} from '../../../../packages/commerce-client/src/continuous-authorization.js';
import {continuityRequestSchema,continuityResult,type ContinuityRequest,type ContinuityResult} from '../../../../packages/contracts/src/continuous-consumer.js';
import type {ContinuousAuthorization,ProtectionReason} from '../../../../packages/contracts/src/continuous-authorization.js';

interface Selection{workspaceId:string|null;version:number}
interface Props{selection:Selection;environment:'REAL'|'SIMULATION';canManage:boolean;accountLabels?:Record<string,string>}
type Purpose='commercial'|'warmup';
type Command=Extract<ContinuityRequest,{operation:'command'}>;
const protections:Record<ProtectionReason,string>={CHANNEL_DOWN:'El canal necesita recuperarse.',AI_UNAVAILABLE:'La IA no está disponible.',QUOTA_EXHAUSTED:'Se alcanzó la cuota.',IDENTITY_CHANGED:'Cambió la identidad del número.',SEND_UNCERTAIN:'Hay un envío pendiente de conciliación.',PROFILE_SUSPENDED:'El perfil está suspendido.'};
const storageKey=(workspaceId:string,purpose:Purpose,environment:string)=>'commerce.continuity.pending.v1:'+JSON.stringify([workspaceId,purpose,environment]);
function loadPending(key:string,purpose:Purpose,environment:string):Command|null{
 const raw=sessionStorage.getItem(key);if(raw===null)return null;if(raw.length>16384)throw new Error('pending state bound');
 const parsed=continuityRequestSchema.safeParse(JSON.parse(raw));
 if(!parsed.success||parsed.data.operation!=='command'||parsed.data.purpose!==purpose||parsed.data.environment!==environment)throw new Error('pending state invalid');
 return parsed.data;
}

/** Shared API consumer. A different profile selection unmounts the old authority. */
export function ContinuousAuthorizationPanel(props:Props){
 const[purpose,setPurpose]=useState<Purpose>('commercial');
 if(!props.selection.workspaceId||props.selection.version<1)return <p>Elige un perfil para consultar la continuidad.</p>;
 return <section aria-label="Continuidad del perfil"><h2>Continuidad</h2>
  <label>Actividad <select value={purpose} onChange={event=>setPurpose(event.target.value as Purpose)}><option value="commercial">Conversaciones comerciales</option><option value="warmup">Preparación entre números propios</option></select></label>
  <ContinuityView key={JSON.stringify([props.selection,purpose,props.environment])} {...props} purpose={purpose}/>
 </section>;
}

function ContinuityView({selection,environment,canManage,accountLabels={},purpose}:Props&{purpose:Purpose}){
 const workspaceId=selection.workspaceId!,key=storageKey(workspaceId,purpose,environment);
 const[initial]=useState(()=>{try{return{pending:loadPending(key,purpose,environment),error:''};}catch{return{pending:null,error:'No se pudo recuperar la operación anterior. Restablece el acceso al almacenamiento de esta pestaña antes de modificar la continuidad.'};}});
 const[pending,setPending]=useState<Command|null>(initial.pending),[error,setError]=useState(initial.error),[notice,setNotice]=useState('');
 const[result,setResult]=useState<ContinuityResult>(),[cursor,setCursor]=useState<string>(),[reload,setReload]=useState(0),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const lock=useRef(false),alive=useRef(true),epoch=useRef(0),blocked=useRef(Boolean(initial.error)),writeAbort=useRef<AbortController|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;writeAbort.current?.abort();};},[]);
 useEffect(()=>{
  const serial=++epoch.current,controller=new AbortController();setLoading(true);setResult(undefined);
  sessionContinuity(selection)({operation:'list',purpose,environment,limit:20,...(cursor?{afterId:cursor}:{})},controller.signal).then(value=>{
   if(alive.current&&epoch.current===serial&&!controller.signal.aborted)setResult(value);
  }).catch(()=>{if(alive.current&&epoch.current===serial&&!controller.signal.aborted)setError('No se pudo consultar la continuidad. Puedes volver a consultar.');})
   .finally(()=>{if(alive.current&&epoch.current===serial&&!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[selection.workspaceId,selection.version,purpose,environment,cursor,reload]);
 function clearPending(){
  // A storage failure keeps the saved intent and blocks further writes.
  sessionStorage.removeItem(key);setPending(null);
 }
 async function command(row:ContinuousAuthorization,action:Command['action']){
  if(!canManage||loading||lock.current||pending||blocked.current||row.revokedAt)return;
  const input:Command={operation:'command',purpose,environment,id:row.id,expectedVersion:row.version,operationId:crypto.randomUUID(),action};
  lock.current=true;setBusy(true);setError('');setNotice('');
  try{
   // Save before transmission; an uncertain response never causes another POST.
   sessionStorage.setItem(key,JSON.stringify(input));setPending(input);
   const controller=new AbortController();writeAbort.current=controller;
   await sessionContinuity(selection)(input,controller.signal);
   if(!alive.current)return;
   clearPending();setNotice(action==='pause'?'Actividad pausada.':action==='resume'?'Pausa retirada. Las protecciones siguen vigentes.':'Autorización revocada.');setReload(value=>value+1);
  }catch(failure){
   if(!alive.current)return;
   if(failure instanceof ContinuityClientError&&failure.code==='CONTINUITY_REQUEST_REJECTED'){
    try{clearPending();}catch{blocked.current=true;}
    setError('El cambio fue rechazado. Consulta el estado vigente antes de volver a actuar.');setReload(value=>value+1);
   }else{
    // Including a storage error: never infer that an intended write committed.
    if(!(failure instanceof ContinuityClientError))blocked.current=true;
    setError('No se pudo confirmar el cambio. Consulta el resultado de la operación antes de otra acción.');
   }
  }finally{if(alive.current){lock.current=false;setBusy(false);writeAbort.current=null;}}
 }
 async function reconcile(){
  if(!pending||lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');
  try{
   const controller=new AbortController();writeAbort.current=controller;
   const value=await sessionContinuity(selection)({operation:'receipt',purpose,environment,operationId:pending.operationId},controller.signal);
   if(!alive.current)return;
   if(value.data.length){continuityResult({data:value.data[0]},pending,workspaceId);clearPending();setNotice('El resultado de la operación quedó confirmado.');setReload(n=>n+1);}
   else setNotice('Aún no hay un resultado registrado para esta operación. Se conserva sin repetirla.');
  }catch{if(alive.current)setError('No se pudo consultar el resultado. La operación se conserva para otra consulta.');}
  finally{if(alive.current){lock.current=false;setBusy(false);writeAbort.current=null;}}
 }
 return <div>
  <p>{purpose==='commercial'?'La asignación comercial autoriza atender conversaciones elegibles.':'La conexión verificada autoriza la preparación legítima entre números propios del mismo perfil.'}</p>
  <p>Una pausa detiene esta actividad. Retirarla conserva las protecciones por salud, identidad, cuotas o envíos inciertos.</p>
  <button disabled={loading||busy} onClick={()=>setReload(n=>n+1)}>Consultar de nuevo</button>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {pending&&<div role="status"><p>Hay una operación pendiente de confirmación.</p><button disabled={busy} onClick={()=>void reconcile()}>Consultar resultado pendiente</button></div>}
  {loading&&<p role="status">Consultando continuidad…</p>}
  {result&&(!result.data.length?<p>No hay autorizaciones para esta actividad.</p>:<ul>{result.data.map((row,index)=><li key={row.id}>
   <h3>{accountLabels[row.accountId]??`Número ${index+1}`}</h3>
   <p>{row.revokedAt?'Revocada':row.humanPaused?'Pausada por una persona':row.protections.length?'Protegida; actividad detenida':'Autorizada; cada acción comprueba sus condiciones'}</p>
   {row.protections.length>0&&<ul aria-label="Protecciones vigentes">{row.protections.map(item=><li key={item.reason}>{protections[item.reason]}</li>)}</ul>}
   {canManage&&!row.revokedAt&&<div><button disabled={loading||busy||Boolean(pending)||blocked.current} onClick={()=>void command(row,row.humanPaused?'resume':'pause')}>{row.humanPaused?'Retirar pausa':'Pausar actividad'}</button><button disabled={loading||busy||Boolean(pending)||blocked.current} onClick={()=>void command(row,'revoke')}>Revocar autorización</button></div>}
  </li>)}</ul>)}
  <button disabled={!cursor||loading||busy} onClick={()=>setCursor(undefined)}>Primera página</button>
  <button disabled={!result?.nextAfterId||loading||busy} onClick={()=>setCursor(result!.nextAfterId!)}>Página siguiente</button>
 </div>;
}
