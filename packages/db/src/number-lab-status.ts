/** V7.5.2 T01: what the latest «Probar número» of a number can honestly claim.
 *
 * Success needs a terminal result with real coverage: the automatic buyer's
 * suite finished and every case (both journeys of every variant it captured)
 * passed its required checks. Anything still queued or executing is «En curso»;
 * an operation left INTENT/UNKNOWN without a receipt is «Por conciliar»; a suite
 * that ended without covering every check is «Incompleta». Pending is never
 * shown as failed, and a manual (conversed) test never claims a verdict.
 * Read only: no operation is retried, settled or created here. */
export type NumberTestState='IN_PROGRESS'|'UNCERTAIN'|'INCOMPLETE'|'FAILED'|'PASSED'|'MANUAL';
export const numberTestStateLabels:Record<NumberTestState,string>={
 IN_PROGRESS:'En curso',UNCERTAIN:'Por conciliar: un paso quedó sin resultado',INCOMPLETE:'Incompleta: no cubrió todos los pasos',
 FAILED:'Con fallas',PASSED:'Aprobada',MANUAL:'Prueba conversada, sin veredicto automático'};
/** Same bound as the worker's reconciliation of a claim that never reached the engine. */
export const NUMBER_TEST_STALE_INTENT_SECONDS=600;
type Executor={query(sql:string,params?:unknown[]):Promise<{rows:any[]}>};
const n=(v:unknown)=>Number(v??0);
export interface NumberTestStatus {at:string;run_id:string;suite_id:string|null;state:NumberTestState;label:string;
 /** true only when PASSED, false only when FAILED; null while pending, uncertain, incomplete or manual. */
 ok:boolean|null;
 operations:{total:number;queued:number;executing:number;uncertain:number;failed:number;applied:number};
 coverage:{cases:number;passed:number;failed:number;incomplete:number;running:number}|null}
export function classifyNumberTest(input:{suite:{state:string;cases:{state:string}[]}|null;runExpired:boolean;
 operations:NumberTestStatus['operations']}):NumberTestState{
 const o=input.operations,uncertain=o.uncertain>0,pending=o.queued>0||o.executing>0;
 if(input.suite){
  const cases=input.suite.cases,count=(state:string)=>cases.filter(c=>c.state===state).length;
  if(count('FAILED'))return 'FAILED';
  if(count('RUNNING')&&input.suite.state==='RUNNING'&&!input.runExpired)return uncertain?'UNCERTAIN':'IN_PROGRESS';
  return cases.length>0&&count('PASSED')===cases.length&&!uncertain&&!pending?'PASSED':'INCOMPLETE';
 }
 return uncertain?'UNCERTAIN':pending?'IN_PROGRESS':'MANUAL';
}
export async function latestNumberTestStatus(c:Executor,workspaceId:string,accountId:string):Promise<NumberTestStatus|null>{
 const run=(await c.query(`SELECT r.id::text AS run_id,r.created_at,r.expires_at<=clock_timestamp() AS expired,sc.suite_id::text AS suite_id
  FROM commerce_number_lab.runs r LEFT JOIN commerce_number_lab.suite_cases sc ON sc.workspace_id=r.workspace_id AND sc.run_id=r.id
  WHERE r.workspace_id=$1 AND r.source_account_id=$2 ORDER BY r.created_at DESC,r.id LIMIT 1`,[workspaceId,accountId])).rows[0];
 if(!run)return null;
 const suite=run.suite_id?(await c.query('SELECT state FROM commerce_number_lab.suites WHERE workspace_id=$1 AND id=$2',[workspaceId,run.suite_id])).rows[0]:undefined;
 const cases=suite?(await c.query('SELECT run_id::text,state FROM commerce_number_lab.suite_cases WHERE workspace_id=$1 AND suite_id=$2',[workspaceId,run.suite_id])).rows as {run_id:string;state:string}[]:[];
 const runs=suite?cases.map(x=>x.run_id):[String(run.run_id)];
 const o=(await c.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE state='QUEUED')::int AS queued,
   count(*) FILTER(WHERE state='INTENT' AND intent_at>clock_timestamp()-make_interval(secs=>$3))::int AS executing,
   count(*) FILTER(WHERE state='UNKNOWN' OR (state='INTENT' AND intent_at<=clock_timestamp()-make_interval(secs=>$3)))::int AS uncertain,
   count(*) FILTER(WHERE state='FAILED')::int AS failed,count(*) FILTER(WHERE state='APPLIED')::int AS applied
  FROM commerce_number_lab.operations WHERE workspace_id=$1 AND run_id=ANY($2::uuid[])`,[workspaceId,runs,NUMBER_TEST_STALE_INTENT_SECONDS])).rows[0];
 const operations={total:n(o.total),queued:n(o.queued),executing:n(o.executing),uncertain:n(o.uncertain),failed:n(o.failed),applied:n(o.applied)};
 // A manual test nobody acted on is not a test yet (same as before V7.5.2).
 if(!suite&&operations.total===0)return null;
 const state=classifyNumberTest({suite:suite?{state:String(suite.state),cases}:null,runExpired:run.expired===true,operations});
 const count=(s:string)=>cases.filter(x=>x.state===s).length;
 return{at:new Date(run.created_at).toISOString(),run_id:String(run.run_id),suite_id:run.suite_id?String(run.suite_id):null,state,label:numberTestStateLabels[state],
  ok:state==='PASSED'?true:state==='FAILED'?false:null,operations,
  coverage:suite?{cases:cases.length,passed:count('PASSED'),failed:count('FAILED'),incomplete:count('PARTIAL'),running:count('RUNNING')}:null};
}
