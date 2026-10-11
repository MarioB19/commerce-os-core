import {createHash} from 'node:crypto';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {query,withTransaction,getRecord,pool,encrypt,decrypt,appendEvent,uuid,readOperationalSettings} from '@commerce/db';
import {providerFor,type ProviderFactory} from './providers.js';

const supportedMedia=new Set(['application/pdf','image/png','image/jpeg','image/webp','audio/mpeg','audio/ogg','video/mp4','application/octet-stream','text/plain']);
const maxFailures=10;
const terminalFailures=new Set(['MEDIA_UNSUPPORTED_OR_TOO_LARGE','SIMULATION_EXTERNAL_PROVIDER_DENIED','MEDIA_REFERENCE_REQUIRED','MEDIA_REFERENCE_INVALID','MEDIA_ORIGIN_DENIED']);

/** GET retries have no customer-facing effect. A permanent error or ten failed
 * attempts closes the media job so an unavailable attachment cannot retry forever. */
export async function downloadInboundMedia(limit=10,factory:ProviderFactory=providerFor){
 const rows=(await query(`SELECT e.*,
  (SELECT count(*)::int FROM domain_events f WHERE f.event_type='channel.media.download_failed' AND f.causation_id=e.id::text) failure_count
  FROM domain_events e WHERE e.event_type='provider.media.observed'
  AND NOT EXISTS(SELECT 1 FROM consumer_receipts c WHERE c.consumer='media-v1' AND c.event_id=e.id)
  AND NOT EXISTS(SELECT 1 FROM domain_events f WHERE f.event_type='channel.media.download_failed' AND f.causation_id=e.id::text AND f.recorded_at>now()-interval '30 seconds')
  ORDER BY e.recorded_at LIMIT $1`,[limit])).rows;
 for(const source of rows){
  const account=await getRecord(pool,source.workspace_id,'channel_account',source.aggregate_id);
  if(!account)continue;
  let stored:{storage_key:string;sha256:string;size_bytes:number;mime_type:string}|undefined;
  let failure:string|undefined;
  try{
   if(account.environment==='SIMULATION'&&account.body.provider!=='simulator')throw new Error('SIMULATION_EXTERNAL_PROVIDER_DENIED');
   const root=process.env.PRIVATE_STORAGE_DIR??process.env.ASSET_STORAGE_DIR;
   if(!root)throw new Error('PRIVATE_STORAGE_NOT_CONFIGURED');
   const reference=source.payload.media_ciphertext?JSON.parse(decrypt(source.payload.media_ciphertext)):source.payload.media??{};
   const observe=async()=>(await factory(account)).media(reference);const media=account.environment==='REAL'?await withTransaction(async c=>{if((await readOperationalSettings(c,account.workspace_id,'REAL',{lock:'share'})).release_hold)throw new Error('RELEASE_HOLD_ACTIVE');return observe();}):await observe();
   const mime=media.mimeType.split(';')[0]!.trim().toLowerCase();
   if(!supportedMedia.has(mime)||media.bytes.length>16*1024*1024)throw new Error('MEDIA_UNSUPPORTED_OR_TOO_LARGE');
   const sha=createHash('sha256').update(media.bytes).digest('hex');
   const key=`${source.id}-${sha}`;
   await mkdir(join(root,'assets'),{recursive:true,mode:0o700});
   const temp=join(root,'assets',`${key}.${uuid()}.tmp`);
   await writeFile(temp,encrypt(Buffer.from(media.bytes).toString('base64')),{mode:0o600});
   await rename(temp,join(root,'assets',`${key}.enc`));
   stored={storage_key:key,sha256:sha,size_bytes:media.bytes.length,mime_type:mime};
  }catch(error){if(error instanceof Error&&error.message==='RELEASE_HOLD_ACTIVE')continue;failure=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'MEDIA_DOWNLOAD_FAILED';}
  await withTransaction(async c=>{
   if(account.environment==='REAL'&&(await readOperationalSettings(c,account.workspace_id,'REAL',{lock:'share'})).release_hold)return;
   if(failure){
    const attempts=Number(source.failure_count)+1;
    const terminal=terminalFailures.has(failure)||attempts>=maxFailures;
    if(terminal){
     const receipt=await c.query(`INSERT INTO consumer_receipts(consumer,event_id) VALUES('media-v1',$1) ON CONFLICT DO NOTHING RETURNING event_id`,[source.id]);
     if(!receipt.rowCount)return;
    }
    await appendEvent(c,{workspace_id:source.workspace_id,environment:source.environment,event_type:'channel.media.download_failed',aggregate_id:source.aggregate_id,causation_id:source.id,payload:{message_id:source.payload.message_id,conversation_id:source.payload.conversation_id,envelope_id:source.payload.envelope_id,reason:failure,attempts,terminal}});
    return;
   }
   const receipt=await c.query(`INSERT INTO consumer_receipts(consumer,event_id) VALUES('media-v1',$1) ON CONFLICT DO NOTHING RETURNING event_id`,[source.id]);
   if(!receipt.rowCount)return;
   await appendEvent(c,{workspace_id:source.workspace_id,environment:source.environment,event_type:'channel.media.stored',aggregate_id:source.aggregate_id,causation_id:source.id,payload:{asset_id:source.id,message_id:source.payload.message_id,conversation_id:source.payload.conversation_id,envelope_id:source.payload.envelope_id,...stored}});
  });
 }
 return rows.length;
}
