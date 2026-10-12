import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import type {ProfileOverview,ProfileRole} from '../../../../packages/contracts/src/profiles.js';
import {loadProfileSettings,saveProfileSettings,type ProfileRequestFence} from '../lib/profile-settings.js';
import {Button} from './ui/button';

/** Prepared for the complete server profile cutover; not mounted by legacy UI. */
export function ProfileSettings({selection,role}:{selection:ProfileRequestFence;role:ProfileRole}){
 const id=useId(),epoch=useRef(0),inflight=useRef(false);
 const[data,setData]=useState<ProfileOverview>(),[dataSelectionVersion,setDataSelectionVersion]=useState<number>(),[name,setName]=useState(''),[zone,setZone]=useState(''),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const currentData=data?.id===selection.workspaceId&&dataSelectionVersion===selection.version?data:undefined;
 const canEdit=role==='owner'&&currentData?.state==='ACTIVE';
 async function refresh(signal?:AbortSignal){
  const generation=++epoch.current;setLoading(true);setError('');setNotice('');
  try{const value=await loadProfileSettings(selection,signal);if(epoch.current===generation){setData(value);setDataSelectionVersion(selection.version);setName(value.business_name);setZone(value.timezone);setUncertain(false);}}
  catch(failure){if(epoch.current===generation&&!signal?.aborted){setData(undefined);setError(failure instanceof Error?failure.message:'No se pudo consultar el perfil.');}}
  finally{if(epoch.current===generation)setLoading(false);}
 }
 useEffect(()=>{const controller=new AbortController();setData(undefined);setSaving(false);setUncertain(false);inflight.current=false;void refresh(controller.signal);return()=>{epoch.current++;controller.abort();};},[selection.workspaceId,selection.version]);
 async function submit(event:FormEvent){
  event.preventDefault();if(!currentData||!canEdit||loading||saving||uncertain||inflight.current)return;
  const generation=epoch.current;inflight.current=true;setSaving(true);setError('');setNotice('');
  try{
   const result=await saveProfileSettings(selection,{expectedVersion:currentData.version,businessName:name,timezone:zone});
   if(epoch.current===generation){setData({...currentData,...result});setName(result.business_name);setZone(result.timezone);setNotice(result.changed?'Datos del negocio guardados.':'Los datos ya estaban actualizados.');}
  }catch(failure){if(epoch.current===generation){setUncertain(true);setError(failure instanceof Error?failure.message:'Actualiza los datos antes de volver a guardar.');}}
  finally{if(epoch.current===generation){inflight.current=false;setSaving(false);}}
 }
 return <section className="card" aria-labelledby={id}>
  <h2 id={id}>Datos del negocio</h2>
  <p>El nombre y la zona horaria pertenecen al perfil seleccionado.</p>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}{loading&&<p role="status">Consultando el perfil…</p>}
  {currentData&&<>
   {currentData.state==='SUSPENDED'&&<p>Este perfil está suspendido. Puedes consultar sus datos, pero no modificarlos.</p>}
   {role!=='owner'&&<p>La persona dueña del perfil puede editar estos datos.</p>}
   <form onSubmit={event=>{void submit(event);}}>
    <label htmlFor={id+'-name'}>Nombre del negocio</label>
    <input id={id+'-name'} value={name} maxLength={160} required disabled={!canEdit||loading||saving||uncertain} onChange={event=>setName(event.target.value)}/>
    <label htmlFor={id+'-zone'}>Zona horaria</label>
    <input id={id+'-zone'} value={zone} maxLength={128} required disabled={!canEdit||loading||saving||uncertain} aria-describedby={id+'-zone-help'} onChange={event=>setZone(event.target.value)}/>
    <p id={id+'-zone-help'}>Usa una zona como America/Mexico_City o UTC.</p>
    {canEdit&&<Button type="submit" disabled={loading||saving||uncertain}>{saving?'Guardando…':'Guardar datos'}</Button>}
   </form>
   <dl><dt>Límite de números</dt><dd>{currentData.number_limit}</dd><dt>Límite de productos</dt><dd>{currentData.product_limit}</dd><dt>Conversaciones diarias</dt><dd>{currentData.daily_conversation_limit}</dd></dl>
  </>}
  <Button type="button" variant="secondary" disabled={loading||saving} onClick={()=>{void refresh();}}>Actualizar datos</Button>
 </section>;
}
