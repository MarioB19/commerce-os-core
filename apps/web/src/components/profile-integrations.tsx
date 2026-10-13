import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import {aiProviderLabels,aiStateText,failureText,loadIntegrations,metaStateText,saveAiKey,saveAiPreferences,saveMetaToken,setAiKeyEnabled,setMetaEnabled,usd,type AiProvider,type AiProviderStatus,type Integrations} from '../lib/profile-integrations.js';
import type {ProfileFence} from '../lib/profile-request.js';
import {Button} from './ui/button';

/** RF-13.a: the profile's only configuration areas besides employees — its own
 * AI keys and its own Meta token. Secrets are write-only; the page shows the
 * last four characters and the result of the single verification. */
export function ProfileIntegrations({selection,role,state}:{selection:ProfileFence;role:ProfileRole;state:ProfileState}){
 const [data,setData]=useState<Integrations>(),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),epoch=useRef(0);
 const owner=role==='owner'&&state==='ACTIVE';
 async function refresh(signal?:AbortSignal){const generation=++epoch.current;setError('');try{const value=await loadIntegrations(selection,signal);if(epoch.current===generation)setData(value);}catch(failure){if(epoch.current===generation&&!signal?.aborted)setError(failure instanceof Error?failure.message:'No se pudieron consultar las integraciones.');}}
 useEffect(()=>{const controller=new AbortController();setData(undefined);void refresh(controller.signal);return()=>{epoch.current++;controller.abort();};},[selection.workspaceId,selection.version]);
 async function act(work:()=>Promise<string|void>){if(busy)return;setBusy(true);setError('');setNotice('');try{const message=await work();if(message)setNotice(message);}catch(failure){setError(failure instanceof Error?failure.message:'No se pudo completar la acción.');}finally{setBusy(false);}}
 if(role==='viewer')return <section className="card"><h1>Integraciones</h1><p>Las integraciones solo están disponibles para Dueño y Operador.</p></section>;
 return <section className="profile-integrations" aria-busy={!data&&!error}>
  <h1>Integraciones</h1>
  <p>Este negocio usa sus propias claves de IA y su propio token de Meta. Nadie más puede leerlas: después de guardarlas solo verás sus últimos cuatro caracteres.</p>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {!data&&!error&&<p role="status">Consultando integraciones…</p>}
  {data&&<>
   <AiSection data={data} owner={owner} busy={busy} selection={selection} act={act} setData={setData} refresh={()=>refresh()}/>
   <MetaSection data={data} owner={owner} busy={busy} selection={selection} act={act} setData={setData} refresh={()=>refresh()}/>
  </>}
 </section>;
}
type SectionProps={data:Integrations;owner:boolean;busy:boolean;selection:ProfileFence;act:(work:()=>Promise<string|void>)=>Promise<void>;setData:(d:Integrations)=>void;refresh:()=>Promise<void>};
function AiSection({data,owner,busy,selection,act,setData,refresh}:SectionProps){
 const id=useId(),prefs=data.ai.preferences,[limit,setLimit]=useState(prefs.monthlyLimitMicrousd?String(prefs.monthlyLimitMicrousd/1_000_000):''),[model,setModel]=useState(prefs.defaultProvider&&prefs.defaultModel?prefs.defaultProvider+'/'+prefs.defaultModel:'');
 useEffect(()=>{setLimit(prefs.monthlyLimitMicrousd?String(prefs.monthlyLimitMicrousd/1_000_000):'');setModel(prefs.defaultProvider&&prefs.defaultModel?prefs.defaultProvider+'/'+prefs.defaultModel:'');},[prefs.version]);
 const verified=new Set(data.ai.providers.filter(p=>p.state==='VERIFIED').map(p=>p.provider));
 function savePreferences(event:FormEvent){event.preventDefault();void act(async()=>{
  const dollars=Number(limit);if(!Number.isFinite(dollars)||dollars<1||dollars>100000)throw new Error('Escribe un límite mensual entre 1 y 100,000 USD.');
  const [p,m]=model?model.split('/') as [AiProvider,string]:[null,null];
  await saveAiPreferences(selection,{expectedVersion:prefs.version,monthlyLimitMicrousd:Math.round(dollars*100)*10_000,defaultProvider:p,defaultModel:m});await refresh();return'Preferencias de IA guardadas.';});}
 return <section className="card" aria-labelledby={id}>
  <h2 id={id}>Inteligencia artificial</h2>
  <p>Guarda la clave de al menos un proveedor. Al guardarla hacemos una única consulta mínima con ella para comprobar que funciona; ese costo se descuenta de tu límite mensual.</p>
  {data.ai.budget?<p>Este mes: {usd(data.ai.budget.usedMicrousd)} usados de {usd(data.ai.budget.limitMicrousd)}.</p>:<p>Aún no hay un límite mensual activo.</p>}
  <form onSubmit={savePreferences} className="integration-preferences">
   <label htmlFor={id+'-limit'}>Límite mensual de IA (USD)</label>
   <input id={id+'-limit'} inputMode="decimal" value={limit} disabled={!owner||busy} onChange={e=>setLimit(e.target.value)} aria-describedby={id+'-limit-help'}/>
   <p id={id+'-limit-help'}>Un cambio aplica a partir del siguiente periodo; el mes en curso conserva su límite.</p>
   <label htmlFor={id+'-model'}>Modelo predeterminado</label>
   <select id={id+'-model'} value={model} disabled={!owner||busy} onChange={e=>setModel(e.target.value)}>
    <option value="">Sin elegir</option>
    {data.ai.models.filter(m=>m.capabilities.includes('chat')).map(m=><option key={m.provider+'/'+m.model} value={m.provider+'/'+m.model} disabled={!verified.has(m.provider)}>{aiProviderLabels[m.provider]} · {m.model}{verified.has(m.provider)?'':' (requiere clave verificada)'}</option>)}
   </select>
   {owner&&<Button type="submit" disabled={busy}>Guardar preferencias</Button>}
  </form>
  <ul className="integration-list">{data.ai.providers.map(p=><AiProviderRow key={p.provider} status={p} owner={owner} busy={busy} selection={selection} act={act} setData={setData} refresh={refresh}/>)}</ul>
 </section>;
}
function AiProviderRow({status,owner,busy,selection,act,setData,refresh}:{status:AiProviderStatus}&Omit<SectionProps,'data'>){
 const id=useId(),[key,setKey]=useState(''),[open,setOpen]=useState(false);
 function save(event:FormEvent){event.preventDefault();const value=key.trim();setKey('');void act(async()=>{
  const result=await saveAiKey(selection,status.provider,status.revision,value);setData(result.integrations);setOpen(false);
  return result.verification.state==='VERIFIED'?`Clave de ${aiProviderLabels[status.provider]} verificada.`:`Clave guardada. ${failureText[result.verification.code??'']??'La verificación no se completó.'}`;});}
 return <li className="integration-item">
  <div><strong>{aiProviderLabels[status.provider]}</strong> <span className={'status status-'+status.state.toLowerCase()}>{aiStateText[status.state]}</span>{status.hint&&<span className="integration-hint"> {status.hint}</span>}</div>
  {status.failure&&<p>{failureText[status.failure]??'La prueba de la clave no se completó.'}</p>}
  {owner&&<div className="integration-actions">
   {!open&&<Button type="button" variant="secondary" disabled={busy} onClick={()=>setOpen(true)}>{status.state==='MISSING'?'Agregar clave':'Reemplazar clave'}</Button>}
   {status.revision>0&&!open&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>{void act(async()=>{await setAiKeyEnabled(selection,status.provider,status.revision,!status.enabled);await refresh();return status.enabled?'Clave desactivada.':'Clave reactivada.';});}}>{status.enabled?'Desactivar':'Reactivar'}</Button>}
  </div>}
  {open&&<form onSubmit={save}>
   <label htmlFor={id}>Clave de {aiProviderLabels[status.provider]}</label>
   <input id={id} type="password" autoComplete="off" spellCheck={false} value={key} required minLength={8} maxLength={8192} onChange={e=>setKey(e.target.value)}/>
   <Button type="submit" disabled={busy||key.trim().length<8}>{busy?'Guardando y verificando…':'Guardar y verificar'}</Button>
   <Button type="button" variant="ghost" disabled={busy} onClick={()=>{setKey('');setOpen(false);}}>Cancelar</Button>
  </form>}
 </li>;
}
function MetaSection({data,owner,busy,selection,act,setData,refresh}:SectionProps){
 const id=useId(),[token,setToken]=useState(''),[open,setOpen]=useState(false),meta=data.meta;
 function save(event:FormEvent){event.preventDefault();const value=token.trim();setToken('');void act(async()=>{
  const result=await saveMetaToken(selection,meta.revision,value);setData(result.integrations);setOpen(false);
  return result.check.state==='VERIFIED'?'Token de Meta verificado.':`Token guardado. ${failureText[result.check.reason??'']??''}`;});}
 return <section className="card" id="meta" aria-labelledby={id}>
  <h2 id={id}>Meta (opcional)</h2>
  <p>Con un token de usuario del sistema de tu propio Business Manager, Commerce OS solo consulta tus campañas y resultados; nunca crea, pausa ni modifica anuncios.</p>
  <p><span className={'status status-'+meta.state.toLowerCase()}>{metaStateText[meta.state]}</span>{meta.hint&&<span className="integration-hint"> {meta.hint}</span>}</p>
  {meta.reason&&<p>{failureText[meta.reason]??'Meta no aceptó el token.'}</p>}
  {meta.grantedScopes.length>0&&<p>Permisos concedidos: {meta.grantedScopes.join(', ')}.</p>}
  {owner&&!open&&<div className="integration-actions"><Button type="button" variant="secondary" disabled={busy} onClick={()=>setOpen(true)}>{meta.state==='MISSING'?'Agregar token':'Reemplazar token'}</Button>
   {meta.revision>0&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>{void act(async()=>{await setMetaEnabled(selection,meta.revision,!meta.enabled);await refresh();return meta.enabled?'Token desactivado.':'Token reactivado.';});}}>{meta.enabled?'Desactivar':'Reactivar'}</Button>}</div>}
  {open&&<form onSubmit={save}>
   <label htmlFor={id+'-token'}>Token de usuario del sistema</label>
   <input id={id+'-token'} type="password" autoComplete="off" spellCheck={false} value={token} required minLength={20} maxLength={4096} onChange={e=>setToken(e.target.value)}/>
   <Button type="submit" disabled={busy||token.trim().length<20}>{busy?'Guardando y verificando…':'Guardar y verificar'}</Button>
   <Button type="button" variant="ghost" disabled={busy} onClick={()=>{setToken('');setOpen(false);}}>Cancelar</Button>
  </form>}
 </section>;
}
