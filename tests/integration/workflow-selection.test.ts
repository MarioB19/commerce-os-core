import {afterAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {processNewWorkflows} from '../../apps/automation-worker/src/workflows.js';
import {getRecord,pool,putRecord} from '../../packages/db/src/index.js';

const workspace='workflow-selection-'+randomUUID();

afterAll(async()=>{await pool.end();});

describe('workflow execution selection',()=>{
 it('leaves reporting-only conversations without an executable identity untouched',async()=>{
  const base={workspaceId:workspace,environment:'SIMULATION' as const};
  const product=await putRecord(pool,{...base,kind:'product',body:{name:'Synthetic reporting product'}});
  const offer=await putRecord(pool,{...base,kind:'offer',body:{name:'Synthetic reporting offer',product_id:product.id,currency:'MXN',base_amount_minor:9700,fulfillment:[],billing_delay_seconds:1800,status:'PUBLISHED'}});
  const conversation=await putRecord(pool,{...base,kind:'conversation',body:{reporting_only:true,product_id:product.id,offer_version_id:offer.id,stage:'NEW',started_at:new Date().toISOString()}});
  const before={version:conversation.version,body:structuredClone(conversation.body)};

  // The worker is intentionally global and may process executable fixtures from
  // other suites sharing this isolated database. Assert this cohort by scope.
  await processNewWorkflows(100);

  const current=await getRecord(pool,workspace,'conversation',conversation.id);
  expect(current).toMatchObject(before);
  expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
  expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind IN ('order','message','fulfillment')",[workspace])).rows[0].n).toBe(0);
  expect((await pool.query('SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND aggregate_id=$2',[workspace,conversation.id])).rows[0].n).toBe(0);
 });
});
