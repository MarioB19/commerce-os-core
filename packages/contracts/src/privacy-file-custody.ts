import {z} from 'zod';
const id=z.uuid().transform(v=>v.toLowerCase()),sha=z.string().regex(/^[a-f0-9]{64}$/);
export const privateFileDescriptorSchema=z.object({asset_id:id,storage_key:z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:-[a-f0-9]{64})?$/),ciphertext_sha256:sha,ciphertext_bytes:z.string().regex(/^[1-9]\d{0,8}$/).refine(v=>BigInt(v)<=512n*1024n*1024n)}).strict();
export const privateFileManifestSchema=z.object({schema_version:z.literal(1),job_id:id,workspace_id:z.string().min(1).max(256).refine(v=>!v.includes('\0')),plan_sha256:sha,inventory_sha256:sha,backup_fence_sha256:sha,files:z.array(privateFileDescriptorSchema).max(1000)}).strict().superRefine((v,c)=>{if(new Set(v.files.map(f=>f.asset_id)).size!==v.files.length||new Set(v.files.map(f=>f.storage_key)).size!==v.files.length||v.files.reduce((n,f)=>n+BigInt(f.ciphertext_bytes),0n)>2n*1024n*1024n*1024n)c.addIssue({code:'custom',message:'PRIVATE_FILE_MANIFEST_BOUND'});});
export const privateFileAuthoritySchema=z.object({manifest:privateFileManifestSchema,authorization_id:id,observed_at:z.iso.datetime({offset:true}),valid_until:z.iso.datetime({offset:true})}).strict();
export const privateFileRequestSchema=z.object({jobId:id,manifestSha256:sha}).strict();
export type PrivateFileManifest=z.infer<typeof privateFileManifestSchema>;
export type PrivateFileAuthority=z.infer<typeof privateFileAuthoritySchema>;
export type PrivateFileRequest=z.infer<typeof privateFileRequestSchema>;
/** Injected by the host; only the canonical DB owner can authenticate this
 * receipt and maintain the exclusive namespace writer lease throughout erase().
 * The filesystem component never turns caller JSON into authority. */
export interface PrivateFileAuthorityPort {load(request:PrivateFileRequest&{phase:'QUARANTINE'|'UNLINK'}):Promise<PrivateFileAuthority>}
