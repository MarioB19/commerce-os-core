import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Body} from '../../../contracts/src/index.js';
import {labSourceSchema,type NumberLabSnapshot} from '../../../contracts/src/number-laboratory.js';
import {labCanonical,labHash,validateLabSnapshot} from './number-lab.js';
import {labConfigurationReferences,labReferenceKinds} from './configuration-references.js';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
function need(v:unknown,c:string):asserts v{if(!v)throw Error(c);}
export interface LabPlanSource {kind:string;ref:{id:string;revision:number;sha256:string};body:Body}
export interface LabPlannedRecord {id:string;kind:string;source:LabPlanSource['ref'];body:Body}
const key=(kind:string,id:string)=>kind+':'+id;
const mutable=new Set(['category','product','workflow']);
/** IDs are deterministic proposals in the isolated database, not native proof. */
function localId(run:string,variant:string,kind:string,identity:unknown){const h=createHash('sha256').update(labCanonical({protocol:'commerce.number-lab.record.v1',run,variant,kind,identity})).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);}
function configuration(raw:{snapshot:unknown;records:readonly LabPlanSource[]}){
 const snapshot=validateLabSnapshot(raw.snapshot);need(Array.isArray(raw.records)&&raw.records.length===snapshot.sources.length&&labHash(raw.records)===snapshot.configuration_sha256,'LAB_CAPTURE_BINDING');
 const sources=new Map<string,LabPlanSource>();
 for(const source of raw.records){
  const parsed=labSourceSchema.parse({kind:source.kind,ref:source.ref}),k=key(parsed.kind,parsed.ref.id);
  need(Object.keys(source).sort().join(',')==='body,kind,ref'&&source.body&&typeof source.body==='object'&&!Array.isArray(source.body),'LAB_SOURCE_SHAPE');
  need(snapshot.sources.some(s=>s.kind===parsed.kind&&labCanonical(s.ref)===labCanonical(parsed.ref)),'LAB_CAPTURE_BINDING');
  need(!sources.has(k),'LAB_SOURCE_VERSION_AMBIGUOUS');sources.set(k,structuredClone(source));
 }
 for(const source of sources.values())for(const ref of labConfigurationReferences(source.body))need(sources.has(key(ref.kind,ref.id)),'LAB_CONFIGURATION_INCOMPLETE');
 return{snapshot,sources};
}
/** Pure compilation only. A native claim, seed role, installed marker and asset
 * broker remain mandatory before any output can be used by an engine. */
export function compileNumberLabConfiguration(raw:{snapshot:unknown;records:readonly LabPlanSource[]},runId:string){
 const run=uuid.parse(runId),{snapshot,sources}=configuration(raw),accountId=localId(run,'account','channel_account',snapshot.account);
 const variants=snapshot.candidates.map(candidate=>{
  const release=candidate.release,c=release.configuration,variant=release.variant_id;
  const roots=[{kind:'binding',ref:candidate.binding},{kind:'product',ref:{id:release.family_id}},
   {kind:'offer',ref:c.offer},{kind:'workflow',ref:c.flow},{kind:'agent',ref:c.seller},{kind:'bank_profile',ref:c.collection},...c.materials.map(ref=>({kind:'asset',ref}))];
  const reachable=new Map<string,LabPlanSource>(),pending=roots.map(root=>{
   const source=sources.get(key(root.kind,root.ref.id));need(source&&(!('sha256'in root.ref)||labCanonical(source.ref)===labCanonical(root.ref)),'LAB_CONFIGURATION_INCOMPLETE');return source;
  });
  for(let i=0;i<pending.length;i++){
   const source=pending[i]!,k=key(source.kind,source.ref.id);if(reachable.has(k))continue;reachable.set(k,source);
   for(const ref of labConfigurationReferences(source.body))pending.push(sources.get(key(ref.kind,ref.id))!);
  }
  const mapped=new Map([...reachable].map(([k,s])=>[k,localId(run,variant,s.kind,s.ref)]));
  const rewrite=(value:any,field=''):any=>{
   if(field==='account_id'&&value!==null&&value!==undefined){need(value===snapshot.account.id,'LAB_CONFIGURATION_ACCOUNT_CHANGED');return accountId;}
   if(labReferenceKinds[field]&&value!==null&&value!==undefined){const id=mapped.get(key(labReferenceKinds[field],uuid.parse(value)));need(id,'LAB_CONFIGURATION_INCOMPLETE');return id;}
   if(field==='asset_ids'&&Array.isArray(value))return value.map(id=>{const mappedId=mapped.get(key('asset',uuid.parse(id)));need(mappedId,'LAB_CONFIGURATION_INCOMPLETE');return mappedId;});
   if(Array.isArray(value))return value.map(v=>rewrite(v));
   if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>{
    need(!/(ciphertext|storage_key|delivery_reference|gateway|authorization|access_code|password|token|api_key)/i.test(k),'LAB_UNSAFE_CONFIGURATION');return[k,rewrite(v,k)];
   }));
   return value;
  };
  const records:LabPlannedRecord[]=[...reachable].map(([k,source])=>{
   if(['workflow','offer'].includes(source.kind))need(source.body.status==='PUBLISHED','LAB_SOURCE_NOT_PUBLISHED');
   if(source.kind==='asset')need(source.body.status==='READY','LAB_ASSET_NOT_READY');
   need(source.kind!=='bank_profile'||(!Object.hasOwn(source.body,'holder')&&!Object.hasOwn(source.body,'account_number')),'LAB_UNSAFE_CONFIGURATION');
   return{id:mapped.get(k)!,kind:source.kind,source:structuredClone(source.ref),body:{...rewrite(source.body),lab_snapshot:true,lab_source:{...source.ref,kind:source.kind},lab_variant_id:variant,lab_release_id:release.id}};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  const pendingImmutable=new Map([...reachable].filter(([,s])=>!mutable.has(s.kind))),ordered:string[]=[];
  while(pendingImmutable.size){let progressed=false;for(const[k,s]of pendingImmutable){
   if(labConfigurationReferences(s.body).some(ref=>pendingImmutable.has(key(ref.kind,ref.id))))continue;
   ordered.push(mapped.get(k)!);pendingImmutable.delete(k);progressed=true;
  }need(progressed,'LAB_IMMUTABLE_REFERENCE_CYCLE');}
  const skeletons=records.filter(r=>mutable.has(r.kind)).map(r=>r.id);
  return{variant_id:variant,release_id:release.id,roots:{product_id:mapped.get(key('product',release.family_id))!,binding_id:mapped.get(key('binding',candidate.binding.id))!,offer_id:mapped.get(key('offer',c.offer.id))!,workflow_id:mapped.get(key('workflow',c.flow.id))!,agent_id:mapped.get(key('agent',c.seller.id))!,collection_id:mapped.get(key('bank_profile',c.collection.id))!},records,
   write_order:{skeletons,immutable:ordered,finalize:skeletons},
   materials:records.filter(r=>r.kind==='asset').map(r=>({id:r.id,source:r.source,kind:r.body.kind,sha256:r.body.sha256??null,size_bytes:r.body.size_bytes??null,broker_required:true as const}))};
 });
 const plan={schema_version:1 as const,run_id:run,workspace_id:'number-lab:'+run,environment:'SIMULATION' as const,operation_class:'TEST' as const,snapshot_sha256:labHash(snapshot),configuration_sha256:snapshot.configuration_sha256,engine_sha256:snapshot.engine_sha256,account_id:accountId,variants,native_authority:false as const};
 return{...plan,sha256:labHash(plan)};
}
export type NumberLabConfigurationPlan=ReturnType<typeof compileNumberLabConfiguration>;
export type {NumberLabSnapshot};
