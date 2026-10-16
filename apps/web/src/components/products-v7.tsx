import {useCallback,useEffect,useId,useState,type FormEvent} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import type {VariantLocale} from '../../../../packages/contracts/src/variants.js';
import type {ProfileFence} from '../lib/profile-request.js';
import {variantRequest,newOperationKey,markets,languageLabel,errorText,type ProductSummary,type VariantView} from '../lib/variants.js';
import {Button} from './ui/button';

/** V7 Productos (RF-05, wireframe C): parents and their markets. One primary
 * action per screen; technical identifiers are never shown as names. */
const message=errorText;
export const stateTone=(state:string)=>state==='SELLING'?'ok':state==='READY_TO_ASSIGN'?'ready':state==='ARCHIVED'?'neutral':'attention';
export const variantPath=(productId:string,variantId:string,section='sale')=>`/products/${productId}/variants/${variantId}/${section}`;

/** Market picker: a preset or explicit fields; nothing is guessed later. */
export function MarketFields({value,onChange,lockCurrency=false}:{value:VariantLocale;onChange:(v:VariantLocale)=>void;lockCurrency?:boolean}){
 const id=useId(),preset=markets.findIndex(m=>JSON.stringify(m.locale)===JSON.stringify(value));
 return <fieldset className="variant-market-fields"><legend>Mercado</legend>
  <label htmlFor={id+'p'}>País y idioma</label>
  <select id={id+'p'} value={preset>=0?String(preset):'custom'} onChange={e=>{if(e.target.value!=='custom'){const m=markets[Number(e.target.value)]!;if(!lockCurrency||m.locale.currency===value.currency)onChange(m.locale);}}}>
   {markets.map((m,i)=><option key={m.label} value={i} disabled={lockCurrency&&m.locale.currency!==value.currency}>{m.label} · {m.locale.currency}</option>)}
   <option value="custom">Otro mercado…</option>
  </select>
  <details><summary>Detalles del mercado</summary>
   <div className="variant-grid">
    <label>Nombre del mercado<input value={value.market} maxLength={160} onChange={e=>onChange({...value,market:e.target.value})}/></label>
    <label>País (código ISO)<input value={value.country} maxLength={2} onChange={e=>onChange({...value,country:e.target.value.toUpperCase()})}/></label>
    <label>Moneda (ISO){lockCurrency&&<span className="variant-hint"> · fija tras publicar</span>}<input value={value.currency} maxLength={3} disabled={lockCurrency} onChange={e=>onChange({...value,currency:e.target.value.toUpperCase()})}/></label>
    <label>Idioma<input value={value.language} maxLength={35} onChange={e=>onChange({...value,language:e.target.value})}/></label>
    <label>Zona horaria<input value={value.timezone} maxLength={128} onChange={e=>onChange({...value,timezone:e.target.value})}/></label>
   </div>
  </details>
  <p className="variant-hint">{languageLabel(value.language)} · {value.currency} · {value.timezone}</p>
 </fieldset>;
}

function CreateProduct({fence,open,onClose,onCreated}:{fence:ProfileFence;open:boolean;onClose:()=>void;onCreated:(productId:string,variantId:string)=>void}){
 const [name,setName]=useState(''),[description,setDescription]=useState(''),[locale,setLocale]=useState<VariantLocale>(markets[0]!.locale),[busy,setBusy]=useState(false),[error,setError]=useState(''),[key,setKey]=useState(newOperationKey);
 async function submit(e:FormEvent){e.preventDefault();setBusy(true);setError('');
  try{const r=await variantRequest<{product:{id:string};variant:VariantView}>(fence,'POST','/v2/products',{name:name.trim(),description,variant:{name:locale.market,locale}},key);setKey(newOperationKey());onCreated(r.product.id,r.variant.id);}
  catch(err){setError(message(err,'No se pudo crear el producto.'));}finally{setBusy(false);}}
 return <Dialog.Root open={open} onOpenChange={o=>{if(!o)onClose();}}><Dialog.Portal><Dialog.Overlay className="profile-switch-overlay"/><Dialog.Content className="profile-switch-dialog variant-dialog">
  <Dialog.Title>Crear producto</Dialog.Title><Dialog.Description>Empieza con un mercado. Incluye un flujo de venta y un vendedor que puedes editar.</Dialog.Description>
  <form onSubmit={submit} className="variant-form">
   <label>Nombre del producto<input required maxLength={160} value={name} onChange={e=>setName(e.target.value)} autoFocus/></label>
   <label>Descripción (opcional)<textarea maxLength={4000} value={description} onChange={e=>setDescription(e.target.value)} rows={3}/></label>
   <MarketFields value={locale} onChange={setLocale}/>
   {error&&<p role="alert">{error}</p>}
   <div className="variant-actions"><Dialog.Close asChild><Button type="button" variant="secondary">Cancelar</Button></Dialog.Close><Button disabled={busy||!name.trim()}>{busy?'Creando…':'Crear producto'}</Button></div>
  </form>
 </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function AddVariantDialog({fence,productId,source,open,onClose,onCreated}:{fence:ProfileFence;productId:string;source?:{id:string;name:string;locale:VariantLocale};open:boolean;onClose:()=>void;onCreated:(variantId:string)=>void}){
 const [locale,setLocale]=useState<VariantLocale>(markets[1]!.locale),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[key,setKey]=useState(newOperationKey);
 async function submit(e:FormEvent){e.preventDefault();setBusy(true);setError('');
  try{const body={name:(name||locale.market).trim(),locale};
   const r=source?await variantRequest<VariantView>(fence,'POST',`/v2/variants/${source.id}/duplicate`,body,key):await variantRequest<VariantView>(fence,'POST','/v2/variants',{product_id:productId,...body},key);
   setKey(newOperationKey());onCreated(r.id);}
  catch(err){setError(message(err,'No se pudo crear la variante.'));}finally{setBusy(false);}}
 return <Dialog.Root open={open} onOpenChange={o=>{if(!o)onClose();}}><Dialog.Portal><Dialog.Overlay className="profile-switch-overlay"/><Dialog.Content className="profile-switch-dialog variant-dialog">
  <Dialog.Title>{source?`Duplicar «${source.name}» a otro país`:'Agregar variante'}</Dialog.Title>
  <Dialog.Description>{source?'Se copia flujo, oferta y materiales como borrador independiente. No se convierte el precio, no se traducen textos, no se copia el cobro ni los números y no se activa la venta. Revisarás precio, idioma, cobro y horarios.':'Cada variante es un mercado con su moneda, idioma, cobro y números.'}</Dialog.Description>
  <form onSubmit={submit} className="variant-form">
   <MarketFields value={locale} onChange={v=>{setLocale(v);}}/>
   <label>Nombre de la variante<input maxLength={160} value={name} placeholder={locale.market} onChange={e=>setName(e.target.value)}/></label>
   {error&&<p role="alert">{error}</p>}
   <div className="variant-actions"><Dialog.Close asChild><Button type="button" variant="secondary">Cancelar</Button></Dialog.Close><Button disabled={busy}>{busy?'Creando…':source?'Crear copia':'Agregar variante'}</Button></div>
  </form>
 </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function VariantRows({product}:{product:ProductSummary}){
 if(!product.variants.length)return <p className="variant-hint">Este producto aún no tiene mercados configurados.</p>;
 return <table className="variant-table"><thead><tr><th scope="col">Mercado</th><th scope="col">Idioma</th><th scope="col">Moneda</th><th scope="col">Operación</th><th scope="col"><span className="sr-only">Abrir</span></th></tr></thead>
  <tbody>{product.variants.map(v=><tr key={v.id}>
   <td data-label="Mercado">{v.name}</td><td data-label="Idioma">{languageLabel(v.locale.language)}</td><td data-label="Moneda">{v.locale.currency}</td>
   <td data-label="Operación"><span className={`number-status variant-state-${stateTone(v.state)}`}>{v.state_label}</span>{v.unpublished_changes&&v.state!=='NEEDS_SETUP'&&<span className="variant-hint"> · cambios sin publicar</span>}{v.numbers>0&&<span className="variant-hint"> · {v.numbers} {v.numbers===1?'número':'números'}</span>}</td>
   <td><a href={variantPath(product.id,v.id)}>Abrir<span className="sr-only"> {v.name}</span> →</a></td>
  </tr>)}</tbody></table>;
}

export function ProductsHome({selection,role,state}:{selection:ProfileFence;role:ProfileRole;state:ProfileState}){
 const manage=role!=='viewer'&&state==='ACTIVE';
 const [products,setProducts]=useState<ProductSummary[]>(),[error,setError]=useState(''),[creating,setCreating]=useState(false),[filter,setFilter]=useState(''),[adopting,setAdopting]=useState('');
 const load=useCallback(async(signal?:AbortSignal)=>{try{setProducts(await variantRequest<ProductSummary[]>(selection,'GET','/v2/products',undefined,undefined,signal));setError('');}catch(e){if(!signal?.aborted)setError(message(e,'No se pudieron consultar tus productos.'));}},[selection]);
 useEffect(()=>{const c=new AbortController();void load(c.signal);return()=>c.abort();},[load]);
 async function adopt(p:ProductSummary){setAdopting(p.id);try{const r=await variantRequest<{variant_id:string}>(selection,'POST',`/v2/products/${p.id}/adopt`,{},newOperationKey());window.location.assign(variantPath(p.id,r.variant_id));}catch(e){setError(message(e,'No se pudo configurar el mercado.'));}finally{setAdopting('');}}
 const shown=(products??[]).filter(p=>!filter||p.name.toLowerCase().includes(filter.toLowerCase()));
 return <section className="products-v7" aria-labelledby="products-title">
  <div className="variant-heading"><h1 id="products-title">Productos</h1>{manage&&!(products&&!products.length)&&<Button onClick={()=>setCreating(true)}>Crear producto</Button>}</div>
  <p className="variant-hint">Un producto, varios mercados. Cada mercado tiene su precio, idioma, cobro y números.</p>
  {error&&<p role="alert">{error}</p>}
  {!products&&!error&&<p role="status">Consultando productos…</p>}
  {products&&products.length>5&&<label className="variant-filter">Buscar producto<input value={filter} onChange={e=>setFilter(e.target.value)} maxLength={160}/></label>}
  {products&&!products.length&&<div className="profile-numbers-empty"><h2>Crea tu primer producto</h2><p>En menos de 15 minutos: nombre, mercado, precio, flujo de venta y vendedor.</p>{manage&&<Button onClick={()=>setCreating(true)}>Crear producto</Button>}</div>}
  <ul className="products-v7-list">{shown.map(p=><li key={p.id} className="products-v7-card">
   <div className="variant-heading"><h2><a href={`/products/${p.id}`}>{p.name}</a></h2>{p.archived&&<span className="number-status">Archivado</span>}</div>
   {p.description&&<p className="variant-hint">{p.description}</p>}
   <VariantRows product={p}/>
   {!p.variants.length&&manage&&!p.archived&&<Button variant="secondary" disabled={adopting===p.id} onClick={()=>void adopt(p)}>{adopting===p.id?'Configurando…':'Configurar como variante México'}</Button>}
  </li>)}</ul>
  <CreateProduct fence={selection} open={creating} onClose={()=>setCreating(false)} onCreated={(productId,variantId)=>window.location.assign(variantPath(productId,variantId))}/>
 </section>;
}

export function ProductDetail({productId,selection,role,state}:{productId:string;selection:ProfileFence;role:ProfileRole;state:ProfileState}){
 const manage=role!=='viewer'&&state==='ACTIVE';
 const [product,setProduct]=useState<ProductSummary|null>(),[error,setError]=useState(''),[adding,setAdding]=useState(false),[copy,setCopy]=useState<ProductSummary['variants'][number]|null>(null),[editing,setEditing]=useState(false);
 const [name,setName]=useState(''),[description,setDescription]=useState(''),[busy,setBusy]=useState(false);
 const load=useCallback(async(signal?:AbortSignal)=>{try{const all=await variantRequest<ProductSummary[]>(selection,'GET','/v2/products?include=all',undefined,undefined,signal);const p=all.find(x=>x.id===productId)??null;setProduct(p);if(p){setName(p.name);setDescription(p.description);}setError('');}catch(e){if(!signal?.aborted)setError(message(e,'No se pudo consultar el producto.'));}},[selection,productId]);
 useEffect(()=>{const c=new AbortController();void load(c.signal);return()=>c.abort();},[load]);
 async function save(e:FormEvent){e.preventDefault();if(!product)return;setBusy(true);setError('');try{await variantRequest(selection,'PATCH',`/v2/products/${product.id}`,{expected_version:product.version,name,description},newOperationKey());setEditing(false);await load();}catch(err){setError(message(err,'No se pudo guardar.'));}finally{setBusy(false);}}
 async function lifecycle(action:'archive'|'restore'){if(!product)return;setBusy(true);setError('');try{await variantRequest(selection,'POST',`/v2/products/${product.id}/${action}`,{expected_version:product.version},newOperationKey());await load();}catch(err){setError(message(err,'No se pudo cambiar el producto.'));}finally{setBusy(false);}}
 if(product===null)return <section><a href="/products">← Productos</a><p role="alert">No encontramos ese producto en este perfil.</p></section>;
 return <section className="products-v7" aria-labelledby="product-title">
  <nav aria-label="Ruta" className="variant-breadcrumb"><a href="/products">Productos</a> › <span>{product?.name??'…'}</span></nav>
  {error&&<p role="alert">{error}</p>}
  {product&&<>
   <div className="variant-heading"><h1 id="product-title">{product.name}</h1>{manage&&!product.archived&&<Button onClick={()=>setAdding(true)}>Agregar variante</Button>}</div>
   <p className="variant-hint">Un producto, varios mercados.{product.archived?' Este producto está archivado.':''}</p>
   <table className="variant-table"><thead><tr><th scope="col">Mercado</th><th scope="col">Idioma</th><th scope="col">Moneda</th><th scope="col">Operación</th><th scope="col"><span className="sr-only">Acciones</span></th></tr></thead>
    <tbody>{product.variants.map(v=><tr key={v.id}><td data-label="Mercado">{v.name}</td><td data-label="Idioma">{languageLabel(v.locale.language)}</td><td data-label="Moneda">{v.locale.currency}</td>
     <td data-label="Operación"><span className={`number-status variant-state-${stateTone(v.state)}`}>{v.state_label}</span></td>
     <td className="variant-row-actions"><a href={variantPath(product.id,v.id)}>Abrir<span className="sr-only"> {v.name}</span></a><a href={`/results?family_id=${product.id}&variant_id=${v.id}`}>Resultados<span className="sr-only"> de {v.name}</span></a>{manage&&v.state!=='ARCHIVED'&&<Button size="sm" variant="secondary" onClick={()=>setCopy(v)}>Duplicar a otro país</Button>}</td></tr>)}</tbody></table>
   <p className="variant-hint">Totales del producto, por moneda: <a href={`/results?family_id=${product.id}`}>ver resultados del producto</a>. Nunca se suman monedas distintas.</p>
   {manage&&<details className="variant-advanced" open={editing} onToggle={e=>setEditing((e.target as HTMLDetailsElement).open)}><summary>Editar producto</summary>
    <form onSubmit={save} className="variant-form"><label>Nombre<input required maxLength={160} value={name} onChange={e=>setName(e.target.value)}/></label>
     <label>Descripción<textarea maxLength={4000} rows={3} value={description} onChange={e=>setDescription(e.target.value)}/></label>
     <div className="variant-actions"><Button disabled={busy}>Guardar producto</Button>{product.archived?<Button type="button" variant="secondary" disabled={busy} onClick={()=>void lifecycle('restore')}>Restaurar producto</Button>:<Button type="button" variant="secondary" disabled={busy} onClick={()=>void lifecycle('archive')}>Archivar producto</Button>}</div>
    </form></details>}
   <AddVariantDialog fence={selection} productId={product.id} open={adding} onClose={()=>setAdding(false)} onCreated={id=>window.location.assign(variantPath(product.id,id))}/>
   {copy&&<AddVariantDialog fence={selection} productId={product.id} source={copy} open onClose={()=>setCopy(null)} onCreated={id=>window.location.assign(variantPath(product.id,id))}/>}
  </>}
  {product===undefined&&!error&&<p role="status">Consultando producto…</p>}
 </section>;
}
