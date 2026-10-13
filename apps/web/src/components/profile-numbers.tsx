import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {z} from 'zod';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import {numberCountries,type NumberCountry} from '../../../../packages/domain/src/numbers/phone.js';
import {api,ApiError} from '../lib/api.js';
import {profileRequest,type ProfileFence} from '../lib/profile-request.js';
import {Button} from './ui/button';

/** V7 Números (RF-07.a/c/d, RF-17.f, wireframe D): add a number with its
 * private phone, show one QR, see readable states. No identity, health,
 * worker, ownership or release-authorization steps are shown. */
const action=z.object({code:z.string(),label:z.string()}).nullable();
const linkSchema=z.object({id:z.string(),version:z.number(),alias:z.string(),masked_number:z.string().nullable(),state:z.string(),label:z.string(),qr_available:z.boolean(),next_action:action,confirmed_at:z.string().nullable()});
const rowSchema=linkSchema.extend({status:z.object({code:z.string(),label:z.string()}),products:z.array(z.string()),warmup:z.object({day:z.number(),of:z.number()}).nullable(),last_test:z.object({at:z.string(),ok:z.boolean()}).nullable()});
const overviewSchema=z.object({numbers:z.array(rowSchema),limit:z.number().nullable()});
const qrSchema=z.object({mimeType:z.literal('image/png'),data:z.string(),expiresAt:z.string()});
const impactSchema=z.object({products:z.array(z.string()),open_conversations:z.number(),pending_followups:z.number(),deliveries_to_confirm:z.number()});
type Row=z.infer<typeof rowSchema>;type Link=z.infer<typeof linkSchema>;
const tone=(code:string)=>['SELLING','CONNECTED','READY_TO_ASSIGN','WARMING'].includes(code)?'ok':['NEEDS_QR','PHONE_MISMATCH','NUMBER_UNAVAILABLE','PREPARATION_FAILED','DISCONNECTED'].includes(code)?'attention':'neutral';
const message=(e:unknown,fallback:string)=>e instanceof ApiError||e instanceof Error?e.message:fallback;

export function ProfileNumbers({selection,role,state}:{selection:ProfileFence;role:ProfileRole;state:ProfileState}){
 const manage=role!=='viewer'&&state==='ACTIVE';
 const [data,setData]=useState<z.infer<typeof overviewSchema>>(),[error,setError]=useState(''),[adding,setAdding]=useState(false),[linking,setLinking]=useState<string|null>(null),[removing,setRemoving]=useState<Row|null>(null);
 const load=useCallback(async(signal?:AbortSignal)=>{try{setData(overviewSchema.parse(await api('/numbers/overview',{signal})));setError('');}catch(e){if(!signal?.aborted)setError(message(e,'No se pudo consultar tus números.'));}},[]);
 useEffect(()=>{const controller=new AbortController();void load(controller.signal);const timer=setInterval(()=>void load(controller.signal),15000);return()=>{controller.abort();clearInterval(timer);};},[load]);
 const full=data?.limit!=null&&data.numbers.length>=data.limit;
 return <section className="profile-numbers" aria-labelledby="numbers-title">
  <div className="profile-numbers-heading"><h1 id="numbers-title">Números</h1>{manage&&<Button onClick={()=>setAdding(true)} disabled={full}>Agregar número</Button>}</div>
  <NumberAlerts selection={selection} canAcknowledge={manage}/>
  {full&&<p role="status">Ya usas todos los números de tu plan ({data?.limit}).</p>}
  {error&&<p role="alert">{error}</p>}
  {!data&&!error&&<p role="status">Consultando tus números…</p>}
  {data&&!data.numbers.length&&<div className="profile-numbers-empty"><h2>Agrega tu primer número</h2><p>Escribe su alias y su número; después escaneas un QR desde WhatsApp.</p></div>}
  {data&&data.numbers.length>0&&<ul className="profile-numbers-list" aria-label="Tus números">{data.numbers.map(n=><li key={n.id} className="profile-number">
   <div className="profile-number-title"><strong>{n.alias}</strong>{n.masked_number&&<span> · {n.masked_number}</span>}<span className={`number-status number-status-${tone(n.status.code)}`}>{n.status.label}</span></div>
   <p className="profile-number-products">{n.products.length?n.products.join(' · '):'Sin variantes asignadas'}</p>
   {n.warmup&&<p className="profile-number-warmup"><progress max={n.warmup.of} value={n.warmup.day} aria-label={`Calentamiento: día ${n.warmup.day} de ${n.warmup.of}`}/> Día {n.warmup.day} de {n.warmup.of}</p>}
   <p className="profile-number-test">Última prueba: {n.last_test?(n.last_test.ok?'correcta':'con problemas'):'sin probar'}</p>
   {manage&&<div className="profile-number-actions">
    {n.next_action&&['link','qr','unlink'].includes(n.next_action.code)&&<Button variant="secondary" onClick={()=>setLinking(n.id)}>{n.next_action.label}</Button>}
    {!['REMOVING','REMOVED'].includes(n.state)&&<Button variant="secondary" onClick={()=>setRemoving(n)}>Eliminar número</Button>}
   </div>}
  </li>)}</ul>}
  <AddNumber open={adding} onClose={()=>setAdding(false)} onCreated={id=>{setAdding(false);setLinking(id);void load();}}/>
  {linking&&<LinkNumber id={linking} onClose={()=>{setLinking(null);void load();}}/>}
  {removing&&<RemoveNumber number={removing} onClose={()=>{setRemoving(null);void load();}}/>}
 </section>;
}

function AddNumber({open,onClose,onCreated}:{open:boolean;onClose:()=>void;onCreated:(id:string)=>void}){
 const [country,setCountry]=useState<NumberCountry>('MX'),[phone,setPhone]=useState(''),[alias,setAlias]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(e:FormEvent){e.preventDefault();if(busy)return;setBusy(true);setError('');
  try{const created=z.object({id:z.string()}).parse(await api('/numbers/quick',{method:'POST',body:JSON.stringify({alias:alias.trim(),country,...(phone.trim()?{phone:phone.trim()}:{})})}));setPhone('');setAlias('');onCreated(created.id);}
  catch(err){setError(message(err,'No se pudo agregar el número.'));}finally{setBusy(false);}}
 return <Dialog.Root open={open} onOpenChange={v=>{if(!v)onClose();}}><Dialog.Portal><Dialog.Overlay className="profile-switch-overlay"/><Dialog.Content className="profile-switch-dialog profile-number-dialog">
  <Dialog.Title>Agregar número</Dialog.Title><Dialog.Description>Usa un teléfono propio. El número se guarda privado; solo verás sus últimos cuatro dígitos.</Dialog.Description>
  <form onSubmit={e=>void submit(e)}>
   <label>País<select value={country} onChange={e=>setCountry(e.target.value as NumberCountry)}>{Object.entries(numberCountries).map(([code,c])=><option key={code} value={code}>{c.name} (+{c.code})</option>)}</select></label>
   <label>Número<input type="tel" inputMode="tel" autoComplete="off" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="55 1234 5678" maxLength={32}/></label>
   <label>Alias<input value={alias} onChange={e=>setAlias(e.target.value)} required minLength={2} maxLength={100} placeholder="Ventas MX"/></label>
   {error&&<p role="alert">{error}</p>}
   <div className="profile-number-actions"><Button type="submit" disabled={busy||alias.trim().length<2}>{busy?'Agregando…':'Mostrar QR'}</Button><Dialog.Close asChild><Button variant="secondary" type="button">Cancelar</Button></Dialog.Close></div>
  </form>
 </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

const steps:Record<string,string>={PREPARING:'Preparando tu número (unos segundos)…',READY_TO_LINK:'Listo para vincular.',WAITING_SCAN:'Esperando escaneo',CONFIRMING:'Conectando…',CONNECTED:'Conectado',NEEDS_QR:'Necesita QR',RECONNECTING:'Reconectando…',DISCONNECTED:'Desconectado'};
function LinkNumber({id,onClose}:{id:string;onClose:()=>void}){
 const [link,setLink]=useState<Link>(),[qr,setQr]=useState<z.infer<typeof qrSchema>>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),requested=useRef(false),qrFetchedAt=useRef(0);
 const read=useCallback(async(signal?:AbortSignal)=>{try{const value=linkSchema.parse(await api(`/numbers/${id}/link`,{signal}));setLink(value);return value;}catch(e){if(!signal?.aborted)setError(message(e,'No se pudo consultar el número.'));return undefined;}},[id]);
 const start=useCallback(async(kind:'link'|'unlink')=>{setBusy(true);setError('');try{setLink(linkSchema.passthrough().parse(await api(`/numbers/${id}/link`,{method:'POST',body:JSON.stringify({action:kind})})));}catch(e){setError(message(e,'No se pudo iniciar la vinculación.'));}finally{setBusy(false);}},[id]);
 useEffect(()=>{const controller=new AbortController();let stop=false;
  const tick=async()=>{const value=await read(controller.signal);if(stop||!value)return;
   if(value.state==='READY_TO_LINK'&&!requested.current){requested.current=true;await start('link');}
   if(value.qr_available&&Date.now()-qrFetchedAt.current>15000){qrFetchedAt.current=Date.now();try{setQr(qrSchema.parse(await api(`/channel-accounts/${id}/qr`,{signal:controller.signal})));}catch{/* a fresh QR is requested on the next tick */}}
   if(!value.qr_available)setQr(undefined);};
  void tick();const timer=setInterval(()=>void tick(),2000);return()=>{stop=true;controller.abort();clearInterval(timer);};},[id,read,start]);
 const state=link?.state??'PREPARING',problem=state==='PHONE_MISMATCH'||state==='NUMBER_UNAVAILABLE';
 return <Dialog.Root open onOpenChange={v=>{if(!v)onClose();}}><Dialog.Portal><Dialog.Overlay className="profile-switch-overlay"/><Dialog.Content className="profile-switch-dialog profile-number-dialog">
  <Dialog.Title>Vincula {link?.alias??'tu número'}</Dialog.Title>
  <Dialog.Description>En el teléfono: WhatsApp → Dispositivos vinculados → Vincular dispositivo. Si usas el mismo teléfono para ver esta página, abre el QR en otro dispositivo.</Dialog.Description>
  <ol className="number-link-steps" aria-label="Avance de la vinculación">
   {['WAITING_SCAN','CONFIRMING','CONNECTED'].map(step=><li key={step} aria-current={state===step?'step':undefined} className={state===step?'current':''}>{steps[step]}</li>)}
  </ol>
  <p role="status">{problem?link?.label:steps[state]??link?.label}</p>
  {qr&&state==='WAITING_SCAN'&&<figure className="number-qr"><img src={`data:${qr.mimeType};base64,${qr.data}`} alt="QR temporal para vincular tu teléfono"/><figcaption>El QR cambia solo cuando caduca.</figcaption></figure>}
  {state==='CONNECTED'&&<p>El calentamiento y las comprobaciones empiezan automáticamente.</p>}
  {state==='PHONE_MISMATCH'&&<p>El teléfono que escaneó el QR no es el número que registraste. Desvincúlalo y escanea con el teléfono correcto.</p>}
  {state==='NUMBER_UNAVAILABLE'&&<p>Este número no se puede usar aquí. Desvincúlalo desde esta página.</p>}
  {(state==='NEEDS_QR'||state==='DISCONNECTED')&&<Button disabled={busy} onClick={()=>void start('link')}>Mostrar QR</Button>}
  {problem&&<Button disabled={busy} onClick={()=>void start('unlink')}>Desvincular</Button>}
  {error&&<p role="alert">{error}</p>}
  <div className="profile-number-actions"><Dialog.Close asChild><Button variant="secondary">{state==='CONNECTED'?'Ver número':'Cerrar'}</Button></Dialog.Close></div>
 </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function RemoveNumber({number,onClose}:{number:Row;onClose:()=>void}){
 const [impact,setImpact]=useState<z.infer<typeof impactSchema>>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[result,setResult]=useState('');
 useEffect(()=>{const controller=new AbortController();api(`/numbers/${number.id}/removal`,{signal:controller.signal}).then(v=>setImpact(impactSchema.parse(v))).catch(e=>{if(!controller.signal.aborted)setError(message(e,'No se pudo calcular el impacto.'));});return()=>controller.abort();},[number.id]);
 async function confirm(){setBusy(true);setError('');try{const value=z.object({state:z.string(),label:z.string()}).parse(await api(`/numbers/${number.id}/removal`,{method:'POST',body:JSON.stringify({expected_version:number.version,confirmation:'REMOVE_NUMBER'})}));setResult(value.state==='REMOVED'?'Número eliminado. La historia se conserva.':'Eliminación en curso: cerramos la sesión y liberamos el cupo al confirmarlo.');}catch(e){setError(message(e,'No se pudo eliminar el número.'));}finally{setBusy(false);}}
 return <Dialog.Root open onOpenChange={v=>{if(!v)onClose();}}><Dialog.Portal><Dialog.Overlay className="profile-switch-overlay"/><Dialog.Content className="profile-switch-dialog profile-number-dialog">
  <Dialog.Title>Eliminar {number.alias}</Dialog.Title><Dialog.Description>Se cancelan los envíos futuros de este número, se cierra su sesión y se conserva la historia. No se borran datos de clientes.</Dialog.Description>
  {!impact&&!error&&<p role="status">Calculando el impacto…</p>}
  {impact&&<ul className="number-removal-impact">
   <li>Variantes asignadas: {impact.products.length?impact.products.join(' · '):'ninguna'}</li>
   <li>Conversaciones abiertas: {impact.open_conversations}</li>
   <li>Seguimientos pendientes que se cancelarán sin enviar: {impact.pending_followups}</li>
   {impact.deliveries_to_confirm>0&&<li>Entregas por confirmar: {impact.deliveries_to_confirm}. Se confirman antes de terminar.</li>}
  </ul>}
  {result?<p role="status">{result}</p>:<Button disabled={busy||!impact} onClick={()=>void confirm()}>Eliminar número</Button>}
  {error&&<p role="alert">{error}</p>}
  <div className="profile-number-actions"><Dialog.Close asChild><Button variant="secondary">Cerrar</Button></Dialog.Close></div>
 </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

const alertSchema=z.object({alerts:z.array(z.object({id:z.string(),kind:z.string(),label:z.string(),href:z.string(),severity:z.enum(['WARNING','CRITICAL']),number:z.object({id:z.string(),alias:z.string()}).nullable(),createdAt:z.string().nullable(),acknowledgedAt:z.string().nullable()}))});
/** RF-07.e: open notices about numbers, deduplicated per incident, in operator language. */
function NumberAlerts({selection,canAcknowledge}:{selection:ProfileFence;canAcknowledge:boolean}){
 const [alerts,setAlerts]=useState<z.infer<typeof alertSchema>['alerts']>([]),[error,setError]=useState('');
 const load=useCallback(async(signal?:AbortSignal)=>{try{setAlerts(alertSchema.parse(await profileRequest(selection,'GET','/v2/alerts',undefined,signal)).alerts.filter(a=>a.href==='/numbers'||a.number));setError('');}catch(e){if(!signal?.aborted)setError(message(e,'No se pudieron consultar los avisos.'));}},[selection]);
 useEffect(()=>{const controller=new AbortController();void load(controller.signal);const timer=setInterval(()=>void load(controller.signal),30000);return()=>{controller.abort();clearInterval(timer);};},[load]);
 async function acknowledge(id:string){try{await profileRequest(selection,'POST',`/v2/alerts/${id}/acknowledge`,{});await load();}catch(e){setError(message(e,'No se pudo marcar el aviso.'));}}
 if(error)return <p role="alert">{error}</p>;
 if(!alerts.length)return null;
 return <section className="number-alerts" aria-label="Avisos de tus números"><h2>Avisos</h2><ul>{alerts.map(a=><li key={a.id} className={a.severity==='CRITICAL'?'critical':''}>
  <span>{a.number?<strong>{a.number.alias}: </strong>:null}{a.label}</span>
  {canAcknowledge&&!a.acknowledgedAt&&<Button variant="secondary" onClick={()=>void acknowledge(a.id)}>Entendido</Button>}
 </li>)}</ul></section>;
}
