import {describe,it,expect} from 'vitest';
import {bundledGroupLibrary,bundledLibraryManifest} from '../../packages/domain/src/warmup/group-library.js';
import {validateLibrary,normalizedMessage,groupDailyBudget,libraryCoverage,shuffledLibrary,libraryLimitsFeasible} from '../../packages/domain/src/warmup/group-policy.js';
import {groupWarmupConfigSchema} from '../../packages/contracts/src/group-warmup.js';
const ids=Array.from({length:10},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
const config=(n:number)=>groupWarmupConfigSchema.parse({name:'Equipo de prueba',groupId:ids[0],senderIds:ids.slice(0,n),libraryVersion:'operacion-interna-es/v1',timezone:'America/Mexico_City'});
describe('V7.2 static group library and outgoing budgets',()=>{
 it('ships 500 coherent ten-turn scripts and 5000 normalized distinct messages, with no AI dependency',()=>{
  expect(bundledLibraryManifest).toMatchObject({scripts:500,messages:5000,ai:false});expect(new Set(bundledGroupLibrary.flatMap(s=>s.turns.map(t=>normalizedMessage(t.text)))).size).toBe(5000);
  for(const script of bundledGroupLibrary){expect(script.turns).toHaveLength(10);expect(script.ownership_confirmed).toBe(true);expect(script.turns.every(t=>t.kind==='text'&&t.text.length>=30)).toBe(true);}
 });
 it('rejects normalized duplicates, personal data and placeholders on import',()=>{
  const sample=structuredClone(bundledGroupLibrary[0]!);sample.turns[1]!.text=sample.turns[0]!.text.toUpperCase()+'!!!';expect(()=>validateLibrary([sample])).toThrow('LIBRARY_DUPLICATE_MESSAGE');
  for(const text of ['Escribe a ejemplo@example.invalid para entrar','El teléfono de contacto es +52 55 1234 5678','La ruta es https://example.invalid/','Contenido sin resolver: {{nombre}}']){const changed=structuredClone(bundledGroupLibrary[0]!);changed.turns[0]!.text=text;expect(()=>validateLibrary([changed])).toThrow('LIBRARY_PERSONAL_DATA_OR_PLACEHOLDER');}
 });
 it('caps 3 senders at 300 outgoing messages even with a group cap of 500',()=>{const b=groupDailyBudget(config(3),11,new Date('2026-11-06T16:00:00Z'));expect(b.total).toBe(300);expect(b.per_sender).toBe(100);});
 it.each([2,3,10])('covers seven days plus reserve with %i senders',n=>{expect(libraryCoverage(config(n),[...bundledGroupLibrary]).sufficient).toBe(true);});
 it('does not credit recipients as outgoing; retains the conservative curve and lower maintenance',()=>{const date=new Date('2026-11-06T16:00:00Z'),c=config(10);expect(groupDailyBudget(c,1,date)).toMatchObject({per_sender:15,total:150});expect(groupDailyBudget(c,8,date).per_sender).toBe(40);expect(groupDailyBudget(c,14,date).total).toBe(359);expect(groupDailyBudget(c,14,date).min_outgoing).toBe(35);expect(groupDailyBudget(c,15,date,true).per_sender).toBe(10);});
 it('rejects caps that cannot fit whole library exchanges without silently lowering evidence',()=>{expect(libraryLimitsFeasible({...config(3),senderDailyLimit:5},[...bundledGroupLibrary])).toBe(false);for(const n of [2,3,10])expect(libraryLimitsFeasible(config(n),[...bundledGroupLibrary])).toBe(true);});
 it('keeps a repeatable permutation through restarts without mutating the corpus',()=>{const rows=[{content_hash:'a'},{content_hash:'b'},{content_hash:'c'}];expect(shuffledLibrary(rows,'program:day')).toEqual(shuffledLibrary(rows,'program:day'));expect(rows.map(r=>r.content_hash)).toEqual(['a','b','c']);});
 it('rejects cross-midnight windows and duplicate sender selection',()=>{expect(()=>groupWarmupConfigSchema.parse({...config(2),startHour:18,endHour:9})).toThrow();expect(()=>groupWarmupConfigSchema.parse({...config(2),senderIds:[ids[0],ids[0]]})).toThrow();});
});
