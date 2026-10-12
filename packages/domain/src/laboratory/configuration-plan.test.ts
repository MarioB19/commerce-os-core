import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {compileNumberLabConfiguration,type LabPlanSource} from './configuration-plan.js';
import {labHash} from './number-lab.js';
import type {NumberLabSnapshot} from '../../../contracts/src/number-laboratory.js';
function fixture(){
 const records:LabPlanSource[]=[],ref=()=>({id:randomUUID(),revision:1,sha256:'a'.repeat(64)}),account=ref();
 const add=(kind:string,body:Record<string,any>)=>{const s={kind,ref:ref(),body};records.push(s);return s;};
 const category=add('category',{name:'Category'}),product=add('product',{name:'Product',category_id:category.ref.id}),asset=add('asset',{name:'File',kind:'file',status:'READY',sha256:'b'.repeat(64),size_bytes:7}),bank=add('bank_profile',{name:'Bank',bank:'Synthetic',currency:'MXN'}),agent=add('agent',{name:'Seller',provider:'workspace',model:'protected-model',product_id:product.ref.id}),sub=add('workflow',{name:'Child',status:'PUBLISHED',nodes:[{id:'end',type:'end',config:{asset_id:asset.ref.id}}]}),flow=add('workflow',{name:'Flow',status:'PUBLISHED',nodes:[{id:'child',type:'subflow',config:{workflow_version_id:sub.ref.id}}]}),offer=add('offer',{name:'Offer',product_id:product.ref.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:100,payment_profile_version_id:bank.ref.id,agent_version_id:agent.ref.id,workflow_version_id:flow.ref.id,fulfillment:[{asset_id:asset.ref.id}]}),binding=add('binding',{account_id:account.id,offer_version_id:offer.ref.id,workflow_version_id:flow.ref.id,agent_version_id:agent.ref.id});
 const candidate={account_id:account.id,binding:binding.ref,state:'ACTIVE' as const,release:{id:randomUUID(),variant_id:randomUUID(),family_id:product.ref.id,revision:1,scope:{workspace_id:'profile',environment:'REAL' as const},locale:{market:'MX',currency:'MXN',language:'es',timezone:'America/Mexico_City'},amount_minor:100,configuration:{offer:offer.ref,flow:flow.ref,seller:agent.ref,collection:bank.ref,remarketing:offer.ref,materials:[asset.ref]}}};
 const snapshot:NumberLabSnapshot={schema_version:1,workspace_id:'profile',source_environment:'REAL',account,captured_at:'2026-10-12T10:00:00.000Z',engine_sha256:'c'.repeat(64),configuration_sha256:labHash(records),ai_configuration_version:1,candidates:[candidate],sources:records.map(({kind,ref})=>({kind,ref})) as NumberLabSnapshot['sources'],tiers:[{variant_id:candidate.release.variant_id,tier_ids:['base']}]};
 const seal=()=>{snapshot.configuration_sha256=labHash(records);snapshot.sources=records.map(({kind,ref})=>({kind,ref})) as NumberLabSnapshot['sources'];};
 return{snapshot,records,seal,add,account,product,offer,flow,sub,asset,bank,agent,binding,candidate,run:randomUUID()};
}
describe('pure closed laboratory configuration compiler',()=>{
 it('is deterministic for one run and assigns separate IDs to a different run',()=>{
  const f=fixture(),before=JSON.stringify(f.records),one=compileNumberLabConfiguration(f,f.run),two=compileNumberLabConfiguration(f,f.run),other=compileNumberLabConfiguration(f,randomUUID());
  expect(one).toEqual(two);expect(one.native_authority).toBe(false);expect(one.environment).toBe('SIMULATION');expect(one.operation_class).toBe('TEST');expect(one.account_id).not.toBe(other.account_id);expect(one.variants[0]!.roots.product_id).not.toBe(other.variants[0]!.roots.product_id);expect(JSON.stringify(f.records)).toBe(before);
 });
 it('remaps subflows, bank, material arrays and channel identity without changing the provider',()=>{
  const f=fixture();f.product.body.asset_ids=[f.asset.ref.id];f.seal();const plan=compileNumberLabConfiguration(f,f.run),v=plan.variants[0]!,find=(id:string)=>v.records.find(r=>r.source.id===id)!;
  expect(find(f.flow.ref.id).body.nodes[0].config.workflow_version_id).toBe(find(f.sub.ref.id).id);expect(find(f.product.ref.id).body.asset_ids).toEqual([find(f.asset.ref.id).id]);expect(find(f.binding.ref.id).body.account_id).toBe(plan.account_id);expect(find(f.offer.ref.id).body.payment_profile_version_id).toBe(find(f.bank.ref.id).id);
  expect(find(f.agent.ref.id).body.provider).toBe('workspace');expect(find(f.agent.ref.id).body.model).toBe('protected-model');expect(v.materials[0]).toMatchObject({source:f.asset.ref,broker_required:true,sha256:'b'.repeat(64),size_bytes:7});
 });
 it('copies shared product configuration separately for each variant and retains originals',()=>{
  const f=fixture(),binding=f.add('binding',{...f.binding.body});const c=structuredClone(f.candidate);c.binding=binding.ref;c.release.id=randomUUID();c.release.variant_id=randomUUID();f.snapshot.candidates.push(c);f.snapshot.tiers.push({variant_id:c.release.variant_id,tier_ids:['base']});f.seal();
  const p=compileNumberLabConfiguration(f,f.run);expect(p.variants).toHaveLength(2);const [a,b]=p.variants;expect(a!.roots.product_id).not.toBe(b!.roots.product_id);expect(a!.records.find(r=>r.kind==='product')!.source).toEqual(b!.records.find(r=>r.kind==='product')!.source);
 });
 it('orders immutable dependencies after their own dependencies and finalizes mutable skeletons',()=>{
  const f=fixture(),v=compileNumberLabConfiguration(f,f.run).variants[0]!,ids=(kind:string)=>v.records.filter(r=>r.kind===kind).map(r=>r.id),order=v.write_order;
  expect(order.skeletons).toEqual(order.finalize);expect(new Set([...order.skeletons,...order.immutable]).size).toBe(v.records.length);expect(order.immutable.indexOf(ids('agent')[0]!)).toBeLessThan(order.immutable.indexOf(ids('offer')[0]!));expect(order.immutable.indexOf(ids('offer')[0]!)).toBeLessThan(order.immutable.indexOf(ids('binding')[0]!));
 });
 it('rejects capture tampering or omission instead of synthesizing a root or source',()=>{
  const f=fixture();f.product.body.name='Changed';expect(()=>compileNumberLabConfiguration(f,f.run)).toThrow('LAB_CAPTURE_BINDING');f.seal();f.records.splice(f.records.indexOf(f.sub),1);f.seal();expect(()=>compileNumberLabConfiguration(f,f.run)).toThrow('LAB_CONFIGURATION_INCOMPLETE');
 });
 it('rejects two pinned revisions of one native ID before creating a map',()=>{
  const f=fixture();f.records.push({...f.sub,ref:{...f.sub.ref,revision:2}});f.seal();expect(()=>compileNumberLabConfiguration(f,f.run)).toThrow('LAB_SOURCE_VERSION_AMBIGUOUS');
 });
 it('rejects immutable cycles while allowing product and published flow skeletons',()=>{
  const f=fixture();f.agent.body.offer_version_id=f.offer.ref.id;f.seal();expect(()=>compileNumberLabConfiguration(f,f.run)).toThrow('LAB_IMMUTABLE_REFERENCE_CYCLE');
 });
 it.each(['storage_key','secret_ciphertext','gateway_ref','authorization_id','api_key'])('refuses protected data despite a recomputed local capture hash: %s',key=>{
  const f=fixture();f.asset.body[key]='forbidden';f.seal();expect(()=>compileNumberLabConfiguration(f,f.run)).toThrow('LAB_UNSAFE_CONFIGURATION');
 });
 it('rejects bank holder/account and a different native channel account',()=>{
  const f=fixture();f.bank.body.account_number='forbidden';f.seal();expect(()=>compileNumberLabConfiguration(f,f.run)).toThrow('LAB_UNSAFE_CONFIGURATION');const g=fixture();g.binding.body.account_id=randomUUID();g.seal();expect(()=>compileNumberLabConfiguration(g,g.run)).toThrow('LAB_CONFIGURATION_ACCOUNT_CHANGED');
 });
 it('does not accept drafts or unready assets as materialized configuration',()=>{
  const f=fixture();f.sub.body.status='DRAFT';f.seal();expect(()=>compileNumberLabConfiguration(f,f.run)).toThrow('LAB_SOURCE_NOT_PUBLISHED');const g=fixture();g.asset.body.status='PENDING';g.seal();expect(()=>compileNumberLabConfiguration(g,g.run)).toThrow('LAB_ASSET_NOT_READY');
 });
});
