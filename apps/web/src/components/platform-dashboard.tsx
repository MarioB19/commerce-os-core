import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {Button} from './ui/button';
import {createPlatformProfile,invitePlatformOwner,issuePlatformToken,loadPlatformAccess,loadPlatformProfiles,loadPlatformTokens,platformMessage,platformScopeLabels,revokePlatformToken,signalLabels,updatePlatformProfile,type PlatformCapacity,type PlatformLimits,type PlatformProfile,type PlatformToken} from '../lib/platform-profiles.js';

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
 if(access==='LOADING')return <main className="main-content" aria-busy="true"><p role="status">Confirmando tu acceso a la plataforma…</p></main>;
 if(access==='DENIED')return <main className="main-content"><h1>Plataforma</h1><p role="alert">Tu cuenta no administra la plataforma.</p><a href="/home">Volver a tus perfiles</a></main>;
 if(access==='ERROR')return <main className="main-content"><h1>Plataforma</h1><p role="alert">{error}</p><a href="/home">Volver a tus perfiles</a></main>;
 return <main className="main-content platform-dashboard" aria-labelledby={heading}>
  <a href="/home">Volver a tus perfiles</a>
  <h1 id={heading}>Plataforma</h1>
  <p>Estado de cada perfil y capacidad de la instalación. Aquí no se consultan conversaciones, contactos ni pagos de ningún perfil.</p>
  {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
  {capacity&&<section className="card" aria-label="Capacidad de la plataforma">
   <h2>Capacidad</h2>
   <dl className="platform-capacity">
    <div><dt>Perfiles</dt><dd>{capacity.profiles.used} de {capacity.profiles.max}</dd></div>
    <div><dt>Números asignados a perfiles</dt><dd>{capacity.numbers.allocated} de {capacity.numbers.max}</dd></div>
    <div><dt>Números registrados</dt><dd>{capacity.numbers.registered} de {capacity.numbers.max}</dd></div>
   </dl>
  </section>}
  <Button type="button" variant="secondary" disabled={loading} onClick={()=>{setNotice('');void refresh();}}>{loading?'Actualizando…':'Actualizar'}</Button>
  {loading&&!profiles&&<p role="status">Consultando perfiles…</p>}
  {profiles?.length===0&&<p>Todavía no hay perfiles.</p>}
  <ul className="platform-profiles" aria-label="Perfiles">
   {profiles?.map(profile=><li key={profile.id}><PlatformProfileCard profile={profile} onDone={done}/></li>)}
  </ul>
  {capacity&&capacity.profiles.used<capacity.profiles.max&&<CreateProfile onDone={done} freeNumbers={Math.max(0,capacity.numbers.max-capacity.numbers.allocated)}/>}
  {capacity&&capacity.profiles.used>=capacity.profiles.max&&<p>La instalación ya usa sus {capacity.profiles.max} perfiles. Para crear otro hace falta ampliar la capacidad.</p>}
  <PlatformTokens onDone={done}/>
 </main>;
}
function PlatformProfileCard({profile,onDone}:{profile:PlatformProfile;onDone:(message:string)=>void}){
 const id=useId(),[mode,setMode]=useState<'NONE'|'STATE'|'LIMITS'|'INVITE'>('NONE');
 return <article className="card" aria-labelledby={id}>
  <h2 id={id}>{profile.businessName}</h2>
  <p><strong>{profile.state==='ACTIVE'?'Activo':'Suspendido'}</strong> · Última actividad: {activity(profile.lastActivityAt)}</p>
  <dl className="platform-counts">
   <div><dt>Números</dt><dd>{profile.numbers.connected} conectados de {profile.numbers.registered} registrados (límite {profile.limits.numbers})</dd></div>
   <div><dt>Productos</dt><dd>{profile.products} (límite {profile.limits.products})</dd></div>
   <div><dt>Variantes</dt><dd>{profile.variants}</dd></div>
   <div><dt>Ofertas</dt><dd>{profile.offers}</dd></div>
   <div><dt>Conversaciones por día</dt><dd>Límite {profile.limits.dailyConversations}</dd></div>
  </dl>
  {profile.signals.length>0&&<p role="note">Atención: {profile.signals.map(signal=>signalLabels[signal]??signal).join(' · ')}</p>}
  <div className="platform-actions">
   <Button type="button" variant="secondary" aria-expanded={mode==='STATE'} onClick={()=>setMode(mode==='STATE'?'NONE':'STATE')}>{profile.state==='ACTIVE'?'Suspender':'Reactivar'}</Button>
   <Button type="button" variant="secondary" aria-expanded={mode==='LIMITS'} onClick={()=>setMode(mode==='LIMITS'?'NONE':'LIMITS')}>Ajustar límites</Button>
   {profile.owners===0&&profile.state==='ACTIVE'&&<Button type="button" variant="secondary" aria-expanded={mode==='INVITE'} onClick={()=>setMode(mode==='INVITE'?'NONE':'INVITE')}>Invitar a la persona Dueño</Button>}
  </div>
  {mode==='STATE'&&<ChangeState profile={profile} onDone={message=>{setMode('NONE');onDone(message);}}/>}
  {mode==='LIMITS'&&<ChangeLimits profile={profile} onDone={message=>{setMode('NONE');onDone(message);}}/>}
  {mode==='INVITE'&&<InviteOwner profile={profile} onDone={message=>{setMode('NONE');onDone(message);}}/>}
 </article>;
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
 return <div className="platform-confirm" role="group" aria-label={target==='SUSPENDED'?'Confirmar suspensión':'Confirmar reactivación'}>
  <p>{target==='SUSPENDED'?`${profile.businessName} dejará de operar: sus ventas, envíos y calentamientos se detienen. Sus datos se conservan y puedes reactivarlo después.`:`${profile.businessName} volverá a operar con su configuración actual.`}</p>
  {submit.error&&<p role="alert">{submit.error}</p>}
  <Button type="button" disabled={submit.busy} onClick={()=>{void submit.run(operationId=>updatePlatformProfile(profile.id,{operationId,expectedVersion:profile.version,state:target}),()=>onDone(target==='SUSPENDED'?`${profile.businessName} quedó suspendido.`:`${profile.businessName} quedó activo.`));}}>{submit.busy?'Guardando…':target==='SUSPENDED'?'Sí, suspender':'Sí, reactivar'}</Button>
 </div>;
}
function LimitFields({value,onChange,maxNumbers}:{value:PlatformLimits;onChange:(next:PlatformLimits)=>void;maxNumbers:number}){
 const field=(key:keyof PlatformLimits,label:string,max:number)=><label>{label}<input type="number" inputMode="numeric" min={0} max={max} required value={value[key]} onChange={event=>onChange({...value,[key]:Math.max(0,Math.trunc(Number(event.target.value)||0))})}/></label>;
 return <>{field('numbers','Números',maxNumbers)}{field('products','Productos',100000)}{field('dailyConversations','Conversaciones por día',100000)}</>;
}
function ChangeLimits({profile,onDone}:{profile:PlatformProfile;onDone:(message:string)=>void}){
 const submit=useSubmit(),[limits,setLimits]=useState<PlatformLimits>(profile.limits);
 function save(event:FormEvent){event.preventDefault();void submit.run(operationId=>updatePlatformProfile(profile.id,{operationId,expectedVersion:profile.version,limits}),()=>onDone(`Límites de ${profile.businessName} actualizados.`));}
 return <form onSubmit={save} aria-label={`Límites de ${profile.businessName}`}>
  <LimitFields value={limits} onChange={setLimits} maxNumbers={20}/>
  {submit.error&&<p role="alert">{submit.error}</p>}
  <Button type="submit" disabled={submit.busy}>{submit.busy?'Guardando…':'Guardar límites'}</Button>
 </form>;
}
function InviteOwner({profile,onDone}:{profile:PlatformProfile;onDone:(message:string)=>void}){
 const submit=useSubmit(),[email,setEmail]=useState('');
 function send(event:FormEvent){event.preventDefault();void submit.run(operationId=>invitePlatformOwner(profile.id,{operationId,email:email.trim()}),()=>onDone(`Invitación para la persona Dueño de ${profile.businessName} en cola de envío.`));}
 return <form onSubmit={send} aria-label={`Invitar a la persona Dueño de ${profile.businessName}`}>
  <label>Correo de la persona Dueño<input type="email" autoComplete="off" required maxLength={254} value={email} onChange={event=>setEmail(event.target.value)}/></label>
  <p>Recibirá un enlace válido 24 horas. La plataforma no obtiene acceso al perfil.</p>
  {submit.error&&<p role="alert">{submit.error}</p>}
  <Button type="submit" disabled={submit.busy}>{submit.busy?'Enviando…':'Enviar invitación'}</Button>
 </form>;
}
function CreateProfile({onDone,freeNumbers}:{onDone:(message:string)=>void;freeNumbers:number}){
 const id=useId(),submit=useSubmit(),[name,setName]=useState(''),[timezone,setTimezone]=useState('America/Mexico_City'),[limits,setLimits]=useState<PlatformLimits>({numbers:Math.min(2,freeNumbers),products:50,dailyConversations:300});
 function create(event:FormEvent){event.preventDefault();void submit.run(operationId=>createPlatformProfile({operationId,businessName:name.trim(),timezone,limits}),()=>{onDone(`Perfil ${name.trim()} creado. Invita ahora a su persona Dueño.`);setName('');});}
 return <section className="card" aria-labelledby={id}>
  <h2 id={id}>Crear perfil</h2>
  <form onSubmit={create}>
   <label>Nombre del negocio<input required maxLength={160} value={name} onChange={event=>setName(event.target.value)}/></label>
   <label>Zona horaria<select value={timezone} onChange={event=>setTimezone(event.target.value)}>{timezones.map(zone=><option key={zone} value={zone}>{zone}</option>)}</select></label>
   <LimitFields value={limits} onChange={setLimits} maxNumbers={freeNumbers}/>
   <p>Quedan {freeNumbers} números sin asignar en la plataforma.</p>
   {submit.error&&<p role="alert">{submit.error}</p>}
   <Button type="submit" disabled={submit.busy}>{submit.busy?'Creando…':'Crear perfil'}</Button>
  </form>
 </section>;
}
/** RF-02.c: the same actions through MCP with a platform token bound to this
 * admin. The bearer is shown once; afterwards only its metadata remains. */
function PlatformTokens({onDone}:{onDone:(message:string)=>void}){
 const id=useId(),[tokens,setTokens]=useState<PlatformToken[]>(),[name,setName]=useState('MCP de plataforma'),[days,setDays]=useState('30'),[scopes,setScopes]=useState<string[]>(['platform:profiles','platform:capacity']),[secret,setSecret]=useState(''),{busy,error,run}=useSubmit();
 const reload=()=>loadPlatformTokens().then(setTokens).catch(()=>setTokens([]));
 useEffect(()=>{void reload();},[]);
 function create(event:FormEvent){event.preventDefault();setSecret('');const span=Number(days);
  void run(async()=>{const issued=await issuePlatformToken({name,scopes,expiresAt:new Date(Date.now()+Math.min(90,Math.max(1,span))*86400000).toISOString()});setSecret(issued.token);},()=>{void reload();onDone('Acceso creado. Copia el token ahora: no se volverá a mostrar.');});}
 return <section className="card" aria-labelledby={id}>
  <h2 id={id}>Accesos MCP de plataforma</h2>
  <p>Permiten a un cliente MCP hacer las mismas acciones de esta página con tu cuenta. Caducan en un máximo de 90 días y dejan de funcionar si se revocan.</p>
  {error&&<p role="alert">{error}</p>}
  {secret&&<p role="status">Token (sólo se muestra una vez): <code className="platform-secret">{secret}</code></p>}
  <ul className="platform-tokens">{tokens?.map(t=><li key={t.id}><strong>{t.name}</strong> · {t.scopes.map(s=>platformScopeLabels[s]??s).join(', ')} · {t.revokedAt?'Revocado':'Vence '+dateTime.format(new Date(t.expiresAt))}
   {!t.revokedAt&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>{void run(()=>revokePlatformToken(t.id),()=>{void reload();onDone('Acceso revocado.');});}}>Revocar</Button>}</li>)}</ul>
  <form onSubmit={create}>
   <label>Nombre<input value={name} maxLength={100} required onChange={e=>setName(e.target.value)}/></label>
   <label>Vigencia en días<input inputMode="numeric" value={days} onChange={e=>setDays(e.target.value)}/></label>
   <fieldset><legend>Permisos</legend>{Object.entries(platformScopeLabels).map(([scope,label])=><label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={e=>setScopes(e.target.checked?[...scopes,scope]:scopes.filter(s=>s!==scope))}/> {label}</label>)}</fieldset>
   <Button type="submit" disabled={busy||!scopes.length}>Crear acceso</Button>
  </form>
 </section>;
}
