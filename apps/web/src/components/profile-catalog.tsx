import {useEffect,useRef,useState} from 'react';
import {sessionProfileCatalog,ProfileCatalogError} from '../../../../packages/commerce-client/src/profile-catalog.js';
import type {ProfileCatalogResource,ProfileCatalogResult} from '../../../../packages/contracts/src/profile-catalog-consumer.js';

interface Selection {workspaceId:string|null;version:number}
type View={authority:string;resource:ProfileCatalogResource;id:string;mode:'get'|'versions';before?:number};
const labels:Record<ProfileCatalogResource,string>={categories:'Categorías',products:'Productos',offers:'Ofertas',materials:'Materiales',flows:'Flujos',sellers:'Vendedores'};
const label=(row:Record<string,unknown>)=>typeof row.name==='string'?row.name:typeof row.title==='string'?row.title:'Recurso sin nombre';

/** Prepared consumer. All data is scoped to one selection and request epoch. */
export function ProfileCatalog({selection,environment,variantLinks=false}:{selection:Selection;environment:'REAL'|'SIMULATION';variantLinks?:boolean}){
 const [resource,setResource]=useState<ProfileCatalogResource>('products'),[search,setSearch]=useState(''),[filter,setFilter]=useState('');
 const [page,setPage]=useState(0),[view,setView]=useState<View|null>(null),[reload,setReload]=useState(0);
 const authority=JSON.stringify([selection.workspaceId,selection.version,environment]);
 const selected=view?.authority===authority&&view.resource===resource?view:null;
 const input=selected?{operation:selected.mode,resource,id:selected.id,environment,...(selected.mode==='versions'?{limit:20,...(selected.before?{before:selected.before}:{})}:{})}:
  {operation:'list',resource,environment,limit:20,offset:page,...(filter?{q:filter}:{})};
 const signature=JSON.stringify([authority,input,reload]),revision=useRef({signature,version:0});
 // Returning A→B→A is a new read even if B never produced a result.
 if(revision.current.signature!==signature)revision.current={signature,version:revision.current.version+1};
 const key=JSON.stringify([signature,revision.current.version]),active=useRef(key);active.current=key;
 const epoch=useRef(0),[state,setState]=useState<{key:string;result?:ProfileCatalogResult;error?:string}>({key:''});
 const valid=selection.workspaceId!==null&&selection.version>0;
 useEffect(()=>{
  if(!valid)return;
  const controller=new AbortController(),serial=++epoch.current;
  const request=JSON.parse((JSON.parse(key) as [string,number])[0]) as [string,unknown,number];
  const [workspaceId,version]=JSON.parse(request[0]) as [string,number,string];
  sessionProfileCatalog({workspaceId,version})(request[1],controller.signal).then(result=>{
   if(active.current===key&&epoch.current===serial&&!controller.signal.aborted)setState({key,result});
  }).catch(error=>{
   if(active.current===key&&epoch.current===serial&&!controller.signal.aborted)setState({key,error:error instanceof ProfileCatalogError&&[401,403,409].includes(error.status)?'La identidad o la selección ya no está vigente. Actualiza el perfil antes de consultar.':'No se pudo consultar el catálogo. Puedes volver a consultar.'});
  });
  return()=>controller.abort();
 },[key,valid]);
 const current=valid&&state.key===key?state:undefined,result=current?.result;
 function choose(id:string,mode:'get'|'versions'){setView({authority,resource,id,mode});}
 if(!valid)return <p>Elige un perfil para consultar el catálogo.</p>;
 return <section aria-label="Catálogo del perfil">
  <h2>Catálogo</h2>
  <label>Tipo de recurso <select value={resource} onChange={e=>{setResource(e.target.value as ProfileCatalogResource);setPage(0);setView(null);}}>{Object.entries(labels).map(([id,text])=><option key={id} value={id}>{text}</option>)}</select></label>
  {!selected&&<form onSubmit={e=>{e.preventDefault();setFilter(search.trim());setPage(0);setReload(n=>n+1);}}><label>Buscar por nombre o descripción <input value={search} maxLength={160} onChange={e=>setSearch(e.target.value)}/></label><button>Buscar</button></form>}
  {selected&&<button onClick={()=>setView(null)}>Volver a la lista</button>}
  <button onClick={()=>setReload(n=>n+1)}>Consultar de nuevo</button>
  {current?.error&&<p role="alert">{current.error}</p>}
  {!current&&<p role="status">Consultando catálogo…</p>}
  {result&&<><p>{selected?.mode==='versions'?'Historial de versiones':selected?'Detalle del recurso':labels[resource]}</p>
   {result.data.length===0?<p>No hay recursos para esta consulta.</p>:<ul>{result.data.map(row=><li key={row.id+':'+row.version}>
    <h3>{label(row)}</h3>{variantLinks&&resource==='products'&&selected?.mode!=='versions'&&<a href={'/products/'+encodeURIComponent(row.id)+'/variants'}>Variantes de {label(row)}</a>}{typeof row.description==='string'&&<p>{row.description}</p>}
    <p>Versión {row.version}{typeof row.status==='string'?' · '+row.status:''}</p>
    {!selected&&<button onClick={()=>choose(row.id,'get')}>Ver {label(row)}</button>}
    {selected?.mode!=='versions'&&<button onClick={()=>choose(row.id,'versions')}>Versiones de {label(row)}</button>}
   </li>)}</ul>}
   {!selected&&<><button disabled={page===0} onClick={()=>setPage(n=>Math.max(0,n-20))}>Página anterior</button><button disabled={!result.hasMore||page>=10000} onClick={()=>setPage(n=>n+20)}>Página siguiente</button></>}
   {selected?.mode==='versions'&&<><button disabled={!selected.before} onClick={()=>setView({...selected,before:undefined})}>Versiones recientes</button><button disabled={!result.hasMore} onClick={()=>setView({...selected,before:result.data.at(-1)!.version})}>Versiones anteriores</button></>}
  </>}
 </section>;
}
