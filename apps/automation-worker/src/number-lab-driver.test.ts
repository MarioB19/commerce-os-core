import {describe,it,expect,vi} from 'vitest';
import {createNumberLabDriver,numberLabDriverDependency} from './number-lab-driver.js';
import type {ProfileConnection} from '../../../packages/db/src/profile-context.js';
import type {NumberLabAction} from '../../../packages/contracts/src/number-laboratory.js';
const id='00000000-0000-4000-8000-000000000001';
describe('closed number laboratory driver boundary',()=>{
 it.each<NumberLabAction>([{type:'message',text:'hello'},{type:'select_variant',variant_id:id,origin:'EXPLICIT'},{type:'advance',hours:2},{type:'continue'}])('keeps supported action $type in CHAT',action=>expect(numberLabDriverDependency(action,'CHAT')).toBeNull());
 it.each<NumberLabAction>([{type:'receipt',attachment_id:id},{type:'review_receipt',receipt_id:id,decision:'APPROVED',reason:'Synthetic explicit review'}])('does not turn $type into a fabricated attachment',action=>expect(numberLabDriverDependency(action,'CHAT')).toBe('LAB_ATTACHMENT_DRIVER_REQUIRED'));
 it('preserves the canonical first-turn boundary without truncating input',()=>{expect(numberLabDriverDependency({type:'message',text:'x'.repeat(4096)},'CHAT')).toBeNull();expect(numberLabDriverDependency({type:'message',text:'x'.repeat(4097)},'CHAT')).toBe('CANONICAL_MESSAGE_LIMIT');});
 it('never claims an automatic case was executed by the interactive driver',()=>expect(numberLabDriverDependency({type:'continue'},'AUTOMATIC')).toBe('AUTOMATIC_DRIVER_REQUIRED'));
 it.each(['execute','observe','reconcile']as const)('rejects caller executor/pool/environment before %s IO',async method=>{
  const connect=vi.fn(),pool={connect},materials={copy:vi.fn()},driver=createNumberLabDriver({controlPool:pool,seedPool:pool,enginePool:pool,identity:{database:'commerce_lab_engine_unit',installationId:id,engineSha256:'c'.repeat(64)},key:new Uint8Array(32),materials});
  await expect(driver[method]({workspaceId:'x',runId:id,operationId:id,environment:'REAL'})).rejects.toThrow();expect(connect).not.toHaveBeenCalled();expect(materials.copy).not.toHaveBeenCalled();
 });
 it('bounds a starved control pool and releases a late connection without any SQL',async()=>{
  vi.useFakeTimers();let resolve:(c:ProfileConnection)=>void=()=>undefined;const query=vi.fn(),release=vi.fn(),pool={connect:()=>new Promise<ProfileConnection>(r=>{resolve=r;})};
  const driver=createNumberLabDriver({controlPool:pool,seedPool:pool,enginePool:pool,identity:{database:'commerce_lab_engine_unit',installationId:id,engineSha256:'c'.repeat(64)},key:new Uint8Array(32),materials:{copy:vi.fn()}});
  try{const rejected=expect(driver.observe({workspaceId:'x',runId:id,operationId:id})).rejects.toThrow('LAB_CONTROL_CONNECTION_TIMEOUT');await vi.advanceTimersByTimeAsync(2000);await rejected;resolve({query,release});await Promise.resolve();await Promise.resolve();expect(release).toHaveBeenCalledOnce();expect(query).not.toHaveBeenCalled();}finally{vi.useRealTimers();}
 });

});
