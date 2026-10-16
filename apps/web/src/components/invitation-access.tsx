import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {invitationLinkTokenSchema} from '../../../../packages/contracts/src/profile-invitation-acceptance.js';
import type {ProfileBootstrap} from '../../../../packages/contracts/src/profiles.js';
import {ApiError} from '../lib/api.js';
import {loadProfiles} from '../lib/profile-identity.js';
import {loginInvitationSession} from '../lib/invitation-login.js';
import {takeInvitationToken} from '../lib/invitation-acceptance.js';
import {InvitationAcceptance} from './invitation-acceptance';
import {InvitationRegistration} from './invitation-registration';
import {ProfileSelector} from './profile-selector';
import {Button} from './ui/button';

type Selection={workspaceId:string;version:number};
type Props={invitationToken:string|null;onSelected:(selection:Selection)=>void};
/** Call exactly once at route bootstrap, before rendering or network requests. */
export function createInvitationAccessPage(onSelected:Props['onSelected']){
 const invitationToken=takeInvitationToken(window.location,window.history);
 return function InvitationAccessPage(){return <InvitationAccess invitationToken={invitationToken} onSelected={onSelected}/>;};
}
/** Prepared composition: no commercial route or application mount is implied. */
export function InvitationAccess({invitationToken,onSelected}:Props){
 if(!invitationLinkTokenSchema.safeParse(invitationToken).success)return <p role="alert">El enlace no es válido. Abre el enlace completo del correo de invitación.</p>;
 return <InvitationAccessSession key={invitationToken} invitationToken={invitationToken!} onSelected={onSelected}/>;
}
function InvitationAccessSession({invitationToken,onSelected}:Props&{invitationToken:string}){
 const label=useId(),live=useRef(false),busy=useRef(false),epoch=useRef(0);
 const [view,setView]=useState<'CHECKING'|'LOGIN'|'REGISTER'|'ACCEPT'|'PROFILES'|'UNKNOWN'>('CHECKING');
 const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[working,setWorking]=useState(false),[error,setError]=useState(''),[profiles,setProfiles]=useState<ProfileBootstrap>();
 async function check(next:'ACCEPT'|'PROFILES'='ACCEPT',signal?:AbortSignal){
  if(busy.current)return;busy.current=true;const generation=++epoch.current;setWorking(true);setError('');setProfiles(undefined);
  try{const result=await loadProfiles(signal);if(live.current&&generation===epoch.current){setProfiles(result);setView(next);}}
  catch(e){if(live.current&&generation===epoch.current&&!signal?.aborted){setView(e instanceof ApiError&&e.status===401?'LOGIN':'UNKNOWN');setError(e instanceof ApiError&&e.status===401?'Inicia sesión con el correo invitado para continuar.':'No se pudo comprobar tu sesión. Vuelve a consultar antes de continuar.');}}
  finally{if(live.current&&generation===epoch.current){busy.current=false;setWorking(false);}}
 }
 useEffect(()=>{live.current=true;const controller=new AbortController();busy.current=false;void check('ACCEPT',controller.signal);return()=>{live.current=false;epoch.current++;controller.abort();};},[]);
 async function login(event:FormEvent){
  event.preventDefault();if(busy.current||view!=='LOGIN')return;
  busy.current=true;const generation=++epoch.current,submittedPassword=password;setPassword('');setWorking(true);setError('');
  try{await loginInvitationSession({email,password:submittedPassword});if(live.current&&generation===epoch.current){busy.current=false;await check();}}
  catch{if(live.current&&generation===epoch.current){setView('UNKNOWN');setError('No se pudo confirmar el inicio de sesión. Comprueba la sesión antes de volver a enviar la contraseña.');}}
  finally{if(live.current&&generation===epoch.current){busy.current=false;setWorking(false);}}
 }
 return <section aria-labelledby={label}><h1 id={label}>Acceso por invitación</h1>
  {error&&<p role="alert">{error}</p>}{working&&<p role="status">Comprobando acceso…</p>}
  {view==='CHECKING'&&<p>Consultando tu sesión…</p>}
  {view==='LOGIN'&&<><form onSubmit={e=>{void login(e);}}><fieldset disabled={working}>
   <label>Correo electrónico<input type="email" name="email" autoComplete="username" maxLength={254} required value={email} onChange={e=>setEmail(e.target.value)}/></label>
   <label>Contraseña<input type="password" name="password" autoComplete="current-password" maxLength={128} required value={password} onChange={e=>setPassword(e.target.value)}/></label>
   <Button type="submit" disabled={working}>Iniciar sesión</Button>
  </fieldset></form><Button type="button" variant="secondary" disabled={working} onClick={()=>{setError('');setPassword('');setView('REGISTER');}}>Crear una cuenta con esta invitación</Button></>}
  {view==='REGISTER'&&<InvitationRegistration invitationToken={invitationToken} onLoginRequested={()=>{setView('LOGIN');setError('');}}/>}
  {view==='ACCEPT'&&<InvitationAcceptance invitationToken={invitationToken} onAccepted={()=>{void check('PROFILES');}}/>}
  {view==='PROFILES'&&profiles&&<ProfileSelector initial={profiles} onConfirmed={onSelected}/>}
  {view==='UNKNOWN'&&<Button type="button" disabled={working} onClick={()=>{void check();}}>Comprobar sesión</Button>}
 </section>;
}
