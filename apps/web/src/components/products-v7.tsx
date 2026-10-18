import {useCallback,useEffect,useId,useMemo,useState,type FormEvent,type ReactNode} from 'react';
import {Archive,ArrowRight,CircleCheck,CircleDashed,Copy,Package,PencilLine,Search,Store} from 'lucide-react';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import type {VariantLocale} from '../../../../packages/contracts/src/variants.js';
import type {ProfileFence} from '../lib/profile-request.js';
import {variantRequest,newOperationKey,markets,languageLabel,errorText,type ProductSummary,type VariantView} from '../lib/variants.js';
import {Alert,Badge,Button,ButtonLink,Card,CardHead,Dialog,DialogActions,DialogClose,DialogContent,EmptyState,ErrorState,Field,Input,NativeSelect,PageHeader,Segmented,Skeleton,Table,TableWrap,Textarea,useToast,type Tone} from './ui';
import {useBreadcrumbs} from './app-shell.js';

/** V7 Productos (RF-05, canvas «Productos»): summary by state, segmented
 * filters, parent → markets table with the contextual action. One primary
 * action per screen; technical identifiers are never shown as names. */
const message=errorText;
export type VariantState=VariantView['state'];
export const stateTone=(state:string):Tone=>state==='SELLING'?'success':state==='READY_TO_ASSIGN'?'info':state==='ARCHIVED'?'neutral':'warn';
export const variantPath=(productId:string,variantId:string,section='sale')=>`/products/${productId}/variants/${variantId}/${section}`;
const needsSetup=(state:string)=>state==='NEEDS_SETUP'||state==='MISSING_COLLECTION';
const relative=(at:number)=>{const s=Math.round((Date.now()-at)/1000);return s<60?'hace unos segundos':s<3600?`hace ${Math.round(s/60)} min`:`hace ${Math.round(s/3600)} h`;};

/** Market picker: a preset or explicit fields; nothing is guessed later. */
export function MarketFields({value,onChange,lockCurrency=false}:{value:VariantLocale;onChange:(v:VariantLocale)=>void;lockCurrency?:boolean}){
 const id=useId(),preset=markets.findIndex(m=>JSON.stringify(m.locale)===JSON.stringify(value));
 return <fieldset className="plain"><legend>Mercado</legend>
  <Field label="País y idioma" id={id+'p'}><NativeSelect value={preset>=0?String(preset):'custom'} onChange={e=>{if(e.target.value!=='custom'){const m=markets[Number(e.target.value)]!;if(!lockCurrency||m.locale.currency===value.currency)onChange(m.locale);}}}>
   {markets.map((m,i)=><option key={m.label} value={i} disabled={lockCurrency&&m.locale.currency!==value.currency}>{m.label} · {m.locale.currency}</option>)}
   <option value="custom">Otro mercado…</option>
  </NativeSelect></Field>
  <details className="disclosure quiet"><summary>Detalles del mercado</summary>
   <div className="disclosure-body form-grid">
    <Field label="Nombre del mercado"><Input value={value.market} maxLength={160} onChange={e=>onChange({...value,market:e.target.value})}/></Field>
    <Field label="País (código ISO)"><Input value={value.country} maxLength={2} onChange={e=>onChange({...value,country:e.target.value.toUpperCase()})}/></Field>
    <Field label="Moneda (ISO)" help={lockCurrency?'Fija tras publicar.':undefined}><Input value={value.currency} maxLength={3} disabled={lockCurrency} onChange={e=>onChange({...value,currency:e.target.value.toUpperCase()})}/></Field>
    <Field label="Idioma"><Input value={value.language} maxLength={35} onChange={e=>onChange({...value,language:e.target.value})}/></Field>
    <Field label="Zona horaria"><Input value={value.timezone} maxLength={128} onChange={e=>onChange({...value,timezone:e.target.value})}/></Field>
   </div>
  </details>
  <p className="muted text-sm">{languageLabel(value.language)} · {value.currency} · {value.timezone}</p>
 </fieldset>;
}

function CreateProduct({fence,open,onClose,onCreated}:{fence:ProfileFence;open:boolean;onClose:()=>void;onCreated:(productId:string,variantId:string)=>void}){
 const [name,setName]=useState(''),[description,setDescription]=useState(''),[locale,setLocale]=useState<VariantLocale>(markets[0]!.locale),[busy,setBusy]=useState(false),[error,setError]=useState(''),[key,setKey]=useState(newOperationKey);
 async function submit(e:FormEvent){e.preventDefault();setBusy(true);setError('');
  try{const r=await variantRequest<{product:{id:string};variant:VariantView}>(fence,'POST','/v2/products',{name:name.trim(),description,variant:{name:locale.market,locale}},key);setKey(newOperationKey());onCreated(r.product.id,r.variant.id);}
  catch(err){setError(message(err,'No se pudo crear el producto.'));}finally{setBusy(false);}}
 return <Dialog open={open} onOpenChange={o=>{if(!o)onClose();}}>
  <DialogContent title="Crear producto" description="Empieza con un mercado. Incluye un flujo de venta y un vendedor que puedes editar.">
   <form onSubmit={submit} className="form">
    <Field label="Nombre del producto"><Input required maxLength={160} value={name} onChange={e=>setName(e.target.value)} autoFocus/></Field>
    <Field label="Descripción" optional><Textarea maxLength={4000} value={description} onChange={e=>setDescription(e.target.value)} rows={3}/></Field>
    <MarketFields value={locale} onChange={setLocale}/>
    {error&&<Alert tone="error">{error}</Alert>}
    <DialogActions><DialogClose asChild><Button type="button" variant="secondary">Cancelar</Button></DialogClose><Button type="submit" disabled={busy||!name.trim()} loading={busy}>Crear producto</Button></DialogActions>
   </form>
  </DialogContent>
 </Dialog>;
}

export function AddVariantDialog({fence,productId,source,open,onClose,onCreated}:{fence:ProfileFence;productId:string;source?:{id:string;name:string;locale:VariantLocale};open:boolean;onClose:()=>void;onCreated:(variantId:string)=>void}){
 const [locale,setLocale]=useState<VariantLocale>(markets[1]!.locale),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[key,setKey]=useState(newOperationKey);
 async function submit(e:FormEvent){e.preventDefault();setBusy(true);setError('');
  try{const body={name:(name||locale.market).trim(),locale};
   const r=source?await variantRequest<VariantView>(fence,'POST',`/v2/variants/${source.id}/duplicate`,body,key):await variantRequest<VariantView>(fence,'POST','/v2/variants',{product_id:productId,...body},key);
   setKey(newOperationKey());onCreated(r.id);}
  catch(err){setError(message(err,'No se pudo crear la variante.'));}finally{setBusy(false);}}
 return <Dialog open={open} onOpenChange={o=>{if(!o)onClose();}}>
  <DialogContent title={source?`Duplicar «${source.name}» a otro país`:'Agregar variante'} description={source?'Se copia flujo, oferta y materiales como borrador independiente. No se convierte el precio, no se traducen textos, no se copia el cobro ni los números y no se activa la venta. Revisarás precio, idioma, cobro y horarios.':'Cada variante es un mercado con su moneda, idioma, cobro y números.'}>
   <form onSubmit={submit} className="form">
    <MarketFields value={locale} onChange={v=>{setLocale(v);}}/>
    <Field label="Nombre de la variante" help={`Si lo dejas vacío se usa «${locale.market}».`}><Input maxLength={160} value={name} onChange={e=>setName(e.target.value)}/></Field>
    {error&&<Alert tone="error">{error}</Alert>}
    <DialogActions><DialogClose asChild><Button type="button" variant="secondary">Cancelar</Button></DialogClose><Button type="submit" disabled={busy} loading={busy}>{source?'Crear copia':'Agregar variante'}</Button></DialogActions>
   </form>
  </DialogContent>
 </Dialog>;
}

type Filter='all'|'selling'|'ready'|'setup'|'archived';
type Sort='name'|'markets'|'state';
const filterOf=(v:ProductSummary['variants'][number]):Exclude<Filter,'all'>=>v.state==='SELLING'?'selling':v.state==='READY_TO_ASSIGN'?'ready':v.state==='ARCHIVED'?'archived':'setup';
const order:Record<VariantState,number>={SELLING:0,READY_TO_ASSIGN:1,MISSING_COLLECTION:2,NEEDS_SETUP:3,ARCHIVED:4};

function VariantRow({product,v,showResults,onCopy,manage}:{product:ProductSummary;v:ProductSummary['variants'][number];showResults?:boolean;onCopy?:(v:ProductSummary['variants'][number])=>void;manage?:boolean}){
 const complete=needsSetup(v.state);
 return <tr className="row-child">
  <td data-label="Mercado"><span className="row-title">{v.name}</span><span className="row-sub">{languageLabel(v.locale.language)} · {v.locale.currency}</span></td>
  <td data-label="Estado"><Badge tone={stateTone(v.state)}>{v.state_label}</Badge>{v.unpublished_changes&&v.state!=='NEEDS_SETUP'&&<span className="row-sub">Cambios sin publicar</span>}</td>
  <td data-label="Números" className="num">{v.numbers}</td>
  <td className="actions">
   {showResults&&<a href={`/results?family_id=${product.id}&variant_id=${v.id}`}>Resultados<span className="sr-only"> de {v.name}</span></a>}
   {manage&&onCopy&&v.state!=='ARCHIVED'&&<Button size="sm" variant="ghost" onClick={()=>onCopy(v)}><Copy aria-hidden="true"/>Duplicar</Button>}
   <ButtonLink variant={complete?'secondary':'ghost'} size="sm" href={variantPath(product.id,v.id)}>{complete?'Completar':'Abrir'}<span className="sr-only"> {v.name}</span><ArrowRight aria-hidden="true"/></ButtonLink>
  </td>
 </tr>;
}

export function ProductsHome({selection,role,state}:{selection:ProfileFence;role:ProfileRole;state:ProfileState}){
 const manage=role!=='viewer'&&state==='ACTIVE';
 const [products,setProducts]=useState<ProductSummary[]>(),[error,setError]=useState(''),[creating,setCreating]=useState(false),[query,setQuery]=useState(''),[filter,setFilter]=useState<Filter>('all'),[sort,setSort]=useState<Sort>('name'),[adopting,setAdopting]=useState(''),[loadedAt,setLoadedAt]=useState(0),[tick,setTick]=useState(0);
 const toast=useToast();
 const load=useCallback(async(signal?:AbortSignal)=>{try{setProducts(await variantRequest<ProductSummary[]>(selection,'GET','/v2/products?include=all',undefined,undefined,signal));setLoadedAt(Date.now());setError('');}catch(e){if(!signal?.aborted)setError(message(e,'No se pudieron consultar tus productos.'));}},[selection]);
 useEffect(()=>{const c=new AbortController();void load(c.signal);return()=>c.abort();},[load,tick]);
 async function adopt(p:ProductSummary){setAdopting(p.id);try{const r=await variantRequest<{variant_id:string}>(selection,'POST',`/v2/products/${p.id}/adopt`,{},newOperationKey());window.location.assign(variantPath(p.id,r.variant_id));}catch(e){toast({tone:'error',title:'No se pudo configurar el mercado.',description:message(e,'')});}finally{setAdopting('');}}
 const all=products??[],variants=all.flatMap(p=>p.variants);
 const counts={selling:variants.filter(v=>v.state==='SELLING').length,ready:variants.filter(v=>v.state==='READY_TO_ASSIGN').length,setup:variants.filter(v=>needsSetup(v.state)).length,archived:variants.filter(v=>v.state==='ARCHIVED').length+all.filter(p=>p.archived&&!p.variants.length).length};
 const shown=useMemo(()=>{const q=query.trim().toLowerCase();
  const rows=all.map(p=>({product:p,variants:p.variants.filter(v=>filter==='all'?v.state!=='ARCHIVED':filterOf(v)===filter)}))
   .filter(({product:p,variants:vs})=>{const match=!q||p.name.toLowerCase().includes(q)||vs.some(v=>v.name.toLowerCase().includes(q));if(!match)return false;if(filter==='all')return !p.archived||vs.length>0;if(filter==='archived')return p.archived||vs.length>0;return vs.length>0;})
   .map(r=>({...r,variants:[...r.variants].sort((a,b)=>order[a.state]-order[b.state]||a.name.localeCompare(b.name,'es'))}));
  rows.sort((a,b)=>sort==='name'?a.product.name.localeCompare(b.product.name,'es'):sort==='markets'?b.variants.length-a.variants.length||a.product.name.localeCompare(b.product.name,'es'):Math.min(...a.variants.map(v=>order[v.state]),9)-Math.min(...b.variants.map(v=>order[v.state]),9)||a.product.name.localeCompare(b.product.name,'es'));
  return rows;},[all,query,filter,sort]);
 const empty=products&&products.length===0;
 return <>
  <PageHeader title="Productos" description="Un producto, varios mercados. Cada mercado tiene su precio, idioma, cobro y números." actions={manage&&!empty?<Button onClick={()=>setCreating(true)}>Crear producto</Button>:undefined}/>
  {error&&<ErrorState message={error} onRetry={()=>setTick(t=>t+1)}/>}
  {!products&&!error&&<div className="kpi-grid" aria-hidden="true"><Skeleton block/><Skeleton block/><Skeleton block/><Skeleton block/></div>}
  {products&&!empty&&<section aria-label="Resumen por estado" className="kpi-grid">
   <StatCard icon={<Store aria-hidden="true"/>} tone="success" label="Vendiendo" value={counts.selling} hint="Mercados con número asignado"/>
   <StatCard icon={<CircleCheck aria-hidden="true"/>} tone="info" label="Listas para asignar" value={counts.ready} hint="Publicadas, sin número"/>
   <StatCard icon={<CircleDashed aria-hidden="true"/>} tone="warn" label="Por completar" value={counts.setup} hint="Falta oferta, cobro o publicar"/>
   <StatCard icon={<Archive aria-hidden="true"/>} tone="neutral" label="Archivados" value={counts.archived} hint="Se conservan sin vender"/>
  </section>}
  {empty&&<EmptyState icon={<Package aria-hidden="true"/>} title="Crea tu primer producto" description="En menos de 15 minutos: nombre, mercado, precio, flujo de venta y vendedor." action={manage?<Button onClick={()=>setCreating(true)}>Crear producto</Button>:undefined}/>}
  {products&&!empty&&<>
   <div className="toolbar">
    <div className="toolbar-search"><Search aria-hidden="true"/><Input type="search" aria-label="Buscar producto" placeholder="Buscar producto o mercado" value={query} maxLength={160} onChange={e=>setQuery(e.target.value)}/></div>
    <Segmented label="Estado" value={filter} onChange={setFilter} options={[{value:'all',label:'Todos'},{value:'selling',label:'Vendiendo',count:counts.selling},{value:'ready',label:'Listas',count:counts.ready},{value:'setup',label:'Por completar',count:counts.setup},{value:'archived',label:'Archivados',count:counts.archived}]}/>
    <label className="toolbar-sort"><span className="muted text-sm">Ordenar</span><NativeSelect value={sort} onChange={e=>setSort(e.target.value as Sort)} aria-label="Ordenar por"><option value="name">Nombre</option><option value="markets">Más mercados</option><option value="state">Estado</option></NativeSelect></label>
   </div>
   {shown.length===0?<EmptyState inline title="Ningún producto coincide" description="Cambia el filtro o la búsqueda." action={<Button variant="secondary" onClick={()=>{setQuery('');setFilter('all');}}>Quitar filtros</Button>}/>
   :<TableWrap label="Productos y mercados"><Table className="products-table"><thead><tr><th scope="col">Producto y mercado</th><th scope="col">Estado</th><th scope="col" className="num">Números</th><th scope="col"><span className="sr-only">Acciones</span></th></tr></thead>
    <tbody>{shown.map(({product:p,variants:vs})=><ProductRows key={p.id} product={p} variants={vs} manage={manage} adopting={adopting===p.id} onAdopt={()=>void adopt(p)}/>)}</tbody>
    <tfoot><tr><td colSpan={4} className="table-foot-cell"><div className="table-foot"><span>{shown.length} producto{shown.length===1?'':'s'} · {shown.reduce((n,r)=>n+r.variants.length,0)} mercado{shown.reduce((n,r)=>n+r.variants.length,0)===1?'':'s'}</span><span>Actualizado {loadedAt?relative(loadedAt):'—'} · <button type="button" className="link-button" onClick={()=>setTick(t=>t+1)}>Actualizar</button></span></div></td></tr></tfoot>
   </Table></TableWrap>}
  </>}
  <CreateProduct fence={selection} open={creating} onClose={()=>setCreating(false)} onCreated={(productId,variantId)=>window.location.assign(variantPath(productId,variantId))}/>
 </>;
}
function ProductRows({product:p,variants,manage,adopting,onAdopt}:{product:ProductSummary;variants:ProductSummary['variants'];manage:boolean;adopting:boolean;onAdopt:()=>void}){
 return <>
  <tr className="row-parent">
   <td data-label="Producto"><a href={`/products/${p.id}`} className="row-title">{p.name}</a>{p.description&&<span className="row-sub">{p.description}</span>}</td>
   <td data-label="Estado">{p.archived?<Badge tone="neutral" icon={false}>Archivado</Badge>:<span className="muted text-sm">{variants.length} mercado{variants.length===1?'':'s'}{p.variants.length-variants.length>0?` · ${p.variants.length-variants.length} archivado${p.variants.length-variants.length===1?'':'s'}`:''}</span>}</td>
   <td className="num muted text-sm">{p.variants.reduce((n,v)=>n+v.numbers,0)||''}</td>
   <td className="actions">{!p.variants.length&&manage&&!p.archived?<Button size="sm" variant="secondary" disabled={adopting} loading={adopting} onClick={onAdopt}>Configurar mercado México</Button>:<a href={`/products/${p.id}`}>Ver producto<span className="sr-only"> {p.name}</span></a>}</td>
  </tr>
  {variants.map(v=><VariantRow key={v.id} product={p} v={v}/>)}
  {!variants.length&&<tr className="row-child"><td colSpan={4} className="muted text-sm">{p.variants.length?'Sus mercados están archivados.':'Este producto aún no tiene mercados configurados.'}</td></tr>}
 </>;
}
function StatCard({icon,tone,label,value,hint}:{icon:ReactNode;tone:Tone;label:string;value:number;hint:string}){
 return <div className="kpi stat" data-tone={tone}><span className="kpi-label"><span className="stat-icon">{icon}</span>{label}</span><strong className="kpi-value">{value}</strong><span className="kpi-hint">{hint}</span></div>;
}

export function ProductDetail({productId,selection,role,state}:{productId:string;selection:ProfileFence;role:ProfileRole;state:ProfileState}){
 const manage=role!=='viewer'&&state==='ACTIVE';
 const [product,setProduct]=useState<ProductSummary|null>(),[error,setError]=useState(''),[adding,setAdding]=useState(false),[copy,setCopy]=useState<ProductSummary['variants'][number]|null>(null),[tick,setTick]=useState(0);
 const [name,setName]=useState(''),[description,setDescription]=useState(''),[busy,setBusy]=useState(false);
 const toast=useToast();
 const load=useCallback(async(signal?:AbortSignal)=>{try{const all=await variantRequest<ProductSummary[]>(selection,'GET','/v2/products?include=all',undefined,undefined,signal);const p=all.find(x=>x.id===productId)??null;setProduct(p);if(p){setName(p.name);setDescription(p.description);}setError('');}catch(e){if(!signal?.aborted)setError(message(e,'No se pudo consultar el producto.'));}},[selection,productId]);
 useEffect(()=>{const c=new AbortController();void load(c.signal);return()=>c.abort();},[load,tick]);
 useBreadcrumbs(product?[{label:'Productos',href:'/products'},{label:product.name}]:[{label:'Productos',href:'/products'}]);
 async function save(e:FormEvent){e.preventDefault();if(!product)return;setBusy(true);setError('');try{await variantRequest(selection,'PATCH',`/v2/products/${product.id}`,{expected_version:product.version,name,description},newOperationKey());await load();toast({tone:'success',title:'Producto guardado.'});}catch(err){setError(message(err,'No se pudo guardar.'));}finally{setBusy(false);}}
 async function lifecycle(action:'archive'|'restore'){if(!product)return;setBusy(true);setError('');try{await variantRequest(selection,'POST',`/v2/products/${product.id}/${action}`,{expected_version:product.version},newOperationKey());await load();toast({tone:'success',title:action==='archive'?'Producto archivado.':'Producto restaurado.'});}catch(err){setError(message(err,'No se pudo cambiar el producto.'));}finally{setBusy(false);}}
 if(product===null)return <><PageHeader title="Producto" back={{href:'/products',label:'Productos'}}/><Alert tone="error">No encontramos ese producto en este perfil.</Alert></>;
 if(!product)return <>{error?<ErrorState message={error} onRetry={()=>setTick(t=>t+1)}/>:<Skeleton lines={3}/>}</>;
 const sorted=[...product.variants].sort((a,b)=>order[a.state]-order[b.state]||a.name.localeCompare(b.name,'es'));
 return <>
  <PageHeader title={product.name} back={{href:'/products',label:'Productos'}} badge={product.archived?<Badge tone="neutral" icon={false}>Archivado</Badge>:undefined} description={product.description||'Un producto, varios mercados. Cada mercado tiene su precio, idioma, cobro y números.'} actions={manage&&!product.archived?<Button onClick={()=>setAdding(true)}>Agregar variante</Button>:undefined}/>
  {error&&<Alert tone="error">{error}</Alert>}
  <Card aria-labelledby="markets-title">
   <CardHead id="markets-title" title="Mercados" description="Totales del producto, por moneda: nunca se suman monedas distintas." actions={<a href={`/results?family_id=${product.id}`} className="btn" data-variant="ghost">Resultados del producto<ArrowRight aria-hidden="true"/></a>}/>
   {sorted.length===0?<EmptyState inline level={3} title="Este producto aún no tiene mercados" description="Agrega una variante para definir precio, idioma, cobro y números." action={manage&&!product.archived?<Button variant="secondary" onClick={()=>setAdding(true)}>Agregar variante</Button>:undefined}/>
   :<TableWrap label="Mercados del producto"><Table><thead><tr><th scope="col">Mercado</th><th scope="col">Estado</th><th scope="col" className="num">Números</th><th scope="col"><span className="sr-only">Acciones</span></th></tr></thead>
    <tbody>{sorted.map(v=><VariantRow key={v.id} product={product} v={v} showResults manage={manage} onCopy={setCopy}/>)}</tbody></Table></TableWrap>}
  </Card>
  {manage&&<details className="disclosure"><summary><PencilLine aria-hidden="true" size={18}/>Editar producto</summary>
   <form onSubmit={save} className="disclosure-body form">
    <Field label="Nombre"><Input required maxLength={160} value={name} onChange={e=>setName(e.target.value)}/></Field>
    <Field label="Descripción" optional><Textarea maxLength={4000} rows={3} value={description} onChange={e=>setDescription(e.target.value)}/></Field>
    <div className="form-actions"><Button type="submit" variant="secondary" disabled={busy}>Guardar producto</Button>{product.archived?<Button type="button" variant="ghost" disabled={busy} onClick={()=>void lifecycle('restore')}>Restaurar producto</Button>:<Button type="button" variant="ghost" disabled={busy} onClick={()=>void lifecycle('archive')}><Archive aria-hidden="true"/>Archivar producto</Button>}</div>
   </form></details>}
  <AddVariantDialog fence={selection} productId={product.id} open={adding} onClose={()=>setAdding(false)} onCreated={id=>window.location.assign(variantPath(product.id,id))}/>
  {copy&&<AddVariantDialog fence={selection} productId={product.id} source={copy} open onClose={()=>setCopy(null)} onCreated={id=>window.location.assign(variantPath(product.id,id))}/>}
 </>;
}
