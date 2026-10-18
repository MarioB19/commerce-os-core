import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {Bell,FlaskConical,Pause,Play,QrCode,Smartphone,Trash2} from 'lucide-react';
import {z} from 'zod';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import {numberCountries,type NumberCountry} from '../../../../packages/domain/src/numbers/phone.js';
import {api,ApiError} from '../lib/api.js';
import {profileRequest,type ProfileFence} from '../lib/profile-request.js';
import {Alert,Badge,Button,Card,Dialog,DialogActions,DialogClose,DialogContent,EmptyState,ErrorState,Field,Input,NativeSelect,PageHeader,Progress,Skeleton,toneOf,useToast} from './ui';
import {useShell} from './app-shell.js';

/** V7 Números (RF-07.a/c/d, RF-17.f, canvas «Números»): add a number with its
 * private phone, show one QR, see readable states. No identity, health,
 * worker, ownership or release-authorization steps are shown. */
const action=z.object({code:z.string(),label:z.string()}).nullable();
const linkSchema=z.object({id:z.string(),version:z.number(),alias:z.string(),masked_number:z.string().nullable(),state:z.string(),label:z.string(),qr_available:z.boolean(),next_action:action,confirmed_at:z.string().nullable()});
const rowSchema=linkSchema.extend({status:z.object({code:z.string(),label:z.string()}),products:z.array(z.string()),warmup:z.object({day:z.number(),of:z.number()}).nullable(),last_test:z.object({at:z.string(),ok:z.boolean(),run_id:z.string().optional()}).nullable()});
const overviewSchema=z.object({numbers:z.array(rowSchema),limit:z.number().nullable()});
const qrSchema=z.object({mimeType:z.literal('image/png'),data:z.string(),expiresAt:z.string()});
const impactSchema=z.object({products:z.array(z.string()),open_conversations:z.number(),pending_followups:z.number(),deliveries_to_confirm:z.number()});
type Row=z.infer<typeof rowSchema>;type Link=z.infer<typeof linkSchema>;
const message=(e:unknown,fallback:string)=>e instanceof ApiError||e instanceof Error?e.message:fallback;

export function ProfileNumbers({selection,role,state}:{selection:ProfileFence;role:ProfileRole;state:ProfileState}){
 const manage=role!=='viewer'&&state==='ACTIVE';
 const [data,setData]=useState<z.infer<typeof overviewSchema>>(),[error,setError]=useState(''),[adding,setAdding]=useState(false),[linking,setLinking]=useState<string|null>(null),[removing,setRemoving]=useState<Row|null>(null),[tick,setTick]=useState(0);
 const toast=useToast();
 const load=useCallback(async(signal?:AbortSignal)=>{try{setData(overviewSchema.parse(await api('/numbers/overview',{signal})));setError('');}catch(e){if(!signal?.aborted)setError(message(e,'No se pudo consultar tus números.'));}},[]);
 useEffect(()=>{const controller=new AbortController();void load(controller.signal);const timer=setInterval(()=>void load(controller.signal),15000);return()=>{controller.abort();clearInterval(timer);};},[load,tick]);
 const full=data?.limit!=null&&data.numbers.length>=data.limit;
 async function pause(n:Row,paused:boolean){try{await api(`/numbers/${n.id}/pause`,{method:'POST',body:JSON.stringify({paused})});await load();toast({tone:'success',title:paused?`${n.alias} en pausa.`:`${n.alias} reanudado.`});}catch(e){toast({tone:'error',title:'No se pudo cambiar la pausa.',description:message(e,'')});}}
 const empty=data&&!data.numbers.length;
 return <>
  <PageHeader title="Números" description={data?.limit!=null?`${data.numbers.length} de ${data.limit} números de tu plan. Cada número vende las variantes que le asignes.`:'Cada número vende las variantes que le asignes.'} actions={manage&&!empty?<Button onClick={()=>setAdding(true)} disabled={full}>Agregar número</Button>:undefined}/>
  <NumberAlerts selection={selection} canAcknowledge={manage}/>
  {full&&<Alert tone="info">Ya usas todos los números de tu plan ({data?.limit}).</Alert>}
  {error&&<ErrorState message={error} onRetry={()=>setTick(t=>t+1)}/>}
  {!data&&!error&&<div className="card-grid cols-2"><Skeleton block/><Skeleton block/></div>}
  {empty&&<EmptyState icon={<Smartphone aria-hidden="true"/>} title="Agrega tu primer número" description="Escribe su alias y su número; después escaneas un QR desde WhatsApp." action={manage?<Button onClick={()=>setAdding(true)}>Agregar número</Button>:undefined}/>}
  {data&&data.numbers.length>0&&<ul className="card-grid cols-2 number-grid" aria-label="Tus números">{data.numbers.map(n=><li key={n.id}><Card as="article" compact aria-labelledby={'n-'+n.id}>
   <div className="card-head"><div><h2 id={'n-'+n.id} className="number-title">{n.alias}{n.masked_number&&<span className="row-sub">{n.masked_number}</span>}</h2></div><Badge tone={toneOf(n.status.code)}>{n.status.label}</Badge></div>
   <p className="muted">{n.products.length?n.products.join(' · '):'Sin variantes asignadas'}</p>
   {n.warmup&&<div className="stack-tight"><Progress value={n.warmup.day} max={n.warmup.of} label={`Calentamiento: día ${n.warmup.day} de ${n.warmup.of}`} valueText={`día ${n.warmup.day} de ${n.warmup.of}`}/><span className="muted text-sm">Calentamiento · día {n.warmup.day} de {n.warmup.of}</span></div>}
   <p className="muted text-sm"><FlaskConical aria-hidden="true" size={14} style={{verticalAlign:'-2px'}}/> Última prueba: {n.last_test?`${new Date(n.last_test.at).toLocaleDateString('es-MX',{day:'numeric',month:'short'})}, ${n.last_test.ok?'sin problemas':'con problemas'}`:'sin probar'}</p>
   <div className="cluster">
    <a className="btn" data-variant="secondary" data-size="sm" href={`/numbers/${n.id}/test`}><FlaskConical aria-hidden="true"/>{n.last_test?'Ver o probar de nuevo':'Probar número'}</a>
    {manage&&n.next_action&&['link','qr','unlink'].includes(n.next_action.code)&&<Button size="sm" variant="secondary" onClick={()=>setLinking(n.id)}><QrCode aria-hidden="true"/>{n.next_action.label}</Button>}
    {manage&&n.state==='CONNECTED'&&<Button size="sm" variant="ghost" onClick={()=>void pause(n,n.status.code!=='PAUSED_BY_YOU')}>{n.status.code==='PAUSED_BY_YOU'?<><Play aria-hidden="true"/>Reanudar</>:<><Pause aria-hidden="true"/>Pausar</>}</Button>}
    {manage&&!['REMOVING','REMOVED'].includes(n.state)&&<Button size="sm" variant="ghost" onClick={()=>setRemoving(n)}><Trash2 aria-hidden="true"/>Eliminar</Button>}
   </div>
  </Card></li>)}</ul>}
  <AddNumber open={adding} onClose={()=>setAdding(false)} onCreated={id=>{setAdding(false);setLinking(id);void load();}}/>
  {linking&&<LinkNumber id={linking} onClose={()=>{setLinking(null);void load();}}/>}
  {removing&&<RemoveNumber number={removing} onClose={()=>{setRemoving(null);void load();}}/>}
 </>;
}

function AddNumber({open,onClose,onCreated}:{open:boolean;onClose:()=>void;onCreated:(id:string)=>void}){
 const [country,setCountry]=useState<NumberCountry>('MX'),[phone,setPhone]=useState(''),[alias,setAlias]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(e:FormEvent){e.preventDefault();if(busy)return;setBusy(true);setError('');
  try{const created=z.object({id:z.string()}).parse(await api('/numbers/quick',{method:'POST',body:JSON.stringify({alias:alias.trim(),country,...(phone.trim()?{phone:phone.trim()}:{})})}));setPhone('');setAlias('');onCreated(created.id);}
  catch(err){setError(message(err,'No se pudo agregar el número.'));}finally{setBusy(false);}}
 return <Dialog open={open} onOpenChange={v=>{if(!v)onClose();}}>
  <DialogContent title="Agregar número" description="Usa un teléfono propio. El número se guarda privado; solo verás sus últimos cuatro dígitos.">
   <form onSubmit={e=>void submit(e)} className="form">
    <Field label="País"><NativeSelect value={country} onChange={e=>setCountry(e.target.value as NumberCountry)}>{Object.entries(numberCountries).map(([code,c])=><option key={code} value={code}>{c.name} (+{c.code})</option>)}</NativeSelect></Field>
    <Field label="Número" optional help="Si lo escribes, comprobamos que el teléfono que escanea el QR sea ese."><Input type="tel" inputMode="tel" autoComplete="off" value={phone} onChange={e=>setPhone(e.target.value)} maxLength={32}/></Field>
    <Field label="Alias" help="Cómo lo verás en Commerce OS, por ejemplo «Ventas MX»."><Input value={alias} onChange={e=>setAlias(e.target.value)} required minLength={2} maxLength={100}/></Field>
    {error&&<Alert tone="error">{error}</Alert>}
    <DialogActions><DialogClose asChild><Button variant="secondary" type="button">Cancelar</Button></DialogClose><Button type="submit" disabled={busy||alias.trim().length<2} loading={busy}>Mostrar QR</Button></DialogActions>
   </form>
  </DialogContent>
 </Dialog>;
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
 const order=['WAITING_SCAN','CONFIRMING','CONNECTED'],at=order.indexOf(state);
 return <Dialog open onOpenChange={v=>{if(!v)onClose();}}>
  <DialogContent title={`Vincula ${link?.alias??'tu número'}`} description="En el teléfono: WhatsApp → Dispositivos vinculados → Vincular dispositivo. Si usas el mismo teléfono para ver esta página, abre el QR en otro dispositivo.">
   <ol className="steps" aria-label="Avance de la vinculación">
    {order.map((step,i)=><li key={step} aria-current={state===step?'step':undefined} data-state={state===step?'current':at>i?'done':undefined}><strong>{steps[step]}</strong></li>)}
   </ol>
   <Alert tone={problem?'error':state==='CONNECTED'?'success':'info'} role="status">{problem?link?.label:steps[state]??link?.label}</Alert>
   {qr&&state==='WAITING_SCAN'&&<figure className="number-qr"><img src={`data:${qr.mimeType};base64,${qr.data}`} alt="QR temporal para vincular tu teléfono"/><figcaption className="muted text-sm">El QR cambia solo cuando caduca.</figcaption></figure>}
   {state==='CONNECTED'&&<p>El calentamiento y las comprobaciones empiezan automáticamente.</p>}
   {state==='PHONE_MISMATCH'&&<p>El teléfono que escaneó el QR no es el número que registraste. Desvincúlalo y escanea con el teléfono correcto.</p>}
   {state==='NUMBER_UNAVAILABLE'&&<p>Este número no se puede usar aquí. Desvincúlalo desde esta página.</p>}
   {error&&<Alert tone="error">{error}</Alert>}
   <DialogActions>
    <DialogClose asChild><Button variant="secondary">{state==='CONNECTED'?'Ver número':'Cerrar'}</Button></DialogClose>
    {(state==='NEEDS_QR'||state==='DISCONNECTED')&&<Button disabled={busy} loading={busy} onClick={()=>void start('link')}>Mostrar QR</Button>}
    {problem&&<Button variant="destructive" disabled={busy} onClick={()=>void start('unlink')}>Desvincular</Button>}
   </DialogActions>
  </DialogContent>
 </Dialog>;
}

function RemoveNumber({number,onClose}:{number:Row;onClose:()=>void}){
 const [impact,setImpact]=useState<z.infer<typeof impactSchema>>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[result,setResult]=useState('');
 useEffect(()=>{const controller=new AbortController();api(`/numbers/${number.id}/removal`,{signal:controller.signal}).then(v=>setImpact(impactSchema.parse(v))).catch(e=>{if(!controller.signal.aborted)setError(message(e,'No se pudo calcular el impacto.'));});return()=>controller.abort();},[number.id]);
 async function confirm(){setBusy(true);setError('');try{const value=z.object({state:z.string(),label:z.string()}).parse(await api(`/numbers/${number.id}/removal`,{method:'POST',body:JSON.stringify({expected_version:number.version,confirmation:'REMOVE_NUMBER'})}));setResult(value.state==='REMOVED'?'Número eliminado. La historia se conserva.':'Eliminación en curso: cerramos la sesión y liberamos el cupo al confirmarlo.');}catch(e){setError(message(e,'No se pudo eliminar el número.'));}finally{setBusy(false);}}
 return <Dialog open onOpenChange={v=>{if(!v)onClose();}}>
  <DialogContent title={`Eliminar ${number.alias}`} description="Se cancelan los envíos futuros de este número, se cierra su sesión y se conserva la historia. No se borran datos de clientes.">
   {!impact&&!error&&<Skeleton lines={3} label="Calculando el impacto…"/>}
   {impact&&<dl className="facts">
    <div><dt>Variantes asignadas</dt><dd>{impact.products.length?impact.products.join(' · '):'ninguna'}</dd></div>
    <div><dt>Conversaciones abiertas</dt><dd>{impact.open_conversations}</dd></div>
    <div><dt>Seguimientos que se cancelan sin enviar</dt><dd>{impact.pending_followups}</dd></div>
    {impact.deliveries_to_confirm>0&&<div><dt>Entregas por confirmar</dt><dd>{impact.deliveries_to_confirm}. Se confirman antes de terminar.</dd></div>}
   </dl>}
   {result&&<Alert tone="success">{result}</Alert>}
   {error&&<Alert tone="error">{error}</Alert>}
   <DialogActions><DialogClose asChild><Button variant="secondary">Cerrar</Button></DialogClose>{!result&&<Button variant="destructive" disabled={busy||!impact} loading={busy} onClick={()=>void confirm()}>Eliminar número</Button>}</DialogActions>
  </DialogContent>
 </Dialog>;
}

const alertSchema=z.object({alerts:z.array(z.object({id:z.string(),kind:z.string(),label:z.string(),href:z.string(),severity:z.enum(['WARNING','CRITICAL']),number:z.object({id:z.string(),alias:z.string()}).nullable(),createdAt:z.string().nullable(),acknowledgedAt:z.string().nullable()}))});
/** RF-07.e: open notices about numbers, deduplicated per incident, in operator language. */
function NumberAlerts({selection,canAcknowledge}:{selection:ProfileFence;canAcknowledge:boolean}){
 const [alerts,setAlerts]=useState<z.infer<typeof alertSchema>['alerts']>([]),[error,setError]=useState('');
 const {refreshCounters}=useShell();
 const load=useCallback(async(signal?:AbortSignal)=>{try{setAlerts(alertSchema.parse(await profileRequest(selection,'GET','/v2/alerts',undefined,signal)).alerts.filter(a=>a.href==='/numbers'||a.number));setError('');}catch(e){if(!signal?.aborted)setError(message(e,'No se pudieron consultar los avisos.'));}},[selection]);
 useEffect(()=>{const controller=new AbortController();void load(controller.signal);const timer=setInterval(()=>void load(controller.signal),30000);return()=>{controller.abort();clearInterval(timer);};},[load]);
 async function acknowledge(id:string){try{await profileRequest(selection,'POST',`/v2/alerts/${id}/acknowledge`,{});await load();refreshCounters();}catch(e){setError(message(e,'No se pudo marcar el aviso.'));}}
 if(error)return <Alert tone="error">{error}</Alert>;
 if(!alerts.length)return null;
 return <Card compact aria-labelledby="alerts-title" className="number-alerts">
  <div className="card-head"><div><h2 id="alerts-title"><Bell aria-hidden="true" size={18} style={{verticalAlign:'-3px'}}/> Avisos</h2><p>{alerts.length} abierto{alerts.length===1?'':'s'} sobre tus números.</p></div></div>
  <ul className="item-list">{alerts.map(a=><li key={a.id}>
   <Badge tone={a.severity==='CRITICAL'?'error':'warn'}>{a.severity==='CRITICAL'?'Importante':'Aviso'}</Badge>
   <span className="item-name">{a.number?<strong>{a.number.alias}: </strong>:null}{a.label}</span>
   {canAcknowledge&&!a.acknowledgedAt&&<Button size="sm" variant="secondary" onClick={()=>void acknowledge(a.id)}>Entendido</Button>}
  </li>)}</ul>
 </Card>;
}
