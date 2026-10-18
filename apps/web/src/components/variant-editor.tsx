import {useCallback,useEffect,useMemo,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {Archive,CircleAlert,CircleCheck,CircleDashed,Copy,History as HistoryIcon,Link2,Paperclip,Upload} from 'lucide-react';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import type {VariantDocument} from '../../../../packages/contracts/src/variants.js';
import {paymentLinkProviderLabels,paymentLinkProviders} from '../../../../packages/contracts/src/variants.js';
import type {ProfileFence} from '../lib/profile-request.js';
import {variantRequest,newOperationKey,toMinor,fromMinor,formatMoney,languageLabel,errorText,type VariantView,type VariantNumber,type NumberImpact,type HistoryView} from '../lib/variants.js';
import {Alert,Badge,Button,Card,CardHead,Dialog,DialogActions,DialogClose,DialogContent,EmptyState,ErrorState,Field,Input,NativeCheck,NativeSelect,Skeleton,Table,TableWrap,Textarea,useToast,type Tone} from './ui';
import {MarketFields,AddVariantDialog,stateTone,variantPath} from './products-v7.js';
import {useBreadcrumbs} from './app-shell.js';

/** V7 variant page (RF-06.a, canvas «Variante»): exactly five sections in
 * this order, same on desktop and mobile. Saving keeps a draft; publishing
 * applies to new conversations only. No tests, results or authorization tabs. */
export const variantSectionTabs=[['sale','Venta'],['offer','Oferta y materiales'],['collection','Cobro'],['remarketing','Remarketing'],['numbers','Números']] as const;
export type VariantTab=typeof variantSectionTabs[number][0];
const message=errorText;
interface Material {id:string;version:number;name:string;kind:string;mime_type:string|null;size_bytes:number;status:string;status_label:string;host:string|null;deliverable:boolean;archived:boolean;used_by_variants:number}
interface SectionProps {variant:VariantView;fence:ProfileFence;manage:boolean;owner:boolean;materials:Material[];reloadMaterials:()=>Promise<void>;save:(path:string,value:unknown)=>Promise<boolean>;busy:boolean;publishable:boolean}
const sectionOfMissing=(code:string):VariantTab|'review'|null=>code==='sale_messages'||code==='seller'?'sale':code==='offer_price'||code==='materials'?'offer':code==='collection'?'collection':code.startsWith('review_')?'review':null;

/** RF-06.d: number → variants, optionally only the numbers selling one offer. */
function InverseView({rows}:{rows:{account_id:string;name:string;sells:{product:string;variant:string;offer_id:string|null}[]}[]}){
 const [offer,setOffer]=useState('');
 const offers=[...new Map(rows.flatMap(n=>n.sells).filter(s=>s.offer_id).map(s=>[s.offer_id as string,`${s.product} · ${s.variant}`])).entries()];
 const shown=offer?rows.map(n=>({...n,sells:n.sells.filter(s=>s.offer_id===offer)})).filter(n=>n.sells.length>0):rows;
 return <div className="stack">
  {offers.length>1&&<Field label="Oferta"><NativeSelect value={offer} onChange={e=>setOffer(e.target.value)}><option value="">Todas</option>{offers.map(([id,label])=><option key={id} value={id}>{label}</option>)}</NativeSelect></Field>}
  {shown.length?<ul className="status-list">{shown.map(n=><li key={n.account_id} data-state="neutral"><CircleDashed aria-hidden="true"/><span><strong>{n.name}</strong> <Sells items={n.sells.map(s=>`${s.product} · ${s.variant}`)} empty="sin variantes"/></span></li>)}</ul>:<p className="muted">Ningún número vende esa oferta.</p>}
 </div>;
}

export function VariantEditor({productId,variantId,section,selection,role,state}:{productId:string;variantId:string;section:VariantTab;selection:ProfileFence;role:ProfileRole;state:ProfileState}){
 const manage=role!=='viewer'&&state==='ACTIVE';
 const toast=useToast();
 const [variant,setVariant]=useState<VariantView|null>(),[error,setError]=useState(''),[materials,setMaterials]=useState<Material[]>([]),[busy,setBusy]=useState(false),[copy,setCopy]=useState(false),[tick,setTick]=useState(0);
 const load=useCallback(async(signal?:AbortSignal)=>{try{const v=await variantRequest<VariantView>(selection,'GET',`/v2/variants/${variantId}`,undefined,undefined,signal);if(v.product.id!==productId){setVariant(null);return;}setVariant(v);setError('');}catch(e){if(!signal?.aborted){if((e as {status?:number}).status===404)setVariant(null);else setError(message(e,'No se pudo consultar la variante.'));}}},[selection,variantId,productId]);
 const reloadMaterials=useCallback(async()=>{try{setMaterials(await variantRequest<Material[]>(selection,'GET','/v2/materials'));}catch{/* the section shows the list it already has */}},[selection]);
 useEffect(()=>{const c=new AbortController();void load(c.signal);void reloadMaterials();return()=>c.abort();},[load,reloadMaterials,tick]);
 useBreadcrumbs(variant?[{label:'Productos',href:'/products'},{label:variant.product.name,href:`/products/${productId}`},{label:variant.document.name}]:[{label:'Productos',href:'/products'}]);
 // While busy every control is disabled, so the browser drops focus to the
 // page. Once the action ends, focus returns to the control that started it
 // (or to the result message) instead of the top of the page.
 const keepFocus=()=>{const origin=document.activeElement as HTMLElement|null;return()=>requestAnimationFrame(()=>{if(document.activeElement&&document.activeElement!==document.body)return;
  if(origin&&origin!==document.body&&origin.isConnected&&!(origin as HTMLButtonElement).disabled)origin.focus({preventScroll:true});else document.getElementById('variant-feedback')?.focus({preventScroll:true});});};
 // Sequential saves (Venta → modelo → mercado) must each use the latest version.
 const latest=useRef<VariantView|null|undefined>(undefined);latest.current=variant;
 const save=useCallback(async(path:string,value:unknown)=>{const current=latest.current;if(!current)return false;const back=keepFocus();setBusy(true);setError('');
  try{const v=await variantRequest<VariantView>(selection,'PUT',`/v2/variants/${current.id}/${path}`,{expected_version:current.version,value},newOperationKey());latest.current=v;setVariant(v);toast({tone:'success',title:'Cambios guardados.',description:'Publica para usarlos en conversaciones nuevas.'});return true;}
  catch(e){setError(message(e,'No se pudo guardar.'));return false;}finally{setBusy(false);back();}},[selection,toast]);
 async function publish(){if(!variant)return;const back=keepFocus();setBusy(true);setError('');
  try{const r=await variantRequest<{variant:VariantView;numbers_following:number}>(selection,'POST',`/v2/variants/${variant.id}/publish`,{expected_version:variant.version,document_sha256:variant.document_sha256},newOperationKey());
   setVariant(r.variant);toast({tone:'success',title:r.numbers_following?`Publicado. Las conversaciones nuevas de ${r.numbers_following} ${r.numbers_following===1?'número':'números'} usarán estos cambios; las que están en curso conservan su configuración.`:'Publicado. Asigna un número para empezar a vender.',duration:9000,action:r.numbers_following?undefined:{label:'Ir a Números',onClick:()=>window.location.assign(variantPath(productId,variant.id,'numbers'))}});}
  catch(e){setError(message(e,'No se pudo publicar.'));}finally{setBusy(false);back();}}
 async function review(fields:string[]){if(!variant)return;const back=keepFocus();setBusy(true);try{setVariant(await variantRequest<VariantView>(selection,'POST',`/v2/variants/${variant.id}/review`,{expected_version:variant.version,reviewed:fields},newOperationKey()));}catch(e){setError(message(e,'No se pudo marcar como revisado.'));}finally{setBusy(false);back();}}
 async function lifecycle(action:'archive'|'restore'){if(!variant)return;const back=keepFocus();setBusy(true);setError('');try{setVariant(await variantRequest<VariantView>(selection,'POST',`/v2/variants/${variant.id}/${action}`,{expected_version:variant.version},newOperationKey()));toast({tone:'success',title:action==='archive'?'Variante archivada.':'Variante restaurada.'});}catch(e){setError(message(e,'No se pudo cambiar la variante.'));}finally{setBusy(false);back();}}
 if(variant===null)return <><a href="/products" className="back-link">Productos</a><Alert tone="error">No encontramos esa variante en este perfil.</Alert></>;
 if(!variant)return <>{error?<ErrorState message={error} onRetry={()=>setTick(t=>t+1)}/>:<Skeleton lines={4}/>}</>;
 const d=variant.document,blocking=variant.missing.filter(m=>m.code!=='publish'),canPublish=manage&&!variant.archived&&!blocking.length&&(variant.unpublished_changes||!variant.published);
 const reason=!manage?'Tu rol no permite publicar.':variant.archived?'La variante está archivada.':blocking.length?`Para publicar falta: ${blocking.map(m=>m.label).join(', ')}.`:variant.published&&!variant.unpublished_changes?'No hay cambios sin publicar.':'';
 const props:SectionProps={variant,fence:selection,manage:manage&&!variant.archived&&!busy,owner:role==='owner'&&state==='ACTIVE',materials,reloadMaterials,save,busy,publishable:canPublish};
 const missingBy=(key:VariantTab)=>blocking.filter(m=>sectionOfMissing(m.code)===key);
 const railState=(key:VariantTab):'ok'|'missing'|'neutral'=>key==='remarketing'?'neutral':key==='numbers'?(variant.numbers.length?'ok':'neutral'):missingBy(key).length?'missing':'ok';
 return <div className="variant-editor">
  <header className="page-header">
   <div>
    <a className="back-link" href={`/products/${productId}`}>{variant.product.name}</a>
    <h1 id="variant-title">{d.name} <Badge tone={stateTone(variant.state)}>{variant.state_label}</Badge></h1>
    <p>{languageLabel(d.locale.language)} · {d.locale.currency} · {d.locale.timezone}. Los cambios se aplican a conversaciones nuevas; las conversaciones en curso conservan su configuración.</p>
   </div>
   <div className="page-header-actions">
    {manage&&!variant.archived&&<><Button variant={canPublish?'default':'secondary'} disabled={!canPublish||busy} loading={busy&&canPublish} onClick={()=>void publish()} aria-describedby={reason?'publish-reason':undefined}>{variant.published?'Publicar cambios':'Publicar variante'}</Button>{reason&&<span id="publish-reason" className="muted text-sm">{reason}</span>}</>}
   </div>
  </header>
  <div id="variant-feedback" tabIndex={-1} className="variant-feedback">{error&&<Alert tone="error">{error}</Alert>}</div>
  {variant.unpublished_changes&&variant.published&&<Alert tone="warn">Tienes cambios guardados sin publicar.</Alert>}
  {d.pending_review.length>0&&manage&&<ReviewPanel fields={d.pending_review} busy={busy} onReview={fields=>void review(fields)}/>}
  <div className="layout-rail">
   <nav className="section-rail" aria-label="Secciones de la variante">
    {variantSectionTabs.map(([key,label])=>{const s=railState(key);const Icon=s==='ok'?CircleCheck:s==='missing'?CircleAlert:CircleDashed;return <a key={key} href={variantPath(productId,variant.id,key)} aria-current={key===section?'page':undefined} data-state={s}><Icon aria-hidden="true"/><span>{label}</span>{s==='missing'&&<span className="sr-only"> (falta algo)</span>}</a>;})}
   </nav>
   <div className="variant-section stack">
    {section==='sale'&&<SaleSection {...props}/>}
    {section==='offer'&&<OfferSection {...props}/>}
    {section==='collection'&&<CollectionSection {...props}/>}
    {section==='remarketing'&&<RemarketingSection {...props}/>}
    {section==='numbers'&&<NumbersSection {...props} onChanged={()=>void load()}/>}
    <details className="disclosure variant-advanced"><summary>Más opciones de la variante</summary>
     <div className="disclosure-body">
      {manage&&!variant.archived&&<Button variant="secondary" size="sm" onClick={()=>setCopy(true)}><Copy aria-hidden="true"/>Duplicar a otro país</Button>}
      {manage&&(variant.archived?<Button variant="secondary" size="sm" disabled={busy} onClick={()=>void lifecycle('restore')}>Restaurar variante</Button>:<Button variant="ghost" size="sm" disabled={busy||variant.numbers.length>0} onClick={()=>void lifecycle('archive')}><Archive aria-hidden="true"/>Archivar variante</Button>)}
      {variant.numbers.length>0&&<p className="muted text-sm">Para archivarla, primero quita los números que la venden.</p>}
      <History fence={selection} variantId={variant.id}/>
     </div>
    </details>
   </div>
   <aside className="variant-aside stack">
    <Card compact aria-labelledby="checklist-title">
     <CardHead level={3} id="checklist-title" title={blocking.length?'Para publicar falta…':variant.published?'Lista para vender':'Lista para publicar'}/>
     <ul className="status-list">
      {([['sale','Flujo y vendedor'],['offer','Oferta y materiales'],['collection','Cobro']] as const).map(([key,label])=>{const miss=missingBy(key);return <li key={key} data-state={miss.length?'missing':'ok'}>{miss.length?<CircleAlert aria-hidden="true"/>:<CircleCheck aria-hidden="true"/>}<span>{label}{miss.length?<span className="row-sub">{miss.map(m=>m.label).join(' · ')} · <a href={variantPath(productId,variant.id,key)}>Completar</a></span>:null}</span></li>;})}
      {blocking.filter(m=>sectionOfMissing(m.code)==='review').map(m=><li key={m.code} data-state="missing"><CircleAlert aria-hidden="true"/><span>{m.label}</span></li>)}
      <li data-state={variant.numbers.length?'ok':'neutral'}>{variant.numbers.length?<CircleCheck aria-hidden="true"/>:<CircleDashed aria-hidden="true"/>}<span>Números{variant.numbers.length?`: ${variant.numbers.map(n=>n.name).join(', ')}`:' · ninguno asignado'}</span></li>
     </ul>
    </Card>
    <FirstMessagePreview variant={variant}/>
    <Card compact flat aria-labelledby="meta-title">
     <CardHead level={3} id="meta-title" title="Datos de la variante"/>
     <dl className="facts">
      <div><dt>Mercado</dt><dd>{d.locale.market} · {d.locale.currency}</dd></div>
      <div><dt>Idioma</dt><dd>{languageLabel(d.locale.language)}</dd></div>
      <div><dt>Zona horaria</dt><dd>{d.locale.timezone}</dd></div>
      <div><dt>Publicada</dt><dd>{variant.published?`Revisión ${variant.published.revision}`:'Todavía no'}</dd></div>
      <div><dt>Actualizada</dt><dd>{new Date(variant.updated_at).toLocaleString('es-MX',{dateStyle:'medium',timeStyle:'short'})}</dd></div>
     </dl>
    </Card>
   </aside>
  </div>
  {copy&&<AddVariantDialog fence={selection} productId={productId} source={{id:variant.id,name:d.name,locale:d.locale}} open onClose={()=>setCopy(false)} onCreated={id=>window.location.assign(variantPath(productId,id))}/>}
 </div>;
}

function FirstMessagePreview({variant}:{variant:VariantView}){
 const d=variant.document,price=d.offer.price_minor>0?formatMoney(d.offer.price_minor,d.locale.currency,d.locale.language):'(precio)';
 const text=d.sale.base==='conversation'?d.sale.conversation?.offer_message??'':d.sale.base==='guided'?d.sale.guided?.presentation.offer_text??'':'';
 const rendered=text.replace(/\{\{\s*product_name\s*\}\}/g,variant.product.name).replace(/\{\{\s*price\s*\}\}/g,price).replace(/\{\{\s*currency\s*\}\}/g,d.locale.currency);
 return <Card compact aria-labelledby="preview-title">
  <CardHead level={3} id="preview-title" title="Primer mensaje" description="Así lo verá el cliente que llega por un anuncio."/>
  {rendered.trim()?<ol className="chat preview"><li className="bubble from-business"><span className="bubble-tag badge" data-tone="accent">{d.sale.seller.name||'Vendedor'}</span><span className="bubble-text">{rendered}</span></li></ol>:<p className="muted text-sm">{d.sale.base==='existing'?'Se conserva el flujo migrado; no hay vista previa.':'Escribe el mensaje de la oferta en Venta para ver la vista previa.'}</p>}
 </Card>;
}

const reviewLabels:Record<string,string>={language:'Idioma de los textos',price_currency:'Precio y moneda',collection:'Cobro',flow_seller:'Flujo y vendedor',remarketing:'Remarketing y horarios',materials:'Materiales'};
function ReviewPanel({fields,busy,onReview}:{fields:readonly string[];busy:boolean;onReview:(fields:string[])=>void}){
 const [checked,setChecked]=useState<string[]>([]);
 return <Alert tone="info" role="region" title="Esta variante es una copia. Revisa estos puntos antes de publicar:" actions={<Button variant="secondary" size="sm" disabled={busy||!checked.length} onClick={()=>{onReview(checked);setChecked([]);}}>Marcar como revisado</Button>}>
  <div className="stack-tight">{fields.map(f=><NativeCheck key={f} label={reviewLabels[f]??f} checked={checked.includes(f)} onChange={e=>setChecked(c=>e.target.checked?[...c,f]:c.filter(x=>x!==f))}/>)}</div>
 </Alert>;
}

function History({fence,variantId}:{fence:ProfileFence;variantId:string}){
 const [history,setHistory]=useState<HistoryView>(),[open,setOpen]=useState(false);
 useEffect(()=>{if(!open||history)return;const c=new AbortController();variantRequest<HistoryView>(fence,'GET',`/v2/variants/${variantId}/history`,undefined,undefined,c.signal).then(setHistory).catch(()=>undefined);return()=>c.abort();},[open,history,fence,variantId]);
 return <details className="disclosure quiet" onToggle={e=>setOpen((e.target as HTMLDetailsElement).open)}><summary><HistoryIcon aria-hidden="true" size={16}/>Historial</summary>
  <div className="disclosure-body">{!history?<Skeleton lines={2} label="Consultando historial…"/>:<ol className="history-list">{history.events.map(e=><li key={e.version}><time dateTime={e.at}>{new Date(e.at).toLocaleString('es-MX',{dateStyle:'medium',timeStyle:'short'})}</time><span>{e.label}{e.section?` (${({sale:'Venta',offer:'Oferta',collection:'Cobro',remarketing:'Remarketing',ai:'Modelo',locale:'Mercado'} as Record<string,string>)[e.section]??e.section})`:''}</span></li>)}</ol>}</div>
 </details>;
}

function MaterialSelect({materials,value,onChange,accept,label,help}:{materials:Material[];value:string;onChange:(id:string)=>void;accept?:string;label:string;help?:string}){
 const options=materials.filter(m=>m.status==='READY'&&!m.archived&&m.deliverable&&(!accept||(m.mime_type??'').startsWith(accept)));
 return <Field label={label} help={help}><NativeSelect value={value} onChange={e=>onChange(e.target.value)}><option value="">Elige un material…</option>{options.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}{value&&!options.some(m=>m.id===value)&&<option value={value}>Material actual</option>}</NativeSelect></Field>;
}
function SaveBar({label,busy,manage,children,secondary}:{label:string;busy:boolean;manage:boolean;children?:ReactNode;secondary?:boolean}){
 if(!manage&&!children)return null;
 return <div className="save-bar"><span className="muted text-sm">Los cambios se guardan como borrador; publica para usarlos.</span><div className="cluster">{children}{manage&&<Button type="submit" variant={secondary?'secondary':'default'} disabled={busy} loading={busy}>{label}</Button>}</div></div>;
}

// ------------------------------------------------------------------ Venta
function SaleSection({variant,fence,manage,owner,materials,save,busy,publishable}:SectionProps){
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
 const setG=(patch:(g:NonNullable<VariantDocument['sale']['guided']>)=>NonNullable<VariantDocument['sale']['guided']>)=>setSale(s=>({...s,guided:patch(s.guided??emptyGuided())}));
 const steps=sale.base==='conversation'?(conversation.deliver_before_payment?['Oferta','Acuerdo','Entrega','Cobro','Comprobante','Gracias']:['Oferta','Acuerdo','Cobro','Comprobante','Gracias','Entrega']):sale.base==='guided'?['Presentación','Imagen','Oferta','Acuerdo','Entrega previa','Cobro','Comprobante','Gracias','Entrega']:[];
 const vars=(names:string[])=><>{names.map(n=><span key={n} className="chip">{`{{${n}}}`}</span>)}</>;
 return <form onSubmit={submit} className="stack" aria-label="Venta">
  <Card aria-labelledby="flow-title">
   <CardHead id="flow-title" title="Flujo de venta" description="Lo que el número hace, paso a paso, con cada cliente."/>
   <Field label="Flujo base"><NativeSelect value={sale.base} disabled={!manage} onChange={e=>setSale(s=>({...s,base:e.target.value as typeof s.base,conversation:e.target.value==='conversation'?conversation:s.conversation}))}>
    <option value="conversation">Venta por conversación</option><option value="guided">Venta guiada con audios (10 pasos)</option>
    {(d.sale.existing_workflow_id||sale.base==='existing')&&<option value="existing">Flujo actual (migrado)</option>}
   </NativeSelect></Field>
   {steps.length?<ol className="flow-steps" aria-label="Pasos">{steps.map(s=><li key={s}><span className="pill">{s}</span></li>)}</ol>:<p className="muted">Se conserva el flujo que ya vendía este producto.</p>}
   {sale.base==='conversation'&&<>
    <Field label="Mensaje de la oferta" help={<>Puedes usar {vars(['product_name','price','currency'])}.</>}><Textarea rows={3} maxLength={4000} value={conversation.offer_message} disabled={!manage} onChange={e=>setConv({offer_message:e.target.value})}/></Field>
    <Field label="Cómo pides el acuerdo"><Textarea rows={2} maxLength={4000} value={conversation.agreement_message} disabled={!manage} onChange={e=>setConv({agreement_message:e.target.value})}/></Field>
    <NativeCheck label="Entregar el material al aceptar el acuerdo, antes del pago" checked={conversation.deliver_before_payment} disabled={!manage} onChange={e=>setConv({deliver_before_payment:e.target.checked})}/>
    <Field label="Mensaje de cobro" help={<>Los datos de pago se agregan en {vars(['bank_instructions'])} desde la sección Cobro.</>}><Textarea rows={3} maxLength={4000} value={conversation.payment_message} disabled={!manage} onChange={e=>setConv({payment_message:e.target.value})}/></Field>
    <Field label="Agradecimiento al aprobar el pago"><Textarea rows={2} maxLength={4000} value={conversation.thanks_message} disabled={!manage} onChange={e=>setConv({thanks_message:e.target.value})}/></Field>
   </>}
   {sale.base==='guided'&&<div className="form-grid">
    <MaterialSelect label="Audio de presentación" accept="audio/" materials={materials} value={guided?.presentation.audio_asset_id??''} onChange={id=>setG(g=>({...g,presentation:{...g.presentation,audio_asset_id:id}}))}/>
    <MaterialSelect label="Imagen del paquete" accept="image/" materials={materials} value={guided?.presentation.pack_image_asset_id??''} onChange={id=>setG(g=>({...g,presentation:{...g.presentation,pack_image_asset_id:id}}))}/>
    <Field label="Texto de la oferta" className="span-all"><Textarea rows={3} value={guided?.presentation.offer_text??''} onChange={e=>setG(g=>({...g,presentation:{...g.presentation,offer_text:e.target.value}}))}/></Field>
    <MaterialSelect label="Audio del acuerdo" accept="audio/" materials={materials} value={guided?.agreement.audio_asset_id??''} onChange={id=>setG(g=>({...g,agreement:{...g.agreement,audio_asset_id:id}}))}/>
    <Field label="Cómo pides el acuerdo"><Textarea rows={2} value={guided?.agreement.prompt??''} onChange={e=>setG(g=>({...g,agreement:{...g.agreement,prompt:e.target.value}}))}/></Field>
    <MaterialSelect label="Audio de cobro" accept="audio/" materials={materials} value={guided?.collection.audio_asset_id??''} onChange={id=>setG(g=>({...g,collection:{...g.collection,audio_asset_id:id}}))}/>
    <Field label="Instrucciones de pago"><Textarea rows={3} value={guided?.collection.payment_instructions??''} onChange={e=>setG(g=>({...g,collection:{...g.collection,payment_instructions:e.target.value}}))}/></Field>
    <Field label="Agradecimiento al aprobar el pago" className="span-all"><Textarea rows={2} value={guided?.closure.receipt_thanks??''} onChange={e=>setG(g=>({...g,closure:{receipt_thanks:e.target.value}}))}/></Field>
   </div>}
   <Field label="Cómo lo piden tus clientes" optional help="Nombres o frases separados por comas; ayudan a elegir el producto cuando un número vende varios."><Input value={aliases} maxLength={2000} disabled={!manage} onChange={e=>setAliases(e.target.value)}/></Field>
  </Card>
  <Card aria-labelledby="seller-title">
   <CardHead id="seller-title" title="Vendedor" description={`Responde en ${languageLabel(d.locale.language)}, el idioma de esta variante.`}/>
   <Field label="Nombre del vendedor"><Input required maxLength={160} value={sale.seller.name} disabled={!manage} onChange={e=>setSale(s=>({...s,seller:{...s.seller,name:e.target.value}}))}/></Field>
   <Field label="Cómo debe atender"><Textarea rows={4} maxLength={8000} value={sale.seller.instructions} disabled={!manage} onChange={e=>setSale(s=>({...s,seller:{...s.seller,instructions:e.target.value}}))}/></Field>
   <Field label="Conocimiento del producto" help="Preguntas frecuentes y datos que puede usar al responder."><Textarea rows={5} maxLength={20000} value={sale.seller.knowledge} disabled={!manage} onChange={e=>setSale(s=>({...s,seller:{...s.seller,knowledge:e.target.value}}))}/></Field>
   <Field label="Límites"><Textarea rows={2} maxLength={4000} value={sale.seller.limits} disabled={!manage} onChange={e=>setSale(s=>({...s,seller:{...s.seller,limits:e.target.value}}))}/></Field>
   <details className="disclosure"><summary>Modelo para esta variante</summary>
    <div className="disclosure-body">
     <p className="muted text-sm">Si no eliges uno, se usa el modelo predeterminado del perfil. El alterno sólo se usa para tareas que el principal no puede hacer.</p>
     <div className="form-grid">
      <Field label="Modelo principal"><NativeSelect value={ai.primary?`${ai.primary.provider}/${ai.primary.model}`:''} disabled={!manage} onChange={e=>setAi(a=>({...a,primary:pick(e.target.value)}))}><option value="">Predeterminado del perfil</option>{chatModels.map(m=><option key={m.provider+m.model} value={`${m.provider}/${m.model}`}>{m.provider} · {m.model}</option>)}</NativeSelect></Field>
      <Field label="Modelo alterno" optional><NativeSelect value={ai.fallback?`${ai.fallback.provider}/${ai.fallback.model}`:''} disabled={!manage} onChange={e=>setAi(a=>({...a,fallback:pick(e.target.value)}))}><option value="">Sin alterno</option>{models.map(m=><option key={'f'+m.provider+m.model} value={`${m.provider}/${m.model}`}>{m.provider} · {m.model} ({m.capabilities.join(', ')})</option>)}</NativeSelect></Field>
     </div>
     <AiStatusPanel fence={fence} variantId={variant.id} version={variant.version} owner={owner}/>
    </div>
   </details>
   <details className="disclosure"><summary>Mercado de la variante</summary>
    <div className="disclosure-body">
     <Field label="Nombre de la variante"><Input maxLength={160} value={market.name} disabled={!manage} onChange={e=>setMarket(m=>({...m,name:e.target.value}))}/></Field>
     <MarketFields value={market.locale} lockCurrency={!!variant.published} onChange={locale=>setMarket(m=>({...m,locale}))}/>
    </div>
   </details>
  </Card>
  <SaveBar label="Guardar venta" busy={busy} manage={manage} secondary={publishable}/>
 </form>;
}
const emptyGuided=():NonNullable<VariantDocument['sale']['guided']>=>({presentation:{audio_asset_id:'',pack_image_asset_id:'',offer_text:''},agreement:{audio_asset_id:'',prompt:''},collection:{audio_asset_id:'',payment_instructions:''},closure:{receipt_thanks:''}});

// ------------------------------------------------------------------ Oferta y materiales
function OfferSection({variant,fence,manage,materials,reloadMaterials,save,busy,publishable}:SectionProps){
 const d=variant.document,currency=d.locale.currency,[offer,setOffer]=useState(d.offer),[price,setPrice]=useState(d.offer.price_minor?fromMinor(d.offer.price_minor,currency):''),[error,setError]=useState('');
 useEffect(()=>{setOffer(d.offer);setPrice(d.offer.price_minor?fromMinor(d.offer.price_minor,currency):'');},[variant.version]);
 const minor=toMinor(price,currency);
 async function submit(e:FormEvent){e.preventDefault();setError('');if(minor===null){setError('Escribe un precio válido.');return;}await save('offer',{...offer,price_minor:minor});}
 const byId=useMemo(()=>new Map(materials.map(m=>[m.id,m])),[materials]);
 const releaseLabels={commitment_accepted:'Al aceptar el acuerdo',receipt_approved:'Al aprobar el pago',reconciled:'Al conciliar el pago'} as const;
 return <div className="stack">
  <form onSubmit={submit} className="stack" aria-label="Oferta">
   <Card aria-labelledby="offer-title">
    <CardHead id="offer-title" title="Oferta" description="Nombre, precio y lo que recibe el cliente."/>
    <div className="form-grid">
     <Field label="Nombre de la oferta"><Input required maxLength={160} value={offer.name} disabled={!manage} onChange={e=>setOffer(o=>({...o,name:e.target.value}))}/></Field>
     <Field label={`Precio (${currency})`} error={error||undefined} help={!error&&minor!==null&&minor>0?`Se mostrará como ${formatMoney(minor,currency,d.locale.language)}`:undefined}><Input inputMode="decimal" required value={price} disabled={!manage} onChange={e=>setPrice(e.target.value)}/></Field>
    </div>
    <h3>Qué recibe el cliente y cuándo</h3>
    {!offer.fulfillment.length&&<Alert tone="warn">Agrega al menos un material entregable.</Alert>}
    {offer.fulfillment.length>0&&<ul className="item-list">{offer.fulfillment.map((f,i)=><li key={f.asset_id+f.release_on+i}>
     <span className="item-name"><Paperclip aria-hidden="true"/>{byId.get(f.asset_id)?.name??'Material'}</span>
     <NativeSelect aria-label="Cuándo se entrega" value={f.release_on} disabled={!manage} onChange={e=>setOffer(o=>({...o,fulfillment:o.fulfillment.map((x,j)=>j===i?{...x,release_on:e.target.value as typeof x.release_on}:x)}))}>
      {(Object.keys(releaseLabels) as (keyof typeof releaseLabels)[]).map(k=><option key={k} value={k}>{releaseLabels[k]}</option>)}
     </NativeSelect>
     {manage&&<Button type="button" size="sm" variant="ghost" onClick={()=>setOffer(o=>({...o,fulfillment:o.fulfillment.filter((_,j)=>j!==i)}))}>Quitar</Button>}
    </li>)}</ul>}
    {manage&&<MaterialSelect label="Agregar material entregable" materials={materials.filter(m=>!offer.fulfillment.some(f=>f.asset_id===m.id))} value="" onChange={id=>{if(id)setOffer(o=>({...o,fulfillment:[...o.fulfillment,{asset_id:id,release_on:'receipt_approved'}]}));}}/>}
    <details className="disclosure"><summary>Tiers y cobro diferido</summary>
     <div className="disclosure-body">
      {offer.tiers.length>0&&<ul className="item-list">{offer.tiers.map((t,i)=><li key={t.id}>
       <Input aria-label="Nombre del tier" value={t.name} disabled={!manage} onChange={e=>setOffer(o=>({...o,tiers:o.tiers.map((x,j)=>j===i?{...x,name:e.target.value}:x)}))}/>
       <Input aria-label="Total mínimo" inputMode="decimal" value={fromMinor(t.minimum_total_minor,currency)} disabled={!manage} onChange={e=>{const v=toMinor(e.target.value,currency);if(v!==null)setOffer(o=>({...o,tiers:o.tiers.map((x,j)=>j===i?{...x,minimum_total_minor:v}:x)}));}}/>
       {manage&&<Button type="button" size="sm" variant="ghost" onClick={()=>setOffer(o=>({...o,tiers:o.tiers.filter((_,j)=>j!==i)}))}>Quitar</Button>}</li>)}</ul>}
      {manage&&offer.tiers.length<20&&<Button type="button" size="sm" variant="secondary" onClick={()=>setOffer(o=>({...o,tiers:[...o.tiers,{id:'tier-'+(o.tiers.length+1),name:'Nuevo tier',minimum_total_minor:0}]}))}>Agregar tier</Button>}
      {offer.legacy.madrina&&<p className="muted text-sm">Esta oferta conserva la opción Madrina configurada anteriormente.</p>}
      <Field label="Espera antes de cobrar (minutos)"><Input type="number" min={0} max={10080} value={Math.round(offer.billing_delay_seconds/60)} disabled={!manage} onChange={e=>setOffer(o=>({...o,billing_delay_seconds:Math.max(0,Math.min(604800,Number(e.target.value)*60))}))}/></Field>
     </div>
    </details>
   </Card>
   <SaveBar label="Guardar oferta" busy={busy} manage={manage} secondary={publishable}/>
  </form>
  <MaterialsPanel fence={fence} manage={manage} materials={materials} reload={reloadMaterials}/>
 </div>;
}

function MaterialsPanel({fence,manage,materials,reload}:{fence:ProfileFence;manage:boolean;materials:Material[];reload:()=>Promise<void>}){
 const [mode,setMode]=useState<'file'|'link'>('file'),[name,setName]=useState(''),[url,setUrl]=useState(''),[file,setFile]=useState<File|null>(null),[progress,setProgress]=useState(''),[error,setError]=useState('');
 const toast=useToast();
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
   setName('');setUrl('');setFile(null);setProgress('');await reload();toast({tone:'success',title:'Material agregado.'});
  }catch(err){setProgress('');setError(message(err,'No se pudo subir el material.'));}
 }
 const live=materials.filter(m=>!m.archived);
 return <Card aria-labelledby="materials-title">
  <CardHead id="materials-title" title="Materiales" description="Archivos y enlaces del perfil que puedes entregar en cualquier variante."/>
  {live.length===0?<p className="muted">Todavía no hay materiales.</p>:<ul className="item-list">{live.map(m=><li key={m.id}><span className="item-name">{m.kind==='link'?<Link2 aria-hidden="true"/>:<Paperclip aria-hidden="true"/>}{m.name}</span><span className="muted text-sm">{m.kind==='link'?m.host:`${m.mime_type??''} · ${(m.size_bytes/1024/1024).toFixed(1)} MB`}</span><Badge tone={m.status==='READY'?'success':'warn'}>{m.status_label}</Badge>
   {m.kind==='file'&&m.status==='READY'&&<a href={`/v2/materials/${m.id}/content?environment=REAL`} target="_blank" rel="noreferrer">Ver<span className="sr-only"> {m.name}</span></a>}</li>)}</ul>}
  {manage&&<form onSubmit={upload} className="form" aria-label="Agregar material">
   <div role="radiogroup" aria-label="Tipo de material" className="cluster"><NativeCheck type="radio" name="material-kind" label="Archivo" checked={mode==='file'} onChange={()=>setMode('file')}/><NativeCheck type="radio" name="material-kind" label="Enlace" checked={mode==='link'} onChange={()=>setMode('link')}/></div>
   <div className="form-grid">
    <Field label="Nombre"><Input maxLength={160} value={name} onChange={e=>setName(e.target.value)} required={mode==='link'}/></Field>
    {mode==='file'?<Field label="Archivo" help="PDF, imagen, audio o video de hasta 20 MB. Se guarda cifrado."><Input type="file" accept="application/pdf,image/png,image/jpeg,audio/mpeg,audio/ogg,video/mp4,text/plain" onChange={e=>setFile(e.target.files?.[0]??null)}/></Field>
     :<Field label="Enlace (https://)"><Input type="url" required maxLength={2000} value={url} onChange={e=>setUrl(e.target.value)}/></Field>}
   </div>
   {progress&&<Alert tone="info">{progress}</Alert>}{error&&<Alert tone="error">{error}</Alert>}
   <div className="form-actions"><Button type="submit" variant="secondary" disabled={!!progress||(mode==='file'&&!file)}><Upload aria-hidden="true"/>Agregar material</Button></div>
  </form>}
 </Card>;
}

// ------------------------------------------------------------------ Cobro
function CollectionSection({variant,manage,save,busy,publishable}:SectionProps){
 const c=variant.document.collection,currency=variant.document.locale.currency;
 const [spei,setSpei]=useState<'keep'|'new'|'none'>(c.spei?'keep':'none'),[bank,setBank]=useState(''),[holder,setHolder]=useState(''),[clabe,setClabe]=useState('');
 const [links,setLinks]=useState(c.links.map(l=>({id:l.id,label:l.label,provider:l.provider,host:l.host,url:'keep'})));
 const [instructions,setInstructions]=useState(c.instructions),[error,setError]=useState('');
 const [reference,setReference]=useState(c.expected_reference??''),[concept,setConcept]=useState(c.expected_concept??'');
 useEffect(()=>{setSpei(c.spei?'keep':'none');setLinks(c.links.map(l=>({id:l.id,label:l.label,provider:l.provider,host:l.host,url:'keep'})));setInstructions(c.instructions);setReference(c.expected_reference??'');setConcept(c.expected_concept??'');setBank('');setHolder('');setClabe('');},[variant.version]);
 async function submit(e:FormEvent){e.preventDefault();setError('');
  if(spei==='none'&&!links.length){setError('Configura SPEI, un enlace de pago o ambos.');return;}
  const ok=await save('collection',{spei:spei==='keep'?'keep':spei==='new'?{bank:bank.trim(),holder:holder.trim(),clabe}:null,
   links:links.map(l=>({...(l.id?{id:l.id}:{}),label:l.label.trim(),provider:l.provider,url:l.url})),instructions,
   expected_reference:reference.trim()||null,expected_concept:concept.trim()||null});
  if(ok){setBank('');setHolder('');setClabe('');}
 }
 return <form onSubmit={submit} className="stack" aria-label="Cobro">
  <Card aria-labelledby="collection-title">
   <CardHead id="collection-title" title="Cobro" description="El cliente recibe estos datos en el paso de cobro de su conversación. Se guardan cifrados; aquí sólo verás los últimos dígitos."/>
   {c.legacy_profile_id&&<Alert tone="info">Se usa el cobro configurado antes de V7. Si lo reemplazas aquí, las conversaciones nuevas usarán los datos nuevos al publicar.</Alert>}
   {error&&<Alert tone="error">{error}</Alert>}
   <fieldset className="plain"><legend>SPEI</legend>
    {currency!=='MXN'?<p className="muted">SPEI sólo aplica a variantes en pesos mexicanos.</p>:<>
     {c.spei&&spei==='keep'&&<p><Badge tone="success">Guardado</Badge> {c.spei.bank} · CLABE terminación {c.spei.last4}</p>}
     {manage&&<div className="cluster">{c.spei&&spei==='keep'?<><Button type="button" variant="secondary" onClick={()=>setSpei('new')}>Reemplazar</Button><Button type="button" variant="ghost" onClick={()=>setSpei('none')}>Quitar SPEI</Button></>:spei==='none'?<Button type="button" variant="secondary" onClick={()=>setSpei('new')}>Agregar SPEI</Button>:null}</div>}
     {spei==='new'&&<div className="form-grid">
      <Field label="Banco"><Input required maxLength={160} value={bank} onChange={e=>setBank(e.target.value)}/></Field>
      <Field label="Beneficiario"><Input required maxLength={160} value={holder} onChange={e=>setHolder(e.target.value)} autoComplete="off"/></Field>
      <Field label="CLABE (18 dígitos)"><Input required inputMode="numeric" autoComplete="off" maxLength={22} value={clabe} onChange={e=>setClabe(e.target.value.replace(/[^0-9 ]/g,''))}/></Field>
      {c.spei&&<div className="field"><span className="field-label">&nbsp;</span><Button type="button" variant="ghost" onClick={()=>setSpei('keep')}>Conservar la guardada</Button></div>}
     </div>}
    </>}
   </fieldset>
   <hr className="divider"/>
   <fieldset className="plain"><legend>Enlace de pago</legend>
    {links.map((l,i)=><div key={l.id??'new'+i} className="link-card">
     <div className="form-grid">
      <Field label="Proveedor"><NativeSelect value={l.provider} disabled={!manage} onChange={e=>setLinks(x=>x.map((y,j)=>j===i?{...y,provider:e.target.value as typeof y.provider}:y))}>{paymentLinkProviders.map(p=><option key={p} value={p}>{paymentLinkProviderLabels[p]}</option>)}</NativeSelect></Field>
      <Field label="Etiqueta para el cliente"><Input required maxLength={160} value={l.label} disabled={!manage} onChange={e=>setLinks(x=>x.map((y,j)=>j===i?{...y,label:e.target.value}:y))}/></Field>
      {l.url==='keep'?<div className="field"><span className="field-label">Enlace</span><p className="muted"><Badge tone="success">Guardado</Badge> en {l.host} {manage&&<Button type="button" size="sm" variant="ghost" onClick={()=>setLinks(x=>x.map((y,j)=>j===i?{...y,url:''}:y))}>Reemplazar enlace</Button>}</p></div>
       :<Field label="Enlace (https://)"><Input type="url" required maxLength={2000} value={l.url} onChange={e=>setLinks(x=>x.map((y,j)=>j===i?{...y,url:e.target.value}:y))}/></Field>}
     </div>
     {manage&&<Button type="button" size="sm" variant="ghost" onClick={()=>setLinks(x=>x.filter((_,j)=>j!==i))}>Quitar enlace</Button>}
    </div>)}
    {manage&&links.length<5&&<div><Button type="button" variant="secondary" onClick={()=>setLinks(x=>[...x,{id:undefined as unknown as string,label:'Pagar en línea',provider:'other',host:'',url:''}])}>Agregar enlace</Button></div>}
   </fieldset>
   <hr className="divider"/>
   <Field label="Indicaciones para el cliente" optional><Textarea rows={2} maxLength={2000} value={instructions} disabled={!manage} onChange={e=>setInstructions(e.target.value)}/></Field>
   <div className="form-grid">
    <Field label="Referencia que debe escribir el cliente" optional help="Las reglas de comprobantes «exacta» o «contiene» la comparan con la del comprobante. Sin ella, ese comprobante pasa a revisión."><Input maxLength={120} value={reference} disabled={!manage} onChange={e=>setReference(e.target.value)}/></Field>
    <Field label="Concepto que debe escribir el cliente" optional><Input maxLength={120} value={concept} disabled={!manage} onChange={e=>setConcept(e.target.value)}/></Field>
   </div>
  </Card>
  <SaveBar label="Guardar cobro" busy={busy} manage={manage} secondary={publishable}/>
 </form>;
}

// ------------------------------------------------------------------ Remarketing
function RemarketingSection({variant,fence,manage,materials,save,busy,publishable}:SectionProps){
 const r=variant.document.remarketing,[policy,setPolicy]=useState(r);
 useEffect(()=>setPolicy(r),[variant.version]);
 const base=()=>({schema_version:1 as const,policy_id:'remarketing-3-slot' as const,policy_revision:1,window:{start_hour:9,end_hour:21},
  slots:[1,2,3].map((position,i)=>({id:'slot-'+position,position:position as 1|2|3,enabled:position===1,delay:{quantity:[2,8,24][i]!,unit:'hours' as const},
   stages:{awaiting_agreement:{medium:'text' as const,text:''},awaiting_payment:{medium:'text' as const,text:''}}}))});
 const stageLabels={awaiting_agreement:'Si aún no acepta el acuerdo',awaiting_payment:'Si aún no paga'} as const;
 type Policy=NonNullable<typeof policy>;type Slot=Policy['slots'][number];type Medium=Slot['stages']['awaiting_agreement']['medium'];
 const update=(i:number,patch:(s:Slot)=>Slot)=>setPolicy(p=>p&&{...p,slots:p.slots.map((s,j)=>j===i?patch(s):s) as typeof p.slots});
 const stage=(i:number,key:'awaiting_agreement'|'awaiting_payment',patch:Partial<Slot['stages']['awaiting_agreement']>)=>update(i,s=>({...s,stages:{...s.stages,[key]:{...s.stages[key],...patch}}}));
 const hours=Array.from({length:25},(_,h)=>h),label=(h:number)=>`${String(h).padStart(2,'0')}:00`;
 const active=policy?policy.slots.filter(s=>s.enabled).length:0;
 return <form onSubmit={e=>{e.preventDefault();void save('remarketing',policy);}} className="stack" aria-label="Remarketing">
  <Card aria-labelledby="remarketing-title">
   <CardHead id="remarketing-title" title="Seguimientos" description="A personas que aún no compraron. Se detienen si compra, responde, pide la baja, se alcanza el máximo o pausas la venta."/>
   {!policy?<EmptyState inline level={3} title="Sin seguimientos configurados" description="Hasta tres recordatorios con espera, formato y mensaje propios." action={manage?<Button type="button" variant="secondary" onClick={()=>setPolicy(base())}>Configurar seguimientos</Button>:undefined}/>:<>
    <fieldset className="plain"><legend>Horario permitido</legend>
     <div className="form-grid">
      <Field label="Desde"><NativeSelect value={policy.window?.start_hour??''} disabled={!manage} onChange={e=>setPolicy(p=>p&&{...p,window:e.target.value===''?undefined:{start_hour:Number(e.target.value),end_hour:Math.max(Number(e.target.value)+1,p.window?.end_hour??21)}})}>
       <option value="">Cualquier hora</option>{hours.slice(0,24).map(h=><option key={h} value={h}>{label(h)}</option>)}</NativeSelect></Field>
      {policy.window&&<Field label="Hasta"><NativeSelect value={policy.window.end_hour} disabled={!manage} onChange={e=>setPolicy(p=>p&&p.window?{...p,window:{...p.window,end_hour:Number(e.target.value)}}:p)}>
       {hours.slice(policy.window.start_hour+1).map(h=><option key={h} value={h}>{label(h)}</option>)}</NativeSelect></Field>}
     </div>
     <p className="muted text-sm">Hora de {variant.document.locale.market} ({variant.document.locale.timezone}). Un seguimiento que cae fuera de este horario espera al siguiente momento permitido.</p>
    </fieldset>
    <p className="muted text-sm">Máximo por persona: {active} seguimiento{active===1?'':'s'} en total, entre ambas etapas.</p>
    {policy.slots.map((slot,i)=><fieldset key={slot.id} className="plain slot-card"><legend>Seguimiento {slot.position}</legend>
     <NativeCheck label="Activo" checked={slot.enabled} disabled={!manage} onChange={e=>update(i,s=>({...s,enabled:e.target.checked}))}/>
     {slot.position>1&&slot.enabled&&<NativeCheck label="Entiendo que más seguimientos aumentan el riesgo de bloqueo y bajas." checked={slot.warning_acknowledged===true} disabled={!manage} onChange={e=>update(i,s=>({...s,warning_acknowledged:e.target.checked}))}/>}
     {!slot.enabled&&<p className="muted text-sm">Inactivo · se enviaría {slot.delay.quantity} {({minutes:'minutos',hours:'horas',days:'días'} as const)[slot.delay.unit]} después del último mensaje.</p>}
     {slot.enabled&&<><div className="form-grid"><Field label="Espera"><Input type="number" min={1} value={slot.delay.quantity} disabled={!manage} onChange={e=>update(i,s=>({...s,delay:{...s.delay,quantity:Math.max(1,Number(e.target.value))}}))}/></Field>
      <Field label="Unidad"><NativeSelect value={slot.delay.unit} disabled={!manage} onChange={e=>update(i,s=>({...s,delay:{...s.delay,unit:e.target.value as typeof s.delay.unit}}))}><option value="minutes">minutos</option><option value="hours">horas</option><option value="days">días</option></NativeSelect></Field></div>
     {(['awaiting_agreement','awaiting_payment'] as const).map(key=><div key={key} className="stack-tight"><h3>{stageLabels[key]}</h3>
      <div className="form-grid">
       <Field label="Formato"><NativeSelect value={slot.stages[key].medium} disabled={!manage} onChange={e=>{const medium=e.target.value as Medium;stage(i,key,{medium,...(medium==='text'?{asset_id:undefined}:{})});}}>
        <option value="text">Sólo texto</option><option value="audio">Audio y texto</option><option value="video">Video y texto</option></NativeSelect></Field>
       {slot.stages[key].medium!=='text'&&<MaterialSelect label={slot.stages[key].medium==='video'?'Video':'Audio'} materials={materials.filter(m=>(m.mime_type??'').startsWith(slot.stages[key].medium+'/'))} value={slot.stages[key].asset_id??''} onChange={id=>stage(i,key,{asset_id:id||undefined})}/>}
      </div>
      <Field label="Mensaje"><Textarea rows={2} maxLength={12000} value={slot.stages[key].text} disabled={!manage} onChange={e=>stage(i,key,{text:e.target.value})}/></Field>
     </div>)}</>}
    </fieldset>)}
    {manage&&<div><Button type="button" variant="ghost" onClick={()=>setPolicy(null)}>Quitar seguimientos</Button></div>}
   </>}
  </Card>
  {(policy||r)&&<SaveBar label={policy?'Guardar remarketing':'Guardar sin seguimientos'} busy={busy} manage={manage} secondary={publishable}/>}
  {r&&<RemarketingResults variant={variant} fence={fence}/>}
  {r&&<RemarketingCycles variant={variant} fence={fence} manage={manage}/>}
 </form>;
}
/** RF-10.c: open follow-up cycles, the same list and reprogramming the MCP has.
 * Reprogramming moves only unstarted future reminders to the timing of the
 * published policy; content and used reminders never change. */
interface CycleView {id:string;revision:number;status:string;status_label:string;stage_label:string;opened_at:string|null;consumed_attempts:number;max_attempts:number;next_due_at:string|null;conversation_paused:boolean}
interface ReprogramPreview {cycle_revision:number;preview_hash:string;previewed_at:string;effective_maximum:number;slots:{id:string;position:number;due_at:string;disposition:string}[]}
const dispositionLabels:Record<string,string>={PRESERVE_CONSUMED:'ya enviado',DISABLED:'inactivo',SKIP_OVERDUE:'vencido, no se envía',QUOTA_BLOCKED:'sin cupo',SCHEDULE:'se programa'};
function RemarketingCycles({variant,fence,manage}:{variant:VariantView;fence:ProfileFence;manage:boolean}){
 const [cycles,setCycles]=useState<CycleView[]|null>(null),[error,setError]=useState(''),[preview,setPreview]=useState<{cycle:string;plan:ReprogramPreview}|null>(null),[busy,setBusy]=useState(false),[tick,setTick]=useState(0);
 useEffect(()=>{const c=new AbortController();
  variantRequest<{cycles:CycleView[]}>(fence,'GET',`/v2/variants/${variant.id}/remarketing/cycles?status=OPEN`,undefined,undefined,c.signal).then(v=>setCycles(v.cycles)).catch(e=>{if(!c.signal.aborted)setError(message(e,'No se pudieron consultar los seguimientos en curso.'));});
  return()=>c.abort();},[fence,variant.id,tick]);
 const ask=async(cycle:string)=>{setBusy(true);setError('');try{setPreview({cycle,plan:await variantRequest<ReprogramPreview>(fence,'POST',`/v2/variants/${variant.id}/remarketing/cycles/${cycle}/reprogram/preview`,{})});}catch(e){setError(message(e,'No se pudo preparar la vista previa.'));}finally{setBusy(false);}};
 const apply=async()=>{if(!preview)return;setBusy(true);setError('');
  try{await variantRequest(fence,'POST',`/v2/variants/${variant.id}/remarketing/cycles/${preview.cycle}/reprogram`,{expected_revision:preview.plan.cycle_revision,preview_hash:preview.plan.preview_hash,previewed_at:preview.plan.previewed_at});setPreview(null);setTick(t=>t+1);}
  catch(e){setError(message(e,'No se pudo reprogramar.'));}finally{setBusy(false);}};
 const when=(v:string|null)=>v?new Date(v).toLocaleString('es-MX',{dateStyle:'medium',timeStyle:'short'}):'—';
 return <Card aria-labelledby="cycles-title">
  <CardHead level={3} id="cycles-title" title="Seguimientos en curso" description="Cada seguimiento conserva la política con la que empezó; publicar otra aplica a los nuevos. Para detener uno, pausa o cierra su conversación."/>
  {error&&<Alert tone="error">{error}</Alert>}{!cycles&&!error&&<Skeleton lines={2}/>}
  {cycles&&(cycles.length===0?<p className="muted">Nadie está en seguimiento ahora con esta variante.</p>:<TableWrap><Table><thead><tr><th scope="col">Etapa</th><th scope="col">Desde</th><th scope="col">Usados</th><th scope="col">Próximo</th><th scope="col"><span className="sr-only">Acciones</span></th></tr></thead>
   <tbody>{cycles.map(c=><tr key={c.id}><td data-label="Etapa">{c.stage_label}{c.conversation_paused?' · conversación pausada':''}</td><td data-label="Desde">{when(c.opened_at)}</td><td data-label="Usados">{c.consumed_attempts} de {c.max_attempts}</td><td data-label="Próximo">{when(c.next_due_at)}</td>
    <td className="actions">{manage&&<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={()=>void ask(c.id)}>Usar horario publicado</Button>}</td></tr>)}</tbody></Table></TableWrap>)}
  <Dialog open={!!preview} onOpenChange={o=>{if(!o)setPreview(null);}}>
   {preview&&<DialogContent title="Vista previa de la reprogramación" description={`Con la política publicada, este seguimiento tendría hasta ${preview.plan.effective_maximum} recordatorio${preview.plan.effective_maximum===1?'':'s'}.`}>
    <ul className="status-list">{preview.plan.slots.map(s=><li key={s.id} data-state={s.disposition==='SCHEDULE'?'ok':'neutral'}>{s.disposition==='SCHEDULE'?<CircleCheck aria-hidden="true"/>:<CircleDashed aria-hidden="true"/>}<span>Seguimiento {s.position}: {dispositionLabels[s.disposition]??s.disposition}{s.disposition==='SCHEDULE'?` · ${when(s.due_at)}`:''}</span></li>)}</ul>
    <p className="muted text-sm">El contenido no cambia y los ya enviados cuentan. La vista previa vale 5 minutos.</p>
    <DialogActions><DialogClose asChild><Button type="button" variant="secondary">Cancelar</Button></DialogClose><Button type="button" disabled={busy} loading={busy} onClick={()=>void apply()}>Reprogramar</Button></DialogActions>
   </DialogContent>}
  </Dialog>
 </Card>;
}
/** RF-10.e: what the follow-ups of this variant did in the last 30 days. */
interface RemarketingResultsView {entered:number;reached:number;replied:number;recovered_sales:number;opted_out:number;messages:{sent:number;uncertain:number};recovered_revenue:{currency:string;revenue_minor:string;sales:number}[]}
function RemarketingResults({variant,fence}:{variant:VariantView;fence:ProfileFence}){
 const [data,setData]=useState<RemarketingResultsView|null>(null),[error,setError]=useState('');
 useEffect(()=>{const c=new AbortController(),to=new Date().toISOString().slice(0,10),from=new Date(Date.now()-29*86400000).toISOString().slice(0,10);
  variantRequest<RemarketingResultsView>(fence,'GET',`/v2/variants/${variant.id}/remarketing/results?from=${from}&to=${to}`,undefined,undefined,c.signal).then(setData).catch(e=>{if(!c.signal.aborted)setError(message(e,'No se pudieron consultar los resultados.'));});
  return()=>c.abort();},[fence,variant.id]);
 return <Card aria-labelledby="rm-results-title">
  <CardHead level={3} id="rm-results-title" title="Últimos 30 días" description="«Respondieron» y «compraron» cuentan sólo hasta 7 días después de recibir un seguimiento." actions={<a href={`/results?family_id=${variant.product.id}&variant_id=${variant.id}&touch=REMARKETING`}>Ver en Resultados</a>}/>
  {error&&<Alert tone="error">{error}</Alert>}{!data&&!error&&<Skeleton lines={2}/>}
  {data&&(data.entered===0&&data.reached===0?<p className="muted">Todavía nadie entró a seguimiento con esta variante.</p>:<dl className="facts">
   <div><dt>Entraron a seguimiento</dt><dd>{data.entered}</dd></div>
   <div><dt>Recibieron seguimiento</dt><dd>{data.reached} · {data.messages.sent} mensaje{data.messages.sent===1?'':'s'}{data.messages.uncertain?` · ${data.messages.uncertain} sin confirmar`:''}</dd></div>
   <div><dt>Respondieron</dt><dd>{data.replied}</dd></div>
   <div><dt>Compraron después</dt><dd>{data.recovered_sales}</dd></div>
   <div><dt>Pidieron la baja</dt><dd>{data.opted_out}</dd></div>
   <div><dt>Ingresos recuperados</dt><dd>{data.recovered_revenue.length?data.recovered_revenue.map(x=>formatMoney(Number(x.revenue_minor),x.currency)).join(' · '):formatMoney(0,variant.document.locale.currency)}</dd></div>
  </dl>)}
 </Card>;
}

// ------------------------------------------------------------------ Números
function NumbersSection({variant,fence,manage,onChanged}:SectionProps&{onChanged:()=>void}){
 const [rows,setRows]=useState<VariantNumber[]>(),[error,setError]=useState(''),[confirm,setConfirm]=useState<{row:VariantNumber;impact:NumberImpact}|null>(null),[busy,setBusy]=useState('');
 const [inverse,setInverse]=useState<{account_id:string;name:string;sells:{product:string;variant:string;offer_id:string|null}[]}[]>();
 const toast=useToast();
 const load=useCallback(async()=>{try{setRows(await variantRequest<VariantNumber[]>(fence,'GET',`/v2/variants/${variant.id}/numbers`));setError('');}catch(e){setError(message(e,'No se pudieron consultar los números.'));}},[fence,variant.id]);
 useEffect(()=>{void load();},[load]);
 async function sell(row:VariantNumber,value:boolean){setBusy(row.account_id);setError('');
  try{await variantRequest(fence,'POST',`/v2/variants/${variant.id}/numbers`,{account_id:row.account_id,sell:value},newOperationKey());setConfirm(null);await load();onChanged();toast({tone:'success',title:value?`${row.name} ya vende esta variante.`:`${row.name} dejó de vender esta variante.`});}
  catch(e){setError(message(e,'No se pudo cambiar el número.'));}finally{setBusy('');}}
 async function askRemove(row:VariantNumber){try{setConfirm({row,impact:await variantRequest<NumberImpact>(fence,'GET',`/v2/variants/${variant.id}/numbers/${row.account_id}/impact`)});}catch(e){setError(message(e,'No se pudo consultar el impacto.'));}}
 return <Card aria-label="Números">
  <CardHead title="Números que venden esta variante" description="Asignar es permanente: el número vende esta variante hasta que lo quites o lo pauses. Las pausas, bajas y protecciones siempre se respetan."/>
  {!variant.published&&<Alert tone="warn">Publica la variante para poder asignarla a un número.</Alert>}
  {error&&<Alert tone="error">{error}</Alert>}
  {!rows&&!error&&<Skeleton lines={3}/>}
  {rows&&!rows.length&&<EmptyState inline level={3} title="Aún no tienes números" description="Agrega uno en Números y vuelve aquí para asignarlo." action={<a className="btn" data-variant="secondary" href="/numbers">Ir a Números</a>}/>}
  {rows&&rows.length>0&&<TableWrap><Table><thead><tr><th scope="col">Número</th><th scope="col">Otras variantes que vende</th><th scope="col">Vender esta variante</th></tr></thead>
   <tbody>{rows.map(r=><tr key={r.account_id}><td data-label="Número"><span className="row-title">{r.name}</span>{r.masked&&<span className="row-sub">{r.masked}</span>}</td>
    <td data-label="Otras variantes"><Sells items={[...r.others.map(o=>`${o.product} · ${o.variant}`),...(r.same_product?[`${variant.product.name} · ${r.same_product.label}`]:[])]}/></td>
    <td data-label="Vender esta variante">{r.sells_this?<span className="cluster"><Badge tone="success">Sí</Badge>{manage&&<Button size="sm" variant="secondary" disabled={!!busy} onClick={()=>void askRemove(r)}>Dejar de vender</Button>}</span>
     :r.same_product?.variant_id?<span className="muted text-sm">Vende otra variante de este producto. Quítala primero.</span>
     :<span className="cluster"><Badge tone="neutral">No</Badge>{manage&&variant.published&&<Button size="sm" variant="secondary" disabled={!!busy} loading={busy===r.account_id} onClick={()=>void sell(r,true)}>{r.same_product?'Vender esta variante (reemplaza la configuración anterior)':'Vender en este número'}</Button>}</span>}</td></tr>)}</tbody></Table></TableWrap>}
  <details className="disclosure quiet" onToggle={e=>{if((e.target as HTMLDetailsElement).open&&!inverse)variantRequest<NonNullable<typeof inverse>>(fence,'GET','/v2/number-variants').then(setInverse).catch(()=>undefined);}}><summary>Vista inversa: número → variantes</summary>
   <div className="disclosure-body">{!inverse?<Skeleton lines={2}/>:<InverseView rows={inverse}/>}</div>
  </details>
  <Dialog open={!!confirm} onOpenChange={o=>{if(!o)setConfirm(null);}}>
   {confirm&&<DialogContent title={`Dejar de vender en ${confirm.row.name}`} description={confirm.impact.effect}>
    <dl className="facts"><div><dt>Conversaciones abiertas</dt><dd>{confirm.impact.open_conversations}</dd></div><div><dt>Seguimientos pendientes que se cancelan</dt><dd>{confirm.impact.pending_followups}</dd></div><div><dt>Mensajes aún no enviados que se cancelan</dt><dd>{confirm.impact.unsent_messages}</dd></div></dl>
    <DialogActions><DialogClose asChild><Button variant="secondary">Seguir vendiendo</Button></DialogClose><Button variant="destructive" disabled={!!busy} loading={!!busy} onClick={()=>void sell(confirm.row,false)}>Dejar de vender</Button></DialogActions>
   </DialogContent>}
  </Dialog>
 </Card>;
}

interface AiTaskStatus {task:string;label:string;state:'READY'|'NEEDS_OWNER'|'HUMAN_REQUIRED';state_label:string;provider:string|null;model:string|null;selection:string|null;grant_expires_at:string|null}
/** RF-14/RF-13.d: what the variant's AI uses per task and why it may not run. */
function AiStatusPanel({fence,variantId,version,owner}:{fence:ProfileFence;variantId:string;version:number;owner:boolean}){
 const [status,setStatus]=useState<AiTaskStatus[]>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const load=useCallback(async()=>{try{setStatus(await variantRequest<AiTaskStatus[]>(fence,'GET',`/v2/variants/${variantId}/ai-status`));}catch(e){setError(message(e,'No se pudo consultar la IA.'));}},[fence,variantId]);
 useEffect(()=>{void load();},[load,version]);
 async function confirm(){setBusy(true);setError('');try{const r=await variantRequest<{status:AiTaskStatus[]}>(fence,'POST',`/v2/variants/${variantId}/ai-authorization`,{},newOperationKey());setStatus(r.status);}catch(e){setError(message(e,'No se pudo confirmar la IA.'));}finally{setBusy(false);}}
 if(!status)return error?<Alert tone="error">{error}</Alert>:<Skeleton lines={2} label="Consultando la IA de la variante…"/>;
 const tone=(s:AiTaskStatus['state']):Tone=>s==='READY'?'success':'warn';
 return <div className="stack-tight"><h3>Estado de la IA (variante publicada)</h3>
  <ul className="item-list">{status.map(t=><li key={t.task}><span className="item-name">{t.label}</span><span className="muted text-sm">{t.provider?`${t.provider} · ${t.model}`:'—'}</span><Badge tone={tone(t.state)}>{t.state==='READY'?'Lista':t.state_label}</Badge></li>)}</ul>
  {owner&&status.some(t=>t.state==='NEEDS_OWNER')&&<div><Button type="button" variant="secondary" disabled={busy} loading={busy} onClick={()=>void confirm()}>Confirmar la IA de esta variante</Button></div>}
  {!owner&&status.some(t=>t.state==='NEEDS_OWNER')&&<p className="muted text-sm">La persona Dueña debe confirmar la IA de esta variante. Mientras tanto, las conversaciones pasan a atención de una persona.</p>}
  <p className="muted text-sm">Los costos de IA se cobran con la clave de tu negocio y se registran por variante y conversación con el precio vigente.</p>
  {error&&<Alert tone="error">{error}</Alert>}
 </div>;
}
/** Each product · variant pair is one item, so long lists stay readable. */
function Sells({items,empty='—'}:{items:string[];empty?:string}){return items.length?<ul className="pill-list">{items.map((item,i)=><li key={i} className="pill">{item}</li>)}</ul>:<span>{empty}</span>;}
