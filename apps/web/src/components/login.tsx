import {useState,type FormEvent} from 'react';
import {AlertCircle,ArrowUpRight,ChartNoAxesCombined,Layers3,LockKeyhole,MessageCircle,Package,ShieldCheck} from 'lucide-react';
import {api} from '../lib/api.js';
import {Button} from './ui/button.js';

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
   <div className="brand"><span className="brand-mark"><Layers3 size={23}/></span>Commerce <strong>OS</strong></div>
   <div className="login-story-body">
    <span className="eyebrow">CONTEXTO. CONTROL. CRECIMIENTO.</span>
    <h1>Tu operación<br/>comercial,<br/><em>conectada.</em></h1>
    <p>Un espacio para tus productos, conversaciones y resultados. Con claridad en cada paso.</p>
    <div className="login-circuit"><Package/><i/><MessageCircle/><i/><ChartNoAxesCombined/></div>
   </div>
   <small>Commerce OS · Espacio privado de trabajo</small>
  </div>
  <div className="login-form-wrap">
   <div className="login-form">
    <span className="badge badge-success"><ShieldCheck size={13}/> ACCESO DEL EQUIPO</span>
    <h2>Bienvenido de nuevo</h2>
    <p>Ingresa con tu cuenta individual para continuar.</p>
    <form onSubmit={e=>{void login(e);}}>
     <label className="field"><span>Correo electrónico</span><input type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} required placeholder="tu@equipo.com"/></label>
     <label className="field"><span>Contraseña</span><input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required placeholder="Tu contraseña"/></label>
     {error&&<div className="inline-error" role="alert"><AlertCircle size={16}/><div><strong>{error.message}</strong></div></div>}
     <Button type="submit" disabled={pending} className="login-submit">{pending?'Ingresando…':'Entrar a Commerce OS'}<ArrowUpRight/></Button>
    </form>
    <a href="/forgot-password" className="recovery-back">Olvidé mi contraseña</a>
    <div className="login-note"><LockKeyhole size={15}/><span>El registro público está cerrado. Tu administrador gestiona el acceso del equipo.</span></div>
   </div>
  </div>
 </div>;
}
