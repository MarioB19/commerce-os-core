import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord,getRecord,encrypt,hash,withTransaction} from '../../packages/db/src/index.js';
import {processReceiptAnalyses} from '../../apps/automation-worker/src/agents.js';
import {processCommands} from '../../apps/automation-worker/src/commands.js';
import {recoverAutomation} from '../../apps/automation-worker/src/runtime.js';
import {decideReceipt} from '../../packages/db/src/receipt-queue.js';
import {recordProfileExecutor} from '../../packages/db/src/profile-record-context.js';
import type {SalesAiProvider} from '../../packages/domain/src/sales/ai.js';

const workspace='receipt-concurrency-'+randomUUID();
beforeAll(async()=>{
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Synthetic finance concurrency',email,password,workspace_id:workspace,role:'owner'});
});
afterAll(async()=>{await pool.end();});
async function fixture(analysis_status='PENDING'){
 const conversation=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:{status:'OPEN',sequence:1}});
 const order=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'order',body:{conversation_id:conversation.id,status:'RECEIPT_RECEIVED',receipt_status:'RECEIVED',reconciliation_status:'UNRECONCILED',amount_minor:9900,currency:'MXN',offer_snapshot:{fulfillment:[]}}});
 const asset=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'asset',body:{name:'Synthetic protected receipt',storage_key:randomUUID(),sha256:hash(randomUUID()),status:'READY'}});
 const receipt=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'receipt',body:{conversation_id:conversation.id,order_id:order.id,asset_id:asset.id,status:'HUMAN_REVIEW',analysis_status,analysis_started_at:new Date(Date.now()-120_000).toISOString()}});
 return{conversation,order,receipt,asset};
}
// V7 F8-D: the person's decision goes through the V7 receipt queue
// (decideReceipt, the body of POST /v2/receipts/:id/decision); the V5
// /v1/receipts/:id/review route was retired.
type ReviewResult={statusCode:number;json:()=>{data:{id:string};error:{code:string}}};
async function review(id:string,expected_version:number,key=randomUUID()):Promise<ReviewResult>{
 try{const data=await withTransaction(async c=>decideReceipt(await recordProfileExecutor(c,workspace,'SIMULATION'),'SIMULATION',id,{decision:'APPROVED',reason:'Explicit synthetic human review',expected_version,amount_minor:9900},{id:'synthetic-reviewer'},key));
  return{statusCode:202,json:()=>({data:{id:data.command_id},error:{code:''}})};}
 catch(error){const e=error as {code?:string;statusCode?:number};if(!e.code)throw error;return{statusCode:e.statusCode??409,json:()=>({data:{id:''},error:{code:e.code!}})};}
}
async function processUntilAnalyzed(id:string){
 const pending=Number((await pool.query("SELECT count(*)::int n FROM records WHERE kind='receipt' AND body->>'analysis_status'='PENDING' AND body->>'review' IS NULL")).rows[0].n);
 for(let attempt=0;attempt<=pending;attempt++){
  const current=await getRecord(pool,workspace,'receipt',id);
  if(current?.body.analysis_status!=='PENDING')return current;
  if(await processReceiptAnalyses(1)===0)break;
 }
 return getRecord(pool,workspace,'receipt',id);
}
describe('Accepted human receipt review versus asynchronous analysis',()=>{
 it('does not let a legacy reviewed PENDING receipt starve new analysis at batch limit one',async()=>{
  const legacy=await fixture();const reviewed=await putRecord(pool,{id:legacy.receipt.id,workspaceId:workspace,environment:'SIMULATION',kind:'receipt',version:legacy.receipt.version,body:{...legacy.receipt.body,status:'APPROVED',review:{actor_id:'synthetic-legacy-reviewer',reason:'Previous human review'}}});
  const next=await fixture(),nullable=await fixture();await putRecord(pool,{id:nullable.receipt.id,workspaceId:workspace,environment:'SIMULATION',kind:'receipt',version:nullable.receipt.version,body:{...nullable.receipt.body,review:null}});
  expect((await processUntilAnalyzed(next.receipt.id))?.body.analysis_status).toBe('HUMAN_REQUIRED');
  expect((await processUntilAnalyzed(nullable.receipt.id))?.body.analysis_status).toBe('HUMAN_REQUIRED');
  expect((await getRecord(pool,workspace,'receipt',reviewed.id))?.version).toBe(reviewed.version);
 });
 it('does not invalidate an accepted review when the no-provider assessment runs before its command',async()=>{
  const f=await fixture();const accepted=await review(f.receipt.id,f.receipt.version);expect(accepted.statusCode).toBe(202);
  await processReceiptAnalyses(100);await processCommands(100);
  const command=(await pool.query('SELECT status,result FROM commands WHERE id=$1',[accepted.json().data.id])).rows[0];
  expect(command).toMatchObject({status:'APPLIED',result:{decision:'APPROVED'}});
  expect((await getRecord(pool,workspace,'order',f.order.id))?.body).toMatchObject({status:'RECEIPT_APPROVED',reconciliation_status:'UNRECONCILED'});
  const applied=await getRecord(pool,workspace,'receipt',f.receipt.id);expect(applied?.body.analysis_status).toBe('HUMAN_REVIEWED');
  await processReceiptAnalyses(100);expect((await getRecord(pool,workspace,'receipt',f.receipt.id))?.version).toBe(applied?.version);
  expect((await pool.query('SELECT count(*) FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].count).toBe('0');
 });
 it('rejects evidence changed before acceptance and accepts only the reviewed current version',async()=>{
  const f=await fixture();await processReceiptAnalyses(100);
  const stale=await review(f.receipt.id,f.receipt.version);expect(stale.statusCode).toBe(409);expect(stale.json().error.code).toBe('VERSION_CONFLICT');
  expect((await pool.query("SELECT count(*) FROM commands WHERE resource_id=$1",[f.receipt.id])).rows[0].count).toBe('0');
  const current=(await getRecord(pool,workspace,'receipt',f.receipt.id))!;expect(current.body.analysis_status).toBe('HUMAN_REQUIRED');
  const accepted=await review(current.id,current.version);expect(accepted.statusCode).toBe(202);await processCommands(100);
  expect((await pool.query('SELECT status FROM commands WHERE id=$1',[accepted.json().data.id])).rows[0].status).toBe('APPLIED');
 });
 it('accepts one concurrent human decision and replays its idempotency key without another command',async()=>{
  const f=await fixture();const keys=[randomUUID(),randomUUID()];const results=await Promise.all(keys.map(key=>review(f.receipt.id,f.receipt.version,key)));
  expect(results.map(r=>r.statusCode).sort()).toEqual([202,409]);expect(results.find(r=>r.statusCode===409)!.json().error.code).toBe('RECEIPT_DECISION_PENDING');
  const index=results.findIndex(r=>r.statusCode===202);const replay=await review(f.receipt.id,f.receipt.version,keys[index]);expect(replay.statusCode).toBe(202);expect(replay.json().data.id).toBe(results[index]!.json().data.id);
  await processCommands(100);expect((await pool.query("SELECT count(*) FROM commands WHERE resource_id=$1",[f.receipt.id])).rows[0].count).toBe('1');
 });
 it('recovers an abandoned analysis without invalidating a pending or completed human review',async()=>{
  const f=await fixture('RUNNING'),abandoned=await fixture('RUNNING');const accepted=await review(f.receipt.id,f.receipt.version);expect(accepted.statusCode).toBe(202);
  await recoverAutomation();expect((await getRecord(pool,workspace,'receipt',f.receipt.id))?.version).toBe(f.receipt.version);
  expect((await getRecord(pool,workspace,'receipt',abandoned.receipt.id))?.body).toMatchObject({analysis_status:'HUMAN_REQUIRED',analysis_dependency:'WORKER_RESTART_DURING_ANALYSIS'});
  await processCommands(100);await recoverAutomation();expect((await getRecord(pool,workspace,'receipt',f.receipt.id))?.body).toMatchObject({status:'APPROVED',analysis_status:'HUMAN_REVIEWED'});
 });
 for(const resolveBeforeCommand of [true,false])it(`discards an in-flight provider result when human review is ${resolveBeforeCommand?'pending':'already applied'}`,async()=>{
  const f=await fixture();const root=await mkdtemp(join(tmpdir(),'receipt-concurrency-'));const oldRoot=process.env.PRIVATE_STORAGE_DIR;process.env.PRIVATE_STORAGE_DIR=root;
  await mkdir(join(root,'assets'));await writeFile(join(root,'assets',`${f.asset.body.storage_key}.enc`),encrypt(Buffer.from('synthetic document fixture').toString('base64')),{mode:0o600});
  const agent=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'agent',body:{provider:'openai',model:'synthetic-no-network'}});
  await putRecord(pool,{id:f.conversation.id,workspaceId:workspace,environment:'SIMULATION',kind:'conversation',version:f.conversation.version,body:{...f.conversation.body,agent_version_id:agent.id}});
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});
  const provider:SalesAiProvider={propose:async()=>{throw new Error('UNUSED');},receipt:async()=>{entered();await wait;return{is_receipt:false,amount_minor:null,currency:null,destination_suffix:null,bank:null,reference:null,status:'unknown',confidence:0,contradictions:[]};}};
  const running=processReceiptAnalyses(100,provider);
  try{
   await started;const snapshot=(await getRecord(pool,workspace,'receipt',f.receipt.id))!;expect(snapshot.body.analysis_status).toBe('RUNNING');
   const accepted=await review(snapshot.id,snapshot.version);expect(accepted.statusCode).toBe(202);
   if(!resolveBeforeCommand)await processCommands(100);release();await running;
   if(resolveBeforeCommand){expect((await getRecord(pool,workspace,'receipt',f.receipt.id))?.version).toBe(snapshot.version);await processCommands(100);}
   const applied=(await getRecord(pool,workspace,'receipt',f.receipt.id))!;expect(applied.body).toMatchObject({status:'APPROVED',analysis_status:'HUMAN_REVIEWED'});expect(applied.body.extraction).toMatchObject({source:'human_observation',amount_minor:9900});
   expect((await pool.query('SELECT status FROM commands WHERE id=$1',[accepted.json().data.id])).rows[0].status).toBe('APPLIED');
  }finally{release();await running;if(oldRoot===undefined)delete process.env.PRIVATE_STORAGE_DIR;else process.env.PRIVATE_STORAGE_DIR=oldRoot;await rm(root,{recursive:true,force:true});}
 });
});
