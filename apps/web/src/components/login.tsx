import {useState,type FormEvent} from 'react';
import {ArrowUpRight,ChartNoAxesCombined,Layers3,LockKeyhole,MessageCircle,Package,ShieldCheck} from 'lucide-react';
import {api} from '../lib/api.js';
import {Alert,Button,Input} from './ui';

/** Sign-in for the V7 application. The password field is cleared before the
 * request leaves; nothing about the account is stored in the browser. */
export function Login({onSignedIn}:{onSignedIn?:()=>void}={}){
 const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[pending,setPending]=useState(false),[error,setError]=useState<Error|null>(null);
 async function login(e:FormEvent){
  e.preventDefault();setPending(true);setError(null);const submitted=password;setPassword('');
  try{await api('/api/auth/sign-in/email',{method:'POST',body:JSON.stringify({email,password:submitted})});onSignedIn?.();}
  catch(failure){setError(failure as Error);}finally{setPending(false);}
 }
 return <div className="login-page">
  <div className="login-story">
   <div className="app-brand"><span className="app-brand-mark"><Layers3 size={16} aria-hidden="true"/></span>Commerce OS</div>
   <div className="login-story-body">
    <span className="eyebrow">Contexto. Control. Crecimiento.</span>
    <h1>Tu operación<br/>comercial,<br/><em>conectada.</em></h1>
    <p>Un espacio para tus productos, conversaciones y resultados. Con claridad en cada paso.</p>
    <div className="login-circuit" aria-hidden="true"><Package/><i/><MessageCircle/><i/><ChartNoAxesCombined/></div>
   </div>
   <small>Commerce OS · Espacio privado de trabajo</small>
  </div>
  <div className="login-form-wrap">
   <div className="login-form">
    <span className="badge" data-tone="success"><ShieldCheck aria-hidden="true"/>Acceso del equipo</span>
    <h2>Bienvenido de nuevo</h2>
    <p>Ingresa con tu cuenta individual para continuar.</p>
    <form onSubmit={e=>{void login(e);}}>
     <div className="field"><label className="field-label" htmlFor="login-email">Correo electrónico</label><Input id="login-email" type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} required/></div>
     <div className="field"><label className="field-label" htmlFor="login-password">Contraseña</label><Input id="login-password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></div>
     {error&&<Alert tone="error">{error.message}</Alert>}
     <Button type="submit" disabled={pending} loading={pending}>Entrar a Commerce OS<ArrowUpRight aria-hidden="true"/></Button>
    </form>
    <a href="/forgot-password" className="recovery-back">Olvidé mi contraseña</a>
    <div className="login-note"><LockKeyhole aria-hidden="true" size={16}/><span>El registro público está cerrado. Tu administrador gestiona el acceso del equipo.</span></div>
   </div>
  </div>
 </div>;
}
