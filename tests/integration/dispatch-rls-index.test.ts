import {afterAll,expect,it} from 'vitest';
import {pool} from '../../packages/db/src/index.js';
import {DISPATCH_CANDIDATE_CLOCKS} from '../../apps/channel-worker/src/dispatch.js';

// 21-oct-2026: under V7 FORCE RLS the channel worker scanned every record per
// candidate effect (uuid::text join quals are not leakproof), so channel_dispatch
// outlived its deadline on production data. See docs/adr-v7-dispatch-rls-index.md.
afterAll(async()=>pool.end());

type PlanNode={'Node Type':string;'Relation Name'?:string;'Index Cond'?:string;Plans?:PlanNode[]};
function recordScans(node:PlanNode,out:PlanNode[]=[]){
 if(node['Relation Name']==='records')out.push(node);
 for(const child of node.Plans??[])recordScans(child,out);
 return out;
}
async function recordScansAsChannelWorker(sql:string){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE commerce_channel');
  // Small fixture tables would otherwise make any scan look cheapest.
  await client.query('SET LOCAL enable_seqscan=off');
  const plan=(await client.query(`EXPLAIN (FORMAT JSON) ${sql}`,[20])).rows[0]['QUERY PLAN'][0].Plan as PlanNode;
  return recordScans(plan);
 }finally{await client.query('ROLLBACK');client.release();}
}
const byId=(node:PlanNode)=>/\(id = /.test(node['Index Cond']??'');

it('looks up candidate conversations and simulations by primary key under worker RLS',async()=>{
 const scans=await recordScansAsChannelWorker(`${DISPATCH_CANDIDATE_CLOCKS('')} SELECT id FROM clocks ORDER BY first_seen_at LIMIT $1`);
 expect(scans.length).toBe(2);
 expect(scans.every(byId)).toBe(true);
});

it('documents why the cast join was replaced: the same policies keep it out of any id index',async()=>{
 const scans=await recordScansAsChannelWorker(`SELECT o.id FROM outbox o LEFT JOIN records c ON c.id::text=o.conversation_id AND c.workspace_id=o.workspace_id WHERE o.status IN ('READY','BLOCKED') LIMIT $1`);
 expect(scans.length).toBe(1);
 expect(scans.some(byId)).toBe(false);
 expect(scans[0]!['Index Cond']??'').not.toContain('::text');
});
