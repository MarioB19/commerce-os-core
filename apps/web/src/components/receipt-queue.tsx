import {SalesNav} from './sales-nav.js';
import {useCallback,useEffect,useRef,useState} from 'react';
import {ReceiptText} from 'lucide-react';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import {variantRequest,newOperationKey,formatMoney,errorText,toMinor,fromMinor} from '../lib/variants.js';
import type {ProfileFence} from '../lib/profile-request.js';
import {Alert,Badge,Button,Card,EmptyState,ErrorState,Field,Input,PageHeader,Segmented,Skeleton,useToast,type Tone} from './ui';
import {useShell} from './app-shell.js';

/** V7 F5 (RF-09.g/h/l, RF-17.g, canvas «Ventas»): the receipt queue. From
 * Inicio, «Revisar comprobantes» opens it with the oldest pending receipt
 * already open; one click approves or rejects it and the next one opens. The
 * file is fetched with the profile fence and shown from memory; nothing is cached. */
type Result='REVIEW'|'APPROVED'|'REJECTED'|'TEST'|'FALSE';
interface Row {id:string;version:number;received_at:string;result:Result;result_label:string;reason:string|null;reason_label:string|null;analysis:string;
 product:string|null;variant:string|null;market:string|null;expected_minor:number|null;currency:string|null;observed_minor:number|null;observed_currency:string|null;
 number:string|null;number_masked:string|null;contact_masked:string|null;conversation_id:string|null;has_document:boolean;mime_type:string|null;decision_pending:boolean;decided_by_person:boolean;automatic_policy:boolean}
interface Detail extends Row {checks:{rule:string;label:string;state:string;state_label:string;reason:string|null}[];extraction:{bank:string|null;destination_suffix:string|null;reference:string|null;status:string|null};
 review:{at:string|null;reason:string|null}|null;duplicate:boolean;last_decision:{status:string;failure:string|null;failure_label:string|null}|null}
interface Page {rows:Row[];total:number;pending:number;view:'pending'|'all'}
const tone:Record<Result,Tone>={REVIEW:'warn',APPROVED:'success',REJECTED:'error',TEST:'neutral',FALSE:'error'};
const checkTone=(state:string):Tone=>state==='PASSED'?'success':state==='FAILED'?'error':state==='UNKNOWN'?'warn':'neutral';
const money=(minor:number|null,currency:string|null)=>minor===null||!currency?'Sin dato':formatMoney(minor,currency);
const when=(iso:string,timezone:string)=>{try{return new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short',timeZone:timezone}).format(new Date(iso));}catch{return iso;}};
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

export function ReceiptQueue({selection,role,state,timezone}:{selection:ProfileFence;role:ProfileRole;state:ProfileState;timezone:string}){
 const canDecide=role!=='viewer'&&state==='ACTIVE';
 const toast=useToast(),{refreshCounters}=useShell();
 const [view,setView]=useState<'pending'|'all'>('pending'),[page,setPage]=useState<Page|null>(null),[selected,setSelected]=useState<string|null>(()=>{try{return new URLSearchParams(location.search).get('receipt');}catch{return null;}});
 const [detail,setDetail]=useState<Detail|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[file,setFile]=useState<{url:string;pdf:boolean}|null>(null),[tick,setTick]=useState(0);
 const fileUrl=useRef<string|null>(null),[amount,setAmount]=useState('');
 const load=useCallback(async(signal?:AbortSignal)=>{try{const p=await variantRequest<Page>(selection,'GET',`/v2/receipts?view=${view}`,undefined,undefined,signal);setPage(p);setError('');
   // Open the oldest pending receipt so the first decision is one click away.
   setSelected(current=>current&&(p.rows.some(r=>r.id===current)||view==='all')?current:p.rows.find(r=>r.result==='REVIEW')?.id??p.rows[0]?.id??null);}
  catch(e){if(!signal?.aborted)setError(errorText(e,'No se pudo consultar la cola de comprobantes.'));}},[selection,view]);
 useEffect(()=>{const c=new AbortController();void load(c.signal);return()=>c.abort();},[load,tick]);
 const readDetail=useCallback(async(id:string,signal?:AbortSignal)=>{const d=await variantRequest<Detail>(selection,'GET',`/v2/receipts/${id}`,undefined,undefined,signal);setDetail(d);return d;},[selection]);
 // The amount to record defaults to what was read, else the price; the person can correct it.
 useEffect(()=>{if(detail?.currency)setAmount(fromMinor(detail.observed_minor??detail.expected_minor??0,detail.currency));else setAmount('');},[detail?.id,detail?.observed_minor,detail?.expected_minor,detail?.currency]);
 useEffect(()=>{setDetail(null);setNotice('');if(!selected)return;const c=new AbortController();readDetail(selected,c.signal).catch(e=>{if(!c.signal.aborted)setError(errorText(e,'No se pudo abrir el comprobante.'));});return()=>c.abort();},[selected,readDetail]);
 // The private file, read with the profile fence and kept only in memory.
 useEffect(()=>{
  const drop=()=>{if(fileUrl.current){URL.revokeObjectURL(fileUrl.current);fileUrl.current=null;}setFile(null);};
  drop();if(!detail?.has_document)return drop;const c=new AbortController();
  fetch(`/v2/receipts/${detail.id}/document?environment=REAL`,{credentials:'include',cache:'no-store',redirect:'error',signal:c.signal,headers:{'X-Commerce-Profile-Id':selection.workspaceId,'X-Commerce-Profile-Version':String(selection.version)}})
   .then(async r=>{if(!r.ok)throw Error('file');const blob=await r.blob();const url=URL.createObjectURL(blob);fileUrl.current=url;setFile({url,pdf:blob.type==='application/pdf'});}).catch(()=>{if(!c.signal.aborted)setFile(null);});
  return()=>{c.abort();drop();};
 },[detail?.id,detail?.has_document,selection.workspaceId,selection.version]);
 async function decide(decision:'APPROVED'|'REJECTED'){
  if(!detail||!canDecide)return;setError('');setNotice('');
  let paid:number|undefined;
  if(decision==='APPROVED'){const value=detail.currency?toMinor(amount,detail.currency):null;if(value===null||value<=0){setError('Escribe el monto que pagó el cliente.');return;}if(value!==detail.observed_minor)paid=value;}
  setBusy(true);
  try{
   await variantRequest(selection,'POST',`/v2/receipts/${detail.id}/decision`,{decision,expected_version:detail.version,...(paid!==undefined?{amount_minor:paid}:{})},newOperationKey());
   setNotice(decision==='APPROVED'?'Aprobando…':'Rechazando…');
   // The worker applies it; confirm before moving on (never assume).
   let current=detail;for(let i=0;i<12&&(current.decision_pending||current.result==='REVIEW');i++){await wait(800);current=await readDetail(detail.id);}
   if(current.result==='REVIEW'){if(current.last_decision?.failure_label)setError(current.last_decision.failure_label);else setNotice('La decisión se está aplicando. Revisa este comprobante en un momento.');}
   else{const done=decision==='APPROVED'?'Pago aprobado. El cliente recibe lo que compró.':'Comprobante rechazado.';setNotice('');toast({tone:'success',title:done});const next=page?.rows.find(r=>r.result==='REVIEW'&&r.id!==detail.id);await load();refreshCounters();if(next&&view==='pending')setSelected(next.id);}
  }catch(e){setError(errorText(e,'No se pudo registrar la decisión.'));}finally{setBusy(false);}
 }
 return <>
  <PageHeader title="Comprobantes" description="Cada comprobante aprobado entrega el producto y cuenta como venta. Las reglas deciden solas cuando todo cumple; lo demás llega aquí." badge={page?<Badge tone={page.pending?'warn':'success'}>{page.pending?`${page.pending} por revisar`:'Al día'}</Badge>:undefined}/>
  <SalesNav current="receipts"/>
  <div className="toolbar">
   <Segmented label="Mostrar" value={view} onChange={setView} options={[{value:'pending',label:'Por revisar',count:page?.pending},{value:'all',label:'Todos'}]}/>
   <a href="/sales/payments/rules" className="btn" data-variant="ghost" style={{marginLeft:'auto'}}>Reglas de comprobantes</a>
  </div>
  {error&&<Alert tone="error">{error}</Alert>}
  <div className={'layout-1-2 sales-layout'+(selected?' has-selection':'')}>
   <section aria-label="Lista de comprobantes" className="stack-tight">
    {!page&&!error&&<Skeleton lines={5}/>}
    {page&&!page.rows.length&&<EmptyState inline level={3} icon={<ReceiptText aria-hidden="true"/>} title={view==='pending'?'No hay comprobantes por revisar':'Todavía no hay comprobantes'} description={view==='pending'?'Cuando una regla no pueda decidir sola, el comprobante aparecerá aquí.':'Cuando un cliente envíe su pago, aparecerá aquí.'}/>}
    {page&&page.rows.length>0&&<ul className="select-list">{page.rows.map(r=><li key={r.id}><button type="button" aria-pressed={selected===r.id} onClick={()=>setSelected(r.id)}>
     <span className="cluster"><Badge tone={tone[r.result]}>{r.result_label}</Badge><strong className="num">{money(r.expected_minor,r.currency)}</strong></span>
     <span>{[r.product,r.variant].filter(Boolean).join(' · ')||'Producto sin dato'}</span>
     <span className="muted text-sm">{when(r.received_at,timezone)}{r.contact_masked?` · Cliente ${r.contact_masked}`:''}</span>
     {r.reason_label&&<span className="text-sm" style={{color:'var(--warn)'}}>{r.reason_label}</span>}
    </button></li>)}</ul>}
    {error&&!page&&<ErrorState message={error} onRetry={()=>setTick(t=>t+1)}/>}
   </section>
   <section aria-label="Comprobante seleccionado" aria-busy={busy}>
    {!selected&&page?.rows.length?<EmptyState inline level={3} title="Elige un comprobante" description="El detalle y la decisión aparecen aquí."/>:null}
    {selected&&!detail&&<Skeleton lines={6} label="Abriendo comprobante…"/>}
    {detail&&<Card aria-labelledby="receipt-title">
     <div className="card-head"><div><h2 id="receipt-title">{money(detail.expected_minor,detail.currency)} · {[detail.product,detail.variant].filter(Boolean).join(' · ')}</h2><p>{detail.reason_label??''}</p></div><Badge tone={tone[detail.result]}>{detail.result_label}</Badge></div>
     {notice&&<Alert tone="info">{notice}</Alert>}
     {detail.result==='REVIEW'&&detail.last_decision?.failure_label&&!busy&&!error&&<Alert tone="error">{detail.last_decision.failure_label}</Alert>}
     {detail.decision_pending&&!busy&&<Alert tone="info">Hay una decisión aplicándose.</Alert>}
     {canDecide&&detail.result==='REVIEW'&&!detail.decided_by_person&&<div className="receipt-decision">
      <Field label={`Monto pagado${detail.currency?` (${detail.currency})`:''}`} help={detail.observed_minor===null?'No se pudo leer el monto: confirma cuánto pagó el cliente.':detail.observed_minor!==detail.expected_minor?'El monto leído no coincide con el precio; se registra lo que escribas.':'Se registra el monto leído del comprobante.'}><Input inputMode="decimal" value={amount} disabled={busy||detail.decision_pending} onChange={e=>setAmount(e.target.value)}/></Field>
      <div className="cluster"><Button disabled={busy||detail.decision_pending} loading={busy} onClick={()=>void decide('APPROVED')}>Aprobar pago</Button><Button variant="secondary" disabled={busy||detail.decision_pending} onClick={()=>void decide('REJECTED')}>Rechazar</Button></div>
     </div>}
     <div className="receipt-file">{detail.has_document?file?file.pdf?<a href={file.url} target="_blank" rel="noopener noreferrer" className="btn" data-variant="secondary">Abrir PDF del comprobante</a>
      :<img src={file.url} alt="Comprobante enviado por el cliente"/>:<Skeleton block label="Cargando archivo…"/>:<p className="muted">El archivo no está disponible.</p>}</div>
     <dl className="facts">
      <div><dt>Precio</dt><dd>{money(detail.expected_minor,detail.currency)}</dd></div>
      <div><dt>Monto leído</dt><dd>{money(detail.observed_minor,detail.observed_currency)}</dd></div>
      <div><dt>Banco</dt><dd>{detail.extraction.bank??'Sin dato'}</dd></div>
      <div><dt>Cuenta destino</dt><dd>{detail.extraction.destination_suffix?`termina en ${detail.extraction.destination_suffix}`:'Sin dato'}</dd></div>
      <div><dt>Referencia</dt><dd>{detail.extraction.reference??'Sin dato'}</dd></div>
      <div><dt>Recibido</dt><dd>{when(detail.received_at,timezone)}</dd></div>
      <div><dt>Número</dt><dd>{[detail.number,detail.number_masked].filter(Boolean).join(' · ')||'Sin dato'}</dd></div>
      <div><dt>Cliente</dt><dd>{detail.contact_masked??'Sin dato'}</dd></div>
     </dl>
     {detail.checks.length>0&&<details className="disclosure" open={detail.result==='REVIEW'}><summary>Reglas revisadas</summary>
      <div className="disclosure-body">
       <ul className="item-list">{detail.checks.map(c=><li key={c.rule}><span className="item-name">{c.label}</span><Badge tone={checkTone(c.state)}>{c.state_label}</Badge>{c.reason&&<span className="muted text-sm">{c.reason}</span>}</li>)}</ul>
       <p className="muted text-sm">{detail.automatic_policy?'Tus reglas aprueban solas cuando todo cumple.':'Tus reglas piden que una persona apruebe cada pago.'} <a href="/sales/payments/rules">Cambiar reglas</a></p>
      </div></details>}
     {detail.review&&<p className="muted text-sm">Decidido por una persona{detail.review.at?` el ${when(detail.review.at,timezone)}`:''}.{detail.review.reason?` Motivo: ${detail.review.reason}`:''}</p>}
     {detail.conversation_id&&<div><a href={`/sales/inbox?conversation=${detail.conversation_id}`} className="btn" data-variant="ghost">Ver conversación</a></div>}
    </Card>}
   </section>
  </div>
 </>;
}
