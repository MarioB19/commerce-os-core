import type {FlowDefinition} from './workflow.js';

/** A separately published recipe: existing pinned workflows retain their terms. */
export function directAgreementWorkflow():FlowDefinition{
 return{name:'Mi Ciclo Listo · acuerdo y entrega directa',entry_node_id:'agreement',max_steps:30,nodes:[
  {id:'agreement',type:'message',config:{text:'¡Hola! Soy Lupita 💛 Mi Ciclo Listo incluye material y herramientas para preescolar y primaria por $97 MXN, en un solo pago.\n\nEl acuerdo es sencillo: te envío ahora el acceso al material Core; tú lo recibes, lo revisas y después pagas los $97. Al entrar al portal eliges tu nivel y grado.\n\n¿Aceptas el acuerdo? Puedes responder «Sí, acepto».'},next:'commitment'},
  {id:'commitment',type:'commitment',config:{classifier:'contextual_agreement',accepted_phrases:['sí','sí acepto','sí, acepto','acepto','acepto el acuerdo','de acuerdo','estoy de acuerdo','ok','va','adelante','sí, mándamelo','sí, envíamelo','sí, quiero mi ciclo listo','sí quiero mi ciclo listo','quiero mi ciclo listo']},next:'core'},
  {id:'core',type:'fulfillment',config:{release_on:'commitment_accepted'},next:'bank'},
  {id:'bank',type:'bank_instructions',config:{text:'Aquí tienes la cuenta para cumplir el acuerdo después de revisar tu material 💛\n\n{{bank_instructions}}\n\nEl pago acordado es de $97 MXN. Envía aquí tu comprobante cuando lo realices.'},next:'receipt'},
  {id:'receipt',type:'receipt',config:{},next:'paid'},
  {id:'paid',type:'message',config:{text:'¡Comprobante aprobado! Gracias por cumplir el acuerdo 💛 Te envío los beneficios que corresponden a tu pago.'},next:'post_payment'},
  {id:'post_payment',type:'fulfillment',config:{release_on:'receipt_approved'},next:'end'},
  {id:'end',type:'end',config:{}}
 ]};
}
