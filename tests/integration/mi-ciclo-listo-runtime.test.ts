import {directAgreementWorkflow} from '../../packages/domain/src/sales/direct-agreement.js';
import {afterAll,afterEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pool,putRecord,getRecord,withTransaction,encrypt,hash} from '../../packages/db/src/index.js';
import type {Body,DomainRecord} from '../../packages/contracts/src/index.js';
import {miCicloListoWorkflow} from '../../packages/domain/src/sales/preschool.js';
import {materializeMessage} from '../../apps/automation-worker/src/inbound.js';
import {advanceWorkflow,ensureOrder,processTimers,processConfirmedSchedules} from '../../apps/automation-worker/src/workflows.js';
import {materializeEffectResults} from '../../apps/automation-worker/src/effect-results.js';
import {applyCommand} from '../../apps/automation-worker/src/commands.js';
import {dispatchOutbox,acquireOwnership,recordHealth} from '../../apps/channel-worker/src/runtime.js';
import {SimulatorProvider,type OutboundMessage} from '../../packages/messaging/src/index.js';

const workspace='mcl-runtime-'+randomUUID(),owner='mcl-test-owner';
const root=await mkdtemp(join(tmpdir(),'mcl-runtime-'));await mkdir(join(root,'assets'));
const priorStorage=process.env.PRIVATE_STORAGE_DIR;process.env.PRIVATE_STORAGE_DIR=root;
afterEach(async()=>{await pool.query("UPDATE records SET body=body||'{\"ai_pending\":false}'::jsonb,version=version+1 WHERE workspace_id=$1 AND kind='conversation'",[workspace]);await pool.query("UPDATE outbox SET status='CANCELLED' WHERE workspace_id=$1 AND status IN('READY','BLOCKED')",[workspace]);await pool.query("UPDATE timers SET status='CANCELLED' WHERE workspace_id=$1 AND status='PENDING'",[workspace]);});
afterAll(async()=>{if(priorStorage===undefined)delete process.env.PRIVATE_STORAGE_DIR;else process.env.PRIVATE_STORAGE_DIR=priorStorage;await rm(root,{recursive:true,force:true});await pool.end();});
const record=(kind:string,body:Body)=>putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind,body});
async function fixture(entry='Hola',direct=false){
 let instant=Date.now()+60000;
 let simulation=await record('simulation',{virtual_now:new Date(instant).toISOString(),status:'RUNNING'});
 const setTime=async(ms:number)=>{instant=ms;simulation=await putRecord(pool,{id:simulation.id,version:simulation.version,workspaceId:workspace,environment:'SIMULATION',kind:'simulation',body:{...simulation.body,virtual_now:new Date(instant).toISOString()}});};
 const assets:Record<string,DomainRecord>={};
 for(const name of ['pitch','agreement','collection','followup1','followup2','mockup','core','calendar','kit']){
  const storage_key=randomUUID(),bytes=Buffer.from('SYNTHETIC LABORATORY FIXTURE '+name);
  if(!['core','kit'].includes(name))await writeFile(join(root,'assets',storage_key+'.enc'),encrypt(bytes.toString('base64')));
  assets[name]=await record('asset',{name:'Synthetic '+name,kind:['core','kit'].includes(name)?'link':'file',url:'https://example.com/laboratory/'+name,storage_key,sha256:hash(bytes),mime_type:name==='mockup'?'image/png':name==='calendar'?'application/pdf':'audio/mpeg',status:'READY'});
 }
 const product=await record('product',{name:'Synthetic nine-grade Mi Ciclo Listo'}),policy=await record('receipt_policy',{allow_amount_mismatch:true,min_amount_minor:1,auto_approve:false,require_currency:true});
 const recipe=direct?directAgreementWorkflow():miCicloListoWorkflow({pitch:assets.pitch!.id,agreement:assets.agreement!.id,collection:assets.collection!.id,followup1:assets.followup1!.id,followup2:assets.followup2!.id,mockup:assets.mockup!.id});
 const workflow=await record('workflow',{...recipe,status:'PUBLISHED'}),offer=await record('offer',{name:'Synthetic MCL',status:'PUBLISHED',product_id:product.id,workflow_version_id:workflow.id,currency:'MXN',base_amount_minor:9700,receipt_policy_version_id:policy.id,fulfillment:[{asset_id:assets.core!.id,release_on:'commitment_accepted'},{asset_id:assets.calendar!.id,release_on:'receipt_approved',min_amount_minor:1},{asset_id:assets.kit!.id,release_on:'receipt_approved',min_amount_minor:10700}]});
 const account=await record('channel_account',{name:'Synthetic sender',provider:'simulator',status:'WORKING',offer_version_id:offer.id,workflow_version_id:workflow.id});
 const provider=new SimulatorProvider(),messages:OutboundMessage[]=[];provider.send=async m=>{messages.push(m);return{status:'ACCEPTED',providerMessageId:'synthetic:'+m.effectId};};
 const identity='opaque:'+randomUUID();
 const receive=(text:string)=>withTransaction(c=>materializeMessage(c,account,{key:randomUUID(),type:'message',identity,text,kind:'text',providerAt:new Date(instant).toISOString(),payload:{}},randomUUID()));
 let conversation=(await receive(entry))!;conversation=await putRecord(pool,{id:conversation.id,version:conversation.version,workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:{...conversation.body,simulation_id:simulation.id}});
 await withTransaction(c=>advanceWorkflow(c,conversation));
 const current=async()=>(await getRecord(pool,workspace,'conversation',conversation.id))!;
 const order=async()=>(await withTransaction(c=>ensureOrder(c,conversation)))!;
 const effects=async()=>(await pool.query('SELECT * FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY dispatch_sequence',[workspace,conversation.id])).rows;
 const timers=async()=>(await pool.query('SELECT * FROM timers WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY due_at',[workspace,conversation.id])).rows;
 const drain=async()=>{await acquireOwnership(account,owner);await pool.query("UPDATE session_ownership SET frozen=false,lease_expires_at=now()+interval '5 minutes' WHERE account_id=$1",[account.id]);await recordHealth(account,()=>provider);await dispatchOutbox(1000,candidate=>candidate.id===account.id&&candidate.workspace_id===workspace?provider:new SimulatorProvider(),owner);await materializeEffectResults(1000);};
 const advance=async(seconds:number)=>{await setTime(instant+seconds*1000);await processTimers(1000);};
 const commit=async()=>{if((await current()).body.flow_state.waiting_node_id==='grade')await receive('segundo de primaria');await drain();await processConfirmedSchedules(1000);await advance(2.5);await drain();await receive('Me interesa');await drain();await receive('SÍ, QUIERO MI CICLO LISTO');};
 const receipt=async()=>record('receipt',{conversation_id:conversation.id,order_id:(await order()).id,asset_id:(await record('asset',{name:'SYNTHETIC LABORATORY RECEIPT',kind:'file',status:'READY',storage_key:randomUUID(),sha256:hash(randomUUID())})).id,status:'HUMAN_REVIEW',extraction:{amount_minor:10700,currency:'MXN'}});
 const review=async(r:DomainRecord)=>withTransaction(c=>applyCommand(c,{id:randomUUID(),workspace_id:workspace,environment:'SIMULATION',kind:'receipt_review',resource_id:r.id,actor_id:'laboratory-operator',payload:{expected_version:r.version,decision:'APPROVED',amount_minor:10700,currency:'MXN',reason:'Unambiguous laboratory fixture'}}));
 return{assets,account,conversation,workflow,offer,simulation,current,order,receive,effects,timers,drain,advance,commit,receipt,review,messages,provider,setTime,now:()=>instant};
}
it.each([['preescolar',1],['preescolar',2],['preescolar',3],['primaria',1],['primaria',2],['primaria',3],['primaria',4],['primaria',5],['primaria',6]])('routes %s %i from initial message without repeating the question',async(nivel,grado)=>{
 const f=await fixture(`Soy de ${grado} de ${nivel}`);expect((await f.current()).body.flow_state.variables).toMatchObject({nivel,grado:String(grado)});expect((await f.effects()).map(e=>e.payload.workflow_node_id)).toEqual(['pitch','mockup']);
});
it('keeps silence gated, clarifies first grade and rejects a bare yes at commitment',async()=>{
 const f=await fixture();await f.drain();await f.advance(24*3600);expect((await f.effects()).map(e=>e.payload.workflow_node_id)).toEqual(['welcome']);expect(await f.timers()).toHaveLength(0);
 await f.receive('primero');expect((await f.current()).body.flow_state).toMatchObject({waiting_node_id:'grade',variables:{grado:'1'}});await f.receive('primaria');expect((await f.current()).body.flow_state.variables).toMatchObject({nivel:'primaria',grado:'1'});
 // Restore a fresh window before actually running the remaining synthetic messages.
 await f.drain();await processConfirmedSchedules(1000);await f.advance(2.5);await f.drain();await f.receive('me interesa');await f.drain();await f.receive('sí');expect((await f.order()).body.committed_at).toBeUndefined();expect((await f.current()).body.flow_state.waiting_for).toBe('commitment');
});
it('waits for confirmed pitch and Core, keeps original due time after restart/ACK, and dispatches five audios',async()=>{
 const f=await fixture();await f.receive('sexto de primaria');await f.advance(600);expect((await f.current()).body.flow_state.waiting_for).toBe('customer_reply');expect(await f.timers()).toHaveLength(0);
 await f.drain();const pitch=(await f.effects()).find(e=>e.payload.workflow_node_id==='pitch');expect(pitch.result.accepted_at).toBe(new Date(f.now()).toISOString());await processConfirmedSchedules(1000);
 expect(await f.timers()).toHaveLength(0);await f.advance(2.499);await f.drain();expect(f.messages.some(m=>m.kind==='image')).toBe(false);await f.advance(.001);await f.drain();expect(f.messages.filter(m=>m.kind==='image')).toHaveLength(1);
 await f.receive('me interesa');await f.drain();await f.receive('SÍ, QUIERO MI CICLO LISTO');expect((await f.current()).body.flow_state.waiting_for).toBe('effect_confirmed');await f.advance(2400);expect((await f.effects()).some(e=>e.payload.workflow_node_id==='collection_audio')).toBe(false);
 await f.drain();const core=(await f.effects()).find(e=>e.payload.fulfillment_id);const coreAt=new Date(core.result.accepted_at).getTime();await processConfirmedSchedules(1000);await f.receive('Ya pude abrir el portal, gracias');const due=(await f.timers()).find(t=>t.payload.node_id==='collection_wait').due_at;expect(new Date(due).getTime()-coreAt).toBe(1800000);
 await pool.query("UPDATE outbox SET status='READ',updated_at=now()+interval '1 hour' WHERE id=$1",[core.id]);await processConfirmedSchedules(1000);expect(new Date((await f.timers()).find(t=>t.payload.node_id==='collection_wait').due_at).getTime()).toBe(new Date(due).getTime());
 await f.advance(1799.999);expect((await f.effects()).some(e=>e.payload.workflow_node_id==='collection_audio')).toBe(false);await f.advance(.001);await f.drain();await processConfirmedSchedules(1000);
 const bank=(await f.effects()).find(e=>e.payload.workflow_node_id==='bank');const followups=(await f.timers()).filter(t=>t.kind==='followup');expect(followups.map(t=>(new Date(t.due_at).getTime()-new Date(bank.result.accepted_at).getTime())/1000)).toEqual([7200,82800]);
 await f.advance(7200);await f.drain();expect(f.messages.filter(m=>m.kind==='audio')).toHaveLength(4);
 await f.advance(75600);await f.drain();expect(f.messages.filter(m=>m.kind==='audio').map(m=>m.media?.filename)).toEqual(['Synthetic pitch','Synthetic agreement','Synthetic collection','Synthetic followup1','Synthetic followup2']);expect(f.messages.filter(m=>m.kind==='image')).toHaveLength(1);expect(f.messages.filter(m=>m.text?.includes('/laboratory/core'))).toHaveLength(1);
 await processTimers(1000);await f.drain();expect(f.messages.filter(m=>m.kind==='audio')).toHaveLength(5);expect((await f.effects()).filter(e=>e.payload.purpose==='followup')).toHaveLength(4);
});
it('omits the second touch when the last inbound window has expired even on simulator/QR semantics',async()=>{
 const f=await fixture();await f.commit();await f.advance(3600);await f.drain();await processConfirmedSchedules(1000);await f.advance(1800);await f.drain();await processConfirmedSchedules(1000);await f.advance(7200);await f.drain();await f.advance(75600);await f.drain();
 expect(f.messages.filter(m=>m.kind==='audio')).toHaveLength(4);expect((await f.timers()).find(t=>t.payload.touch_index===2).status).toBe('CANCELLED');
});
it.each(['receipt','negative','optout','human'])('cancels durable collection before transport on %s',async(mode)=>{
 const f=await fixture();await f.commit();await f.drain();await processConfirmedSchedules(1000);
 if(mode==='receipt')await f.receipt();if(mode==='negative')await f.receive('No me interesa');if(mode==='optout')await f.receive('baja');if(mode==='human')await pool.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,takeover,reason,actor_id) VALUES($1,'conversation',$2,true,'laboratory','test')",[workspace,f.conversation.id]);
 await f.advance(1800);await f.drain();expect((await f.effects()).some(e=>e.payload.workflow_node_id==='collection_audio')).toBe(false);expect((await f.timers()).find(t=>t.payload.node_id==='collection_wait').status).toBe('CANCELLED');
});
it('cancels already proposed followups at dispatch after receipt and still delivers Calendar/Kit once',async()=>{
 const f=await fixture();await f.commit();await f.drain();await processConfirmedSchedules(1000);await f.advance(1800);await f.drain();await processConfirmedSchedules(1000);await f.advance(7200);
 expect((await f.effects()).filter(e=>e.payload.purpose==='followup')).toHaveLength(2);const r=await f.receipt();await f.drain();expect((await f.effects()).filter(e=>e.payload.purpose==='followup').every(e=>e.status==='CANCELLED')).toBe(true);
 await f.review(r);await f.drain();expect(f.messages.filter(m=>m.kind==='document')).toHaveLength(1);expect(f.messages.filter(m=>m.text?.includes('/laboratory/kit'))).toHaveLength(1);await processTimers(1000);await f.drain();expect(f.messages.filter(m=>m.kind==='document')).toHaveLength(1);
});
it('revalidates the last inbound window at dispatch even when a touch was eligible when queued',async()=>{
 const f=await fixture();await f.commit();await f.drain();await processConfirmedSchedules(1000);await f.advance(1800);await f.drain();await processConfirmedSchedules(1000);await f.advance(7200);await f.setTime(f.now()+24*3600_000);await f.drain();expect((await f.effects()).filter(e=>e.payload.purpose==='followup').every(e=>e.status==='CANCELLED')).toBe(true);expect(f.messages.filter(m=>m.kind==='audio')).toHaveLength(3);
});

it('retains uncertain Core without replay or an invented billing anchor',async()=>{
 const f=await fixture();await f.commit();let coreCalls=0;f.provider.send=async m=>{if(m.text?.includes('/laboratory/core')){coreCalls++;return{status:'UNKNOWN',reason:'LAB_ACCEPTANCE_UNCERTAIN'};}return{status:'ACCEPTED',providerMessageId:'synthetic:'+m.effectId};};
 await f.drain();await processConfirmedSchedules(1000);await f.advance(3600);await f.drain();expect(coreCalls).toBe(1);expect((await f.current()).body.flow_state.waiting_for).toBe('effect_confirmed');expect((await f.timers()).some(t=>t.payload.purpose==='collection')).toBe(false);expect((await f.effects()).some(e=>e.payload.workflow_node_id==='collection_audio')).toBe(false);
});
it.each(['negative','human','answer'])('stops queued followup effects and future touches on %s',async(mode)=>{
 const f=await fixture();await f.commit();await f.drain();await processConfirmedSchedules(1000);await f.advance(1800);await f.drain();await processConfirmedSchedules(1000);await f.advance(7200);
 if(mode==='human')await pool.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,takeover,reason,actor_id) VALUES($1,'conversation',$2,true,'laboratory','test')",[workspace,f.conversation.id]);else await f.receive(mode==='negative'?'No, gracias':'No pude abrir el portal');
 await f.drain();await f.advance(75600);await f.drain();expect(f.messages.filter(m=>m.kind==='audio')).toHaveLength(3);expect((await f.effects()).filter(e=>e.payload.purpose==='followup').every(e=>e.status==='CANCELLED')).toBe(true);
});

it('delivers Core then banking immediately on a natural agreement without double delivery',async()=>{
 const f=await fixture('Hola',true);await f.drain();expect((await f.current()).body.flow_state.waiting_for).toBe('commitment');
 await f.receive('¿puedo verlo primero?');expect((await f.order()).body.committed_at).toBeUndefined();
 await f.receive('Sí, acepto.');expect((await f.order()).body.status).toBe('COMMITTED');expect(await f.timers()).toHaveLength(0);await f.drain();
 const coreIndex=f.messages.findIndex(m=>m.text?.includes('/laboratory/core'));const bankIndex=f.messages.findIndex(m=>m.text?.includes('instrucciones bancarias'));expect(coreIndex).toBeGreaterThanOrEqual(0);expect(bankIndex).toBe(coreIndex+1);
 await f.receive('acepto');await f.drain();expect(f.messages.filter(m=>m.text?.includes('/laboratory/core'))).toHaveLength(1);expect(f.messages.filter(m=>m.text?.includes('instrucciones bancarias'))).toHaveLength(1);
});
it('never sends banking after an uncertain immediate material send',async()=>{
 const f=await fixture('Hola',true);await f.drain();await f.receive('sí');let calls=0;
 f.provider.send=async m=>{if(m.text?.includes('/laboratory/core')){calls++;return{status:'UNKNOWN',reason:'SYNTHETIC_UNKNOWN'};}throw new Error('Bank must remain behind uncertain Core');};
 await f.drain();await f.drain();expect(calls).toBe(1);expect((await f.effects()).find(e=>e.payload.workflow_node_id==='bank').status).toBe('BLOCKED');
});
