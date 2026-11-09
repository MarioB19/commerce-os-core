import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from 'react';
import type {MetaInventoryView,MetaConnectionView} from '../../../../packages/contracts/src/meta-portfolios.js';
import type {ProfileFence} from '../lib/profile-request.js';
import {variantRequest,errorText} from '../lib/variants.js';
import {Alert,Badge,Button,Card,CardHead,Field,Input,Progress,Skeleton} from './ui';
const stateLabel:Record<string,string>={VERIFIED:'Verificada',UNVERIFIED:'Verificación pendiente',INVALID:'Revisar token',DISABLED:'Desactivada'};
export function MetaConnections(props:{selection:ProfileFence;owner:boolean}){return <ConnectionPanel key={`${props.selection.workspaceId}:${props.selection.version}`} {...props}/>;}
function ConnectionPanel({selection,owner}:{selection:ProfileFence;owner:boolean}){
 const [data,setData]=useState<MetaInventoryView>(),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[edit,setEdit]=useState<MetaConnectionView|null|undefined>();
 const generation=useRef(0);
 const load=useCallback(async(signal?:AbortSignal)=>{const n=++generation.current;try{const d=await variantRequest<MetaInventoryView>(selection,'GET','/v2/meta',undefined,undefined,signal);if(!signal?.aborted&&generation.current===n)setData(d);}catch(e){if(!signal?.aborted&&generation.current===n)setError(errorText(e,'No se pudo consultar Meta.'));}},[selection]);
 useEffect(()=>{const c=new AbortController();setData(undefined);setEdit(undefined);setError('');void load(c.signal);const timer=setInterval(()=>void load(c.signal),10000);return()=>{c.abort();generation.current++;clearInterval(timer);};},[load]);
 async function act(work:()=>Promise<void>,message:string){if(busy)return;setBusy(true);setError('');setNotice('');try{await work();setNotice(message);await load();}catch(e){setError(errorText(e,'No se completó el cambio.'));}finally{setBusy(false);}}
 return <div className="stack">
  {error&&<Alert tone="error">{error}</Alert>}{notice&&<Alert tone="success">{notice}</Alert>}
  <Card><CardHead title="Conexiones de Meta" description="Conecta los tokens de tus negocios y elige hasta cinco portafolios. Incluimos todas sus cuentas publicitarias accesibles y leemos sus resultados."/>
   {!data?<Skeleton lines={3}/>:<ul className="item-list">{data.connections.map(c=><li key={c.id} className="provider-row">
    <div className="cluster"><strong>{c.alias}</strong><Badge tone={c.state==='VERIFIED'?'success':c.state==='INVALID'?'error':'neutral'}>{stateLabel[c.state]}</Badge>{c.hint&&<code>{c.hint}</code>}</div>
    {c.reason&&<p className="muted">{c.reason==='META_PERMISSION_MISSING'?'Falta el permiso ads_read.':c.reason==='META_TOKEN_EXPIRED'?'El token venció o fue revocado.':'Meta no permitió completar la verificación.'}</p>}
    {owner&&<div className="cluster"><Button variant="secondary" size="sm" disabled={busy} onClick={()=>setEdit(c)}>Reemplazar token de {c.alias}</Button>
     <Button variant="ghost" size="sm" disabled={busy} onClick={()=>void act(async()=>{await variantRequest(selection,'POST',`/v2/meta/connections/${c.id}/state`,{expectedRevision:c.revision,enabled:!c.enabled});},c.enabled?'Conexión desactivada. Sus datos anteriores se conservan.':'Conexión reactivada.')}>{c.enabled?'Desactivar':'Reactivar'}</Button>
     {c.enabled&&<Button variant="ghost" size="sm" disabled={busy} onClick={()=>void act(async()=>{await variantRequest(selection,'POST',`/v2/meta/connections/${c.id}/discover`,{operationId:crypto.randomUUID()});},'Lectura de cuentas solicitada.')}>Volver a leer cuentas</Button>}</div>}
   </li>)}</ul>}
   {owner&&edit===undefined&&<Button variant="secondary" disabled={busy} onClick={()=>setEdit(null)}>Agregar conexión de Meta</Button>}
   {owner&&edit!==undefined&&<ConnectionForm key={edit?.id??'new'} connection={edit} busy={busy} save={(input)=>act(async()=>{const result=await variantRequest<{check:{state:string}}>(selection,'PUT',`/v2/meta/connections/${input.id}/token`,{alias:input.alias,expectedRevision:edit?.revision??0,token:input.token});setEdit(undefined);if(result.check.state==='INVALID')throw new Error('El token quedó guardado, pero Meta lo rechazó. Revisa su vigencia y el permiso ads_read.');},'Token guardado. Estamos comprobando sus portafolios y cuentas.')} cancel={()=>setEdit(undefined)}/>}
  </Card>
  {data&&<>
   <Card><CardHead title={`Portafolios · ${data.counts.selectedPortfolios} de ${data.limit}`} description="Selecciona los portafolios que quieres consultar. Al incluirlos comienza la carga de los últimos 90 días."/>
    {!data.portfolios.length?<p className="muted">{data.connections.length?'Todavía no se han descubierto portafolios. Revisa el avance y los permisos del token.':'Agrega una conexión para descubrir tus portafolios.'}</p>:<ul className="item-list">{data.portfolios.map(p=><li key={p.id} className="provider-row"><div className="cluster"><strong>{p.name}</strong><code>{p.id}</code><Badge>{p.accessibleAccounts} de {p.accounts} cuentas accesibles</Badge></div>
     <label className="cluster"><input type="checkbox" checked={p.selected} disabled={!owner||busy||(!p.selected&&data.counts.selectedPortfolios>=data.limit)} onChange={e=>void act(async()=>{await variantRequest(selection,'PATCH',`/v2/meta/portfolios/${p.id}`,{expectedVersion:p.version,selected:e.target.checked});},e.target.checked?'Portafolio incluido. La carga comenzará automáticamente.':'Portafolio retirado de las lecturas. Se conserva el histórico.')}/>Incluir {p.name}</label></li>)}</ul>}
    {data.counts.selectedPortfolios>=data.limit&&<p className="muted">Alcanzaste el máximo de cinco portafolios. Retira uno antes de incluir otro.</p>}
   </Card>
   <Card><CardHead title="Cuentas y cobertura" description={`${data.counts.accessibleAccounts} cuentas accesibles · ${data.counts.includedAccounts} incluidas. Los nombres iguales se distinguen por ID.`}/>
    <ul className="item-list">{data.accounts.map(a=><li key={a.id} className="provider-row"><div className="cluster"><strong>{a.name}</strong><code>{a.id}</code><Badge>{a.portfolioName??'Portafolio no determinado'}</Badge></div><p className="muted text-sm">{a.currency} · {a.timezone} · {a.included?'Incluida':'Sin seleccionar'} · {a.accessible?'Acceso disponible':'Sin acceso vigente'}</p>
     {a.included&&<Progress value={a.coveredDays/a.historyDays*100} label={`Histórico de ${a.id}`} valueText={`${a.coveredDays} de ${a.historyDays} días`}/>}
     {a.ownerBasis==='CURRENT_OWNER_BASELINE'&&<p className="muted text-sm">La agrupación histórica usa el propietario observado; no confirma transferencias anteriores.</p>}
     {a.pendingTasks>0&&<p className="muted">Lectura en curso: {a.pendingTasks} bloques pendientes.</p>}{a.failedTasks>0&&<p className="muted">Hay bloques pendientes de recuperación. Revisa las lecturas recientes.</p>}</li>)}</ul>
   </Card>
   <details className="disclosure"><summary>Lecturas recientes</summary><ul className="item-list">{data.operations.slice(0,10).map(o=><li key={o.id}><p>{o.completed} de {o.total} bloques completos · {o.pending?'En curso':o.failed?'Requiere revisión':o.status==='CANCELLED'?'Cancelada':'Terminada'}</p>{o.issues.length>0&&<p className="muted text-sm">{o.issues.join(' · ')}</p>}{owner&&o.failed>0&&<Button variant="secondary" size="sm" disabled={busy} onClick={()=>void act(async()=>{await variantRequest(selection,'POST',`/v2/meta/operations/${o.id}/retry`,{});},'Reanudación solicitada para los bloques recuperables.')}>Reintentar lectura</Button>}</li>)}</ul></details>
   <a href="/campaigns" className="btn" data-variant="secondary">Ver resultados por portafolio y cuenta</a>
  </>}
 </div>;
}
function ConnectionForm({connection,busy,save,cancel}:{connection:MetaConnectionView|null;busy:boolean;save:(input:{id:string;alias:string;token:string})=>Promise<void>;cancel:()=>void}){
 const label=useId(),[id]=useState(()=>connection?.id??crypto.randomUUID()),[alias,setAlias]=useState(connection?.alias??''),[token,setToken]=useState('');
 function submit(event:FormEvent){event.preventDefault();const value=token.trim();setToken('');void save({id,alias:alias.trim(),token:value});}
 return <form onSubmit={submit} className="form"><Field id={label+'-alias'} label="Nombre de la conexión"><Input value={alias} maxLength={80} required disabled={busy} onChange={e=>setAlias(e.target.value)} placeholder="Por ejemplo, Inovaris México"/></Field>
  <Field id={label+'-token'} label="Token de Meta" help="Token de usuario del sistema con permiso ads_read y acceso a tus cuentas. Se guarda cifrado."><Input type="password" autoComplete="off" spellCheck={false} value={token} required disabled={busy} onChange={e=>setToken(e.target.value)}/></Field>
  <div className="cluster"><Button type="submit" disabled={busy}>Guardar y verificar token</Button><Button type="button" variant="ghost" disabled={busy} onClick={cancel}>Cancelar</Button></div></form>;
}
