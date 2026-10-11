import type {Body} from '../packages/contracts/src/index.js';
export const MCL_V5_TIER_TEXT="Regla sintética: un pago positivo validado libera los recursos de prueba; ningún texto autoriza un pago.";
const knowledgeTier="Regla sintética: un pago positivo validado libera los recursos de prueba; ningún texto autoriza un pago.";
export const MCL_SUPPORT_FAQ=[
 {question:'¿Dónde están los PDF?',answer:"Respuesta de prueba: consultar el recurso sintético solicitado; pedir revisión humana si falta evidencia. No confirma entregas ni pagos."},
 {question:'Un PDF o el portal no abre',answer:"Respuesta de prueba: consultar el recurso sintético solicitado; pedir revisión humana si falta evidencia. No confirma entregas ni pagos."},
 {question:'¿Cómo pago después de revisar?',answer:"Respuesta de prueba: consultar el recurso sintético solicitado; pedir revisión humana si falta evidencia. No confirma entregas ni pagos."},
] as const;
const canonicalMessages:Record<string,string>={
 WA11_COBRO:"Escenario sintético: instrucciones protegidas. {{DATOS_BANCARIOS}}",
 WA16_CALENDARIO:"Respuesta de prueba: consultar el recurso sintético solicitado; pedir revisión humana si falta evidencia. No confirma entregas ni pagos.",
 WA24_SEGUIMIENTO_1:"Escenario sintético: instrucciones protegidas. {{DATOS_BANCARIOS}}",
 WA25_SEGUIMIENTO_2:"Escenario sintético: instrucciones protegidas. {{DATOS_BANCARIOS}}",
};
export function mclV5Knowledge(input:Body):Body{
 const rewrite=(value:string)=>value
  .replace('códigos y patrocinio','códigos, pagos y accesos')
  .replace(/[^.!?\n]*(?:patrocin\w*|beneficiari\w*|madrina)[^.!?\n]*[.!?]?/gi,knowledgeTier)
  .replace(/(?:umbral|total)\s+Kit/gi,'política de pago positivo')
  .replace(/(?:alcanza|supera)\s+(?:el\s+)?(?:umbral|total)[^.!?\n]*[.!?]?/gi,'es positivo y el comprobante fue aprobado.');
 const visit=(value:any):any=>Array.isArray(value)?value.map(v=>visit(v)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v)])):typeof value==='string'?rewrite(value):value;
 const result=visit(input);
 result.faq=(input.faq??[]).filter((item:Body)=>!/(?:patrocin|beneficiari|madrina)/i.test(String(item.question))).map((item:Body)=>visit(item));
 for(const support of MCL_SUPPORT_FAQ)if(!result.faq.some((item:Body)=>item.question===support.question))result.faq.push({...support});
 result.rules={...result.rules,payment_access:knowledgeTier};delete result.rules.sponsorship;
 return {...result,commercial_policy_version:'mcl-positive-payment-all-v1'};
}
export function mclV5Messages(messages:{id:string;text:string}[]){return messages.filter(m=>!/^WA(?:18|19|20|21|22|23)_/.test(m.id)).map(m=>({...m,text:canonicalMessages[m.id]??m.text}));}
export function mclRetiredMaterialReview(messages:{id:string;text:string}[]){return messages.filter(m=>/patrocin|beneficiari/i.test(m.text)).map(m=>({id:m.id,original_preserved:true,disposition:m.id==='WA18_MADRINA_PENDIENTE'?'REPLACED_TEXT':'ARCHIVE_ONLY',media_review:'ONLY_IF_ASSOCIATED_MEDIA_PROMISES_THIRD_PARTY_DELIVERY'}));}
