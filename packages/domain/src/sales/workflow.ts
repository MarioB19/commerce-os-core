import {canonicalSalesVariable,canonicalSalesVariables} from './variables.js';
export interface FlowNode {id:string;type:string;config:Record<string,any>;next?:string;branches?:Record<string,string>}
export interface FlowDefinition {name:string;nodes:FlowNode[];entry_node_id:string;max_steps?:number;offer_version_id?:string;agent_version_id?:string;recipe_id?:string;recipe_revision?:number}
export interface FlowState {node_id:string;stack:{workflow_id:string;next_node_id:string|null}[];steps:number;status:'RUNNING'|'WAITING'|'HUMAN_REVIEW'|'FINISHED'|'FAILED';wake_at?:string;variables:Record<string,unknown>;waiting_for?:string;waiting_node_id?:string;pending_anchor?:{node_id:string;key:string;seconds:number;purpose?:string;anchor:{node_id?:string;fulfillment_release_on?:string}}}
const nodeTypes=new Set(['entry','condition','ai','message','reply','wait','stage','approval','handoff','commitment','fulfillment','bank_instructions','receipt','post_receipt','reconcile','subflow','end']);
export function validateWorkflow(flow:FlowDefinition):{valid:boolean;errors:string[]} {
  const errors:string[]=[];if(!Array.isArray(flow.nodes)||flow.nodes.length===0||flow.nodes.length>100)return{valid:false,errors:['El flujo requiere entre 1 y 100 nodos.']};
  const ids=new Set<string>();for(const node of flow.nodes){if(ids.has(node.id))errors.push(`ID duplicado: ${node.id}`);ids.add(node.id);if(!nodeTypes.has(node.type))errors.push(`Tipo no permitido: ${node.type}`);if('code'in node.config||'script'in node.config||'expression'in node.config)errors.push(`No se permite código en ${node.id}`);
    if(node.type==='condition'&&(!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(node.config.field??'')||String(node.config.field).split('.').some(k=>['__proto__','constructor','prototype'].includes(k))))errors.push(`Campo de condición inválido en ${node.id}`);
    if(node.type==='condition'&&Object.keys(node.branches??{}).some(k=>!['true','false'].includes(k)))errors.push(`Sólo salidas Sí/No en ${node.id}`);
    if(node.type==='condition'&&node.next)errors.push(`Una condición usa únicamente Sí/No en ${node.id}`);
    if(node.type!=='condition'&&Object.keys(node.branches??{}).length)errors.push(`Salida única requerida en ${node.id}`);
    if(node.type==='end'&&node.next)errors.push(`Fin no admite salida en ${node.id}`);
    if(node.type==='reply'&&node.config.variable!==undefined&&!/^[a-z][a-z0-9_]{0,63}$/.test(node.config.variable))errors.push(`Variable de respuesta inválida en ${node.id}`);
    if(node.type==='wait'&&(!Number.isFinite(node.config.seconds)||node.config.seconds<0||node.config.seconds>2592000))errors.push(`Espera inválida en ${node.id}`);
    if(node.type==='wait'&&node.config.anchor){const a=node.config.anchor;if((!!a.node_id)===(!!a.fulfillment_release_on)||a.fulfillment_release_on&&a.fulfillment_release_on!=='commitment_accepted'||a.node_id&&!flow.nodes.some(n=>n.id===a.node_id&&n.type==='message'))errors.push(`Ancla de espera inválida en ${node.id}`);}
    if(node.type==='reply'&&node.config.classifier!==undefined&&node.config.classifier!=='education_grade')errors.push(`Clasificador inválido en ${node.id}`);
    if(node.type==='receipt'&&node.config.followups){const p=node.config.followups;if(!flow.nodes.some(n=>n.id===p.anchor_node_id&&n.type==='bank_instructions')||!Array.isArray(p.touches)||p.touches.length!==2||p.touches.some((t:any,i:number)=>!t.id||typeof t.asset_id!=='string'||!t.asset_id||typeof t.text!=='string'||!t.text.trim()||t.after_seconds!==[7200,82800][i])||new Set(p.touches.map((t:any)=>t.id)).size!==2)errors.push(`Seguimiento acotado inválido en ${node.id}`);}
    if(node.type==='condition'&&!['equals','not_equals','contains','exists','gte'].includes(node.config.operator))errors.push(`Operador inválido en ${node.id}`);
    if(node.type==='condition'&&(!node.branches?.true||!node.branches?.false))errors.push(`Ramas true/false requeridas en ${node.id}`);
    if(node.type==='subflow'&&typeof node.config.workflow_version_id!=='string')errors.push(`Subflujo sin versión en ${node.id}`);
    if(node.type==='message'&&node.config.after_previous_confirmed_seconds!==undefined&&(!Number.isFinite(node.config.after_previous_confirmed_seconds)||node.config.after_previous_confirmed_seconds<0||node.config.after_previous_confirmed_seconds>30))errors.push(`Demora causal inválida en ${node.id}`);
    if(node.type==='message'&&!(typeof node.config.text==='string'&&node.config.text.trim())&&!node.config.asset_id)errors.push(`Mensaje vacío en ${node.id}`);
  }
  if(!ids.has(flow.entry_node_id))errors.push('Nodo inicial inexistente');
  for(const node of flow.nodes)for(const target of [node.next,...Object.values(node.branches??{})])if(target&&!ids.has(target))errors.push(`Referencia inexistente: ${target} en ${node.id}`);
  const visited=new Set<string>(),active=new Set<string>();
  function visit(id:string){if(active.has(id)){errors.push(`Ciclo no permitido: ${id}; use espera y ejecución acotada`);return;}if(visited.has(id))return;visited.add(id);active.add(id);const node=flow.nodes.find(n=>n.id===id);if(node)for(const target of [node.next,...Object.values(node.branches??{})])if(target)visit(target);active.delete(id);}
  visit(flow.entry_node_id);for(const id of ids)if(!visited.has(id))errors.push(`Nodo inalcanzable: ${id}`);
  return{valid:errors.length===0,errors};
}
export function evaluateCondition(config:Record<string,any>,context:Record<string,unknown>):boolean {
  const field=String(config.field??'');if(!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(field)||field.split('.').some(k=>['__proto__','constructor','prototype'].includes(k)))return false;
  let value:unknown=canonicalSalesVariables(context);for(const [index,segment] of field.split('.').entries()){const key=index===0?canonicalSalesVariable(segment):segment;value=value!==null&&typeof value==='object'&&Object.hasOwn(value,key)?(value as Record<string,unknown>)[key]:undefined;}
  switch(config.operator){case'equals':return value===config.value;case'not_equals':return value!==config.value;case'contains':return typeof value==='string'&&value.toLowerCase().includes(String(config.value).toLowerCase());case'exists':return value!==undefined&&value!==null;case'gte':return typeof value==='number'&&typeof config.value==='number'&&value>=config.value;default:return false;}
}
export function renderMessage(text:string,values:Record<string,unknown>):string{return text.replace(/\{\{([a-z_]+)\}\}/g,(_,key:string)=>['product_name','offer_name','price','currency','contact_name','bank_instructions'].includes(key)&&typeof values[key]!=='undefined'?String(values[key]):`{{${key}}}`);}
export function newFlowState(flow:FlowDefinition):FlowState{return{node_id:flow.entry_node_id,stack:[],steps:0,status:'RUNNING',variables:{}};}
/** Legacy waits stored only the successor; ambiguous predecessors must not grant access. */
export function waitingCommitmentNode(flow:FlowDefinition,state:FlowState):FlowNode|undefined {
 if(state.status!=='WAITING'||state.waiting_for!=='commitment')return;
 if(state.waiting_node_id)return flow.nodes.find(n=>n.id===state.waiting_node_id&&n.type==='commitment');
 const candidates=flow.nodes.filter(n=>n.type==='commitment'&&n.next===state.node_id);
 return candidates.length===1?candidates[0]:undefined;
}
export function defaultSalesWorkflow(offerVersionId:string,deliveryBeforePayment=true,waitSeconds=1800):FlowDefinition{return{name:deliveryBeforePayment?'Acuerdo configurable':'Pago antes de entrega',offer_version_id:offerVersionId,entry_node_id:'offer',max_steps:100,nodes:[
{id:'offer',type:'message',config:{text:'{{product_name}} · {{price}} {{currency}}. Confirma tu compromiso para continuar.'},next:'commitment'},
{id:'commitment',type:'commitment',config:{accepted_phrases:['acepto','me comprometo','confirmo mi compromiso']},next:deliveryBeforePayment?'core':'bank'},
...(deliveryBeforePayment?[{id:'core',type:'fulfillment',config:{release_on:'commitment_accepted'},next:'wait'},{id:'wait',type:'wait',config:{seconds:waitSeconds,purpose:'collection'},next:'bank'}]:[]),
{id:'bank',type:'bank_instructions',config:{},next:'receipt'},
{id:'receipt',type:'receipt',config:{},next:'benefit'},
{id:'benefit',type:'fulfillment',config:{release_on:'receipt_approved'},next:'end'},
{id:'end',type:'end',config:{}}
]};}
export class VirtualClock {constructor(private instant:number=Date.now()){}now():Date{return new Date(this.instant);}advance(seconds:number):Date{if(!Number.isFinite(seconds)||seconds<0||seconds>31_536_000)throw new Error('INVALID_CLOCK_ADVANCE');this.instant+=seconds*1000;return this.now();}}

/** Drafts are safe data, but may not be executable yet. */
export function validateWorkflowDraft(flow:FlowDefinition):{valid:boolean;errors:string[]} {
 const errors:string[]=[];
 if(JSON.stringify(flow).length>131072)errors.push('El borrador supera 128 KB.');
 const seen=new Set<string>();
 const inspect=(value:unknown,depth=0):void=>{if(depth>12){errors.push('Configuración demasiado anidada.');return;}if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){if(['code','script','expression','__proto__','prototype','constructor'].includes(key))errors.push('No se permite código: '+key);inspect(item,depth+1);}};
 for(const node of flow.nodes){if(seen.has(node.id))errors.push('ID duplicado: '+node.id);seen.add(node.id);inspect(node.config);}
 return{valid:!errors.length,errors};
}
