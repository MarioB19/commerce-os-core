import {useEffect,useState} from 'react';
import {Link} from '@tanstack/react-router';
import {Panel,Feedback,QueryState,useWorkspace} from '../shared';
import {Button} from '../ui/button';
import {useData,useAction,params,type Row} from '../../lib/api';

type Account={id:string;name:string;version:number;status:string;uses_product:boolean;sending_enabled:boolean;effective_assignment:{offer_version_id:string;workflow_version_id:string;agent_version_id:string}};
type OfferSelection={state:'EXPLICIT'|'ASSIGNED_CURRENT'|'SELECTION_REQUIRED'|'LATEST_PUBLISHED_UNASSIGNED'|'NO_OFFER';reason?:string;offer_id?:string;offer_ids?:string[]};
type Configuration=Row&{configuration_published:boolean;offer:Row|null;offer_selection?:OfferSelection;offers?:Row[];workflow:Row|null;seller:Row|null;visibility?:{assignments:boolean};connections:{sales_ai:{configured:boolean;state:string;model:string|null};assigned_accounts:number|null};accounts:Account[]};
type Result={account_id:string;ok:boolean;code?:string};
export function CommercialConfiguration({productId}:{productId:string}){
	 const {environment}=useWorkspace();
	 const [offerId,setOfferId]=useState('');
	 useEffect(()=>setOfferId(''),[productId,environment]);
	 const query=useData<Configuration>(`/products/${productId}/configuration${params(environment,offerId?{offer_id:offerId}:{})}`);
 const results:Result[]=[],error='';
 const data=query.data?.connections?.sales_ai&&Array.isArray(query.data.accounts)?query.data:undefined;
 return <Panel title="Paquete comercial y números"><div className="sales-panel-body grid gap-4">{query.data&&!data&&<p role="alert">No pudimos leer el estado de esta configuración. Actualiza la página para reintentar.</p>}<QueryState query={query}>{data&&<>
	  <p><strong>{data.configuration_published?'Paquete comercial publicado':'Paquete comercial pendiente'}</strong></p>
	  {(data.offers?.length??0)>1&&<label className="field"><span>Oferta que quieres revisar</span><select value={offerId||data.offer_selection?.offer_id||''} onChange={event=>setOfferId(event.target.value)}><option value="">{data.offer_selection?.state==='SELECTION_REQUIRED'?'Selecciona una oferta vigente':'Usar la oferta fijada por las asignaciones'}</option>{(data.offers??[]).filter(offer=>offer.status==='PUBLISHED').map(offer=><option key={offer.id} value={offer.id}>{offer.name}</option>)}</select><small>{data.offer_selection?.state==='SELECTION_REQUIRED'?'Hay varias ofertas vigentes en las rutas actuales. Elige una para revisar su diagnóstico; esto no reasigna números ni autoriza envíos.':'La oferta fijada por las rutas actuales tiene prioridad sobre una versión nueva sin asignar.'}</small></label>}
  <p>{data.connections.sales_ai.configured?'IA de Ventas configurada; evaluación real pendiente.':'Proveedor IA de Ventas pendiente. Puedes conservar y publicar el vendedor.'} <Link to="/settings">Configurar IA →</Link></p>
  <div className="button-group">{data.workflow&&<Button asChild variant="secondary"><Link to={`/sales/flows/${data.workflow.id}`}>Abrir flujo</Link></Button>}{data.seller&&<Button asChild variant="secondary"><Link to={`/sales/agents/${data.seller.id}`}>Abrir vendedor</Link></Button>}</div>
	  <p>{data.visibility?.assignments===false?'Las asignaciones y autorizaciones sólo son visibles para responsables de números.':`${data.connections.assigned_accounts??0} números usan este producto. Cada asignación conserva sus versiones y requiere autorización operativa propia.`}</p>
	  {data.visibility?.assignments!==false&&<div className="button-group"><Button asChild><Link to="/catalog" search={{product:productId,tab:"numbers"}}>Gestionar números</Link></Button></div>}
  {results.length>0&&<div role="status"><p>{results.every(r=>r.ok)?'Todas las asignaciones se guardaron.':'Hay asignaciones pendientes. Revisa el resultado de cada número.'}</p><ul>{results.map(r=><li key={r.account_id}>{data.accounts.find(a=>a.id===r.account_id)?.name??r.account_id}: {r.ok?'Guardado; envíos deshabilitados':`No guardado (${r.code??'error'})`}</li>)}</ul></div>}
  <Feedback error={error?new Error(error):null}/>
 </>}</QueryState></div></Panel>;
}

export function ArchivedConfiguration(){
 const {environment,session}=useWorkspace();const action=useAction();const [error,setError]=useState(''),[chosen,setChosen]=useState(''),[reason,setReason]=useState('');
 const products=useData(`/products${params(environment,{include_archived:'true'})}`),offers=useData(`/offers${params(environment,{include_archived:'true'})}`),flows=useData(`/workflows${params(environment,{include_archived:'true'})}`),agents=useData(`/agents${params(environment,{include_archived:'true'})}`),assets=useData(`/assets${params(environment,{include_archived:'true'})}`);
 const groups=[['products',products],['offers',offers],['workflows',flows],['agents',agents],['assets',assets]] as const;
 const active=groups.flatMap(([path,q])=>(q.data??[]).filter(r=>!r.archived_at&&r.status!=='ARCHIVED').map(row=>({path,row})));
 const rows=groups.flatMap(([path,q])=>(q.data??[]).filter(r=>r.archived_at).map(r=>({path,row:r})));
 return <Panel title="Archivo recuperable"><div className="sales-panel-body grid gap-4">{session.role==='owner'&&<details><summary>Retirar una configuración de las selecciones</summary><label className="field"><span>Recurso a archivar</span><select value={chosen} onChange={e=>setChosen(e.target.value)}><option value="">Selecciona un recurso</option>{active.map(({path,row})=><option key={row.id} value={path+':'+row.id}>{row.name} · {path} · revisión {row.version}</option>)}</select></label><label className="field"><span>Motivo del archivo</span><input value={reason} onChange={e=>setReason(e.target.value)}/></label><Button disabled={!chosen||reason.trim().length<3||action.isPending} onClick={()=>{const item=active.find(({path,row})=>path+':'+row.id===chosen);if(!item)return;void action.mutateAsync({path:`/${item.path}/${item.row.id}/archive`,body:{expected_version:item.row.version,archived:true,reason:reason.trim()}}).then(()=>{setChosen('');setReason('');}).catch(e=>setError(e.message));}}>Archivar conservando el historial</Button></details>}<p>Las versiones retiradas conservan su historial y referencias. Restaurarlas vuelve a mostrarlas en las selecciones.</p>{rows.length?<ul>{rows.map(({path,row})=><li key={row.id}>{row.name} · revisión {row.version} <Button variant="secondary" disabled={action.isPending} onClick={()=>{void action.mutateAsync({path:`/${path}/${row.id}/archive`,body:{expected_version:row.version,archived:false,reason:'Restauración explícita desde el archivo'}}).catch(e=>setError(e.message));}}>Restaurar {row.name}</Button></li>)}</ul>:<p>No hay configuración archivada.</p>}<Feedback error={error?new Error(error):null}/></div></Panel>;
}
