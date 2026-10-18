import {useEffect,useState,useRef,type FormEvent} from 'react';
import {Alert,Badge,Button,Card,CardHead,Field,Input,NativeCheck,NativeSelect} from './ui';
import {api} from '../lib/api.js';
type Config={mode:'local'|'remote';host:string;port:number;tls:'none'|'starttls'|'implicit';from:string;name:string};
type Metadata={version:number;enabled:boolean;config:Config|null;credentials_configured:boolean;diagnostic:string;diagnosed_at:string|null};
type Job={id:string;status:string;attempts:number;diagnostic_code:string;created_at:string};
const statuses:Record<string,string>={PENDING:'Pendiente',SENDING:'En proceso',ACCEPTED:'Aceptado por SMTP · recepción sin confirmar',FAILED:'Fallido',EXPIRED:'Vencido',UNCERTAIN:'Resultado incierto · sin reenvío automático',CANCELLED:'Enlace invalidado'};
const diagnostics:Record<string,string>={NOT_CONFIGURED:'Sin configurar',SMTP_CONNECTION_OK:'Conexión y autenticación SMTP verificadas. No se envió ningún mensaje.',SMTP_UNREACHABLE:'No se pudo conectar con el servidor SMTP.',SMTP_AUTH_FAILED:'El servidor rechazó las credenciales.',SMTP_TLS_FAILED:'No se pudo establecer una conexión TLS segura.',SMTP_OUTCOME_UNKNOWN:'No se pudo confirmar el diagnóstico.',SMTP_REJECTED:'El servidor rechazó la operación.',SMTP_ACCEPTED:'Aceptado por SMTP; recepción sin confirmar.',SMTP_TEMPORARY_REJECTION:'Rechazo temporal del servidor SMTP.'};
/** V7 F8: installation-wide transactional mail (password recovery), only for
 * platform administrators. Credentials are written once and never returned. */
export function PlatformMail(){
 const [metadata,setMetadata]=useState<Metadata|null>(null),[config,setConfig]=useState<Config>({mode:'local',host:'localhost',port:25,tls:'none',from:'',name:'Commerce OS'}),[enabled,setEnabled]=useState(false);
 const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[clear,setClear]=useState(false),[jobs,setJobs]=useState<Job[]>([]),[pending,setPending]=useState(false),[error,setError]=useState<Error|null>(null),[notice,setNotice]=useState('');
 const busy=useRef(false),feedback=useRef<HTMLDivElement>(null);
 const isResend=config.mode==='remote'&&config.host.toLowerCase()==='smtp.resend.com';
 const changedServer=Boolean(metadata?.config&&metadata.credentials_configured&&(metadata.config.host.toLowerCase()!==config.host.toLowerCase()||metadata.config.mode!==config.mode));
 function useResend(){setConfig(c=>({...c,mode:'remote',host:'smtp.resend.com',port:465,tls:'implicit'}));setUsername('resend');setPassword('');setClear(false);setEnabled(false);setError(null);setNotice('Resend preparado en el formulario. Revisa el remitente e introduce la API key. Al guardar, el envío quedará deshabilitado; hasta entonces sigue vigente la configuración actual.');}
 async function load(){const m=await api<Metadata>('/v2/platform/mail');setMetadata(m);setEnabled(m.enabled);if(m.config)setConfig(m.config);setJobs(await api<Job[]>('/v2/platform/mail/jobs'));}
 useEffect(()=>{void load().catch(setError);},[]);
 const update=<K extends keyof Config>(key:K,value:Config[K])=>setConfig(previous=>({...previous,[key]:value}));
 async function save(e:FormEvent){e.preventDefault();if(busy.current)return;busy.current=true;setPending(true);setError(null);setNotice('');try{await api('/v2/platform/mail',{method:'PUT',body:JSON.stringify({expected_version:metadata?.version??0,enabled,config,...(username?{username}:{}),...(password?{password}:{}),...(clear?{clear_credentials:true}:{})})});setUsername('');setPassword('');setClear(false);await load();setNotice('Configuración guardada. Los siguientes correos usarán esta revisión.');}catch(err){setError(err as Error);}finally{busy.current=false;setPending(false);requestAnimationFrame(()=>feedback.current?.focus());}}
 async function diagnose(){if(busy.current)return;busy.current=true;setPending(true);setError(null);try{const r=await api<{code:string}>('/v2/platform/mail/diagnose',{method:'POST',body:'{}'});setNotice(diagnostics[r.code]??'Revisa la configuración del servidor.');await load();}catch(err){setError(err as Error);}finally{busy.current=false;setPending(false);requestAnimationFrame(()=>feedback.current?.focus());}}
 return <Card aria-labelledby="platform-mail">
  <CardHead id="platform-mail" title="Correo transaccional" description="Recuperación de acceso para todas las cuentas de la instalación. Esta configuración es común a Real y Simulación. La recepción de un correo debe comprobarse por separado de la aceptación SMTP." actions={<Button type="button" variant="secondary" size="sm" disabled={pending||!metadata} onClick={useResend}>Configurar Resend</Button>}/>
  {isResend&&<Alert tone="info" role="note">Usa una API key de Resend con permiso de envío para el dominio de tu remitente. Se guarda cifrada y nunca se devuelve al navegador.</Alert>}
  <form onSubmit={e=>void save(e)} aria-busy={pending} className="form">
   <Field label="Envío de recuperación"><NativeSelect value={enabled?'enabled':'disabled'} onChange={e=>setEnabled(e.target.value==='enabled')}><option value="disabled">Deshabilitado</option><option value="enabled">Habilitado</option></NativeSelect></Field>
   <div className="form-grid">
    <Field label="Modalidad"><NativeSelect value={config.mode} onChange={e=>{const mode=e.target.value as Config['mode'];setConfig(c=>({...c,mode,port:mode==='remote'?587:25,tls:mode==='remote'?'starttls':'none'}));}}><option value="local">SMTP local del VPS</option><option value="remote">Servidor SMTP de salida</option></NativeSelect></Field>
    <Field label="Host SMTP"><Input value={config.host} onChange={e=>update('host',e.target.value)} required autoComplete="off"/></Field>
    <Field label="Puerto"><Input type="number" min={1} max={65535} value={config.port} onChange={e=>update('port',Number(e.target.value))} required/></Field>
    <Field label="Seguridad de conexión"><NativeSelect value={config.tls} onChange={e=>update('tls',e.target.value as Config['tls'])}>{config.mode==='local'&&<option value="none">Red privada autorizada</option>}<option value="starttls">STARTTLS obligatorio (587)</option><option value="implicit">TLS implícito (465)</option></NativeSelect></Field>
    <Field label="Correo remitente"><Input type="email" value={config.from} onChange={e=>update('from',e.target.value)} required/></Field>
    <Field label="Nombre visible"><Input value={config.name} onChange={e=>update('name',e.target.value)} required maxLength={160}/></Field>
   </div>
   <p className="muted text-sm">El host, puerto y direcciones de salida deben estar permitidos en la configuración protegida del servidor. Guardar esta pantalla no instala un MTA ni configura DNS.</p>
   {config.mode==='remote'&&<><p className="muted text-sm">Credenciales: {metadata?.credentials_configured?'guardadas; deja los campos vacíos para conservarlas':'sin configurar'}. Nunca se muestran las credenciales guardadas.</p><div className="form-grid"><Field label="Usuario SMTP"><Input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="off" disabled={clear}/></Field><Field label={isResend?'API key de Resend':'Contraseña SMTP'}><Input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="new-password" disabled={clear} required={!clear&&(changedServer||!metadata?.credentials_configured)}/></Field></div></>}
   {changedServer&&!clear&&<Alert tone="warn">Al cambiar de servidor debes introducir una credencial nueva o eliminar la anterior.</Alert>}
   {metadata?.credentials_configured&&<NativeCheck label="Eliminar las credenciales guardadas" checked={clear} onChange={e=>{setClear(e.target.checked);setUsername('');setPassword('');}}/>}
   <div className="form-actions"><Button type="submit" variant="secondary" disabled={pending||!metadata}>Guardar configuración</Button></div>
  </form>
  <div ref={feedback} tabIndex={-1} role={error?'alert':'status'} className="variant-feedback">{error&&<Alert tone="error" role="none">{error.message}</Alert>}{notice&&<Alert tone="success" role="none">{notice}</Alert>}</div>
  <h3>Diagnóstico</h3><p className="muted">{diagnostics[metadata?.diagnostic??'NOT_CONFIGURED']??'Sin diagnóstico disponible'}</p><div><Button type="button" variant="secondary" size="sm" disabled={pending||!metadata?.config} onClick={()=>void diagnose()}>Comprobar conexión sin enviar correo</Button></div>
  <h3>Solicitudes recientes</h3><p className="muted text-sm">Aceptado significa que el servidor SMTP recibió el mensaje para procesarlo; no confirma entrega al destinatario.</p>
  {jobs.length?<ul className="item-list">{jobs.map(job=><li key={job.id}><Badge tone={job.status==='ACCEPTED'?'success':job.status==='FAILED'||job.status==='EXPIRED'?'error':job.status==='UNCERTAIN'?'warn':'neutral'}>{statuses[job.status]}</Badge><span className="muted text-sm">{new Date(job.created_at).toLocaleString('es-MX')} · Intentos: {job.attempts}</span></li>)}</ul>:<p className="muted">Aún no hay solicitudes de correo.</p>}
 </Card>;
}
