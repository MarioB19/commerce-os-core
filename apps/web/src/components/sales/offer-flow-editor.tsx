import {useCallback,useEffect,useId,useMemo,useRef,useState,type ReactNode} from 'react';
import {Link} from '@tanstack/react-router';
import type {RemarketingPolicy,RemarketingSlot,SalesFlowConfiguration,SalesFlowContent} from '../../../../../packages/contracts/src/sales-flow.js';
import {salesAgreementRecipeV1} from '../../../../../packages/domain/src/sales/sales-recipe-v2.js';
import {validateSalesFlowOfferDraft,type SalesFlowConfigurationIssue} from '../../../../../packages/domain/src/sales/sales-flow-configuration.js';
import {AssetPreview} from '../asset-preview';
import {Badge,Feedback,Notice,QueryState,useWorkspace} from '../shared';
import {Button} from '../ui/button';
import {params,useAction,useData,type Row} from '../../lib/api';

type Fulfillment={asset_id:string;release_on:'commitment_accepted'|'receipt_approved'|'reconciled';min_amount_minor?:number};
type OfferFlowDraft={
 name?:string;currency:string;base_amount_minor:number;
 payment_profile_version_id?:string;receipt_policy_version_id?:string;
 workflow_version_id?:string;agent_version_id?:string;
 fulfillment:Fulfillment[];positive_payment_unlocks_all:boolean;billing_delay_seconds:number;
 sales_flow:SalesFlowConfiguration;
};
type ConfigurationResponse={offer:Row;validation:{ready:boolean;maximum:number;issues:SalesFlowConfigurationIssue[]}};

const record=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
const optionalString=(value:unknown)=>typeof value==='string'&&value?value:undefined;
const slotCopy=[
 ['¿Quieres recibir ahora el contenido completo? Si aceptas el acuerdo, responde SÍ, LO QUIERO.','¿Pudiste abrir el material? Si necesitas ayuda, escríbeme; cuando pagues, envía el comprobante.'],
 ['Si todavía te interesa, puedo resolver tus dudas antes de aceptar el acuerdo.','Sigo disponible para ayudarte con el acceso o con el comprobante.'],
 ['Cierro este seguimiento para no insistir. Responde sólo si quieres continuar o necesitas ayuda.','Último recordatorio de este ciclo. Dime si necesitas ayuda o si prefieres cerrar el seguimiento.'],
] as const;

function emptyRemarketing():RemarketingPolicy{
 const delays=[{quantity:2,unit:'hours' as const},{quantity:8,unit:'hours' as const},{quantity:24,unit:'hours' as const}];
 return{schema_version:1,policy_id:'remarketing-3-slot',policy_revision:1,slots:delays.map((delay,index)=>({
  id:`remarketing_${index+1}`,position:(index+1) as 1|2|3,enabled:index===0,delay,
  stages:{
   awaiting_agreement:{medium:'audio' as const,text:slotCopy[index]![0]},
   awaiting_payment:{medium:'audio' as const,text:slotCopy[index]![1]},
  },
 })) as RemarketingPolicy['slots']};
}

function stepConfig(workflow:Row|undefined,step:number){
 const nodes=Array.isArray(workflow?.nodes)?workflow.nodes as Array<Record<string,any>>:[];
 return record(nodes.find(node=>record(node.config).recipe_step===step)?.config);
}

function initialDraft(offer:Row,product:Row,workflow:Row|undefined):OfferFlowDraft{
 const saved=record(offer.sales_flow) as Partial<SalesFlowConfiguration>;
 const priorContent=record(saved.content);
 const presentation=record(priorContent.presentation),agreement=record(priorContent.agreement),collection=record(priorContent.collection),closure=record(priorContent.closure);
 const content:SalesFlowContent={
  presentation:{audio_asset_id:String(presentation.audio_asset_id??stepConfig(workflow,1).asset_id??''),pack_image_asset_id:String(presentation.pack_image_asset_id??stepConfig(workflow,2).asset_id??''),offer_text:String(presentation.offer_text??stepConfig(workflow,3).text??'')},
  agreement:{audio_asset_id:String(agreement.audio_asset_id??stepConfig(workflow,4).asset_id??''),prompt:String(agreement.prompt??stepConfig(workflow,5).text??'')},
  collection:{audio_asset_id:String(collection.audio_asset_id??stepConfig(workflow,7).asset_id??''),payment_instructions:String(collection.payment_instructions??stepConfig(workflow,8).text??'')},
  closure:{receipt_thanks:String(closure.receipt_thanks??stepConfig(workflow,9).text??'')},
 };
 return{
  name:optionalString(offer.name),currency:String(offer.currency??'MXN'),base_amount_minor:Number(offer.base_amount_minor??0),
  payment_profile_version_id:optionalString(offer.payment_profile_version_id),receipt_policy_version_id:optionalString(offer.receipt_policy_version_id),
  workflow_version_id:optionalString(offer.workflow_version_id),agent_version_id:optionalString(offer.agent_version_id),
  fulfillment:Array.isArray(offer.fulfillment)?structuredClone(offer.fulfillment) as Fulfillment[]:[],
  positive_payment_unlocks_all:offer.positive_payment_unlocks_all===true,billing_delay_seconds:Number(offer.billing_delay_seconds??0),
  sales_flow:{entry_aliases:Array.isArray(saved.entry_aliases)&&saved.entry_aliases.length?[...saved.entry_aliases]:[String(product.name??'Producto')],recipe:saved.recipe??salesAgreementRecipeV1(),remarketing:saved.remarketing??emptyRemarketing(),content},
 };
}

export function OfferFlowEditor({offer,product,assets,uploadAction,onSaved}:{offer:Row;product:Row;assets:Row[];uploadAction?:ReactNode;onSaved:(offer:Row)=>void}){
 const {environment}=useWorkspace();
 const workflow=useData<Row>(`/workflows/${offer.workflow_version_id}${params(environment)}`,Boolean(offer.workflow_version_id));
 const workflows=useData(`/workflows${params(environment,{product_id:product.id})}`),agents=useData(`/agents${params(environment,{product_id:product.id})}`),banks=useData(`/bank-profiles${params(environment)}`),policies=useData(`/receipt-policies${params(environment)}`);
 const editor=<OfferFlowDraftEditor key={String(offer.series_id??offer.id)} offer={offer} product={product} workflow={workflow.data} assets={assets} workflows={workflows.data??[]} agents={agents.data??[]} banks={banks.data??[]} policies={policies.data??[]} uploadAction={uploadAction} onSaved={onSaved}/>;
 return offer.workflow_version_id?<QueryState query={workflow}>{editor}</QueryState>:editor;
}

export function OpenRemarketingCycles({offer,productOfferIds}:{offer:Row;productOfferIds:string[]}){
 const {environment}=useWorkspace(),cycles=useData(`/remarketing-cycles${params(environment,{status:'OPEN'})}`,offer.status==='PUBLISHED'),previewAction=useAction(),applyAction=useAction();
 const [previews,setPreviews]=useState<Record<string,Record<string,any>>>({}),[message,setMessage]=useState('');
 if(offer.status!=='PUBLISHED')return <Notice>Los tiempos guardados aplicarán a ciclos nuevos cuando publiques esta versión. Los ciclos abiertos nunca se reprograman automáticamente.</Notice>;
 const rows=(cycles.data??[]).filter(cycle=>productOfferIds.includes(String(cycle.source_offer_version_id)));
 async function preview(cycle:Row){const value=await previewAction.mutateAsync({path:`/remarketing-cycles/${cycle.id}/reprogram/preview`,body:{offer_version_id:offer.id}}) as Record<string,any>;setPreviews(current=>({...current,[cycle.id]:value}));setMessage('Vista previa lista. Aún no se modificó ningún ciclo.');}
 async function apply(cycle:Row){const value=previews[cycle.id];if(!value)return;const applied=await applyAction.mutateAsync({path:`/remarketing-cycles/${cycle.id}/reprogram`,body:{offer_version_id:offer.id,expected_revision:value.cycle_revision,preview_hash:value.preview_hash,previewed_at:value.previewed_at},invalidatePaths:['/remarketing-cycles']}) as Record<string,any>;setMessage(applied.future_external_effects_possible?`Reprogramación aplicada: no se envió nada ahora; quedaron ${applied.scheduled} recordatorios REAL futuros sujetos a autorización y elegibilidad al despachar.`:'Reprogramación aplicada sólo a pendientes seguros. No se enviaron mensajes ni se habilitó transporte real.');setPreviews(current=>{const next={...current};delete next[cycle.id];return next;});await cycles.refetch();}
 return <section className="offer-flow-cycles"><h3>Ciclos abiertos</h3><p>Aplicar estos tiempos es una acción separada. Primero revisa vencidos, cupo consumido y límites del canal.</p><Feedback error={previewAction.error??applyAction.error} success={message}/><QueryState query={cycles}>{!rows.length&&<p>No hay ciclos abiertos de este producto.</p>}{rows.map((cycle,index)=>{const value=previews[cycle.id];return <article key={cycle.id}><div><strong>Ciclo abierto {index+1}</strong><p>{cycle.stage==='AGREEMENT'?'Esperando acuerdo':'Esperando comprobante'} · {Number(cycle.consumed_attempts??0)} de {Number(cycle.max_attempts??0)} cupos consumidos</p></div><Button type="button" variant="secondary" disabled={previewAction.isPending||applyAction.isPending} onClick={()=>void preview(cycle)}>Previsualizar cambio</Button>{value&&<div className="offer-flow-cycle-preview"><p>Máximo actual: {value.current_maximum} · nuevo: {value.target_maximum} · efectivo por consumidos: {value.effective_maximum}</p><ul>{(value.slots as Array<Record<string,any>>).map(slot=><li key={slot.id}>Recordatorio {slot.position}: {new Date(slot.due_at).toLocaleString()} · {cycleDisposition(slot.disposition)}{transportDisposition(slot.transport)}</li>)}</ul><Notice>Esta aplicación cancela y recrea sólo timers pendientes. Conserva enviados, en curso, inciertos, vencidos omitidos e IDs de cupo.</Notice><Button type="button" disabled={applyAction.isPending} onClick={()=>void apply(cycle)}>{applyAction.isPending?'Aplicando…':'Aplicar esta vista previa'}</Button></div>}</article>;})}</QueryState></section>;
}

function cycleDisposition(value:unknown){return({PRESERVE_CONSUMED:'conservar consumido',DISABLED:'desactivado',SKIP_OVERDUE:'omitir por vencido',QUOTA_BLOCKED:'bloqueado por cupo',SCHEDULE:'reprogramar pendiente'} as Record<string,string>)[String(value)]??String(value);}
function transportDisposition(value:unknown){return({OUTSIDE_24H_REQUIRES_ELIGIBLE_TEMPLATE_OR_NEW_INBOUND:' · fuera de 24 h: configura una plantilla aprobada con video o espera un nuevo mensaje',OUTSIDE_24H_TEMPLATE_MEDIA_UNSUPPORTED:' · fuera de 24 h: audio no es compatible con plantilla; usa video',OUTSIDE_24H_TEMPLATE_REQUIRES_CURRENT_PROVIDER_EVIDENCE:' · fuera de 24 h: la plantilla de video aún exige evidencia vigente del proveedor'} as Record<string,string>)[String(value)]??'';}

function OfferFlowDraftEditor({offer,product,workflow,assets,workflows,agents,banks,policies,uploadAction,onSaved}:{offer:Row;product:Row;workflow?:Row;assets:Row[];workflows:Row[];agents:Row[];banks:Row[];policies:Row[];uploadAction?:ReactNode;onSaved:(offer:Row)=>void}){
 const {environment,session}=useWorkspace(),storageKey=`commerce-sales-flow-draft:${session.workspace_id}:${environment}:${offer.id}:${offer.version}`;
 const [draft,setDraftState]=useState<OfferFlowDraft>(()=>{
  const source=initialDraft(offer,product,workflow);
  try{const local=JSON.parse(localStorage.getItem(storageKey)??'null') as {draft?:OfferFlowDraft};return local?.draft??source;}catch{return source;}
 });
 const [saved,setSaved]=useState(()=>JSON.stringify(initialDraft(offer,product,workflow))),[revision,setRevision]=useState(Number(offer.version??1)),[message,setMessage]=useState(offer.status==='DRAFT'?'Borrador guardado':'Versión publicada · sólo lectura'),[error,setError]=useState<Error|null>(null);
 const mutation=useAction(),editable=offer.status==='DRAFT'&&(session.permissions.includes('*')||session.permissions.includes('catalog:write'));
 const serialized=JSON.stringify(draft),dirty=serialized!==saved;
 const validation=useMemo(()=>validateSalesFlowOfferDraft({...offer,...draft,status:'DRAFT'}),[draft,offer]);
 const issue=(path:string)=>validation.issues.find(item=>item.path.join('.')===path||item.path.join('.').startsWith(path+'.'));
 const live=useRef({draft,revision,saved});live.current={draft,revision,saved};
 const inflight=useRef<Promise<void>|null>(null);
 const setDraft=(next:OfferFlowDraft|((current:OfferFlowDraft)=>OfferFlowDraft))=>{setDraftState(next);setMessage('Cambios pendientes · guardado automático');setError(null);};

 useEffect(()=>{if(!editable||!dirty)return;try{localStorage.setItem(storageKey,JSON.stringify({draft,updated_at:new Date().toISOString()}));}catch{/* Browser storage is a best-effort recovery copy. */}},[draft,dirty,editable,storageKey]);
 const save=useCallback(async()=>{
  if(inflight.current)return inflight.current;
  const current=live.current;if(JSON.stringify(current.draft)===current.saved||!editable)return;
  const checked=validateSalesFlowOfferDraft({...offer,...current.draft,status:'DRAFT'});
  if(!checked.valid){setMessage('Sin guardar · corrige los campos marcados');return;}
  const snapshot=structuredClone(current.draft),snapshotJson=JSON.stringify(snapshot),expected=current.revision;
  const promise=(async()=>{try{
   const response=await mutation.mutateAsync({path:`/offers/${offer.id}/sales-flow`,method:'PATCH',body:{expected_version:expected,changes:snapshot},invalidatePaths:['/offers']}) as ConfigurationResponse;
   const merged={...offer,...response.offer},serverDraft=initialDraft(merged,product,workflow),serverJson=JSON.stringify(serverDraft),serverRevision=Number(response.offer.version??expected+1);
   setRevision(serverRevision);setSaved(serverJson);live.current={...live.current,revision:serverRevision,saved:serverJson};
   setDraftState(currentDraft=>JSON.stringify(currentDraft)===snapshotJson?serverDraft:{...currentDraft,sales_flow:{...currentDraft.sales_flow,remarketing:{...currentDraft.sales_flow.remarketing,policy_revision:serverDraft.sales_flow.remarketing.policy_revision}}});
   setMessage(response.validation.ready?'Borrador guardado · listo para publicar':'Borrador guardado · aún faltan campos para publicar');setError(null);try{localStorage.removeItem(storageKey);}catch{/* Optional recovery copy. */}onSaved(merged);
  }catch(caught){setError(caught as Error);setMessage('Sin guardar · tus cambios siguen aquí');}finally{inflight.current=null;}})();
  inflight.current=promise;return promise;
 },[editable,mutation,offer,onSaved,product,storageKey,workflow]);
 const saveRef=useRef(save);saveRef.current=save;
 useEffect(()=>{if(!editable||!dirty||!validation.valid)return;const timer=window.setTimeout(()=>void saveRef.current(),900);return()=>window.clearTimeout(timer);},[dirty,editable,serialized,validation.valid]);

 const readyAssets=assets.filter(asset=>asset.status==='READY'&&!asset.archived_at),updateContent=(part:keyof SalesFlowContent,value:SalesFlowContent[typeof part])=>setDraft(current=>({...current,sales_flow:{...current.sales_flow,content:{...current.sales_flow.content!,[part]:value}}}));
 const updatePolicy=(change:(policy:RemarketingPolicy)=>RemarketingPolicy)=>setDraft(current=>({...current,sales_flow:{...current.sales_flow,remarketing:change(current.sales_flow.remarketing)}}));
 const setFulfillment=(stage:'initial'|'closing',items:Fulfillment[])=>setDraft(current=>({...current,fulfillment:[...(stage==='initial'?items:current.fulfillment.filter(item=>item.release_on==='commitment_accepted')),...(stage==='closing'?items:current.fulfillment.filter(item=>item.release_on!=='commitment_accepted'))]}));
 const initialItems=draft.fulfillment.filter(item=>item.release_on==='commitment_accepted'),closingItems=draft.fulfillment.filter(item=>item.release_on!=='commitment_accepted');
 const maximum=draft.sales_flow.remarketing.slots.filter(slot=>slot.enabled).length;

 return <div className="offer-flow-editor" aria-busy={mutation.isPending}>
  <div className="offer-flow-toolbar"><div><Badge tone={validation.ready?'success':validation.valid?'warning':'danger'}>{message}</Badge><p>Máximo configurado: {maximum} {maximum===1?'recordatorio':'recordatorios'} por ciclo.</p></div><div className="button-group">{uploadAction}<Button type="button" variant="secondary" disabled={!editable||!dirty||!validation.valid||mutation.isPending} onClick={()=>void save()}>{mutation.isPending?'Guardando…':'Guardar ahora'}</Button></div></div>
  <Feedback error={error}/>
  {!!validation.issues.length&&<details className="offer-flow-issues" open><summary>{validation.issues.length} puntos por completar antes de publicar</summary><ul>{validation.issues.map((item,index)=><li key={`${item.path.join('.')}:${index}`}>{item.message}</li>)}</ul></details>}
  <fieldset disabled={!editable} className="offer-flow-fieldset">
   <FlowSection number="1" title="Producto y oferta" description="Nombre, precio y frases con las que una persona elige este producto.">
    <div className="form-grid"><Field label="Nombre de la oferta"><input value={draft.name??''} onChange={event=>setDraft(current=>({...current,name:event.target.value}))}/></Field><Field label="Precio"><input type="number" min="0" step="0.01" value={draft.base_amount_minor/100} onChange={event=>setDraft(current=>({...current,base_amount_minor:Math.round(Number(event.target.value)*100)}))}/></Field><Field label="Moneda"><select value={draft.currency} onChange={event=>setDraft(current=>({...current,currency:event.target.value}))}><option value="MXN">MXN · Peso mexicano</option><option value="USD">USD · Dólar estadounidense</option></select></Field></div>
    <Field label="Alias y frases de entrada" error={issue('sales_flow.entry_aliases')}><textarea rows={3} value={draft.sales_flow.entry_aliases.join('\n')} onChange={event=>setDraft(current=>({...current,sales_flow:{...current.sales_flow,entry_aliases:event.target.value.split('\n').map(value=>value.trim()).filter(Boolean)}}))}/><small>Una frase por línea. No uses “sí”, importes ni “ya pagué” para seleccionar producto.</small></Field>
   </FlowSection>
   <FlowSection number="2" title="Presentación" description="Los primeros tres mensajes salen en orden y no exigen respuesta intermedia.">
    <AssetField label="Audio 1 · presentación" value={draft.sales_flow.content!.presentation.audio_asset_id} assets={readyAssets} accept="audio/" error={issue('sales_flow.content.presentation.audio_asset_id')} onChange={asset_id=>updateContent('presentation',{...draft.sales_flow.content!.presentation,audio_asset_id:asset_id})}/>
    <AssetField label="Imagen del pack" value={draft.sales_flow.content!.presentation.pack_image_asset_id} assets={readyAssets} accept="image/" error={issue('sales_flow.content.presentation.pack_image_asset_id')} onChange={asset_id=>updateContent('presentation',{...draft.sales_flow.content!.presentation,pack_image_asset_id:asset_id})}/>
    <Field label="Texto de la oferta" error={issue('sales_flow.content.presentation.offer_text')}><textarea rows={5} value={draft.sales_flow.content!.presentation.offer_text} onChange={event=>updateContent('presentation',{...draft.sales_flow.content!.presentation,offer_text:event.target.value})}/></Field>
   </FlowSection>
   <FlowSection number="3" title="Acuerdo" description="Explica el acuerdo y espera una aceptación que responda a este contexto.">
    <AssetField label="Audio 2 · explicación del acuerdo" value={draft.sales_flow.content!.agreement.audio_asset_id} assets={readyAssets} accept="audio/" error={issue('sales_flow.content.agreement.audio_asset_id')} onChange={asset_id=>updateContent('agreement',{...draft.sales_flow.content!.agreement,audio_asset_id:asset_id})}/>
    <Field label="Solicitud escrita del acuerdo" error={issue('sales_flow.content.agreement.prompt')}><textarea rows={4} value={draft.sales_flow.content!.agreement.prompt} onChange={event=>updateContent('agreement',{...draft.sales_flow.content!.agreement,prompt:event.target.value})}/><small>Acepta expresiones inequívocas como “sí, lo quiero” sólo después de presentar este mensaje.</small></Field>
   </FlowSection>
   <FlowSection number="4" title="Entrega inicial" description="Materiales que recibe después de aceptar y antes del cobro."><MaterialList items={initialItems} assets={readyAssets} onChange={items=>setFulfillment('initial',items)} release="commitment_accepted" error={issue('fulfillment')}/></FlowSection>
   <FlowSection number="5" title="Cobro" description="Invitación de pago, instrucciones protegidas y revisión del comprobante.">
    <AssetField label="Audio 3 · invitación a pagar" value={draft.sales_flow.content!.collection.audio_asset_id} assets={readyAssets} accept="audio/" error={issue('sales_flow.content.collection.audio_asset_id')} onChange={asset_id=>updateContent('collection',{...draft.sales_flow.content!.collection,audio_asset_id:asset_id})}/>
    <Field label="Mensaje de cobro" error={issue('sales_flow.content.collection.payment_instructions')}><textarea rows={5} value={draft.sales_flow.content!.collection.payment_instructions} onChange={event=>updateContent('collection',{...draft.sales_flow.content!.collection,payment_instructions:event.target.value})}/><small>Los datos bancarios se insertan desde el perfil protegido; no los pegues aquí.</small></Field>
    <div className="form-grid"><Field label="Perfil de pago" error={issue('payment_profile_version_id')}><HumanSelect value={draft.payment_profile_version_id} rows={banks} empty="Selecciona un perfil" onChange={payment_profile_version_id=>setDraft(current=>({...current,payment_profile_version_id}))}/></Field><Field label="Política de comprobante" error={issue('receipt_policy_version_id')}><HumanSelect value={draft.receipt_policy_version_id} rows={policies} empty="Selecciona una política" onChange={receipt_policy_version_id=>setDraft(current=>({...current,receipt_policy_version_id}))}/></Field></div>
   </FlowSection>
   <FlowSection number="6" title="Cierre" description="Agradece el comprobante y entrega todos los regalos sin umbral de importe.">
    <Field label="Agradecimiento" error={issue('sales_flow.content.closure.receipt_thanks')}><textarea rows={4} value={draft.sales_flow.content!.closure.receipt_thanks} onChange={event=>updateContent('closure',{receipt_thanks:event.target.value})}/></Field>
    <MaterialList items={closingItems} assets={readyAssets} onChange={items=>setFulfillment('closing',items)} release="receipt_approved" error={issue('fulfillment')}/>
   </FlowSection>
   <FlowSection number="7" title="Seguimiento" description="Tres posiciones estables. Cambiar una demora no activa el recordatorio ni crea otro cupo.">
    <Notice>Enviar más recordatorios aumenta la insistencia. Actívalos sólo con contenido y permiso adecuados; no garantiza evitar bloqueos.</Notice>
    <div className="remarketing-slots">{draft.sales_flow.remarketing.slots.map((slot,index)=><RemarketingSlotEditor key={slot.id} slot={slot} assets={readyAssets} issue={path=>issue(`sales_flow.remarketing.slots.${index}.${path}`)} onChange={next=>updatePolicy(policy=>({...policy,slots:policy.slots.map(item=>item.id===slot.id?next:item)}))}/>)}</div>
   </FlowSection>
   <FlowSection number="8" title="Vendedor" description="Responde preguntas sin cambiar el precio, banco, entregas ni punto pendiente.">
    <div className="form-grid"><Field label="Perfil del vendedor" error={issue('agent_version_id')}><HumanSelect value={draft.agent_version_id} rows={agents} empty="Selecciona un vendedor" onChange={agent_version_id=>setDraft(current=>({...current,agent_version_id}))}/></Field><Field label="Flujo relacionado" error={issue('workflow_version_id')}><HumanSelect value={draft.workflow_version_id} rows={workflows} empty="Selecciona un flujo" onChange={workflow_version_id=>setDraft(current=>({...current,workflow_version_id}))}/></Field></div>
    <div className="button-group"><Link to="/sales/agents" search={{product:product.id}}>Editar conocimiento y objeciones →</Link>{draft.workflow_version_id&&<Link to={`/sales/flows/${draft.workflow_version_id}`} search={{product:product.id}}>Abrir flujo avanzado →</Link>}</div>
   </FlowSection>
  </fieldset>
  <ChatPreview draft={draft} assets={readyAssets}/>
  <details><summary>Ajustes avanzados</summary><p>Receta {draft.sales_flow.recipe.recipe_id} · revisión {draft.sales_flow.recipe.recipe_revision}. La oferta conserva sus referencias históricas; guardar no publica ni activa números.</p><label><input type="checkbox" checked={draft.positive_payment_unlocks_all} disabled={!editable} onChange={event=>setDraft(current=>({...current,positive_payment_unlocks_all:event.target.checked}))}/> Un comprobante válido con importe positivo libera todos los regalos configurados.</label></details>
 </div>;
}

function FlowSection({number,title,description,children}:{number:string;title:string;description:string;children:ReactNode}){return <section className="offer-flow-section"><header><span>{number}</span><div><h3>{title}</h3><p>{description}</p></div></header><div className="offer-flow-section-body">{children}</div></section>;}
function Field({label,error,children}:{label:string;error?:SalesFlowConfigurationIssue;children:ReactNode}){const id=useId();return <label className="field" htmlFor={id}><span>{label}</span><div id={id} aria-invalid={Boolean(error)}>{children}</div>{error&&<small className="field-error">{error.message}</small>}</label>;}
function HumanSelect({value,rows,empty,onChange}:{value?:string;rows:Row[];empty:string;onChange:(value:string|undefined)=>void}){return <select value={value??''} onChange={event=>onChange(event.target.value||undefined)}><option value="">{empty}</option>{rows.filter(row=>!row.archived_at&&row.status!=='ARCHIVED').map(row=><option key={row.id} value={row.id}>{row.name??row.alias??'Sin nombre'}{row.status?` · ${row.status==='PUBLISHED'?'Publicado':'Borrador'}`:''}</option>)}</select>;}
function AssetField({label,value,assets,accept,error,onChange}:{label:string;value:string;assets:Row[];accept:string;error?:SalesFlowConfigurationIssue;onChange:(value:string)=>void}){const eligible=assets.filter(asset=>String(asset.mime_type??'').startsWith(accept));return <div className="offer-flow-asset"><Field label={label} error={error}><select value={value} onChange={event=>onChange(event.target.value)}><option value="">Selecciona desde la biblioteca…</option>{eligible.map(asset=><option key={asset.id} value={asset.id}>{asset.name??'Material sin nombre'} · {String(asset.mime_type??'archivo').replace(accept,'')}</option>)}</select></Field>{value&&<AssetPreview assetId={value} inline/>}</div>;}

function MaterialList({items,assets,onChange,release,error}:{items:Fulfillment[];assets:Row[];onChange:(items:Fulfillment[])=>void;release:Fulfillment['release_on'];error?:SalesFlowConfigurationIssue}){
 const [candidate,setCandidate]=useState(''),available=assets.filter(asset=>!items.some(item=>item.asset_id===asset.id));
 const update=(index:number,asset_id:string)=>onChange(items.map((item,position)=>position===index?{...item,asset_id}:item));
 const move=(index:number,direction:number)=>{const next=[...items],target=index+direction;if(target<0||target>=next.length)return;[next[index],next[target]]=[next[target]!,next[index]!];onChange(next);};
 return <div className="offer-flow-materials">{!items.length&&<p>No hay materiales en esta etapa.</p>}{items.map((item,index)=><article key={`${item.asset_id}:${index}`}><div><strong>{index+1}. {assets.find(asset=>asset.id===item.asset_id)?.name??'Material no disponible'}</strong>{item.min_amount_minor!=null&&<Badge tone="warning">Tiene mínimo histórico</Badge>}</div><select aria-label={`Sustituir material ${index+1}`} value={item.asset_id} onChange={event=>update(index,event.target.value)}>{assets.map(asset=><option key={asset.id} value={asset.id}>{asset.name??'Material sin nombre'}</option>)}</select><AssetPreview assetId={item.asset_id}/><div className="button-group"><Button type="button" size="sm" variant="secondary" disabled={index===0} onClick={()=>move(index,-1)}>Subir</Button><Button type="button" size="sm" variant="secondary" disabled={index===items.length-1} onClick={()=>move(index,1)}>Bajar</Button><Button type="button" size="sm" variant="secondary" onClick={()=>onChange(items.filter((_,position)=>position!==index))}>Retirar del borrador</Button></div></article>)}<div className="button-group"><select aria-label="Material para agregar" value={candidate} onChange={event=>setCandidate(event.target.value)}><option value="">Elegir material…</option>{available.map(asset=><option key={asset.id} value={asset.id}>{asset.name??'Material sin nombre'}</option>)}</select><Button type="button" variant="secondary" disabled={!candidate} onClick={()=>{onChange([...items,{asset_id:candidate,release_on:release}]);setCandidate('');}}>Agregar</Button></div>{error&&<p className="field-error">{error.message}</p>}</div>;
}

function RemarketingSlotEditor({slot,assets,issue,onChange}:{slot:RemarketingSlot;assets:Row[];issue:(path:string)=>SalesFlowConfigurationIssue|undefined;onChange:(slot:RemarketingSlot)=>void}){
 const updateStage=(stage:'awaiting_agreement'|'awaiting_payment',changes:Partial<RemarketingSlot['stages'][typeof stage]>)=>onChange({...slot,stages:{...slot.stages,[stage]:{...slot.stages[stage],...changes}}});
 const updateTemplate=(stage:'awaiting_agreement'|'awaiting_payment',field:'name'|'language',nextValue:string)=>{
  const current=slot.stages[stage].template;
  const name=field==='name'?nextValue:String(current?.name??'');
  const language=field==='language'?nextValue:String(current?.language??'');
  updateStage(stage,{template:name||language?{...current,name,language,header_kind:'video',approved:true}:undefined});
 };
 return <article className="remarketing-slot"><header><div><strong>Recordatorio {slot.position}</strong><p>Enviar después de</p></div><label><input type="checkbox" checked={slot.enabled} onChange={event=>onChange({...slot,enabled:event.target.checked})}/> {slot.enabled?'Activado':'Desactivado'}</label></header>{slot.enabled&&slot.position>1&&<Field label="Confirmación de frecuencia" error={issue('warning_acknowledged')}><label className="remarketing-warning-ack"><input type="checkbox" checked={slot.warning_acknowledged===true} onChange={event=>onChange({...slot,warning_acknowledged:event.target.checked})}/> Confirmo que este recordatorio adicional aumenta la insistencia y requiere permiso y contenido adecuados.</label></Field>}<div className="form-grid"><Field label="Cantidad" error={issue('delay')}><input type="number" min="1" step="1" value={slot.delay.quantity} onChange={event=>onChange({...slot,delay:{...slot.delay,quantity:Number(event.target.value)}})}/></Field><Field label="Unidad"><select value={slot.delay.unit} onChange={event=>onChange({...slot,delay:{...slot.delay,unit:event.target.value as RemarketingSlot['delay']['unit']}})}><option value="minutes">Minutos</option><option value="hours">Horas</option><option value="days">Días</option></select></Field></div>{(['awaiting_agreement','awaiting_payment'] as const).map(stage=>{const value=slot.stages[stage],eligible=assets.filter(asset=>String(asset.mime_type??'').startsWith(value.medium+'/'));return <fieldset key={stage}><legend>{stage==='awaiting_agreement'?'Antes del acuerdo':'Después de la entrega, sin pago'}</legend><div className="form-grid"><Field label="Medio" error={issue(`stages.${stage}.medium`)}><select value={value.medium} onChange={event=>updateStage(stage,{medium:event.target.value as 'audio'|'video',asset_id:undefined})}><option value="audio">Audio</option><option value="video">Video</option></select></Field><Field label="Archivo" error={issue(`stages.${stage}.asset_id`)}><select value={value.asset_id??''} onChange={event=>updateStage(stage,{asset_id:event.target.value||undefined})}><option value="">Selecciona…</option>{eligible.map(asset=><option value={asset.id} key={asset.id}>{asset.name??'Material sin nombre'}</option>)}</select></Field></div>{value.asset_id&&<AssetPreview assetId={value.asset_id}/>}<Field label="Texto" error={issue(`stages.${stage}.text`)}><textarea rows={3} value={value.text} onChange={event=>updateStage(stage,{text:event.target.value})}/></Field><div className="form-grid"><Field label="Nombre de plantilla (opcional)" error={issue(`stages.${stage}.template.name`)}><input value={value.template?.name??''} placeholder="recordatorio_36h" autoCapitalize="none" onChange={event=>updateTemplate(stage,'name',event.target.value)}/></Field><Field label="Idioma de plantilla (opcional)" error={issue(`stages.${stage}.template.language`)}><input value={value.template?.language??''} placeholder="es_MX" autoCapitalize="none" onChange={event=>updateTemplate(stage,'language',event.target.value)}/></Field></div><small>Fuera de 24 horas sólo se usa una plantilla aprobada con encabezado de video y evidencia vigente del proveedor. Escribir aquí el nombre y el idioma no acredita su aprobación; audio fuera de ventana queda bloqueado sin consumir cupo.</small></fieldset>;})}</article>;
}

function ChatPreview({draft,assets}:{draft:OfferFlowDraft;assets:Row[]}){
 const name=(id:string|undefined)=>assets.find(asset=>asset.id===id)?.name??'Material pendiente',content=draft.sales_flow.content!;
 const messages=[
  ['Audio',name(content.presentation.audio_asset_id)],['Imagen',name(content.presentation.pack_image_asset_id)],['Texto',content.presentation.offer_text],['Audio',name(content.agreement.audio_asset_id)],['Texto',content.agreement.prompt],
  ['Entrega',draft.fulfillment.filter(item=>item.release_on==='commitment_accepted').map(item=>name(item.asset_id)).join(' · ')||'Material pendiente'],['Audio',name(content.collection.audio_asset_id)],['Cobro',content.collection.payment_instructions],['Cierre',content.closure.receipt_thanks],['Regalos',draft.fulfillment.filter(item=>item.release_on!=='commitment_accepted').map(item=>name(item.asset_id)).join(' · ')||'Material pendiente'],
 ];
 return <details className="offer-chat-preview" open><summary>Vista previa del chat completo</summary><div className="chat-preview-thread">{messages.map(([kind,text],index)=><div className="chat-preview-bubble" key={index}><small>{index+1} · {kind}</small><p>{text||'Texto pendiente'}</p></div>)}</div><h4>Paquetes de seguimiento activos</h4>{draft.sales_flow.remarketing.slots.filter(slot=>slot.enabled).map(slot=><div className="chat-preview-thread" key={slot.id}><div className="chat-preview-bubble"><small>Sin acuerdo · {slot.delay.quantity} {slot.delay.unit}</small><p>{name(slot.stages.awaiting_agreement.asset_id)} + {slot.stages.awaiting_agreement.text}</p></div><div className="chat-preview-bubble"><small>Sin pago · {slot.delay.quantity} {slot.delay.unit}</small><p>{name(slot.stages.awaiting_payment.asset_id)} + {slot.stages.awaiting_payment.text}</p></div></div>)}</details>;
}
