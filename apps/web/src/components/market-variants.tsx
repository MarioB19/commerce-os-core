import {marketVariantPending} from '../lib/market-variant-pending.js';
import {useEffect,useId,useRef,useState} from 'react';
import type {z} from 'zod';
import {marketDraftViewSchema} from '../../../../packages/contracts/src/market-variant-client.js';
import {marketDraftFieldsSchema,type MarketEnvironment} from '../../../../packages/contracts/src/market-variant-store.js';
import {marketCopyReviewFields,marketLocaleSchema,type MarketRelease} from '../../../../packages/contracts/src/market-variants.js';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import {sessionMarketVariants} from '../../../../packages/commerce-client/src/market-variants.js';
import {marketVariantsView,marketPriceMinor,marketPriceText,type MarketViewState} from '../lib/market-variants.js';
import {Button} from './ui/button';

type Draft=z.infer<typeof marketDraftViewSchema>;
type Ref=MarketRelease['configuration']['offer'];
type Kind='offer'|'flow'|'seller'|'collection'|'material';
type Locale=MarketRelease['locale'];
export interface MarketVariantsProps{
 actorId?:string;selection:{workspaceId:string;version:number};environment:MarketEnvironment;role:ProfileRole;profileState:ProfileState;
 product:{id:string;version:number;name:string};
 catalog:{workspaceId:string;selectionVersion:number;environment:MarketEnvironment;productId:string;
  options:readonly {kind:Kind;label:string;ref:Ref}[]};
}
const initial:MarketViewState={status:'IDLE',result:null,pending:null,mayResend:false,message:''};
const locale:Locale={market:'México',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'};
const key=(ref:Ref)=>ref.id+':'+ref.revision;
const labels={language:'Idioma',price_currency:'Precio y moneda',collection:'Cobro',flow_seller:'Flujo y vendedor',remarketing:'Seguimiento',materials:'Materiales'};
type Form=Locale&{price:string;offer:string;flow:string;seller:string;collection:string;materials:string[]};
const blank=():Form=>({...locale,price:'',offer:'',flow:'',seller:'',collection:'',materials:[]});
function formOf(draft:Draft):Form{const d=draft.draft;return{...d.locale,price:marketPriceText(d.amount_minor,d.locale.currency),
 offer:key(d.configuration.offer),flow:key(d.configuration.flow),seller:key(d.configuration.seller),collection:key(d.configuration.collection),materials:d.configuration.materials.map(key)};}

/** Selected-product view; every mutation is reconciled against native receipts. */
export function MarketVariants(props:MarketVariantsProps){
 const p=props,key=JSON.stringify([p.selection.workspaceId,p.selection.version,p.environment,p.product.id,p.product.version,p.role,p.profileState]);
 if(p.catalog.workspaceId!==p.selection.workspaceId||p.catalog.selectionVersion!==p.selection.version||p.catalog.environment!==p.environment||p.catalog.productId!==p.product.id)
  return <p role="status">Actualizando el catálogo del perfil seleccionado…</p>;
 return <SelectedVariants key={key} {...props}/>;
}
function SelectedVariants(p:MarketVariantsProps){
 const id=useId(),view=useRef<ReturnType<typeof marketVariantsView>|null>(null);
 const[state,setState]=useState(initial),[draft,setDraft]=useState<Draft|null>(null),[form,setForm]=useState<Form>(blank),[editing,setEditing]=useState(false);
 const[review,setReview]=useState<string[]>([]),[error,setError]=useState(''),[copyLocale,setCopyLocale]=useState<Locale>(locale);
 useEffect(()=>{
  let storage;try{storage=p.actorId?marketVariantPending({workspace:p.selection.workspaceId,actor:p.actorId,environment:p.environment,family:p.product.id},sessionStorage):undefined;}catch{storage={load:()=>{throw Error('storage');},save:()=>{throw Error('storage');},clear:()=>{throw Error('storage');}};}
  const next=marketVariantsView(sessionMarketVariants(p.selection),p.environment,p.selection.workspaceId,undefined,storage);view.current=next;
  const unsubscribe=next.subscribe(()=>setState(next.snapshot()));setState(next.snapshot());
  void next.read({operation:'list',family_id:p.product.id,limit:25});
  return()=>{unsubscribe();next.dispose();if(view.current===next)view.current=null;};
 },[p.selection.workspaceId,p.selection.version,p.environment,p.product.id,p.actorId]);
 useEffect(()=>{
  if(!state.result||Array.isArray(state.result.data))return;
  const data=state.result.data,candidate='variant'in data?data.variant:'draft'in data?data:null;
  if(candidate&&candidate.family_id===p.product.id){setDraft(candidate);setForm(formOf(candidate));setReview([]);setEditing(true);setError('');}
 },[state.result,p.product.id]);
 const writable=p.profileState==='ACTIVE'&&p.role!=='viewer',busy=state.status==='LOADING'||state.status==='WRITING',uncertain=state.pending!==null;
 const disabled=!writable||busy||uncertain;
 const page=state.result&&'meta'in state.result?state.result:null;
 const dirty=!draft||JSON.stringify(form)!==JSON.stringify(formOf(draft));
 const change=(patch:Partial<Form>)=>{setForm(old=>({...old,...patch}));setReview([]);setError('');};
 function resolve(kind:Kind,value:string):Ref{
  const candidates=[...p.catalog.options.filter(item=>item.kind===kind).map(item=>item.ref),...(draft?kind==='material'?draft.draft.configuration.materials:[draft.draft.configuration[kind]]:[])];
  const ref=candidates.find(item=>key(item)===value);if(!ref)throw Error('Elige una versión del catálogo.');return ref;
 }
 function fields(){const offer=resolve('offer',form.offer);return marketDraftFieldsSchema.parse({locale:{market:form.market,currency:form.currency,language:form.language,timezone:form.timezone},
  amount_minor:marketPriceMinor(form.price,form.currency),configuration:{offer,flow:resolve('flow',form.flow),seller:resolve('seller',form.seller),collection:resolve('collection',form.collection),remarketing:offer,materials:form.materials.map(value=>resolve('material',value))}});}
 function options(kind:Kind){
  const values=p.catalog.options.filter(item=>item.kind===kind),seen=new Set(values.map(item=>key(item.ref)));
  const historical=draft?kind==='material'?draft.draft.configuration.materials:[draft.draft.configuration[kind]]:[];
  return [...values,...historical.filter(ref=>!seen.has(key(ref))).map(ref=>({kind,label:'Versión conservada',ref}))];
 }
 async function action(run:()=>Promise<void>){if(disabled)return;setError('');try{await run();}catch{setError('Revisa los campos y las versiones seleccionadas antes de continuar.');}}
 const refresh=()=>{if(busy||uncertain)return;setEditing(false);setDraft(null);setReview([]);void view.current?.read({operation:'list',family_id:p.product.id,limit:25});};
 return <section className="card" aria-labelledby={id}>
  <h2 id={id}>Variantes de {p.product.name}</h2>
  <p>Cada mercado conserva sus versiones comerciales y sus materiales.</p>
  {!writable&&<p>Consulta disponible. Este perfil o tu rol no permite modificar variantes.</p>}
  {state.message&&<p role={uncertain?'alert':'status'}>{state.message}</p>}{error&&<p role="alert">{error}</p>}
  {busy&&<p role="status">{state.status==='WRITING'?'Guardando la operación…':'Consultando el catálogo…'}</p>}
  {state.pending&&<div>
   <p>Referencia de la operación: <code>{state.pending.operation_id}</code></p>
   <Button disabled={busy} onClick={()=>{void view.current?.reconcile();}}>Comprobar operación</Button>
   {state.mayResend&&<Button variant="secondary" disabled={busy} onClick={()=>{void view.current?.resend();}}>Reenviar la misma solicitud</Button>}
  </div>}
  {!uncertain&&<>
   <div className="flex flex-wrap gap-2">
    <Button variant="secondary" disabled={busy} onClick={refresh}>Consultar variantes</Button>
    {writable&&<Button disabled={busy} onClick={()=>{setDraft(null);setForm(blank());setReview([]);setEditing(true);setError('');}}>Nueva variante</Button>}
    {writable&&<Button variant="secondary" disabled={busy} onClick={()=>{void action(async()=>{await view.current?.write({operation:'adopt',body:{product_id:p.product.id,expected_product_version:p.product.version}});});}}>Preparar producto para variantes</Button>}
   </div>
   {page&&<><ul>{page.data.map(item=><li key={item.id}>
    <Button variant="ghost" disabled={busy} onClick={()=>{setEditing(false);setDraft(null);void view.current?.read({operation:'get',id:item.id});}}>{item.draft.locale.market} · {item.draft.locale.language} · {item.draft.locale.currency}</Button>
    <span>{item.current_release_id?'Con versión publicada':'Borrador'}</span>
   </li>)}</ul>{page.meta.has_more&&<Button variant="secondary" disabled={busy} onClick={()=>{void view.current?.read({operation:'list',family_id:p.product.id,limit:25,after:page.meta.next!});}}>Ver más variantes</Button>}</>}
   {editing&&!busy&&<>
    <h3>{draft?'Editar borrador':'Crear borrador'}</h3>
    <form onSubmit={event=>{event.preventDefault();void action(async()=>{const body=fields();await view.current?.write(draft?{operation:'replace',id:draft.id,body:{expected_version:draft.version,fields:body}}:{operation:'create',body:{family_id:p.product.id,fields:body}});});}}>
     <fieldset disabled={disabled} className="grid gap-3">
      {(['market','currency','language','timezone']as const).map(name=><label key={name} htmlFor={id+'-'+name}>{({market:'Mercado',currency:'Moneda',language:'Idioma',timezone:'Zona horaria'})[name]}
       <input id={id+'-'+name} required maxLength={name==='market'?160:name==='timezone'?128:80} value={form[name]} onChange={event=>change({[name]:event.target.value})}/></label>)}
      <label htmlFor={id+'-price'}>Precio en {form.currency}<input id={id+'-price'} required inputMode="decimal" value={form.price} maxLength={24} onChange={event=>change({price:event.target.value})}/></label>
      {(['offer','flow','seller','collection']as const).map(kind=><label key={kind} htmlFor={id+'-'+kind}>{({offer:'Oferta y seguimiento',flow:'Flujo',seller:'Vendedor',collection:'Cobro'})[kind]}
       <select id={id+'-'+kind} required value={form[kind]} onChange={event=>change({[kind]:event.target.value})}><option value="">Elige una versión</option>{options(kind).map(item=><option key={key(item.ref)} value={key(item.ref)}>{item.label} · revisión {item.ref.revision}</option>)}</select></label>)}
      <label htmlFor={id+'-materials'}>Materiales<select id={id+'-materials'} multiple value={form.materials} onChange={event=>change({materials:[...event.target.selectedOptions].map(item=>item.value)})}>{options('material').map(item=><option key={key(item.ref)} value={key(item.ref)}>{item.label} · revisión {item.ref.revision}</option>)}</select></label>
      <Button type="submit" disabled={disabled||!dirty}>Guardar borrador</Button>
     </fieldset>
    </form>
    {draft&&<div><h3>Publicar versión comercial</h3><p>Revisa estos campos del borrador guardado. Publicar conserva una versión; las asignaciones a números se gestionan por separado.</p>
     <fieldset disabled={disabled||dirty}>{marketCopyReviewFields.map(field=><label key={field}><input type="checkbox" checked={review.includes(field)} onChange={event=>setReview(old=>event.target.checked?[...old,field]:old.filter(item=>item!==field))}/>{labels[field]}</label>)}</fieldset>
     <Button disabled={disabled||dirty||review.length!==marketCopyReviewFields.length} onClick={()=>{void action(async()=>{await view.current?.write({operation:'publish',id:draft.id,body:{expected_version:draft.version,draft_sha256:draft.draft_sha256,reviewed_fields:marketCopyReviewFields.filter(field=>review.includes(field))}});});}}>Publicar versión comercial</Button>
     {dirty&&<p>Guarda y revisa los cambios antes de publicar.</p>}
    </div>}
    {draft?.current_release_id&&<form onSubmit={event=>{event.preventDefault();void action(async()=>{const target=marketLocaleSchema.parse(copyLocale);await view.current?.write({operation:'copy',body:{source_release_id:draft.current_release_id!,locale:target}});});}}>
     <h3>Copiar la versión publicada a otro mercado</h3><p>La copia será un borrador independiente y requerirá revisar idioma, precio, cobro, flujo, seguimiento y materiales.</p>
     <fieldset disabled={disabled}>{(['market','currency','language','timezone']as const).map(name=><label key={name} htmlFor={id+'-copy-'+name}>{({market:'Mercado destino',currency:'Moneda destino',language:'Idioma destino',timezone:'Zona horaria destino'})[name]}
      <input id={id+'-copy-'+name} value={copyLocale[name]} required maxLength={160} onChange={event=>setCopyLocale(old=>({...old,[name]:event.target.value}))}/></label>)}
      <Button type="submit">Crear copia como borrador</Button>
     </fieldset>
    </form>}
   </>}
  </>}
 </section>;
}
