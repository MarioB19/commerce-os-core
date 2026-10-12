import {z} from 'zod';
import {createHash} from 'node:crypto';
import {warmupContentSchema,warmupProfileSchema} from './policy.js';
const uuid=z.uuid().transform(v=>v.toLowerCase()),sha=z.string().regex(/^[a-f0-9]{64}$/);
export const legacyQrAdoptionSchema=z.object({operationId:uuid,accountId:uuid,expectedStateVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),snapshotSha256:sha}).strict();
export const legacyQrSnapshotSchema=z.object({workspaceId:z.string().min(1),environment:z.enum(['REAL','SIMULATION']),accountId:uuid,
 stateVersion:z.number().int().positive(),poolId:uuid,profileId:uuid,episodeId:uuid.nullable(),policyVersion:z.enum(['legacy-30d/v1','standard-15d/v1','standard-15d/v2']),
 topology:z.enum(['direct','group']),purpose:z.enum(['preparation','maintenance']),programId:uuid.nullable(),groupId:uuid.nullable(),groupVersion:z.number().int().positive().nullable(),
 configSha256:sha,identityFingerprint:sha,grantId:uuid,connectionId:uuid,
 content:z.array(z.object({id:uuid,hash:sha}).strict()).min(1).max(1000),
}).strict();
export type LegacyQrSnapshot=z.infer<typeof legacyQrSnapshotSchema>;
function canonical(value:unknown):string{if(Array.isArray(value))return'['+value.map(canonical).join(',')+']';if(value!==null&&typeof value==='object')return'{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value);}
export function adoptionDigest(value:unknown){return createHash('sha256').update(canonical(value)).digest('hex');}
/** Historical policies remain themselves. Nothing maps a legacy counter to v2
 * credits, changes an episode, or treats a recorded QR grant as channel health. */
export function legacyQrSnapshot(input:Omit<LegacyQrSnapshot,'configSha256'|'policyVersion'|'content'>&{config:unknown;content:readonly{id:string;content_hash:string;body:unknown;origin?:string}[]}){
 const config=warmupProfileSchema.parse(input.config);
 const content=input.content.map(row=>{const body=warmupContentSchema.parse(row.body);if(row.content_hash!==adoptionDigest(body))throw Error('ADOPTION_CONTENT_CHANGED');return{id:row.id,hash:row.content_hash};}).sort((a,b)=>a.id.localeCompare(b.id));
 if(new Set(content.map(row=>row.id)).size!==content.length)throw Error('ADOPTION_CONTENT_DUPLICATE');
 const {config:_config,content:_content,...rest}=input;
 const snapshot=legacyQrSnapshotSchema.parse({...rest,configSha256:adoptionDigest(config),policyVersion:config.policy_version,content});
 return{snapshot,sha256:adoptionDigest(snapshot)};
}
