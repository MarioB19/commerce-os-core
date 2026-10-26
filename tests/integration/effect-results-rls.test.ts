import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {pool,putRecord,withTransaction} from '../../packages/db/src/index.js';
import {proposeEffect} from '../../apps/automation-worker/src/shared.js';
import {PENDING_EFFECT_RESULTS} from '../../apps/automation-worker/src/effect-results.js';

// 25-oct-2026 (V7.1): under V7 FORCE RLS the correlated form below re-scanned
// every message and fulfillment record once per terminal effect on each 250 ms
// pass (150k buffers, ~2 s per pass with production data: a full PostgreSQL
// core). The materialized form must select exactly the same effects, in the
// same order. See docs/adr-v7-1-worker-loop-budget.md.
const LEGACY=`SELECT o.* FROM outbox o WHERE o.kind<>'warmup' AND COALESCE(o.payload->>'kind','text') NOT IN('grant','warmup')
 AND o.status IN('SENT','DELIVERED','READ','FAILED','UNKNOWN','CANCELLED') AND (
 NOT EXISTS(SELECT 1 FROM records m WHERE m.workspace_id=o.workspace_id AND m.environment=o.environment AND m.kind='message' AND m.body->>'effect_id'=o.id::text)
 OR EXISTS(SELECT 1 FROM records m WHERE m.workspace_id=o.workspace_id AND m.environment=o.environment AND m.kind='message' AND m.body->>'effect_id'=o.id::text AND m.body->>'status' IS DISTINCT FROM o.status)
 OR EXISTS(SELECT 1 FROM records f WHERE f.workspace_id=o.workspace_id AND f.environment=o.environment AND f.kind='fulfillment' AND f.id::text=o.payload->>'fulfillment_id' AND (f.body->>'status' IS DISTINCT FROM o.status OR f.body->>'delivery_projection_version' IS DISTINCT FROM '2')))
 ORDER BY o.updated_at LIMIT $1`;
const workspace='effect-results-'+randomUUID();
beforeAll(()=>fixtureProfiles(workspace));
afterAll(async()=>pool.end());

async function asAutomation<T>(work:(client:PoolClient)=>Promise<T>):Promise<T>{
 const client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE commerce_automation');return await work(client);}
 finally{await client.query('ROLLBACK');client.release();}
}
async function conversation(){
 const product=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'product',body:{name:'Effect results product'}});
 const offer=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'offer',body:{product_id:product.id,base_amount_minor:9900,currency:'MXN',status:'PUBLISHED',fulfillment:[],billing_delay_seconds:30}});
 const account=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Effect results account',provider:'simulator',status:'WORKING'}});
 const contact=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'contact',body:{name:'Effect results contact',identity:'opaque:'+randomUUID(),status:'LEAD',consent:{purpose:'messages',source:'fixture',evidence:'local explicit consent fixture',observed_at:new Date().toISOString()}}});
 const record=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:{account_id:account.id,contact_id:contact.id,offer_version_id:offer.id,status:'OPEN',stage:'NEW',sequence:1,last_inbound_at:new Date().toISOString(),ai_pending:false}});
 return {account,contact,conversation:record};
}
type Seed={status:string;messages:Array<{status:string;effectId?:(id:string)=>string}>};
// Cases (each its own conversation, so ordering ties cannot hide a difference):
const seeds:Record<string,Seed>={
 noMessage:{status:'SENT',messages:[]},
 sameStatus:{status:'SENT',messages:[{status:'SENT'}]},
 staleStatus:{status:'DELIVERED',messages:[{status:'SENT'}]},
 nonCanonicalId:{status:'READ',messages:[{status:'READ',effectId:id=>id.toUpperCase()}]},
 oneOfTwoStale:{status:'FAILED',messages:[{status:'FAILED'},{status:'SENT'}]},
 cancelledMatching:{status:'CANCELLED',messages:[{status:'CANCELLED'}]},
 notTerminal:{status:'READY',messages:[]},
};
const effects:Record<string,string>={};

beforeAll(async()=>{
 let minute=0;
 for(const [name,seed] of Object.entries(seeds)){
  const f=await conversation();
  const effect=await withTransaction(c=>proposeEffect(c,f.conversation,{kind:'text',text:`Effect results ${name}`},randomUUID()));
  effects[name]=effect.id;
  // Distinct, increasing updated_at values make the expected order unambiguous.
  await pool.query(`UPDATE outbox SET status=$2,updated_at=now()-interval '1 hour'+$3*interval '1 minute' WHERE id=$1`,[effect.id,seed.status,minute++]);
  for(const message of seed.messages)await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'message',body:{conversation_id:f.conversation.id,contact_id:f.contact.id,account_id:f.account.id,direction:'OUTBOUND',kind:'text',text:'projected',status:message.status,effect_id:(message.effectId??(id=>id))(effect.id)}});
 }
});

it('selects exactly the effects of the correlated form, in the same order, under the automation role',async()=>{
 const [legacy,current]=await asAutomation(async client=>[
  (await client.query(LEGACY,[100])).rows.map(row=>row.id),
  (await client.query(PENDING_EFFECT_RESULTS(''),[100])).rows.map(row=>row.id),
 ]);
 expect(current).toEqual(legacy);
 expect(current).toEqual(['noMessage','staleStatus','nonCanonicalId','oneOfTwoStale'].map(name=>effects[name]));
});

it('respects the limit with the same prefix',async()=>{
 const [legacy,current]=await asAutomation(async client=>[
  (await client.query(LEGACY,[2])).rows.map(row=>row.id),
  (await client.query(PENDING_EFFECT_RESULTS(''),[2])).rows.map(row=>row.id),
 ]);
 expect(current).toEqual(legacy);expect(current).toHaveLength(2);
});

type PlanNode={'Node Type':string;'Relation Name'?:string;'Index Cond'?:string;'Parent Relationship'?:string;Plans?:PlanNode[]};
function recordScans(node:PlanNode,underSubPlan=false,out:Array<{node:PlanNode;underSubPlan:boolean}>=[]){
 const sub=underSubPlan||node['Parent Relationship']==='SubPlan';
 if(node['Relation Name']==='records')out.push({node,underSubPlan:sub});
 for(const child of node.Plans??[])recordScans(child,sub,out);
 return out;
}
async function plan(sql:string){return asAutomation(async client=>{
 await client.query('SET LOCAL enable_seqscan=off');
 return recordScans((await client.query(`EXPLAIN (FORMAT JSON) ${sql}`,[100])).rows[0]['QUERY PLAN'][0].Plan as PlanNode);
});}

it('reads messages and fulfillments once per pass, never per terminal effect',async()=>{
 // With production statistics the fulfillments are read by primary key (lab,
 // 25-oct-2026: 470 effects, 1.2k buffers, 11 ms); with this fixture's tiny
 // tables the planner may scan them once by kind. Either way, no per-effect scan.
 const scans=await plan(PENDING_EFFECT_RESULTS(''));
 expect(scans).toHaveLength(2);
 expect(scans.some(scan=>scan.underSubPlan)).toBe(false);
 expect(scans.some(scan=>(scan.node['Index Cond']??'').includes('::text'))).toBe(false);
});

it('documents the replaced form: its records scans run once per terminal effect',async()=>{
 const scans=await plan(LEGACY);
 expect(scans.filter(scan=>scan.underSubPlan).length).toBeGreaterThanOrEqual(2);
});
