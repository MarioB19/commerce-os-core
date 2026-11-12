import {describe,expect,it} from 'vitest';
import {classifyHealthReadFailure,healthFreezeCause} from '../../apps/channel-worker/src/lifecycle.js';
import {backupCurrent,diskCondition,diskThresholds} from '../../apps/automation-worker/src/operations-monitor.js';
import {healthSample} from '../../apps/automation-worker/src/warmup.js';
import {effectiveProgramState} from '../../packages/db/src/group-warmup.js';
import {MCP_CAPABILITIES,MCP_RELEASE,mcpCompatibility} from '../../packages/contracts/src/mcp-capabilities.js';
import {ProviderError} from '../../packages/messaging/src/types.js';

/** V7.5 pure decisions (docs/adr-v7-5-resilience.md); no database or network. */
describe('V7.5 H05: provider read failures keep their class',()=>{
 it.each([
  [Object.assign(new Error('The operation was aborted due to timeout'),{name:'TimeoutError'}),'PROVIDER_READ_TIMEOUT','unavailable',true],
  [new ProviderError('PROVIDER_HTTP_401',401),'PROVIDER_AUTHENTICATION_REJECTED','not_authorized',false],
  [new ProviderError('PROVIDER_HTTP_503',503),'PROVIDER_SERVER_ERROR','unavailable',true],
  [new ProviderError('PROVIDER_HTTP_429',429),'PROVIDER_RATE_LIMITED','unavailable',true],
  [new ProviderError('GROUP_LIST_RESPONSE_UNSUPPORTED'),'PROVIDER_RESPONSE_INVALID','unavailable',true],
  [new TypeError('fetch failed'),'PROVIDER_TRANSPORT_UNAVAILABLE','unavailable',true],
  [new Error('GATEWAY_ISOLATION_UNVERIFIED'),'GATEWAY_ISOLATION_UNVERIFIED','unavailable',false],
  [new Error('something else'),'PROVIDER_CONFIGURATION_OR_CONNECTION_UNAVAILABLE','unavailable',true],
 ] as const)('%s → %s',(error,code,availability,retryable)=>{
  const r=classifyHealthReadFailure(error,1234.4);
  expect(r).toMatchObject({code,availability,retryable,phase:'provider_health_read',duration_ms:1234});
  expect(JSON.stringify(r)).not.toMatch(/key|token|secret/i);
 });
 it('only 401/403 is a not-authorized availability',()=>{
  expect(classifyHealthReadFailure(new ProviderError('PROVIDER_HTTP_403',403),1).availability).toBe('not_authorized');
  expect(classifyHealthReadFailure(new ProviderError('PROVIDER_HTTP_500',500),1).availability).toBe('unavailable');
 });
});
describe('V7.5 H12: freeze causes',()=>{
 it('a confirmed stop with clear restriction and identity is a recoverable disconnection',()=>{
  expect(healthFreezeCause({blocked:true,identityChanged:false,blockers:['SESSION_BLOCKED'],session:'STOPPED'})).toEqual({freeze:'HEALTH_DISCONNECTED',incident:'SESSION_DISCONNECTED'});
 });
 it.each([
  [{blocked:true,identityChanged:true,blockers:['SESSION_BLOCKED'],session:'STOPPED'}],
  [{blocked:true,identityChanged:false,blockers:['SESSION_BLOCKED','RESTRICTION_BLOCKED'],session:'STOPPED'}],
  [{blocked:true,identityChanged:false,blockers:['SESSION_BLOCKED','RESTRICTION_UNKNOWN'],session:'STOPPED'}],
  [{blocked:true,identityChanged:false,blockers:['SESSION_BLOCKED'],session:'FAILED'}],
  [{blocked:true,identityChanged:false,blockers:['QUALITY_BLOCKED'],session:'WORKING'}],
 ])('anything else that blocks is not recoverable automatically (%#)',input=>{
  expect(healthFreezeCause(input).freeze).toBe('HEALTH_BLOCKED');
 });
 it('an incomplete read is an unknown freeze, not a disconnection',()=>{
  expect(healthFreezeCause({blocked:false,identityChanged:false,blockers:['SESSION_UNKNOWN'],session:'UNKNOWN'})).toEqual({freeze:'HEALTH_UNKNOWN',incident:'HEALTH_UNKNOWN'});
 });
});
describe('V7.5 H01: breaker samples',()=>{
 it('confirmed down or blocking reads are failures; unreadable ones are unknown',()=>{
  expect(healthSample({status:'UNKNOWN',health_status:'UNKNOWN'})).toBe('UNKNOWN');
  expect(healthSample({status:'STARTING',health_status:'UNKNOWN'})).toBe('UNKNOWN');
  expect(healthSample({status:'STOPPED',health_status:'BLOCKED'})).toBe('FAILED');
  expect(healthSample({status:'WORKING',health_status:'BLOCKED'})).toBe('FAILED');
  expect(healthSample({status:'SCAN_QR_CODE',health_status:'UNKNOWN'})).toBe('FAILED');
 });
});
describe('V7.5 H03: effective program state',()=>{
 const base={pool:{breaker_open:false},numbers:[{id:'a',connected:true,ownership:'OPERATIONAL',reason:null},{id:'b',connected:true,ownership:'OPERATIONAL',reason:null}],history:[] as any[],senderIds:['a','b'],config:{timezone:'UTC',startHour:0,endHour:23}};
 const at=new Date('2026-11-12T12:00:00Z');
 it('ACTIVE with an open protection is PROTECTED, never running',()=>{
  expect(effectiveProgramState({...base,status:'ACTIVE',pool:{breaker_open:true,breaker_reason:'DISTINCT_ACCOUNT_FAILURE_THRESHOLD'},now:at})).toMatchObject({state:'PROTECTED',nextAction:'REVIEW_AND_RECOVER_PROTECTION',nextSend:null,reasons:['DISTINCT_ACCOUNT_FAILURE_THRESHOLD']});
 });
 it('distinguishes a person’s pause, a missing connection or ownership, quiet hours, pending ACK and real sending',()=>{
  expect(effectiveProgramState({...base,status:'PAUSED',now:at}).state).toBe('PAUSED_BY_HUMAN');
  expect(effectiveProgramState({...base,status:'ACTIVE',numbers:[{...base.numbers[0],connected:false},base.numbers[1]],now:at}).state).toBe('NEEDS_CONNECTION');
  expect(effectiveProgramState({...base,status:'ACTIVE',numbers:[{...base.numbers[0],ownership:'FROZEN'},base.numbers[1]],now:at}).state).toBe('NEEDS_OWNERSHIP');
  expect(effectiveProgramState({...base,status:'ACTIVE',config:{timezone:'UTC',startHour:1,endHour:2},now:at}).state).toBe('WAITING_WINDOW');
  expect(effectiveProgramState({...base,status:'ACTIVE',history:[{sent:2,delivered:1,pending:0,uncertain:0,next_send:null}],now:at}).state).toBe('WAITING_ACK');
  const running=effectiveProgramState({...base,status:'ACTIVE',history:[{sent:0,delivered:0,pending:3,uncertain:0,next_send:'2026-11-12T12:05:00Z'}],now:at});
  expect(running).toMatchObject({state:'RUNNING',nextSend:{at:'2026-11-12T12:05:00.000Z',conditional:false}});
  expect(effectiveProgramState({...base,status:'ACTIVE',numbers:[{...base.numbers[0],reason:'GROUP_MEMBERSHIP_STALE'},base.numbers[1]],now:at})).toMatchObject({state:'GROUP_READ_STALE',nextAction:'REFRESH_GROUPS'});
 });
});
describe('V7.5 R01 and H11: monitor decisions',()=>{
 const GiB=1024**3;
 it('warns early with hysteresis and keeps the critical floor',()=>{
  expect(diskCondition({available_bytes:23*GiB,total_bytes:125*GiB},false)).toEqual({critical:false,warning:true});
  expect(diskCondition({available_bytes:26*GiB,total_bytes:125*GiB},true)).toEqual({critical:false,warning:true});
  expect(diskCondition({available_bytes:26*GiB,total_bytes:125*GiB},false)).toEqual({critical:false,warning:false});
  expect(diskCondition({available_bytes:28*GiB,total_bytes:125*GiB},true)).toEqual({critical:false,warning:false});
  expect(diskCondition({available_bytes:0.5*GiB,total_bytes:125*GiB},false)).toEqual({critical:true,warning:true});
  expect(diskThresholds.warnFreeRatio).toBeLessThan(diskThresholds.clearFreeRatio);
 });
 it('backup currency follows the producer that runs and keeps failures and staleness visible',()=>{
  const now=new Date('2026-11-12T12:00:00Z'),h=(n:number)=>new Date(now.getTime()-n*3600_000).toISOString();
  expect(backupCurrent({runs:{last_success_at:h(2),last_full_at:h(24),last_failure_at:null},now})).toEqual({current:true,source:'PITR_RUNS'});
  expect(backupCurrent({runs:{last_success_at:h(2),last_full_at:h(24),last_failure_at:h(1)},now})).toEqual({current:false,source:'LAST_BACKUP_RUN_FAILED'});
  expect(backupCurrent({runs:{last_success_at:h(40),last_full_at:h(40),last_failure_at:null},now}).source).toBe('BACKUP_STALE');
  expect(backupCurrent({runs:{last_success_at:h(2),last_full_at:h(24*9),last_failure_at:null},now}).source).toBe('FULL_BACKUP_STALE');
  expect(backupCurrent({runs:null,now}).source).toBe('NO_VERIFIED_BACKUP_OBSERVED');
  expect(backupCurrent({evidence:{status:'VERIFIED',expires_at:h(-1)},runs:null,now})).toEqual({current:true,source:'VERIFIED_EXTERNAL_EVIDENCE'});
  expect(backupCurrent({evidence:{status:'VERIFIED',expires_at:h(1)},runs:null,now}).current).toBe(false);
 });
});
describe('V7.5 H04: MCP compatibility is by capability, not by tool count',()=>{
 it('reports exactly what an older client lacks',()=>{
  const server={version:MCP_RELEASE,capabilities:[...MCP_CAPABILITIES]};
  expect(mcpCompatibility({version:MCP_RELEASE,capabilities:[...MCP_CAPABILITIES]},server)).toEqual({compatible:true,missing:[],update:null});
  const v72={version:'7.0.0',capabilities:MCP_CAPABILITIES.filter(c=>!/audienceConfirmed|cambiar_calentamiento|reintentar|recuper|revisar|conciliar|acusar_todos|cursor|directo|version|confirmar_desvinculacion/.test(c))};
  const result=mcpCompatibility(v72,server);
  expect(result.compatible).toBe(false);expect(result.missing).toContain('warmup_manage.iniciar.audienceConfirmed');expect(result.missing).toContain('warmup_manage.recuperar_proteccion');expect(result.update).toMatch(/Actualiza el paquete MCP/);
 });
});
