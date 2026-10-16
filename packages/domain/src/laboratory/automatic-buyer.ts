import type {NumberLabAction} from '../../../contracts/src/number-laboratory.js';

/** V7 RF-19.p: the automatic buyer of «Probar número», as a pure step machine.
 * Each journey runs in its own isolated run; after every settled step the
 * worker asks for the next one with what the step showed (the same view the
 * person sees) and records the checks. Nothing is inferred that the
 * conversation did not show; a step that cannot run leaves the case partial. */
export type SuiteJourney='PURCHASE'|'FOLLOWUP';
export type CheckName='route'|'offer'|'collection'|'receipt'|'delivery'|'exclusion'|'followup';
export interface SuiteCheck {name:CheckName;state:'PASSED'|'FAILED'|'UNKNOWN'|'SKIPPED';detail:string}
export interface SuiteCase {journey:SuiteJourney;variant_id:string;phase:string;steps:number;checks:SuiteCheck[];expect_followup:boolean;attachment_id:string|null}
export interface SuiteEntry {from:string;kind?:string;purpose?:string|null;status?:string|null;material?:string|null;receipt_id?:string|null;explanation?:string|null;text?:string|null}
export interface SuiteLastStep {state:'APPLIED'|'FAILED'|'UNKNOWN';result:{state?:string;reason?:string|null;variant_id?:string|null;transcript?:SuiteEntry[];flow?:{waiting_for:string|null}}|null}
export type SuiteDecision={action:NumberLabAction;phase:string;checks:SuiteCheck[]}|{done:'PASSED'|'FAILED'|'PARTIAL';checks:SuiteCheck[];phase:string};
export const SUITE_REQUIRED:Record<SuiteJourney,CheckName[]>={PURCHASE:['route','offer','collection','receipt','delivery','exclusion'],FOLLOWUP:['route','offer','followup']};
export const SUITE_MAX_STEPS=40;
export const SUITE_MESSAGES={greet:'Hola, quiero información',accept:'Sí, acepto'} as const;
/** Silent customer: the clock moves 2, then 8, then 24 hours (34 h in total). */
const FOLLOWUP_HOURS=[2,8,24] as const;

function set(checks:SuiteCheck[],check:SuiteCheck){return[...checks.filter(c=>c.name!==check.name),check];}
function has(checks:SuiteCheck[],name:CheckName){return checks.some(c=>c.name===name);}
export function finishSuiteCase(journey:SuiteJourney,checks:SuiteCheck[]):'PASSED'|'FAILED'|'PARTIAL'{
 if(checks.some(c=>c.state==='FAILED'))return'FAILED';
 const required=SUITE_REQUIRED[journey];
 return required.every(n=>checks.some(c=>c.name===n&&(c.state==='PASSED'||c.state==='SKIPPED')))?'PASSED':'PARTIAL';
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
  if(c.journey==='FOLLOWUP')return step({type:'advance',hours:FOLLOWUP_HOURS[0]},'FOLLOWUP_0');
  return step({type:'message',text:SUITE_MESSAGES.accept},'COLLECTION');
 }
 if(c.phase==='COLLECTION'){
  if(waiting==='simulation_continue')return step({type:'continue'},'COLLECTION');
  const collected=t.some(e=>e.from==='business'&&e.purpose==='collection');
  checks=set(checks,collected?{name:'collection',state:'PASSED',detail:'Llegaron los datos de pago (marcador de prueba).'}:{name:'collection',state:'FAILED',detail:'No llegaron los datos de pago después de aceptar.'});
  if(!collected)return done();
  if(waiting!=='receipt_approved'||!c.attachment_id){checks=set(checks,{name:'receipt',state:'UNKNOWN',detail:'El flujo no quedó esperando el comprobante.'});return done();}
  return step({type:'receipt',attachment_id:c.attachment_id},'RECEIPT');
 }
 if(c.phase==='RECEIPT'){
  const receipt=[...t].reverse().find(e=>e.kind==='receipt');
  if(!receipt){checks=set(checks,{name:'receipt',state:'FAILED',detail:'El comprobante no se registró.'});return done();}
  if(receipt.status==='REJECTED'){checks=set(checks,{name:'receipt',state:'FAILED',detail:(receipt.explanation??'El comprobante fue rechazado.').slice(0,300)});return done();}
  if(receipt.status==='HUMAN_REVIEW'&&receipt.receipt_id){
   checks=set(checks,{name:'receipt',state:'PASSED',detail:('Se leyó y pasó a revisión: '+(receipt.explanation??'')).slice(0,300)});
   return step({type:'review_receipt',receipt_id:receipt.receipt_id,decision:'APPROVED',reason:'Aprobado por la prueba automática'},'DELIVERY');
  }
  checks=set(checks,{name:'receipt',state:receipt.status==='APPROVED'?'PASSED':'UNKNOWN',detail:(receipt.explanation??receipt.status??'').slice(0,300)});
  if(receipt.status!=='APPROVED')return done();
  return deliveryStep(c,t,waiting,checks);
 }
 if(c.phase==='DELIVERY')return deliveryStep(c,t,waiting,checks);
 if(c.phase==='EXCLUSION'){
  const approved=t.map((e,i)=>({e,i})).filter(x=>x.e.kind==='receipt'&&x.e.status==='APPROVED').at(-1)?.i??-1;
  const after=t.slice(approved+1).filter(isFollowup);
  checks=set(checks,after.length?{name:'exclusion',state:'FAILED',detail:'Siguió enviando seguimientos después de la compra.'}:{name:'exclusion',state:'PASSED',detail:'Sin seguimientos en las 24 h posteriores a la compra.'});
  return done();
 }
 const followup=/^FOLLOWUP_(\d)$/.exec(c.phase);
 if(followup){
  if(waiting==='simulation_continue')return step({type:'continue'},c.phase);
  const sent=t.filter(isFollowup);
  const index=Number(followup[1]),elapsed=FOLLOWUP_HOURS.slice(0,index+1).reduce((a,b)=>a+b,0);
  if(sent.length){checks=set(checks,{name:'followup',state:'PASSED',detail:`Llegó un seguimiento después de ${elapsed} h sin respuesta.`});return done();}
  if(index+1<FOLLOWUP_HOURS.length)return step({type:'advance',hours:FOLLOWUP_HOURS[index+1]!},'FOLLOWUP_'+(index+1));
  checks=set(checks,c.expect_followup?{name:'followup',state:'FAILED',detail:`No llegó ningún seguimiento en ${elapsed} h sin respuesta.`}:{name:'followup',state:'SKIPPED',detail:'La variante no tiene seguimientos activos.'});
  return done();
 }
 checks=set(checks,{name:pending(c),state:'UNKNOWN',detail:'Paso desconocido.'});return done();
}
function deliveryStep(c:SuiteCase,t:SuiteEntry[],waiting:string|null,checks:SuiteCheck[]):SuiteDecision{
 if(waiting==='simulation_continue')return{action:{type:'continue'},phase:'DELIVERY',checks};
 const approved=t.map((e,i)=>({e,i})).filter(x=>x.e.kind==='receipt'&&x.e.status==='APPROVED').at(-1)?.i??-1;
 const delivered=t.slice(approved+1).some(e=>e.from==='business'&&(!!e.material||(e.explanation??'').startsWith('Entrega')));
 const next=[...checks.filter(x=>x.name!=='delivery'),delivered?{name:'delivery' as const,state:'PASSED' as const,detail:'Se entregó lo comprado (simulado).'}:{name:'delivery' as const,state:'FAILED' as const,detail:'No se entregó lo comprado después de aprobar el pago.'}];
 if(!delivered)return{done:finishSuiteCase(c.journey,next),checks:next,phase:'DELIVERY'};
 return{action:{type:'advance',hours:24},phase:'EXCLUSION',checks:next};
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
