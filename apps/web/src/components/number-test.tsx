import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {Clock3,Download,FlaskConical,Paperclip,ReceiptText,RotateCcw,Send} from 'lucide-react';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import type {ProfileFence} from '../lib/profile-request.js';
import {variantRequest,newOperationKey,errorText,formatMoney} from '../lib/variants.js';
import {Alert,Badge,Button,Card,CardHead,Input,PageHeader,Skeleton,useToast,type Tone} from './ui';
import {useBreadcrumbs} from './app-shell.js';

/** V7 F6 «Probar número» (RF-19, canvas «Probar número»): talk to a number as
 * a customer would, with the configuration captured when the test starts.
 * Each action is applied by the laboratory worker; the page follows it until
 * it settles. Nothing reaches WhatsApp, sales, payments or the number's quota. */
interface Estimate {mode:'CHAT'|'AUTOMATIC';maximum_microusd:number;maximum_ai_calls:number;valid_until:string;captured_at:string;note:string;
 variants:{variant_id:string;name:string;provider:string;model:string;cases:number;maximum_microusd:number}[]}
interface Entry {at:string;from:'customer'|'business';kind:string;text:string|null;material:string|null;status:string|null;purpose:string|null;material_id?:string|null;mime?:string|null;attachment_id?:string|null;receipt_id?:string|null;explanation?:string|null;variant_name?:string|null}
interface View {expired?:boolean;run:{run_id:string;account_id:string;state:string;state_label:string;version:number;virtual_now:string;created_at:string;expires_at:string};
 captured:{captured_at:string;estimate:{maximum_microusd:number;maximum_ai_calls:number}}|null;
 variants:{variant_id:string;name:string;revision:number;amount_minor:number;currency:string}[];selected_variant_id:string|null;
 operations:{operation_id:string;state:string;state_label:string;created_at:string;action:{type:string;hours?:number;text?:string};result:{state:string|null;reason:string|null;reason_label:string|null;fix?:Fix|null}|null}[];
 pending:boolean;conversation:{transcript:Entry[];timers:{due_at:string;purpose:string|null}[];waiting_for:string|null;next_step:{action:string;label:string}};
 isolation:{label:string}}
interface Fix {label:string;href:string}
interface Diagnosis {ready:boolean;problems:{code:string;severity:'BLOCKING'|'WARNING';label:string;fix:Fix|null;variant_name:string|null}[]}
interface NumberRow {account_id:string;name:string;masked:string|null;sells:{variant_id:string|null;variant:string;product:string}[]}

const usd=(micro:number)=>new Intl.NumberFormat('es-MX',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:4}).format(micro/1_000_000);
const clock=(iso:string,timezone:string)=>{try{return new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short',timeZone:timezone}).format(new Date(iso));}catch{return iso;}};
const purposeLabels:Record<string,string>={remarketing:'Seguimiento',collection:'Cobro',seller_reply:'IA',fulfillment:'Entrega',commercial:'Flujo'};
const purposeTone:Record<string,Tone>={remarketing:'warn',collection:'info',seller_reply:'accent',fulfillment:'success',commercial:'neutral'};
const actionLabel=(a:View['operations'][number]['action'])=>a.type==='message'?'Mensaje del cliente':a.type==='advance'?`Reloj +${a.hours} h`:a.type==='continue'?'Continuar':a.type==='select_variant'?'Elegir variante':a.type==='receipt'?'Comprobante del cliente':a.type==='review_receipt'?'Revisión del comprobante':a.type;
const receiptLabels:Record<string,string>={APPROVED:'Aprobado',REJECTED:'Rechazado',HUMAN_REVIEW:'En revisión'};
const receiptTone:Record<string,Tone>={APPROVED:'success',REJECTED:'error',HUMAN_REVIEW:'warn'};
const ATTACHMENT_TYPES=['image/png','image/jpeg','image/webp','application/pdf'];
const journey=[['greeting','Saludo'],['offer','Oferta'],['agreement','Acuerdo'],['collection','Cobro'],['receipt','Comprobante'],['delivery','Entrega']] as const;

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
 if(!open)return <button type="button" className="link-button" onClick={()=>setOpen(true)}><Paperclip aria-hidden="true" size={14}/> {name} · Ver</button>;
 if(failed)return <span className="muted text-sm"><Paperclip aria-hidden="true" size={14}/> {name} (no se pudo abrir; si cambió el material, reinicia la prueba)</span>;
 if(!url)return <span className="muted text-sm" role="status"><Paperclip aria-hidden="true" size={14}/> {name}…</span>;
 if(mime.startsWith('image/'))return <img className="media-preview" src={url} alt={name}/>;
 if(mime.startsWith('audio/'))return <audio className="media-preview" controls src={url} aria-label={name}/>;
 if(mime.startsWith('video/'))return <video className="media-preview" controls src={url} aria-label={name}/>;
 return <a className="link-button" href={url} target="_blank" rel="noreferrer"><Paperclip aria-hidden="true" size={14}/> {name} · Abrir PDF</a>;
}

/** V7 RF-19.p/h: the automatic buyer. Every variant the number sells is played
 * by a customer who buys and one who stops answering; the report gives one
 * verdict per variant with each step. Estimate first; nothing is sent. */
interface SuiteReport {suite:{suite_id:string;state:string;state_label:string;created_at:string;maximum_microusd:number};
 variants:{variant_id:string;name:string;verdict:string;verdict_label:string;cases:{journey:string;journey_label:string;state:string;state_label:string;checks:{name:string;label:string;state:string;detail:string}[]}[]}[];note:string}
interface SuiteEstimate {maximum_microusd:number;cases:{variant_id:string;name:string;journey:string;maximum_microusd:number}[];note:string}
const checkTone:Record<string,Tone>={PASSED:'success',FAILED:'error',UNKNOWN:'warn',SKIPPED:'neutral'};
function AutomaticSuite({accountId,selection,canRun}:{accountId:string;selection:ProfileFence;canRun:boolean}){
 const [report,setReport]=useState<SuiteReport|null>(null),[estimate,setEstimate]=useState<SuiteEstimate|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{const c=new AbortController();variantRequest<SuiteReport|null>(selection,'GET',`/v2/number-tests/suites/latest?account_id=${accountId}`,undefined,undefined,c.signal).then(setReport).catch(()=>undefined);return()=>c.abort();},[accountId,selection]);
 useEffect(()=>{if(report?.suite.state!=='RUNNING')return;const id=report.suite.suite_id,c=new AbortController();
  const t=setInterval(()=>{void variantRequest<SuiteReport>(selection,'GET',`/v2/number-tests/suites/${id}`,undefined,undefined,c.signal).then(setReport).catch(()=>undefined);},2000);return()=>{c.abort();clearInterval(t);};},[report?.suite.state,report?.suite.suite_id,selection]);
 async function estimateNow(){setBusy(true);setError('');try{setEstimate(await variantRequest<SuiteEstimate>(selection,'POST','/v2/number-tests/suites/estimate',{account_id:accountId}));}catch(e){setError(errorText(e,'No se pudo estimar la prueba automática.'));}finally{setBusy(false);}}
 async function start(){if(!estimate)return;setBusy(true);setError('');
  try{const s=await variantRequest<{suite_id:string}>(selection,'POST','/v2/number-tests/suites',{account_id:accountId,accepted_maximum_microusd:estimate.maximum_microusd},newOperationKey());
   setEstimate(null);setReport(await variantRequest<SuiteReport>(selection,'GET',`/v2/number-tests/suites/${s.suite_id}`));}
  catch(e){setError(errorText(e,'No se pudo iniciar la prueba automática.'));}finally{setBusy(false);}}
 return <Card aria-labelledby="number-test-suite-title">
  <CardHead id="number-test-suite-title" title="Prueba automática de todas las variantes" description="Un cliente simulado compra (saludo, oferta, cobro, comprobante y entrega) y otro deja de responder (seguimientos), por cada variante del número."/>
  {error&&<Alert tone="error">{error}</Alert>}
  {report&&<div className="stack" aria-live="polite">
   <p><Badge tone={report.suite.state==='RUNNING'?'info':'neutral'}>{report.suite.state_label}</Badge> <span className="muted text-sm">{new Date(report.suite.created_at).toLocaleString('es-MX')}</span></p>
   <ul className="stack">{report.variants.map(v=><li key={v.variant_id} className="stack-tight"><strong>{v.name}: {v.verdict_label}</strong>
    <ul className="stack-tight">{v.cases.map(c=><li key={c.journey}><span>{c.journey_label} · {c.state_label}</span>
     <ul className="pill-list">{c.checks.map(k=><li key={k.name}><Badge tone={checkTone[k.state]??'neutral'}>{k.label}: {k.detail}</Badge></li>)}</ul></li>)}</ul></li>)}</ul>
  </div>}
  {!estimate?<div><Button variant="secondary" disabled={!canRun||busy||report?.suite.state==='RUNNING'} loading={busy} onClick={()=>void estimateNow()}>{report?'Volver a probar todo':'Ver costo y probar todo'}</Button></div>:<Alert tone="info" title={`Costo máximo de IA: ${usd(estimate.maximum_microusd)}`} actions={<><Button disabled={busy} loading={busy} onClick={()=>void start()}>Aceptar y probar todo</Button><Button variant="secondary" disabled={busy} onClick={()=>setEstimate(null)}>Cancelar</Button></>}>{estimate.note}</Alert>}
 </Card>;
}

/** A synthetic receipt image drawn in the browser: an example the customer
 * could send, so the receipt rules can be exercised without a real document. */
async function exampleReceipt(amount:string,reference:string):Promise<File>{
 const canvas=document.createElement('canvas');canvas.width=720;canvas.height=460;const ctx=canvas.getContext('2d')!;
 ctx.fillStyle='#fff';ctx.fillRect(0,0,720,460);ctx.fillStyle='#111318';ctx.font='600 28px sans-serif';ctx.fillText('Comprobante de transferencia (PRUEBA)',32,60);
 ctx.font='18px sans-serif';ctx.fillStyle='#5d6778';const lines=['Banco: Banco de prueba','Fecha: '+new Date().toLocaleString('es-MX'),'Importe: '+amount,'Referencia: '+reference,'Cuenta destino: **** 0000','Estado: Aplicado'];
 lines.forEach((l,i)=>ctx.fillText(l,32,120+i*44));ctx.strokeStyle='#e3e6ea';ctx.strokeRect(16,16,688,428);
 const blob=await new Promise<Blob|null>(r=>canvas.toBlob(r,'image/png'));if(!blob)throw Error('receipt');
 return new File([blob],'comprobante-de-prueba.png',{type:'image/png'});
}

export function NumberTest({accountId,selection,role,state,timezone}:{accountId:string;selection:ProfileFence;role:ProfileRole;state:ProfileState;timezone:string}){
 const canRun=role!=='viewer'&&state==='ACTIVE';
 const toast=useToast();
 const [number,setNumber]=useState<NumberRow|null>(null),[view,setView]=useState<View|null>(null),[estimate,setEstimate]=useState<Estimate|null>(null);
 const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[text,setText]=useState(''),[fresh,setFresh]=useState(false);
 const log=useRef<HTMLOListElement>(null),input=useRef<HTMLInputElement>(null),[diagnosis,setDiagnosis]=useState<Diagnosis|null>(null);
 useBreadcrumbs(number?[{label:'Números',href:'/numbers'},{label:`Probar ${number.name}`}]:[{label:'Números',href:'/numbers'}]);
 // RF-19.i: before starting, what blocks the test or leaves part of it out, with the screen that fixes it.
 useEffect(()=>{if(!loaded||(view&&!fresh))return;const c=new AbortController();
  variantRequest<Diagnosis>(selection,'GET',`/v2/number-tests/diagnose?account_id=${accountId}`,undefined,undefined,c.signal).then(setDiagnosis).catch(()=>{if(!c.signal.aborted)setDiagnosis(null);});
  return()=>c.abort();},[loaded,view,fresh,accountId,selection]);
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
 // RF-19.o: the whole test as a JSON file (kept 30 days), read with the profile fence.
 async function exportRun(){if(!view)return;setError('');
  try{const r=await fetch(`/v2/number-tests/${view.run.run_id}/export?environment=REAL`,{credentials:'include',cache:'no-store',redirect:'error',headers:{'X-Commerce-Profile-Id':selection.workspaceId,'X-Commerce-Profile-Version':String(selection.version)}});
   if(!r.ok)throw Error('export');const url=URL.createObjectURL(await r.blob());const a=document.createElement('a');a.href=url;a.download=`prueba-${view.run.run_id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast({tone:'success',title:'Prueba exportada.'});}
  catch{setError('No se pudo exportar la prueba.');}}
 // RF-19.d: the customer sends a receipt (image or PDF ≤4 MB), as on WhatsApp.
 async function attach(file:File){if(!view)return;
  if(!ATTACHMENT_TYPES.includes(file.type)){setError('Adjunta una imagen (PNG, JPG o WEBP) o un PDF.');return;}
  if(file.size>4*1024*1024){setError('El comprobante debe pesar máximo 4 MB.');return;}
  setBusy(true);setError('');
  try{const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
   const saved=await variantRequest<{attachment_id:string}>(selection,'POST',`/v2/number-tests/${view.run.run_id}/attachments`,{mime_type:file.type,base64:btoa(binary)},newOperationKey());
   setBusy(false);await act({type:'receipt',attachment_id:saved.attachment_id});}
  catch(e){setError(errorText(e,'No se pudo adjuntar el comprobante.'));setBusy(false);}}
 async function example(){if(!view)return;const v=view.variants.find(x=>x.variant_id===view.selected_variant_id)??view.variants[0];try{await attach(await exampleReceipt(v?formatMoney(v.amount_minor,v.currency):'(sin precio)','PRUEBA-'+view.run.run_id.slice(0,6).toUpperCase()));}catch{setError('No se pudo generar el comprobante de ejemplo.');}}
 async function send(e:FormEvent){e.preventDefault();const value=text.trim();if(!value)return;await act({type:'message',text:value});setText('');input.current?.focus();}
 const title=number?number.name:'Número';
 const blocked=!canRun||busy||!!view?.pending||['COMPLETED','STOPPED'].includes(view?.run.state??'');
 const next=view?.conversation.next_step,multiple=(view?.variants.length??0)>1&&(!view?.selected_variant_id||next?.action==='select');
 const transcript=view?.conversation.transcript??[];
 const reached={greeting:transcript.some(m=>m.from==='customer'),offer:transcript.some(m=>m.from==='business'&&(m.purpose==='commercial'||m.purpose==='seller_reply')),agreement:transcript.filter(m=>m.from==='customer').length>1,collection:transcript.some(m=>m.purpose==='collection'),receipt:transcript.some(m=>m.kind==='receipt'),delivery:transcript.some(m=>m.purpose==='fulfillment')};
 const current=journey.findIndex(([k])=>!reached[k]);
 const lastFix=!view?.pending?view?.operations.at(-1)?.result?.fix:undefined;
 return <>
  <PageHeader title={`Probar ${title}`} back={{href:'/numbers',label:'Números'}} badge={number?.masked?<Badge tone="neutral" icon={false}>{number.masked}</Badge>:undefined} description={view&&!fresh?`Estado: ${view.run.state_label}. ${view.isolation.label}`:'Conversa con este número como lo haría un cliente. Prueba aislada: no envía mensajes reales, no registra ventas ni pagos y no consume la cuota del número.'} actions={view&&!fresh?<div className="cluster"><Button variant="secondary" disabled={!canRun||busy} onClick={()=>{setFresh(true);setEstimate(null);}}><RotateCcw aria-hidden="true"/>Reiniciar</Button>{!view.expired&&<Button variant="ghost" disabled={busy} onClick={()=>void exportRun()}><Download aria-hidden="true"/>Exportar</Button>}</div>:undefined}/>
  {error&&<Alert tone="error">{error}</Alert>}
  {!loaded&&<Skeleton lines={4} label="Abriendo la prueba…"/>}
  {loaded&&(!view||fresh)&&<Card aria-label="Nueva prueba">
   <CardHead title={view?'Nueva prueba con la configuración actual':'Empieza una prueba'} description={number?`Este número vende: ${number.sells.length?number.sells.map(s=>`${s.product} · ${s.variant}`).join(' — '):'ninguna variante (asígnale una para probarlo)'}.`:undefined}/>
   {diagnosis&&diagnosis.problems.length>0&&<Alert tone={diagnosis.ready?'warn':'error'} role={diagnosis.ready?'note':'alert'} title={diagnosis.ready?'La prueba no cubrirá todo:':'Antes de probar, corrige esto:'}>
    <ul>{diagnosis.problems.map((p,i)=><li key={i}>{p.variant_name&&<>{p.variant_name}: </>}{p.label}{p.fix&&<> · <a href={p.fix.href}>{p.fix.label}</a></>}</li>)}</ul>
   </Alert>}
   {!estimate?<div className="cluster"><Button disabled={!canRun||busy||diagnosis?.ready===false} loading={busy} onClick={()=>void estimateNow()}><FlaskConical aria-hidden="true"/>Ver costo y empezar</Button>{view&&<Button variant="ghost" onClick={()=>{setFresh(false);setEstimate(null);}}>Volver a la última prueba</Button>}</div>:<Alert tone="info" title={`Costo máximo de IA: ${usd(estimate.maximum_microusd)} (${estimate.maximum_ai_calls} respuestas como máximo).`} actions={<><Button disabled={busy} loading={busy} onClick={()=>void start()}>Aceptar y empezar</Button><Button variant="secondary" disabled={busy} onClick={()=>setEstimate(null)}>Cancelar</Button></>}>
    <span>{estimate.note}</span>
    <ul>{estimate.variants.map(v=><li key={v.variant_id}>{v.name}: {v.provider} · {v.model}, hasta {usd(v.maximum_microusd)}</li>)}</ul>
   </Alert>}
  </Card>}
  {view&&!fresh&&<div className="layout-aside">
   <div className="stack">
    {view.expired&&<Alert tone="warn">Esta prueba venció: las pruebas se guardan 30 días. Pulsa Reiniciar para probar de nuevo.</Alert>}
    <ol ref={log} className="chat" aria-label="Conversación de prueba" aria-live="polite">
     {transcript.length===0&&<li className="chat-empty">Escribe como si fueras un cliente.</li>}
     {transcript.map((m,i)=><li key={i} className={`bubble from-${m.from}`}>
      {m.from==='business'&&m.purpose&&<Badge className="bubble-tag" tone={purposeTone[m.purpose]??'neutral'} icon={false}>{purposeLabels[m.purpose]??m.purpose}</Badge>}
      {m.text&&<span className="bubble-text">{m.text}</span>}
      {(m.material_id||m.attachment_id)&&m.mime?<LabMaterial runId={view.run.run_id} entry={m} selection={selection}/>:m.material&&<span className="muted text-sm"><Paperclip aria-hidden="true" size={14}/> {m.material}</span>}
      {m.kind==='receipt'&&<span><Badge tone={receiptTone[m.status??'']??'neutral'}>{receiptLabels[m.status??'']??m.status}</Badge>{m.explanation&&<span className="muted text-sm"> {m.explanation}</span>}</span>}
      {m.kind==='receipt'&&m.status==='HUMAN_REVIEW'&&m.receipt_id&&canRun&&<span className="cluster" role="group" aria-label="Decidir el comprobante">
       <Button size="sm" variant="secondary" disabled={blocked} onClick={()=>void act({type:'review_receipt',receipt_id:m.receipt_id,decision:'APPROVED',reason:'Aprobado en la prueba'})}>Aprobar</Button>
       <Button size="sm" variant="secondary" disabled={blocked} onClick={()=>void act({type:'review_receipt',receipt_id:m.receipt_id,decision:'REJECTED',reason:'Rechazado en la prueba'})}>Rechazar</Button></span>}
      {m.from==='business'&&m.explanation&&<details className="bubble-why"><summary>¿Por qué respondió esto?</summary><p className="muted">{m.variant_name&&<>{m.variant_name}. </>}{m.explanation}</p></details>}
      <span className="bubble-meta">{m.from==='customer'?'Cliente':'Negocio'} · {clock(m.at,timezone)}</span>
     </li>)}
    </ol>
    {view.pending?<Alert tone="info" role="status">El negocio está respondiendo…</Alert>:next&&<p role="status" className="muted"><strong>Siguiente:</strong> {next.label}</p>}
    {lastFix&&<Alert tone="warn">{view.operations.at(-1)!.result!.reason_label??'Falta una configuración.'} <a href={lastFix.href}>{lastFix.label}</a></Alert>}
    {view.conversation.timers.length>0&&<p className="muted text-sm"><Clock3 aria-hidden="true" size={14} style={{verticalAlign:'-2px'}}/> Programado: {view.conversation.timers.map(t=>`${t.purpose==='remarketing'||!t.purpose?'seguimiento':t.purpose} el ${clock(t.due_at,timezone)}`).join(' · ')}. Adelanta el reloj para verlo.</p>}
    {multiple&&<Alert tone="info" role="region" title="El número vende varias variantes. ¿Por cuál llega el cliente? (como si viniera de su anuncio)" actions={view.variants.map(v=><Button key={v.variant_id} variant="secondary" disabled={blocked} onClick={()=>void act({type:'select_variant',variant_id:v.variant_id,origin:'ADVERTISEMENT'})}>{v.name}</Button>)}/>}
    <form className="composer" onSubmit={e=>void send(e)}>
     <label className="sr-only" htmlFor="number-test-input">Mensaje del cliente</label>
     <Input id="number-test-input" ref={input} value={text} maxLength={4096} disabled={blocked} placeholder="Escribe como cliente…" onChange={e=>setText(e.target.value)} autoComplete="off"/>
     <label className="attach-label"><Paperclip aria-hidden="true"/><span className="sr-only">Adjuntar comprobante</span>
      <input type="file" accept={ATTACHMENT_TYPES.join(',')} disabled={blocked} onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void attach(f);}}/></label>
     <Button type="submit" disabled={blocked||!text.trim()}><Send aria-hidden="true"/>Enviar</Button>
    </form>
    <div className="cluster" role="group" aria-label="Acciones rápidas">
     {next?.action==='continue'&&<Button variant="secondary" disabled={blocked} onClick={()=>void act({type:'continue'})}>Continuar</Button>}
     <Button variant="secondary" disabled={blocked||transcript.length===0} onClick={()=>void example()}><ReceiptText aria-hidden="true"/>Comprobante de ejemplo</Button>
     {[2,8,24].map(h=><Button key={h} variant="secondary" disabled={blocked||transcript.length===0} onClick={()=>void act({type:'advance',hours:h})}><Clock3 aria-hidden="true"/>Adelantar {h} h</Button>)}
    </div>
    {view.operations.length>0&&<details className="disclosure"><summary>Historial de la prueba ({view.operations.length})</summary>
     <ol className="disclosure-body history-list">{view.operations.map(o=><li key={o.operation_id}><span>{actionLabel(o.action)} · {o.state_label}{o.result?.reason_label?` — ${o.result.reason_label}`:''}{o.result?.fix&&<> · <a href={o.result.fix.href}>{o.result.fix.label}</a></>}</span></li>)}</ol>
    </details>}
   </div>
   <aside className="stack">
    <Card compact aria-labelledby="journey-title">
     <CardHead level={3} id="journey-title" title="Recorrido" description="Según lo que lleva la conversación."/>
     <ol className="steps">{journey.map(([k,label],i)=><li key={k} data-state={reached[k]?'done':i===current?'current':undefined} aria-current={i===current?'step':undefined}><strong>{label}</strong></li>)}</ol>
    </Card>
    <Card compact flat aria-labelledby="test-meta-title">
     <CardHead level={3} id="test-meta-title" title="Esta prueba"/>
     <dl className="facts">
      <div><dt>Configuración fijada</dt><dd>{clock(view.captured?.captured_at??view.run.created_at,timezone)}</dd></div>
      <div><dt>Reloj de la prueba</dt><dd>{clock(view.run.virtual_now,timezone)}</dd></div>
      <div><dt>Variante</dt><dd>{view.variants.find(v=>v.variant_id===view.selected_variant_id)?.name??(view.variants.length?'Sin elegir':'Ninguna')}</dd></div>
      <div><dt>Costo máximo de IA</dt><dd>{view.captured?usd(view.captured.estimate.maximum_microusd):'—'}</dd></div>
     </dl>
     <p className="muted text-sm">Si cambias la variante, pulsa Reiniciar para probar lo actual.</p>
    </Card>
   </aside>
  </div>}
  {loaded&&<AutomaticSuite accountId={accountId} selection={selection} canRun={canRun}/>}
 </>;
}
