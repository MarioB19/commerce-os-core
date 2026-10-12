import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {captureNumberLab} from './number-lab-snapshot.js';
import {marketRecordVersionHash} from './market-variants.js';
import {marketReleaseHash} from '../../domain/src/catalog/market-variants.js';
import {labHash} from '../../domain/src/laboratory/number-lab.js';
import type {ProfileAuthority} from '../../domain/src/core/profile-authorization.js';
import type {ProfileExecutor} from './profile-context.js';
function fixture(){const workspace='profile-snapshot',now=Date.parse('2026-10-12T07:00:00.000Z'),rows:any[]=[];
 const row=(kind:string,body:unknown)=>{const r={record_id:randomUUID(),workspace_id:workspace,environment:'REAL',kind,version:1,body};rows.push(r);return r;};
 const product=row('product',{name:'Synthetic',description:'Same product',knowledge:[]}),flow=row('workflow',{name:'Flow',nodes:[],entry_node_id:'entry',status:'PUBLISHED'}),agent=row('agent',{name:'Seller',instructions:'Same seller',provider:'workspace'}),bank=row('bank_profile',{name:'Bank',bank:'Synthetic',currency:'MXN',holder:'Private holder',account_number:'123456',secret_ciphertext:'synthetic-secret'}),asset=row('asset',{name:'Audio',kind:'file',mime_type:'audio/mpeg',size_bytes:10,sha256:'a'.repeat(64),status:'READY',storage_key:'PRIVATE_STORAGE'}),policy=row('receipt_policy',{name:'Receipt',require_currency:true});
 const offer=row('offer',{name:'Offer',product_id:product.record_id,currency:'MXN',base_amount_minor:9700,status:'PUBLISHED',receipt_policy_version_id:policy.record_id,fulfillment:[{asset_id:asset.record_id,release_on:'receipt_approved'}],tiers:[{id:'base',name:'Base',minimum_total_minor:9700},{id:'extra',name:'Extra',minimum_total_minor:12000}]});
 const account=row('channel_account',{name:'Disconnected account',provider:'waha',gateway_ref:'PRIVATE',phone:'PRIVATE_PHONE'});const ref=(r:any)=>({id:r.record_id,revision:r.version,sha256:marketRecordVersionHash(r)});
 const body={account_id:account.record_id,offer_version_id:offer.record_id,workflow_version_id:flow.record_id,agent_version_id:agent.record_id,valid_from:new Date(now-1000).toISOString()};
 const binding=row('binding',body);const assignments=[{id:randomUUID(),product_id:product.record_id,binding_id:binding.record_id,binding_version:1,binding_body:body,state:'ACTIVE'}];
 const release={id:randomUUID(),scope:{workspace_id:workspace,environment:'REAL' as const},family_id:product.record_id,variant_id:randomUUID(),revision:1,locale:{market:'México',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'},amount_minor:9700,configuration:{offer:ref(offer),flow:ref(flow),seller:ref(agent),collection:ref(bank),remarketing:ref(offer),materials:[ref(asset)]}};
 const releases=[release];
 let clockCalls=0,clockDelta=0,ambiguous=false,corrupt=false;
 const statements:string[]=[];const db:ProfileExecutor={workspaceId:workspace,query:async(sql,values)=>{statements.push(sql);let result:any[];
 if(sql==='SELECT clock_timestamp() AS now')result=[{now:new Date(now+(clockCalls++?clockDelta:0))}];
 else if(sql.includes('FROM commercial_assignments'))result=assignments;
 else if(sql.includes('FROM market_variants')){result=releases.filter(r=>r.family_id===values![1]&&r.configuration.offer.id===values![2]).map(r=>({body:r,sha256:corrupt?'f'.repeat(64):marketReleaseHash(r)}));if(ambiguous)result.push(result[0]);}
 else if(sql.includes('FROM record_versions'))result=rows.filter(r=>r.kind===values![1]&&r.record_id===values![2]&&r.version===values![3]);
 else if(sql.includes("kind='channel_account'"))result=[account];
 else if(sql.includes('kind=$2 AND id=$3'))result=rows.filter(r=>r.kind===values![1]&&r.record_id===values![2]).sort((a,b)=>b.version-a.version).slice(0,1);
 else if(sql.includes("kind='product'"))result=rows.filter(r=>r.kind==='product'&&r.record_id===values![1]);else if(sql.includes("kind='receipt_policy'"))result=rows.filter(r=>r.kind==='receipt_policy'&&r.record_id===values![1]);else throw Error('UNEXPECTED_QUERY');
 return{command:'SELECT',rowCount:result.length,oid:0,fields:[],rows:result};}};
 const authority:ProfileAuthority={profile:{id:workspace,state:'ACTIVE'},membership:{userId:'actor',workspaceId:workspace,role:'operator',active:true,version:1},credential:{kind:'session',userId:'actor',workspaceId:workspace,revoked:false,expiresAt:new Date(now+3600000).toISOString(),scopes:[],membershipVersion:1}};
 return{db,authority,account,release,releases,rows,row,ref,assignments,statements,config:{engineSha256:'c'.repeat(64),aiConfigurationVersion:1},setDelta(n:number){clockDelta=n;},ambiguity(){ambiguous=true;},corrupt(){corrupt=true;}};
}
describe('native number laboratory snapshot projection',()=>{
 it('captures every release and tier with real record hashes and no channel/credential/storage data',async()=>{const f=fixture(),r=await captureNumberLab(f.db,f.authority,f.account.record_id,f.config);expect(r.snapshot.candidates).toHaveLength(1);expect(r.snapshot.tiers[0]?.tier_ids).toEqual(['base','extra']);expect(r.snapshot.configuration_sha256).toBe(labHash(r.records));expect(r.records.map(r=>r.kind)).toContain('receipt_policy');expect(JSON.stringify(r)).not.toMatch(/PRIVATE|synthetic-secret|123456|Private holder/);expect(f.statements.some(s=>s.includes('FOR SHARE OF a,b'))).toBe(true);expect(f.statements.every(s=>s.startsWith('SELECT'))).toBe(true);});
 it.each(['link','access'] as const)('keeps the native %s source hash while excluding its destination and secret from capture',async kind=>{const f=fixture(),asset=f.rows.find(r=>r.kind==='asset');Object.assign(asset.body,{kind,url:'https://private.example.test/path',adapter:'link',delivery_ciphertext:'PRIVATE-CIPHERTEXT'});f.release.configuration.materials=[f.ref(asset)];const captured=await captureNumberLab(f.db,f.authority,f.account.record_id,f.config),copy=captured.records.find(r=>r.kind==='asset')!;expect(copy.ref).toEqual(f.ref(asset));expect(copy.body.kind).toBe(kind);expect(JSON.stringify(copy.body)).not.toMatch(/private.example|PRIVATE-CIPHERTEXT|url|delivery_ciphertext/);});
 it('captures nested subflows, category, materials and acquisition provenance',async()=>{
  const f=fixture(),category=f.row('category',{name:'Nested category',knowledge:[]}),extra=f.row('asset',{name:'Nested file',kind:'file',status:'READY',sha256:'a'.repeat(64),size_bytes:20}),sub=f.row('workflow',{name:'Nested',status:'PUBLISHED',entry_node_id:'end',nodes:[{id:'end',type:'end',config:{asset_ids:[extra.record_id]}}]}),campaign=f.row('acquisition_campaign',{name:'Origin',source:'Native configuration',evidence:'Synthetic',status:'PAUSED',account_id:f.account.record_id});
  f.rows.find(r=>r.kind==='product').body.category_id=category.record_id;
  const flow=f.rows.find(r=>r.kind==='workflow');flow.body.nodes=[{id:'entry',type:'subflow',config:{workflow_version_id:sub.record_id}}];f.release.configuration.flow=f.ref(flow);
  Object.assign(f.assignments[0]!.binding_body,{campaign_id:campaign.record_id});
  const result=await captureNumberLab(f.db,f.authority,f.account.record_id,f.config);
  for(const expected of [category,extra,sub,campaign])expect(result.records.find(r=>r.ref.id===expected.record_id)?.ref).toEqual(f.ref(expected));
  expect(result.records.filter(r=>r.kind==='binding')).toHaveLength(1);
 });
 it('keeps an explicit old release revision when the mutable record has advanced',async()=>{
  const f=fixture(),flow=f.rows.find(r=>r.kind==='workflow');f.rows.push({...flow,version:2,body:{...flow.body,name:'New draft',status:'DRAFT'}});
  const result=await captureNumberLab(f.db,f.authority,f.account.record_id,f.config);expect(result.records.find(r=>r.kind==='workflow')?.ref.revision).toBe(1);
 });
 it('fails closed for missing or unpublished nested references and an asset not READY',async()=>{
  for(const state of ['missing','draft','asset']){const f=fixture(),product=f.rows.find(r=>r.kind==='product');
   if(state==='missing')product.body.category_id=randomUUID();
   if(state==='draft')product.body.workflow_template_version_id=f.row('workflow',{name:'Draft',status:'DRAFT',nodes:[]}).record_id;
   if(state==='asset')product.body.asset_ids=[f.row('asset',{name:'File',kind:'file',status:'PENDING'}).record_id];
   await expect(captureNumberLab(f.db,f.authority,f.account.record_id,f.config)).rejects.toThrow(state==='missing'?'LAB_REFERENCE_MISSING':state==='draft'?'LAB_SOURCE_NOT_PUBLISHED':'LAB_ASSET_NOT_READY');
  }
 });
 it('does not silently resolve two different pinned revisions of one source',async()=>{
  const f=fixture(),asset=f.rows.find(r=>r.kind==='asset'),newer={...asset,version:2,body:{...asset.body,name:'Revised'}};f.rows.push(newer);
  const product=f.row('product',{name:'Second family'}),offer=f.row('offer',{...f.rows.find(r=>r.kind==='offer').body,product_id:product.record_id}),body={...f.assignments[0]!.binding_body,offer_version_id:offer.record_id},binding=f.row('binding',body);
  f.assignments.push({...f.assignments[0]!,id:randomUUID(),product_id:product.record_id,binding_id:binding.record_id,binding_body:body});
  f.releases.push({...f.release,id:randomUUID(),variant_id:randomUUID(),family_id:product.record_id,configuration:{...f.release.configuration,offer:f.ref(offer),remarketing:f.ref(offer),materials:[f.ref(newer)]}});
  await expect(captureNumberLab(f.db,f.authority,f.account.record_id,f.config)).rejects.toThrow('LAB_SOURCE_VERSION_AMBIGUOUS');
 });
 it('terminates reference cycles and rejects foreign channel provenance',async()=>{
  const f=fixture(),flow=f.rows.find(r=>r.kind==='workflow');flow.body.nodes=[{id:'entry',type:'subflow',config:{workflow_version_id:flow.record_id}}];f.release.configuration.flow=f.ref(flow);
  expect((await captureNumberLab(f.db,f.authority,f.account.record_id,f.config)).records.filter(r=>r.ref.id===flow.record_id)).toHaveLength(1);
  const g=fixture();g.assignments[0]!.binding_body.account_id=randomUUID();await expect(captureNumberLab(g.db,g.authority,g.account.record_id,g.config)).rejects.toThrow('LAB_CONFIGURATION_ACCOUNT_CHANGED');
 });
 it('rejects the entire closure at 300 records without returning a truncated projection',async()=>{
  const f=fixture(),product=f.rows.find(r=>r.kind==='product');let prior=product.body;
  for(let i=0;i<301;i++){const child=f.row('workflow',{name:'Nested '+i,status:'PUBLISHED',entry_node_id:'next',nodes:[]});prior.workflow_template_version_id=child.record_id;prior=child.body;}
  // workflow_template_version_id is not a workflow schema field; use real subflow nodes for that chain.
  const nested=f.rows.filter(r=>r.kind==='workflow').slice(1);for(let i=0;i<nested.length-1;i++)nested[i]!.body.nodes=[{id:'next',type:'subflow',config:{workflow_version_id:nested[i+1]!.record_id}}];
  await expect(captureNumberLab(f.db,f.authority,f.account.record_id,f.config)).rejects.toThrow('LAB_SOURCE_LIMIT');
 });
 it('does not infer an adopted variant from an ambiguous matching tuple',async()=>{const f=fixture();f.ambiguity();await expect(captureNumberLab(f.db,f.authority,f.account.record_id,f.config)).rejects.toThrow('LAB_VARIANT_BINDING_REQUIRED');});
 it('rejects a corrupt release and old record hash rather than copying current content',async()=>{const f=fixture();f.corrupt();await expect(captureNumberLab(f.db,f.authority,f.account.record_id,f.config)).rejects.toThrow('LAB_RELEASE_CHANGED');const g=fixture();g.rows.find(r=>r.kind==='agent').body.instructions='changed';await expect(captureNumberLab(g.db,g.authority,g.account.record_id,g.config)).rejects.toThrow('LAB_SOURCE_CHANGED');});
 it('keeps paused/retired canonical assignments closed with no legacy fallback',async()=>{const f=fixture();f.assignments[0]!.state='RETIRED';await expect(captureNumberLab(f.db,f.authority,f.account.record_id,f.config)).rejects.toThrow('LAB_ASSIGNMENT_NOT_CURRENT');});
 it('rejects oversized coverage without dropping the last assignment',async()=>{const f=fixture();f.assignments.push(...Array.from({length:20},()=>({...f.assignments[0]!})));await expect(captureNumberLab(f.db,f.authority,f.account.record_id,f.config)).rejects.toThrow('LAB_ASSIGNMENT_COVERAGE');});
 it('checks the final clock and assignment expiry after all source reads',async()=>{const f=fixture();f.setDelta(120001);await expect(captureNumberLab(f.db,f.authority,f.account.record_id,f.config)).rejects.toThrow('LAB_CAPTURE_EXPIRED');const g=fixture();Object.assign(g.assignments[0]!.binding_body,{valid_to:'2026-10-12T07:00:00.500Z'});g.setDelta(700);await expect(captureNumberLab(g.db,g.authority,g.account.record_id,g.config)).rejects.toThrow('LAB_CAPTURE_EXPIRED');});
 it('refuses a viewer or a foreign profile before reading configuration',async()=>{const f=fixture();f.authority.membership.role='viewer';await expect(captureNumberLab(f.db,f.authority,f.account.record_id,f.config)).rejects.toThrow('PROFILE_ACTION_FORBIDDEN');expect(f.statements).toHaveLength(1);});
});
