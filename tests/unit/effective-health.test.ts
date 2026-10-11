import {describe,expect,it} from 'vitest';
import {currentEffectiveSignal,currentProviderHealthReady,currentRestrictionClear,effectiveHealthBlockers,selectEffectiveHealth} from '../../packages/db/src/effective-health.js';

const now=new Date('2026-09-22T12:00:00.000Z'),account='00000000-0000-4000-8000-000000000001';
const row=(id:string,dimension:string,status:string,observed_at:string,expires_at:string,created_at=observed_at,value:unknown=null,source='provider_read')=>({id,created_at,body:{account_id:account,dimension,status,scope:'account',source,value,observed_at,expires_at}});

describe('effective channel health',()=>{
	 it('keeps expired restriction history without letting it govern newer current evidence',()=>{
  const blocked=row('blocked','restriction','BLOCKED','2026-09-22T11:55:00.000Z','2026-09-22T11:56:00.000Z');
  const unknown=row('unknown','restriction','UNKNOWN','2026-09-22T11:59:00.000Z','2026-09-22T12:01:00.000Z');
  const selected=selectEffectiveHealth([blocked,unknown],{now,accountId:account});
	  expect(selected.by_dimension.restriction).toMatchObject({id:'unknown',status:'UNKNOWN',current:true});
	  expect(selected.latest_by_dimension.restriction).toMatchObject({id:'unknown',status:'UNKNOWN'});
	  expect(effectiveHealthBlockers(selectEffectiveHealth([blocked],{now,accountId:account}))).toEqual([]);
	 });

 it('only a later explicit provider OK clears a confirmed restriction',()=>{
  const blocked=row('blocked','restriction','BLOCKED','2026-09-22T11:55:00.000Z','2026-09-22T11:56:00.000Z');
 const partial=row('partial','restriction','OK','2026-09-22T11:57:00.000Z','2026-09-22T12:01:00.000Z','2026-09-22T11:57:00.000Z',{latest_read:{timelock:true,capping:false}});
	  expect(selectEffectiveHealth([blocked,partial],{now,accountId:account}).by_dimension.restriction).toMatchObject({id:'partial',status:'UNKNOWN',current:true});
  const legacy=row('legacy','restriction','OK','2026-09-22T11:57:30.000Z','2026-09-22T12:01:00.000Z');
	  expect(selectEffectiveHealth([blocked,legacy],{now,accountId:account}).by_dimension.restriction).toMatchObject({id:'legacy',status:'UNKNOWN',current:true});
  const clear=row('clear','restriction','OK','2026-09-22T11:58:00.000Z','2026-09-22T12:01:00.000Z','2026-09-22T11:58:00.000Z',{latest_read:{timelock:true,capping:true}});
  const selected=selectEffectiveHealth([blocked,partial,clear],{now,accountId:account});
  expect(selected.by_dimension.restriction).toMatchObject({id:'clear',status:'OK',explicit_restriction_clear:true});
  expect(currentRestrictionClear(selected)).toBe(true);
  expect(currentRestrictionClear(selectEffectiveHealth([{...clear,body:{...clear.body,expires_at:'2026-09-22T11:59:59.000Z'}}],{now,accountId:account}))).toBe(false);
 });

 it('invalidates malformed and future observations before deterministic ordering',()=>{
  const current=row('a','session','OK','2026-09-22T11:59:00.000Z','2026-09-22T12:01:00.000Z','2026-09-22T11:59:01.000Z');
  const sameObservedNewerCreated=row('b','session','BLOCKED','2026-09-22T11:59:00.000Z','2026-09-22T12:01:00.000Z','2026-09-22T11:59:02.000Z');
  const future=row('future','session','OK','2026-09-22T12:00:00.001Z','2026-09-22T12:11:00.000Z');
  const zeroWindow=row('zero-window','transport','OK','2026-09-22T11:59:00.000Z','2026-09-22T11:59:00.000Z');
  const malformed={id:'malformed',created_at:'2026-09-22T11:59:03.000Z',body:{account_id:account,dimension:'session',status:'OK',observed_at:'not-a-date',expires_at:'also-not-a-date'}};
  const selected=selectEffectiveHealth([current,sameObservedNewerCreated,future,zeroWindow,malformed],{now,accountId:account});
  expect(selected.by_dimension.session?.id).toBe('b');
  expect(selected.invalid.map(item=>item.reason).sort()).toEqual(['EXPIRY_WINDOW_INVALID','OBSERVED_AT_FUTURE','OBSERVED_AT_INVALID']);
 });

 it('uses TTL for non-restriction dimensions',()=>{
  const stale=row('stale','transport','OK','2026-09-22T11:50:00.000Z','2026-09-22T11:51:00.000Z');
  const selected=selectEffectiveHealth([stale],{now,accountId:account});
  expect(selected.by_dimension.transport).toMatchObject({status:'OK',current:false});
 expect(currentEffectiveSignal(selected,'transport')).toBeUndefined();
 });

 it('requires current official quality for Cloud while allowing current yellow quality',()=>{
  const transport=row('transport','transport','OK','2026-09-22T11:59:00.000Z','2026-09-22T12:01:00.000Z');
  expect(currentProviderHealthReady(selectEffectiveHealth([transport],{now,accountId:account}),'cloud')).toBe(false);
  const unknown=row('quality-unknown','quality','UNKNOWN','2026-09-22T11:59:01.000Z','2026-09-22T12:01:00.000Z');
  expect(currentProviderHealthReady(selectEffectiveHealth([transport,unknown],{now,accountId:account}),'cloud')).toBe(false);
  const yellow=row('quality-yellow','quality','WARNING','2026-09-22T11:59:02.000Z','2026-09-22T12:01:00.000Z','2026-09-22T11:59:02.000Z','YELLOW');
  expect(currentProviderHealthReady(selectEffectiveHealth([transport,yellow],{now,accountId:account}),'cloud')).toBe(true);
  const red=row('quality-red','quality','BLOCKED','2026-09-22T11:59:03.000Z','2026-09-22T12:01:00.000Z','2026-09-22T11:59:03.000Z','RED');
  expect(currentProviderHealthReady(selectEffectiveHealth([transport,yellow,red],{now,accountId:account}),'cloud')).toBe(false);
 });
});
