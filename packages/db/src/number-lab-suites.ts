import {createHash} from 'node:crypto';
import {z} from 'zod';
import {withProfileTransaction,type ProfileExecutor,type ProfilePool} from './profile-context.js';
import {currentProfileExecutor} from './profile-query-routing.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';
import {labHash} from '../../domain/src/laboratory/number-lab.js';
import {nextSuiteStep,finishSuiteCase,variantVerdict,verdictLabels,type SuiteCase,type SuiteCheck,type SuiteJourney,type SuiteLastStep} from '../../domain/src/laboratory/automatic-buyer.js';
import {openLabValue,sealLabValue} from './number-laboratory.js';

/** V7 RF-19.p/h: suites of the automatic buyer (control store, profile RLS). */
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function need(ok:unknown,code:string):asserts ok{if(!ok)throw Error(code);}
const iso=(v:unknown)=>v?new Date(v instanceof Date?v.getTime():String(v)).toISOString():null;
/** Stable ids derived from the suite's start key: a lost response replays the same suite and runs. */
export function suiteDerivedId(...parts:string[]){const h=createHash('sha256').update(['commerce.number-lab.suite.v1',...parts].join('\0')).digest('hex');
 return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);}
async function authorize(db:ProfileExecutor,a:ProfileAuthority,write:boolean){const now=new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now);authorizeProfileAction(a,{scope:write?'tests:run':'tests:read',workspaceId:db.workspaceId,mutation:write},now);}

export async function readSuiteByStart(db:ProfileExecutor,a:ProfileAuthority,operationId:string){await authorize(db,a,true);need(uuid.test(operationId),'LAB_SUITE_ID');
 const r=(await db.query('SELECT id::text FROM commerce_number_lab.suites WHERE workspace_id=$1 AND start_operation_id=$2',[db.workspaceId,operationId])).rows[0];return r?String(r.id):null;}
export async function insertSuite(db:ProfileExecutor,a:ProfileAuthority,input:{id:string;account_id:string;operation_id:string;maximum_microusd:number}){await authorize(db,a,true);
 await db.query('INSERT INTO commerce_number_lab.suites(workspace_id,id,account_id,actor_id,start_operation_id,maximum_microusd) VALUES($1,$2,$3,$4,$5,$6)',[db.workspaceId,input.id,input.account_id,a.membership.userId,input.operation_id,input.maximum_microusd]);}
export async function insertSuiteCase(db:ProfileExecutor,input:{suite_id:string;run_id:string;variant_id:string;journey:SuiteJourney;expect_followup:boolean;attachment_id:string|null}){
 await db.query('INSERT INTO commerce_number_lab.suite_cases(workspace_id,suite_id,run_id,variant_id,journey,expect_followup,attachment_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[db.workspaceId,input.suite_id,input.run_id,input.variant_id,input.journey,input.expect_followup,input.attachment_id]);}
export async function latestSuiteId(db:ProfileExecutor,a:ProfileAuthority,accountId:string){await authorize(db,a,false);need(uuid.test(accountId),'LAB_ACCOUNT_ID');
 const r=(await db.query('SELECT s.id::text FROM commerce_number_lab.suites s WHERE s.workspace_id=$1 AND s.account_id=$2 AND EXISTS(SELECT 1 FROM commerce_number_lab.suite_cases c JOIN commerce_number_lab.runs r ON r.workspace_id=c.workspace_id AND r.id=c.run_id WHERE c.workspace_id=s.workspace_id AND c.suite_id=s.id AND r.expires_at>clock_timestamp()) ORDER BY s.created_at DESC,s.id LIMIT 1',[db.workspaceId,accountId])).rows[0];return r?String(r.id):null;}
const checkLabels:Record<string,string>={route:'Llega a la variante',offer:'Presenta la oferta',collection:'Da los datos de pago',receipt:'Lee el comprobante',delivery:'Entrega lo comprado',exclusion:'No sigue insistiendo después de comprar',followup:'Da seguimiento si el cliente no responde'};
const caseLabels:Record<string,string>={RUNNING:'En curso',PASSED:'Bien',FAILED:'Falló',PARTIAL:'Incompleto'};
const journeyLabels:Record<SuiteJourney,string>={PURCHASE:'Cliente que compra',FOLLOWUP:'Cliente que no responde'};
/** RF-19.h: the suite report, one verdict per variant with each journey's checks. */
export async function readSuiteReport(db:ProfileExecutor,a:ProfileAuthority,suiteId:string,names:(ids:string[])=>Promise<Record<string,string>>){await authorize(db,a,false);need(uuid.test(suiteId),'LAB_SUITE_ID');
 const s=(await db.query('SELECT * FROM commerce_number_lab.suites WHERE workspace_id=$1 AND id=$2',[db.workspaceId,suiteId])).rows[0];if(!s)return null;
 const cases=(await db.query('SELECT c.*,r.expires_at FROM commerce_number_lab.suite_cases c JOIN commerce_number_lab.runs r ON r.workspace_id=c.workspace_id AND r.id=c.run_id WHERE c.workspace_id=$1 AND c.suite_id=$2 ORDER BY c.variant_id,c.journey DESC',[db.workspaceId,suiteId])).rows;
 const variantIds=[...new Set(cases.map(c=>String(c.variant_id)))],label=await names(variantIds);
 const variants=variantIds.map(variantId=>{const own=cases.filter(c=>String(c.variant_id)===variantId),verdict=variantVerdict(own.map(c=>({journey:c.journey,state:c.state})));
  return{variant_id:variantId,name:label[variantId]??'Variante',verdict,verdict_label:verdictLabels[verdict],
   cases:own.map(c=>({journey:c.journey as SuiteJourney,journey_label:journeyLabels[c.journey as SuiteJourney],run_id:String(c.run_id),state:String(c.state),state_label:caseLabels[c.state]??c.state,steps:Number(c.steps),
    checks:(c.checks as SuiteCheck[]).map(k=>({...k,label:checkLabels[k.name]??k.name})),expired:Date.parse(String(iso(c.expires_at)))<=Date.now()}))};});
 const state=String(s.state);
 return{suite:{suite_id:String(s.id),account_id:String(s.account_id),state,state_label:{RUNNING:'En curso',COMPLETED:'Terminada',STOPPED:'Detenida'}[state]??state,
   created_at:iso(s.created_at),completed_at:iso(s.completed_at),maximum_microusd:Number(s.maximum_microusd)},
  variants,summary:{responde_bien:variants.filter(v=>v.verdict==='RESPONDE_BIEN').length,fallo:variants.filter(v=>v.verdict==='FALLO').length,incompleto:variants.filter(v=>v.verdict==='INCOMPLETO').length,en_curso:variants.filter(v=>v.verdict==='EN_CURSO').length},
  note:'Cada variante se prueba con dos clientes simulados: uno que compra (saludo, oferta, cobro, comprobante, entrega y sin seguimientos después de comprar) y uno que no responde (seguimientos). «Responde bien» exige que todos los pasos pasen.'};
}

// ------------------------------------------------------------------ worker
const lastResultSchema=z.object({schema_version:z.literal(1),run_state:z.string(),result:z.unknown()}).passthrough();
/** One pass of the automatic buyer (laboratory worker, control role): for each
 * due case, read what its last step showed, record the checks and queue the
 * next scripted step under the suite's authority. Never executes a step. */
export async function advanceNumberLabSuites(pool:ProfilePool,key:Uint8Array,limit=10){
 need(!currentProfileExecutor(),'LAB_SUITE_OUTER_TRANSACTION');need(key.length===32,'LAB_CIPHER_KEY');
 let due:{workspace_id:string;suite_id:string;run_id:string}[]=[];
 const c=await pool.connect();try{due=(await c.query('SELECT workspace_id,suite_id::text,run_id::text FROM commerce_number_lab.active_suite_cases($1)',[limit])).rows as typeof due;}finally{c.release();}
 let advanced=0;
 for(const d of due){
  await withProfileTransaction(pool,d.workspace_id,async db=>{
   const row=(await db.query('SELECT c.*,s.actor_id,s.state AS suite_state FROM commerce_number_lab.suite_cases c JOIN commerce_number_lab.suites s ON s.workspace_id=c.workspace_id AND s.id=c.suite_id WHERE c.workspace_id=$1 AND c.suite_id=$2 AND c.run_id=$3 FOR UPDATE OF c',[d.workspace_id,d.suite_id,d.run_id])).rows[0];
   if(!row||row.state!=='RUNNING'||row.suite_state!=='RUNNING')return;
   const run=(await db.query('SELECT version,expires_at FROM commerce_number_lab.runs WHERE workspace_id=$1 AND id=$2',[d.workspace_id,d.run_id])).rows[0];need(run,'LAB_SUITE_RUN_MISSING');
   const op=(await db.query('SELECT * FROM commerce_number_lab.operations WHERE workspace_id=$1 AND run_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[d.workspace_id,d.run_id])).rows[0];
   if(op&&['QUEUED','INTENT'].includes(op.state))return;
   let last:SuiteLastStep|null=null;
   if(op){const v=lastResultSchema.parse(openLabValue({workspaceId:d.workspace_id,runId:d.run_id,purpose:'result',operationId:String(op.id)},op.result_ciphertext,key));last={state:op.state,result:(v.result??null) as SuiteLastStep['result']};}
   const current:SuiteCase={journey:row.journey,variant_id:String(row.variant_id),phase:String(row.phase),steps:Number(row.steps),checks:row.checks as SuiteCheck[],expect_followup:!!row.expect_followup,attachment_id:row.attachment_id?String(row.attachment_id):null};
   const decision=nextSuiteStep(current,last);
   if('action' in decision){
    const operationId=suiteDerivedId('step',d.run_id,String(current.steps)),expected=Number(run.version);
    const input={operation_id:operationId,expected_version:expected,action:decision.action},request=labHash({runId:d.run_id,input,actor_id:String(row.actor_id)});
    await db.query('SELECT commerce_number_lab.enqueue_suite_step($1,$2,$3,$4,$5,$6,$7)',[d.workspace_id,d.suite_id,d.run_id,operationId,expected,request,sealLabValue({workspaceId:d.workspace_id,runId:d.run_id,purpose:'action',operationId},decision.action,key)]);
    await db.query('UPDATE commerce_number_lab.suite_cases SET phase=$4,steps=steps+1,checks=$5,updated_at=clock_timestamp() WHERE workspace_id=$1 AND suite_id=$2 AND run_id=$3',[d.workspace_id,d.suite_id,d.run_id,decision.phase,JSON.stringify(decision.checks)]);
   }else{
    await db.query('UPDATE commerce_number_lab.suite_cases SET state=$4,phase=$5,checks=$6,updated_at=clock_timestamp() WHERE workspace_id=$1 AND suite_id=$2 AND run_id=$3',[d.workspace_id,d.suite_id,d.run_id,decision.done,decision.phase,JSON.stringify(decision.checks)]);
    const open=(await db.query("SELECT count(*)::int n FROM commerce_number_lab.suite_cases WHERE workspace_id=$1 AND suite_id=$2 AND state='RUNNING'",[d.workspace_id,d.suite_id])).rows[0].n;
    if(!open)await db.query("UPDATE commerce_number_lab.suites SET state='COMPLETED',completed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND state='RUNNING'",[d.workspace_id,d.suite_id]);
   }
   advanced++;
  });
 }
 return advanced;
}
export {finishSuiteCase};
