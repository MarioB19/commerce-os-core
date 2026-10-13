import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import type {ProfileFence} from '../lib/profile-request.js';
import {variantRequest,newOperationKey,errorText} from '../lib/variants.js';
import {Button} from './ui/button.js';

/** V7 F6 «Probar número» (RF-19.a/b/e/k/l/m/n): talk to a number as a customer
 * would, with the configuration captured when the test starts. Each action is
 * applied by the laboratory worker; the page follows it until it settles.
 * Nothing reaches WhatsApp, sales, payments or the number's quota. */
interface Estimate {mode:'CHAT'|'AUTOMATIC';maximum_microusd:number;maximum_ai_calls:number;valid_until:string;captured_at:string;note:string;
 variants:{variant_id:string;name:string;provider:string;model:string;cases:number;maximum_microusd:number}[]}
interface Entry {at:string;from:'customer'|'business';kind:string;text:string|null;material:string|null;status:string|null;purpose:string|null;material_id?:string|null;mime?:string|null;attachment_id?:string|null;receipt_id?:string|null;explanation?:string|null}
interface View {run:{run_id:string;account_id:string;state:string;state_label:string;version:number;virtual_now:string;created_at:string;expires_at:string};
 captured:{captured_at:string;estimate:{maximum_microusd:number;maximum_ai_calls:number}}|null;
 variants:{variant_id:string;name:string;revision:number;amount_minor:number;currency:string}[];selected_variant_id:string|null;
 operations:{operation_id:string;state:string;state_label:string;created_at:string;action:{type:string;hours?:number;text?:string};result:{state:string|null;reason:string|null;reason_label:string|null}|null}[];
 pending:boolean;conversation:{transcript:Entry[];timers:{due_at:string;purpose:string|null}[];waiting_for:string|null;next_step:{action:string;label:string}};
 isolation:{label:string}}
interface NumberRow {account_id:string;name:string;masked:string|null;sells:{variant_id:string|null;variant:string;product:string}[]}

const usd=(micro:number)=>new Intl.NumberFormat('es-MX',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:4}).format(micro/1_000_000);
const clock=(iso:string,timezone:string)=>{try{return new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short',timeZone:timezone}).format(new Date(iso));}catch{return iso;}};
const purposeLabels:Record<string,string>={remarketing:'Seguimiento',collection:'Cobro',seller_reply:'Vendedor IA',fulfillment:'Entrega',commercial:'Mensaje del flujo'};
const actionLabel=(a:View['operations'][number]['action'])=>a.type==='message'?'Mensaje del cliente':a.type==='advance'?`Reloj +${a.hours} h`:a.type==='continue'?'Continuar':a.type==='select_variant'?'Elegir variante':a.type==='receipt'?'Comprobante del cliente':a.type==='review_receipt'?'Revisión del comprobante':a.type;
const receiptLabels:Record<string,string>={APPROVED:'Aprobado',REJECTED:'Rechazado',HUMAN_REVIEW:'En revisión'};
const ATTACHMENT_TYPES=['image/png','image/jpeg','image/webp','application/pdf'];

/** RF-19.c: a file the business sent, previewed inside the chat as the customer
 * would see it. Read privately with the profile fence and kept only in memory. */
function LabMaterial({runId,entry,selection}:{runId:string;entry:Entry;selection:ProfileFence}){
 const path=entry.attachment_id?`attachments/${entry.attachment_id}`:`materials/${entry.material_id}`;
 const [url,setUrl]=useState<string|null>(null),[failed,setFailed]=useState(false),[open,setOpen]=useState(!/^(?:video|application)\//.test(entry.mime??''));
 useEffect(()=>{if(!open||!(entry.material_id||entry.attachment_id))return;const c=new AbortController();let made:string|null=null;setFailed(false);
  fetch(`/v2/number-tests/${runId}/${path}?environment=REAL`,{credentials:'include',cache:'no-store',redirect:'error',signal:c.signal,headers:{'X-Commerce-Profile-Id':selection.workspaceId,'X-Commerce-Profile-Version':String(selection.version)}})
   .then(async r=>{if(!r.ok)throw Error('file');made=URL.createObjectURL(await r.blob());setUrl(made);}).catch(()=>{if(!c.signal.aborted)setFailed(true);});
  return()=>{c.abort();if(made)URL.revokeObjectURL(made);setUrl(null);};
 },[open,runId,path,entry.material_id,entry.attachment_id,selection.workspaceId,selection.version]);
 const name=entry.material??'Material',mime=entry.mime??'';
 if(!open)return <button type="button" className="number-test-material" onClick={()=>setOpen(true)}>📎 {name} · Ver</button>;
 if(failed)return <span className="number-test-material">📎 {name} (no se pudo abrir; si cambió el material, reinicia la prueba)</span>;
 if(!url)return <span className="number-test-material" role="status">📎 {name}…</span>;
 if(mime.startsWith('image/'))return <img className="number-test-media" src={url} alt={name}/>;
 if(mime.startsWith('audio/'))return <audio className="number-test-media" controls src={url} aria-label={name}/>;
 if(mime.startsWith('video/'))return <video className="number-test-media" controls src={url} aria-label={name}/>;
 return <a className="number-test-material" href={url} target="_blank" rel="noreferrer">📎 {name} · Abrir PDF</a>;
}

export function NumberTest({accountId,selection,role,state,timezone}:{accountId:string;selection:ProfileFence;role:ProfileRole;state:ProfileState;timezone:string}){
 const canRun=role!=='viewer'&&state==='ACTIVE';
 const [number,setNumber]=useState<NumberRow|null>(null),[view,setView]=useState<View|null>(null),[estimate,setEstimate]=useState<Estimate|null>(null);
 const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[text,setText]=useState(''),[fresh,setFresh]=useState(false);
 const log=useRef<HTMLOListElement>(null),input=useRef<HTMLInputElement>(null);
 const readRun=useCallback(async(runId:string,signal?:AbortSignal)=>{const v=await variantRequest<View>(selection,'GET',`/v2/number-tests/${runId}`,undefined,undefined,signal);setView(v);return v;},[selection]);
 useEffect(()=>{const c=new AbortController();
  (async()=>{try{
   const numbers=await variantRequest<NumberRow[]>(selection,'GET','/v2/number-variants',undefined,undefined,c.signal);setNumber(numbers.find(n=>n.account_id===accountId)??null);
   const latest=await variantRequest<View|null>(selection,'GET',`/v2/number-tests/latest?account_id=${accountId}`,undefined,undefined,c.signal);setView(latest);
  }catch(e){if(!c.signal.aborted)setError(errorText(e,'No se pudo abrir la prueba.'));}finally{if(!c.signal.aborted)setLoaded(true);}})();
  return()=>c.abort();},[accountId,selection]);
 // Follow a queued action until the worker settles it.
 useEffect(()=>{if(!view?.pending)return;const c=new AbortController();const t=setInterval(()=>{void readRun(view.run.run_id,c.signal).catch(()=>undefined);},1000);return()=>{c.abort();clearInterval(t);};},[view?.pending,view?.run.run_id,readRun]);
 useEffect(()=>{log.current?.lastElementChild?.scrollIntoView({block:'nearest'});},[view?.conversation.transcript.length]);
 async function estimateNow(){setBusy(true);setError('');try{setEstimate(await variantRequest<Estimate>(selection,'POST','/v2/number-tests/estimate',{account_id:accountId,mode:'CHAT'}));}catch(e){setError(errorText(e,'No se pudo estimar la prueba.'));}finally{setBusy(false);}}
 async function start(){if(!estimate)return;setBusy(true);setError('');
  try{const run=await variantRequest<{run_id:string}>(selection,'POST','/v2/number-tests',{account_id:accountId,mode:'CHAT',accepted_maximum_microusd:estimate.maximum_microusd},newOperationKey());
   setEstimate(null);setFresh(false);await readRun(run.run_id);input.current?.focus();}
  catch(e){setError(errorText(e,'No se pudo iniciar la prueba.'));}finally{setBusy(false);}}
 async function act(action:Record<string,unknown>){if(!view)return;setBusy(true);setError('');
  try{await variantRequest(selection,'POST',`/v2/number-tests/${view.run.run_id}/actions`,{expected_version:view.run.version,action},newOperationKey());await readRun(view.run.run_id);}
  catch(e){setError(errorText(e,'No se pudo aplicar la acción.'));await readRun(view.run.run_id).catch(()=>undefined);}finally{setBusy(false);}}
 // RF-19.d: the customer sends a receipt (image or PDF ≤4 MB), as on WhatsApp.
 async function attach(file:File){if(!view)return;
  if(!ATTACHMENT_TYPES.includes(file.type)){setError('Adjunta una imagen (PNG, JPG o WEBP) o un PDF.');return;}
  if(file.size>4*1024*1024){setError('El comprobante debe pesar máximo 4 MB.');return;}
  setBusy(true);setError('');
  try{const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
   const saved=await variantRequest<{attachment_id:string}>(selection,'POST',`/v2/number-tests/${view.run.run_id}/attachments`,{mime_type:file.type,base64:btoa(binary)},newOperationKey());
   setBusy(false);await act({type:'receipt',attachment_id:saved.attachment_id});}
  catch(e){setError(errorText(e,'No se pudo adjuntar el comprobante.'));setBusy(false);}}
 async function send(e:FormEvent){e.preventDefault();const value=text.trim();if(!value)return;await act({type:'message',text:value});setText('');input.current?.focus();}
 const title=number?`${number.name}${number.masked?` · ${number.masked}`:''}`:'Número';
 const blocked=!canRun||busy||!!view?.pending||['COMPLETED','STOPPED'].includes(view?.run.state??'');
 const next=view?.conversation.next_step,multiple=(view?.variants.length??0)>1&&(!view?.selected_variant_id||next?.action==='select');
 return <section className="number-test" aria-labelledby="number-test-title">
  <p><a href="/numbers">← Números</a></p>
  <div className="variant-heading"><h1 id="number-test-title">Probar {title}</h1>{view&&!fresh&&<span className="number-status variant-state-ok">{view.run.state_label}</span>}</div>
  <p className="number-test-isolation" role="note">Prueba aislada: no envía mensajes reales, no registra ventas ni pagos y no consume la cuota del número. Funciona aunque el número esté desconectado.</p>
  {error&&<p role="alert">{error}</p>}
  {!loaded&&<p role="status">Abriendo la prueba…</p>}
  {loaded&&(!view||fresh)&&<section className="number-test-start" aria-label="Nueva prueba">
   <h2>{view?'Nueva prueba con la configuración actual':'Empieza una prueba'}</h2>
   {number&&<p>Este número vende: {number.sells.length?number.sells.map(s=>`${s.product} · ${s.variant}`).join(' — '):'ninguna variante (asígnale una para probarlo)'}.</p>}
   {!estimate?<Button disabled={!canRun||busy} onClick={()=>void estimateNow()}>{busy?'Estimando…':'Ver costo y empezar'}</Button>:<>
    <p><strong>Costo máximo de IA: {usd(estimate.maximum_microusd)}</strong> ({estimate.maximum_ai_calls} respuestas como máximo).</p>
    <p className="variant-hint">{estimate.note}</p>
    <ul className="number-test-variants">{estimate.variants.map(v=><li key={v.variant_id}>{v.name}: {v.provider} · {v.model}, hasta {usd(v.maximum_microusd)}</li>)}</ul>
    <div className="profile-number-actions"><Button disabled={busy} onClick={()=>void start()}>{busy?'Iniciando…':'Aceptar y empezar'}</Button><Button variant="secondary" disabled={busy} onClick={()=>setEstimate(null)}>Cancelar</Button></div>
   </>}
   {view&&<p><button type="button" className="link-button" onClick={()=>{setFresh(false);setEstimate(null);}}>Volver a la última prueba</button></p>}
  </section>}
  {view&&!fresh&&<>
   <p className="variant-hint">Configuración fijada: {clock(view.captured?.captured_at??view.run.created_at,timezone)} · Reloj de la prueba: {clock(view.run.virtual_now,timezone)}<br/>Si cambias la variante, pulsa Reiniciar para probar lo actual.</p>
   <ol ref={log} className="number-test-chat" aria-label="Conversación de prueba" aria-live="polite">
    {view.conversation.transcript.length===0&&<li className="number-test-empty">Escribe como si fueras un cliente.</li>}
    {view.conversation.transcript.map((m,i)=><li key={i} className={`number-test-bubble from-${m.from}`}>
     {m.from==='business'&&m.purpose&&<span className="number-test-tag">{purposeLabels[m.purpose]??m.purpose}</span>}
     {m.text&&<span className="number-test-text">{m.text}</span>}
     {(m.material_id||m.attachment_id)&&m.mime?<LabMaterial runId={view.run.run_id} entry={m} selection={selection}/>:m.material&&<span className="number-test-material">📎 {m.material}</span>}
     {m.kind==='receipt'&&<span className="number-test-receipt"><strong>{receiptLabels[m.status??'']??m.status}</strong>{m.explanation&&<> · {m.explanation}</>}</span>}
     {m.kind==='receipt'&&m.status==='HUMAN_REVIEW'&&m.receipt_id&&canRun&&<span className="number-test-review" role="group" aria-label="Decidir el comprobante">
      <Button variant="secondary" disabled={blocked} onClick={()=>void act({type:'review_receipt',receipt_id:m.receipt_id,decision:'APPROVED',reason:'Aprobado en la prueba'})}>Aprobar</Button>
      <Button variant="secondary" disabled={blocked} onClick={()=>void act({type:'review_receipt',receipt_id:m.receipt_id,decision:'REJECTED',reason:'Rechazado en la prueba'})}>Rechazar</Button></span>}
     <span className="number-test-meta">{m.from==='customer'?'Cliente':'Negocio'}</span>
    </li>)}
   </ol>
   {view.pending?<p role="status">El negocio está respondiendo…</p>:next&&<p role="status" className="number-test-next">{next.label}</p>}
   {view.conversation.timers.length>0&&<p className="variant-hint">Programado: {view.conversation.timers.map(t=>`${t.purpose==='remarketing'||!t.purpose?'seguimiento':t.purpose} el ${clock(t.due_at,timezone)}`).join(' · ')}. Adelanta el reloj para verlo.</p>}
   {multiple&&<div className="number-test-select" role="group" aria-label="¿Qué le interesa al cliente?">
    <span>El número vende varias variantes. ¿Por cuál llega el cliente? (como si viniera de su anuncio)</span>
    {view.variants.map(v=><Button key={v.variant_id} variant="secondary" disabled={blocked} onClick={()=>void act({type:'select_variant',variant_id:v.variant_id,origin:'ADVERTISEMENT'})}>{v.name}</Button>)}
   </div>}
   <form className="number-test-composer" onSubmit={e=>void send(e)}>
    <label className="sr-only" htmlFor="number-test-input">Mensaje del cliente</label>
    <input id="number-test-input" ref={input} value={text} maxLength={4096} disabled={blocked} placeholder="Escribe como cliente…" onChange={e=>setText(e.target.value)} autoComplete="off"/>
    <Button type="submit" disabled={blocked||!text.trim()}>Enviar</Button>
    <label className="number-test-attach">📎<span className="sr-only">Adjuntar comprobante</span>
     <input type="file" accept={ATTACHMENT_TYPES.join(',')} disabled={blocked} onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void attach(f);}}/></label>
   </form>
   <div className="number-test-tools" role="group" aria-label="Controles de la prueba">
    {next?.action==='continue'&&<Button disabled={blocked} onClick={()=>void act({type:'continue'})}>Continuar</Button>}
    {[2,8,24].map(h=><Button key={h} variant="secondary" disabled={blocked||view.conversation.transcript.length===0} onClick={()=>void act({type:'advance',hours:h})}>Adelantar {h} h</Button>)}
    <Button variant="secondary" disabled={!canRun||busy} onClick={()=>{setFresh(true);setEstimate(null);}}>Reiniciar</Button>
   </div>
   {view.operations.length>0&&<details className="number-test-history"><summary>Historial de la prueba ({view.operations.length})</summary>
    <ol>{view.operations.map(o=><li key={o.operation_id}>{actionLabel(o.action)} · {o.state_label}{o.result?.reason_label?` — ${o.result.reason_label}`:''}</li>)}</ol>
   </details>}
  </>}
 </section>;
}
