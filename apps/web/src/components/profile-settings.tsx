import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import type {ProfileOverview,ProfileRole} from '../../../../packages/contracts/src/profiles.js';
import {downloadProfileExport,loadProfileSettings,saveProfileSettings,type ProfileRequestFence} from '../lib/profile-settings.js';
import {Alert,Button,Card,CardHead,Field,Input,Skeleton} from './ui';
import {Download} from 'lucide-react';

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
 return <div className="stack" style={{gap:'var(--space-5)'}}>
  <Card aria-labelledby={id}>
   <CardHead id={id} title="Datos del negocio" description="El nombre y la zona horaria pertenecen al perfil seleccionado." actions={<Button type="button" variant="ghost" size="sm" disabled={loading||saving} onClick={()=>{void refresh();}}>Actualizar datos</Button>}/>
   {error&&<Alert tone="error">{error}</Alert>}{notice&&<Alert tone="success">{notice}</Alert>}{loading&&<Skeleton lines={2} label="Consultando el perfil…"/>}
   {currentData&&<>
    {currentData.state==='SUSPENDED'&&<Alert tone="warn">Este perfil está suspendido. Puedes consultar sus datos, pero no modificarlos.</Alert>}
    {role!=='owner'&&<p className="muted text-sm">La persona dueña del perfil puede editar estos datos.</p>}
    <form onSubmit={event=>{void submit(event);}} className="form">
     <div className="form-grid">
      <Field label="Nombre del negocio" id={id+'-name'}><Input value={name} maxLength={160} required disabled={!canEdit||loading||saving||uncertain} onChange={event=>setName(event.target.value)}/></Field>
      <Field label="Zona horaria" id={id+'-zone'} help="Usa una zona como America/Mexico_City o UTC."><Input value={zone} maxLength={128} required disabled={!canEdit||loading||saving||uncertain} onChange={event=>setZone(event.target.value)}/></Field>
     </div>
     {canEdit&&<div className="form-actions"><Button type="submit" disabled={loading||saving||uncertain} loading={saving}>Guardar datos</Button></div>}
    </form>
    <dl className="facts"><div><dt>Límite de números</dt><dd>{currentData.number_limit}</dd></div><div><dt>Límite de productos</dt><dd>{currentData.product_limit}</dd></div><div><dt>Conversaciones diarias</dt><dd>{currentData.daily_conversation_limit}</dd></div></dl>
   </>}
  </Card>
  {role==='owner'&&<ProfileDataExport selection={selection}/>}
 </div>;
}

/** RF-01.5: readable export of the profile's own data, owner only. */
function ProfileDataExport({selection}:{selection:ProfileRequestFence}){
 const id=useId(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState<{sha256:string;bytes:number}>();
 async function run(){
  if(busy)return;setBusy(true);setError('');setDone(undefined);
  try{const result=await downloadProfileExport(selection);setDone({sha256:result.sha256,bytes:result.bytes});}
  catch(failure){setError(failure instanceof Error?failure.message:'No se pudo descargar la exportación.');}
  finally{setBusy(false);}
 }
 return <Card aria-labelledby={id}>
  <CardHead id={id} title="Exportar datos del perfil" level={2} description="Descarga un archivo legible (JSON por líneas, comprimido) con productos, variantes, números, contactos, conversaciones, ventas y comprobantes de este perfil. No incluye llaves, tokens ni contraseñas. La plataforma sólo guarda la huella del archivo."/>
  {error&&<Alert tone="error">{error}</Alert>}
  {done&&<Alert tone="success">Exportación descargada ({Math.max(1,Math.round(done.bytes/1024))} KB). Huella: <code>{done.sha256.slice(0,16)}…</code></Alert>}
  <div><Button type="button" variant="secondary" disabled={busy} loading={busy} onClick={()=>{void run();}}><Download aria-hidden="true"/>Exportar datos</Button></div>
 </Card>;
}
