import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {browserContracts,runBrowserVerification} from '../browser-contracts.mjs';
test('every explicit browser contract runs once before mounted Playwright with its filters intact',async()=>{
 const calls=[],args=['tests/e2e/example.spec.ts','--grep','profile'];
 const result=await runBrowserVerification(async(cmd,argv)=>{calls.push([cmd,argv]);return 0;},args);
 assert.equal(browserContracts.length,13);assert.equal(new Set(browserContracts).size,13);
 for(const path of browserContracts)assert.ok((await readFile(new URL('../../'+path,import.meta.url))).length);
 assert.deepEqual(calls.slice(0,13),browserContracts.map(path=>[process.execPath,[path]]));
 assert.deepEqual(calls.slice(13),[['playwright',['test',...args]],['python3',['scripts/sanitize-test-artifacts.py']]]);
 assert.deepEqual(result,{code:0,sanitized:0});assert.deepEqual(args,['tests/e2e/example.spec.ts','--grep','profile']);
});
test('contract failure remains a failure even if mounted tests and sanitation pass',async()=>{
 const calls=[];const result=await runBrowserVerification(async(cmd,args)=>{calls.push([cmd,args]);return args[0]===browserContracts[2]?7:0;},[]);
 assert.equal(result.code,7);assert.equal(calls.length,5);assert.equal(calls[3][0],'playwright');assert.equal(calls[4][0],'python3');
});
test('mounted test and sanitizer failures cannot be hidden by passing contracts',async()=>{
 for(const [failed,code] of [['playwright',8],['python3',9]]){
  const r=await runBrowserVerification(async cmd=>cmd===failed?code:0,[]);assert.equal(r.code,code);
 }
});
test('launch failure sanitizes retained reports and propagates rejection',async()=>{
 const calls=[];await assert.rejects(runBrowserVerification(async(cmd,args)=>{calls.push([cmd,args]);if(cmd!== 'python3')throw Error('synthetic launch');return 0;},[]),/synthetic launch/);
 assert.deepEqual(calls.at(-1),['python3',['scripts/sanitize-test-artifacts.py']]);assert.equal(calls.length,2);
});
test('invalid child result fails closed',async()=>{
 const r=await runBrowserVerification(async cmd=>cmd===process.execPath?null:0,[]);assert.equal(r.code,1);
});
