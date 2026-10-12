import {describe,it,expect,vi} from 'vitest';
import {marketVariantsView,marketPriceMinor,marketPriceText} from './market-variants.js';
import {MarketClientError,type MarketClient} from '../../../../packages/commerce-client/src/market-variants.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const adopt={operation:'adopt' as const,body:{product_id:id(1),expected_product_version:1}};
describe('exact price conversion',()=>{
 it.each([['10.01','MXN',1001],['17','JPY',17],['1.234','KWD',1234]] as const)('converts %s %s without float rounding',(value,currency,minor)=>{
  expect(marketPriceMinor(value,currency)).toBe(minor);expect(marketPriceText(minor,currency)).toBe(value);
 });
 it.each(['0.001','1e3','-1','10,20','01','9007199254740991.01'])('rejects malformed or excessive MXN price %s',price=>{
  expect(()=>marketPriceMinor(price,'MXN')).toThrow();
 });
});
function deferred(){let resolve!:(value:{data:{id:string}})=>void;const promise=new Promise<{data:{id:string}}>(yes=>{resolve=yes;});return{promise,resolve};}
describe('selected market view',()=>{
 it('fixes environment and operation identity before one write',async()=>{
  const client=vi.fn().mockResolvedValue({data:{id:id(1)}}),view=marketVariantsView(client,'SIMULATION','p',()=>id(9));
  await view.write(adopt);expect(client).toHaveBeenCalledTimes(1);
  expect(client.mock.calls[0]![0]).toEqual({...adopt,environment:'SIMULATION',operation_id:id(9)});
  expect(view.snapshot().status).toBe('READY');expect(view.snapshot().pending).toBeNull();
 });
 it('blocks duplicate clicks while a write is pending',async()=>{
  const d=deferred(),client=vi.fn(()=>d.promise),view=marketVariantsView(client,'REAL','p',()=>id(9));
  const first=view.write(adopt);await view.write(adopt);await view.read({operation:'get',id:id(1)});
  expect(client).toHaveBeenCalledTimes(1);d.resolve({data:{id:id(1)}});await first;
 });
 it('does not accept a mismatched successful write receipt',async()=>{
  const view=marketVariantsView(vi.fn().mockResolvedValue({data:{id:id(2)}}),'REAL','p',()=>id(9));
  await view.write(adopt);expect(view.snapshot().status).toBe('UNCERTAIN');
  expect(view.snapshot().pending?.operation_id).toBe(id(9));
 });
 it('retains frozen input through mutation and an uncertain response',async()=>{
  const client=vi.fn().mockRejectedValue(new Error('unknown')),view=marketVariantsView(client,'REAL','p',()=>id(9));
  const input=structuredClone(adopt);await view.write(input);input.body.expected_product_version=5;
  expect(view.snapshot().pending).toMatchObject({body:{expected_product_version:1}});
  expect(Object.isFrozen(view.snapshot().pending?.body)).toBe(true);
  await view.write(adopt);await view.resend();expect(client).toHaveBeenCalledTimes(1);
 });
 it('reconciles explicitly and validates the original operation',async()=>{
  const client=vi.fn().mockRejectedValueOnce(Error('unknown')).mockResolvedValueOnce({data:{id:id(2)}}).mockResolvedValueOnce({data:{id:id(1)}});
  const view=marketVariantsView(client,'REAL','p',()=>id(9));await view.write(adopt);await view.reconcile();
  expect(view.snapshot().status).toBe('UNCERTAIN');expect(view.snapshot().mayResend).toBe(false);
  await view.reconcile();expect(view.snapshot().status).toBe('READY');expect(view.snapshot().pending).toBeNull();
  expect(client.mock.calls[1]![0]).toEqual({operation:'reconcile',environment:'REAL',id:id(9)});
 });
 it('permits only a deliberate same-UUID/content resend after a 404 lookup',async()=>{
  const client=vi.fn().mockRejectedValueOnce(Error('unknown')).mockRejectedValueOnce(new MarketClientError('MARKET_OPERATION_NOT_FOUND',404)).mockResolvedValueOnce({data:{id:id(1)}});
  const next=vi.fn(()=>id(9)),view=marketVariantsView(client,'REAL','p',next);
  await view.write(adopt);await view.reconcile();expect(client).toHaveBeenCalledTimes(2);expect(view.snapshot().mayResend).toBe(true);
  await view.resend();expect(next).toHaveBeenCalledTimes(1);expect(client.mock.calls[2]![0]).toEqual(client.mock.calls[0]![0]);
  expect(view.snapshot().status).toBe('READY');
 });
 it.each([401,403,404,409,429,500,504])('does not enable resend after lookup HTTP %s',async status=>{
  const client=vi.fn().mockRejectedValueOnce(Error('unknown')).mockRejectedValue(new MarketClientError('MARKET_READ_UNCONFIRMED',status));
  const view=marketVariantsView(client,'REAL','p',()=>id(9));await view.write(adopt);await view.reconcile();await view.resend();
  expect(client).toHaveBeenCalledTimes(2);expect(view.snapshot().mayResend).toBe(false);
 });
 it('disposal aborts the request and hides a late successful write',async()=>{
  const d=deferred();let signal:AbortSignal|undefined;const client:MarketClient=(_q,s)=>{signal=s;return d.promise;};
  const view=marketVariantsView(client,'REAL','p',()=>id(9)),notify=vi.fn();view.subscribe(notify);
  const sending=view.write(adopt);view.dispose();const prior=notify.mock.calls.length;
  expect(signal?.aborted).toBe(true);d.resolve({data:{id:id(1)}});await sending;
  expect(notify).toHaveBeenCalledTimes(prior);expect(view.snapshot().status).toBe('WRITING');
  await view.write(adopt);expect(notify).toHaveBeenCalledTimes(prior);
 });
 it('independent A→B→A views cannot resurrect earlier result',async()=>{
  const d=deferred(),a=marketVariantsView(()=>d.promise,'REAL','a'),b=marketVariantsView(vi.fn(),'REAL','b');
  const pending=a.read({operation:'get',id:id(1)});a.dispose();b.dispose();
  const newA=marketVariantsView(vi.fn(),'REAL','a');d.resolve({data:{id:id(1)}});await pending;
  expect(newA.snapshot().result).toBeNull();expect(newA.snapshot().status).toBe('IDLE');
 });
 it('invalid command rejects before any transport',async()=>{
  const client=vi.fn(),view=marketVariantsView(client,'REAL','p',()=>id(9));
  await expect(view.write({...adopt,body:{...adopt.body,expected_product_version:0}})).rejects.toThrow();
  expect(client).not.toHaveBeenCalled();expect(view.snapshot().status).toBe('IDLE');
 });
});
