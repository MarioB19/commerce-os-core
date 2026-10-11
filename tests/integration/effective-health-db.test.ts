import {afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {pool,putRecord} from '../../packages/db/src/index.js';
import {readEffectiveHealth} from '../../packages/db/src/effective-health.js';

afterAll(async()=>{await pool.end();});

it('orders account health by instant, not timestamp text, with deterministic tie breaks',async()=>{
 const workspaceId='health-order-'+randomUUID(),now=new Date('2026-09-22T12:30:00.000Z');
 const account=await putRecord(pool,{workspaceId,environment:'SIMULATION',kind:'channel_account',body:{name:'Synthetic health-order account',provider:'simulator',status:'WORKING'}});
 const accountId=account.id;
 const signal=async(status:'BLOCKED'|'OK',observedAt:string)=>putRecord(pool,{workspaceId,environment:'SIMULATION',kind:'health_signal',body:{account_id:accountId,dimension:'restriction',scope:'account',status,source:'provider_read',value:{latest_read:{timelock:true,capping:true}},observed_at:observedAt,expires_at:'2026-09-22T13:00:00.000Z'}});
 await signal('BLOCKED','2026-09-22T13:00:00+02:00'); // 11:00Z, lexically later
 const clear=await signal('OK','2026-09-22T12:00:00.000Z');
 const selected=await readEffectiveHealth(pool,{workspaceId,environment:'SIMULATION',accountId,now});
 expect(selected.by_dimension.restriction).toMatchObject({id:clear.id,status:'OK',current:true,explicit_restriction_clear:true});
});
