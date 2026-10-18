import {useEffect,useId,useRef,useState} from 'react';
import {invitationLinkTokenSchema} from '../../../../packages/contracts/src/profile-invitation-acceptance.js';
import {acceptInvitationLink,readInvitationAcceptance} from '../lib/invitation-acceptance.js';
import {Alert,Button,Skeleton} from './ui';

/** Prepared recipient view; the route bootstrap extracts/removes the fragment.
 * No request selects a profile or registers a new identity. */
export function InvitationAcceptance({invitationToken,onAccepted}:{invitationToken:string|null;onAccepted?:()=>void}){
 const title=useId(),epoch=useRef(0),busy=useRef(false);
 const [state,setState]=useState<'READING'|'PENDING'|'ACCEPTED'|'UNKNOWN'>('READING'),[bound,setBound]=useState<string|null>(null),[working,setWorking]=useState(false),[error,setError]=useState('');
 const valid=invitationLinkTokenSchema.safeParse(invitationToken).success,current=bound===invitationToken?state:'READING';
 async function check(signal?:AbortSignal){
  if(!valid||busy.current)return;const generation=++epoch.current;busy.current=true;setWorking(true);setError('');
  try{const result=await readInvitationAcceptance(invitationToken!,signal);if(generation===epoch.current){setState(result.state);setBound(invitationToken);}}
  catch{if(generation===epoch.current&&!signal?.aborted){setState('UNKNOWN');setBound(invitationToken);setError('No se pudo comprobar el estado. Inicia sesión con el correo invitado y vuelve a consultar.');}}
  finally{if(generation===epoch.current){busy.current=false;setWorking(false);}}
 }
 useEffect(()=>{const controller=new AbortController();busy.current=false;setBound(null);setState('READING');setWorking(false);setError('');void check(controller.signal);return()=>{epoch.current++;controller.abort();};},[invitationToken]);
 async function accept(){
  if(!valid||busy.current||current!=='PENDING')return;const generation=epoch.current;busy.current=true;setWorking(true);setError('');
  try{await acceptInvitationLink(invitationToken!);if(generation===epoch.current){setState('ACCEPTED');setBound(invitationToken);}}
  catch{if(generation===epoch.current){setState('UNKNOWN');setBound(invitationToken);setError('El resultado no está confirmado. Comprueba el estado antes de aceptar otra vez.');}}
  finally{if(generation===epoch.current){busy.current=false;setWorking(false);}}
 }
 return <section aria-labelledby={title} className="stack"><h2 id={title}>Aceptar invitación</h2>
  {!valid?<Alert tone="error">El enlace no es válido. Abre el enlace completo del correo de invitación.</Alert>:<>
   <p className="muted">Inicia sesión con el correo que recibió la invitación. La aceptación incorpora ese usuario al perfil invitado.</p>
   {working&&<Skeleton lines={1} label="Comprobando la invitación…"/>}{error&&<Alert tone="error">{error}</Alert>}
   {current==='ACCEPTED'?<><Alert tone="success">Invitación aceptada. Puedes elegir el perfil desde tu sesión.</Alert>{onAccepted&&<div><Button type="button" disabled={working} onClick={onAccepted}>Elegir perfil</Button></div>}</>:<>
    {current==='PENDING'&&<p>La invitación está pendiente. Puedes aceptarla con tu sesión actual.</p>}
    <div className="form-actions"><Button type="button" disabled={working||current!=='PENDING'} onClick={()=>{void accept();}}>Aceptar invitación</Button><Button type="button" variant="secondary" disabled={working} onClick={()=>{void check();}}>Comprobar estado</Button></div>
   </>}
  </>}
 </section>;
}
