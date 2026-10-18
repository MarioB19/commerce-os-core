import {SalesNav} from './sales-nav.js';
import {useEffect,useMemo,useRef,useState,type FormEvent} from 'react';
import {MessageSquare,Search,ShoppingBag} from 'lucide-react';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import type {ProfileSalesRow} from '../../../../packages/contracts/src/profile-sales-consumer.js';
import {sessionProfileSales} from '../../../../packages/commerce-client/src/profile-sales.js';
import {salesMutationView,salesPendingStore,nextSalesPage,type SalesMutationInput,type SalesMutationState} from '../lib/profile-sales.js';
import {marketPriceText} from '../lib/market-price.js';
import {Alert,Badge,Button,Card,CardHead,EmptyState,ErrorState,Field,Input,PageHeader,Skeleton,Textarea,toneOf} from './ui';
type Resource='conversations'|'orders';
const labels={conversations:'Conversaciones',orders:'Pedidos'};
const words:Record<string,string>={OPEN:'Abierta',CLOSED:'Cerrada',PENDING:'Pendiente',READY:'Preparado',APPROVED:'Aprobado',REJECTED:'Rechazado',HUMAN_REVIEW:'Revisión humana',PAID:'Pagado',UNPAID:'Sin pagar',FULFILLED:'Entregado',RECEIVED:'Recibido',PROCESSING:'En proceso',VALID:'Válido',INVALID:'No válido'};
const str=(v:unknown,fallback='Sin dato')=>typeof v==='string'&&v?v:fallback;
const stateLabel=(v:unknown)=>typeof v==='string'?(words[v]??v):'Sin estado';
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
function moment(v:unknown,timezone:string){if(typeof v!=='string'||!Number.isFinite(Date.parse(v)))return 'Fecha no disponible';return new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short',timeZone:timezone}).format(new Date(v));}
function amount(row:Record<string,unknown>){const minor=row.amount_minor??row.total_minor,currency=row.currency;return typeof minor==='number'&&Number.isSafeInteger(minor)&&typeof currency==='string'?`${marketPriceText(minor,currency)} ${currency}`:'Importe no confirmado';}
const empty:SalesMutationState={status:'IDLE',pending:null,command:null,mayResend:false,message:''};
/** V7 Ventas (RF-09): inbox and orders. Mounted only under a native selected
 * profile; commands are registered first and applied by the worker. */
export function ProfileSales({resource,selection,actorId,role,profileState,timezone}:{resource:Resource;selection:{workspaceId:string;version:number};actorId:string;role:ProfileRole;profileState:ProfileState;timezone:string}){
 const scope=JSON.stringify([selection.workspaceId,selection.version,actorId,resource]),client=useMemo(()=>sessionProfileSales(selection),[selection.workspaceId,selection.version]);
 const [search,setSearch]=useState(''),[query,setQuery]=useState(''),[offset,setOffset]=useState(0),[selected,setSelected]=useState<string|null>(()=>{if(resource!=='conversations')return null;try{const id=new URLSearchParams(location.search).get('conversation');return id&&/^[0-9a-f-]{36}$/i.test(id)?id:null;}catch{return null;}}),[reload,setReload]=useState(0);
 const [page,setPage]=useState<{scope:string;rows:ProfileSalesRow[];total:number;error?:boolean}|null>(null),[detail,setDetail]=useState<{scope:string;id:string;row?:ProfileSalesRow;error?:boolean}|null>(null);
 const mutation=useRef<ReturnType<typeof salesMutationView>|null>(null),[operation,setOperation]=useState<SalesMutationState>(empty),[formError,setFormError]=useState(''),[message,setMessage]=useState(''),[reason,setReason]=useState('');
 useEffect(()=>{let store;try{store=salesPendingStore({actor:actorId,workspace:selection.workspaceId,environment:'REAL'},sessionStorage);}catch{store={load:()=>{throw Error('storage');},save:()=>{throw Error('storage');},clear:()=>{throw Error('storage');}};}const view=salesMutationView(client,'REAL',store);mutation.current=view;setOperation(view.snapshot());const off=view.subscribe(()=>setOperation(view.snapshot()));return()=>{off();view.dispose();if(mutation.current===view)mutation.current=null;};},[client,actorId,selection.workspaceId]);
 useEffect(()=>{const controller=new AbortController();setPage(null);client.read({operation:'list',resource,environment:'REAL',q:query||undefined,limit:20,offset},controller.signal).then(value=>{if(!controller.signal.aborted)setPage({scope,rows:value.data,total:value.meta.total});}).catch(()=>{if(!controller.signal.aborted)setPage({scope,rows:[],total:0,error:true});});return()=>controller.abort();},[client,scope,resource,query,offset,reload]);
 useEffect(()=>{setDetail(null);setMessage('');setReason('');setFormError('');if(!selected)return;const controller=new AbortController();client.read({operation:'get',resource,id:selected,environment:'REAL'},controller.signal).then(value=>{if(!controller.signal.aborted){const row=value.data[0]!;setDetail({scope,id:selected,row});}}).catch(()=>{if(!controller.signal.aborted)setDetail({scope,id:selected,error:true});});return()=>controller.abort();},[client,scope,resource,selected,reload]);
 useEffect(()=>{if(operation.status==='CONFIRMED')setReload(n=>n+1);},[operation.status,operation.command?.id,operation.command?.status]);
 const current=page?.scope===scope?page:null,chosen=detail?.scope===scope&&detail.id===selected?detail:null,row=chosen?.row;
 const nextPage=current?nextSalesPage(offset,current.total):null;
 const writable=role!=='viewer'&&profileState==='ACTIVE',locked=operation.status==='WORKING'||!!operation.pending&&!operation.mayResend;
 function filter(event:FormEvent){event.preventDefault();setOffset(0);setSelected(null);setQuery(search.trim());}
 async function submit(input:SalesMutationInput){if(!writable||locked)return;setFormError('');await mutation.current?.submit(input);}
 function command(type:'send_message'|'close_conversation'|'commitment'|'opt_out'){
  if(!row)return;const body=type==='send_message'?{type,kind:'text' as const,text:message,expected_version:row.version}:type==='commitment'?{type}:{type,reason};void submit({operation:'conversation.command',resource_id:row.id,body});
 }
 function control(name:'paused'|'takeover',value:boolean){if(row)void submit({operation:'conversation.controls',resource_id:row.id,body:{[name]:value,reason}});}
 const title=(item:ProfileSalesRow)=>str(item.name??item.title,`${resource==='conversations'?'Conversación':'Pedido'} ${item.id.slice(-8)}`);
 const Icon=resource==='conversations'?MessageSquare:ShoppingBag;
 return <>
  <PageHeader title={labels[resource]} description={resource==='conversations'?'Lo que tus números atienden ahora. Elige una conversación para ver sus mensajes y tomar el control.':'Pedidos registrados por tus números. Cada pedido se paga con un comprobante.'}/>
  <SalesNav current={resource}/>
  {operation.status!=='IDLE'&&<Alert tone={operation.status==='UNCERTAIN'||operation.status==='ERROR'?'error':'info'} title={operation.status==='WORKING'?'Confirmando la solicitud…':operation.message} actions={<>{(operation.pending||operation.command)&&<Button variant="secondary" size="sm" disabled={operation.status==='WORKING'} onClick={()=>{void mutation.current?.reconcile();}}>Consultar solicitud</Button>}</>}>
   {operation.pending&&<span>Referencia: <code>{operation.pending.operation_id}</code>. Conversación: <code>{operation.pending.resource_id}</code>.</span>}
   {operation.mayResend&&writable&&<span>Si recargaste la página, vuelve a abrir el mismo registro y completa exactamente los mismos datos. El contenido del mensaje no se guarda en el navegador.</span>}
  </Alert>}
  <form onSubmit={filter} className="toolbar"><div className="toolbar-search"><Search aria-hidden="true"/><Input type="search" aria-label={`Buscar ${labels[resource].toLowerCase()}`} placeholder={`Buscar ${labels[resource].toLowerCase()}`} value={search} maxLength={160} onChange={e=>setSearch(e.target.value)}/></div><Button type="submit" variant="secondary">Buscar</Button></form>
  <div className={'layout-1-2 sales-layout'+(selected?' has-selection':'')}>
   <section aria-label={`Lista de ${labels[resource].toLowerCase()}`} className="stack-tight">
    {!current&&<Skeleton lines={5}/>}
    {current?.error&&<ErrorState message="No se pudo confirmar la lista. Revisa tu acceso y vuelve a consultar." onRetry={()=>setReload(n=>n+1)} retryLabel="Consultar de nuevo"/>}
    {current&&!current.error&&<>
     <p className="muted text-sm">{current.total} registro{current.total===1?'':'s'}</p>
     {!current.rows.length&&<EmptyState inline level={3} icon={<Icon aria-hidden="true"/>} title={query?'Sin resultados con este filtro':resource==='conversations'?'Todavía no hay conversaciones':'Todavía no hay pedidos'} description={query?'Prueba con otro texto.':resource==='conversations'?'Cuando un cliente escriba a uno de tus números, aparecerá aquí.':'Los pedidos aparecen cuando un cliente acepta una oferta.'}/>}
     <ul className="select-list">{current.rows.map(item=><li key={item.id}><button type="button" aria-pressed={selected===item.id} onClick={()=>setSelected(item.id)}>
      <span className="row-title">{title(item)}</span>
      <span className="cluster"><Badge tone={toneOf(String(item.status??item.stage??''))} icon={false}>{stateLabel(item.status??item.stage)}</Badge><span className="muted text-sm">{moment(item.updated_at,timezone)}</span></span>
      {resource!=='conversations'&&<span className="muted text-sm">{amount(item)}</span>}
     </button></li>)}</ul>
     {(offset>0||nextPage!==null)&&<div className="cluster"><Button variant="secondary" size="sm" disabled={!offset} onClick={()=>{setOffset(Math.max(0,offset-20));setSelected(null);}}>Anterior</Button><Button variant="secondary" size="sm" disabled={nextPage===null} onClick={()=>{if(nextPage!==null){setOffset(nextPage);setSelected(null);}}}>Siguiente</Button></div>}
     {offset>=10000&&current.total>offset+20&&<p className="muted text-sm">Acota la búsqueda para consultar más registros.</p>}
    </>}
   </section>
   <section aria-label="Detalle seleccionado">
    {!selected&&<EmptyState inline level={3} icon={<Icon aria-hidden="true"/>} title={`Elige ${resource==='conversations'?'una conversación':'un pedido'}`} description="El detalle aparece aquí."/>}
    {selected&&!chosen&&<Skeleton lines={6} label="Consultando detalle…"/>}
    {chosen?.error&&<ErrorState message="No se pudo confirmar este registro. No se habilitarán cambios." onRetry={()=>setReload(n=>n+1)} retryLabel="Consultar detalle"/>}
    {row&&<Card aria-labelledby="detail-title">
     <CardHead id="detail-title" title={str(row.name??row.title,resource==='conversations'?'Detalle de conversación':'Detalle del pedido')} description={`${stateLabel(row.status??row.stage)} · Revisión ${row.version}`}/>
     {resource==='conversations'?<>
      <dl className="facts"><div><dt>Contacto</dt><dd>{str(object(row.contact).name,'Sin nombre registrado')}</dd></div>{row.order?<div><dt>Pedido</dt><dd>{amount(object(row.order))} · {stateLabel(object(row.order).status)}</dd></div>:null}<div><dt>Automatización</dt><dd>{object(row.controls).paused?'Pausada':'Sin pausa manual'}</dd></div><div><dt>Atención manual</dt><dd>{object(row.controls).takeover?'Activa':'Inactiva'}</dd></div></dl>
      <ol aria-label="Mensajes" className="chat">{(Array.isArray(row.messages)?row.messages:[]).map(value=>{const entry=object(value);const inbound=entry.direction==='inbound';return <li className={`bubble ${inbound?'from-customer':'from-business'}`} key={String(entry.id)}><span className="bubble-text">{str(entry.text,'Contenido adjunto')}</span><span className="bubble-meta">{inbound?'Cliente':'Negocio'} · {moment(entry.created_at,timezone)}</span></li>;})}</ol>
      {writable&&<fieldset disabled={locked} className="plain"><legend>Atender conversación</legend>
       <Field label="Mensaje" help="El comando se registra primero. El envío depende de los controles vigentes del número y de la conversación."><Textarea value={message} maxLength={4096} rows={3} onChange={e=>setMessage(e.target.value)}/></Field>
       <div><Button disabled={!message.trim()} onClick={()=>command('send_message')}>{operation.mayResend?'Reenviar mensaje con la misma referencia':'Registrar mensaje'}</Button></div>
       <Field label="Motivo de la decisión" help="Obligatorio para pausar, tomar la atención, cerrar o dar de baja."><Textarea value={reason} minLength={3} maxLength={2000} rows={2} onChange={e=>setReason(e.target.value)}/></Field>
       <div className="cluster"><Button variant="secondary" size="sm" disabled={reason.trim().length<3} onClick={()=>control('paused',!object(row.controls).paused)}>{object(row.controls).paused?'Reanudar automatización':'Pausar automatización'}</Button><Button variant="secondary" size="sm" disabled={reason.trim().length<3} onClick={()=>control('takeover',!object(row.controls).takeover)}>{object(row.controls).takeover?'Devolver a automatización':'Tomar atención manual'}</Button><Button variant="secondary" size="sm" disabled={reason.trim().length<3} onClick={()=>command('close_conversation')}>Solicitar cierre</Button><Button variant="ghost" size="sm" disabled={reason.trim().length<3} onClick={()=>command('opt_out')}>Registrar baja del contacto</Button></div>
      </fieldset>}
     </>:<>
      <dl className="facts"><div><dt>Importe</dt><dd>{amount(row)}</dd></div><div><dt>Conversación</dt><dd>{str(row.conversation_id)}</dd></div></dl>
      <div><a href="/sales/payments" className="btn" data-variant="secondary">Consultar registro de pagos</a></div>
     </>}
     {!writable&&<p className="muted text-sm">{role==='viewer'?'Tu rol permite consultar estos registros.':'Este perfil no permite registrar decisiones mientras esté suspendido.'}</p>}{formError&&<Alert tone="error">{formError}</Alert>}
    </Card>}
   </section>
  </div>
 </>;
}
