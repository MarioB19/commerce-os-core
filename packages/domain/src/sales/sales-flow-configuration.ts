import {salesFlowConfigurationSchema,type Body,type SalesFlowConfiguration} from '../../../contracts/src/index.js';
import {enabledRemarketingMaximum} from './remarketing.js';

export interface SalesFlowConfigurationIssue {
 code:string;
 path:(string|number)[];
 message:string;
}

export interface SalesFlowConfigurationValidation {
 valid:boolean;
 ready:boolean;
 maximum:number;
 issues:SalesFlowConfigurationIssue[];
 value?:SalesFlowConfiguration;
}

function zodIssues(error:{issues:Array<{code:string;path:PropertyKey[];message:string}>}):SalesFlowConfigurationIssue[]{
 return error.issues.map(issue=>({
  code:String(issue.code).toUpperCase(),
  path:issue.path.map(value=>typeof value==='number'?value:String(value)),
  message:issue.message,
 }));
}

/** Shared browser/API/MCP validation for the versioned offer configuration. */
export function validateSalesFlowConfigurationDraft(value:unknown,options:{requireContent?:boolean}={}):SalesFlowConfigurationValidation{
 const parsed=salesFlowConfigurationSchema.safeParse(value);
 if(!parsed.success)return{valid:false,ready:false,maximum:0,issues:zodIssues(parsed.error)};
 const issues:SalesFlowConfigurationIssue[]=[];
 if(options.requireContent&&!parsed.data.content)issues.push({code:'SALES_FLOW_CONTENT_REQUIRED',path:['content'],message:'Completa presentación, acuerdo, cobro y cierre antes de publicar esta versión.'});
 return{valid:true,ready:issues.length===0,maximum:enabledRemarketingMaximum(parsed.data.remarketing),issues,value:parsed.data};
}

/** Readiness of the complete offer surrounding the guided sales-flow editor. */
export function validateSalesFlowOfferDraft(offer:Body):SalesFlowConfigurationValidation{
 const validation=validateSalesFlowConfigurationDraft(offer.sales_flow,{requireContent:true});
 const issues=validation.issues.map(issue=>({...issue,path:['sales_flow',...issue.path]}));
 const add=(code:string,path:(string|number)[],message:string)=>issues.push({code,path,message});
 if(!offer.payment_profile_version_id)add('PAYMENT_PROFILE_REQUIRED',['payment_profile_version_id'],'Selecciona el perfil de pago que se mostrará al cobrar.');
 if(!offer.receipt_policy_version_id)add('RECEIPT_POLICY_REQUIRED',['receipt_policy_version_id'],'Selecciona la política que revisará el comprobante.');
 if(!offer.workflow_version_id)add('WORKFLOW_REQUIRED',['workflow_version_id'],'Selecciona la versión del flujo que ejecutará esta oferta.');
 if(!offer.agent_version_id)add('SELLER_REQUIRED',['agent_version_id'],'Selecciona el vendedor que responderá preguntas y objeciones.');
 const deliveries=Array.isArray(offer.fulfillment)?offer.fulfillment:[];
 if(!deliveries.some((item:Body)=>item.release_on==='commitment_accepted'))add('INITIAL_DELIVERY_REQUIRED',['fulfillment'],'Agrega al menos un material para entregar después del acuerdo.');
 if(!deliveries.some((item:Body)=>['receipt_approved','reconciled'].includes(String(item.release_on))))add('CLOSING_DELIVERY_REQUIRED',['fulfillment'],'Agrega al menos un regalo o acceso para entregar después del comprobante.');
 for(const[index,item]of deliveries.entries())if(['receipt_approved','reconciled'].includes(String(item.release_on))&&item.min_amount_minor!=null)add('POSTPAYMENT_AMOUNT_GATE',['fulfillment',index,'min_amount_minor'],'Los regalos de esta receta no deben depender de un importe mínimo.');
 return{...validation,ready:validation.valid&&issues.length===0,issues};
}
