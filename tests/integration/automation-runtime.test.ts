import {describe,it,expect,afterAll,beforeAll} from 'vitest';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {randomUUID} from 'node:crypto';
import {pool,putRecord,withTransaction,getRecord,hash,stableJson} from '../../packages/db/src/index.js';
import {materializeMessage} from '../../apps/automation-worker/src/inbound.js';
import {processAgents} from '../../apps/automation-worker/src/agents.js';
import {advanceWorkflow,processTimers} from '../../apps/automation-worker/src/workflows.js';
import {applyCommand} from '../../apps/automation-worker/src/commands.js';
import {processCampaigns} from '../../apps/automation-worker/src/campaigns.js';
import {proposeEffect} from '../../apps/automation-worker/src/shared.js';
import {dispatchOutbox,acquireOwnership,recordHealth,recoverChannelCommands,processChannelCommands} from '../../apps/channel-worker/src/runtime.js';
import {SimulatorProvider} from '../../packages/messaging/src/index.js';
import type {SalesAiProvider,AgentResult} from '../../packages/domain/src/sales/ai.js';
import {chatLock} from '../../packages/db/src/commercial-assignments.js';
const workspace='automation-'+randomUUID(),owner='automation-test-owner';
// V7 F2: fixture workspaces are adopted profiles (max three per installation).
const lifecyclePeerWorkspace='automation-lifecycle-peer-'+randomUUID();
beforeAll(()=>fixtureProfiles(workspace,lifecyclePeerWorkspace));
afterAll(async()=>pool.end());
async function fixture(){const product=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'product',body:{name:'Fixture product'}});const offer=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'offer',body:{product_id:product.id,base_amount_minor:9900,currency:'MXN',status:'PUBLISHED',fulfillment:[],billing_delay_seconds:30}});const account=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Fixture account',provider:'simulator',status:'WORKING'}});const contact=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'contact',body:{name:'Fixture contact',identity:'opaque:'+randomUUID(),status:'LEAD',consent:{purpose:'messages',source:'fixture',evidence:'local explicit consent fixture',observed_at:new Date().toISOString()}}});const conversation=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:{account_id:account.id,contact_id:contact.id,offer_version_id:offer.id,status:'OPEN',stage:'NEW',sequence:1,last_customer_text:'Información',last_inbound_at:new Date().toISOString(),ai_pending:false}});return{product,offer,account,contact,conversation};}
const aiResult:AgentResult={proposal:{reply:'Grounded fixture reply',intent:'question',confidence:1,tool:'none',grounding:['offer_snapshot']},usage:{input_tokens:5,output_tokens:5,cost_minor:0},provider:'deterministic',model:'fixture'};
describe('Automation durable controls with real PostgreSQL',()=>{
 for(const control of ['takeover','suppressed']as const)it(`discards AI response when ${control} changes during external call`,async()=>{
  const f=await fixture();
  // UUID numeric groups can be redacted by the real seller sanitizer. Use an
  // alphabetic marker so this handshake always identifies the target request.
  const marker='midcall-'+f.conversation.id.replace(/[0-9]/g,digit=>String.fromCharCode(107+Number(digit)));
  await pool.query(`UPDATE records SET body=body||jsonb_build_object('ai_pending',true,'last_customer_text',$2::text),version=version+1 WHERE id=$1`,[f.conversation.id,marker]);
  if(control==='takeover'){
   // Reproduce a full earlier batch in the shared integration database. These
   // review-only fixtures are consumed without producing replies or orders.
   await pool.query(`INSERT INTO records(workspace_id,environment,kind,body,updated_at) SELECT $1,'SIMULATION','conversation',$2::jsonb,'2000-01-01T00:00:00Z' FROM generate_series(1,100)`,[workspace,JSON.stringify({account_id:f.account.id,contact_id:f.contact.id,ai_pending:true,ai_status:'HUMAN_REVIEW',last_customer_text:'Earlier review fixture',fixture_midcall_backlog:true})]);
  }
  const queued=Number((await pool.query("SELECT count(*)::int n FROM records WHERE kind='conversation' AND body->>'ai_pending'='true' AND body->>'last_customer_text' IS NOT NULL")).rows[0].n),batchLimit=Math.ceil(queued/100)+1;
  let entered!:()=>void,release!:(r:AgentResult)=>void,enteredTarget=false,batches=0;
  const started=new Promise<void>(resolve=>{entered=resolve}),pending=new Promise<AgentResult>(resolve=>{release=resolve});
  const provider:SalesAiProvider={propose:async(_agent,context)=>{if(context.customer_text!==marker)return aiResult;enteredTarget=true;entered();return pending;},receipt:async()=>{throw new Error('unused');}};
  let running:Promise<number>|undefined;
  try{
   for(;batches<batchLimit;){
    batches++;running=processAgents(100,provider);
    // A batch may finish before reaching our target. Keep advancing persisted
    // work; never wait indefinitely for a callback excluded by its LIMIT.
    const reached=await Promise.race([started.then(()=>true),running.then(()=>false)]);
    if(reached)break;
    running=undefined;
   }
   expect(enteredTarget,`Target AI call not reached after ${batches}/${batchLimit} batches from ${queued} pending candidates`).toBe(true);
   if(control==='takeover')expect(batches).toBeGreaterThan(1);
   await pool.query(`INSERT INTO manual_controls(workspace_id,scope_type,scope_id,${control},reason,actor_id) VALUES($1,$2,$3,true,'fixture midcall control','test')`,[workspace,control==='takeover'?'conversation':'contact',control==='takeover'?f.conversation.id:f.contact.id]);
  }finally{release(aiResult);if(running)await running;}
  const runs=(await pool.query(`SELECT body FROM records WHERE kind='ai_run' AND body->>'conversation_id'=$1`,[f.conversation.id])).rows;
  // The reviewed agent (V7) holds a run blocked by a manual control as
  // AWAITING_EFFECT/CONTROLS_BLOCKED instead of discarding it; no effect exists.
  expect(runs).toHaveLength(1);expect(runs[0].body).toMatchObject({status:'AWAITING_EFFECT',effect_proposal_block:'CONTROLS_BLOCKED'});
  expect(Number((await pool.query('SELECT count(*) FROM outbox WHERE conversation_id=$1',[f.conversation.id])).rows[0].count)).toBe(0);
 });
 it('persistent wait resumes once after virtual advancement and repeated worker calls',async()=>{const f=await fixture();const workflow=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'workflow',body:{name:'Persistent fixture wait',status:'PUBLISHED',entry_node_id:'wait',nodes:[{id:'wait',type:'wait',config:{seconds:30},next:'message'},{id:'message',type:'message',config:{text:'After durable wait'},next:'end'},{id:'end',type:'end',config:{}}]}});const sim=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'simulation',body:{status:'RUNNING',virtual_now:new Date(Date.now()+60000).toISOString()}});await pool.query('UPDATE records SET body=body||$2::jsonb,version=version+1 WHERE id=$1',[f.conversation.id,JSON.stringify({workflow_version_id:workflow.id,simulation_id:sim.id})]);await withTransaction(async c=>advanceWorkflow(c,(await getRecord(c,workspace,'conversation',f.conversation.id))!));const timer=(await pool.query('SELECT * FROM timers WHERE conversation_id=$1',[f.conversation.id])).rows[0];expect(timer.status).toBe('PENDING');await processTimers(100);expect((await pool.query('SELECT status FROM timers WHERE id=$1',[timer.id])).rows[0].status).toBe('PENDING');await pool.query(`UPDATE records SET body=body||jsonb_build_object('virtual_now',$2::text),version=version+1 WHERE id=$1`,[sim.id,new Date(new Date(timer.due_at).getTime()+1000).toISOString()]);await processTimers(100);await processTimers(100);expect((await pool.query('SELECT status FROM timers WHERE id=$1',[timer.id])).rows[0].status).toBe('FIRED');expect(Number((await pool.query('SELECT count(*) FROM outbox WHERE conversation_id=$1',[f.conversation.id])).rows[0].count)).toBe(1);});
 it('cancelled campaign produces no effect and a changed approved snapshot pauses execution',async()=>{const f=await fixture();for(const cancel of [true,false]){const campaign=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'message_campaign',body:{name:'Campaign fixture',status:'DRAFT',account_id:f.account.id,offer_version_id:f.offer.id,message:'Original approved content',segment:{contact_ids:[f.contact.id]},max_recipients:1}});const configHash=hash(stableJson(campaign.body));const auth=(await pool.query(`INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at) VALUES($1,'SIMULATION','test',$2,$3,now()+interval '1 hour') RETURNING *`,[workspace,{campaign_id:campaign.id,account_ids:[f.account.id],max_messages:1,allow_automation:true},configHash])).rows[0];await withTransaction(c=>applyCommand(c,{id:randomUUID(),workspace_id:workspace,environment:'SIMULATION',resource_id:campaign.id,kind:'campaign_schedule',actor_id:'test',payload:{scheduled_at:new Date(Date.now()-1000).toISOString(),authorization_id:auth.id,config_hash:configHash,recipients:[{contact_id:f.contact.id,conversation_id:f.conversation.id}],expected_version:campaign.version}}));if(cancel)await withTransaction(c=>applyCommand(c,{id:randomUUID(),workspace_id:workspace,environment:'SIMULATION',resource_id:campaign.id,kind:'campaign_cancel',actor_id:'test',payload:{reason:'Fixture cancel'}}));else await pool.query(`UPDATE records SET body=body||'{"message":"Unapproved new content"}'::jsonb,version=version+1 WHERE id=$1`,[campaign.id]);await processCampaigns(100);expect((await getRecord(pool,workspace,'message_campaign',campaign.id))?.body.status).toBe(cancel?'CANCELLED':'PAUSED');expect(Number((await pool.query(`SELECT count(*) FROM outbox WHERE payload->>'campaign_id'=$1`,[campaign.id])).rows[0].count)).toBe(0);}});
 it('blocked account backlog does not starve a healthy account',async()=>{const blocked=await fixture(),healthy=await fixture();const simulator=new SimulatorProvider();for(const account of [blocked.account,healthy.account]){await acquireOwnership(account,owner);await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[account.id]);await recordHealth(account,()=>simulator);}await pool.query(`INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'channel_account',$2,true,'isolated fault','test')`,[workspace,blocked.account.id]);for(let i=0;i<25;i++)await withTransaction(c=>proposeEffect(c,blocked.conversation,{kind:'text',text:'Blocked fixture'},randomUUID()));const effect=await withTransaction(c=>proposeEffect(c,healthy.conversation,{kind:'text',text:'Healthy fixture'},randomUUID()));
  // The dispatcher is global. Include all pending accounts, including virtual clocks ahead of wall time;
  // the 25 older effects on one paused account must still not occupy the batch ahead of its peer.
  const accounts=(await pool.query("SELECT count(DISTINCT account_id)::int n FROM outbox WHERE status IN('READY','BLOCKED')")).rows[0].n;
  await dispatchOutbox(Math.max(20,accounts),()=>simulator,owner);expect((await pool.query('SELECT status FROM outbox WHERE id=$1',[effect.id])).rows[0].status).toBe('SENT');
  expect((await pool.query('SELECT count(*)::int n,COALESCE(sum(attempts),0)::int attempts FROM outbox WHERE account_id=$1',[blocked.account.id])).rows[0]).toEqual({n:25,attempts:0});
 });
 it('rotates an already blocked cohort without rewriting it and reaches a healthy account within one scan',async()=>{
  const blocked:string[]=[];for(let i=0;i<21;i++){
   const f=await fixture();await pool.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'channel_account',$2,true,'Synthetic paused backlog','fixture')",[workspace,f.account.id]);
   blocked.push((await withTransaction(c=>proposeEffect(c,f.conversation,{kind:'text',text:'Synthetic old blocked head'},randomUUID()))).id);
  }
  const healthy=await fixture(),simulator=new SimulatorProvider();
  const rankBlockerContact=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'contact',body:{name:'Rank-one blocker',identity:'opaque:'+randomUUID(),status:'LEAD',consent:{purpose:'messages',source:'fixture',evidence:'local explicit consent fixture',observed_at:new Date().toISOString()}}});
  const rankBlockerConversation=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:{account_id:healthy.account.id,contact_id:rankBlockerContact.id,offer_version_id:healthy.offer.id,status:'OPEN',stage:'NEW',sequence:1,last_customer_text:'Blocked rank one',last_inbound_at:new Date().toISOString(),ai_pending:false}});
  await pool.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'conversation',$2,true,'Synthetic rank-one blocker','fixture')",[workspace,rankBlockerConversation.id]);
  blocked.push((await withTransaction(c=>proposeEffect(c,rankBlockerConversation,{kind:'text',text:'Blocked before healthy effect in the same account'},randomUUID()))).id);
  await acquireOwnership(healthy.account,owner);await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[healthy.account.id]);await recordHealth(healthy.account,()=>simulator);
  const effect=await withTransaction(c=>proposeEffect(c,healthy.conversation,{kind:'text',text:'Healthy after blocked account heads'},randomUUID()));
  await pool.query("UPDATE outbox SET status='BLOCKED',result=jsonb_build_object('reason','OPERATION_PAUSED'),updated_at='2000-01-01T00:00:00Z' WHERE id=ANY($1::uuid[])",[blocked]);
  const before=(await pool.query('SELECT id,status,result,attempts,updated_at FROM outbox WHERE id=ANY($1::uuid[]) ORDER BY id',[blocked])).rows;
  let sends=0;const provider=Object.assign(new SimulatorProvider(),{send:async()=>{sends++;return{status:'ACCEPTED' as const,providerMessageId:'synthetic-healthy-after-rotation'};}});
  const pending=(await pool.query("SELECT count(*)::int n FROM outbox WHERE status IN('READY','BLOCKED')")).rows[0].n;
  for(let tick=0;tick<pending+2&&(await pool.query('SELECT status FROM outbox WHERE id=$1',[effect.id])).rows[0].status!=='SENT';tick++)await dispatchOutbox(20,account=>account.id===healthy.account.id?provider:simulator,owner);
  expect((await pool.query('SELECT status FROM outbox WHERE id=$1',[effect.id])).rows[0].status).toBe('SENT');expect(sends).toBe(1);
  const after=(await pool.query('SELECT id,status,result,attempts,updated_at FROM outbox WHERE id=ANY($1::uuid[]) ORDER BY id',[blocked])).rows;
  expect(after).toEqual(before);
 });
 it('yields lock-contended chat heads without mutating effects so later accounts can progress',async()=>{
  const contenders:Awaited<ReturnType<typeof fixture>>[]=[];for(let i=0;i<20;i++)contenders.push(await fixture());
  const healthy=await fixture(),simulator=new SimulatorProvider();
  for(const f of [...contenders,healthy]){await acquireOwnership(f.account,owner);await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[f.account.id]);await recordHealth(f.account,()=>simulator);}
  const contenderEffects=[];for(const f of contenders)contenderEffects.push(await withTransaction(c=>proposeEffect(c,f.conversation,{kind:'text',text:'Contended chat head'},randomUUID())));
  const healthyEffect=await withTransaction(c=>proposeEffect(c,healthy.conversation,{kind:'text',text:'Healthy after contended heads'},randomUUID()));
  const before=(await pool.query('SELECT id,status,result,attempts,updated_at FROM outbox WHERE id=ANY($1::uuid[]) ORDER BY id',[contenderEffects.map(effect=>effect.id)])).rows;
  const lockClient=await pool.connect();
  try{
   await lockClient.query('BEGIN');for(const f of contenders)await lockClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[chatLock(workspace,f.account.id,f.contact.id)]);
   const position=Number((await pool.query(`WITH clocks AS MATERIALIZED (SELECT o.id,o.account_id,o.dispatch_sequence,o.created_at AS first_seen_at,o.not_before,g.next_check_at,g.updated_at AS gate_checked_at,CASE WHEN o.environment='SIMULATION' THEN COALESCE(wr.virtual_now,(s.body->>'virtual_now')::timestamptz,now()) ELSE now() END AS effective_now FROM outbox o LEFT JOIN outbox_gate_schedule g ON g.effect_id=o.id LEFT JOIN records c ON c.id::text=o.conversation_id AND c.workspace_id=o.workspace_id LEFT JOIN records s ON s.id::text=c.body->>'simulation_id' AND s.workspace_id=c.workspace_id LEFT JOIN warmup_conversations wv ON wv.id::text=o.conversation_id AND o.kind='warmup' LEFT JOIN warmup_simulation_runs wr ON wr.id=wv.simulation_run_id WHERE o.status IN ('READY','BLOCKED')),fair AS MATERIALIZED (SELECT clocks.*,COALESCE(gate_checked_at,first_seen_at) AS considered_at,row_number() OVER(PARTITION BY account_id ORDER BY COALESCE(gate_checked_at,first_seen_at),dispatch_sequence) AS account_rank FROM clocks WHERE not_before<=effective_now AND (next_check_at IS NULL OR next_check_at<=now())),ranked AS (SELECT id,row_number() OVER(ORDER BY account_rank,considered_at,dispatch_sequence) AS position FROM fair) SELECT position FROM ranked WHERE id=$1`,[healthyEffect.id])).rows[0].position);
   expect(position).toBeGreaterThan(contenders.length);
   await dispatchOutbox(position-1,()=>simulator,owner);
   expect((await pool.query('SELECT status FROM outbox WHERE id=$1',[healthyEffect.id])).rows[0].status).toBe('READY');
   expect(Number((await pool.query("SELECT count(*)::int n FROM outbox_gate_schedule WHERE effect_id=ANY($1::uuid[]) AND last_reason='CHAT_LOCK_BUSY'",[contenderEffects.map(effect=>effect.id)])).rows[0].n)).toBe(contenders.length);
   const after=(await pool.query('SELECT id,status,result,attempts,updated_at FROM outbox WHERE id=ANY($1::uuid[]) ORDER BY id',[contenderEffects.map(effect=>effect.id)])).rows;expect(after).toEqual(before);
   await dispatchOutbox(position-1,()=>simulator,owner);
   expect((await pool.query('SELECT status FROM outbox WHERE id=$1',[healthyEffect.id])).rows[0].status).toBe('SENT');
  }finally{await lockClient.query('ROLLBACK');lockClient.release();}
 });
 it('does not starve a due recheck while each tick receives a full batch of new work',async()=>{
  await pool.query("UPDATE outbox SET status='CANCELLED' WHERE workspace_id=$1 AND status IN('READY','BLOCKED')",[workspace]);
  const blocked=await fixture();
  await pool.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'channel_account',$2,true,'Persistent synthetic blocker','fixture')",[workspace,blocked.account.id]);
  const effect=await withTransaction(c=>proposeEffect(c,blocked.conversation,{kind:'text',text:'Due recheck under continuous arrivals'},randomUUID()));
  // This test is about fairness once a recheck exists. Seed its durable state
  // directly: the dispatcher is global, so LIMIT 1 can legitimately select
  // another workspace's older head after the full MCP integration scenario.
  await pool.query("UPDATE outbox SET status='BLOCKED',result=$2 WHERE id=$1",[effect.id,{reason:'OPERATION_PAUSED'}]);
  await pool.query("INSERT INTO outbox_gate_schedule(effect_id,next_check_at,last_reason,updated_at) VALUES($1,now()-interval '1 second','OPERATION_PAUSED',$2)",[effect.id,new Date('1900-01-01T00:00:00.000Z')]);
  for(let tick=0;tick<2;tick++){
   const marker=new Date(`190${tick}-01-01T00:00:00.000Z`);
   await pool.query("UPDATE outbox_gate_schedule SET next_check_at=now()-interval '1 second',updated_at=$2 WHERE effect_id=$1",[effect.id,marker]);
   const arrivals=[];for(let i=0;i<20;i++){const fresh=await fixture();arrivals.push((await withTransaction(c=>proposeEffect(c,fresh.conversation,{kind:'text',text:`Continuous arrival ${tick}-${i}`},randomUUID()))).id);}
   await dispatchOutbox(20,()=>new SimulatorProvider(),owner);
   const recheck=(await pool.query('SELECT last_reason,updated_at FROM outbox_gate_schedule WHERE effect_id=$1',[effect.id])).rows[0];
   expect(recheck.last_reason).toBe('OPERATION_PAUSED');expect(new Date(recheck.updated_at).getTime()).toBeGreaterThan(marker.getTime());
   await pool.query("UPDATE outbox SET status='CANCELLED' WHERE id=ANY($1::uuid[])",[arrivals]);
  }
 });
 it('slow HTTP on account A does not delay account B',async()=>{const slow=await fixture(),healthy=await fixture();const simulator=new SimulatorProvider();for(const account of [slow.account,healthy.account]){await acquireOwnership(account,owner);await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[account.id]);await recordHealth(account,()=>simulator);}const a=await withTransaction(c=>proposeEffect(c,slow.conversation,{kind:'text',text:'Slow'},randomUUID())),b=await withTransaction(c=>proposeEffect(c,healthy.conversation,{kind:'text',text:'Healthy parallel'},randomUUID()));let release!:()=>void;const pending=new Promise<void>(r=>{release=r});let bSent!:()=>void;const healthySent=new Promise<void>(r=>{bSent=r});const timeout=setTimeout(()=>release(),8000);const slowProvider=Object.assign(new SimulatorProvider(),{send:async()=>{await pending;return{status:'ACCEPTED' as const,providerMessageId:'slow-fixture'};}}),healthyProvider=Object.assign(new SimulatorProvider(),{send:async()=>{bSent();return{status:'ACCEPTED' as const,providerMessageId:'healthy-fixture'};}});const running=dispatchOutbox(100,account=>account.id===slow.account.id?slowProvider:account.id===healthy.account.id?healthyProvider:simulator,owner);try{await healthySent;
 // B was sent while A's provider is still blocked. A's own claim runs concurrently
 // and may commit just after B's send on a loaded host: wait (bounded) for it.
 let status='';for(let i=0;i<150&&status!=='SENDING';i++){status=(await pool.query('SELECT status FROM outbox WHERE id=$1',[a.id])).rows[0].status;if(status!=='SENDING')await new Promise(r=>setTimeout(r,20));}expect(status).toBe('SENDING');}finally{release();clearTimeout(timeout);await running;}expect((await pool.query('SELECT status FROM outbox WHERE id=$1',[b.id])).rows[0].status).toBe('SENT');});

 it('human approval is pinned to the waiting node and resumes a condition and subflow once',async()=>{const f=await fixture();const sub=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'workflow',body:{name:'Approval subflow',status:'PUBLISHED',entry_node_id:'m',nodes:[{id:'m',type:'message',config:{text:'Approved subflow'},next:'end'},{id:'end',type:'end',config:{}}]}});const flow=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'workflow',body:{name:'Approval fixture',status:'PUBLISHED',entry_node_id:'approve',nodes:[{id:'approve',type:'approval',config:{},next:'condition'},{id:'condition',type:'condition',config:{field:'order.currency',operator:'equals',value:'MXN'},branches:{true:'sub',false:'end'}},{id:'sub',type:'subflow',config:{workflow_version_id:sub.id},next:'end'},{id:'end',type:'end',config:{}}]}});await pool.query('UPDATE records SET body=body||$2::jsonb,version=version+1 WHERE id=$1',[f.conversation.id,JSON.stringify({workflow_version_id:flow.id})]);await withTransaction(c=>advanceWorkflow(c,f.conversation));const approve={id:randomUUID(),workspace_id:workspace,environment:'SIMULATION',resource_id:f.conversation.id,kind:'conversation_command',actor_id:'fixture-reviewer',payload:{type:'approve_step',expected_workflow_version_id:flow.id,expected_node_id:'approve',reason:'Reviewed fixture branch and subflow'}};await expect(withTransaction(c=>applyCommand(c,{...approve,payload:{...approve.payload,expected_node_id:'wrong'}}))).rejects.toThrow('WORKFLOW_APPROVAL_INVALIDATED');await withTransaction(c=>applyCommand(c,approve));expect((await getRecord(pool,workspace,'conversation',f.conversation.id))?.body.flow_state.status).toBe('FINISHED');expect(Number((await pool.query('SELECT count(*) FROM outbox WHERE conversation_id=$1',[f.conversation.id])).rows[0].count)).toBe(1);await expect(withTransaction(c=>applyCommand(c,approve))).rejects.toThrow();});

 it('referral binding chooses ad before ad set and unknown observed ads do not infer campaign',async()=>{const f=await fixture();const campaign=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'acquisition_campaign',body:{name:'Evidence campaign'}}),adSet=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'ad_set',body:{name:'Evidence ad set',campaign_id:campaign.id}}),ad=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'ad',body:{name:'Evidence ad',ad_set_id:adSet.id,external_id:'observed-fixture-ad'}});const otherOffer=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'offer',body:{product_id:f.product.id,base_amount_minor:5000,currency:'MXN',status:'PUBLISHED',fulfillment:[]}});for(const scope of [{ad_set_id:adSet.id,offer_version_id:otherOffer.id},{ad_id:ad.id,offer_version_id:f.offer.id}])await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'binding',body:{account_id:f.account.id,campaign_id:campaign.id,valid_from:'2026-01-01T00:00:00Z',source:'explicit fixture',evidence:'Local fixture evidence',...scope}});const identity='opaque:'+randomUUID();const first=await withTransaction(c=>materializeMessage(c,f.account,{key:randomUUID(),type:'message',providerAt:'2026-09-05T12:00:00Z',identity,text:'Known ad',kind:'text',referral:{source_id:'observed-fixture-ad'},payload:{}},randomUUID()));expect(first?.body.offer_version_id).toBe(f.offer.id);expect(first?.body.origin.ad_id).toBe(ad.id);await withTransaction(c=>materializeMessage(c,f.account,{key:randomUUID(),type:'message',providerAt:'2026-09-05T12:01:00Z',identity,text:'Another referral',kind:'text',referral:{source_id:'observed-fixture-ad'},payload:{}},randomUUID()));expect(Number((await pool.query("SELECT count(*) FROM records WHERE kind='touchpoint' AND body->>'conversation_id'=$1",[first!.id])).rows[0].count)).toBe(2);const unknown=await withTransaction(c=>materializeMessage(c,f.account,{key:randomUUID(),type:'message',providerAt:'2026-09-05T12:00:00Z',identity:'opaque:'+randomUUID(),text:'Unknown ad',kind:'text',referral:{source_id:'unknown-ad'},payload:{}},randomUUID()));expect(unknown?.body.origin.campaign_id).toBeUndefined();expect(unknown?.body.origin.binding_id).toBeUndefined();});

 it('abandoned lifecycle commands require review and are never replayed',async()=>{
  const f=await fixture(),id=randomUUID();
  await pool.query(`INSERT INTO commands(id,workspace_id,environment,kind,resource_id,payload,status,result,actor_id,idempotency_key,updated_at) VALUES($1,$2,'SIMULATION','channel_command',$3,'{"type":"restart"}','PENDING','{"processing_owner":"crashed-fixture"}','test',$4,now()-interval '120 seconds')`,[id,workspace,f.account.id,id]);
  expect(await recoverChannelCommands()).toBe(1);expect(await recoverChannelCommands()).toBe(0);
  const command=(await pool.query('SELECT * FROM commands WHERE id=$1',[id])).rows[0];
  expect(command.status).toBe('FAILED');expect(command.result.recovery).toBe('NO_AUTOMATIC_RETRY');
  // The lifecycle worker scans every workspace. An unrelated, eligible command
  // must use its normal simulator without entering this account's call counter.
  const foreignWorkspace=lifecyclePeerWorkspace;
  const foreign=await putRecord(pool,{workspaceId:foreignWorkspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Unrelated lifecycle fixture',provider:'simulator',status:'WORKING'}});
  expect((await acquireOwnership(foreign,owner)).acquired).toBe(true);
  const foreignCommand=randomUUID();
  await pool.query(`INSERT INTO commands(id,workspace_id,environment,kind,resource_id,payload,status,result,actor_id,idempotency_key) VALUES($1,$2,'SIMULATION','channel_command',$3,'{"type":"logout"}','PENDING','{}','test',$4)`,[foreignCommand,foreignWorkspace,foreign.id,foreignCommand]);
  let remoteCalls=0;
  const provider=Object.assign(new SimulatorProvider(),{lifecycle:async()=>{remoteCalls++;return{status:'WORKING'};}}),simulator=new SimulatorProvider();
  const pending=(await pool.query("SELECT count(*)::int n FROM commands WHERE status='PENDING' AND kind='channel_command'")).rows[0].n;
  await processChannelCommands(Math.max(10,pending),account=>account.id===f.account.id&&account.workspace_id===workspace?provider:simulator,owner);
  expect(remoteCalls).toBe(0);
  expect((await pool.query('SELECT * FROM commands WHERE id=$1',[id])).rows[0]).toEqual(command);
  expect((await pool.query('SELECT status,result FROM commands WHERE id=$1',[foreignCommand])).rows[0]).toEqual({status:'APPLIED',result:{status:'STOPPED'}});
  expect((await getRecord(pool,foreignWorkspace,'channel_account',foreign.id))?.body.status).toBe('STOPPED');
 });

});
