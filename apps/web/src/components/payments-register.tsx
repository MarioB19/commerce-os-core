import {useEffect,useMemo,useRef,useState} from 'react';
import {sessionPayments,type PaymentsClient} from '../../../../packages/commerce-client/src/payments.js';
import {paymentFilterSchema,paymentStatuses,paymentLabels,type PaymentFilters,type PaymentRegister} from '../../../../packages/contracts/src/payments-register.js';
import {moneyText,profileToday} from '../lib/results.js';
type Props={selection:{workspaceId:string|null;version:number};environment:'REAL'|'SIMULATION';timezone:string;role:'owner'|'operator'|'reconciler'|'viewer';onReceipt?:(id:string)=>void};
const methods={BANK_TRANSFER:'Transferencia',LINK:'Enlace de pago',UNKNOWN:'Sin dato'};
/** Prepared view. Remounting at the entire authority boundary discards pending
 * responses and RAM-only downloads, including A→B→A profile changes. */
export function PaymentsRegister(props:Props){if(!props.selection.workspaceId||props.selection.version<1)return <p>Elige un perfil para consultar pagos.</p>;
 return <PaymentView key={JSON.stringify([props.selection,props.environment,props.timezone,props.role])} {...props}/>;
}
function PaymentView({selection,environment,timezone,role,onReceipt}:Props){
 const client=useMemo(()=>sessionPayments(selection),[selection.workspaceId,selection.version]);
 const [filters,setFilters]=useState<PaymentFilters>(()=>{const to=profileToday(timezone);return paymentFilterSchema.parse({environment,from:to.slice(0,8)+'01',to});});
 const [data,setData]=useState<PaymentRegister>(),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[download,setDownload]=useState<{url:string;format:'csv'|'xlsx'}>();
 const sequence=useRef(0),active=useRef(true),pending=useRef<AbortController|null>(null),downloadUrl=useRef<string|null>(null);
 function clearDownload(){if(downloadUrl.current)URL.revokeObjectURL(downloadUrl.current);downloadUrl.current=null;setDownload(undefined);}
 async function read(q=filters,offset=0){const serial=++sequence.current;pending.current?.abort();const controller=new AbortController();pending.current=controller;setBusy(true);setData(undefined);setMessage('');clearDownload();
  try{const result=await client({operation:'list',query:{...q,limit:25,offset}},controller.signal);if(active.current&&serial===sequence.current&&result.operation==='list')setData(result.data);}
  catch{if(active.current&&serial===sequence.current)setMessage('No se pudo confirmar la consulta. Revisa tu acceso y vuelve a consultar.');}
  finally{if(active.current&&serial===sequence.current)setBusy(false);}
 }
 useEffect(()=>{active.current=true;void read();return()=>{active.current=false;++sequence.current;pending.current?.abort();if(downloadUrl.current)URL.revokeObjectURL(downloadUrl.current);};},[]);
 function change(patch:Partial<PaymentFilters>){++sequence.current;pending.current?.abort();setBusy(false);clearDownload();setFilters(v=>({...v,...patch}));}
 const dirty=!!data&&JSON.stringify(data.filters)!==JSON.stringify(paymentFilterSchema.safeParse(filters).data),exportable=role==='owner'&&!!data&&!busy&&!dirty;
 async function exportFile(format:'csv'|'xlsx'){if(!exportable||!data)return;const serial=++sequence.current,controller=new AbortController();pending.current?.abort();pending.current=controller;setBusy(true);setMessage('');clearDownload();
  try{const result=await client({operation:'export',query:{...data.filters,format}},controller.signal);if(active.current&&serial===sequence.current&&result.operation==='export'){const bytes=new Uint8Array(result.bytes),url=URL.createObjectURL(new Blob([bytes],{type:result.mime}));downloadUrl.current=url;setDownload({url,format});}}
  catch{if(active.current&&serial===sequence.current)setMessage('La exportación no está confirmada. No se descargó un archivo parcial; puedes solicitarla de nuevo.');}
  finally{if(active.current&&serial===sequence.current)setBusy(false);}
 }
 return <section aria-label="Registro de pagos" className="grid gap-4"><h1>Pagos</h1><p>Comprobantes e ingresos reconocidos, separados por moneda. Periodo según {timezone}.</p>
 <form onSubmit={e=>{e.preventDefault();const q=paymentFilterSchema.safeParse(filters);if(!q.success){setMessage('Revisa las fechas y los filtros. El periodo máximo es de 367 días.');return;}void read(q.data);}} className="card grid gap-3">
 <label>Desde<input type="date" required value={filters.from} onChange={e=>change({from:e.target.value})}/></label><label>Hasta<input type="date" required value={filters.to} onChange={e=>change({to:e.target.value})}/></label>
 <label>Estado<select aria-label="Estado" value={filters.status??''} onChange={e=>change({status:e.target.value as PaymentFilters['status']||undefined})}><option value="">Todos</option>{paymentStatuses.map(v=><option key={v} value={v}>{paymentLabels[v]}</option>)}</select></label>
 <label>Moneda<select aria-label="Moneda" value={filters.currency??''} onChange={e=>change({currency:e.target.value||undefined})}><option value="">Todas por separado</option>{Intl.supportedValuesOf('currency').map(v=><option key={v}>{v}</option>)}</select></label>
 {(['family','variant','market','account','campaign','ad']as const).map(kind=>{const key=({family:'familyId',variant:'variantId',market:'market',account:'accountId',campaign:'campaignId',ad:'adId'}as const)[kind];return <PaymentChoice key={kind} client={client} kind={kind} filters={filters} value={filters[key]??''} onChange={value=>change({...{[key]:value||undefined},...(kind==='family'?{variantId:undefined}:{})})}/>;})}
 <label>Buscar producto, referencia o últimos dígitos<input maxLength={160} value={filters.q??''} onChange={e=>change({q:e.target.value||undefined})}/></label>
 <label>Ordenar por<select aria-label="Ordenar por" value={filters.sort} onChange={e=>change({sort:e.target.value as PaymentFilters['sort']})}><option value="date">Fecha</option><option value="amount">Importe</option><option value="status">Estado</option></select></label>
 <label>Orden<select aria-label="Orden" value={filters.direction} onChange={e=>change({direction:e.target.value as PaymentFilters['direction']})}><option value="desc">Descendente</option><option value="asc">Ascendente</option></select></label><button disabled={busy}>Consultar pagos</button></form>
 {busy&&<p role="status">Consultando…</p>}{message&&<p role="alert">{message}</p>}{dirty&&<p role="status">Aplica los filtros para actualizar la lista y exportar.</p>}
 {data&&<><h2>Pagos de {data.filters.from} a {data.filters.to}</h2><p>{data.total} comprobantes · consulta {new Date(data.observedAt).toLocaleString('es-MX',{timeZone:timezone})}.</p>
 <ul aria-label="Totales por moneda">{data.totals.map(t=><li key={t.currency}>{moneyText(t.approvedRevenueMinor,t.currency)} reconocidos · {t.approvedPayments} pagos</li>)}</ul>
 <div><button disabled={!exportable} onClick={()=>void exportFile('csv')}>Exportar CSV</button> <button disabled={!exportable} onClick={()=>void exportFile('xlsx')}>Exportar Excel</button>{role!=='owner'&&<p>La exportación requiere permiso de propietario.</p>}{download&&<p><a href={download.url} download={'payments.'+download.format}>Descargar {download.format==='xlsx'?'Excel':'CSV'}</a></p>}</div>
 {data.rows.length===0?<p>No hay comprobantes para esta consulta.</p>:<div className="overflow-auto"><table><caption>Registro de comprobantes del perfil</caption><thead><tr>{['Fecha','Producto','Variante / mercado','Importe','Método','Estado','Número','Campaña / anuncio','Contacto','Acciones'].map(v=><th key={v}>{v}</th>)}</tr></thead><tbody>{data.rows.map(row=><tr key={row.receiptId}>
 <td>{new Date(row.occurredAt).toLocaleString('es-MX',{timeZone:timezone})}</td><td>{row.familyName??'Sin dato'}</td><td>{row.variantId?`${row.market??'Sin mercado'} · ${row.variantId.slice(0,8)}`:'Sin variante registrada'}</td><td>{row.amountMinor!==null&&row.currency?moneyText(row.amountMinor,row.currency):'Sin dato'}</td><td>{methods[row.method]}</td><td>{paymentLabels[row.status]}{row.duplicate?' · Posible duplicado':''}</td><td>{row.accountMasked??'Sin dato'}</td><td>{row.campaignId??'Sin dato'} / {row.adId??'Sin dato'}</td><td>{row.contactMasked??'Sin dato'}</td>
 <td>{onReceipt&&<><button onClick={()=>onReceipt(row.receiptId)}>Revisar comprobante</button>{row.conversationId&&<a href={'/sales/inbox?conversation='+row.conversationId}>Abrir conversación</a>}</>}</td></tr>)}</tbody></table></div>}
 <button disabled={busy||dirty||data.offset===0} onClick={()=>void read(data.filters,Math.max(0,data.offset-data.limit))}>Página anterior</button><button disabled={busy||dirty||data.offset+data.limit>=data.total||data.offset>=10000} onClick={()=>void read(data.filters,data.offset+data.limit)}>Página siguiente</button>
 </>}
 </section>;
}
function PaymentChoice({client,kind,filters,value,onChange}:{client:PaymentsClient;kind:'family'|'variant'|'market'|'account'|'campaign'|'ad';filters:PaymentFilters;value:string;onChange:(value:string)=>void}){
 const label={family:'Producto',variant:'Variante',market:'País o mercado',account:'Número',campaign:'Campaña',ad:'Anuncio'}[kind],signature=JSON.stringify(filters),seq=useRef(0);
 const [state,setState]=useState<{signature:string;rows:{id:string;label:string}[];next:string|null;error?:string}>({signature:'',rows:[],next:null}),controller=useRef<AbortController|null>(null);
 useEffect(()=>{++seq.current;controller.current?.abort();setState({signature,rows:[],next:null});return()=>{++seq.current;controller.current?.abort();};},[signature]);
 async function load(after?:string){const serial=++seq.current;controller.current?.abort();controller.current=new AbortController();try{const r=await client({operation:'options',query:{...filters,kind,limit:25,...(after?{after}:{})}},controller.current.signal);if(seq.current===serial&&r.operation==='options')setState(s=>({signature,rows:after?[...s.rows,...r.data]:r.data,next:r.next}));}catch{if(seq.current===serial)setState({signature,rows:[],next:null,error:'No se pudieron consultar las opciones.'});}}
 const current=state.signature===signature?state:undefined;
 return <div><label>{label}<select aria-label={label} value={value} onChange={e=>onChange(e.target.value)}><option value="">Todos</option>{value&&!current?.rows.some(r=>r.id===value)&&<option value={value}>Selección actual</option>}{current?.rows.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}</select></label><button type="button" onClick={()=>void load()}>Buscar {label.toLowerCase()}</button>{current?.next&&<button type="button" onClick={()=>void load(current.next!)}>Más opciones de {label.toLowerCase()}</button>}{current?.error&&<p role="status">{current.error}</p>}</div>;
}
