import {useEffect,useId,useRef,useState} from 'react';
import {profileRoleLabels,profileRoles,type ProfileRole,type ProfileState} from '../../../../packages/contracts/src/profiles.js';
import {invitationCreateSchema,type InvitationListed,type InvitationPage} from '../../../../packages/contracts/src/profile-invitations.js';
import type {ProfileRequestFence} from '../lib/profile-settings.js';
import {loadProfileInvitations,createProfileInvitation,findProfileInvitationOperation,cancelProfileInvitation} from '../lib/profile-invitations.js';
import {Button} from './ui/button';
import {ApiError} from '../lib/api.js';
type Draft={operationId:string;email:string;role:ProfileRole};
/** Prepared interface: sending and recipient acceptance are separate gates. */
export function ProfileInvitations({selection,role,state}:{selection:ProfileRequestFence;role:ProfileRole;state:ProfileState}){
 const title=useId(),epoch=useRef(0),busy=useRef(false),pending=useRef<Draft|undefined>(undefined);
 const[page,setPage]=useState<InvitationPage>(),[bound,setBound]=useState<ProfileRequestFence>(),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[uncertain,setUncertain]=useState(false),[retryReady,setRetryReady]=useState(false),[email,setEmail]=useState(''),[inviteRole,setInviteRole]=useState<ProfileRole>('operator'),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const current=role==='owner'&&bound?.workspaceId===selection.workspaceId&&bound.version===selection.version?page:undefined;
 const editable=role==='owner'&&state==='ACTIVE'&&!loading&&!saving&&!uncertain;
 async function refresh(afterId?:string,signal?:AbortSignal){
  if(busy.current)return;const generation=++epoch.current;setLoading(true);setError('');setNotice('');
  if(role!=='owner'){setPage(undefined);setLoading(false);return;}
  try{
   const operation=pending.current;const found=operation?await findProfileInvitationOperation(selection,operation.operationId):undefined;
   const result=await loadProfileInvitations(selection,afterId,signal);
   if(generation===epoch.current){setPage(result);setBound(selection);setUncertain(false);setRetryReady(Boolean(operation&&found===null));
    if(found){pending.current=undefined;setEmail('');setNotice('Solicitud registrada. Su estado de envío se muestra por separado.');}
    else if(operation)setNotice('La operación todavía no consta. Puedes repetir explícitamente la misma solicitud; conserva su identificador y contenido.');
    return true;
   }
  }catch(e){if(generation===epoch.current&&!signal?.aborted){setPage(undefined);setError(e instanceof Error?e.message:'No se pudieron consultar las invitaciones.');}}
  finally{if(generation===epoch.current)setLoading(false);}
 }
 useEffect(()=>{const controller=new AbortController();busy.current=false;pending.current=undefined;setPage(undefined);setSaving(false);setUncertain(false);setRetryReady(false);setEmail('');void refresh(undefined,controller.signal);return()=>{epoch.current++;controller.abort();};},[selection.workspaceId,selection.version,role]);
 async function create(){
  if(!editable||busy.current||!current)return;const parsed=invitationCreateSchema.safeParse(pending.current??{operationId:crypto.randomUUID(),email,role:inviteRole});if(!parsed.success){setError('Escribe un correo válido y elige un rol.');return;}
  const generation=epoch.current;busy.current=true;pending.current=parsed.data;setSaving(true);setError('');setNotice('');setRetryReady(false);
  try{const result=await createProfileInvitation(selection,parsed.data);if(generation===epoch.current){pending.current=undefined;setEmail('');busy.current=false;if(await refresh())setNotice(result.status==='CANCELLED'?'La solicitud ya estaba cancelada.':'Invitación registrada. Consulta su estado de envío en la lista.');}}
  catch(e){if(generation===epoch.current){if(e instanceof ApiError&&e.code==='INVITATION_ALREADY_PENDING'){pending.current=undefined;setRetryReady(false);}setUncertain(true);setError(e instanceof Error?e.message:'Consulta el estado antes de continuar.');}}
  finally{if(generation===epoch.current||!busy.current){busy.current=false;setSaving(false);}}
 }
 async function cancel(row:InvitationListed){
  if(!editable||busy.current||pending.current||row.status!=='PENDING')return;const generation=epoch.current;busy.current=true;setSaving(true);setError('');setNotice('');
  try{await cancelProfileInvitation(selection,row.id,row.version);if(generation===epoch.current){busy.current=false;if(await refresh())setNotice('Invitación cancelada. El enlace deja de ser utilizable.');}}
  catch(e){if(generation===epoch.current){setUncertain(true);setError(e instanceof Error?e.message:'Consulta el estado antes de continuar.');}}
  finally{if(generation===epoch.current||!busy.current){busy.current=false;setSaving(false);}}
 }
 return <section className="card" aria-labelledby={title}><h2 id={title}>Invitaciones</h2><p>Invita a una persona a este perfil. La cola de correo y la entrega tienen estados separados.</p>
 {role!=='owner'?<p>Solo Dueño puede consultar y gestionar invitaciones.</p>:<>
  {state==='SUSPENDED'&&<p>El perfil está suspendido. Las invitaciones permanecen en modo de consulta.</p>}
  {loading&&<p role="status">Consultando invitaciones…</p>}{notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
  <form onSubmit={event=>{event.preventDefault();void create();}}><fieldset disabled={!editable||Boolean(pending.current)}><legend>Nueva invitación</legend><label>Correo de la persona<input type="email" value={email} maxLength={254} required onChange={event=>setEmail(event.target.value)}/></label><label>Rol de la invitación<select value={inviteRole} onChange={event=>setInviteRole(event.target.value as ProfileRole)}>{profileRoles.map(value=><option key={value} value={value}>{profileRoleLabels[value]}</option>)}</select></label></fieldset>
  <Button type="submit" disabled={!editable||!current||Boolean(pending.current&&!retryReady)}>{retryReady?'Reintentar la misma solicitud':'Guardar invitación'}</Button></form>
  {current?.data.length===0&&<p>No hay invitaciones en esta página.</p>}
  <ul>{current?.data.map(row=><li key={row.id}><p>{row.email} — {profileRoleLabels[row.role]}</p><p>{row.status==='CANCELLED'?'Cancelada':row.delivery==='QUEUED'?'En cola; todavía no enviada':row.delivery==='ACCEPTED'?'Aceptada por el proveedor; recepción no acreditada':row.delivery==='UNCERTAIN'?'Resultado de envío incierto':row.status}</p><Button type="button" variant="secondary" disabled={!editable||Boolean(pending.current)||row.status!=='PENDING'} onClick={()=>{void cancel(row);}}>Cancelar invitación de {row.email}</Button></li>)}</ul>
  <Button type="button" variant="secondary" disabled={loading||saving} onClick={()=>{void refresh();}}>Consultar estado de invitaciones</Button>
  {current?.nextAfterId&&<Button type="button" variant="secondary" disabled={loading||saving||uncertain||Boolean(pending.current)} onClick={()=>{void refresh(current.nextAfterId!);}}>Siguiente página de invitaciones</Button>}
 </>}
 </section>;
}
