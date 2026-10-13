import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type pg from 'pg';
import {createDatabaseWorkerRuntime,decrypt} from '@commerce/db';
import {withWorkerProfilePhase} from '../../../packages/db/src/profile-worker-scope.js';
import {withProfileTransaction} from '../../../packages/db/src/profile-context.js';
import {PostgresReceiptDocumentAi,type ReceiptAiDocument} from '../../../packages/ai-providers/src/receipt-document.js';
import {aiCredentialKey} from '../../../packages/ai-providers/src/profile-integrations.js';
import {processProfileReceiptAnalyses,type ReceiptAnalysisRuntime,type ReceiptMediaBroker} from './receipt-ai.js';
import {profileAiPool} from './ai-runtime.js';

/** V7 F5 (RF-09, RF-14.c): receipts of orders that captured a policy are read
 * with the variant's own `receipt.document` grant (minted by the owner when
 * the variant's AI was confirmed) and the business's key. A variant without
 * that grant, or a host without the AI login, leaves the receipt for a person.
 * The model never decides: the captured policy does. */
export const RECEIPT_MAXIMUM_MICROUSD=250_000;
const MAX_RECEIPT_BYTES=20*1024*1024;

/** Reads only the authenticated asset version named by the frame, from the
 * encrypted private store, and checks its bytes against the captured hash. */
export function privateReceiptMedia(root=process.env.PRIVATE_STORAGE_DIR??process.env.ASSET_STORAGE_DIR):ReceiptMediaBroker{
 return{async read(document:ReceiptAiDocument,assetVersion:number){
  if(!root)throw new Error('PRIVATE_ASSET_NOT_CONFIGURED');
  const key=await withWorkerProfilePhase(async db=>{
   const row=(await db.query("SELECT body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='asset' AND id=$3 AND version=$4",[document.workspaceId,document.environment,document.asset.id,assetVersion])).rows[0];
   const storage=row?.body?.storage_key;
   if(typeof storage!=='string'||!/^[a-f0-9-]{36}(?:-[a-f0-9]{64})?$/.test(storage)||row.body.sha256!==document.asset.sha256)throw new Error('PROTECTED_RECEIPT_ASSET_REQUIRED');
   return storage;
  });
  const bytes=Buffer.from(decrypt(await readFile(join(root,'assets',`${key}.enc`),'utf8')),'base64');
  if(bytes.length===0||bytes.length>MAX_RECEIPT_BYTES||createHash('sha256').update(bytes).digest('hex')!==document.asset.sha256){bytes.fill(0);throw new Error('PROTECTED_RECEIPT_ASSET_CHANGED');}
  return new Uint8Array(bytes);
 }};
}

/** Current receipt grants of one profile, read by the AI login itself. */
export async function receiptGrants(aiPool:pg.Pool,workspaceId:string){
 return withProfileTransaction(aiPool as never,workspaceId,async db=>{
  await db.query("SELECT set_config('app.environment','REAL',true)");
  const rows=(await db.query(`SELECT DISTINCT ON(variant_id) id,variant_id FROM ai_runtime_grants WHERE workspace_id=$1 AND environment='REAL' AND task='receipt.document'
   AND NOT is_test AND revoked_at IS NULL AND variant_id IS NOT NULL AND expires_at>clock_timestamp()+interval '5 minutes' ORDER BY variant_id,expires_at DESC,id`,[workspaceId])).rows as {id:string;variant_id:string}[];
  return new Map(rows.map(r=>[r.variant_id,r.id]));
 });
}

export function receiptRuntime(input:{aiPool:pg.Pool;grants:Map<string,string>;custodyKey:Uint8Array;media:ReceiptMediaBroker;fetcher?:typeof fetch;clock?:()=>number}):ReceiptAnalysisRuntime{
 return{media:input.media,bind(document){
  const grantId=input.grants.get(document.variantId);
  if(!grantId)return null;
  return new PostgresReceiptDocumentAi({pool:input.aiPool as never,grantId,custodyKey:input.custodyKey,maximumMicrousd:RECEIPT_MAXIMUM_MICROUSD,
   ...(input.fetcher?{fetcher:input.fetcher}:{}),...(input.clock?{clock:input.clock}:{})});
 }};
}

/** Automation tick step: one bounded pass per active profile. A failure in one
 * profile is reported by code and never stops the rest of the tick. Tests
 * inject the worker runtime, AI login, key, provider transport and media. */
type Workers=ReturnType<typeof createDatabaseWorkerRuntime>;
export async function processVariantReceipts(limit=3,deps:{workers?:Workers;aiPool?:pg.Pool|null;custodyKey?:Uint8Array;fetcher?:typeof fetch;media?:ReceiptMediaBroker}={}){
 const aiPool=deps.aiPool!==undefined?deps.aiPool:profileAiPool();let custodyKey:Uint8Array|null=deps.custodyKey??null;
 if(aiPool&&!custodyKey){try{custodyKey=aiCredentialKey();}catch{custodyKey=null;}}
 const runtime=deps.workers??createDatabaseWorkerRuntime('commerce_automation','REAL');let processed=0;
 let profiles:Awaited<ReturnType<Workers['discover']>>=[];
 try{profiles=await runtime.discover();}catch(error){process.stderr.write(`variant_receipts_discovery_failed ${code(error)}\n`);return 0;}
 for(const profile of profiles){
  if(profile.state!=='ACTIVE')continue;
  try{
   const analysis=aiPool&&custodyKey?receiptRuntime({aiPool,grants:await receiptGrants(aiPool,profile.workspaceId),custodyKey,media:deps.media??privateReceiptMedia(),...(deps.fetcher?{fetcher:deps.fetcher}:{})}):undefined;
   processed+=await runtime.run(profile,()=>processProfileReceiptAnalyses(analysis,limit));
  }catch(error){process.stderr.write(`variant_receipts_failed ${code(error)}\n`);}
 }
 return processed;
}
const code=(error:unknown)=>error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'UNEXPECTED';
