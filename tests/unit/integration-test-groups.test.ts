import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {integrationTestGroups,integrationGroupArgs} from '../../scripts/integration-test-groups.js';
const root=process.cwd();
describe('integration database partition without omitted tests',()=>{
 it('assigns every current integration file exactly once to its own database',()=>{
  const files=readdirSync(resolve(root,'tests/integration')).filter(file=>file.endsWith('.test.ts')).map(file=>'tests/integration/'+file).sort();
  const groups=integrationTestGroups(root,files.map(file=>({file:resolve(root,file)})));
  expect(groups.flat().sort()).toEqual(files);expect(new Set(groups.flat()).size).toBe(files.length);
  // V7 F2: per-installation quotas require a fresh database for every file.
  for(const file of files)expect(groups.find(group=>group.includes(file))).toEqual([file]);
 });
 it('runs ordinary files before profile transitions, each in its own database',()=>{
  const files=['tests/integration/profile-session.test.ts','tests/integration/v7-mcp-stdio.test.ts','tests/integration/warmup-runtime.test.ts'];
  const groups=integrationTestGroups(root,files.map(file=>({file})));
  expect(groups).toEqual([[files[1]],[files[2]],[files[0]]]);
  expect(groups.flat().sort()).toEqual(files.sort());
 });
 it('partitions only the native selected files and preserves explicit flags without widening filters',()=>{
  const files=['tests/integration/a.test.ts','tests/integration/profile-one.test.ts','tests/integration/profile-two.test.ts'];
  const groups=integrationTestGroups(root,files.map(file=>({file}))),original=['profile','--exclude','**/not-selected.test.ts','--testNamePattern','specific test'];
  const args=integrationGroupArgs(original,groups,groups[1]!);expect(args.slice(0,original.length)).toEqual(original);
  expect(args.slice(original.length)).toEqual(['--exclude',files[0],'--exclude',files[2]]);expect(args).not.toContain(files[1]);
 });
 it.each([[],[{file:'../live.test.ts'}],[{file:'/tmp/live.test.ts'}],[{file:'tests/unit/no.test.ts'}],[{file:'tests/integration/a.test.ts',projectName:'unexpected'}],[{file:'tests/integration/a.test.ts'},{file:'tests/integration/a.test.ts'}]].map(value=>({value})))('rejects empty, ambiguous or escaped selection %j',({value})=>{expect(()=>integrationTestGroups(root,value)).toThrow();});
 it('isolates exact F3/F4 transitions without widening selected filters',()=>{
  const files=['tests/integration/a.test.ts','tests/integration/continuous-authorization.test.ts','tests/integration/market-variants.test.ts','tests/integration/market-other.test.ts','tests/integration/profile-one.test.ts','tests/integration/v7-mcp-stdio.test.ts'];
  const groups=integrationTestGroups(root,files.map(file=>({file})));
  expect(groups).toEqual([[files[0]],[files[3]],[files[5]],[files[1]],[files[2]],[files[4]]]);
  expect(groups.flat().sort()).toEqual([...files].sort());
  for(const name of files.slice(1,3)){
   const selected=groups.find(group=>group.includes(name))!;
   const original=['--testNamePattern','specific'];
   expect(integrationGroupArgs(original,groups,selected)).toEqual([...original,...groups.flat().filter(file=>file!==name).flatMap(file=>['--exclude',file])]);
   expect(integrationTestGroups(root,[{file:name}])).toEqual([[name]]);
  }
 });
 it('isolates expiry maintenance transitions without widening the selection',()=>{
  const expiry='tests/integration/expired-effects.test.ts',ordinary='tests/integration/warmup-runtime.test.ts',stdio='tests/integration/v7-mcp-stdio.test.ts';
  const groups=integrationTestGroups(root,[ordinary,expiry,stdio].map(file=>({file})));
  expect(groups).toEqual([[stdio],[ordinary],[expiry]]);
  expect(integrationTestGroups(root,[{file:expiry}])).toEqual([[expiry]]);
 });
 it('rejects a group that was not part of the native selection',()=>{expect(()=>integrationGroupArgs([], [['tests/integration/a.test.ts']],['tests/integration/other.test.ts'])).toThrow('GROUP_UNKNOWN');});
});
