import {describe,it,expect} from 'vitest';
import {labConfigurationReferences} from './configuration-references.js';
const id='00000000-0000-4000-8000-000000000001';
describe('closed laboratory reference vocabulary',()=>{
 it('finds nested native refs and array materials only once, leaving literal IDs alone',()=>{
  expect(labConfigurationReferences({id,nodes:[{id:'node',config:{asset_id:id,asset_ids:[id],text:id}}],knowledge:[{id}],account_id:id})).toEqual([{kind:'asset',id}]);
 });
 it('normalizes IDs and rejects malformed typed references without dropping them',()=>{
  const upper='AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';expect(labConfigurationReferences({category_id:upper})).toEqual([{kind:'category',id:upper.toLowerCase()}]);
  for(const body of [{asset_id:32},{asset_ids:'bad'},{asset_ids:[id,4]},{workflow_version_id:''}])expect(()=>labConfigurationReferences(body)).toThrow();
 });
 it('bounds depth and breadth before exhausting a process',()=>{
  let body:any={};for(let i=0;i<33;i++)body={nested:body};expect(()=>labConfigurationReferences(body)).toThrow('LAB_REFERENCE_GRAPH_LIMIT');
  expect(()=>labConfigurationReferences({nodes:Array.from({length:20001},()=>0)})).toThrow('LAB_REFERENCE_GRAPH_LIMIT');
 });
 it('does not inspect keys as code or interpret UUIDs in arbitrary copy',()=>{
  expect(labConfigurationReferences({text:'workflow_version_id '+id,unknown_id:id,category_id:null,agent_version_id:null})).toEqual([]);
 });
});
