import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {integrationTestGroups,integrationGroupArgs} from '../../scripts/integration-test-groups.js';
const root=process.cwd();
describe('integration database partition without omitted tests',()=>{
 it('assigns every current integration file exactly once and isolates every profile transition',()=>{
  const files=readdirSync(resolve(root,'tests/integration')).filter(file=>file.endsWith('.test.ts')).map(file=>'tests/integration/'+file).sort();
  const groups=integrationTestGroups(root,files.map(file=>({file:resolve(root,file)})));
  expect(groups.flat().sort()).toEqual(files);expect(new Set(groups.flat()).size).toBe(files.length);
  for(const file of files.filter(file=>file.startsWith('tests/integration/profile-')))expect(groups.find(group=>group.includes(file))).toEqual([file]);
  expect(groups[0]?.every(file=>!file.startsWith('tests/integration/profile-'))).toBe(true);
 });
 it('keeps global MCP calendar workers separate and last after profile transitions',()=>{
  const files=['tests/integration/profile-session.test.ts','tests/integration/numbers-mcp-stdio.test.ts','tests/integration/warmup-runtime.test.ts'];
  const groups=integrationTestGroups(root,files.map(file=>({file})));
  expect(groups).toEqual([[files[2]],[files[0]],[files[1]]]);
  expect(groups.flat().sort()).toEqual(files.sort());
 });
 it('partitions only the native selected files and preserves explicit flags without widening filters',()=>{
  const files=['tests/integration/a.test.ts','tests/integration/profile-one.test.ts','tests/integration/profile-two.test.ts'];
  const groups=integrationTestGroups(root,files.map(file=>({file}))),original=['profile','--exclude','**/not-selected.test.ts','--testNamePattern','specific test'];
  const args=integrationGroupArgs(original,groups,groups[1]!);expect(args.slice(0,original.length)).toEqual(original);
  expect(args.slice(original.length)).toEqual(['--exclude',files[0],'--exclude',files[2]]);expect(args).not.toContain(files[1]);
 });
 it.each([[],[{file:'../live.test.ts'}],[{file:'/tmp/live.test.ts'}],[{file:'tests/unit/no.test.ts'}],[{file:'tests/integration/a.test.ts',projectName:'unexpected'}],[{file:'tests/integration/a.test.ts'},{file:'tests/integration/a.test.ts'}]].map(value=>({value})))('rejects empty, ambiguous or escaped selection %j',({value})=>{expect(()=>integrationTestGroups(root,value)).toThrow();});
 it('isolates exact F3/F4 transitions with the calendar without widening selected filters',()=>{
  const files=['tests/integration/a.test.ts','tests/integration/continuous-authorization.test.ts','tests/integration/market-variants.test.ts','tests/integration/market-other.test.ts','tests/integration/profile-one.test.ts','tests/integration/numbers-mcp-stdio.test.ts'];
  const groups=integrationTestGroups(root,files.map(file=>({file})));
  expect(groups).toEqual([[files[0],files[3]],[files[1]],[files[2]],[files[4]],[files[5]]]);
  expect(groups.flat().sort()).toEqual([...files].sort());
  for(const name of files.slice(1,3)){
   const selected=groups.find(group=>group.includes(name))!;
   const original=['--testNamePattern','specific'];
   expect(integrationGroupArgs(original,groups,selected)).toEqual([...original,...groups.flat().filter(file=>file!==name).flatMap(file=>['--exclude',file])]);
   expect(integrationTestGroups(root,[{file:name}])).toEqual([[name]]);
  }
 });
 it('isolates expiry maintenance transitions without widening the selection',()=>{
  const expiry='tests/integration/expired-effects.test.ts',ordinary='tests/integration/warmup-runtime.test.ts',calendar='tests/integration/numbers-mcp-stdio.test.ts';
  const groups=integrationTestGroups(root,[ordinary,expiry,calendar].map(file=>({file})));
  expect(groups).toEqual([[ordinary],[expiry],[calendar]]);
  expect(integrationTestGroups(root,[{file:expiry}])).toEqual([[expiry]]);
 });
 it('rejects a group that was not part of the native selection',()=>{expect(()=>integrationGroupArgs([], [['tests/integration/a.test.ts']],['tests/integration/other.test.ts'])).toThrow('GROUP_UNKNOWN');});
});
