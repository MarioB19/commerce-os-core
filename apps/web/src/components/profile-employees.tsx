import {useEffect,useId,useRef,useState} from 'react';
import {profileRoleLabels,profileRoles,type ProfileEmployee,type ProfileRole,type ProfileState} from '../../../../packages/contracts/src/profiles.js';
import type {ProfileRequestFence} from '../lib/profile-settings.js';
import {loadProfileEmployees,saveProfileEmployee} from '../lib/profile-employees.js';
import {Alert,Button,Card,CardHead,Field,NativeCheck,NativeSelect,Skeleton} from './ui';

/** Staged administration; server authorization and final profile cutover required. */
export function ProfileEmployees({selection,role,state,currentUserId}:{selection:ProfileRequestFence;role:ProfileRole;state:ProfileState;currentUserId:string}){
 const id=useId(),epoch=useRef(0),inflight=useRef(false);
 const [rows,setRows]=useState<ProfileEmployee[]>(),[bound,setBound]=useState<ProfileRequestFence>(),[edits,setEdits]=useState<Record<string,{role:ProfileRole;active:boolean}>>({}),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const current=bound?.workspaceId===selection.workspaceId&&bound.version===selection.version&&role==='owner'?rows:undefined;
 const editable=role==='owner'&&state==='ACTIVE'&&!loading&&!saving&&!uncertain;
 async function refresh(signal?:AbortSignal){
  const generation=++epoch.current;setLoading(true);setError('');setNotice('');
  if(role!=='owner'){setRows(undefined);setLoading(false);return;}
  try{const data=await loadProfileEmployees(selection,signal);if(generation===epoch.current){setRows(data);setBound(selection);setEdits({});setUncertain(false);}}
  catch(e){if(generation===epoch.current&&!signal?.aborted){setRows(undefined);setError(e instanceof Error?e.message:'No se pudo consultar el acceso.');}}
  finally{if(generation===epoch.current)setLoading(false);}
 }
 useEffect(()=>{const controller=new AbortController();setRows(undefined);setUncertain(false);setSaving(false);inflight.current=false;void refresh(controller.signal);return()=>{epoch.current++;controller.abort();};},[selection.workspaceId,selection.version,role]);
 async function save(row:ProfileEmployee){
  if(!editable||!current||inflight.current||row.user_id===currentUserId)return;const edit=Object.hasOwn(edits,row.user_id)?edits[row.user_id]:undefined;if(!edit)return;
  const generation=epoch.current;inflight.current=true;setSaving(true);setError('');setNotice('');
  try{const result=await saveProfileEmployee(selection,row.user_id,{expectedVersion:row.version,...edit});if(generation===epoch.current){setRows(current.map(value=>value.user_id===row.user_id?{...value,role:result.role,active:result.active,version:result.version}:value));setEdits(previous=>{const next={...previous};delete next[row.user_id];return next;});setNotice(result.changed?'Acceso del empleado actualizado.':'El acceso ya estaba actualizado.');}}
  catch(e){if(generation===epoch.current){setUncertain(true);setError(e instanceof Error?e.message:'Actualiza los empleados antes de continuar.');}}
  finally{if(generation===epoch.current){inflight.current=false;setSaving(false);}}
 }
 return <Card aria-labelledby={id}>
  <CardHead id={id} title="Empleados" description="Los permisos se aplican al perfil seleccionado. Desactivar conserva el historial." actions={role==='owner'?<Button type="button" variant="ghost" size="sm" disabled={loading||saving} onClick={()=>{void refresh();}}>Actualizar empleados</Button>:undefined}/>
  {role!=='owner'?<p className="muted">Solo Dueño puede consultar y administrar empleados.</p>:<>
   {state==='SUSPENDED'&&<Alert tone="warn">Este perfil está suspendido. El acceso permanece en modo de consulta.</Alert>}
   {loading&&<Skeleton lines={3} label="Consultando empleados…"/>}{notice&&<Alert tone="success">{notice}</Alert>}{error&&<Alert tone="error">{error}</Alert>}
   {current?.length===0&&<p className="muted">No hay empleados registrados en este perfil.</p>}
   {current&&current.length>0&&<ul className="item-list employees">{current.map(row=>{const edit=Object.hasOwn(edits,row.user_id)?edits[row.user_id]:{role:row.role,active:row.active};return <li key={row.user_id}><fieldset disabled={!editable||row.user_id===currentUserId} className="plain employee">
    <legend><span className="row-title">{row.name}</span><span className="row-sub">{row.email}</span></legend>
    {row.user_id===currentUserId&&<p className="muted text-sm">Tu acceso se conserva; otra persona Dueño debe administrar cualquier cambio.</p>}
    <div className="cluster">
     <Field label={`Rol de ${row.name}`}><NativeSelect value={edit.role} onChange={event=>setEdits(previous=>({...previous,[row.user_id]:{...edit,role:event.target.value as ProfileRole}}))}>{profileRoles.map(value=><option key={value} value={value}>{profileRoleLabels[value]}</option>)}</NativeSelect></Field>
     <NativeCheck label={`Acceso activo de ${row.name}`} checked={edit.active} onChange={event=>setEdits(previous=>({...previous,[row.user_id]:{...edit,active:event.target.checked}}))}/>
     <Button type="button" variant="secondary" size="sm" disabled={!editable||!Object.hasOwn(edits,row.user_id)} onClick={()=>{void save(row);}}>Guardar acceso de {row.name}</Button>
    </div>
   </fieldset></li>;})}</ul>}
  </>}
 </Card>;
}
