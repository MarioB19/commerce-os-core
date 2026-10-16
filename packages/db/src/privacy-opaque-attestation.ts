import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {ProfileExecutor} from './profile-context.js';
import {profileIdSchema} from '../../contracts/src/profiles.js';
import {inspectPrivacyOpaqueCopy} from './privacy-opaque-copies.js';
const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),relation=z.enum(['idempotency','sales_history_imports']);
const target=z.strictObject({journeyId:uuid,sourceVersion:z.int().positive(),backupId:uuid,leaseId:uuid});
const capture=target.extend({receiptId:uuid,implementationId:uuid});
const source=z.strictObject({relation,key_sha256:sha,source_sha256:sha,source_text:z.string().min(1).max(12_000_000)});
const sources=z.strictObject({schema_version:z.literal(1),workspace_id:profileIdSchema,environment:z.literal('REAL'),journey_id:uuid,source_version:z.int().positive(),backup_id:uuid,authority_sha256:sha,source_set_sha256:sha,sources:z.array(source).max(128),erasure_authorized:z.literal(false)});
const bindingBase=z.strictObject({relation,key_sha256:sha,source_sha256:sha,ciphertext_sha256:sha,plaintext_sha256:sha,asset_refs:z.tuple([])});
const identity=bindingBase.extend({relation:z.literal('idempotency'),classification:z.literal('IDENTITY_ONLY'),credential_relation:z.enum(['personal_access_tokens','service_tokens']),credential_id:uuid,credential_sha256:sha});
const member=z.strictObject({source_key_sha256:sha,content_sha256:sha,reported_body_sha256:sha,eligible:z.literal(true),index:z.int().min(0).max(999),reported_id:uuid,order_id:uuid,reported_sha256:sha});
const imported=bindingBase.extend({relation:z.literal('sales_history_imports'),classification:z.literal('OWNED_IMPORT'),members:z.array(member).min(1).max(1000)});
const binding=z.discriminatedUnion('classification',[identity,imported]);
const receipt=z.strictObject({schema_version:z.literal(1),receipt_uuid:uuid,workspace_id:profileIdSchema,environment:z.literal('REAL'),journey_id:uuid,backup_id:uuid,source_set_sha256:sha,bindings_sha256:sha,bindings:z.array(binding).max(128),erasure_authorized:z.literal(false)});
const verified=receipt.extend({receipt_sha256:sha});
function need(v:unknown):asserts v{if(!v)throw Error('PRIVACY_OPAQUE_NATIVE_BINDING');}
function hash(v:string){return createHash('sha256').update(v).digest('hex');}
async function one(db:ProfileExecutor,sql:string,args:unknown[]){const r=await db.query(sql,args);need(r.rows.length===1&&Object.hasOwn(r.rows[0],'receipt'));return r.rows[0].receipt;}
function check(db:ProfileExecutor,v:z.infer<typeof receipt>,q:{journeyId:string;backupId:string;receiptId:string}){
 need(v.workspace_id===db.workspaceId&&v.journey_id===q.journeyId&&v.backup_id===q.backupId&&v.receipt_uuid===q.receiptId);
 need(new Set(v.bindings.map(b=>b.relation+':'+b.key_sha256)).size===v.bindings.length);
 for(const b of v.bindings)if(b.classification==='OWNED_IMPORT'){need(new Set(b.members.map(m=>m.source_key_sha256)).size===b.members.length);b.members.forEach((m,i)=>need(m.index===i));}
 return v;
}
/** Private attestor only: caller supplies a custody-held key, a reviewed native
 * implementation adoption, and an already fenced RR executor. No key discovery,
 * transaction creation, logging, retry or plaintext result. SQL re-derives every
 * source and native credential/import binding; runtime has no attestor role. */
export async function capturePrivacyOpaqueCopies(db:ProfileExecutor,input:z.input<typeof capture>,key:Uint8Array){
 const q=capture.parse(input);need(key instanceof Uint8Array&&key.byteLength===32);
 const s=sources.parse(await one(db,'SELECT privacy_opaque_sources($1,$2,$3,$4) receipt',[q.journeyId,q.sourceVersion,q.backupId,q.leaseId]));
 need(s.workspace_id===db.workspaceId&&s.journey_id===q.journeyId&&s.source_version===q.sourceVersion&&s.backup_id===q.backupId);
 need(s.sources.reduce((n,x)=>n+Buffer.byteLength(x.source_text),0)<=33_554_432&&new Set(s.sources.map(x=>x.relation+':'+x.key_sha256)).size===s.sources.length);
 const observations=s.sources.map(x=>{need(hash(x.source_text)===x.source_sha256);return{...inspectPrivacyOpaqueCopy({relation:x.relation,workspaceId:db.workspaceId,sourceText:x.source_text},key),key_sha256:x.key_sha256};});
 need(Buffer.byteLength(JSON.stringify(observations))<=4_194_304);
 const value=check(db,receipt.parse(await one(db,'SELECT import_privacy_opaque_pass($1,$2,$3,$4,$5,$6,$7) receipt',[q.receiptId,q.journeyId,q.sourceVersion,q.backupId,q.leaseId,q.implementationId,JSON.stringify(observations)])),q);
 need(value.source_set_sha256===s.source_set_sha256&&value.bindings.length===s.sources.length);
 for(let i=0;i<s.sources.length;i++){const a=s.sources[i]!,b=value.bindings[i]!;need(a.relation===b.relation&&a.key_sha256===b.key_sha256&&a.source_sha256===b.source_sha256);}
 return value;
}
/** This revalidation is a prerequisite for035/036, never erasure permission. */
export async function readPrivacyOpaquePass(db:ProfileExecutor,input:{receiptId:string;journeyId:string;backupId:string;leaseId:string}){
 const q=z.strictObject({receiptId:uuid,journeyId:uuid,backupId:uuid,leaseId:uuid}).parse(input),value=verified.parse(await one(db,'SELECT read_privacy_opaque_pass($1,$2,$3,$4) receipt',[q.receiptId,q.journeyId,q.backupId,q.leaseId]));check(db,value,q);return value;
}
