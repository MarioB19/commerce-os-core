import type {QueryExecutor} from '@commerce/db';
import {readOperationalSettings} from '@commerce/db';
import {fail} from './context.js';

/** Capacity changes never infer remote logout, cancel work or transfer ownership. */
export async function assertCapacityAccountQuiet(c:QueryExecutor,workspace:string,environment:string,accountId:string,{retired,expectedAccountVersion,expectedSessionVersion}:{retired?:boolean;expectedAccountVersion?:number;expectedSessionVersion?:number|null}={}){
 const locked=(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired',['channel-command:'+accountId])).rows[0];
 if(!locked.acquired)throw fail(409,'CHANNEL_COMMAND_PENDING');
 const account=(await c.query("SELECT * FROM records WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND kind='channel_account' FOR UPDATE",[accountId,workspace,environment])).rows[0];
 if(!account)throw fail(409,'CAPACITY_ACCOUNT_BINDING_CHANGED');
 if(expectedAccountVersion!==undefined&&account.version!==expectedAccountVersion)throw fail(409,'VERSION_CONFLICT');
 if(retired&&!account.body.deleted_at)throw fail(409,'RETIRE_ACCOUNT_BEFORE_RELEASE');
 if(retired===false&&account.body.deleted_at)throw fail(410,'CHANNEL_ACCOUNT_DELETED');
 if(account.body.sending_enabled===true)throw fail(409,'STOP_AND_ISOLATE_BEFORE_DRAIN');
 const session=(await c.query('SELECT * FROM channel_sessions WHERE account_id=$1 AND workspace_id=$2 AND environment=$3 AND archived_at IS NULL FOR UPDATE',[accountId,workspace,environment])).rows[0];
 if(expectedSessionVersion!==undefined&&(session?.revision??null)!==expectedSessionVersion)throw fail(409,'SESSION_VERSION_CONFLICT');
 if(session&&(session.desired_state!=='STOPPED'||!session.operational_pause||session.recovery_enabled))throw fail(409,'STOP_AND_ISOLATE_BEFORE_DRAIN');
 const owner=(await c.query('SELECT * FROM session_ownership WHERE account_id=$1 AND workspace_id=$2 FOR UPDATE',[accountId,workspace])).rows[0];
 if(owner&&(!owner.frozen||new Date(owner.lease_expires_at).getTime()>Date.now()))throw fail(409,'OWNERSHIP_ISOLATION_REQUIRED');
 if((await c.query("SELECT 1 FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=$3 AND kind='channel_command' AND (status='PENDING' OR (status='FAILED' AND payload->>'type' IN('connect','restart','disconnect','logout') AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at'))) LIMIT 1",[workspace,environment,accountId])).rowCount)throw fail(409,'RECONCILIATION_REQUIRED');
 if((await c.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND status IN('SENDING','UNKNOWN') LIMIT 1",[workspace,environment,accountId])).rowCount)throw fail(409,'RECONCILIATION_REQUIRED');
 if(environment==='REAL'){
  const policy=await readOperationalSettings(c,workspace,environment);
  if(!policy.body.dispatch_frozen||policy.body.real_sends_enabled||policy.body.allow_real_operations)throw fail(409,'REAL_FREEZE_REQUIRED');
 }
 return{account,session};
}

/** Root's immutable infrastructure receipt must survive another account reservation. */
export async function readVerifiedPhysicalProvision(c:QueryExecutor,operationId:string|null){
 if(!operationId)return null;
 return(await c.query("SELECT * FROM number_operations WHERE id=$1 AND environment='REAL' AND (action='PROVISION' OR (action='EXPAND' AND input->'apply'='true'::jsonb)) AND state='SUCCEEDED' AND result->>'outcome'='VERIFIED' AND result->'sessions_started'='0'::jsonb",[operationId])).rows[0]??null;
}
export async function verifiedPhysicalProvision(c:QueryExecutor,operationId:string|null){return !!await readVerifiedPhysicalProvision(c,operationId);}


/** Reserve/refresh only the target slots selected by the capacity route. */
export async function attachCapacityOperationSlots(c:QueryExecutor,workspace:string,environment:string,operationId:string,slots:number[]){
 const slotIds:string[]=[];
 for(const slot of slots){
  const existing=(await c.query("SELECT operation_id FROM number_capacity_slots WHERE workspace_id=$1 AND environment=$2 AND host_ref='primary' AND slot=$3",[workspace,environment,slot])).rows[0];
  const keepPhysical=await verifiedPhysicalProvision(c,existing?.operation_id??null);
  const changed=await c.query("INSERT INTO number_capacity_slots(workspace_id,environment,slot,operation_id) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,environment,host_ref,slot) DO UPDATE SET operation_id=CASE WHEN $5 THEN number_capacity_slots.operation_id ELSE EXCLUDED.operation_id END,version=number_capacity_slots.version+1 WHERE (COALESCE((number_capacity_slots.readback->>'verified')::boolean,false)=false OR COALESCE((number_capacity_slots.readback->>'observed_at')::timestamptz,'epoch'::timestamptz)<=now()-interval '60 seconds') AND number_capacity_slots.state IN('AVAILABLE','RESERVED','PREPARED') RETURNING id",[workspace,environment,slot,operationId,keepPhysical]);
  slotIds.push(...changed.rows.map(row=>row.id));
 }
 await c.query("UPDATE number_operations SET input=input||$2::jsonb WHERE id=$1 AND workspace_id=$3 AND environment=$4",[operationId,{slot_ids:slotIds},workspace,environment]);
 return slotIds;
}
