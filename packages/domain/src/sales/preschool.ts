import type {FlowDefinition} from './workflow.js';

/** Public synthetic example; does not contain the private commercial copy.
 * Asset references only: access codes, banking data and customer identities are
 * supplied through the protected catalog and never belong in this definition.
 */
export function preschoolWorkflow(assets:{pitch:string;agreement:string;collection:string}):FlowDefinition {
 return{name:'Preescolar Listo · conversación, acuerdo y entrega',entry_node_id:'welcome',max_steps:60,nodes:[
  {id:'welcome',type:'message',config:{text:"Respuesta de prueba: consultar el recurso sintético solicitado; pedir revisión humana si falta evidencia. No confirma entregas ni pagos."},next:'grade'},
  {id:'grade',type:'reply',config:{variable:'grado'},next:'pitch'},
  {id:'pitch',type:'message',config:{kind:'audio',asset_id:assets.pitch},next:'pitch_reply'},
  {id:'pitch_reply',type:'reply',config:{variable:'interes'},next:'offer'},
  {id:'offer',type:'message',config:{text:"Respuesta de prueba: consultar el recurso sintético solicitado; pedir revisión humana si falta evidencia. No confirma entregas ni pagos."},next:'agreement_audio'},
  {id:'agreement_audio',type:'message',config:{kind:'audio',asset_id:assets.agreement},next:'agreement'},
  {id:'agreement',type:'message',config:{text:"Escenario sintético: confirmar el acuerdo de prueba con SÍ, QUIERO MI CICLO LISTO."},next:'commitment'},
  {id:'commitment',type:'commitment',config:{accepted_phrases:['SÍ, QUIERO MI CICLO LISTO','SI QUIERO MI CICLO LISTO','SI, QUIERO MI CICLO LISTO','SÍ QUIERO MI CICLO LISTO','QUIERO MI CICLO LISTO','SI QUIERO EL CICLO LISTO','SI QUIERO MI CICLO LISTO!','SI ACEPTO','SÍ ACEPTO','ACEPTO EL ACUERDO','ACEPTO']},next:'core'},
  {id:'core',type:'fulfillment',config:{release_on:'commitment_accepted'},next:'collection_audio'},
  {id:'collection_audio',type:'message',config:{kind:'audio',asset_id:assets.collection,purpose:'collection'},next:'bank'},
  {id:'bank',type:'bank_instructions',config:{},next:'receipt'},
  {id:'receipt',type:'receipt',config:{},next:'paid'},
  {id:'paid',type:'message',config:{text:"Respuesta de prueba: consultar el recurso sintético solicitado; pedir revisión humana si falta evidencia. No confirma entregas ni pagos."},next:'post_payment'},
  {id:'post_payment',type:'fulfillment',config:{release_on:'receipt_approved'},next:'end'},
  {id:'end',type:'end',config:{}}
 ]};
}

export interface MiCicloListoAssets {pitch:string;agreement:string;collection:string;followup1:string;followup2:string;mockup:string}
/** Same state-machine contract; public text is synthetic and not a production baseline. */
export function miCicloListoWorkflow(assets:MiCicloListoAssets,copy:{offer?:string;agreement?:string;collection?:string;followup1?:string;followup2?:string}={}):FlowDefinition {
 const legacy=preschoolWorkflow(assets);
 const nodes=structuredClone(legacy.nodes);
 nodes.find(n=>n.id==='welcome')!.config={education_intro:true,text:"Respuesta de prueba: consultar el recurso sintético solicitado; pedir revisión humana si falta evidencia. No confirma entregas ni pagos."};
 nodes.find(n=>n.id==='grade')!.config={variable:'grado',classifier:'education_grade'};
 nodes.find(n=>n.id==='commitment')!.config.classifier='contextual_agreement';
 nodes.find(n=>n.id==='pitch')!.next='mockup';
 nodes.splice(nodes.findIndex(n=>n.id==='pitch_reply'),0,
  {id:'mockup',type:'message',config:{kind:'image',asset_id:assets.mockup,after_previous_confirmed_seconds:2.5},next:'pitch_reply'});
 nodes.find(n=>n.id==='offer')!.config.text=copy.offer??"Respuesta de prueba: consultar el recurso sintético solicitado; pedir revisión humana si falta evidencia. No confirma entregas ni pagos.";
 nodes.find(n=>n.id==='agreement')!.config.text=copy.agreement??"Escenario sintético: confirmar el acuerdo de prueba con SÍ, QUIERO MI CICLO LISTO.";
 nodes.find(n=>n.id==='core')!.next='collection_wait';
 nodes.splice(nodes.findIndex(n=>n.id==='collection_audio'),0,{id:'collection_wait',type:'wait',config:{seconds:1800,purpose:'collection',anchor:{fulfillment_release_on:'commitment_accepted'}},next:'collection_audio'});
 nodes.find(n=>n.id==='bank')!.config={text:copy.collection??"Escenario sintético: las instrucciones se resuelven desde el perfil protegido. {{bank_instructions}}"};
 nodes.find(n=>n.id==='receipt')!.config={followups:{anchor_node_id:'bank',touches:[
  {id:'followup_1',asset_id:assets.followup1,after_seconds:7200,text:copy.followup1??"Escenario sintético: las instrucciones se resuelven desde el perfil protegido. {{bank_instructions}}"},
  {id:'followup_2',asset_id:assets.followup2,after_seconds:82800,text:copy.followup2??"Escenario sintético: las instrucciones se resuelven desde el perfil protegido. {{bank_instructions}}"}
 ]}};
 return{...legacy,name:'Mi Ciclo Listo · Preescolar y Primaria · Acuerdo 2026-09-12',nodes};
}
