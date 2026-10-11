import {it,expect,afterAll} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pool,putRecord,appendEvent,encrypt,decrypt} from '../../packages/db/src/index.js';
import {processInbound} from '../../apps/automation-worker/src/inbound.js';
import {materializeInboundMedia,materializeFailedInboundMedia} from '../../apps/automation-worker/src/media.js';
import {downloadInboundMedia} from '../../apps/channel-worker/src/media.js';
import {SimulatorProvider} from '../../packages/messaging/src/index.js';
const workspace='media-'+randomUUID();afterAll(async()=>pool.end());
it('receives media, downloads with channel credentials boundary, seals protected artifact and starts documentary review',async()=>{
 const product=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'product',body:{name:'Media fixture'}});const offer=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'offer',body:{product_id:product.id,currency:'MXN',base_amount_minor:9900,fulfillment:[],status:'PUBLISHED'}});
 const account=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Fixture line',provider:'simulator',offer_version_id:offer.id}});const contact=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'contact',body:{name:'Fixture contact',identity:'opaque:media-customer'}});const conversation=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:{contact_id:contact.id,account_id:account.id,offer_version_id:offer.id,stage:'COMMITTED',status:'OPEN',flow_state:{status:'WAITING',waiting_for:'receipt_approved',node_id:'benefit',steps:4,stack:[],variables:{}}}});
 const body={id:'fixture-media-event',identity:'opaque:media-customer',kind:'document',text:'Receipt fixture',media:{providerId:'fixture:pdf',mimeType:'application/pdf'}};await pool.query(`INSERT INTO inbound_envelopes(workspace_id,environment,account_id,provider,provider_event_id,payload_ciphertext,metadata,occurred_at) VALUES($1,'SIMULATION',$2,'simulator',$3,$4,'{}',now())`,[workspace,account.id,body.id,encrypt(body)]);
 await processInbound();await downloadInboundMedia(10,()=>new SimulatorProvider());await materializeInboundMedia();await downloadInboundMedia(10,()=>new SimulatorProvider());await materializeInboundMedia();
 const assets=(await pool.query(`SELECT * FROM records WHERE workspace_id=$1 AND kind='asset'`,[workspace])).rows;expect(assets).toHaveLength(1);expect(assets[0].body).toMatchObject({source:'channel_ingress',immutable:true,status:'READY',mime_type:'application/pdf'});const encrypted=await readFile(join(process.env.PRIVATE_STORAGE_DIR??process.env.ASSET_STORAGE_DIR!,'assets',assets[0].body.storage_key+'.enc'),'utf8');expect(encrypted).not.toContain('%PDF');const bytes=Buffer.from(decrypt(encrypted),'base64');expect(createHash('sha256').update(bytes).digest('hex')).toBe(assets[0].body.sha256);
 const messages=(await pool.query(`SELECT body FROM records WHERE workspace_id=$1 AND kind='message'`,[workspace])).rows;expect(messages[0].body.asset_id).toBe(assets[0].id);expect(messages[0].body.media_status).toBe('READY');expect(messages[0].body.media.status).toBe('READY');
 const receipts=(await pool.query(`SELECT body FROM records WHERE workspace_id=$1 AND kind='receipt'`,[workspace])).rows;expect(receipts).toHaveLength(1);expect(receipts[0].body).toMatchObject({conversation_id:conversation.id,asset_id:assets[0].id,status:'HUMAN_REVIEW'});
});

it('keeps unrelated early media private and promotes only an explicitly payment-labelled attachment',async()=>{
 const scopedWorkspace='media-early-'+randomUUID();
 const product=await putRecord(pool,{workspaceId:scopedWorkspace,environment:'SIMULATION',kind:'product',body:{name:'Early media fixture'}});
 const offer=await putRecord(pool,{workspaceId:scopedWorkspace,environment:'SIMULATION',kind:'offer',body:{product_id:product.id,currency:'MXN',base_amount_minor:9700,fulfillment:[],status:'PUBLISHED'}});
 const account=await putRecord(pool,{workspaceId:scopedWorkspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Early fixture line',provider:'simulator',offer_version_id:offer.id}});
 const contact=await putRecord(pool,{workspaceId:scopedWorkspace,environment:'SIMULATION',kind:'contact',body:{name:'Early fixture contact',identity:'opaque:early-media-customer'}});
 const conversation=await putRecord(pool,{workspaceId:scopedWorkspace,environment:'SIMULATION',kind:'conversation',body:{contact_id:contact.id,account_id:account.id,product_id:product.id,offer_version_id:offer.id,routing_state:'RESOLVED',stage:'NEW',status:'OPEN',flow_state:{status:'WAITING',waiting_for:'commitment',node_id:'commitment',steps:1,stack:[],variables:{}}}});
 const ingest=async(text:string)=>{
  const eventId='fixture-media-'+randomUUID();
  const body={id:eventId,identity:'opaque:early-media-customer',kind:'document',text,media:{providerId:'fixture:pdf',mimeType:'application/pdf'}};
  await pool.query(`INSERT INTO inbound_envelopes(workspace_id,environment,account_id,provider,provider_event_id,payload_ciphertext,metadata,occurred_at) VALUES($1,'SIMULATION',$2,'simulator',$3,$4,'{}',now())`,[scopedWorkspace,account.id,eventId,encrypt(body)]);
  await processInbound();await downloadInboundMedia(10,()=>new SimulatorProvider());await materializeInboundMedia();
 };
 await ingest('Es una foto del cuaderno, necesito ayuda para abrirlo.');
 expect((await pool.query("SELECT count(*)::int count FROM records WHERE workspace_id=$1 AND kind='receipt'",[scopedWorkspace])).rows[0].count).toBe(0);
 await ingest('No es comprobante, es una captura del error de acceso.');
 expect((await pool.query("SELECT count(*)::int count FROM records WHERE workspace_id=$1 AND kind='receipt'",[scopedWorkspace])).rows[0].count).toBe(0);
 await ingest('Adjunto mi comprobante de pago.');
 const receipts=(await pool.query("SELECT body FROM records WHERE workspace_id=$1 AND kind='receipt'",[scopedWorkspace])).rows;
 expect(receipts).toHaveLength(1);expect(receipts[0].body).toMatchObject({conversation_id:conversation.id,status:'HUMAN_REVIEW',analysis_status:'PENDING'});
});

it('stores an inbound WebP attachment without treating it as a payment receipt',async()=>{
 const scopedWorkspace='media-webp-'+randomUUID();
 const account=await putRecord(pool,{workspaceId:scopedWorkspace,environment:'SIMULATION',kind:'channel_account',body:{provider:'simulator'}});
 const message=await putRecord(pool,{workspaceId:scopedWorkspace,environment:'SIMULATION',kind:'message',body:{direction:'INBOUND',text:'Foto del material',media_status:'PENDING'}});
 const source=await appendEvent(pool,{workspace_id:scopedWorkspace,environment:'SIMULATION',event_type:'provider.media.observed',aggregate_id:account.id,payload:{message_id:message.id,media:{providerId:'fixture:webp'}}});
 const provider=new SimulatorProvider();provider.media=async()=>({bytes:Buffer.from('RIFF0000WEBPVP8 '),mimeType:'image/webp; charset=binary'});
 await downloadInboundMedia(10,()=>provider);
 const stored=(await pool.query("SELECT payload FROM domain_events WHERE causation_id=$1 AND event_type='channel.media.stored'",[source.id])).rows;
 expect(stored).toHaveLength(1);expect(stored[0].payload.mime_type).toBe('image/webp');
 expect((await pool.query("SELECT count(*)::int count FROM consumer_receipts WHERE consumer='media-v1' AND event_id=$1",[source.id])).rows[0].count).toBe(1);
});

it('ends a repeatedly unavailable media download and marks the attachment failed',async()=>{
 const scopedWorkspace='media-failed-'+randomUUID();
 const account=await putRecord(pool,{workspaceId:scopedWorkspace,environment:'SIMULATION',kind:'channel_account',body:{provider:'simulator'}});
 const message=await putRecord(pool,{workspaceId:scopedWorkspace,environment:'SIMULATION',kind:'message',body:{direction:'INBOUND',media:{status:'PENDING',mime_type:'image/webp'},media_status:'PENDING'}});
 const source=await appendEvent(pool,{workspace_id:scopedWorkspace,environment:'SIMULATION',event_type:'provider.media.observed',aggregate_id:account.id,payload:{message_id:message.id,media:{providerId:'fixture:expired'}}});
 for(let attempt=1;attempt<=9;attempt++)await pool.query(
  `INSERT INTO domain_events(workspace_id,environment,event_type,aggregate_id,correlation_id,causation_id,payload,recorded_at)
   VALUES($1,'SIMULATION','channel.media.download_failed',$2,$3,$4,$5,now()-interval '31 seconds')`,
  [scopedWorkspace,account.id,randomUUID(),source.id,{reason:'MEDIA_FETCH_FAILED',attempts:attempt}],
 );
 const provider=new SimulatorProvider();provider.media=async()=>{throw new Error('MEDIA_FETCH_FAILED');};
 await downloadInboundMedia(10,()=>provider);
 const failures=(await pool.query("SELECT payload FROM domain_events WHERE causation_id=$1 AND event_type='channel.media.download_failed' ORDER BY recorded_at",[source.id])).rows;
 expect(failures).toHaveLength(10);expect(failures.at(-1)?.payload).toMatchObject({reason:'MEDIA_FETCH_FAILED',attempts:10,terminal:true});
 expect((await pool.query("SELECT body->'media'->>'status' status FROM records WHERE id=$1",[message.id])).rows[0].status).toBe('PENDING');
 await materializeFailedInboundMedia();
 expect((await pool.query("SELECT body FROM records WHERE id=$1",[message.id])).rows[0].body).toMatchObject({media:{status:'FAILED'},media_status:'FAILED',media_failure_reason:'MEDIA_FETCH_FAILED'});
 expect((await pool.query("SELECT count(*)::int count FROM consumer_receipts WHERE consumer='media-v1' AND event_id=$1",[source.id])).rows[0].count).toBe(1);
 await materializeFailedInboundMedia();
 expect((await pool.query("SELECT count(*)::int count FROM consumer_receipts c JOIN domain_events e ON e.id=c.event_id WHERE c.consumer='media-sales-failure-v1' AND e.causation_id=$1",[source.id])).rows[0].count).toBe(1);
 await downloadInboundMedia(10,()=>provider);
 expect((await pool.query("SELECT count(*)::int count FROM domain_events WHERE causation_id=$1 AND event_type='channel.media.download_failed'",[source.id])).rows[0].count).toBe(10);
});
