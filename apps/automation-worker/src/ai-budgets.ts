import {pool,withTransaction} from '@commerce/db';

/** V7 F4: keeps each profile's monthly AI budget open across month boundaries
 * from the owner's configured limit (open_ai_budget_periods). At most once an
 * hour per process; a profile without a configured limit is left untouched. */
let lastRun=0;
export async function openAiBudgets(now=Date.now()){
 if(now-lastRun<3_600_000)return 0;lastRun=now;
 const scopes=(await pool.query("SELECT workspace_id,environment FROM ai_budget_scopes()")).rows as {workspace_id:string;environment:string}[];
 let opened=0;
 for(const s of scopes)opened+=await withTransaction(async c=>{
  await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment',$2,true)",[s.workspace_id,s.environment]);
  return Number((await c.query('SELECT open_ai_budget_periods($1,$2) AS n',[s.workspace_id,s.environment])).rows[0].n);
 }).catch(()=>0);
 return opened;
}
export function resetAiBudgetCadenceForTests(){lastRun=0;}
