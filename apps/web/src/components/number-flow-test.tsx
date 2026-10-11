import {useEffect,useMemo,useState,type FormEvent,type ReactNode} from 'react';
import {FlaskConical,RefreshCw,Send,TimerReset} from 'lucide-react';
import {api,useData} from '../lib/api';
import {AssetPreview} from './asset-preview';
import {Feedback,Badge} from './shared';
import {StateBadge} from './operational-state';
import {Button} from './ui/button';
import {Modal} from './ui/dialog';

type Value=Record<string,any>;
const key=()=>crypto.randomUUID();

export function NumberFlowTest({open,sourceAccountId,alias,onClose}:{open:boolean;sourceAccountId:string|null;alias?:string;onClose:()=>void}){
 const[testId,setTestId]=useState<string|null>(null),[error,setError]=useState<Error|null>(null),[busy,setBusy]=useState(false),[route,setRoute]=useState(''),[message,setMessage]=useState(''),[amountMajor,setAmountMajor]=useState('97.00'),[quantity,setQuantity]=useState(45),[unit,setUnit]=useState(60);
 const latest=useData<Value|null>(`/channel-accounts/${sourceAccountId}/flow-tests/latest?environment=SIMULATION`,open&&!!sourceAccountId&&!testId);
 const state=useData<Value>(`/number-flow-tests/${testId}?environment=SIMULATION`,open&&!!testId,1200);
 const data=state.data;
 useEffect(()=>{if(data?.assignments?.length&&!data.assignments.some((item:Value)=>item.selection_key===route))setRoute(String(data.assignments[0].selection_key));},[data?.assignments,route]);
 useEffect(()=>{if(!open){setTestId(null);setError(null);setBusy(false);setMessage('');setRoute('');}},[open]);
 const disabled=busy||Boolean(data?.pending_action);
 const timeline=useMemo(()=>[...(data?.transcript??[])],[data?.transcript]);
 const reviewReceipt=data?.receipts?.find((receipt:Value)=>receipt.status==='HUMAN_REVIEW');
 const actions=new Set<string>(data?.available_actions??[]),allowed=(action:string)=>!actions.size||actions.has(action);
 const amountMinor=Math.round(Number(amountMajor)*100);
 async function post(path:string,body:Value={}){
  setBusy(true);setError(null);
  try{return await api<Value>(`${path}?environment=SIMULATION`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key()},body:JSON.stringify({...body,environment:'SIMULATION'})});}
  catch(reason){setError(reason as Error);return null;}
  finally{setBusy(false);}
 }
 async function start(){if(!sourceAccountId)return;const result=await post(`/channel-accounts/${sourceAccountId}/flow-tests`,{contact_name:'Contacto de prueba',start_mode:'EMPTY'});if(result?.id){setTestId(String(result.id));setRoute('');}}
 async function act(body:Value){if(!testId)return;const result=await post(`/number-flow-tests/${testId}/actions`,body);if(result)await state.refetch();}
 async function reset(){if(!testId)return;const result=await post(`/number-flow-tests/${testId}/reset`,{contact_name:'Contacto de prueba',start_mode:'EMPTY'});if(result?.id){setTestId(String(result.id));setRoute('');}}
 async function write(event:FormEvent){event.preventDefault();if(!message.trim())return;await act({type:'question',text:message.trim()});setMessage('');}
 return <Modal className="numbers-modal" title={`Probar flujo${alias?` · ${alias}`:''}`} description="Laboratorio aislado: empieza vacío, conserva el orden causal y nunca usa el teléfono ni registra ingresos reales." open={open} onOpenChange={value=>{if(!value)onClose();}} wide>
  <Feedback error={error??latest.error??state.error}/>
  {!testId&&!latest.isLoading&&<div className="lab-entry"><FlaskConical size={28}/><h3>Ensayo completo de este número</h3><p>La prueba nueva abre un chat vacío. Copia rutas, ofertas y materiales vigentes sin sembrar mensajes ni efectos externos.</p><div className="numbers-actions"><Button disabled={busy||!sourceAccountId} onClick={()=>void start()}>{busy?'Preparando…':'Empezar chat vacío'}</Button>{latest.data?.id&&<Button variant="secondary" disabled={busy} onClick={()=>setTestId(String(latest.data!.id))}>Retomar la última prueba</Button>}</div></div>}
  {testId&&<>
   <div className="numbers-notice" role="status"><strong>SIMULATION · sin tráfico real</strong><p>{data?.pending_action?'Procesando la acción anterior…':data?.empty?'Chat vacío: escribe el primer mensaje o selecciona una ruta.':data?.active_route?`Ruta activa: ${data.active_route.product_name}`:'Escribe o elige un producto para probar el routing.'}</p></div>
   {data?.source?.freshness==='STALE'&&<div className="numbers-notice" role="alert"><strong>Prueba desactualizada</strong><p>La configuración del número cambió desde esta copia. Reinicia antes de usar sus resultados.</p></div>}
   {!data&&<p role="status">Preparando el laboratorio…</p>}
   {data&&<>
    <section><h3>Ruta del ensayo</h3><FormLabel label="Producto a ensayar"><select value={route} onChange={event=>setRoute(event.target.value)} disabled={disabled}><option value="">Selecciona una ruta…</option>{data.assignments?.map((item:Value)=><option key={item.selection_key} value={item.selection_key}>{item.product_name} · {item.offer_name}</option>)}</select></FormLabel><Button variant="secondary" disabled={disabled||!route||!allowed('select_product')} onClick={()=>void act({type:'select_product',selection_key:route})}>Probar esta selección</Button><details><summary>Rutas y reglas copiadas</summary><ul>{data.assignments?.map((item:Value)=><li key={item.selection_key}><strong>{item.product_name}</strong> · {item.workflow_name} · {item.seller_name}<br/><small>{item.entry_rules?.length?item.entry_rules.map((rule:Value)=>`${rule.kind}: ${rule.value}`).join(' · '):'Sin palabra clave; la selección del panel sólo fija la ruta del laboratorio.'}</small></li>)}</ul></details></section>
    <section className="ux-chat" aria-labelledby="test-chat-title"><h3 id="test-chat-title">Chat de prueba</h3><div className="ux-chat-thread" aria-live="polite">{timeline.length?<ol>{timeline.map((item:Value)=><li key={item.id} className={item.direction==='INBOUND'?'ux-chat-inbound':'ux-chat-outbound'}><div><Badge>{item.direction==='INBOUND'?'Cliente':'Sistema'}</Badge><StateBadge value={item.status}/></div>{item.text&&<p>{item.text}</p>}{item.asset_id&&<AssetPreview assetId={String(item.asset_id)} environment="SIMULATION" inline/>}{!item.text&&!item.asset_id&&<p>[{item.kind??'evento'}]</p>}<small>{item.name??item.mime_type??item.kind??'Mensaje'}{item.at?` · ${new Date(item.at).toLocaleString('es-MX')}`:''}</small><details><summary>Estado técnico</summary><code>{item.status??'UNKNOWN'}</code>{item.dispatch_sequence!=null&&<span> · secuencia {item.dispatch_sequence}</span>}{item.technical?.effect_id&&<span> · efecto {item.technical.effect_id}</span>}</details></li>)}</ol>:<p className="ux-chat-empty">Aún no hay mensajes. Esta prueba empezó vacía.</p>}</div>
     <form onSubmit={event=>void write(event)}><FormLabel label="Escribe como cliente"><textarea value={message} onChange={event=>setMessage(event.target.value)} maxLength={4096} placeholder="Haz una pregunta o escribe la palabra clave del producto"/></FormLabel><Button type="submit" disabled={disabled||!message.trim()||!allowed('question')}><Send size={16}/>Enviar mensaje</Button></form>
     <div className="ux-chat-actions" aria-label="Acciones disponibles en el chat"><h4>Siguiente acción</h4>{actions.has('continue')&&<Button onClick={()=>void act({type:'continue'})} disabled={disabled}>Continuar flujo</Button>}<Button variant="secondary" disabled={disabled||!data.active_route||!allowed('accept')} onClick={()=>void act({type:'accept'})}>Aceptar el acuerdo</Button><div className="ux-chat-action-card"><FormLabel label="Monto de prueba (MXN)"><input type="number" inputMode="decimal" min="0.01" step="0.01" value={amountMajor} onChange={event=>setAmountMajor(event.target.value)}/></FormLabel><Button variant="secondary" disabled={disabled||!data.active_route||!Number.isFinite(amountMinor)||amountMinor<1||!allowed('receipt')} onClick={()=>void act({type:'receipt',amount_minor:amountMinor,currency:'MXN'})}>Adjuntar comprobante sintético</Button>{reviewReceipt&&<Button variant="secondary" disabled={disabled||!allowed('approve_receipt')} onClick={()=>void act({type:'approve_receipt'})}>Aprobar comprobante de prueba</Button>}</div><div className="ux-chat-action-card"><div className="numbers-split"><FormLabel label="Avanzar"><input type="number" min={1} value={quantity} onChange={event=>setQuantity(Number(event.target.value))}/></FormLabel><FormLabel label="Unidad"><select value={unit} onChange={event=>setUnit(Number(event.target.value))}><option value={60}>Minutos</option><option value={3600}>Horas</option><option value={86400}>Días</option></select></FormLabel></div><Button variant="secondary" disabled={disabled||quantity<1||quantity*unit>604800||!allowed('advance')} onClick={()=>void act({type:'advance',seconds:quantity*unit})}>Avanzar tiempo</Button><Button variant="secondary" disabled={disabled||!data.next_reminder||!allowed('next_reminder')} onClick={()=>void act({type:'next_reminder'})}>Ir al siguiente recordatorio</Button></div></div>
    </section>
    <section><h3>Resultado del laboratorio</h3><p>{data.orders?.length??0} pedidos ficticios · {data.receipts?.length??0} comprobantes ficticios · {data.timers?.filter((timer:Value)=>timer.status==='PENDING').length??0} recordatorios pendientes.</p>{data.orders?.map((order:Value)=><p key={order.id}>Pedido: {order.status} · {order.amount_minor/100} {order.currency}{order.sale_status?` · venta ${order.sale_status}${order.sale_amount_minor?` por ${order.sale_amount_minor/100} ${order.sale_currency}`:''}`:''}</p>)}{data.fulfillments?.map((item:Value)=><p key={item.id}>Entrega {item.release_on}: {item.status}</p>)}<p><strong>Efectos externos: ninguno.</strong> Banco ficticio y accesos LAB-ONLY.</p></section>
    <div className="form-footer"><Button variant="secondary" disabled={disabled} onClick={()=>void state.refetch()}><RefreshCw size={16}/>Actualizar</Button><Button variant="secondary" disabled={disabled} onClick={()=>void reset()}><TimerReset size={16}/>Reiniciar vacía</Button><Button onClick={onClose}>Cerrar</Button></div>
   </>}
  </>}
 </Modal>;
}

function FormLabel({label,children}:{label:string;children:ReactNode}){return <label className="field"><span>{label}</span>{children}</label>;}
