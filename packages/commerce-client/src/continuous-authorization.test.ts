import {describe,it,expect,vi} from 'vitest';
import {sessionContinuity,personalContinuity} from './continuous-authorization.js';
import {continuityRoute,continuityResult} from '../../contracts/src/continuous-consumer.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const state=()=>({id:id(1),workspaceId:'one',environment:'REAL',accountId:id(2),source:{kind:'COMMERCIAL_ASSIGNMENT',assignmentId:id(3),assignmentRevision:1,bindingId:id(4)},createdBy:'owner',createdAt:'2026-01-01T00:00:00Z',version:1,humanPaused:false,revokedAt:null,protections:[]});
const command={operation:'command',purpose:'commercial',id:id(1),operationId:id(9),expectedVersion:1,action:'pause'};
describe('shared continuity transport',()=>{
 it.each([{workspaceId:'two'},{url:'https://foreign.invalid'},{headers:{authorization:'changed'}},{operationId:undefined},{reason:'SEND_UNCERTAIN'}])('rejects added selectors or missing id %j before network',async extra=>{
  const fetcher=vi.fn();await expect(sessionContinuity({workspaceId:'one',version:1},fetcher)({...command,...extra})).rejects.toMatchObject({code:'CONTINUITY_INPUT_INVALID'});expect(fetcher).not.toHaveBeenCalled();
 });
 it('sends one scoped POST with preserved operation ID and closed human body',async()=>{
  const fetcher=vi.fn(async()=>Response.json({data:{...state(),humanPaused:true,version:2}})),selection={workspaceId:'one',version:3},client=sessionContinuity(selection,fetcher);
  selection.workspaceId='two';selection.version=4;const result=await client(command);expect(result.data[0].humanPaused).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe('/v2/continuity/commercial/'+id(1)+'/commands');expect(init).toMatchObject({method:'POST',credentials:'include',redirect:'error',cache:'no-store',headers:{'x-commerce-profile-id':'one','x-commerce-profile-version':'3'}});
  expect(JSON.parse(init.body as string)).toEqual({environment:'REAL',operationId:id(9),expectedVersion:1,action:'pause'});
 });
 it('never retries an uncertain write and offers a separate operation receipt read',async()=>{
  const fetcher=vi.fn(async()=>{throw new Error('network outcome unknown');}),client=sessionContinuity({workspaceId:'one',version:1},fetcher);
  await expect(client(command)).rejects.toMatchObject({code:'CONTINUITY_OUTCOME_UNCONFIRMED'});expect(fetcher).toHaveBeenCalledTimes(1);
  expect(continuityRoute({operation:'receipt',purpose:'commercial',operationId:id(9)})).toMatchObject({method:'GET',route:'/v2/continuity/commercial/operations/'+id(9)+'?environment=REAL',body:undefined});
 });
 it.each([408,425,429,500,502,504])('preserves uncertain HTTP %i writes without retry',async status=>{
  const fetcher=vi.fn(async()=>new Response('untrusted upstream body',{status}));await expect(sessionContinuity({workspaceId:'one',version:1},fetcher)(command)).rejects.toMatchObject({code:'CONTINUITY_OUTCOME_UNCONFIRMED',status});expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('binds command confirmation and permits an already-applied no-op at its exact version',()=>{
  const request=continuityRoute(command).value;
  for(const row of [state(),{...state(),humanPaused:true,version:3},{...state(),humanPaused:true,revokedAt:'2026-01-02T00:00:00Z'}])expect(()=>continuityResult({data:row},request,'one')).toThrow('CONTINUITY_COMMAND_UNCONFIRMED');
  expect(continuityResult({data:{...state(),humanPaused:true}},request,'one').data[0].version).toBe(1);
  const issue=continuityRoute({operation:'issue',purpose:'commercial',operationId:id(9),assignmentId:id(3),expectedRevision:1}).value;
  expect(()=>continuityResult({data:{...state(),source:{...state().source,assignmentRevision:2}}},issue,'one')).toThrow('CONTINUITY_RESPONSE_ORIGIN_CHANGED');
 });
 it('rejects foreign profile, purpose and environment even on HTTP 200',async()=>{
  for(const changes of [{workspaceId:'two'},{environment:'SIMULATION'},{source:{kind:'VERIFIED_QR_CONNECTION',connectionId:id(9),identityFingerprint:'a'.repeat(64)}}]){
   const client=sessionContinuity({workspaceId:'one',version:1},async()=>Response.json({data:{...state(),...changes}}));
   await expect(client({operation:'get',purpose:'commercial',id:id(1)})).rejects.toMatchObject({code:'CONTINUITY_OUTCOME_UNCONFIRMED'});
  }
 });
 it('bounds response data and never exposes provider error text',async()=>{
  const client=sessionContinuity({workspaceId:'one',version:1},async()=>new Response('x'.repeat(2*1024*1024+1)));
  await expect(client(command)).rejects.toMatchObject({code:'CONTINUITY_OUTCOME_UNCONFIRMED'});
  await expect(sessionContinuity({workspaceId:'one',version:1},async()=>new Response('sensitive error',{status:403}))(command)).rejects.toMatchObject({code:'CONTINUITY_REQUEST_REJECTED',status:403});
 });
 it('keeps fixed PAT separate from cookies and forbids nonlocal HTTP origins',async()=>{
  for(const origin of ['http://example.invalid','https://user:pass@example.invalid','https://example.invalid/path'])expect(()=>personalContinuity(origin,'cos_pat_'+'x'.repeat(43))).toThrow('CONTINUITY_AUTHORITY_REQUIRED');
  const fetcher=vi.fn(async()=>Response.json({data:null})),client=personalContinuity('https://example.invalid','cos_pat_'+'x'.repeat(43),fetcher);
  await client({operation:'receipt',purpose:'commercial',operationId:id(9)});expect(fetcher.mock.calls[0]).toEqual([expect.any(String),expect.objectContaining({credentials:'omit',headers:{authorization:'Bearer cos_pat_'+'x'.repeat(43)}})]);
 });
 it('rejects duplicate or out of order pages and false next cursor',()=>{
  const request=continuityRoute({operation:'list',purpose:'commercial',limit:2}).value;
  for(const value of [{data:[state(),state()],nextAfterId:null},{data:[state()],nextAfterId:id(1)}])expect(()=>continuityResult(value,request,'one')).toThrow('CONTINUITY_PAGE_INVALID');
 });
});
