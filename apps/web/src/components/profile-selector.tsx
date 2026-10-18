import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {profileRoleLabels,type ProfileBootstrap} from '../../../../packages/contracts/src/profiles.js';
import {loadProfiles,selectProfile} from '../lib/profile-identity.js';
import {Alert,Button,Field,NativeSelect,Skeleton} from './ui';

/** Mounted only when the server's complete profile-auth cutover is active. */
export function ProfileSelector({initial,onConfirmed=()=>window.location.assign('/home')}:{initial?:ProfileBootstrap;onConfirmed?:(selection:{workspaceId:string;version:number})=>void}){
 const label=useId(),mounted=useRef(false),inflight=useRef(false),[data,setData]=useState(initial),[target,setTarget]=useState(initial?.selection.workspaceId??''),[pending,setPending]=useState(false),[loading,setLoading]=useState(!initial),[error,setError]=useState(''),[reconcile,setReconcile]=useState(false);
 const nativeSelection=data?.profiles.find(profile=>profile.id===data.selection.workspaceId&&profile.selected);
 const choice=data?.profiles.find(profile=>profile.id===target);
 async function refresh(signal?:AbortSignal){
  setLoading(true);setError('');
  try{const next=await loadProfiles(signal);if(mounted.current){setData(next);setTarget(next.selection.workspaceId??'');setReconcile(false);}}
  catch(failure){if(mounted.current&&!signal?.aborted)setError(failure instanceof Error?failure.message:'No se pudieron consultar tus perfiles.');}
  finally{if(mounted.current)setLoading(false);}
 }
 useEffect(()=>{mounted.current=true;const controller=new AbortController();if(!initial)void refresh(controller.signal);return()=>{mounted.current=false;controller.abort();};},[initial]);
 async function submit(event:FormEvent){
  event.preventDefault();if(!choice||!data||inflight.current||pending||loading||reconcile)return;
  if(nativeSelection?.id===target){onConfirmed({workspaceId:target,version:data.selection.version});return;}
  inflight.current=true;setPending(true);setError('');
  try{const selected=await selectProfile(target,data.selection.version);if(mounted.current)onConfirmed(selected);}
  catch(failure){if(mounted.current){setReconcile(true);setError(failure instanceof Error?failure.message:'No se pudo confirmar el cambio. Actualiza los perfiles antes de continuar.');}}
  finally{inflight.current=false;if(mounted.current)setPending(false);}
 }
 return <div className="stack" aria-labelledby={label}>
  <div><h2 id={label}>Elige el perfil de tu negocio</h2><p className="muted">El perfil determina los datos y permisos con los que vas a trabajar.</p></div>
  {nativeSelection&&<p className="muted">Perfil actual: <strong>{nativeSelection.businessName}</strong> · {profileRoleLabels[nativeSelection.role]}</p>}
  {error&&<Alert tone="error">{error}</Alert>}
  {loading&&<Skeleton lines={2} label="Consultando tus perfiles…"/>}
  {data?.profiles.length===0&&!loading&&<Alert tone="info">No tienes acceso a un perfil. Contacta a la persona responsable de tu negocio.</Alert>}
  {Boolean(data?.profiles.length)&&<form onSubmit={event=>{void submit(event);}} className="form">
   <Field label="Perfil" id={label+'-select'}><NativeSelect value={target} disabled={pending||loading||reconcile} onChange={event=>setTarget(event.target.value)}>
    <option value="">Selecciona un perfil</option>
    {data!.profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.businessName} · {profileRoleLabels[profile.role]}{profile.state==='SUSPENDED'?' · Suspendido':''}</option>)}
   </NativeSelect></Field>
   {choice?.state==='SUSPENDED'&&<Alert tone="warn">Este perfil está suspendido. Puedes consultar su información y gestionar la seguridad de tu cuenta; las operaciones comerciales están detenidas.</Alert>}
   <div className="form-actions"><Button type="submit" disabled={!choice||pending||loading||reconcile} loading={pending}>{nativeSelection?.id===target?'Continuar con este perfil':'Cambiar a este perfil'}</Button><Button type="button" variant="ghost" disabled={pending||loading} onClick={()=>{void refresh();}}>Actualizar perfiles</Button></div>
  </form>}
 </div>;
}
