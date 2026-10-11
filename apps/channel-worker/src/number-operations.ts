import {randomUUID} from 'node:crypto';
import {pool,withTransaction,getRecord,putRecord,encrypt,hash,appendEvent,readOperationalSettings} from '@commerce/db';
import {providerFor,type ProviderFactory} from './providers.js';
import {observeGroup} from '../../../packages/db/src/warmup-groups.js';
import {numberNow} from '../../../packages/db/src/number-clock.js';
import {observeChannelSession} from '../../../packages/db/src/channel-sessions.js';
import {CAPACITY_READBACK_TTL_MS} from '../../../packages/contracts/src/numbers.js';
import type {DomainRecord} from '../../../packages/contracts/src/index.js';
/** Durable jobs; an expired mutating claim remains UNKNOWN until readback. */
export async function processNumberOperations(owner='number-operations',factory:ProviderFactory=providerFor){
 owner=owner+':'+randomUUID();
 await pool.query("UPDATE number_operations SET state='UNKNOWN',version=version+1,result=result||jsonb_build_object('reason','LEASE_EXPIRED_RECONCILE_SAME_OPERATION') WHERE state='PREPARING' AND lease_until<now()");
 const ids=(await pool.query("SELECT id,workspace_id,environment FROM number_operations WHERE state IN('REQUESTED','RESERVED') ORDER BY created_at LIMIT 20")).rows;
 let processed=0;
 for(const candidate of ids){const {id}=candidate;const op=await withTransaction(async c=>{if(candidate.environment==='REAL'&&(await readOperationalSettings(c,candidate.workspace_id,'REAL',{lock:'share'})).release_hold)return;return(await c.query("UPDATE number_operations SET state='PREPARING',lease_owner=$2,lease_until=now()+interval '2 minutes',version=version+1 WHERE id=$1 AND state IN('REQUESTED','RESERVED') RETURNING *",[id,owner])).rows[0];});if(!op)continue;
  try{
   if(op.action==='EXPAND'&&!op.input.apply){await withTransaction(async c=>{await assertClaim(c,id,owner);await c.query("UPDATE number_capacity_slots SET state=CASE WHEN account_id IS NULL THEN 'PREPARED' ELSE state END,version=version+1 WHERE operation_id=$1",[id]);await c.query("UPDATE number_operations SET state='SUCCEEDED',result=$2,lease_until=NULL,version=version+1 WHERE id=$1 AND lease_owner=$3",[id,{prepared_slots:op.input.count,physical_provisioning:false,installed:false,sessions_started:0,next_action:'REVIEW_AND_EXPAND_CAPACITY'},owner]);});processed++;continue;}
   if(['PROVISION','EXPAND','DRAIN'].includes(op.action)&&op.environment==='REAL'){
    await pool.query("UPDATE number_operations SET state='HUMAN_ACTION_REQUIRED',result=$2,lease_until=NULL,version=version+1 WHERE id=$1 AND lease_owner=$3 AND state='PREPARING' AND lease_until>now()",[id,{reason:'BOUNDED_ADMINISTRATOR_REQUIRED',next_action:'APPLY_REVIEWED_CAPACITY',no_session_started:true},owner]);continue;
   }
   if(op.action==='GROUP_REFRESH'){
    const checkpoint=op.result?.checkpoint??{account:0,offset:0,index:0},observed=op.result?.observed??[];
    const deadline=Date.now()+45000;let reads=0;
    while(checkpoint.account<op.input.account_ids.length&&reads<16&&Date.now()<deadline){
     const accountId=op.input.account_ids[checkpoint.account],account=await getRecord(pool,op.workspace_id,'channel_account',accountId);
     if(!account||account.environment!==op.environment)throw new Error('ACCOUNT_SCOPE_INVALID');
     const page=await providerRead(account,factory,async provider=>{if(!provider.listGroups||!provider.group)throw new Error('GROUP_PROVIDER_UNSUPPORTED');return provider.listGroups({offset:checkpoint.offset,limit:20});});reads++;
     while(checkpoint.index<page.groups.length&&reads<16&&Date.now()<deadline){
      const snapshot=await providerRead(account,factory,async provider=>{if(!provider.group)throw new Error('GROUP_PROVIDER_UNSUPPORTED');return provider.group(page.groups[checkpoint.index]!.id);});reads++;
      await withTransaction(async c=>{await assertClaim(c,op.id,owner);const group=await observeGroup(c,account,snapshot,await numberNow(c,account.workspace_id,account.environment));observed.push({group_id:group.id,account_id:account.id,version:group.version});checkpoint.index++;await c.query('UPDATE number_operations SET result=$2,updated_at=now() WHERE id=$1',[id,{checkpoint,observed,source:'provider_read'}]);});
     }
     if(checkpoint.index<page.groups.length)break;
     if(page.hasMore){checkpoint.offset+=20;checkpoint.index=0;if(checkpoint.offset>=200)throw new Error('GROUP_PAGINATION_LIMIT');}
     else{checkpoint.account++;checkpoint.offset=0;checkpoint.index=0;}
    }
    await withTransaction(async c=>{await assertClaim(c,id,owner);await c.query("UPDATE number_operations SET state=$2,result=$3,version=version+1,lease_until=NULL,updated_at=now() WHERE id=$1",[id,checkpoint.account===op.input.account_ids.length?'SUCCEEDED':'REQUESTED',{checkpoint,observed,source:'provider_read',next_action:checkpoint.account===op.input.account_ids.length?'READ_GROUPS':'READ_OPERATION'}]);});
   }else if(op.action==='IDENTITY_OBSERVE'){
    const account=await getRecord(pool,op.workspace_id,'channel_account',op.input.account_id);if(!account||account.environment!==op.environment)throw new Error('ACCOUNT_SCOPE_INVALID');const {profile,signals}=await providerRead(account,factory,async provider=>{if(!provider.profile)throw new Error('PROFILE_READ_UNSUPPORTED');const profile=await provider.profile(),signals=await provider.health();return{profile,signals};});const identity=signals.find(s=>s.dimension==='transport'&&s.status==='OK'&&(s.value as {identity_fingerprint?:string})?.identity_fingerprint===hash(profile.identity));if(!identity)throw new Error('IDENTITY_READ_NOT_CONFIRMED');
    await withTransaction(async c=>{await assertClaim(c,id,owner);const current=(await getRecord(c,op.workspace_id,'channel_account',account.id))!;if(current.body.identity_fingerprint&&current.body.identity_fingerprint!==hash(profile.identity))throw new Error('IDENTITY_CONFLICT');const session=(await c.query('SELECT desired_state FROM channel_sessions WHERE account_id=$1',[account.id])).rows[0];if(current.body.status==='WORKING'&&current.body.last_lifecycle_at&&session?.desired_state==='RUNNING')await observeChannelSession(c,current,signals,'number-identity-observe');await c.query('UPDATE channel_sessions SET observed_identity_ciphertext=$2,last_health_at=$3 WHERE account_id=$1',[account.id,encrypt(profile.identity),identity.observedAt]);const now=await numberNow(c,account.workspace_id,account.environment);await putRecord(c,{id:account.id,workspaceId:account.workspace_id,environment:account.environment,kind:account.kind,version:current.version,body:{...current.body,identity_verified:current.body.identity_verified===true,identity_fingerprint:hash(profile.identity),identity_conflict:false,status:'WORKING',health_checked_at:now.toISOString(),health_status:'OK',masked_number:'•••• '+profile.identity.replace(/\D/g,'').slice(-4)}});for(const s of signals)await putRecord(c,{workspaceId:account.workspace_id,environment:account.environment,kind:'health_signal',body:{account_id:account.id,dimension:s.dimension,status:s.status,value:s.value,source:s.source,scope:s.scope,observed_at:s.observedAt,expires_at:s.expiresAt}});await c.query("UPDATE number_operations SET state='SUCCEEDED',result=$2,version=version+1,lease_until=NULL WHERE id=$1",[id,{account_id:account.id,identity_observed:true,next_action:'CONFIRM_OWNERSHIP'}]);});
   }else if(op.environment==='SIMULATION'){
    await withTransaction(async c=>{await assertClaim(c,id,owner);const observedAt=await numberNow(c,op.workspace_id,op.environment),readback={verified:true,environment:'SIMULATION',adapter:'no-network',sessions_started:0,session_count:0,connected_sessions:0,observed_at:observedAt.toISOString(),expires_at:new Date(observedAt.getTime()+CAPACITY_READBACK_TTL_MS).toISOString()};if(op.action==='PROVISION'){const a=await getRecord(c,op.workspace_id,'channel_account',op.input.account_id);if(!a||a.environment!=='SIMULATION'||a.body.provider!=='simulator')throw new Error('SIMULATION_SCOPE_INVALID');await c.query("UPDATE number_capacity_slots SET state='QR_PENDING',readback=$2,version=version+1 WHERE id=$1 AND account_id=$3",[op.input.slot_id,readback,op.input.account_id]);}else if(op.action==='EXPAND'){const target=Number(op.input.effective_target);if(!Number.isInteger(target)||target<1||target>20)throw new Error('CAPACITY_TARGET_INVALID');const refreshed=await c.query("UPDATE number_capacity_slots SET state=CASE WHEN operation_id=$3 AND account_id IS NULL THEN 'PREPARED' ELSE state END,readback=$4,version=version+1 WHERE workspace_id=$1 AND environment=$2 AND host_ref='primary' AND slot BETWEEN 1 AND $5",[op.workspace_id,op.environment,id,readback,target]);if(refreshed.rowCount!==target)throw new Error('CAPACITY_TARGET_INCOMPLETE');}else if(op.action==='DRAIN')await c.query("UPDATE number_capacity_slots SET state='DRAINING',readback=$2,version=version+1 WHERE id=$1",[op.input.slot_id,readback]);await c.query("UPDATE number_operations SET state='SUCCEEDED',result=$2,version=version+1,lease_until=NULL WHERE id=$1",[id,{external_effects:0,simulation:true,next_action:op.action==='PROVISION'?'CONNECT_AND_VERIFY':'READ_CAPACITY'}]);});
   }
   processed++;
  }catch(error){await pool.query("UPDATE number_operations SET state='FAILED',result=result||$2::jsonb,version=version+1,lease_until=NULL WHERE id=$1 AND lease_owner=$3 AND state='PREPARING' AND lease_until>now()",[id,{reason:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'OPERATION_FAILED',next_action:'REVIEW_OPERATION'},owner]);}
  await withTransaction(c=>appendEvent(c,{workspace_id:op.workspace_id,environment:op.environment,event_type:'number.operation_processed',aggregate_id:id,payload:{action:op.action}}));
 }
 return processed;
}

async function assertClaim(c:import('@commerce/db').QueryExecutor,id:string,owner:string){
 const claim=await c.query("SELECT id FROM number_operations WHERE id=$1 AND lease_owner=$2 AND state='PREPARING' AND lease_until>now() FOR UPDATE",[id,owner]);
 if(!claim.rowCount)throw new Error('OPERATION_CLAIM_LOST');
}

/** Root publication waits for all REAL provider reads, including queued number jobs. */
async function providerRead<T>(account:DomainRecord,factory:ProviderFactory,read:(provider:Awaited<ReturnType<ProviderFactory>>)=>Promise<T>):Promise<T>{
 const observe=async()=>read(await factory(account));
 if(account.environment!=='REAL')return observe();
 return withTransaction(async c=>{const policy=await readOperationalSettings(c,account.workspace_id,'REAL',{lock:'share'});if(policy.release_hold)throw new Error('RELEASE_HOLD_ACTIVE');return observe();});
}
