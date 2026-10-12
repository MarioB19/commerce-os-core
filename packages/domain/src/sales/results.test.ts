import {describe,it,expect} from 'vitest';
import {resultFiltersSchema,resultDailyFactsSchema,goalFieldsSchema,type ResultDailyFacts,type ResultSpend} from '../../../contracts/src/results.js';
import {summarizeResults,decimalRatio,previousResultsPeriod,resultBucket} from './results.js';
const day='2026-10-11',q=resultFiltersSchema.parse({from:day,to:day,currency:'MXN'});
const facts=(patch:Partial<ResultDailyFacts>={}):ResultDailyFacts=>({day,currency:'MXN',dimensions:{family_id:null,variant_id:null,market:null,account_id:null,campaign_id:null,ad_id:null,touch:'UNKNOWN'},funnel:{started:'10',responded:'8',offered:'6',collection_sent:'5',receipt_received:'4',payment_approved:'3'},revenue_minor:'5000',sales:'4',attributed_revenue_minor:'4000',attributed_sales:'3',response_ms_sum:'24000',response_samples:'8',sale_ms_sum:'300000',sale_samples:'3',ai_cost_microusd:'120000',ai_cost_unknown_attempts:'0',ai_input_tokens:'1000',ai_output_tokens:'300',ai_cache_read_tokens:'0',ai_cache_write_tokens:'0',ai_audio_input_tokens:'0',ai_tokens_unknown_attempts:'0',...patch});
const costs=(patch:Partial<ResultSpend>={}):ResultSpend=>({day,currency:'MXN',cut:{},spend_minor:'2000',attributed_conversations:'8',comparable:true,reason:null,...patch});
describe('profile results money and evidence composition',()=>{
 it('keeps cohort conversion separate from order sales and comparable Meta metrics',()=>{
  const r=summarizeResults([facts()],[costs()],q);
  expect(r.conversion.value).toBe('0.300000');expect(r.average_ticket_minor.value).toBe('1250.000000');expect(r.cost_per_sale_minor.value).toBe('666.666667');expect(r.roas.value).toBe('2.000000');expect(r.cost_per_conversation_minor.value).toBe('250.000000');
  expect(r.first_response_ms.value).toBe('3000.000000');expect(r.first_sale_ms.value).toBe('100000.000000');expect(r.ai).toMatchObject({currency:'USD',unit:'microUSD',cost:{value:'120000'},per_sale:{value:'30000.000000'}});
 });
 it('never sums other currency rows or claims a conversion from no conversations',()=>{
  const r=summarizeResults([facts({currency:'USD'})],[costs({currency:'USD'})],q);expect(r.totals.revenue_minor).toBe('0');expect(r.conversion.value).toBeNull();expect(r.spend_minor.reason).toBe('SPEND_COVERAGE_INCOMPLETE');
 });
 it('distinguishes a measured zero spend from missing spend and cannot divide by zero',()=>{
  const zero=summarizeResults([facts()],[costs({spend_minor:'0'})],q);expect(zero.spend_minor.value).toBe('0');expect(zero.cost_per_sale_minor.value).toBe('0.000000');expect(zero.roas.reason).toBe('NO_DENOMINATOR');
  const missing=summarizeResults([facts()],[costs({spend_minor:null,attributed_conversations:null,comparable:false,reason:'META_NOT_CONFIGURED'})],q);expect(missing.cost_per_sale_minor).toEqual({value:null,reason:'META_NOT_CONFIGURED'});
 });
 it('requires every calendar day of the period for comparable costs',()=>{
  const r=summarizeResults([facts()],[costs()],{...q,from:'2026-10-10'});expect(r.roas.reason).toBe('SPEND_COVERAGE_INCOMPLETE');
 });
 it('rejects duplicate spend days instead of double counting',()=>{expect(()=>summarizeResults([facts()],[costs(),costs()],q)).toThrow('RESULT_SPEND_DAY_DUPLICATED');});
 it('rejects mixing a report cut with broader spend',()=>{expect(()=>summarizeResults([facts()],[costs()],{...q,touch:'REMARKETING'})).toThrow('RESULT_SPEND_SCOPE_MISMATCH');});
 it('excludes facts outside a requested variant, date or account',()=>{
  const variant='10000000-0000-4000-8000-000000000001',r=summarizeResults([facts(),facts({day:'2026-10-09'})],[],{...q,variant_id:variant});expect(r.totals.sales).toBe('0');
 });
 it('retains exact sums beyond the JavaScript safe integer range',()=>{
  const row=facts({revenue_minor:'9007199254740993',attributed_revenue_minor:'0'}),r=summarizeResults([row,row],[],q);expect(r.totals.revenue_minor).toBe('18014398509481986');
 });
 it('does not fill missing stages from a recognized payment',()=>{
  const r=summarizeResults([facts({funnel:{started:'10',responded:'0',offered:'0',collection_sent:'0',receipt_received:'0',payment_approved:'3'},response_samples:'0',response_ms_sum:'0'})],[],q);expect(r.funnel.find(s=>s.stage==='offered')?.count).toBe('0');expect(r.conversion.value).toBe('0.300000');
 });
 it('rejects impossible aggregate samples and malformed or negative monetary facts',()=>{
  for(const row of [facts({sales:'-1'}),facts({response_samples:'9'}),facts({attributed_revenue_minor:'5001'}),facts({funnel:{...facts().funnel,payment_approved:'11'}})])expect(resultDailyFactsSchema.safeParse(row).success).toBe(false);
 });
 it('marks the entire AI cost incomplete when even one attempt is uncertain',()=>{
  const r=summarizeResults([facts({ai_cost_unknown_attempts:'1'})],[],q);expect(r.ai.cost.reason).toBe('AI_COST_INCOMPLETE');expect(r.ai.per_conversation.value).toBeNull();expect(r.totals.ai_cost_microusd).toBe('120000');
 });
 it('uses civil dates across DST boundaries and ISO weeks',()=>{
  expect(previousResultsPeriod('2026-11-01','2026-11-07')).toEqual({from:'2026-10-25',to:'2026-10-31',days:7});expect(resultBucket('2026-01-01','week')).toBe('2025-12-29');expect(resultBucket('2026-03-31','month')).toBe('2026-03-01');
 });
 it('rejects invalid dates, periods, unknown fields and ambiguous monetary goals',()=>{
  for(const v of [{from:'2026-02-30'},{to:'2025-01-01'},{from:'2024-01-01'},{workspace_id:'foreign'}])expect(resultFiltersSchema.safeParse({...q,...v}).success).toBe(false);
  const g={from:day,to:day,currency:'MXN',family_id:null,variant_id:null,metric:'REVENUE',target:'100'};expect(goalFieldsSchema.safeParse(g).success).toBe(true);for(const v of [{target:'1.5'},{target:'0'},{variant_id:'10000000-0000-4000-8000-000000000001'}])expect(goalFieldsSchema.safeParse({...g,...v}).success).toBe(false);
  expect(goalFieldsSchema.safeParse({...g,metric:'ROAS',target:'2.5'}).success).toBe(true);
 });
 it('rounds exact rationals once and rejects negative denominators',()=>{expect(decimalRatio(1n,6n).value).toBe('0.166667');expect(decimalRatio(0n,0n).value).toBeNull();expect(()=>decimalRatio(1n,-1n)).toThrow('RESULT_RATIO_INVALID');});
});

describe('goal calendar progress and fractional attribution',()=>{
 it('preserves fractional attributed conversations without binary floating money',()=>{
  const r=summarizeResults([facts()],[costs({attributed_conversations:'2.5'})],q);expect(r.cost_per_conversation_minor.value).toBe('800.000000');
 });
 it('projects additive goals using inclusive civil days and stops at the period end',async()=>{
  const {resultGoalProgress}=await import('./results.js'),f=goalFieldsSchema.parse({from:'2026-10-01',to:'2026-10-31',currency:'MXN',family_id:null,variant_id:null,metric:'REVENUE',target:'10000'}),r=summarizeResults([facts()],[],q);
  expect(resultGoalProgress(f,r,'2026-10-10')).toMatchObject({actual:{value:'5000'},progress:{value:'0.500000'},projection:{value:'15500.000000'},elapsed_days:10,total_days:31,met:false});
  expect(resultGoalProgress(f,r,'2026-11-10').projection.value).toBe('5000.000000');expect(resultGoalProgress(f,r,'2026-09-30').projection.reason).toBe('PERIOD_NOT_STARTED');
 });
 it('keeps ratio goal projections explicit and missing spend unknown',async()=>{
  const {resultGoalProgress}=await import('./results.js'),f=goalFieldsSchema.parse({from:day,to:day,currency:'MXN',family_id:null,variant_id:null,metric:'ROAS',target:'1.5'});
  expect(resultGoalProgress(f,summarizeResults([facts()],[costs()],q),day)).toMatchObject({met:true,projection:{value:'2.000000'},projection_basis:'unchanged_observed_ratio'});
  expect(resultGoalProgress(f,summarizeResults([facts()],[],q),day).projection.value).toBeNull();
 });
 it('evaluates cost ceilings in the correct direction and rejects mixed currency',async()=>{
  const {resultGoalProgress}=await import('./results.js'),f=goalFieldsSchema.parse({from:day,to:day,currency:'MXN',family_id:null,variant_id:null,metric:'MAX_COST_PER_SALE',target:'800'}),r=summarizeResults([facts()],[costs()],q);
  expect(resultGoalProgress(f,r,day).met).toBe(true);expect(()=>resultGoalProgress({...f,currency:'USD'},r,day)).toThrow('GOAL_CURRENCY_MISMATCH');
 });
});
