import {afterEach,expect,it,vi} from 'vitest';
import {pool} from '../../packages/db/src/index.js';
import type {DomainRecord} from '../../packages/contracts/src/index.js';
import type {OutboundMessage} from '../../packages/messaging/src/index.js';
import {numberSimulator} from '../../apps/channel-worker/src/number-simulator.js';
import {providerFor} from '../../apps/channel-worker/src/providers.js';

const account=(status='WORKING',fault?:string)=>({id:'11111111-1111-4111-8111-111111111111',workspace_id:'number-stop-fixture',environment:'SIMULATION',kind:'channel_account',version:1,created_at:'2026-10-09T00:00:00Z',updated_at:'2026-10-09T00:00:00Z',body:{provider:'simulator',device_ref:'Synthetic device',name:'Synthetic operator',status,sending_enabled:false,...(fault?{simulated_fault:fault}:{})}} as DomainRecord);
const message={effectId:'22222222-2222-4222-8222-222222222222',recipient:'opaque:synthetic',kind:'text',text:'Private fixture'} as OutboundMessage;
function stub(groupFault?:string){return vi.spyOn(pool,'query').mockImplementation(async(sql:any)=>{
 if(String(sql).startsWith('SELECT virtual_now FROM warmup_simulation_runs'))return{rows:[],rowCount:0} as any;
 if(String(sql).startsWith('SELECT fault FROM number_simulation_groups'))return{rows:groupFault?[{fault:groupFault}]:[],rowCount:groupFault?1:0} as any;
 if(String(sql).startsWith('SELECT * FROM number_simulation_groups')||String(sql).startsWith('SELECT t.recipient_id FROM warmup_turns'))return{rows:[],rowCount:0} as any;
 throw Error('UNEXPECTED_SYNTHETIC_QUERY');
 });}
afterEach(()=>vi.restoreAllMocks());

it.each(['STOPPED','DISCONNECTED'])('preserves canonical %s across providerFor reconstruction and denies sends before any query',async status=>{
 const query=stub('accepted_timeout');
 for(let n=0;n<2;n++){
  const provider=await providerFor(account(status));
  expect(await provider.health()).toContainEqual(expect.objectContaining({dimension:'session',status:'BLOCKED',value:'STOPPED'}));
  query.mockClear();expect(await provider.send(message)).toEqual({status:'REJECTED',reason:'SIMULATED_SESSION_STOPPED'});expect(query).not.toHaveBeenCalled();
 }
});
it.each(['stop','logout'] as const)('%s stays stopped in the same provider until explicit start/restart',async action=>{
 stub();const provider=await numberSimulator(account());
 expect(await provider.lifecycle(action)).toEqual({status:'STOPPED'});
 expect((await provider.health()).find(s=>s.dimension==='session')?.value).toBe('STOPPED');
 expect((await provider.send(message)).status).toBe('REJECTED');
 expect(await provider.lifecycle(action==='stop'?'start':'restart')).toEqual({status:'WORKING'});
 expect((await provider.health()).find(s=>s.dimension==='session')?.value).toBe('WORKING');
 expect((await provider.send(message)).status).toBe('ACCEPTED');
});
it('preserves the existing initial NEW/start contract and a reconstructed WORKING provider',async()=>{
 stub();const provider=await providerFor(account('NEW'));
 expect((await provider.health()).find(s=>s.dimension==='session')?.value).toBe('WORKING');
 expect(await provider.lifecycle('start')).toEqual({status:'WORKING'});
 const rebuilt=await providerFor(account('WORKING'));expect((await rebuilt.send(message)).status).toBe('ACCEPTED');
});
it.each([['UNKNOWN','UNKNOWN'],['FAILED','REJECTED']] as const)('preserves explicit %s send faults',async(fault,status)=>{
 stub();const provider=await numberSimulator(account('WORKING',fault));expect((await provider.send(message)).status).toBe(status);
});
it('preserves an accepted-with-lost-response group fault while stopping overrides uncertainty',async()=>{
 stub('accepted_timeout');const provider=await numberSimulator(account());expect(await provider.send(message)).toEqual({status:'UNKNOWN',reason:'SIMULATED_ACCEPTED_WITH_LOST_RESPONSE'});
 await provider.lifecycle('stop');expect(await provider.send(message)).toEqual({status:'REJECTED',reason:'SIMULATED_SESSION_STOPPED'});
});
it('keeps REAL and external-provider boundaries unchanged',async()=>{
 stub();await expect(numberSimulator({...account(),environment:'REAL'})).rejects.toThrow('SIMULATION_SCOPE_INVALID');
 await expect(providerFor({...account(),environment:'REAL'})).rejects.toThrow('SIMULATION_SCOPE_INVALID');
 await expect(providerFor({...account(),body:{...account().body,provider:'waha'}})).rejects.toThrow('SIMULATION_EXTERNAL_PROVIDER_DENIED');
});
