import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import {aiProviderLabels,aiStateText,failureText,loadIntegrations,metaStateText,saveAiKey,saveAiPreferences,saveMetaToken,setAiKeyEnabled,setMetaEnabled,usd,type AiProvider,type AiProviderStatus,type Integrations} from '../lib/profile-integrations.js';
import type {ProfileFence} from '../lib/profile-request.js';
import {Alert,Badge,Button,Card,CardHead,Field,Input,NativeSelect,PageHeader,Progress,Skeleton,Tabs,TabsContent,TabsList,TabsTrigger,toneOf} from './ui';
import {Bot,Megaphone} from 'lucide-react';

/** RF-13.a: the profile's only configuration areas besides employees — its own
 * AI keys and its own Meta token. Secrets are write-only; the page shows the
 * last four characters and the result of the single verification. */
export function ProfileIntegrations({selection,role,state}:{selection:ProfileFence;role:ProfileRole;state:ProfileState}){
 const [data,setData]=useState<Integrations>(),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),epoch=useRef(0);
 const owner=role==='owner'&&state==='ACTIVE';
 async function refresh(signal?:AbortSignal){const generation=++epoch.current;setError('');try{const value=await loadIntegrations(selection,signal);if(epoch.current===generation)setData(value);}catch(failure){if(epoch.current===generation&&!signal?.aborted)setError(failure instanceof Error?failure.message:'No se pudieron consultar las integraciones.');}}
 useEffect(()=>{const controller=new AbortController();setData(undefined);void refresh(controller.signal);return()=>{epoch.current++;controller.abort();};},[selection.workspaceId,selection.version]);
 async function act(work:()=>Promise<string|void>){if(busy)return;setBusy(true);setError('');setNotice('');try{const message=await work();if(message)setNotice(message);}catch(failure){setError(failure instanceof Error?failure.message:'No se pudo completar la acción.');}finally{setBusy(false);}}
 const [tab,setTab]=useState<string>(()=>{try{return window.location.hash==='#meta'?'meta':'ai';}catch{return 'ai';}});
 if(role==='viewer')return <><PageHeader title="Integraciones"/><Alert tone="info">Las integraciones solo están disponibles para Dueño y Operador.</Alert></>;
 return <>
  <PageHeader title="Integraciones" description="Este negocio usa sus propias claves de IA y su propio token de Meta. Nadie más puede leerlas: después de guardarlas solo verás sus últimos cuatro caracteres."/>
  {error&&<Alert tone="error">{error}</Alert>}{notice&&<Alert tone="success">{notice}</Alert>}
  {!data&&!error&&<Skeleton lines={4} label="Consultando integraciones…"/>}
  {data&&<Tabs value={tab} onValueChange={v=>{setTab(v);try{history.replaceState(null,'',v==='meta'?'#meta':'#ai');}catch{/* no history */}}}>
   <TabsList aria-label="Integraciones"><TabsTrigger value="ai"><Bot aria-hidden="true" size={16}/>Inteligencia artificial</TabsTrigger><TabsTrigger value="meta"><Megaphone aria-hidden="true" size={16}/>Meta</TabsTrigger></TabsList>
   <TabsContent value="ai"><AiSection data={data} owner={owner} busy={busy} selection={selection} act={act} setData={setData} refresh={()=>refresh()}/></TabsContent>
   <TabsContent value="meta"><MetaSection data={data} owner={owner} busy={busy} selection={selection} act={act} setData={setData} refresh={()=>refresh()}/></TabsContent>
  </Tabs>}
 </>;
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
 const b=data.ai.budget,ratio=b&&b.limitMicrousd>0?Math.min(1,b.usedMicrousd/b.limitMicrousd):0;
 return <div className="stack">
  <Card aria-labelledby={id}>
   <CardHead id={id} title="Inteligencia artificial" description="Guarda la clave de al menos un proveedor. Al guardarla hacemos una única consulta mínima con ella para comprobar que funciona; ese costo se descuenta de tu límite mensual."/>
   {b?<div className="stack-tight"><strong className="kpi-value" style={{fontSize:22}}>{usd(b.usedMicrousd)} <span className="muted" style={{fontWeight:400,fontSize:16}}>de {usd(b.limitMicrousd)} este mes</span></strong><Progress value={ratio*100} label="Presupuesto de IA usado" tone={ratio>0.9?'warn':undefined} valueText={`${Math.round(ratio*100)} %`}/></div>:<p className="muted">Aún no hay un límite mensual activo.</p>}
   <form onSubmit={savePreferences} className="form">
    <div className="form-grid">
     <Field label="Límite mensual de IA (USD)" id={id+'-limit'} help="Un cambio aplica a partir del siguiente periodo; el mes en curso conserva su límite."><Input inputMode="decimal" value={limit} disabled={!owner||busy} onChange={e=>setLimit(e.target.value)}/></Field>
     <Field label="Modelo predeterminado" id={id+'-model'}><NativeSelect value={model} disabled={!owner||busy} onChange={e=>setModel(e.target.value)}>
      <option value="">Sin elegir</option>
      {data.ai.models.filter(m=>m.capabilities.includes('chat')).map(m=><option key={m.provider+'/'+m.model} value={m.provider+'/'+m.model} disabled={!verified.has(m.provider)}>{aiProviderLabels[m.provider]} · {m.model}{verified.has(m.provider)?'':' (requiere clave verificada)'}</option>)}
     </NativeSelect></Field>
    </div>
    {owner&&<div className="form-actions"><Button type="submit" variant="secondary" disabled={busy}>Guardar preferencias</Button></div>}
   </form>
  </Card>
  <Card aria-labelledby={id+'-keys'}>
   <CardHead id={id+'-keys'} title="Claves por proveedor" level={3}/>
   <ul className="item-list providers">{data.ai.providers.map(p=><AiProviderRow key={p.provider} status={p} owner={owner} busy={busy} selection={selection} act={act} setData={setData} refresh={refresh}/>)}</ul>
  </Card>
 </div>;
}
function AiProviderRow({status,owner,busy,selection,act,setData,refresh}:{status:AiProviderStatus}&Omit<SectionProps,'data'>){
 const id=useId(),[key,setKey]=useState(''),[open,setOpen]=useState(false);
 function save(event:FormEvent){event.preventDefault();const value=key.trim();setKey('');void act(async()=>{
  const result=await saveAiKey(selection,status.provider,status.revision,value);setData(result.integrations);setOpen(false);
  return result.verification.state==='VERIFIED'?`Clave de ${aiProviderLabels[status.provider]} verificada.`:`Clave guardada. ${failureText[result.verification.code??'']??'La verificación no se completó.'}`;});}
 return <li className="provider-row">
  <div className="cluster"><strong className="item-name">{aiProviderLabels[status.provider]}</strong><Badge tone={toneOf(status.state)}>{aiStateText[status.state]}</Badge>{status.hint&&<code>{status.hint}</code>}</div>
  {status.failure&&<p className="muted text-sm">{failureText[status.failure]??'La prueba de la clave no se completó.'}</p>}
  {owner&&!open&&<div className="cluster">
   <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={()=>setOpen(true)}>{status.state==='MISSING'?'Agregar clave':'Reemplazar clave'}</Button>
   {status.revision>0&&<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={()=>{void act(async()=>{await setAiKeyEnabled(selection,status.provider,status.revision,!status.enabled);await refresh();return status.enabled?'Clave desactivada.':'Clave reactivada.';});}}>{status.enabled?'Desactivar':'Reactivar'}</Button>}
  </div>}
  {open&&<form onSubmit={save} className="form">
   <Field label={`Clave de ${aiProviderLabels[status.provider]}`} id={id} help="Se guarda cifrada y se verifica con una consulta mínima."><Input type="password" autoComplete="off" spellCheck={false} value={key} required minLength={8} maxLength={8192} onChange={e=>setKey(e.target.value)}/></Field>
   <div className="form-actions"><Button type="submit" disabled={busy||key.trim().length<8} loading={busy}>Guardar y verificar</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>{setKey('');setOpen(false);}}>Cancelar</Button></div>
  </form>}
 </li>;
}
function MetaSection({data,owner,busy,selection,act,setData,refresh}:SectionProps){
 const id=useId(),[token,setToken]=useState(''),[open,setOpen]=useState(false),meta=data.meta;
 function save(event:FormEvent){event.preventDefault();const value=token.trim();setToken('');void act(async()=>{
  const result=await saveMetaToken(selection,meta.revision,value);setData(result.integrations);setOpen(false);
  return result.check.state==='VERIFIED'?'Token de Meta verificado.':`Token guardado. ${failureText[result.check.reason??'']??''}`;});}
 return <Card id="meta" aria-labelledby={id}>
  <CardHead id={id} title="Meta (opcional)" description="Con un token de usuario del sistema de tu propio Business Manager, Commerce OS solo consulta tus campañas y resultados; nunca crea, pausa ni modifica anuncios."/>
  <div className="cluster"><Badge tone={toneOf(meta.state)}>{metaStateText[meta.state]}</Badge>{meta.hint&&<code>{meta.hint}</code>}</div>
  {meta.reason&&<Alert tone="warn">{failureText[meta.reason]??'Meta no aceptó el token.'}</Alert>}
  {meta.grantedScopes.length>0&&<p className="muted text-sm">Permisos concedidos: {meta.grantedScopes.join(', ')}.</p>}
  {owner&&!open&&<div className="cluster"><Button type="button" variant="secondary" disabled={busy} onClick={()=>setOpen(true)}>{meta.state==='MISSING'?'Agregar token':'Reemplazar token'}</Button>
   {meta.revision>0&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>{void act(async()=>{await setMetaEnabled(selection,meta.revision,!meta.enabled);await refresh();return meta.enabled?'Token desactivado.':'Token reactivado.';});}}>{meta.enabled?'Desactivar':'Reactivar'}</Button>}</div>}
  {open&&<form onSubmit={save} className="form">
   <Field label="Token de usuario del sistema" id={id+'-token'} help="Necesita el permiso ads_read. Se guarda cifrado."><Input type="password" autoComplete="off" spellCheck={false} value={token} required minLength={20} maxLength={4096} onChange={e=>setToken(e.target.value)}/></Field>
   <div className="form-actions"><Button type="submit" disabled={busy||token.trim().length<20} loading={busy}>Guardar y verificar</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>{setToken('');setOpen(false);}}>Cancelar</Button></div>
  </form>}
 </Card>;
}
