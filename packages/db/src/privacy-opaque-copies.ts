import {createDecipheriv,createHash} from 'node:crypto';
import {z} from 'zod';
import {serviceScopes,serviceResourceIdSchema} from '../../contracts/src/index.js';
import {profileIdSchema} from '../../contracts/src/profiles.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.uuid(),time=z.iso.datetime({offset:true}),text=z.string().min(1).max(1024);
const envs=z.array(z.enum(['REAL','SIMULATION'])).min(1).max(2).refine(v=>new Set(v).size===v.length);
const response=z.strictObject({_encrypted_response:z.string().min(1).max(12_000_000)});
const idem=z.strictObject({workspace_id:profileIdSchema,environment:z.literal('REAL'),actor_id:text,operation:text,key:z.string().min(8).max(160),request_hash:sha,scope_adoption_sha256:sha.nullable(),response,status_code:z.int().min(200).max(299),created_at:time});
const sale=z.strictObject({id:uuid,workspace_id:profileIdSchema,environment:z.literal('REAL'),actor_id:text,source:z.string().regex(/^[a-zA-Z0-9_-]{3,80}$/),status:z.enum(['PREVIEW','COMMITTED']),payload_ciphertext:z.string().min(1).max(12_000_000),preview:z.record(z.string(),z.unknown()),created_at:time,committed_at:time.nullable()});
const personal=z.strictObject({id:uuid,name:z.string().min(1).max(100),allowed_environments:envs,expires_at:time,revoked_at:z.null(),version:z.literal(1),created_at:time,token:z.string().regex(/^cos_pat_[A-Za-z0-9_-]{43}$/)});
const service=z.strictObject({id:uuid,token:z.string().regex(/^cos_v5_[A-Za-z0-9_-]{43}$/),name:z.string().min(1).max(100),scopes:z.array(z.enum(serviceScopes)).min(1).max(100),allowed_environments:envs,resource_ids:z.array(serviceResourceIdSchema).min(1).max(500).nullable(),expires_at:time});
const creative=z.strictObject({id:uuid,token:z.string().regex(/^cosp_[A-Za-z0-9_-]{43}$/),expires_at:time});
const issues=['INVALID_DATE','AMOUNT_REQUIRED','INVALID_AMOUNT_OR_CURRENCY','INVALID_AD_ID','INVALID_PRODUCT_ID','AMBIGUOUS_DUPLICATE_NEEDS_STABLE_ID','PRODUCT_NOT_FOUND','SOURCE_REVISION_CONFLICT'] as const;
const warnings=['CURRENCY_ASSUMED','POST_ID_IS_NOT_AD_ID','LEGACY_NAME_MARKER_REQUIRES_REVIEW','PRODUCT_NOT_RESOLVED','ALREADY_IMPORTED'] as const;
const member=z.strictObject({external_id:z.string().max(4096).nullable(),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),amount_minor:z.int().min(1).max(Number.MAX_SAFE_INTEGER),currency:z.string().regex(/^[A-Z]{3}$/),currency_source:z.enum(['source','configuration']),product_id:uuid.nullable(),product_label:z.string().max(4096).nullable(),ad_id:z.string().regex(/^\d+$/).max(128).nullable(),identifier_type:z.enum(['ad','post','unknown']),classification:z.literal('REPORTED'),legacy_marker:z.boolean(),evidence_verified:z.literal(false),issues:z.array(z.enum(issues)).max(8),warnings:z.array(z.enum(warnings)).max(8),source_key:sha,content_hash:sha});
const MAX_BYTES=8_388_608;
function need(value:unknown):asserts value{if(!value)throw Error('PRIVACY_OPAQUE_INVALID');}
function hash(value:string|Uint8Array){return createHash('sha256').update(value).digest('hex');}
// All projected property names are fixed ASCII, matching retention_canonical_json.
function canonical(value:unknown):string{if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value);}
function decode(value:string,bytes?:number){need(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value));const raw=Buffer.from(value,'base64');need(raw.toString('base64')===value&&(bytes===undefined||raw.length===bytes));return raw;}
function open(value:string,key:Uint8Array){const parts=value.split('.');need(parts.length===4&&parts[0]==='v1'&&parts[3]!.length>0&&parts[3]!.length<=Math.ceil(MAX_BYTES/3)*4);const iv=decode(parts[1]!,12),tag=decode(parts[2]!,16),data=decode(parts[3]!);need(data.length<=MAX_BYTES);const c=createDecipheriv('aes-256-gcm',key,iv);c.setAuthTag(tag);let partial:Buffer|undefined,tail:Buffer|undefined;try{partial=c.update(data);tail=c.final();return Buffer.concat([partial,tail]);}finally{partial?.fill(0);tail?.fill(0);}}
/** Pure, bounded authentication of a native opaque source. This is a candidate
 * for a privileged native binding, never EXCLUDED or an erasure permission.
 * sourceText must later be reread byte-exactly by the private031/035 attestor.
 * No environment/config/credential discovery, network, SQL or logging occurs. */
export function inspectPrivacyOpaqueCopy(input:{relation:'idempotency'|'sales_history_imports';workspaceId:string;sourceText:string},key:Uint8Array){
 let local:Buffer|undefined,plain:Buffer|undefined;
 try{
  const v=z.strictObject({relation:z.enum(['idempotency','sales_history_imports']),workspaceId:profileIdSchema,sourceText:z.string().min(1).max(12_000_000)}).parse(input);need(Buffer.byteLength(v.sourceText)<=12_000_000&&key instanceof Uint8Array&&key.byteLength===32);local=Buffer.from(key);
  const parsed:unknown=JSON.parse(v.sourceText),source=v.relation==='idempotency'?idem.parse(parsed):sale.parse(parsed);need(source.workspace_id===v.workspaceId);
  const ciphertext='response' in source?source.response._encrypted_response:source.payload_ciphertext;plain=open(ciphertext,local);const plaintextSha=hash(plain),value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));
  const base={schema_version:1 as const,relation:v.relation,workspace_id:v.workspaceId,environment:'REAL' as const,source_sha256:hash(v.sourceText),ciphertext_sha256:hash(ciphertext),plaintext_sha256:plaintextSha,requires_native_binding:true as const,erasure_authorized:false as const};
  if('operation' in source){
   let decoded:z.infer<typeof personal>|z.infer<typeof service>|z.infer<typeof creative>,credentialRelation:'personal_access_tokens'|'service_tokens';
   if(source.operation==='personal-token.create'||/^personal-token\.rotate:[a-f0-9-]{36}$/.test(source.operation)){decoded=personal.parse(value);credentialRelation='personal_access_tokens';if(source.operation!=='personal-token.create')uuid.parse(source.operation.slice('personal-token.rotate:'.length));}
   else if(source.operation==='service-token.create'){decoded=service.parse(value);credentialRelation='service_tokens';}
   else if(source.operation==='creative.token.create'){decoded=creative.parse(value);credentialRelation='service_tokens';}
   else throw Error('PRIVACY_OPAQUE_OPERATION_UNREVIEWED');
   const{token,...original}=decoded;const metadata={...original,expires_at:new Date(original.expires_at).toISOString(),...('created_at' in original?{created_at:new Date(original.created_at).toISOString()}: {})};
   return Object.freeze({...base,kind:'IDENTITY_CREDENTIAL_CANDIDATE' as const,credential_relation:credentialRelation,credential_id:decoded.id,token_sha256:hash(token),credential_metadata_sha256:hash(canonical(metadata))});
  }
  const rows=z.array(member).min(1).max(1000).parse(value);need(new Set(rows.map(r=>r.source_key)).size===rows.length);
  const members=rows.map(r=>{need(Number.isFinite(Date.parse(r.date))&&new Date(r.date).toISOString().slice(0,10)===r.date);const{external_id:_,product_label:__,source_key,content_hash,...body}=r;return Object.freeze({source_key_sha256:source_key,content_sha256:content_hash,reported_body_sha256:hash(canonical(body)),eligible:r.issues.length===0});});
  return Object.freeze({...base,kind:'SALES_IMPORT_MEMBERS_CANDIDATE' as const,import_id:source.id,import_state:source.status,members:Object.freeze(members)});
 }catch(error){
  if(error instanceof Error&&error.message==='PRIVACY_OPAQUE_OPERATION_UNREVIEWED')throw error;
  // eslint-disable-next-line preserve-caught-error -- Native crypto/Zod errors can contain private source data.
  throw Error('PRIVACY_OPAQUE_INVALID');
 }
 finally{plain?.fill(0);local?.fill(0);}
}
