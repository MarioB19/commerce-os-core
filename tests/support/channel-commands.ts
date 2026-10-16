import {randomUUID} from 'node:crypto';
import {pool,putRecord,withTransaction,type QueryExecutor} from '../../packages/db/src/index.js';
import type {Body} from '../../packages/contracts/src/index.js';
import {retireRealAccountOn} from './profile-fixture.js';

/** V7 F8-D test fixture: queues one channel lifecycle command with the same
 * session/pause effects the retired V5 /v1/channel-accounts/:id/commands route
 * applied. In production these commands come from the V7 number journey
 * (link, unlink, removal) and from operator scripts with the owner connection;
 * worker tests keep exercising the channel worker through this fixture. */
export type ChannelCommandType='connect'|'disconnect'|'logout'|'restart'|'freeze'|'resume'|'check_health'|'transfer_ownership';
export async function queueChannelCommand(account:{id:string;workspace_id:string;environment:string},type:ChannelCommandType,extra:Body={},actor='synthetic-operator',client?:QueryExecutor){
 const run=async(c:QueryExecutor)=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+account.id]);
  if(['disconnect','logout','restart','freeze','transfer_ownership'].includes(type))await c.query(`INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'channel_account',$2,true,$3,$4)
   ON CONFLICT(workspace_id,scope_type,scope_id) DO UPDATE SET paused=true,version=manual_controls.version+1,reason=EXCLUDED.reason,actor_id=EXCLUDED.actor_id`,[account.workspace_id,account.id,String(extra.reason??type),actor]);
  if(['connect','restart','disconnect','logout','freeze'].includes(type))await c.query(`UPDATE channel_sessions SET desired_state=$2,operational_pause=CASE WHEN $3 THEN true ELSE operational_pause END,revision=revision+1,updated_at=now() WHERE account_id=$1`,
   [account.id,['connect','restart'].includes(type)?'RUNNING':'STOPPED',['disconnect','logout','freeze'].includes(type)]);
  return (await c.query(`INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,$2,'channel_command',$3,$4,$5,$6) RETURNING *`,
   [account.workspace_id,account.environment,account.id,actor,{type,...extra},randomUUID()])).rows[0] as Body;
 };
 return client?run(client):withTransaction(run);
}
export const channelCommandRow=async(id:string)=>(await pool.query('SELECT * FROM commands WHERE id=$1',[id])).rows[0] as Body;

/** A number retired before V7 (V5 deletion): tombstoned with its history and,
 * unlike the V7 removal, without releasing its capacity slot, so the platform
 * capacity drain/release flows stay exercised for historical slots. REAL
 * numbers retire through the quota path (paused, stopped, then deleted). */
export async function retireLegacyNumber(workspace:string,id:string){
 return withTransaction(async c=>{
  const row=(await c.query("SELECT * FROM records WHERE id=$1 AND workspace_id=$2 AND kind='channel_account' FOR UPDATE",[id,workspace])).rows[0];
  if(row.environment==='REAL')return retireRealAccountOn(c,workspace,id);
  await c.query('UPDATE session_ownership SET frozen=true,updated_at=now() WHERE workspace_id=$1 AND account_id=$2',[workspace,id]);
  await putRecord(c,{id,workspaceId:workspace,environment:row.environment,kind:'channel_account',version:row.version,body:{...row.body,deleted_at:new Date().toISOString(),deleted_by:'synthetic-v5-retirement',sending_enabled:false,active_authorization_id:null,identity_verified:false}});
 });
}

/** A scoped service token as a fixture (the V5 owner creation route was
 * retired; capacity agents receive theirs from /v2/platform/capacity). */
export async function issueServiceToken(workspace:string,name:string,scopes:string[],environments:string[]=['REAL']){
 const {randomBytes}=await import('node:crypto');const {hash}=await import('../../packages/db/src/index.js');
 const token=randomBytes(24).toString('hex');
 await pool.query("INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,allowed_environments,expires_at) VALUES($1,'synthetic-fixture',$2,$3,$4,$5,now()+interval '1 hour')",[workspace,name,hash(token),JSON.stringify(scopes),JSON.stringify(environments)]);
 return token;
}
