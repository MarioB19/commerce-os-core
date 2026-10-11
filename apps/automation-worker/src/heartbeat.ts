import {query,withTransaction,putRecord} from '@commerce/db';
import type {AutomationProgress} from './loop-monitor.js';

export async function persistAutomationHeartbeat(instance:string,progress:AutomationProgress){
 const scopes=(await query("SELECT DISTINCT workspace_id,environment FROM records WHERE kind='channel_account' AND NOT(body?'deleted_at')")).rows;
 for(const scope of scopes)await withTransaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`automation-heartbeat:${scope.workspace_id}:${scope.environment}:${instance}`]);
  const previous=(await c.query("SELECT id,version FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='service_heartbeat' AND body->>'service'='automation-worker' AND body->>'instance'=$3 ORDER BY updated_at DESC LIMIT 1",[scope.workspace_id,scope.environment,instance])).rows[0];
  const now=new Date();
  await putRecord(c,{id:previous?.id,version:previous?.version,workspaceId:scope.workspace_id,environment:scope.environment,kind:'service_heartbeat',body:{service:'automation-worker',instance,status:progress.ready?'OK':'BLOCKED',observed_at:now.toISOString(),expires_at:new Date(now.getTime()+45_000).toISOString(),source:'AUTOMATION_LOOP_PROGRESS',code:progress.code,loops:progress.loops}});
 });
}
