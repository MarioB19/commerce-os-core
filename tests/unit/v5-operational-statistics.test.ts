import {it,expect} from 'vitest';
import {deliveryTrend,operationalStatistics} from '../../packages/domain/src/health/operational-statistics.js';
import {type EffectSample,type Evidence} from '../../packages/domain/src/health/number-health.js';
import {explicitProviderTimestamp} from '../../packages/messaging/src/normalize.js';
const now=new Date('2026-09-14T12:00:00Z'),at=(clock:string)=>'2026-09-14T'+clock+'Z';
it('compares disjoint mature cohorts to an independently counted prior window without alerting',()=>{
 const samples:EffectSample[]=[];for(const [hour,timely]of [[10,18],[11,15]])for(let i=0;i<20;i++)samples.push({id:hour+':'+i,purpose:'COMMERCIAL',attempted_at:at(hour+':15:00'),accepted_at:at(hour+':15:00'),delivered_at:at(hour+':'+(i<timely!?'16':'25')+':00'),status:'DELIVERED',physical_attempts:1,peer_id:'repeated-peer'});
 samples.push({id:'immature',purpose:'COMMERCIAL',attempted_at:at('11:59:00'),accepted_at:at('11:59:00'),status:'SENT',physical_attempts:1});
 const result=deliveryTrend(samples,now,1,300);expect(result.status).toBe('DESCRIPTIVE_COMPARISON');expect(result.current).toMatchObject({numerator:15,denominator:20});expect(result.baseline).toMatchObject({numerator:18,denominator:20});expect(result.change_percentage_points).toBeCloseTo(-15,10);expect(result.baseline_window.end).toBe(result.current_window.start);expect(result.alerts).toBe('CALIBRATION_REQUIRED');expect(result.interpretation).toContain('correlated');
 expect(deliveryTrend(samples.filter(s=>s.id!=='10:0'),now,1,300)).toMatchObject({status:'INSUFFICIENT_BASELINE',change_percentage_points:null});
 expect(deliveryTrend([],now,168,1800).baseline.value).toBeNull();
});
it('integrates only valid session intervals, counts observed transitions and leaves gaps unknown',()=>{
 const signal=(observed:string,expires:string,status:string):Evidence=>({dimension:'session',scope:'account',source:'provider_event',observed_at:at(observed),expires_at:at(expires),status});
 const signals=[signal('10:59:00','11:15:00','OK'),signal('11:10:00','11:30:00','BLOCKED'),signal('11:20:00','11:40:00','OK'),signal('11:50:00','12:05:00','BLOCKED')];
 const result=operationalStatistics({now,hours:1,signals:[...signals,signals[1]!],dimension:'session',envelopes:[],queue:[],simulation:false});
 expect(result.session).toMatchObject({connected_seconds:1800,disconnected_seconds:1200,unknown_seconds:600,observed_seconds:3000,reconnections_observed:1,disconnections_observed:2,observations:3});expect(result.session.coverage).toBeCloseTo(5/6,12);expect(result.webhook.ingress_seconds.median).toBeNull();expect(result.backlog.oldest_due_seconds).toBeNull();expect(result.alerts.automatic_statistical_alerts).toBe(false);
 const empty=operationalStatistics({now,hours:1,signals:[],dimension:'session',envelopes:[],queue:[],simulation:true});expect(empty.session).toMatchObject({availability:'NO_EVIDENCE',connected_seconds:null,disconnected_seconds:null,unknown_seconds:3600,reconnections_observed:null});expect(empty.environment_basis).toBe('SIMULATION_VIRTUAL_NOT_REAL_TIME');
});
it('distinguishes durable ingress latency, processing delay, unknown timestamps and current backlog',()=>{
 const result=operationalStatistics({now,hours:1,signals:[],dimension:'transport',simulation:false,envelopes:[{id:'1',received_at:at('11:10:00'),processed_at:at('11:12:00'),provider_at:at('11:09:00'),status:'PROCESSED'},{id:'2',received_at:at('11:20:00'),processed_at:at('11:25:00'),provider_at:at('11:22:00'),status:'PROCESSED'},{id:'3',received_at:at('11:40:00'),status:'PENDING'}],queue:[{id:'1',created_at:at('10:00:00'),not_before:at('10:01:00'),status:'READY'},{id:'2',created_at:at('11:00:00'),not_before:at('11:30:00'),status:'BLOCKED'},{id:'3',created_at:at('11:00:00'),not_before:at('13:00:00'),status:'READY'},{id:'4',created_at:at('11:00:00'),not_before:at('11:00:00'),status:'UNKNOWN'}]});
 expect(result.webhook.processing_seconds).toMatchObject({median:120,p95:300,n:2,eligible:3});expect(result.webhook.ingress_seconds).toMatchObject({median:60,p95:60,n:1,eligible:3,missing_timestamp:1,clock_skew:1});expect(result.webhook.oldest_pending_seconds).toBe(1200);expect(result.backlog).toMatchObject({due:2,blocked:1,scheduled:1,unknown:1,oldest_due_seconds:7200});
});
it('extracts only explicit provider timestamps scoped to the Cloud number, with no receipt fallback',()=>{
 expect(explicitProviderTimestamp('waha',{payload:{timestamp:1789387200}})?.provider_event_at).toBe('2026-09-14T12:00:00.000Z');expect(explicitProviderTimestamp('waha',{payload:{body:'private text'}})).toBeNull();expect(explicitProviderTimestamp('waha',{payload:{timestamp:'broken'}})).toBeNull();expect(explicitProviderTimestamp('cloud',{entry:[null,{changes:[null,{value:{messages:[null]}}]}]})).toBeNull();
 expect(explicitProviderTimestamp('cloud',{entry:[{changes:[{value:{metadata:{phone_number_id:'B'},messages:[{timestamp:1}]}},{value:{metadata:{phone_number_id:'A'},statuses:[{timestamp:1789387200}]}}]}]},'A')).toEqual({provider_event_at:'2026-09-14T12:00:00.000Z',provider_timestamp_count:1});
});
