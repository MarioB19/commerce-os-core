import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
export const intakeCanonical=(value:unknown):string=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(intakeCanonical).join(',')}]`:`{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>`${JSON.stringify(k)}:${intakeCanonical(v)}`).join(',')}}`;
export const intakeHash=(value:unknown)=>sha(intakeCanonical(value));
const Sha=z.string().regex(/^[a-f0-9]{64}$/),Variant=z.string().regex(/^A0[1-6]-h[1-3]$/);
export const PlaybookReceiptInputSchema=z.object({
 author_reference:z.string().trim().min(5).max(500),
 sources:z.array(z.object({source_id:z.string().uuid(),sha256:Sha,content:z.string().max(500000)}).strict()).min(1).max(30),
 fields:z.array(z.object({key:z.string().min(1).max(200),layer:z.enum(['configuration','narration','meta','direction','display']),source_id:z.string().uuid(),source_sha256:Sha,pointer:z.string().max(500),value:z.unknown(),targets:z.array(z.object({variant_id:Variant,recipe_pointer:z.string().startsWith('/').max(500)}).strict()).min(1).max(18)}).strict()).min(1).max(1000),
}).strict();
export type PlaybookReceiptInput=z.infer<typeof PlaybookReceiptInputSchema>;
export type PlaybookIssue={code:string;field:string;message:string};
export type PlaybookReceipt=PlaybookReceiptInput&{schema_version:1;received_by:string;received_at:string;technical_conformance:'PASS'|'FAIL';editorial_approval:'PENDING';issues:PlaybookIssue[]};
export const PlaybookReceiptSchema=PlaybookReceiptInputSchema.extend({schema_version:z.literal(1),received_by:z.string().min(1),received_at:z.string().datetime(),technical_conformance:z.enum(['PASS','FAIL']),editorial_approval:z.literal('PENDING'),issues:z.array(z.object({code:z.string(),field:z.string(),message:z.string()}))}).strict();
export type IntakeEvidence={receipt:PlaybookReceipt;variant_id:string;receipt_sha256:string};
/** New recipes require the immutable receipt copied by the API; legacy recipes retain their existing checks. */
export function validateIntakeEvidence(recipe:unknown,evidence:unknown):PlaybookIssue[]{
 if((recipe as any)?.engine_version!=='1.1.0')return[];
 const parsed=z.object({receipt:PlaybookReceiptSchema,variant_id:Variant,receipt_sha256:Sha}).strict().safeParse(evidence);
 if(!parsed.success)return[{code:'PLAYBOOK_INTAKE_REQUIRED',field:'playbookIntake',message:'Falta la recepción exacta del playbook y la variante del lote.'}];
 const value=parsed.data;
 if(value.receipt_sha256!==intakeHash(value.receipt)||value.receipt.technical_conformance!=='PASS')return[{code:'PLAYBOOK_RECEIPT_INVALID',field:'playbookIntake',message:'La recepción fue alterada o no pasó la conformidad técnica.'}];
 return inspectRecipeIntake(recipe,value.variant_id,value.receipt);
}
/** RFC6901 own-property traversal; empty pointer references the entire document. */
export function valueAtPointer(document:unknown,pointer:string):{found:boolean;value?:unknown}{
 if(pointer==='')return{found:true,value:document};
 if(!pointer.startsWith('/')||/~(?:[^01]|$)/u.test(pointer))return{found:false};
 let current:any=document;
 for(const part of pointer.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'))){
  if(['__proto__','constructor','prototype'].includes(part)||current===null||typeof current!=='object'||!Object.hasOwn(current,part)||Array.isArray(current)&&!/^(0|[1-9]\d*)$/.test(part))return{found:false};
  current=current[part];
 }
 return current===undefined?{found:false}:{found:true,value:current};
}
export function verifyPlaybookReceipt(input:PlaybookReceiptInput):PlaybookIssue[]{
 const issues:PlaybookIssue[]=[],docs=new Map<string,unknown>(),seen=new Set<string>(),keys=new Set<string>(),targetPaths=new Set<string>();
 for(const s of input.sources){
  if(seen.has(s.source_id))issues.push({code:'INTAKE_SOURCE_DUPLICATE',field:s.source_id,message:'Una fuente debe aparecer una sola vez.'});seen.add(s.source_id);
  if(sha(s.content)!==s.sha256)issues.push({code:'INTAKE_SOURCE_HASH_MISMATCH',field:s.source_id,message:'Los bytes de la fuente no coinciden con el SHA registrado.'});
  try{docs.set(s.source_id,JSON.parse(s.content));}catch{docs.set(s.source_id,s.content);}
 }
 for(const f of input.fields){
  if(keys.has(f.key))issues.push({code:'INTAKE_FIELD_DUPLICATE',field:f.key,message:'La clave editorial está repetida.'});keys.add(f.key);
  const s=input.sources.find(s=>s.source_id===f.source_id),found=valueAtPointer(docs.get(f.source_id),f.pointer);
  if(!s||s.sha256!==f.source_sha256||!found.found||!isDeepStrictEqual(found.value,f.value))issues.push({code:'INTAKE_VALUE_MISMATCH',field:f.key,message:'El valor no coincide exactamente con fuente y locator; no se rellena ni corrige.'});
  for(const t of f.targets){const key=`${t.variant_id}:${t.recipe_pointer}`;if(targetPaths.has(key))issues.push({code:'INTAKE_TARGET_DUPLICATE',field:f.key,message:'Dos campos intentan gobernar la misma salida de la variante.'});targetPaths.add(key);}
 }
 return issues;
}
export function receivePlaybook(input:unknown,actorId:string,now=new Date()):PlaybookReceipt{
 const parsed=PlaybookReceiptInputSchema.parse(input),issues=verifyPlaybookReceipt(parsed);
 return{...parsed,schema_version:1,received_by:actorId,received_at:now.toISOString(),technical_conformance:issues.length?'FAIL':'PASS',editorial_approval:'PENDING',issues};
}
export function inspectRecipeIntake(recipe:unknown,variantId:string,receipt:PlaybookReceipt):PlaybookIssue[]{
 const issues=verifyPlaybookReceipt(receipt),targets=receipt.fields.flatMap(f=>f.targets.filter(t=>t.variant_id===variantId).map(t=>({f,t}))),r=recipe as any;
 const required=['/content/product_name','/content/audience','/content/angle','/content/hook','/content/body','/content/cta',...['primary_text','headline','description','whatsapp_message'].map(k=>`/content/ad_copy/${k}`)];
 for(const [i] of (r?.presentation?.overlays??[]).entries())required.push(`/presentation/overlays/${i}/text`);
 for(const pointer of required)if(!targets.some(({t})=>t.recipe_pointer===pointer))issues.push({code:'INTAKE_RECIPE_FIELD_MISSING',field:pointer,message:'Falta el campo exacto recibido para esta variante.'});
 for(const {f,t} of targets){const actual=valueAtPointer(recipe,t.recipe_pointer);if(!actual.found||!isDeepStrictEqual(actual.value,f.value))issues.push({code:'INTAKE_RECIPE_DRIFT',field:t.recipe_pointer,message:'La receta difiere del valor recibido y requiere otra versión de entradas.'});}
 return issues;
}
export function intakeImpact(previous:PlaybookReceipt,next:PlaybookReceipt){
 const before=new Map(previous.fields.map(f=>[f.key,f])),after=new Map(next.fields.map(f=>[f.key,f]));
 const authored=(f:PlaybookReceiptInput['fields'][number]|undefined)=>f&&({value:f.value,layer:f.layer,targets:f.targets,pointer:f.pointer,source_id:f.source_id});
 const changed=[...new Set([...before.keys(),...after.keys()])].filter(k=>!isDeepStrictEqual(authored(before.get(k)),authored(after.get(k))));
 const variants=new Set<string>(),stages=new Set<string>();
 for(const key of changed){const f=after.get(key)??before.get(key)!;for(const t of [...(before.get(key)?.targets??[]),...(after.get(key)?.targets??[])]){variants.add(t.variant_id);if(t.recipe_pointer==='/content/body'||t.recipe_pointer==='/voice/body_asset')for(const hook of [1,2,3])variants.add(`${t.variant_id.split('-')[0]}-h${hook}`);}
  const dependent=f.layer==='meta'?['copy','editorial']:f.layer==='narration'?['voice','captions','render','qa','editorial']:f.layer==='direction'?['assets','render','qa','editorial']:['render','qa','editorial'];dependent.forEach(s=>stages.add(s));
 }
 return{changed_fields:changed.sort(),affected_variants:[...variants].sort(),stale_stages:[...stages].sort(),provenance_changed:intakeHash(previous.sources.map(({source_id,sha256})=>({source_id,sha256})))!==intakeHash(next.sources.map(({source_id,sha256})=>({source_id,sha256}))),approval_review_required:intakeHash(previous)!==intakeHash(next),originals_preserved:true};
}
