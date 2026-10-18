import {PlatformMail} from './platform-mail.js';
import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {Alert,Badge,Button,Card,CardHead,Field,Input,NativeCheck,NativeSelect,PageHeader,Skeleton,ToastProvider} from './ui';
import {Layers3,RefreshCw} from 'lucide-react';
export function PlainPage({children,title}:{children:React.ReactNode;title?:string}){return <div className="plain-page"><header className="app-topbar"><a href="/home" className="app-brand"><span className="app-brand-mark"><Layers3 size={16} aria-hidden="true"/></span>Commerce OS</a><span className="muted">{title}</span><div className="topbar-actions"><a href="/home" className="btn" data-variant="ghost">Volver a tus perfiles</a></div></header><main className="app-main" id="profile-main" tabIndex={-1}>{children}</main></div>;}
import {cancelPlatformDeletion,loadPlatformDeletion,requestPlatformDeletion,type PlatformDeletionState,createPlatformProfile,invitePlatformOwner,issuePlatformToken,loadPlatformAccess,loadPlatformProfiles,loadPlatformTokens,platformMessage,platformScopeLabels,revokePlatformToken,signalLabels,updatePlatformProfile,type PlatformCapacity,type PlatformLimits,type PlatformProfile,type PlatformToken} from '../lib/platform-profiles.js';

const timezones=['America/Mexico_City','America/Monterrey','America/Cancun','America/Tijuana','America/Bogota','America/Lima','America/Santiago','America/Argentina/Buenos_Aires','Europe/Madrid','UTC'];
const dateTime=new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short'});
function activity(value:string|null){return value?dateTime.format(new Date(value)):'Sin actividad registrada';}
/** A form keeps its operation id until it succeeds, so retrying an uncertain
 * submission replays the same platform operation instead of creating another. */
function useOperation(){const ref=useRef<string>(crypto.randomUUID());return{current:()=>ref.current,next:()=>{ref.current=crypto.randomUUID();}};}

/** V7 RF-02: platform administration outside every profile. Aggregates only;
 * it never shows conversations, contacts, payments or any profile content. */
export function PlatformDashboard(){
 const heading=useId(),[access,setAccess]=useState<'LOADING'|'ADMIN'|'DENIED'|'ERROR'>('LOADING');
 const [profiles,setProfiles]=useState<PlatformProfile[]>(),[capacity,setCapacity]=useState<PlatformCapacity>(),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const epoch=useRef(0);
 async function refresh(signal?:AbortSignal){
  const generation=++epoch.current;setLoading(true);setError('');
  try{const data=await loadPlatformProfiles(signal);if(generation===epoch.current){setProfiles(data.profiles);setCapacity(data.capacity);}}
  catch(e){if(generation===epoch.current&&!signal?.aborted)setError(platformMessage(e));}
  finally{if(generation===epoch.current)setLoading(false);}
 }
 useEffect(()=>{const controller=new AbortController();
  loadPlatformAccess(controller.signal).then(admin=>{if(controller.signal.aborted)return;setAccess(admin?'ADMIN':'DENIED');if(admin)void refresh(controller.signal);})
   .catch(e=>{if(!controller.signal.aborted){setAccess('ERROR');setError(platformMessage(e));}});
  return()=>{epoch.current++;controller.abort();};
 },[]);
 const done=(message:string)=>{setNotice(message);void refresh();};
 if(access==='LOADING')return <main className="boot" aria-busy="true"><p role="status" className="muted">Confirmando tu acceso a la plataforma…</p></main>;
 if(access==='DENIED')return <PlainPage title="Plataforma"><PageHeader title="Plataforma"/><Alert tone="error">Tu cuenta no administra la plataforma.</Alert></PlainPage>;
 if(access==='ERROR')return <PlainPage title="Plataforma"><PageHeader title="Plataforma"/><Alert tone="error">{error}</Alert></PlainPage>;
 return <ToastProvider><PlainPage title="Plataforma">
  <PageHeader id={heading} title="Plataforma" description="Estado de cada perfil y capacidad de la instalación. Aquí no se consultan conversaciones, contactos ni pagos de ningún perfil." actions={<Button type="button" variant="secondary" disabled={loading} loading={loading} onClick={()=>{setNotice('');void refresh();}}><RefreshCw aria-hidden="true"/>Actualizar</Button>}/>
  {notice&&<Alert tone="success">{notice}</Alert>}{error&&<Alert tone="error">{error}</Alert>}
  {capacity&&<section className="kpi-grid" aria-label="Capacidad de la plataforma">
   <div className="kpi"><span className="kpi-label">Perfiles</span><strong className="kpi-value">{capacity.profiles.used} <span className="muted" style={{fontSize:16,fontWeight:400}}>de {capacity.profiles.max}</span></strong></div>
   <div className="kpi"><span className="kpi-label">Números asignados a perfiles</span><strong className="kpi-value">{capacity.numbers.allocated} <span className="muted" style={{fontSize:16,fontWeight:400}}>de {capacity.numbers.max}</span></strong></div>
   <div className="kpi"><span className="kpi-label">Números registrados</span><strong className="kpi-value">{capacity.numbers.registered} <span className="muted" style={{fontSize:16,fontWeight:400}}>de {capacity.numbers.max}</span></strong></div>
  </section>}
  {loading&&!profiles&&<Skeleton lines={4} label="Consultando perfiles…"/>}
  {profiles?.length===0&&<p className="muted">Todavía no hay perfiles.</p>}
  <ul className="card-grid cols-2 plain-list" aria-label="Perfiles">
   {profiles?.map(profile=><li key={profile.id}><PlatformProfileCard profile={profile} onDone={done}/></li>)}
  </ul>
  {capacity&&capacity.profiles.used<capacity.profiles.max&&<CreateProfile onDone={done} freeNumbers={Math.max(0,capacity.numbers.max-capacity.numbers.allocated)}/>}
  {capacity&&capacity.profiles.used>=capacity.profiles.max&&<Alert tone="info">La instalación ya usa sus {capacity.profiles.max} perfiles. Para crear otro hace falta ampliar la capacidad.</Alert>}
  <PlatformTokens onDone={done}/>
  <PlatformMail/>
 </PlainPage></ToastProvider>;
}
function PlatformProfileCard({profile,onDone}:{profile:PlatformProfile;onDone:(message:string)=>void}){
 const id=useId(),[mode,setMode]=useState<'NONE'|'STATE'|'LIMITS'|'INVITE'|'DELETE'>('NONE');
 return <Card as="article" aria-labelledby={id}>
  <div className="card-head"><div><h2 id={id}>{profile.businessName}</h2><p>Última actividad: {activity(profile.lastActivityAt)}</p></div><Badge tone={profile.state==='ACTIVE'?'success':'warn'}>{profile.state==='ACTIVE'?'Activo':'Suspendido'}</Badge></div>
  <dl className="facts">
   <div><dt>Números</dt><dd>{profile.numbers.connected} conectados de {profile.numbers.registered} (límite {profile.limits.numbers})</dd></div>
   <div><dt>Productos</dt><dd>{profile.products} (límite {profile.limits.products})</dd></div>
   <div><dt>Variantes</dt><dd>{profile.variants}</dd></div>
   <div><dt>Ofertas</dt><dd>{profile.offers}</dd></div>
   <div><dt>Conversaciones por día</dt><dd>Límite {profile.limits.dailyConversations}</dd></div>
  </dl>
  {profile.signals.length>0&&<Alert tone="warn" role="note">Atención: {profile.signals.map(signal=>signalLabels[signal]??signal).join(' · ')}</Alert>}
  <div className="cluster">
   <Button type="button" variant="secondary" size="sm" aria-expanded={mode==='STATE'} onClick={()=>setMode(mode==='STATE'?'NONE':'STATE')}>{profile.state==='ACTIVE'?'Suspender':'Reactivar'}</Button>
   <Button type="button" variant="secondary" size="sm" aria-expanded={mode==='LIMITS'} onClick={()=>setMode(mode==='LIMITS'?'NONE':'LIMITS')}>Ajustar límites</Button>
   {profile.owners===0&&profile.state==='ACTIVE'&&<Button type="button" variant="secondary" size="sm" aria-expanded={mode==='INVITE'} onClick={()=>setMode(mode==='INVITE'?'NONE':'INVITE')}>Invitar a la persona Dueño</Button>}
   {profile.state==='SUSPENDED'&&<Button type="button" variant="ghost" size="sm" aria-expanded={mode==='DELETE'} onClick={()=>setMode(mode==='DELETE'?'NONE':'DELETE')}>Eliminación del perfil</Button>}
  </div>
  {mode==='STATE'&&<ChangeState profile={profile} onDone={message=>{setMode('NONE');onDone(message);}}/>}
  {mode==='LIMITS'&&<ChangeLimits profile={profile} onDone={message=>{setMode('NONE');onDone(message);}}/>}
  {mode==='INVITE'&&<InviteOwner profile={profile} onDone={message=>{setMode('NONE');onDone(message);}}/>}
  {mode==='DELETE'&&<ProfileDeletion profile={profile} onDone={message=>{setMode('NONE');onDone(message);}}/>}
 </Card>;
}
function useSubmit(){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),operation=useOperation();
 async function run(work:(operationId:string)=>Promise<unknown>,onSuccess:()=>void){
  if(busy)return;setBusy(true);setError('');
  try{await work(operation.current());operation.next();onSuccess();}catch(e){setError(platformMessage(e));}finally{setBusy(false);}
 }
 return{busy,error,run};
}
function ChangeState({profile,onDone}:{profile:PlatformProfile;onDone:(message:string)=>void}){
 const submit=useSubmit(),target=profile.state==='ACTIVE'?'SUSPENDED':'ACTIVE';
 return <Alert tone={target==='SUSPENDED'?'warn':'info'} role="region" title={target==='SUSPENDED'?'Confirmar suspensión':'Confirmar reactivación'} actions={<Button type="button" variant={target==='SUSPENDED'?'destructive':'default'} size="sm" disabled={submit.busy} loading={submit.busy} onClick={()=>{void submit.run(operationId=>updatePlatformProfile(profile.id,{operationId,expectedVersion:profile.version,state:target}),()=>onDone(target==='SUSPENDED'?`${profile.businessName} quedó suspendido.`:`${profile.businessName} quedó activo.`));}}>{target==='SUSPENDED'?'Sí, suspender':'Sí, reactivar'}</Button>}>
  <span>{target==='SUSPENDED'?`${profile.businessName} dejará de operar: sus ventas, envíos y calentamientos se detienen. Sus datos se conservan y puedes reactivarlo después.`:`${profile.businessName} volverá a operar con su configuración actual.`}</span>
  {submit.error&&<span role="alert">{submit.error}</span>}
 </Alert>;
}
/** RF-01.5: deletion request of a suspended profile. Requires the owner's
 * export from the last 7 days and the exact business name. It erases nothing:
 * the profile stays suspended until the privacy erasure window (D-18). */
function ProfileDeletion({profile,onDone}:{profile:PlatformProfile;onDone:(message:string)=>void}){
 const id=useId(),submit=useSubmit(),[state,setState]=useState<PlatformDeletionState>(),[loadError,setLoadError]=useState(''),[confirmation,setConfirmation]=useState(''),[reason,setReason]=useState('');
 useEffect(()=>{const c=new AbortController();loadPlatformDeletion(profile.id,c.signal).then(setState).catch(e=>{if(!c.signal.aborted)setLoadError(platformMessage(e));});return()=>c.abort();},[profile.id,profile.version]);
 if(loadError)return <Alert tone="error">{loadError}</Alert>;
 if(!state)return <Skeleton lines={2} label="Consultando la eliminación…"/>;
 const pending=state.deletion?.status==='PENDING_ERASURE'?state.deletion:null,exported=state.lastExport;
 if(pending)return <form className="form policy-section" aria-labelledby={id} onSubmit={event=>{event.preventDefault();void submit.run(operationId=>cancelPlatformDeletion(profile.id,{operationId,deletionId:pending.id,reason:reason.trim()}),()=>onDone(`Se canceló la eliminación de ${profile.businessName}.`));}}>
  <h3 id={id}>Eliminación pendiente</h3>
  <p>Solicitada el {dateTime.format(new Date(pending.requestedAt))}. {profile.businessName} sigue suspendido y no puede reactivarse mientras la eliminación esté pendiente. El borrado definitivo lo ejecuta la ventana de privacidad.</p>
  <Field label="Motivo de la cancelación"><Input required minLength={8} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/></Field>
  {submit.error&&<Alert tone="error">{submit.error}</Alert>}
  <div><Button type="submit" variant="secondary" disabled={submit.busy||reason.trim().length<8} loading={submit.busy}>Cancelar la eliminación</Button></div>
 </form>;
 const ready=exported?.usable===true;
 return <form className="form policy-section" aria-labelledby={id} onSubmit={event=>{event.preventDefault();if(!exported)return;void submit.run(operationId=>requestPlatformDeletion(profile.id,{operationId,expectedVersion:state.version,confirmation:confirmation.trim(),exportId:exported.id,reason:reason.trim()}),()=>onDone(`Eliminación de ${profile.businessName} solicitada. El perfil queda suspendido hasta el borrado definitivo.`));}}>
  <h3 id={id}>Eliminar {profile.businessName}</h3>
  {exported?<p>Última exportación de la persona Dueño: {dateTime.format(new Date(exported.createdAt))} · {exported.rows} filas · huella <code>{exported.sha256.slice(0,16)}…</code>{ready?'':' (tiene más de 7 días)'}</p>:<p>Este perfil no tiene exportación de datos.</p>}
  {!ready&&<Alert tone="info" role="note">Antes de pedir la eliminación, la persona Dueño debe exportar los datos del perfil desde Perfil del negocio → Exportar datos. La plataforma no puede leer ni descargar ese contenido.</Alert>}
  {ready&&<>
   <p>La solicitud deja el perfil suspendido de forma permanente hasta el borrado definitivo. Se puede cancelar mientras esté pendiente.</p>
   <Field label="Motivo"><Input required minLength={8} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/></Field>
   <Field label="Escribe el nombre exacto del negocio para confirmar"><Input autoComplete="off" required maxLength={160} value={confirmation} onChange={event=>setConfirmation(event.target.value)}/></Field>
   {submit.error&&<Alert tone="error">{submit.error}</Alert>}
   <div><Button type="submit" variant="destructive" disabled={submit.busy||confirmation.trim()!==profile.businessName||reason.trim().length<8} loading={submit.busy}>Solicitar eliminación</Button></div>
  </>}
 </form>;
}
function LimitFields({value,onChange,maxNumbers}:{value:PlatformLimits;onChange:(next:PlatformLimits)=>void;maxNumbers:number}){
 const field=(key:keyof PlatformLimits,label:string,max:number)=><Field label={label}><Input type="number" inputMode="numeric" min={0} max={max} required value={value[key]} onChange={event=>onChange({...value,[key]:Math.max(0,Math.trunc(Number(event.target.value)||0))})}/></Field>;
 return <div className="form-grid">{field('numbers','Números',maxNumbers)}{field('products','Productos',100000)}{field('dailyConversations','Conversaciones por día',100000)}</div>;
}
function ChangeLimits({profile,onDone}:{profile:PlatformProfile;onDone:(message:string)=>void}){
 const submit=useSubmit(),[limits,setLimits]=useState<PlatformLimits>(profile.limits);
 function save(event:FormEvent){event.preventDefault();void submit.run(operationId=>updatePlatformProfile(profile.id,{operationId,expectedVersion:profile.version,limits}),()=>onDone(`Límites de ${profile.businessName} actualizados.`));}
 return <form onSubmit={save} aria-label={`Límites de ${profile.businessName}`} className="form policy-section">
  <LimitFields value={limits} onChange={setLimits} maxNumbers={20}/>
  {submit.error&&<Alert tone="error">{submit.error}</Alert>}
  <div><Button type="submit" variant="secondary" disabled={submit.busy} loading={submit.busy}>Guardar límites</Button></div>
 </form>;
}
function InviteOwner({profile,onDone}:{profile:PlatformProfile;onDone:(message:string)=>void}){
 const submit=useSubmit(),[email,setEmail]=useState('');
 function send(event:FormEvent){event.preventDefault();void submit.run(operationId=>invitePlatformOwner(profile.id,{operationId,email:email.trim()}),()=>onDone(`Invitación para la persona Dueño de ${profile.businessName} en cola de envío.`));}
 return <form onSubmit={send} aria-label={`Invitar a la persona Dueño de ${profile.businessName}`} className="form policy-section">
  <Field label="Correo de la persona Dueño" help="Recibirá un enlace válido 24 horas. La plataforma no obtiene acceso al perfil."><Input type="email" autoComplete="off" required maxLength={254} value={email} onChange={event=>setEmail(event.target.value)}/></Field>
  {submit.error&&<Alert tone="error">{submit.error}</Alert>}
  <div><Button type="submit" variant="secondary" disabled={submit.busy} loading={submit.busy}>Enviar invitación</Button></div>
 </form>;
}
function CreateProfile({onDone,freeNumbers}:{onDone:(message:string)=>void;freeNumbers:number}){
 const id=useId(),submit=useSubmit(),[name,setName]=useState(''),[timezone,setTimezone]=useState('America/Mexico_City'),[limits,setLimits]=useState<PlatformLimits>({numbers:Math.min(2,freeNumbers),products:50,dailyConversations:300});
 function create(event:FormEvent){event.preventDefault();void submit.run(operationId=>createPlatformProfile({operationId,businessName:name.trim(),timezone,limits}),()=>{onDone(`Perfil ${name.trim()} creado. Invita ahora a su persona Dueño.`);setName('');});}
 return <Card aria-labelledby={id}>
  <CardHead id={id} title="Crear perfil" description={`Quedan ${freeNumbers} números sin asignar en la plataforma.`}/>
  <form onSubmit={create} className="form">
   <div className="form-grid">
    <Field label="Nombre del negocio"><Input required maxLength={160} value={name} onChange={event=>setName(event.target.value)}/></Field>
    <Field label="Zona horaria"><NativeSelect value={timezone} onChange={event=>setTimezone(event.target.value)}>{timezones.map(zone=><option key={zone} value={zone}>{zone}</option>)}</NativeSelect></Field>
   </div>
   <LimitFields value={limits} onChange={setLimits} maxNumbers={freeNumbers}/>
   {submit.error&&<Alert tone="error">{submit.error}</Alert>}
   <div className="form-actions"><Button type="submit" disabled={submit.busy} loading={submit.busy}>Crear perfil</Button></div>
  </form>
 </Card>;
}
/** RF-02.c: the same actions through MCP with a platform token bound to this
 * admin. The bearer is shown once; afterwards only its metadata remains. */
function PlatformTokens({onDone}:{onDone:(message:string)=>void}){
 const id=useId(),[tokens,setTokens]=useState<PlatformToken[]>(),[name,setName]=useState('MCP de plataforma'),[days,setDays]=useState('30'),[scopes,setScopes]=useState<string[]>(['platform:profiles','platform:capacity']),[secret,setSecret]=useState(''),{busy,error,run}=useSubmit();
 const reload=()=>loadPlatformTokens().then(setTokens).catch(()=>setTokens([]));
 useEffect(()=>{void reload();},[]);
 function create(event:FormEvent){event.preventDefault();setSecret('');const span=Number(days);
  void run(async()=>{const issued=await issuePlatformToken({name,scopes,expiresAt:new Date(Date.now()+Math.min(90,Math.max(1,span))*86400000).toISOString()});setSecret(issued.token);},()=>{void reload();onDone('Acceso creado. Copia el token ahora: no se volverá a mostrar.');});}
 return <Card aria-labelledby={id}>
  <CardHead id={id} title="Accesos MCP de plataforma" description="Permiten a un cliente MCP hacer las mismas acciones de esta página con tu cuenta. Caducan en un máximo de 90 días y dejan de funcionar si se revocan."/>
  {error&&<Alert tone="error">{error}</Alert>}
  {secret&&<Alert tone="success" title="Token (sólo se muestra una vez)"><code style={{overflowWrap:'anywhere'}}>{secret}</code></Alert>}
  {tokens&&tokens.length>0&&<ul className="item-list">{tokens.map(t=><li key={t.id}><span className="item-name">{t.name}<span className="row-sub">{t.scopes.map(s=>platformScopeLabels[s]??s).join(', ')}</span></span><Badge tone={t.revokedAt?'neutral':'success'}>{t.revokedAt?'Revocado':'Vence '+dateTime.format(new Date(t.expiresAt))}</Badge>
   {!t.revokedAt&&<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={()=>{void run(()=>revokePlatformToken(t.id),()=>{void reload();onDone('Acceso revocado.');});}}>Revocar</Button>}</li>)}</ul>}
  <form onSubmit={create} className="form">
   <div className="form-grid"><Field label="Nombre"><Input value={name} maxLength={100} required onChange={e=>setName(e.target.value)}/></Field><Field label="Vigencia en días"><Input inputMode="numeric" value={days} onChange={e=>setDays(e.target.value)}/></Field></div>
   <fieldset className="plain"><legend>Permisos</legend><div className="cluster">{Object.entries(platformScopeLabels).map(([scope,label])=><NativeCheck key={scope} label={label} checked={scopes.includes(scope)} onChange={e=>setScopes(e.target.checked?[...scopes,scope]:scopes.filter(s=>s!==scope))}/>)}</div></fieldset>
   <div className="form-actions"><Button type="submit" variant="secondary" disabled={busy||!scopes.length}>Crear acceso</Button></div>
  </form>
 </Card>;
}
