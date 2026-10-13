import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {reviewedModelCatalog,aiTasks,PRICE_VERSION} from './price-catalog.js';
import {validateModel,resolveModel,measuredCost} from './catalog.js';
import {validateResponseModel} from './protocol.js';

describe('V7 reviewed model price catalogue (RF-14.a/c/d)',()=>{
 const at=Date.parse('2026-12-01T00:00:00Z');
 it('validates every model with a dated official price and short-context ceilings',()=>{
  for(const m of reviewedModelCatalog){expect(()=>validateModel(m,at),m.model).not.toThrow();expect(m.price.version).toBe(PRICE_VERSION);}
  expect(()=>validateModel(reviewedModelCatalog[0]!,Date.parse('2027-04-02T00:00:00Z'))).toThrow('PRICE_EXPIRED');
  expect(reviewedModelCatalog.filter(m=>m.provider==='anthropic').every(m=>m.inputTokenCeiling<=100_000)).toBe(true);
  expect(reviewedModelCatalog.filter(m=>m.provider==='openai').every(m=>m.inputTokenCeiling<270_000)).toBe(true);
 });
 it('is exactly the catalogue installed by migration 0106',()=>{
  const sql=readFileSync(new URL('../../db/migrations/0106_v7_ai_price_catalog.sql',import.meta.url),'utf8');
  const documents=[...sql.matchAll(/'(\{"provider".*?\})'::jsonb/g)].map(m=>JSON.parse(m[1]!.replaceAll("''","'")));
  expect(documents).toEqual(reviewedModelCatalog.map(m=>JSON.parse(JSON.stringify(m))));
 });
 it('covers chat, vision and audio with three providers and an explicit fallback order (D-09)',()=>{
  for(const provider of ['openai','anthropic','google'])expect(reviewedModelCatalog.some(m=>m.provider===provider&&m.capabilities.includes('chat')),provider).toBe(true);
  expect([...new Set(Object.values(aiTasks).map(t=>t.capability))].sort()).toEqual(['audio','chat','vision']);
  // V7 F6: the laboratory seller is its own task with the same chat model.
  expect(Object.keys(aiTasks).sort()).toEqual(['audio.transcribe','laboratory.chat','receipt.document','sales.chat']);
  const profile={profileId:'p',version:1,default:{provider:'anthropic' as const,model:'claude-haiku-5-5'},variants:{},capabilityFallbacks:[{provider:'google' as const,model:'gemini-2.5-flash-lite'}],configuredProviders:['anthropic' as const,'google' as const]};
  expect(resolveModel(profile,'11111111-1111-4111-8111-111111111111','chat',reviewedModelCatalog,at)).toMatchObject({state:'MODEL',selection:'default'});
  expect(resolveModel(profile,'11111111-1111-4111-8111-111111111111','audio',reviewedModelCatalog,at)).toMatchObject({state:'MODEL',selection:'capability-fallback',model:{provider:'google'}});
  expect(resolveModel({...profile,capabilityFallbacks:[]},'11111111-1111-4111-8111-111111111111','audio',reviewedModelCatalog,at)).toEqual({state:'HUMAN_REQUIRED',code:'CAPABILITY_NOT_CONFIGURED'});
 });
 it('accepts only dated snapshots of the reviewed alias as response identity',()=>{
  const luna=reviewedModelCatalog.find(m=>m.model==='gpt-6-luna')!,ok=(model:string)=>()=>validateResponseModel(luna,{model,service_tier:'default'});
  expect(ok('gpt-6-luna')).not.toThrow();expect(ok('gpt-6-luna-2026-09-15')).not.toThrow();
  expect(ok('gpt-6-luna-pro')).toThrow();expect(ok('gpt-6.1-sol')).toThrow();
  expect(()=>validateModel({...luna,responseModels:['gpt-6-*']},at)).toThrow('CONFIGURATION');
 });
 it('prices measured usage in integer microUSD',()=>{
  const haiku=reviewedModelCatalog.find(m=>m.model==='claude-haiku-5-5')!;
  expect(measuredCost(haiku,{input:1200,output:80,cacheRead:0,cacheWrite:0,audioInput:0})).toBe(160);
  const flash=reviewedModelCatalog.find(m=>m.model==='gemini-2.5-flash')!;
  expect(measuredCost(flash,{input:1000,output:100,cacheRead:0,cacheWrite:0,audioInput:2000})).toBe(Math.ceil((1000*300_000+100*2_500_000+2000*1_000_000)/1e6));
 });
});
