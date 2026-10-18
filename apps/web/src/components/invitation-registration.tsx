import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {invitationLinkTokenSchema} from '../../../../packages/contracts/src/profile-invitation-acceptance.js';
import {invitationRegistrationSchema} from '../../../../packages/contracts/src/profile-invitation-registration.js';
import {registerInvitationIdentity} from '../lib/invitation-registration.js';
import {ApiError} from '../lib/api.js';
import {Alert,Button,Field,Input} from './ui';

/** Prepared view. Login callback keeps the parent's invitation only in RAM. */
export function InvitationRegistration({invitationToken,onLoginRequested}:{invitationToken:string|null;onLoginRequested:()=>void}){
 const title=useId(),epoch=useRef(0),busy=useRef(false);
 const [name,setName]=useState(''),[email,setEmail]=useState(''),[password,setPassword]=useState('');
 const [state,setState]=useState<'EDITING'|'SENDING'|'CREATED'|'LOGIN'|'UNKNOWN'>('EDITING'),[error,setError]=useState('');
 const [bound,setBound]=useState(invitationToken),valid=invitationLinkTokenSchema.safeParse(invitationToken).success;
 const current=bound===invitationToken?state:'EDITING',canEdit=current==='EDITING';
 useEffect(()=>{epoch.current++;busy.current=false;setName('');setEmail('');setPassword('');setError('');setState('EDITING');setBound(invitationToken);return()=>{epoch.current++;};},[invitationToken]);
 async function submit(event:FormEvent){
  event.preventDefault();if(!valid||!canEdit||busy.current)return;
  const input=invitationRegistrationSchema.safeParse({token:invitationToken,name,email,password});
  if(!input.success){setError('Completa el nombre, un correo válido y una contraseña de 12 a 128 caracteres.');return;}
  const generation=epoch.current;busy.current=true;setState('SENDING');setError('');setPassword('');
  try{await registerInvitationIdentity(input.data);if(epoch.current===generation)setState('CREATED');}
  catch(e){if(epoch.current===generation){
   if(e instanceof ApiError&&e.code==='INVITATION_REGISTRATION_REJECTED'){setState('EDITING');setError(e.message);}
   else if(e instanceof ApiError&&e.code==='INVITATION_REGISTRATION_LOGIN_REQUIRED'){setState('LOGIN');setError(e.message);}
   else{setState('UNKNOWN');setError('No se pudo confirmar el alta. Inicia sesión con los datos que enviaste y comprueba la invitación.');}
  }}finally{if(epoch.current===generation)busy.current=false;}
 }
 return <section aria-labelledby={title} className="stack"><h2 id={title}>Crear cuenta con invitación</h2>
  {!valid?<Alert tone="error">El enlace no es válido. Abre el enlace completo del correo de invitación.</Alert>:<>
   <p className="muted">Usa el correo que recibió la invitación. La cuenta se incorporará al perfil y rol indicados por quien te invitó.</p>
   {error&&<Alert tone="error">{error}</Alert>}
   {current==='CREATED'?<Alert tone="success">Cuenta creada e invitación aceptada. Inicia sesión para continuar.</Alert>:null}
   {(canEdit||current==='SENDING')&&<form onSubmit={event=>{void submit(event);}} className="form">
    <fieldset disabled={!canEdit} className="plain">
     <Field label="Nombre"><Input name="name" autoComplete="name" required maxLength={120} value={name} onChange={e=>setName(e.target.value)}/></Field>
     <Field label="Correo invitado"><Input name="email" type="email" autoComplete="email" required maxLength={320} value={email} onChange={e=>setEmail(e.target.value)}/></Field>
     <Field label="Contraseña" help="De 12 a 128 caracteres."><Input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/></Field>
     <div className="form-actions"><Button type="submit" disabled={!canEdit} loading={current==='SENDING'}>Crear cuenta y aceptar</Button><Button type="button" variant="secondary" disabled={current==='SENDING'} onClick={onLoginRequested}>Iniciar sesión y comprobar invitación</Button></div>
    </fieldset>
   </form>}
  </>}
 </section>;
}
