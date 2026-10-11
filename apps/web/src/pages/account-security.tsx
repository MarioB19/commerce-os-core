import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Link} from '@tanstack/react-router';
import {Eye,EyeOff,ShieldCheck,ArrowLeft,Mail} from 'lucide-react';
import {Button} from '../components/ui/button';
import {useWorkspace} from '../components/shared';

type IdentityError=Error&{code?:string;status?:number};
export async function identityRequest(path:string,body?:unknown,method='POST'){
 if(path.startsWith('/v1/'))path += (path.includes('?')?'&':'?')+'environment=REAL';
 let response:Response;
 try{response=await fetch(path,{method:body===undefined?'GET':method,credentials:'include',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
 catch{throw Object.assign(new Error('No pudimos confirmar el resultado. No repitas el cambio automáticamente: intenta iniciar sesión con la nueva contraseña o recupera tu acceso.'),{code:'NETWORK_UNCERTAIN'});}
 const result=await response.json().catch(()=>null);
 if(!response.ok||!result){const code=result?.error?.code??result?.code??'UNKNOWN_RESULT';throw Object.assign(new Error(result?.error?.message??(response.status===429?'Hay demasiados intentos. Espera unos minutos.':'No pudimos confirmar el resultado. Vuelve a iniciar sesión o recupera tu acceso.')),{code,status:response.status});}
 return result;
}
function PasswordField({id,label,value,onChange,current=false,error}:{id:string;label:string;value:string;onChange:(value:string)=>void;current?:boolean;error?:string}){
 const [visible,setVisible]=useState(false);
 return <div className="field"><label htmlFor={id}>{label}</label><div className="password-control"><input id={id} name={id} type={visible?'text':'password'} autoComplete={current?'current-password':'new-password'} value={value} onChange={e=>onChange(e.target.value)} required maxLength={128} aria-invalid={!!error} aria-describedby={error?id+'-error':current?undefined:'password-guidance'} /><button type="button" className="icon-button" aria-label={`${visible?'Ocultar':'Mostrar'} ${label.toLowerCase()}`} aria-pressed={visible} onClick={()=>setVisible(!visible)}>{visible?<EyeOff size={19}/>:<Eye size={19}/>}</button></div>{error&&<span className="field-error" id={id+'-error'}>{error}</span>}</div>;
}
function PasswordForm({token,onSuccess,change=false}:{token?:string;onSuccess:()=>void;change?:boolean}){
 const [current,setCurrent]=useState(''),[next,setNext]=useState(''),[confirmation,setConfirmation]=useState('');
 const [errors,setErrors]=useState<Record<string,string>>({}),[error,setError]=useState<IdentityError|null>(null),[pending,setPending]=useState(false);
 const busy=useRef(false),form=useRef<HTMLFormElement>(null),summary=useRef<HTMLDivElement>(null);
 async function submit(e:FormEvent){
  e.preventDefault();if(busy.current)return;
  const fields:Record<string,string>={};
  if(change&&!current)fields.current='Escribe tu contraseña actual.';
  if(next.length<12||next.length>128)fields.next='Usa entre 12 y 128 caracteres.';
  else if(change&&current===next)fields.next='Elige una contraseña diferente.';
  if(next!==confirmation)fields.confirmation='La confirmación no coincide.';
  setErrors(fields);setError(null);
  if(Object.keys(fields).length){requestAnimationFrame(()=>form.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus());return;}
  busy.current=true;setPending(true);
  try{
   await identityRequest('/api/auth/'+(change?'change-password':'reset-password'),{...(change?{currentPassword:current}:{token}),newPassword:next,confirmPassword:confirmation});
   setCurrent('');setNext('');setConfirmation('');onSuccess();
  }catch(caught){const issue=caught as IdentityError;setError(issue);if(issue.code==='INVALID_PASSWORD'){setErrors({current:issue.message});requestAnimationFrame(()=>document.getElementById('current-password')?.focus());}else requestAnimationFrame(()=>summary.current?.focus());}
  finally{busy.current=false;setPending(false);}
 }
 return <form ref={form} onSubmit={e=>void submit(e)} noValidate aria-busy={pending}>
  {change&&<PasswordField id="current-password" label="Contraseña actual" current value={current} onChange={setCurrent} error={errors.current}/>}
  <PasswordField id="new-password" label="Nueva contraseña" value={next} onChange={setNext} error={errors.next}/>
  <p id="password-guidance" className="form-hint">Entre 12 y 128 caracteres. Puedes usar espacios, pegar y utilizar tu gestor de contraseñas.</p>
  <PasswordField id="confirm-password" label="Confirmar nueva contraseña" value={confirmation} onChange={setConfirmation} error={errors.confirmation}/>
  {change&&<div className="security-notice"><ShieldCheck size={19}/><span>Al cambiarla, se cerrarán tus otras sesiones. Continuarás en este dispositivo.</span></div>}
  {error&&<div ref={summary} tabIndex={-1} role="alert" className="security-error"><p>{error.message}</p>{['SESSION_EXPIRED','FRESH_SESSION_REQUIRED','UNAUTHORIZED','NETWORK_UNCERTAIN','UNKNOWN_RESULT'].includes(error.code??'')&&<p><a href="/login">Iniciar sesión</a> · <a href="/forgot-password">Recuperar acceso</a></p>}{error.code==='INVALID_TOKEN'&&<Link to="/forgot-password">Solicitar otro enlace</Link>}</div>}
  <Button disabled={pending} type="submit">{pending?'Guardando…':change?'Cambiar contraseña':'Restablecer contraseña'}</Button>
 </form>;
}
export function AccountSecurityPage(){
 const {session}=useWorkspace();const [done,setDone]=useState(false);const status=useRef<HTMLDivElement>(null);
 return <section className="account-security"><div className="page-heading"><span className="eyebrow">MI CUENTA</span><h1>Seguridad</h1><p>Gestiona el acceso a tu cuenta de Commerce OS.</p></div>
  <div className="security-card"><div className="security-identity"><span className="user-avatar" aria-hidden="true">{session.user.name.slice(0,2).toUpperCase()}</span><div><strong>{session.user.name}</strong><p>{session.user.email}</p></div></div><h2>Cambiar contraseña</h2><p className="form-hint">Tu cuenta es la misma en Simulación y Operación real.</p>
  {done&&<div ref={status} role="status" tabIndex={-1} className="security-success">Contraseña actualizada. Tus sesiones anteriores se cerraron y continuas con una sesión nueva en este dispositivo.</div>}
  <PasswordForm change onSuccess={()=>{setDone(true);requestAnimationFrame(()=>status.current?.focus());}}/></div></section>;
}
function RecoveryLayout({children}:{children:React.ReactNode}){return <main className="recovery-page"><div className="recovery-brand">Commerce <strong>OS</strong></div><section className="security-card recovery-card">{children}</section><p className="recovery-footer">Espacio privado de trabajo</p></main>;}
export function ForgotPasswordPage(){
 const [email,setEmail]=useState(''),[pending,setPending]=useState(false),[done,setDone]=useState(false),[error,setError]=useState<Error|null>(null);
 const busy=useRef(false),status=useRef<HTMLDivElement>(null);
 async function submit(e:FormEvent){e.preventDefault();if(busy.current)return;busy.current=true;setPending(true);setError(null);try{await identityRequest('/api/auth/request-password-reset',{email});setDone(true);setEmail('');}catch(err){setError(err as Error);}finally{busy.current=false;setPending(false);requestAnimationFrame(()=>status.current?.focus());}}
 return <RecoveryLayout><Mail className="recovery-icon" size={28}/><h1>Recupera tu acceso</h1><p>Escribe el correo de tu cuenta. Te enviaremos un enlace para elegir una nueva contraseña.</p>
  {done?<div className="security-success" role="status" tabIndex={-1} ref={status}>Si existe una cuenta activa con ese correo, recibirás instrucciones para recuperar el acceso. El enlace vence en 30 minutos. Revisa también la carpeta de correo no deseado.</div>:<form onSubmit={e=>void submit(e)} aria-busy={pending}><label className="field"><span>Correo electrónico</span><input type="email" name="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} required maxLength={254}/></label>{error&&<div className="security-error" role="alert" ref={status} tabIndex={-1}>{error.message}</div>}<Button type="submit" disabled={pending}>{pending?'Solicitando…':'Enviar enlace de recuperación'}</Button></form>}
  <Link className="recovery-back" to="/login"><ArrowLeft size={16}/>Volver a iniciar sesión</Link></RecoveryLayout>;
}
/** Called once before router creation. Token stays in this closure/component memory, never history/query cache. */
export function createResetPasswordPage(){
 const url=new URL(window.location.href);let incoming=url.pathname==='/reset-password'?(new URLSearchParams(url.hash.slice(1)).get('token')??url.searchParams.get('token')):null;
 if(url.pathname==='/reset-password')window.history.replaceState(null,'','/reset-password');
 return function ResetPasswordPage(){
  const [token,setToken]=useState(incoming),[done,setDone]=useState(false);const title=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{incoming=null;},[]);
  return <RecoveryLayout><ShieldCheck className="recovery-icon" size={28}/><h1 ref={title} tabIndex={-1}>{done?'Contraseña restablecida':'Elige una nueva contraseña'}</h1>
   {done?<><div role="status" className="security-success">Tu contraseña se actualizó. Se cerraron todas las sesiones de tu cuenta.</div><Link className="button-link" to="/login">Iniciar sesión</Link></>:token?<><p>Al guardar, se cerrarán todas las sesiones. Después deberás iniciar sesión de nuevo.</p><PasswordForm token={token} onSuccess={()=>{setToken(null);setDone(true);requestAnimationFrame(()=>title.current?.focus());}}/></>:<><p>El enlace no está disponible, venció o ya fue utilizado. Por seguridad, al recargar esta página necesitarás abrir el enlace del correo de nuevo.</p><Link to="/forgot-password">Solicitar otro enlace</Link></>}
   {!done&&<Link className="recovery-back" to="/login"><ArrowLeft size={16}/>Volver a iniciar sesión</Link>}</RecoveryLayout>;
 };
}
