import type {NumberLabAction} from '../../../contracts/src/number-laboratory.js';

/** V7 RF-19.p: the automatic buyer of «Probar número», as a pure step machine.
 * Each journey runs in its own isolated run; after every settled step the
 * worker asks for the next one with what the step showed (the same view the
 * person sees) and records the checks. Nothing is inferred that the
 * conversation did not show; a step that cannot run leaves the case partial. */
export type SuiteJourney='PURCHASE'|'FOLLOWUP';
export type CheckName='route'|'offer'|'agreement'|'initial_delivery'|'collection'|'receipt'|'delivery'|'exclusion'|'followup';
export interface SuiteCheck {name:CheckName;state:'PASSED'|'FAILED'|'UNKNOWN'|'SKIPPED';detail:string}
/** V7.5.3: what a case must prove beyond its journey (set when the suite starts). */
/** V7.5.4: a continuation keeps the suite and run it continues. */
export interface SuitePlan {receipt_amount_minor?:number;tier_id?:string;continues_suite_id?:string;continues_run_id?:string}
export interface SuiteCase {journey:SuiteJourney;variant_id:string;phase:string;steps:number;checks:SuiteCheck[];expect_followup:boolean;attachment_id:string|null;plan?:SuitePlan}
/** V7.5.3 (A03): the engine's own record of expected and delivered materials. */
export interface SuiteInventory {expected:{commitment:string[];receipt:string[]};delivered:{asset_id:string;stage:'commitment'|'receipt';effects:number;confirmed:number}[];approved_amount_minor:number|null;extracted_amount_minor:number|null;committed:boolean}
export interface SuiteEntry {from:string;kind?:string;purpose?:string|null;status?:string|null;material?:string|null;receipt_id?:string|null;explanation?:string|null;text?:string|null}
export interface SuiteLastStep {state:'APPLIED'|'FAILED'|'UNKNOWN';result:{state?:string;reason?:string|null;variant_id?:string|null;transcript?:SuiteEntry[];flow?:{waiting_for:string|null;ai_status?:string|null};inventory?:SuiteInventory;agreement?:{classifier:string|null;literal:string|null}}|null}
export type SuiteDecision={action:NumberLabAction;phase:string;checks:SuiteCheck[]}|{done:'PASSED'|'FAILED'|'PARTIAL';checks:SuiteCheck[];phase:string};
export const SUITE_REQUIRED:Record<SuiteJourney,CheckName[]>={PURCHASE:['route','offer','agreement','initial_delivery','collection','receipt','delivery','exclusion'],FOLLOWUP:['route','offer','followup']};
export const SUITE_MAX_STEPS=40;
export const SUITE_MESSAGES={greet:'Hola, quiero información',accept:'Sí, acepto'} as const;
/** Silent customer: the clock moves in bounded 2 h steps up to 34 h, so a
 * reminder deferred to the next allowed window is observed at its time, and a
 * second reminder (beyond the cycle's quota) would also be seen. */
const FOLLOWUP_STEP_HOURS=2,FOLLOWUP_TOTAL_HOURS=34;
/** States in which the flow is legitimately waiting for time or transport. */
const BOUNDED_WAITS=new Set(['timer','effect_confirmed','prepayment_delivery_confirmed','closing_delivery_confirmed']);
const MAX_COLLECTION_WAITS=3;

function set(checks:SuiteCheck[],check:SuiteCheck){return[...checks.filter(c=>c.name!==check.name),check];}
function has(checks:SuiteCheck[],name:CheckName){return checks.some(c=>c.name===name);}
export function finishSuiteCase(journey:SuiteJourney,checks:SuiteCheck[]):'PASSED'|'FAILED'|'PARTIAL'{
 if(checks.some(c=>c.state==='FAILED'))return'FAILED';
 const required=SUITE_REQUIRED[journey];
 // V7.5.3: SKIPPED records why a check did not run; it never proves it.
 return required.every(n=>checks.some(c=>c.name===n&&c.state==='PASSED'))?'PASSED':'PARTIAL';
}
const business=(t:SuiteEntry[])=>t.filter(e=>e.from==='business');
const isFollowup=(e:SuiteEntry)=>e.from==='business'&&(e.purpose==='remarketing'||e.purpose==='followup');

export function nextSuiteStep(c:SuiteCase,last:SuiteLastStep|null):SuiteDecision{
 let checks=[...c.checks];
 const done=(phase=c.phase)=>({done:finishSuiteCase(c.journey,checks),checks,phase});
 const step=(action:NumberLabAction,phase:string)=>({action,phase,checks});
 if(!last)return step({type:'message',text:SUITE_MESSAGES.greet},'OFFER');
 if(c.steps>=SUITE_MAX_STEPS){checks=set(checks,{name:pending(c),state:'UNKNOWN',detail:`La prueba no terminó en ${SUITE_MAX_STEPS} pasos.`});return done();}
 if(last.state!=='APPLIED'||!last.result||last.result.state==='DEPENDENCY_REQUIRED'){
  const reason=last.result?.reason??(last.state==='UNKNOWN'?'Resultado incierto':'El paso no se pudo aplicar');
  checks=set(checks,{name:pending(c),state:last.state==='FAILED'&&last.result?.state!=='DEPENDENCY_REQUIRED'?'FAILED':'UNKNOWN',detail:String(reason).slice(0,200)});return done();
 }
 const r=last.result,t=r.transcript??[],waiting=r.flow?.waiting_for??null;
 if(c.phase==='OFFER'){
  if(!has(checks,'route')&&business(t).length)checks=set(checks,r.variant_id===c.variant_id?{name:'route',state:'PASSED',detail:'El mensaje llegó a esta variante.'}:{name:'route',state:'FAILED',detail:'El mensaje lo atendió otra variante.'});
  if(waiting==='simulation_continue')return step({type:'continue'},'OFFER');
  if(!has(checks,'route'))checks=set(checks,{name:'route',state:'FAILED',detail:'El negocio no respondió al saludo.'});
  const offered=business(t).some(e=>e.purpose!=='collection'&&!isFollowup(e));
  checks=set(checks,offered?{name:'offer',state:'PASSED',detail:'El negocio presentó la oferta.'}:{name:'offer',state:'FAILED',detail:'No hubo respuesta con la oferta.'});
  if(checks.some(x=>x.state==='FAILED'))return done();
  if(c.journey==='FOLLOWUP')return step({type:'advance',hours:FOLLOWUP_STEP_HOURS},'FOLLOWUP_'+FOLLOWUP_STEP_HOURS);
  // V7.5.3 (F2): a contextual agreement is accepted naturally («Sí, acepto»,
  // the mandatory proof of opción 2); a flow that still requires its literal
  // phrase gets exactly that phrase.
  const agreement=r.agreement,acceptance=agreement&&agreement.classifier!=='contextual_agreement'&&agreement.literal?agreement.literal:SUITE_MESSAGES.accept;
  return step({type:'message',text:acceptance},'COLLECTION');
 }
 const collectionWait=/^COLLECTION(?:_WAIT_(\d))?$/.exec(c.phase);
 if(collectionWait){
  if(waiting==='simulation_continue')return step({type:'continue'},c.phase);
  const inv=r.inventory;
  // The acceptance must have changed state; a reply that only says so does not count.
  if(waiting==='commitment'||inv&&!inv.committed){checks=set(checks,{name:'agreement',state:'FAILED',detail:'El flujo siguió esperando el acuerdo después de aceptar; no se registró ni se entregó nada.'});return done();}
  if(!has(checks,'agreement'))checks=set(checks,{name:'agreement',state:inv?.committed?'PASSED':'UNKNOWN',detail:inv?.committed?'El acuerdo quedó registrado por el flujo.':'No hay registro del acuerdo en la prueba.'});
  const collected=t.some(e=>e.from==='business'&&e.purpose==='collection');
  if(!collected){
   const waits=Number(collectionWait[1]??0);
   if(waiting&&BOUNDED_WAITS.has(waiting)&&waits<MAX_COLLECTION_WAITS)return step({type:'advance',hours:2},'COLLECTION_WAIT_'+(waits+1));
   if(r.flow?.ai_status==='HUMAN_REVIEW'||waiting==='human_approved'){checks=set(checks,{name:'collection',state:'UNKNOWN',detail:'La conversación pasó a revisión humana antes del cobro.'});return done();}
   checks=set(checks,waiting&&BOUNDED_WAITS.has(waiting)
    ?{name:'collection',state:'UNKNOWN',detail:`El flujo siguió esperando (${waiting}) después de ${waits*2} h; tiempo agotado sin datos de pago.`}
    :{name:'collection',state:'FAILED',detail:'No llegaron los datos de pago después de aceptar.'});
   return done();
  }
  checks=set(checks,inventoryCheck('initial_delivery',inv,'commitment','antes del cobro'));
  checks=set(checks,{name:'collection',state:'PASSED',detail:'Llegaron los datos de pago (marcador de prueba).'});
  if(checks.some(x=>x.state==='FAILED'))return done();
  if(waiting!=='receipt_approved'||!c.attachment_id){checks=set(checks,{name:'receipt',state:'UNKNOWN',detail:'El flujo no quedó esperando el comprobante.'});return done();}
  return step({type:'receipt',attachment_id:c.attachment_id},'RECEIPT');
 }
 if(c.phase==='RECEIPT'){
  const receipt=[...t].reverse().find(e=>e.kind==='receipt');
  if(!receipt){checks=set(checks,{name:'receipt',state:'FAILED',detail:'El comprobante no se registró.'});return done();}
  if(receipt.status==='REJECTED'){checks=set(checks,{name:'receipt',state:'FAILED',detail:(receipt.explanation??'El comprobante fue rechazado.').slice(0,300)});return done();}
  const planned=c.plan?.receipt_amount_minor,extracted=r.inventory?.extracted_amount_minor??null;
  if(planned!==undefined&&extracted!==null&&extracted!==planned){checks=set(checks,{name:'receipt',state:'FAILED',detail:`Se leyó un importe distinto al del comprobante (${extracted} en lugar de ${planned}, en centavos).`});return done();}
  if(receipt.status==='HUMAN_REVIEW'&&receipt.receipt_id){
   checks=set(checks,{name:'receipt',state:'PASSED',detail:('Se leyó y pasó a revisión: '+(receipt.explanation??'')).slice(0,300)});
   return step({type:'review_receipt',receipt_id:receipt.receipt_id,decision:'APPROVED',reason:'Aprobado por la prueba automática'},'DELIVERY');
  }
  checks=set(checks,{name:'receipt',state:receipt.status==='APPROVED'?'PASSED':'UNKNOWN',detail:(receipt.explanation??receipt.status??'').slice(0,300)});
  if(receipt.status!=='APPROVED')return done();
  return deliveryStep(c,t,waiting,checks,r.inventory);
 }
 if(c.phase==='DELIVERY')return deliveryStep(c,t,waiting,checks,r.inventory);
 if(c.phase==='EXCLUSION'){
  const approved=t.map((e,i)=>({e,i})).filter(x=>x.e.kind==='receipt'&&x.e.status==='APPROVED').at(-1)?.i??-1;
  const after=t.slice(approved+1).filter(isFollowup);
  checks=set(checks,after.length?{name:'exclusion',state:'FAILED',detail:'Siguió enviando seguimientos después de la compra.'}:{name:'exclusion',state:'PASSED',detail:'Sin seguimientos en las 24 h posteriores a la compra.'});
  return done();
 }
 const followup=/^FOLLOWUP_(\d{1,2})$/.exec(c.phase);
 if(followup){
  if(waiting==='simulation_continue')return step({type:'continue'},c.phase);
  const sent=t.filter(isFollowup),elapsed=Number(followup[1]);
  // A follow-up proves the policy only with the policy active; then the
  // clock keeps moving to confirm the cycle's single-message quota.
  if(elapsed<FOLLOWUP_TOTAL_HOURS&&sent.length<=1)return step({type:'advance',hours:FOLLOWUP_STEP_HOURS},'FOLLOWUP_'+(elapsed+FOLLOWUP_STEP_HOURS));
  if(sent.length>1)checks=set(checks,{name:'followup',state:'FAILED',detail:`Llegaron ${sent.length} seguimientos; la política permite uno por ciclo.`});
  else if(sent.length===1)checks=set(checks,c.expect_followup?{name:'followup',state:'PASSED',detail:`Llegó un único seguimiento en ${elapsed} h sin respuesta.`}:{name:'followup',state:'FAILED',detail:'Llegó un seguimiento aunque la variante no tiene seguimientos activos.'});
  else checks=set(checks,c.expect_followup?{name:'followup',state:'FAILED',detail:`No llegó ningún seguimiento en ${elapsed} h sin respuesta.`}:{name:'followup',state:'SKIPPED',detail:'La variante no tiene seguimientos activos; no se acredita.'});
  return done();
 }
 checks=set(checks,{name:pending(c),state:'UNKNOWN',detail:'Paso desconocido.'});return done();
}
function deliveryStep(c:SuiteCase,t:SuiteEntry[],waiting:string|null,checks:SuiteCheck[],inv?:SuiteInventory):SuiteDecision{
 if(waiting==='simulation_continue')return{action:{type:'continue'},phase:'DELIVERY',checks};
 const planned=c.plan?.receipt_amount_minor;
 let next=checks;
 if(planned!==undefined&&inv&&inv.approved_amount_minor!==planned)next=set(next,{name:'delivery',state:'FAILED',detail:`Se aprobó un importe distinto (${inv.approved_amount_minor??'ninguno'} en lugar de ${planned}, en centavos).`});
 else next=set(next,inventoryCheck('delivery',inv,'receipt','después de aprobar el pago'));
 if(next.find(x=>x.name==='delivery')?.state!=='PASSED')return{done:finishSuiteCase(c.journey,next),checks:next,phase:'DELIVERY'};
 return{action:{type:'advance',hours:24},phase:'EXCLUSION',checks:next};
}
/** V7.5.3 (A03): every expected material of the stage, by ID, exactly once,
 * accepted by transport; nothing of another stage early; nothing unexpected. */
function inventoryCheck(name:'initial_delivery'|'delivery',inv:SuiteInventory|undefined,stage:'commitment'|'receipt',when:string):SuiteCheck{
 if(!inv)return{name,state:'UNKNOWN',detail:'La prueba no informó el inventario esperado; no se acredita por un solo material.'};
 const expected=inv.expected[stage],rows=inv.delivered.filter(d=>d.stage===stage);
 if(!expected.length&&stage==='commitment'&&!rows.length&&!inv.delivered.some(d=>d.stage==='receipt'))return{name,state:'PASSED',detail:'La variante no entrega materiales al aceptar y no entregó ninguno.'};
 if(!expected.length)return{name,state:'UNKNOWN',detail:'La variante no tiene materiales configurados para esta etapa; no se acredita la entrega.'};
 const missing=expected.filter(id=>!rows.some(d=>d.asset_id===id&&d.confirmed>=1));
 const duplicated=rows.filter(d=>d.effects>1||rows.filter(x=>x.asset_id===d.asset_id).length>1).map(d=>d.asset_id);
 const unexpected=rows.filter(d=>!expected.includes(d.asset_id)).map(d=>d.asset_id);
 const early=stage==='commitment'?inv.delivered.filter(d=>d.stage==='receipt').map(d=>d.asset_id):[];
 if(missing.length||duplicated.length||unexpected.length||early.length)return{name,state:'FAILED',detail:[
  missing.length?`faltan ${missing.length} de ${expected.length}`:'',duplicated.length?`${new Set(duplicated).size} duplicados`:'',
  unexpected.length?`${unexpected.length} no esperados`:'',early.length?`${early.length} liberados antes de aprobar el pago`:''].filter(Boolean).join(', ').replace(/^./,m=>m.toUpperCase())+` (${when}).`};
 return{name,state:'PASSED',detail:`Llegaron los ${expected.length} materiales esperados ${when}, una sola vez cada uno.`};
}
function pending(c:SuiteCase):CheckName{return SUITE_REQUIRED[c.journey].find(n=>!c.checks.some(x=>x.name===n))??SUITE_REQUIRED[c.journey].at(-1)!;}

/** RF-19.h: one result per variant, from its two journeys. */
export type VariantVerdict='RESPONDE_BIEN'|'FALLO'|'INCOMPLETO'|'EN_CURSO'|'SIN_PROBAR';
export const verdictLabels:Record<VariantVerdict,string>={RESPONDE_BIEN:'Responde bien',FALLO:'Falló',INCOMPLETO:'Incompleto',EN_CURSO:'En curso',SIN_PROBAR:'Sin probar'};
export function variantVerdict(cases:{journey:SuiteJourney;state:string}[]):VariantVerdict{
 if(!cases.length)return'SIN_PROBAR';
 if(cases.some(c=>c.state==='FAILED'))return'FALLO';
 if(cases.some(c=>c.state==='RUNNING'))return'EN_CURSO';
 if(cases.length===2&&cases.every(c=>c.state==='PASSED')&&new Set(cases.map(c=>c.journey)).size===2)return'RESPONDE_BIEN';
 return'INCOMPLETO';
}
