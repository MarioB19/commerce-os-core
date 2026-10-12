import {useEffect,useState} from 'react';
import type {MarketCatalog} from '../../../../packages/contracts/src/market-catalog.js';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import {sessionMarketCatalog} from '../../../../packages/commerce-client/src/market-catalog.js';
import {MarketVariants} from './market-variants.js';
export function ProductVariants({productId,selection,actorId,role,profileState}:{productId:string;selection:{workspaceId:string;version:number};actorId:string;role:ProfileRole;profileState:ProfileState}){
 const key=JSON.stringify([productId,selection.workspaceId,selection.version,actorId]),[reload,setReload]=useState(0),[state,setState]=useState<{key:string;data?:MarketCatalog;error?:boolean}>({key:''});
 useEffect(()=>{const controller=new AbortController();setState({key:''});sessionMarketCatalog(selection)(productId,'REAL',controller.signal).then(data=>{if(!controller.signal.aborted)setState({key,data});}).catch(()=>{if(!controller.signal.aborted)setState({key,error:true});});return()=>controller.abort();},[key,reload,productId,selection.workspaceId,selection.version]);
 const current=state.key===key?state:null;
 return <section><a href="/products">Volver a productos</a><h1>{current?.data?.product.name??'Variantes del producto'}</h1>
 {!current&&<p role="status">Consultando versiones del producto…</p>}
 {current?.error&&<div><p role="alert">No se pudieron confirmar las versiones. Revisa el perfil y vuelve a consultar.</p><button onClick={()=>setReload(n=>n+1)}>Consultar de nuevo</button></div>}
 {current?.data&&<><p>Las opciones corresponden a ofertas publicadas de este producto. La publicación volverá a verificar sus versiones.</p>
 <MarketVariants key={key} actorId={actorId} selection={selection} environment="REAL" role={role} profileState={profileState} product={current.data.product}
 catalog={{workspaceId:current.data.scope.workspace_id,selectionVersion:selection.version,environment:'REAL',productId,options:current.data.options}}/></>}
 </section>;
}
