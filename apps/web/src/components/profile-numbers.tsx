import {ProfileWarmups} from './profile-warmups.js';
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
const warmupMode=z.enum(['REQUIRED','DECLARED_READY']);
const linkSchema=z.object({id:z.string(),version:z.number(),alias:z.string(),masked_number:z.string().nullable(),state:z.string(),label:z.string(),qr_available:z.boolean(),next_action:action,confirmed_at:z.string().nullable(),
 detail:z.string().nullable().optional(),warmup_mode:warmupMode.optional(),preparation:z.object({since:z.string().nullable(),expected_seconds:z.number(),automatic_retry:z.boolean(),retryable:z.boolean()}).nullable().optional(),
 removal:z.object({phase:z.string(),detail:z.string()}).optional(),
 // V7.5 §4 (H13): whether the connected line can operate now.
 operability:z.object({state:z.string(),reason:z.string().nullable(),next_action:z.string().nullable(),last_check:z.object({id:z.string(),status:z.string(),error:z.string().nullable(),at:z.string()}).nullable()}).optional()});
/** V7.4 D/E: the warm-up of a number as it is, never a calendar day. */
const warmupSchema=z.object({mode:warmupMode,state:z.string(),label:z.string(),effective_days:z.number(),target_days:z.number(),program:z.object({id:z.string(),name:z.string(),status:z.string(),role:z.enum(['sender','receiver'])}).nullable()});
const rowSchema=linkSchema.extend({status:z.object({code:z.string(),label:z.string()}),products:z.array(z.string()),warmup:warmupSchema,last_test:z.object({at:z.string(),ok:z.boolean().nullable(),run_id:z.string().optional(),state:z.string().optional(),label:z.string().optional()}).nullable()});
const overviewSchema=z.object({numbers:z.array(rowSchema),limit:z.number().nullable()});
const qrSchema=z.object({mimeType:z.literal('image/png'),data:z.string(),expiresAt:z.string()});
const impactSchema=z.object({products:z.array(z.string()),open_conversations:z.number(),pending_followups:z.number(),deliveries_to_confirm:z.number()});
type Row=z.infer<typeof rowSchema>;type Link=z.infer<typeof linkSchema>;
const message=(e:unknown,fallback:string)=>e instanceof ApiError||e instanceof Error?e.message:fallback;
const checkErrors:Record<string,string>={VERIFIED_ISOLATION_PROOF_REQUIRED:'No hay una constancia vigente de que el proceso anterior quedó aislado; el control no se transfiere a ciegas. Se resolverá con la siguiente actualización de la plataforma o con soporte.',OLD_OWNER_ISOLATION_AND_RECONCILIATION_REQUIRED:'Hay operaciones por conciliar antes de transferir el control.'};
function ownershipText(o:{state:string;reason:string|null;last_check:{status:string;error:string|null}|null}){
 const base=o.state==='FROZEN'?(o.reason==='HEALTH_DISCONNECTED'?'Conectado, pero la última comprobación vio la sesión detenida; los envíos están detenidos.':o.reason==='HEALTH_UNKNOWN'?'Esperando una comprobación sana de la conexión; los envíos están detenidos.':'Conectado, pero sin control operativo vigente: los envíos están detenidos.'):'Conectado, pero el control operativo de esta línea venció: los envíos están detenidos.';
 const last=o.last_check?.status==='PENDING'?' Comprobación en curso.':o.last_check?.status==='FAILED'&&o.last_check.error?' '+(checkErrors[o.last_check.error]??'La última comprobación no se completó.'):'';
 return base+last;
}

/** V7.5.2 T01: the server's own state of the test; pending is never «con problemas». */
function testLabel(t:NonNullable<Row['last_test']>){const label=t.label??(t.ok===true?'Aprobada':t.ok===false?'Con fallas':'En curso');return label.charAt(0).toLowerCase()+label.slice(1);}

export function ProfileNumbers({selection,role,state}:{selection:ProfileFence;role:ProfileRole;state:ProfileState}){
 const manage=role!=='viewer'&&state==='ACTIVE';
 const [warmups,setWarmups]=useState(false);
 const [data,setData]=useState<z.infer<typeof overviewSchema>>(),[error,setError]=useState(''),[adding,setAdding]=useState(false),[linking,setLinking]=useState<string|null>(null),[removing,setRemoving]=useState<Row|null>(null),[choosing,setChoosing]=useState<Row|null>(null),[unlinking,setUnlinking]=useState<Row|null>(null),[tick,setTick]=useState(0);
 const toast=useToast();
 const load=useCallback(async(signal?:AbortSignal)=>{try{setData(overviewSchema.parse(await api('/numbers/overview',{signal})));setError('');}catch(e){if(!signal?.aborted)setError(message(e,'No se pudo consultar tus números.'));}},[]);
 useEffect(()=>{const controller=new AbortController();void load(controller.signal);const timer=setInterval(()=>void load(controller.signal),15000);return()=>{controller.abort();clearInterval(timer);};},[load,tick]);
 const full=data?.limit!=null&&data.numbers.length>=data.limit;
 async function pause(n:Row,paused:boolean){try{await api(`/numbers/${n.id}/pause`,{method:'POST',body:JSON.stringify({paused})});await load();toast({tone:'success',title:paused?`${n.alias} en pausa.`:`${n.alias} reanudado.`});}catch(e){toast({tone:'error',title:'No se pudo cambiar la pausa.',description:message(e,'')});}}
 // V7.5 §4 (H13): the current worker checks the line; control moves only with verified isolation.
 async function reconcile(n:Row){try{await api(`/numbers/${n.id}/link`,{method:'POST',body:JSON.stringify({action:'reconcile_ownership'})});await load();toast({tone:'success',title:`Comprobando ${n.alias}.`,description:'No se envía ningún mensaje. El estado se actualiza en unos segundos.'});}catch(e){toast({tone:'error',title:'No se pudo iniciar la comprobación.',description:message(e,'')});}}
 const empty=data&&!data.numbers.length;
 if(warmups)return <ProfileWarmups selection={selection} manage={manage} onBack={()=>setWarmups(false)}/>;
 return <>
  <div className="cluster"><Button variant="secondary" onClick={()=>setWarmups(true)}>Calentamientos</Button></div>
  <PageHeader title="Números" description={data?.limit!=null?`${data.numbers.length} de ${data.limit} números de tu plan. Cada número vende las variantes que le asignes.`:'Cada número vende las variantes que le asignes.'} actions={manage&&!empty?<Button onClick={()=>setAdding(true)} disabled={full}>Agregar número</Button>:undefined}/>
  <NumberAlerts selection={selection} canAcknowledge={manage}/>
  {full&&<Alert tone="info">Ya usas todos los números de tu plan ({data?.limit}).</Alert>}
  {error&&<ErrorState message={error} onRetry={()=>setTick(t=>t+1)}/>}
  {!data&&!error&&<div className="card-grid cols-2"><Skeleton block/><Skeleton block/></div>}
  {empty&&<EmptyState icon={<Smartphone aria-hidden="true"/>} title="Agrega tu primer número" description="Escribe su alias y su número; después escaneas un QR desde WhatsApp." action={manage?<Button onClick={()=>setAdding(true)}>Agregar número</Button>:undefined}/>}
  {data&&data.numbers.length>0&&<ul className="card-grid cols-2 number-grid" aria-label="Tus números">{data.numbers.map(n=><li key={n.id}><Card as="article" compact aria-labelledby={'n-'+n.id}>
   <div className="card-head"><div><h2 id={'n-'+n.id} className="number-title">{n.alias}{n.masked_number&&<span className="row-sub">{n.masked_number}</span>}</h2></div><Badge tone={toneOf(n.status.code)}>{n.status.label}</Badge></div>
   <p className="muted">{n.products.length?n.products.join(' · '):'Sin variantes asignadas'}</p>
   {(n.state==='PREPARING'||n.state==='PREPARATION_DELAYED'||n.state==='PREPARATION_FAILED'||n.removal)&&n.detail&&<Alert tone={n.state==='PREPARATION_FAILED'?'error':n.state==='PREPARATION_DELAYED'||n.removal?.phase==='UNLINK_CONFIRMATION_REQUIRED'?'warn':'info'}>{n.detail}</Alert>}
   {n.state==='CONNECTED'&&n.operability&&!['OPERATIONAL','NOT_APPLICABLE','RELEASE_RECOVERY'].includes(n.operability.state)&&<Alert tone="warn">{ownershipText(n.operability)}</Alert>}
   {!n.removal&&<div className="stack-tight">
    <span className="text-sm"><strong>Calentamiento:</strong> {n.warmup.label}{manage&&<> · <button type="button" className="link-button" onClick={()=>setChoosing(n)} aria-label={`Cambiar el calentamiento de ${n.alias}`}>Cambiar</button></>}</span>
    {n.warmup.state==='ACTIVE'&&<Progress value={n.warmup.effective_days} max={n.warmup.target_days} label={`${n.alias}: días efectivos de calentamiento`} valueText={`${n.warmup.effective_days} de ${n.warmup.target_days} días efectivos`}/>}
    {n.warmup.state==='GROUP_REQUIRED'&&manage&&<Button size="sm" variant="secondary" onClick={()=>setWarmups(true)}>Elegir grupo</Button>}
   </div>}
   <p className="muted text-sm"><FlaskConical aria-hidden="true" size={14} style={{verticalAlign:'-2px'}}/> Última prueba: {n.last_test?`${new Date(n.last_test.at).toLocaleDateString('es-MX',{day:'numeric',month:'short'})}, ${testLabel(n.last_test)}`:'sin probar'}</p>
   <div className="cluster">
    <a className="btn" data-variant="secondary" data-size="sm" href={`/numbers/${n.id}/test`}><FlaskConical aria-hidden="true"/>{n.last_test?'Ver o probar de nuevo':'Probar número'}</a>
    {manage&&n.next_action&&['link','qr','unlink','retry_preparation'].includes(n.next_action.code)&&<Button size="sm" variant="secondary" onClick={()=>setLinking(n.id)}><QrCode aria-hidden="true"/>{n.next_action.label}</Button>}
    {manage&&(n.state==='PREPARING'||n.state==='PREPARATION_DELAYED')&&<Button size="sm" variant="ghost" onClick={()=>setLinking(n.id)}>Ver avance</Button>}
    {manage&&n.next_action?.code==='confirm_unlinked'&&<Button size="sm" variant="secondary" onClick={()=>setUnlinking(n)}>{n.next_action.label}</Button>}
    {manage&&n.state==='CONNECTED'&&n.operability?.next_action==='RECONCILE_OWNERSHIP'&&<Button size="sm" variant="secondary" onClick={()=>void reconcile(n)}>Verificar y retomar control</Button>}
    {manage&&n.state==='CONNECTED'&&<Button size="sm" variant="ghost" onClick={()=>void pause(n,n.status.code!=='PAUSED_BY_YOU')}>{n.status.code==='PAUSED_BY_YOU'?<><Play aria-hidden="true"/>Reanudar</>:<><Pause aria-hidden="true"/>Pausar</>}</Button>}
    {manage&&!['REMOVING','REMOVED'].includes(n.state)&&<Button size="sm" variant="ghost" onClick={()=>setRemoving(n)}><Trash2 aria-hidden="true"/>Eliminar</Button>}
   </div>
  </Card></li>)}</ul>}
  <AddNumber open={adding} onClose={()=>setAdding(false)} onCreated={id=>{setAdding(false);setLinking(id);void load();}}/>
  {linking&&<LinkNumber id={linking} onClose={()=>{setLinking(null);void load();}}/>}
  {removing&&<RemoveNumber number={removing} onClose={()=>{setRemoving(null);void load();}}/>}
  {choosing&&<WarmupChoice number={choosing} onClose={()=>{setChoosing(null);void load();}}/>}
  {unlinking&&<ConfirmUnlinked number={unlinking} onClose={()=>{setUnlinking(null);void load();}}/>}
 </>;
}

const warmupOptions=[{value:'required',title:'Necesita calentamiento',help:'Es una línea nueva o con poco uso. Después de conectarla eliges un grupo para empezar; no se envía nada hasta que inicies ese calentamiento.'},
 {value:'ready',title:'Ya está preparado; no iniciar calentamiento',help:'El teléfono ya tiene uso normal. Se conecta y se comprueba, pero no se programan ni se envían mensajes de calentamiento.'}] as const;
type WarmupOption=typeof warmupOptions[number]['value'];
function WarmupOptions({value,onChange,name}:{value:WarmupOption|'';onChange:(v:WarmupOption)=>void;name:string}){
 return <fieldset className="stack-tight"><legend>¿Este teléfono necesita calentamiento?</legend>
  {warmupOptions.map(o=><label key={o.value} className="choice"><input type="radio" name={name} value={o.value} checked={value===o.value} onChange={()=>onChange(o.value)} required/><span><strong>{o.title}</strong><span className="muted text-sm" style={{display:'block'}}>{o.help}</span></span></label>)}
 </fieldset>;
}
function AddNumber({open,onClose,onCreated}:{open:boolean;onClose:()=>void;onCreated:(id:string)=>void}){
 const [country,setCountry]=useState<NumberCountry>('MX'),[phone,setPhone]=useState(''),[alias,setAlias]=useState(''),[warmup,setWarmup]=useState<WarmupOption|''>(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 // One idempotency key per filled form: a double click or a retry after a lost
 // response returns the same number instead of registering it twice.
 const attempt=useRef(crypto.randomUUID());
 async function submit(e:FormEvent){e.preventDefault();if(busy||!warmup)return;setBusy(true);setError('');
  try{const created=z.object({id:z.string()}).parse(await api('/numbers/quick',{method:'POST',headers:{'Idempotency-Key':attempt.current},body:JSON.stringify({alias:alias.trim(),country,warmup,...(phone.trim()?{phone:phone.trim()}:{})})}));setPhone('');setAlias('');setWarmup('');attempt.current=crypto.randomUUID();onCreated(created.id);}
  catch(err){setError(message(err,'No se pudo agregar el número.'));if(err instanceof ApiError&&err.status<500)attempt.current=crypto.randomUUID();}finally{setBusy(false);}}
 return <Dialog open={open} onOpenChange={v=>{if(!v&&!busy)onClose();}}>
  <DialogContent title="Agregar número" description="Usa un teléfono propio. El número se guarda privado; solo verás sus últimos cuatro dígitos.">
   <form onSubmit={e=>void submit(e)} className="form">
    <Field label="País"><NativeSelect value={country} onChange={e=>setCountry(e.target.value as NumberCountry)}>{Object.entries(numberCountries).map(([code,c])=><option key={code} value={code}>{c.name} (+{c.code})</option>)}</NativeSelect></Field>
    <Field label="Número" optional help="Si lo escribes, comprobamos que el teléfono que escanea el QR sea ese."><Input type="tel" inputMode="tel" autoComplete="off" value={phone} onChange={e=>setPhone(e.target.value)} maxLength={32}/></Field>
    <Field label="Alias" help="Cómo lo verás en Commerce OS, por ejemplo «Ventas MX»."><Input value={alias} onChange={e=>setAlias(e.target.value)} required minLength={2} maxLength={100}/></Field>
    <WarmupOptions name="warmup-new" value={warmup} onChange={setWarmup}/>
    <p className="muted text-sm">Puedes cambiar esta elección después. Ninguna de las dos asigna variantes ni abre ventas por sí sola.</p>
    {error&&<Alert tone="error">{error}</Alert>}
    <DialogActions><DialogClose asChild><Button variant="secondary" type="button" disabled={busy}>Cancelar</Button></DialogClose><Button type="submit" disabled={busy||alias.trim().length<2||!warmup} loading={busy}>Continuar al QR</Button></DialogActions>
   </form>
  </DialogContent>
 </Dialog>;
}
/** V7.4 D: change the choice of an existing number, saying what it does. */
function WarmupChoice({number,onClose}:{number:Row;onClose:()=>void}){
 const current:WarmupOption=number.warmup.mode==='DECLARED_READY'?'ready':'required',[value,setValue]=useState<WarmupOption>(current),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(''),attempt=useRef(crypto.randomUUID());
 const same=value===current&&number.warmup.state!=='CHOICE_REQUIRED';
 async function save(e:FormEvent){e.preventDefault();if(busy||same)return;setBusy(true);setError('');
  try{const r=z.object({changed:z.boolean(),cancelled_unsent:z.number().optional(),programs_paused:z.number().optional(),deliveries_to_confirm:z.number().optional()}).parse(await api(`/numbers/${number.id}/warmup`,{method:'POST',headers:{'Idempotency-Key':attempt.current},body:JSON.stringify({mode:value,expected_version:number.version})}));
   setDone(value==='ready'?`Listo: ${number.alias} queda como ya preparado.${r.programs_paused?` Su calentamiento quedó en pausa para que lo revises (${r.cancelled_unsent??0} envíos sin salir cancelados).`:''}${r.deliveries_to_confirm?' Hay entregas por confirmar; se concilian solas.':''}`:`Listo: ${number.alias} necesita calentamiento. Elige un grupo en Calentamientos para empezar.`);}
  catch(err){setError(message(err,'No se pudo guardar la elección.'));attempt.current=crypto.randomUUID();}finally{setBusy(false);}}
 return <Dialog open onOpenChange={v=>{if(!v&&!busy)onClose();}}>
  <DialogContent title={`Calentamiento de ${number.alias}`} description="El historial del número se conserva en cualquier caso.">
   <form className="form" onSubmit={e=>void save(e)}>
    <WarmupOptions name={'warmup-'+number.id} value={value} onChange={v=>{setValue(v);setDone('');}}/>
    {number.warmup.state==='CHOICE_REQUIRED'&&<Alert tone="warn">La preparación se declaró para otro teléfono. Confirma tu elección para el que está vinculado ahora.</Alert>}
    {value==='ready'&&current==='required'&&number.warmup.program&&<Alert tone="warn">Este número participa en «{number.warmup.program.name}». Al marcarlo como ya preparado se cancelan sus envíos que aún no salen y ese calentamiento queda en pausa hasta que lo revises.</Alert>}
    {value==='required'&&current==='ready'&&<Alert tone="info">No se enviará nada todavía: tendrás que elegir un grupo e iniciar el calentamiento.</Alert>}
    {done&&<Alert tone="success" role="status">{done}</Alert>}
    {error&&<Alert tone="error">{error}</Alert>}
    <DialogActions><DialogClose asChild><Button variant="secondary" type="button" disabled={busy}>Cerrar</Button></DialogClose>{!done&&<Button type="submit" disabled={busy||same} loading={busy}>Guardar elección</Button>}</DialogActions>
   </form>
  </DialogContent>
 </Dialog>;
}
/** V7.4 E: a removal that could not close the session from here. */
function ConfirmUnlinked({number,onClose}:{number:Row;onClose:()=>void}){
 const [checked,setChecked]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(''),attempt=useRef(crypto.randomUUID());
 async function confirm(){if(busy||!checked)return;setBusy(true);setError('');
  try{const r=z.object({state:z.string()}).parse(await api(`/numbers/${number.id}/removal/unlink-confirmation`,{method:'POST',headers:{'Idempotency-Key':attempt.current},body:JSON.stringify({expected_version:number.version,confirmation:'DEVICE_UNLINKED_ON_PHONE'})}));setDone(r.state==='REMOVED'?'Número eliminado. La historia se conserva.':'Confirmación registrada. La eliminación terminará en unos momentos.');}
  catch(err){setError(message(err,'No se pudo confirmar la desvinculación.'));attempt.current=crypto.randomUUID();}finally{setBusy(false);}}
 return <Dialog open onOpenChange={v=>{if(!v&&!busy)onClose();}}>
  <DialogContent title={`Termina de eliminar ${number.alias}`} description="No pudimos cerrar esta sesión desde Commerce OS, así que la cierras tú en el teléfono.">
   <ol className="stack-tight"><li>En el teléfono de este número abre WhatsApp → Dispositivos vinculados.</li><li>Toca el dispositivo de Commerce OS y elige «Cerrar sesión».</li><li>Vuelve aquí y confirma.</li></ol>
   <label className="cluster"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)} disabled={busy||!!done}/>Ya quité este dispositivo en WhatsApp → Dispositivos vinculados.</label>
   <p className="muted text-sm">Antes de terminar comprobamos que el servidor de este número ya no tenga ninguna sesión. Tu historial y tus clientes se conservan.</p>
   {done&&<Alert tone="success" role="status">{done}</Alert>}
   {error&&<Alert tone="error">{error}</Alert>}
   <DialogActions><DialogClose asChild><Button variant="secondary" disabled={busy}>Cerrar</Button></DialogClose>{!done&&<Button variant="destructive" disabled={busy||!checked} loading={busy} onClick={()=>void confirm()}>Confirmar y eliminar</Button>}</DialogActions>
  </DialogContent>
 </Dialog>;
}

const steps:Record<string,string>={PREPARING:'Preparando la conexión de tu número…',PREPARATION_DELAYED:'La preparación está tardando más de lo normal',PREPARATION_FAILED:'No se pudo preparar el número',READY_TO_LINK:'Listo para vincular.',WAITING_SCAN:'Esperando escaneo',CONFIRMING:'Comprobando que sea tu número…',CONNECTED:'Conectado',NEEDS_QR:'Necesita QR',RECONNECTING:'Reconectando…',DISCONNECTED:'Desconectado',REMOVING:'Eliminación en curso',REMOVED:'Eliminado'};
function LinkNumber({id,onClose}:{id:string;onClose:()=>void}){
 const [link,setLink]=useState<Link>(),[qr,setQr]=useState<z.infer<typeof qrSchema>>(),[error,setError]=useState(''),[qrProblem,setQrProblem]=useState(''),[busy,setBusy]=useState(false),requested=useRef(false),qrFetchedAt=useRef(0),qrFailures=useRef(0);
 const read=useCallback(async(signal?:AbortSignal)=>{try{const value=linkSchema.parse(await api(`/numbers/${id}/link`,{signal}));setLink(value);setError('');return value;}catch(e){if(!signal?.aborted)setError(message(e,'No se pudo consultar el número. Seguimos intentando.'));return undefined;}},[id]);
 const start=useCallback(async(kind:'link'|'unlink'|'retry_preparation')=>{setBusy(true);setError('');try{setLink(linkSchema.passthrough().parse(await api(`/numbers/${id}/link`,{method:'POST',body:JSON.stringify({action:kind})})));}catch(e){setError(message(e,kind==='retry_preparation'?'No se pudo reintentar la preparación.':'No se pudo iniciar la vinculación.'));if(kind==='link')requested.current=false;}finally{setBusy(false);}},[id]);
 useEffect(()=>{const controller=new AbortController();let stop=false,running=false;
  // One request at a time: a slow answer never overlaps the next poll, and a
  // late answer after closing the window is discarded.
  const tick=async()=>{if(running||stop)return;running=true;try{const value=await read(controller.signal);if(stop||!value)return;
   if(value.state==='READY_TO_LINK'&&!requested.current){requested.current=true;await start('link');}
   if(value.qr_available&&Date.now()-qrFetchedAt.current>15000){
    try{const next=qrSchema.parse(await api(`/channel-accounts/${id}/qr`,{signal:controller.signal}));if(stop)return;qrFetchedAt.current=Date.now();qrFailures.current=0;setQr(next);setQrProblem('');}
    catch{if(stop)return;qrFailures.current++;if(qrFailures.current>=3)setQrProblem('No pudimos obtener el QR en este momento. Seguimos intentándolo; no cierres esta ventana.');}
   }
   if(!value.qr_available){setQr(undefined);qrFetchedAt.current=0;if(value.state!=='WAITING_SCAN'){qrFailures.current=0;setQrProblem('');}}
  }finally{running=false;}};
  void tick();const timer=setInterval(()=>void tick(),2000);return()=>{stop=true;controller.abort();clearInterval(timer);};},[id,read,start]);
 const state=link?.state??'PREPARING',problem=state==='PHONE_MISMATCH'||state==='NUMBER_UNAVAILABLE',preparing=state==='PREPARING'||state==='PREPARATION_DELAYED'||state==='PREPARATION_FAILED';
 const order=['WAITING_SCAN','CONFIRMING','CONNECTED'],at=order.indexOf(state),expired=!!qr&&new Date(qr.expiresAt).getTime()<Date.now()-20000;
 return <Dialog open onOpenChange={v=>{if(!v)onClose();}}>
  <DialogContent title={`Vincula ${link?.alias??'tu número'}`} description="En el teléfono: WhatsApp → Dispositivos vinculados → Vincular dispositivo. Si usas el mismo teléfono para ver esta página, abre el QR en otro dispositivo.">
   <ol className="steps" aria-label="Avance de la vinculación">
    {order.map((step,i)=><li key={step} aria-current={state===step?'step':undefined} data-state={state===step?'current':at>i?'done':undefined}><strong>{steps[step]}</strong></li>)}
   </ol>
   <Alert tone={problem||state==='PREPARATION_FAILED'?'error':state==='CONNECTED'?'success':state==='PREPARATION_DELAYED'?'warn':'info'} role="status">{problem?link?.label:steps[state]??link?.label}</Alert>
   {preparing&&link?.detail&&<p>{link.detail}</p>}
   {preparing&&link?.preparation?.since&&<p className="muted text-sm">En preparación desde las {new Date(link.preparation.since).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'})}. Puedes cerrar esta ventana: el número queda guardado y el QR estará disponible desde «Números».</p>}
   {qr&&state==='WAITING_SCAN'&&!expired&&<figure className="number-qr"><img src={`data:${qr.mimeType};base64,${qr.data}`} alt="QR temporal para vincular tu teléfono"/><figcaption className="muted text-sm">El QR cambia solo cuando caduca.</figcaption></figure>}
   {state==='WAITING_SCAN'&&(!qr||expired)&&!qrProblem&&<p className="muted" role="status">Generando el QR…</p>}
   {state==='WAITING_SCAN'&&qrProblem&&<Alert tone="warn">{qrProblem}</Alert>}
   {state==='CONFIRMING'&&<p className="muted">Ya recibimos el escaneo. No necesitas volver a escanear; esto tarda menos de un minuto.</p>}
   {state==='CONNECTED'&&(link?.warmup_mode==='DECLARED_READY'
    ?<p>Marcaste este número como ya preparado: no se programará ningún calentamiento. Cuando quieras vender con él, asígnale una variante.</p>
    :<p>Para calentar este número, elige un grupo en «Calentamientos». No se envía ningún mensaje hasta que inicies un calentamiento.</p>)}
   {state==='PHONE_MISMATCH'&&<p>El teléfono que escaneó el QR no es el número que registraste. Desvincúlalo y escanea con el teléfono correcto.</p>}
   {state==='NUMBER_UNAVAILABLE'&&<p>Este número no se puede usar aquí. Desvincúlalo desde esta página.</p>}
   {error&&<Alert tone="error">{error}</Alert>}
   <DialogActions>
    <DialogClose asChild><Button variant="secondary">{state==='CONNECTED'?'Ver número':'Cerrar'}</Button></DialogClose>
    {state==='PREPARATION_FAILED'&&<Button disabled={busy} loading={busy} onClick={()=>void start('retry_preparation')}>Reintentar la preparación</Button>}
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
