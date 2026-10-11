import {readOperationalSettings,type QueryExecutor} from '@commerce/db';
import type {Body} from '@commerce/contracts';
/** A timeout never frees a claim. Only a known outbox result releases admission. */
export async function reserveDispatchCapacity(c:QueryExecutor,effect:Body,owner:string){
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[effect.environment==='REAL'?'channel-host-admission':`simulation-admission:${effect.workspace_id}`]);
 if((await c.query("SELECT 1 FROM number_capacity_slots WHERE account_id=$1 AND state IN('DRAINING','ERROR','UNKNOWN')",[effect.account_id])).rowCount)return false;
 await c.query("UPDATE number_dispatch_slots s SET released_at=now() FROM outbox o WHERE o.id=s.effect_id AND s.released_at IS NULL AND o.status NOT IN('SENDING','UNKNOWN')");
 const settings=await readOperationalSettings(c,effect.workspace_id,effect.environment);
 const hostLimit=Math.min(20,Math.max(1,Number(process.env.CHANNEL_HOST_CONCURRENCY??10)||10));
 const active=(await c.query("SELECT s.workspace_id,s.environment,o.account_id FROM number_dispatch_slots s JOIN outbox o ON o.id=s.effect_id WHERE s.released_at IS NULL AND s.environment=$1 AND ($1='REAL' OR s.workspace_id=$2)",[effect.environment,effect.workspace_id])).rows;
 if(active.length>=hostLimit||active.some(s=>s.account_id===effect.account_id)||active.filter(s=>s.workspace_id===effect.workspace_id&&s.environment===effect.environment).length>=settings.body.channel_account_concurrency)return false;
 await c.query('INSERT INTO number_dispatch_slots(workspace_id,environment,effect_id,owner_id) VALUES($1,$2,$3,$4) ON CONFLICT(effect_id) DO UPDATE SET released_at=NULL,reserved_at=now(),owner_id=EXCLUDED.owner_id',[effect.workspace_id,effect.environment,effect.id,owner]);return true;
}
