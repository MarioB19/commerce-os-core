import {useCallback,useEffect,useMemo,useRef,useState,type FormEvent,type ReactNode} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import type {VariantDocument} from '../../../../packages/contracts/src/variants.js';
import {paymentLinkProviderLabels,paymentLinkProviders} from '../../../../packages/contracts/src/variants.js';
import type {ProfileFence} from '../lib/profile-request.js';
import {variantRequest,newOperationKey,toMinor,fromMinor,formatMoney,languageLabel,errorText,type VariantView,type VariantNumber,type NumberImpact,type HistoryView} from '../lib/variants.js';
import {Button} from './ui/button';
import {MarketFields,AddVariantDialog,stateTone,variantPath} from './products-v7.js';

/** V7 variant page (RF-06.a): exactly five sections in this order, same on
 * desktop and mobile. Saving keeps a draft; publishing applies to new
 * conversations only. No tests, results or authorization tabs here. */
export const variantSectionTabs=[['sale','Venta'],['offer','Oferta y materiales'],['collection','Cobro'],['remarketing','Remarketing'],['numbers','Números']] as const;
export type VariantTab=typeof variantSectionTabs[number][0];
const message=errorText;
interface Material {id:string;version:number;name:string;kind:string;mime_type:string|null;size_bytes:number;status:string;status_label:string;host:string|null;deliverable:boolean;archived:boolean;used_by_variants:number}
interface SectionProps {variant:VariantView;fence:ProfileFence;manage:boolean;owner:boolean;materials:Material[];reloadMaterials:()=>Promise<void>;save:(path:string,value:unknown)=>Promise<boolean>}

export function VariantEditor({productId,variantId,section,selection,role,state}:{productId:string;variantId:string;section:VariantTab;selection:ProfileFence;role:ProfileRole;state:ProfileState}){
 const manage=role!=='viewer'&&state==='ACTIVE';
 const [variant,setVariant]=useState<VariantView|null>(),[error,setError]=useState(''),[notice,setNotice]=useState(''),[materials,setMaterials]=useState<Material[]>([]),[busy,setBusy]=useState(false),[copy,setCopy]=useState(false);
 const load=useCallback(async(signal?:AbortSignal)=>{try{const v=await variantRequest<VariantView>(selection,'GET',`/v2/variants/${variantId}`,undefined,undefined,signal);if(v.product.id!==productId){setVariant(null);return;}setVariant(v);setError('');}catch(e){if(!signal?.aborted){if((e as {status?:number}).status===404)setVariant(null);else setError(message(e,'No se pudo consultar la variante.'));}}},[selection,variantId,productId]);
 const reloadMaterials=useCallback(async()=>{try{setMaterials(await variantRequest<Material[]>(selection,'GET','/v2/materials'));}catch{/* the section shows the list it already has */}},[selection]);
 useEffect(()=>{const c=new AbortController();void load(c.signal);void reloadMaterials();return()=>c.abort();},[load,reloadMaterials]);
 // While busy every control is disabled, so the browser drops focus to the
 // page. Once the action ends, focus returns to the control that started it
 // (or to the result message) instead of the top of the page.
 const keepFocus=()=>{const origin=document.activeElement as HTMLElement|null;return()=>requestAnimationFrame(()=>{if(document.activeElement&&document.activeElement!==document.body)return;
  if(origin&&origin!==document.body&&origin.isConnected&&!(origin as HTMLButtonElement).disabled)origin.focus({preventScroll:true});else document.getElementById('variant-feedback')?.focus({preventScroll:true});});};
 // Sequential saves (Venta → modelo → mercado) must each use the latest version.
 const latest=useRef<VariantView|null|undefined>(undefined);latest.current=variant;
 const save=useCallback(async(path:string,value:unknown)=>{const current=latest.current;if(!current)return false;const back=keepFocus();setBusy(true);setError('');setNotice('');
  try{const v=await variantRequest<VariantView>(selection,'PUT',`/v2/variants/${current.id}/${path}`,{expected_version:current.version,value},newOperationKey());latest.current=v;setVariant(v);setNotice('Cambios guardados. Publica para usarlos en conversaciones nuevas.');return true;}
  catch(e){setError(message(e,'No se pudo guardar.'));return false;}finally{setBusy(false);back();}},[selection]);
 async function publish(){if(!variant)return;const back=keepFocus();setBusy(true);setError('');setNotice('');
  try{const r=await variantRequest<{variant:VariantView;numbers_following:number}>(selection,'POST',`/v2/variants/${variant.id}/publish`,{expected_version:variant.version,document_sha256:variant.document_sha256},newOperationKey());
   setVariant(r.variant);setNotice(r.numbers_following?`Publicado. Las conversaciones nuevas de ${r.numbers_following} ${r.numbers_following===1?'número':'números'} usarán estos cambios; las que están en curso conservan su configuración.`:'Publicado. Asigna un número para empezar a vender.');}
  catch(e){setError(message(e,'No se pudo publicar.'));}finally{setBusy(false);back();}}
 async function review(fields:string[]){if(!variant)return;const back=keepFocus();setBusy(true);try{setVariant(await variantRequest<VariantView>(selection,'POST',`/v2/variants/${variant.id}/review`,{expected_version:variant.version,reviewed:fields},newOperationKey()));}catch(e){setError(message(e,'No se pudo marcar como revisado.'));}finally{setBusy(false);back();}}
 async function lifecycle(action:'archive'|'restore'){if(!variant)return;const back=keepFocus();setBusy(true);setError('');try{setVariant(await variantRequest<VariantView>(selection,'POST',`/v2/variants/${variant.id}/${action}`,{expected_version:variant.version},newOperationKey()));}catch(e){setError(message(e,'No se pudo cambiar la variante.'));}finally{setBusy(false);back();}}
 if(variant===null)return <section><a href="/products">← Productos</a><p role="alert">No encontramos esa variante en este perfil.</p></section>;
 if(!variant)return <section aria-busy="true">{error?<p role="alert">{error}</p>:<p role="status">Consultando variante…</p>}</section>;
 const d=variant.document,blocking=variant.missing.filter(m=>m.code!=='publish'),canPublish=manage&&!variant.archived&&!blocking.length&&(variant.unpublished_changes||!variant.published);
 const props:SectionProps={variant,fence:selection,manage:manage&&!variant.archived&&!busy,owner:role==='owner'&&state==='ACTIVE',materials,reloadMaterials,save};
 return <section className="variant-editor" aria-labelledby="variant-title">
  <nav aria-label="Ruta" className="variant-breadcrumb"><a href="/products">Productos</a> › <a href={`/products/${productId}`}>{variant.product.name}</a> › <span>{d.name}</span></nav>
  <div className="variant-heading"><h1 id="variant-title">{variant.product.name} · {d.name}</h1>
   <span className={`number-status variant-state-${stateTone(variant.state)}`}>{variant.state_label}</span>
   {manage&&!variant.archived&&(variant.unpublished_changes||!variant.published)&&<Button disabled={!canPublish||busy} onClick={()=>void publish()}>{busy?'Guardando…':variant.published?'Publicar cambios':'Publicar variante'}</Button>}
  </div>
  <p className="variant-hint">{languageLabel(d.locale.language)} · {d.locale.currency} · {d.locale.timezone}. Los cambios se aplican a conversaciones nuevas; las conversaciones en curso conservan su configuración.</p>
  {variant.unpublished_changes&&variant.published&&<p className="variant-pending" role="status">Tienes cambios guardados sin publicar.</p>}
  <div id="variant-feedback" tabIndex={-1} className="variant-feedback">{notice&&<p role="status" className="variant-notice">{notice}</p>}{error&&<p role="alert">{error}</p>}</div>
  {blocking.length>0&&<div className="variant-missing" role="region" aria-label="Lo que falta"><strong>Para publicar falta:</strong><ul>{blocking.map(m=><li key={m.code}>{m.label}</li>)}</ul></div>}
  {d.pending_review.length>0&&manage&&<ReviewPanel fields={d.pending_review} busy={busy} onReview={fields=>void review(fields)}/>}
  <nav className="variant-tabs" aria-label="Secciones de la variante">{variantSectionTabs.map(([key,label])=><a key={key} href={variantPath(productId,variant.id,key)} aria-current={key===section?'page':undefined}>{label}</a>)}</nav>
  <div className="variant-section">
   {section==='sale'&&<SaleSection {...props}/>}
   {section==='offer'&&<OfferSection {...props}/>}
   {section==='collection'&&<CollectionSection {...props}/>}
   {section==='remarketing'&&<RemarketingSection {...props}/>}
   {section==='numbers'&&<NumbersSection {...props} onChanged={()=>void load()}/>}
  </div>
  <details className="variant-advanced"><summary>Más opciones de la variante</summary>
   <div className="variant-actions">
    {manage&&!variant.archived&&<Button variant="secondary" onClick={()=>setCopy(true)}>Duplicar a otro país</Button>}
    {manage&&(variant.archived?<Button variant="secondary" disabled={busy} onClick={()=>void lifecycle('restore')}>Restaurar variante</Button>:<Button variant="secondary" disabled={busy||variant.numbers.length>0} onClick={()=>void lifecycle('archive')}>Archivar variante</Button>)}
   </div>
   {variant.numbers.length>0&&<p className="variant-hint">Para archivarla, primero quita los números que la venden.</p>}
   <History fence={selection} variantId={variant.id}/>
  </details>
  {copy&&<AddVariantDialog fence={selection} productId={productId} source={{id:variant.id,name:d.name,locale:d.locale}} open onClose={()=>setCopy(false)} onCreated={id=>window.location.assign(variantPath(productId,id))}/>}
 </section>;
}

const reviewLabels:Record<string,string>={language:'Idioma de los textos',price_currency:'Precio y moneda',collection:'Cobro',flow_seller:'Flujo y vendedor',remarketing:'Remarketing y horarios',materials:'Materiales'};
function ReviewPanel({fields,busy,onReview}:{fields:readonly string[];busy:boolean;onReview:(fields:string[])=>void}){
 const [checked,setChecked]=useState<string[]>([]);
 return <div className="variant-review" role="region" aria-label="Revisión de la copia"><strong>Esta variante es una copia. Revisa estos puntos antes de publicar:</strong>
  <ul>{fields.map(f=><li key={f}><label><input type="checkbox" checked={checked.includes(f)} onChange={e=>setChecked(c=>e.target.checked?[...c,f]:c.filter(x=>x!==f))}/> {reviewLabels[f]??f}</label></li>)}</ul>
  <Button variant="secondary" disabled={busy||!checked.length} onClick={()=>{onReview(checked);setChecked([]);}}>Marcar como revisado</Button></div>;
}

function History({fence,variantId}:{fence:ProfileFence;variantId:string}){
 const [history,setHistory]=useState<HistoryView>(),[open,setOpen]=useState(false);
 useEffect(()=>{if(!open||history)return;const c=new AbortController();variantRequest<HistoryView>(fence,'GET',`/v2/variants/${variantId}/history`,undefined,undefined,c.signal).then(setHistory).catch(()=>undefined);return()=>c.abort();},[open,history,fence,variantId]);
 return <details onToggle={e=>setOpen((e.target as HTMLDetailsElement).open)}><summary>Historial</summary>
  {!history?<p role="status">Consultando historial…</p>:<ol className="variant-history">{history.events.map(e=><li key={e.version}><time dateTime={e.at}>{new Date(e.at).toLocaleString('es-MX')}</time> · {e.label}{e.section?` (${({sale:'Venta',offer:'Oferta',collection:'Cobro',remarketing:'Remarketing',ai:'Modelo',locale:'Mercado'} as Record<string,string>)[e.section]??e.section})`:''}</li>)}</ol>}
 </details>;
}

function Field({label,hint,children}:{label:string;hint?:string;children:ReactNode}){return <label className="variant-field"><span>{label}</span>{children}{hint&&<small className="variant-hint">{hint}</small>}</label>;}
function MaterialSelect({materials,value,onChange,accept,label}:{materials:Material[];value:string;onChange:(id:string)=>void;accept?:string;label:string}){
 const options=materials.filter(m=>m.status==='READY'&&!m.archived&&m.deliverable&&(!accept||(m.mime_type??'').startsWith(accept)));
 return <Field label={label}><select value={value} onChange={e=>onChange(e.target.value)}><option value="">Elige un material…</option>{options.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}{value&&!options.some(m=>m.id===value)&&<option value={value}>Material actual</option>}</select></Field>;
}

// ------------------------------------------------------------------ Venta
function SaleSection({variant,fence,manage,owner,materials,save}:SectionProps){
 const d=variant.document,[sale,setSale]=useState(d.sale),[ai,setAi]=useState(d.ai),[market,setMarket]=useState({name:d.name,locale:d.locale});
 const [aliases,setAliases]=useState(d.sale.aliases.join(', '));
 const [models,setModels]=useState<{provider:string;model:string;capabilities:string[]}[]>([]);
 useEffect(()=>{setSale(d.sale);setAi(d.ai);setMarket({name:d.name,locale:d.locale});setAliases(d.sale.aliases.join(', '));},[variant.version]);
 useEffect(()=>{const c=new AbortController();fetch('/v2/integrations',{credentials:'include',signal:c.signal,headers:{'X-Commerce-Profile-Id':fence.workspaceId,'X-Commerce-Profile-Version':String(fence.version)}}).then(r=>r.ok?r.json():null).then(v=>{if(v?.data?.ai?.models)setModels(v.data.ai.models);}).catch(()=>undefined);return()=>c.abort();},[fence]);
 const conversation=sale.conversation??{offer_message:'',agreement_message:'',deliver_before_payment:false,payment_message:'',thanks_message:''};
 const guided=sale.guided;
 async function submit(e:FormEvent){e.preventDefault();
  const list=aliases.split(',').map(a=>a.trim()).filter(Boolean);
  const value={...sale,aliases:list,conversation:sale.base==='conversation'?conversation:sale.conversation,existing_workflow_id:sale.base==='existing'?d.sale.existing_workflow_id:null};
  if(!await save('sale',value))return;
  if(JSON.stringify(ai)!==JSON.stringify(d.ai)&&!await save('ai',ai))return;
  if(JSON.stringify(market)!==JSON.stringify({name:d.name,locale:d.locale}))await save('market',market);
 }
 const setConv=(patch:Partial<typeof conversation>)=>setSale(s=>({...s,conversation:{...conversation,...patch}}));
 const chatModels=models.filter(m=>m.capabilities.includes('chat'));
 const pick=(v:string)=>{if(!v)return null;const [provider,...rest]=v.split('/');return{provider:provider as 'openai'|'anthropic'|'google',model:rest.join('/')};};
 return <form onSubmit={submit} className="variant-form" aria-label="Venta">
  <h2>Flujo de venta</h2>
  <Field label="Flujo base"><select value={sale.base} disabled={!manage} onChange={e=>setSale(s=>({...s,base:e.target.value as typeof s.base,conversation:e.target.value==='conversation'?conversation:s.conversation}))}>
   <option value="conversation">Venta por conversación</option><option value="guided">Venta guiada con audios (10 pasos)</option>
   {(d.sale.existing_workflow_id||sale.base==='existing')&&<option value="existing">Flujo actual (migrado)</option>}
  </select></Field>
  <p className="variant-flow-steps" aria-label="Pasos">{sale.base==='conversation'?(conversation.deliver_before_payment?'Oferta → Acuerdo → Entrega → Cobro → Comprobante → Gracias':'Oferta → Acuerdo → Cobro → Comprobante → Gracias → Entrega'):sale.base==='guided'?'Presentación → Imagen → Oferta → Acuerdo → Entrega previa → Cobro → Comprobante → Gracias → Entrega':'Se conserva el flujo que ya vendía este producto.'}</p>
  {sale.base==='conversation'&&<>
   <Field label="Mensaje de la oferta" hint="Puedes usar {{product_name}}, {{price}} y {{currency}}."><textarea rows={3} maxLength={4000} value={conversation.offer_message} disabled={!manage} onChange={e=>setConv({offer_message:e.target.value})}/></Field>
   <Field label="Cómo pides el acuerdo"><textarea rows={2} maxLength={4000} value={conversation.agreement_message} disabled={!manage} onChange={e=>setConv({agreement_message:e.target.value})}/></Field>
   <label className="variant-check"><input type="checkbox" checked={conversation.deliver_before_payment} disabled={!manage} onChange={e=>setConv({deliver_before_payment:e.target.checked})}/> Entregar el material al aceptar el acuerdo, antes del pago</label>
   <Field label="Mensaje de cobro" hint="Los datos de pago se agregan en {{bank_instructions}} desde la sección Cobro."><textarea rows={3} maxLength={4000} value={conversation.payment_message} disabled={!manage} onChange={e=>setConv({payment_message:e.target.value})}/></Field>
   <Field label="Agradecimiento al aprobar el pago"><textarea rows={2} maxLength={4000} value={conversation.thanks_message} disabled={!manage} onChange={e=>setConv({thanks_message:e.target.value})}/></Field>
  </>}
  {sale.base==='guided'&&<>
   <MaterialSelect label="Audio de presentación" accept="audio/" materials={materials} value={guided?.presentation.audio_asset_id??''} onChange={id=>setSale(s=>({...s,guided:{...(s.guided??emptyGuided()),presentation:{...(s.guided??emptyGuided()).presentation,audio_asset_id:id}}}))}/>
   <MaterialSelect label="Imagen del paquete" accept="image/" materials={materials} value={guided?.presentation.pack_image_asset_id??''} onChange={id=>setSale(s=>({...s,guided:{...(s.guided??emptyGuided()),presentation:{...(s.guided??emptyGuided()).presentation,pack_image_asset_id:id}}}))}/>
   <Field label="Texto de la oferta"><textarea rows={3} value={guided?.presentation.offer_text??''} onChange={e=>setSale(s=>({...s,guided:{...(s.guided??emptyGuided()),presentation:{...(s.guided??emptyGuided()).presentation,offer_text:e.target.value}}}))}/></Field>
   <MaterialSelect label="Audio del acuerdo" accept="audio/" materials={materials} value={guided?.agreement.audio_asset_id??''} onChange={id=>setSale(s=>({...s,guided:{...(s.guided??emptyGuided()),agreement:{...(s.guided??emptyGuided()).agreement,audio_asset_id:id}}}))}/>
   <Field label="Cómo pides el acuerdo"><textarea rows={2} value={guided?.agreement.prompt??''} onChange={e=>setSale(s=>({...s,guided:{...(s.guided??emptyGuided()),agreement:{...(s.guided??emptyGuided()).agreement,prompt:e.target.value}}}))}/></Field>
   <MaterialSelect label="Audio de cobro" accept="audio/" materials={materials} value={guided?.collection.audio_asset_id??''} onChange={id=>setSale(s=>({...s,guided:{...(s.guided??emptyGuided()),collection:{...(s.guided??emptyGuided()).collection,audio_asset_id:id}}}))}/>
   <Field label="Instrucciones de pago"><textarea rows={3} value={guided?.collection.payment_instructions??''} onChange={e=>setSale(s=>({...s,guided:{...(s.guided??emptyGuided()),collection:{...(s.guided??emptyGuided()).collection,payment_instructions:e.target.value}}}))}/></Field>
   <Field label="Agradecimiento al aprobar el pago"><textarea rows={2} value={guided?.closure.receipt_thanks??''} onChange={e=>setSale(s=>({...s,guided:{...(s.guided??emptyGuided()),closure:{receipt_thanks:e.target.value}}}))}/></Field>
  </>}
  <Field label="Cómo lo piden tus clientes (opcional)" hint="Nombres o frases separados por comas; ayudan a elegir el producto cuando un número vende varios."><input value={aliases} maxLength={2000} disabled={!manage} onChange={e=>setAliases(e.target.value)}/></Field>
  <h2>Vendedor</h2>
  <p className="variant-hint">Responde en {languageLabel(d.locale.language)}, el idioma de esta variante.</p>
  <Field label="Nombre del vendedor"><input required maxLength={160} value={sale.seller.name} disabled={!manage} onChange={e=>setSale(s=>({...s,seller:{...s.seller,name:e.target.value}}))}/></Field>
  <Field label="Cómo debe atender"><textarea rows={4} maxLength={8000} value={sale.seller.instructions} disabled={!manage} onChange={e=>setSale(s=>({...s,seller:{...s.seller,instructions:e.target.value}}))}/></Field>
  <Field label="Conocimiento del producto" hint="Preguntas frecuentes y datos que puede usar al responder."><textarea rows={5} maxLength={20000} value={sale.seller.knowledge} disabled={!manage} onChange={e=>setSale(s=>({...s,seller:{...s.seller,knowledge:e.target.value}}))}/></Field>
  <Field label="Límites"><textarea rows={2} maxLength={4000} value={sale.seller.limits} disabled={!manage} onChange={e=>setSale(s=>({...s,seller:{...s.seller,limits:e.target.value}}))}/></Field>
  <details className="variant-advanced"><summary>Modelo para esta variante</summary>
   <p className="variant-hint">Si no eliges uno, se usa el modelo predeterminado del perfil. El alterno sólo se usa para tareas que el principal no puede hacer.</p>
   <Field label="Modelo principal"><select value={ai.primary?`${ai.primary.provider}/${ai.primary.model}`:''} disabled={!manage} onChange={e=>setAi(a=>({...a,primary:pick(e.target.value)}))}><option value="">Predeterminado del perfil</option>{chatModels.map(m=><option key={m.provider+m.model} value={`${m.provider}/${m.model}`}>{m.provider} · {m.model}</option>)}</select></Field>
   <Field label="Modelo alterno (opcional)"><select value={ai.fallback?`${ai.fallback.provider}/${ai.fallback.model}`:''} disabled={!manage} onChange={e=>setAi(a=>({...a,fallback:pick(e.target.value)}))}><option value="">Sin alterno</option>{models.map(m=><option key={'f'+m.provider+m.model} value={`${m.provider}/${m.model}`}>{m.provider} · {m.model} ({m.capabilities.join(', ')})</option>)}</select></Field>
     <AiStatusPanel fence={fence} variantId={variant.id} version={variant.version} owner={owner}/>
  </details>
  <details className="variant-advanced"><summary>Mercado de la variante</summary>
   <Field label="Nombre de la variante"><input maxLength={160} value={market.name} disabled={!manage} onChange={e=>setMarket(m=>({...m,name:e.target.value}))}/></Field>
   <MarketFields value={market.locale} lockCurrency={!!variant.published} onChange={locale=>setMarket(m=>({...m,locale}))}/>
  </details>
  {manage&&<div className="variant-actions"><Button>Guardar venta</Button></div>}
 </form>;
}
const emptyGuided=():NonNullable<VariantDocument['sale']['guided']>=>({presentation:{audio_asset_id:'',pack_image_asset_id:'',offer_text:''},agreement:{audio_asset_id:'',prompt:''},collection:{audio_asset_id:'',payment_instructions:''},closure:{receipt_thanks:''}});

// ------------------------------------------------------------------ Oferta y materiales
function OfferSection({variant,fence,manage,materials,reloadMaterials,save}:SectionProps){
 const d=variant.document,currency=d.locale.currency,[offer,setOffer]=useState(d.offer),[price,setPrice]=useState(d.offer.price_minor?fromMinor(d.offer.price_minor,currency):''),[error,setError]=useState('');
 useEffect(()=>{setOffer(d.offer);setPrice(d.offer.price_minor?fromMinor(d.offer.price_minor,currency):'');},[variant.version]);
 const minor=toMinor(price,currency);
 async function submit(e:FormEvent){e.preventDefault();setError('');if(minor===null){setError('Escribe un precio válido.');return;}await save('offer',{...offer,price_minor:minor});}
 const byId=useMemo(()=>new Map(materials.map(m=>[m.id,m])),[materials]);
 return <div className="variant-form">
  <form onSubmit={submit} className="variant-form" aria-label="Oferta">
   <h2>Oferta</h2>
   <Field label="Nombre de la oferta"><input required maxLength={160} value={offer.name} disabled={!manage} onChange={e=>setOffer(o=>({...o,name:e.target.value}))}/></Field>
   <Field label={`Precio (${currency})`} hint={minor!==null&&minor>0?`Se mostrará como ${formatMoney(minor,currency,d.locale.language)}`:undefined}><input inputMode="decimal" required value={price} disabled={!manage} onChange={e=>setPrice(e.target.value)}/></Field>
   <h3>Qué recibe el cliente y cuándo</h3>
   {!offer.fulfillment.length&&<p className="variant-hint">Agrega al menos un material.</p>}
   <ul className="variant-list">{offer.fulfillment.map((f,i)=><li key={f.asset_id+f.release_on+i}>
    <span>{byId.get(f.asset_id)?.name??'Material'}</span>
    <select aria-label="Cuándo se entrega" value={f.release_on} disabled={!manage} onChange={e=>setOffer(o=>({...o,fulfillment:o.fulfillment.map((x,j)=>j===i?{...x,release_on:e.target.value as typeof x.release_on}:x)}))}>
     <option value="commitment_accepted">Al aceptar el acuerdo</option><option value="receipt_approved">Al aprobar el pago</option><option value="reconciled">Al conciliar el pago</option>
    </select>
    {manage&&<Button type="button" size="sm" variant="ghost" onClick={()=>setOffer(o=>({...o,fulfillment:o.fulfillment.filter((_,j)=>j!==i)}))}>Quitar</Button>}
   </li>)}</ul>
   {manage&&<MaterialSelect label="Agregar material entregable" materials={materials.filter(m=>!offer.fulfillment.some(f=>f.asset_id===m.id))} value="" onChange={id=>{if(id)setOffer(o=>({...o,fulfillment:[...o.fulfillment,{asset_id:id,release_on:'receipt_approved'}]}));}}/>}
   <details className="variant-advanced"><summary>Tiers y cobro diferido</summary>
    <ul className="variant-list">{offer.tiers.map((t,i)=><li key={t.id}><input aria-label="Nombre del tier" value={t.name} disabled={!manage} onChange={e=>setOffer(o=>({...o,tiers:o.tiers.map((x,j)=>j===i?{...x,name:e.target.value}:x)}))}/>
     <input aria-label="Total mínimo" inputMode="decimal" value={fromMinor(t.minimum_total_minor,currency)} disabled={!manage} onChange={e=>{const v=toMinor(e.target.value,currency);if(v!==null)setOffer(o=>({...o,tiers:o.tiers.map((x,j)=>j===i?{...x,minimum_total_minor:v}:x)}));}}/>
     {manage&&<Button type="button" size="sm" variant="ghost" onClick={()=>setOffer(o=>({...o,tiers:o.tiers.filter((_,j)=>j!==i)}))}>Quitar</Button>}</li>)}</ul>
    {manage&&offer.tiers.length<20&&<Button type="button" size="sm" variant="secondary" onClick={()=>setOffer(o=>({...o,tiers:[...o.tiers,{id:'tier-'+(o.tiers.length+1),name:'Nuevo tier',minimum_total_minor:0}]}))}>Agregar tier</Button>}
    {offer.legacy.madrina&&<p className="variant-hint">Esta oferta conserva la opción Madrina configurada anteriormente.</p>}
    <Field label="Espera antes de cobrar (minutos)"><input type="number" min={0} max={10080} value={Math.round(offer.billing_delay_seconds/60)} disabled={!manage} onChange={e=>setOffer(o=>({...o,billing_delay_seconds:Math.max(0,Math.min(604800,Number(e.target.value)*60))}))}/></Field>
   </details>
   {error&&<p role="alert">{error}</p>}
   {manage&&<div className="variant-actions"><Button>Guardar oferta</Button></div>}
  </form>
  <MaterialsPanel fence={fence} manage={manage} materials={materials} reload={reloadMaterials}/>
 </div>;
}

function MaterialsPanel({fence,manage,materials,reload}:{fence:ProfileFence;manage:boolean;materials:Material[];reload:()=>Promise<void>}){
 const [mode,setMode]=useState<'file'|'link'>('file'),[name,setName]=useState(''),[url,setUrl]=useState(''),[file,setFile]=useState<File|null>(null),[progress,setProgress]=useState(''),[error,setError]=useState('');
 async function upload(e:FormEvent){e.preventDefault();setError('');
  try{
   if(mode==='link'){await variantRequest(fence,'POST','/v2/materials',{kind:'link',name:name.trim(),url:url.trim()},newOperationKey());}
   else{
    if(!file)return;const bytes=new Uint8Array(await file.arrayBuffer());
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
    const created=await variantRequest<{id:string;upload:{part_bytes:number;parts:number}}>(fence,'POST','/v2/materials',{kind:'file',name:(name||file.name).trim().slice(0,160),mime_type:file.type,size_bytes:bytes.length,sha256:digest},newOperationKey());
    for(let i=0;i<created.upload.parts;i++){
     setProgress(`Subiendo ${i+1} de ${created.upload.parts}…`);
     const part=bytes.subarray(i*created.upload.part_bytes,(i+1)*created.upload.part_bytes);let binary='';for(let j=0;j<part.length;j+=0x8000)binary+=String.fromCharCode(...part.subarray(j,j+0x8000));
     await variantRequest(fence,'PUT',`/v2/materials/${created.id}/parts/${i+1}`,{base64:btoa(binary)},newOperationKey());
    }
    setProgress('Verificando…');await variantRequest(fence,'POST',`/v2/materials/${created.id}/complete`,{},newOperationKey());
   }
   setName('');setUrl('');setFile(null);setProgress('');await reload();
  }catch(err){setProgress('');setError(message(err,'No se pudo subir el material.'));}
 }
 return <section className="variant-materials" aria-labelledby="materials-title"><h2 id="materials-title">Materiales</h2>
  <ul className="variant-list">{materials.filter(m=>!m.archived).map(m=><li key={m.id}><span>{m.name}</span><small className="variant-hint">{m.kind==='link'?m.host:`${m.mime_type??''} · ${(m.size_bytes/1024/1024).toFixed(1)} MB`} · {m.status_label}</small>
   {m.kind==='file'&&m.status==='READY'&&<a href={`/v2/materials/${m.id}/content?environment=REAL`} target="_blank" rel="noreferrer">Ver<span className="sr-only"> {m.name}</span></a>}</li>)}</ul>
  {manage&&<form onSubmit={upload} className="variant-form" aria-label="Agregar material">
   <div role="radiogroup" aria-label="Tipo de material" className="variant-actions"><label><input type="radio" checked={mode==='file'} onChange={()=>setMode('file')}/> Archivo</label><label><input type="radio" checked={mode==='link'} onChange={()=>setMode('link')}/> Enlace</label></div>
   <Field label="Nombre"><input maxLength={160} value={name} onChange={e=>setName(e.target.value)} required={mode==='link'}/></Field>
   {mode==='file'?<Field label="Archivo" hint="PDF, imagen, audio o video de hasta 20 MB. Se guarda cifrado."><input type="file" accept="application/pdf,image/png,image/jpeg,audio/mpeg,audio/ogg,video/mp4,text/plain" onChange={e=>setFile(e.target.files?.[0]??null)}/></Field>
    :<Field label="Enlace (https://)"><input type="url" required maxLength={2000} value={url} onChange={e=>setUrl(e.target.value)}/></Field>}
   {progress&&<p role="status">{progress}</p>}{error&&<p role="alert">{error}</p>}
   <div className="variant-actions"><Button variant="secondary" disabled={!!progress||(mode==='file'&&!file)}>Agregar material</Button></div>
  </form>}
 </section>;
}

// ------------------------------------------------------------------ Cobro
function CollectionSection({variant,manage,save}:SectionProps){
 const c=variant.document.collection,currency=variant.document.locale.currency;
 const [spei,setSpei]=useState<'keep'|'new'|'none'>(c.spei?'keep':'none'),[bank,setBank]=useState(''),[holder,setHolder]=useState(''),[clabe,setClabe]=useState('');
 const [links,setLinks]=useState(c.links.map(l=>({id:l.id,label:l.label,provider:l.provider,host:l.host,url:'keep'})));
 const [instructions,setInstructions]=useState(c.instructions),[error,setError]=useState('');
 useEffect(()=>{setSpei(c.spei?'keep':'none');setLinks(c.links.map(l=>({id:l.id,label:l.label,provider:l.provider,host:l.host,url:'keep'})));setInstructions(c.instructions);setBank('');setHolder('');setClabe('');},[variant.version]);
 async function submit(e:FormEvent){e.preventDefault();setError('');
  if(spei==='none'&&!links.length){setError('Configura SPEI, un enlace de pago o ambos.');return;}
  const ok=await save('collection',{spei:spei==='keep'?'keep':spei==='new'?{bank:bank.trim(),holder:holder.trim(),clabe}:null,
   links:links.map(l=>({...(l.id?{id:l.id}:{}),label:l.label.trim(),provider:l.provider,url:l.url})),instructions});
  if(ok){setBank('');setHolder('');setClabe('');}
 }
 return <form onSubmit={submit} className="variant-form" aria-label="Cobro">
  <p className="variant-hint">El cliente recibe estos datos en el paso de cobro de su conversación. Se guardan cifrados; aquí sólo verás los últimos dígitos.</p>
  {c.legacy_profile_id&&<p className="variant-pending">Se usa el cobro configurado antes de V7. Si lo reemplazas aquí, las conversaciones nuevas usarán los datos nuevos al publicar.</p>}
  <fieldset className="variant-card"><legend>SPEI</legend>
   {currency!=='MXN'?<p className="variant-hint">SPEI sólo aplica a variantes en pesos mexicanos.</p>:<>
    {c.spei&&spei==='keep'&&<p>{c.spei.bank} · CLABE terminación {c.spei.last4}</p>}
    {manage&&<div className="variant-actions">{c.spei&&spei==='keep'?<><Button type="button" variant="secondary" onClick={()=>setSpei('new')}>Reemplazar</Button><Button type="button" variant="ghost" onClick={()=>setSpei('none')}>Quitar SPEI</Button></>:spei==='none'?<Button type="button" variant="secondary" onClick={()=>setSpei('new')}>Agregar SPEI</Button>:null}</div>}
    {spei==='new'&&<div className="variant-grid">
     <Field label="Banco"><input required maxLength={160} value={bank} onChange={e=>setBank(e.target.value)}/></Field>
     <Field label="Beneficiario"><input required maxLength={160} value={holder} onChange={e=>setHolder(e.target.value)} autoComplete="off"/></Field>
     <Field label="CLABE (18 dígitos)"><input required inputMode="numeric" autoComplete="off" maxLength={22} value={clabe} onChange={e=>setClabe(e.target.value.replace(/[^0-9 ]/g,''))}/></Field>
     {c.spei&&<Button type="button" variant="ghost" onClick={()=>setSpei('keep')}>Conservar la guardada</Button>}
    </div>}
   </>}
  </fieldset>
  <fieldset className="variant-card"><legend>Enlace de pago</legend>
   {links.map((l,i)=><div key={l.id??'new'+i} className="variant-grid">
    <Field label="Proveedor"><select value={l.provider} disabled={!manage} onChange={e=>setLinks(x=>x.map((y,j)=>j===i?{...y,provider:e.target.value as typeof y.provider}:y))}>{paymentLinkProviders.map(p=><option key={p} value={p}>{paymentLinkProviderLabels[p]}</option>)}</select></Field>
    <Field label="Etiqueta para el cliente"><input required maxLength={160} value={l.label} disabled={!manage} onChange={e=>setLinks(x=>x.map((y,j)=>j===i?{...y,label:e.target.value}:y))}/></Field>
    {l.url==='keep'?<p>Enlace guardado en {l.host} {manage&&<Button type="button" size="sm" variant="ghost" onClick={()=>setLinks(x=>x.map((y,j)=>j===i?{...y,url:''}:y))}>Reemplazar enlace</Button>}</p>
     :<Field label="Enlace (https://)"><input type="url" required maxLength={2000} value={l.url} onChange={e=>setLinks(x=>x.map((y,j)=>j===i?{...y,url:e.target.value}:y))}/></Field>}
    {manage&&<Button type="button" size="sm" variant="ghost" onClick={()=>setLinks(x=>x.filter((_,j)=>j!==i))}>Quitar enlace</Button>}
   </div>)}
   {manage&&links.length<5&&<Button type="button" variant="secondary" onClick={()=>setLinks(x=>[...x,{id:undefined as unknown as string,label:'Pagar en línea',provider:'other',host:'',url:''}])}>Agregar enlace</Button>}
  </fieldset>
  <Field label="Indicaciones para el cliente (opcional)"><textarea rows={2} maxLength={2000} value={instructions} disabled={!manage} onChange={e=>setInstructions(e.target.value)}/></Field>
  {error&&<p role="alert">{error}</p>}
  {manage&&<div className="variant-actions"><Button>Guardar cobro</Button></div>}
 </form>;
}

// ------------------------------------------------------------------ Remarketing
function RemarketingSection({variant,manage,materials,save}:SectionProps){
 const r=variant.document.remarketing,[policy,setPolicy]=useState(r);
 useEffect(()=>setPolicy(r),[variant.version]);
 const base=()=>({schema_version:1 as const,policy_id:'remarketing-3-slot' as const,policy_revision:1,slots:[1,2,3].map((position,i)=>({id:'slot-'+position,position:position as 1|2|3,enabled:false,delay:{quantity:[2,8,24][i]!,unit:'hours' as const},stages:{awaiting_agreement:{medium:'audio' as const,text:''},awaiting_payment:{medium:'audio' as const,text:''}}}))});
 const stageLabels={awaiting_agreement:'Si aún no acepta el acuerdo',awaiting_payment:'Si aún no paga'} as const;
 type Slot=NonNullable<typeof policy>['slots'][number];
 const update=(i:number,patch:(s:Slot)=>Slot)=>setPolicy(p=>p&&{...p,slots:p.slots.map((s,j)=>j===i?patch(s):s) as typeof p.slots});
 return <form onSubmit={e=>{e.preventDefault();void save('remarketing',policy);}} className="variant-form" aria-label="Remarketing">
  <p className="variant-hint">Seguimientos a personas que aún no compraron. Se detienen si compra, pide la baja, se alcanza el límite o pausas la venta. Zona: {variant.document.locale.timezone}.</p>
  {!policy?<>{manage&&<Button type="button" variant="secondary" onClick={()=>setPolicy(base())}>Configurar seguimientos</Button>}<p>Sin seguimientos configurados.</p></>:<>
   {policy.slots.map((slot,i)=><fieldset key={slot.id} className="variant-card"><legend>Seguimiento {slot.position}</legend>
    <label className="variant-check"><input type="checkbox" checked={slot.enabled} disabled={!manage} onChange={e=>update(i,s=>({...s,enabled:e.target.checked}))}/> Activo</label>
    {slot.position>1&&slot.enabled&&<label className="variant-check"><input type="checkbox" checked={slot.warning_acknowledged===true} disabled={!manage} onChange={e=>update(i,s=>({...s,warning_acknowledged:e.target.checked}))}/> Entiendo que más seguimientos aumentan el riesgo de bloqueo y bajas.</label>}
    <div className="variant-grid"><Field label="Espera"><input type="number" min={1} value={slot.delay.quantity} disabled={!manage} onChange={e=>update(i,s=>({...s,delay:{...s.delay,quantity:Math.max(1,Number(e.target.value))}}))}/></Field>
     <Field label="Unidad"><select value={slot.delay.unit} disabled={!manage} onChange={e=>update(i,s=>({...s,delay:{...s.delay,unit:e.target.value as typeof s.delay.unit}}))}><option value="minutes">minutos</option><option value="hours">horas</option><option value="days">días</option></select></Field></div>
    {(['awaiting_agreement','awaiting_payment'] as const).map(stage=><div key={stage} className="variant-stage"><strong>{stageLabels[stage]}</strong>
     <Field label="Mensaje"><textarea rows={2} maxLength={12000} value={slot.stages[stage].text} disabled={!manage} onChange={e=>update(i,s=>({...s,stages:{...s.stages,[stage]:{...s.stages[stage],text:e.target.value}}}))}/></Field>
     <MaterialSelect label="Audio o video" materials={materials.filter(m=>/^(audio|video)\//.test(m.mime_type??''))} value={slot.stages[stage].asset_id??''} onChange={id=>update(i,s=>({...s,stages:{...s.stages,[stage]:{...s.stages[stage],asset_id:id||undefined,medium:(materials.find(m=>m.id===id)?.mime_type??'').startsWith('video/')?'video':'audio'}}}))}/>
    </div>)}
   </fieldset>)}
   {manage&&<div className="variant-actions"><Button>Guardar remarketing</Button><Button type="button" variant="ghost" onClick={()=>setPolicy(null)}>Quitar seguimientos</Button></div>}
  </>}
  {!policy&&r&&manage&&<div className="variant-actions"><Button>Guardar sin seguimientos</Button></div>}
 </form>;
}

// ------------------------------------------------------------------ Números
function NumbersSection({variant,fence,manage,onChanged}:SectionProps&{onChanged:()=>void}){
 const [rows,setRows]=useState<VariantNumber[]>(),[error,setError]=useState(''),[confirm,setConfirm]=useState<{row:VariantNumber;impact:NumberImpact}|null>(null),[busy,setBusy]=useState('');
 const [inverse,setInverse]=useState<{account_id:string;name:string;sells:{product:string;variant:string;offer_id:string|null}[]}[]>();
 const load=useCallback(async()=>{try{setRows(await variantRequest<VariantNumber[]>(fence,'GET',`/v2/variants/${variant.id}/numbers`));setError('');}catch(e){setError(message(e,'No se pudieron consultar los números.'));}},[fence,variant.id]);
 useEffect(()=>{void load();},[load]);
 async function sell(row:VariantNumber,value:boolean){setBusy(row.account_id);setError('');
  try{await variantRequest(fence,'POST',`/v2/variants/${variant.id}/numbers`,{account_id:row.account_id,sell:value},newOperationKey());setConfirm(null);await load();onChanged();}
  catch(e){setError(message(e,'No se pudo cambiar el número.'));}finally{setBusy('');}}
 async function askRemove(row:VariantNumber){try{setConfirm({row,impact:await variantRequest<NumberImpact>(fence,'GET',`/v2/variants/${variant.id}/numbers/${row.account_id}/impact`)});}catch(e){setError(message(e,'No se pudo consultar el impacto.'));}}
 return <div aria-label="Números">
  {!variant.published&&<p className="variant-pending">Publica la variante para poder asignarla a un número.</p>}
  {error&&<p role="alert">{error}</p>}
  {!rows&&!error&&<p role="status">Consultando números…</p>}
  {rows&&!rows.length&&<p>Aún no tienes números. <a href="/numbers">Agrega uno en Números</a>.</p>}
  {rows&&rows.length>0&&<table className="variant-table"><thead><tr><th scope="col">Número</th><th scope="col">Otras variantes que vende</th><th scope="col">Vender esta variante</th></tr></thead>
   <tbody>{rows.map(r=><tr key={r.account_id}><td data-label="Número">{r.name}{r.masked&&<small className="variant-hint"> · {r.masked}</small>}</td>
    <td data-label="Otras variantes"><Sells items={[...r.others.map(o=>`${o.product} · ${o.variant}`),...(r.same_product?[`${variant.product.name} · ${r.same_product.label}`]:[])]}/></td>
    <td data-label="Vender esta variante">{r.sells_this?<span className="variant-toggle"><strong>Sí</strong>{manage&&<Button size="sm" variant="secondary" disabled={!!busy} onClick={()=>void askRemove(r)}>Dejar de vender</Button>}</span>
     :r.same_product?.variant_id?<span className="variant-hint">Vende otra variante de este producto. Quítala primero.</span>
     :<span className="variant-toggle"><span>No</span>{manage&&variant.published&&<Button size="sm" disabled={!!busy} onClick={()=>void sell(r,true)}>{busy===r.account_id?'Asignando…':r.same_product?'Vender esta variante (reemplaza la configuración anterior)':'Vender en este número'}</Button>}</span>}</td></tr>)}</tbody></table>}
  <p className="variant-hint">Asignar es permanente: el número vende esta variante hasta que lo quites o lo pauses. Las pausas, bajas y protecciones siempre se respetan.</p>
  <details className="variant-advanced" onToggle={e=>{if((e.target as HTMLDetailsElement).open&&!inverse)variantRequest<NonNullable<typeof inverse>>(fence,'GET','/v2/number-variants').then(setInverse).catch(()=>undefined);}}><summary>Vista inversa: número → variantes</summary>
   {!inverse?<p role="status">Consultando…</p>:<ul className="variant-list">{inverse.map(n=><li key={n.account_id}><strong>{n.name}</strong> <Sells items={n.sells.map(s=>`${s.product} · ${s.variant}`)} empty="sin variantes"/></li>)}</ul>}
  </details>
  {confirm&&<Dialog.Root open onOpenChange={o=>{if(!o)setConfirm(null);}}><Dialog.Portal><Dialog.Overlay className="profile-switch-overlay"/><Dialog.Content className="profile-switch-dialog variant-dialog">
   <Dialog.Title>Dejar de vender en {confirm.row.name}</Dialog.Title>
   <Dialog.Description>{confirm.impact.effect}</Dialog.Description>
   <ul><li>Conversaciones abiertas: {confirm.impact.open_conversations}</li><li>Seguimientos pendientes que se cancelan: {confirm.impact.pending_followups}</li><li>Mensajes aún no enviados que se cancelan: {confirm.impact.unsent_messages}</li></ul>
   <div className="variant-actions"><Dialog.Close asChild><Button variant="secondary">Seguir vendiendo</Button></Dialog.Close><Button variant="destructive" disabled={!!busy} onClick={()=>void sell(confirm.row,false)}>Dejar de vender</Button></div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>}
 </div>;
}

interface AiTaskStatus {task:string;label:string;state:'READY'|'NEEDS_OWNER'|'HUMAN_REQUIRED';state_label:string;provider:string|null;model:string|null;selection:string|null;grant_expires_at:string|null}
/** RF-14/RF-13.d: what the variant's AI uses per task and why it may not run. */
function AiStatusPanel({fence,variantId,version,owner}:{fence:ProfileFence;variantId:string;version:number;owner:boolean}){
 const [status,setStatus]=useState<AiTaskStatus[]>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const load=useCallback(async()=>{try{setStatus(await variantRequest<AiTaskStatus[]>(fence,'GET',`/v2/variants/${variantId}/ai-status`));}catch(e){setError(message(e,'No se pudo consultar la IA.'));}},[fence,variantId]);
 useEffect(()=>{void load();},[load,version]);
 async function confirm(){setBusy(true);setError('');try{const r=await variantRequest<{status:AiTaskStatus[]}>(fence,'POST',`/v2/variants/${variantId}/ai-authorization`,{},newOperationKey());setStatus(r.status);}catch(e){setError(message(e,'No se pudo confirmar la IA.'));}finally{setBusy(false);}}
 if(!status)return error?<p role="alert">{error}</p>:<p role="status">Consultando la IA de la variante…</p>;
 return <div className="variant-ai-status"><h3>Estado de la IA (variante publicada)</h3>
  <ul className="variant-list">{status.map(t=><li key={t.task}><strong>{t.label}</strong><span>{t.provider?`${t.provider} · ${t.model}`:'—'}</span><span className={`number-status variant-state-${t.state==='READY'?'ok':'attention'}`}>{t.state==='READY'?'Lista':t.state_label}</span></li>)}</ul>
  {owner&&status.some(t=>t.state==='NEEDS_OWNER')&&<Button type="button" variant="secondary" disabled={busy} onClick={()=>void confirm()}>{busy?'Confirmando…':'Confirmar la IA de esta variante'}</Button>}
  {!owner&&status.some(t=>t.state==='NEEDS_OWNER')&&<p className="variant-hint">La persona Dueña debe confirmar la IA de esta variante. Mientras tanto, las conversaciones pasan a atención de una persona.</p>}
  <p className="variant-hint">Los costos de IA se cobran con la clave de tu negocio y se registran por variante y conversación con el precio vigente.</p>
  {error&&<p role="alert">{error}</p>}
 </div>;
}
/** Each product · variant pair is one item, so long lists stay readable. */
function Sells({items,empty='—'}:{items:string[];empty?:string}){return items.length?<ul className="variant-sells">{items.map((item,i)=><li key={i}>{item}</li>)}</ul>:<span>{empty}</span>;}
