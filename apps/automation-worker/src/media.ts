import {query,withTransaction,getRecord,putRecord} from '@commerce/db';
import {save,event} from './shared.js';
import {applyCommand} from './commands.js';
function explicitReceiptIntent(text:string){
 const value=text.trim().toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ');
 if(!value)return false;
 const subject='(?:comprobante|recibo|ticket|pago|transferencia|deposito)';
 if(new RegExp(`\\b(?:no|nunca|todavia no|aun no)\\b[^.!?]{0,40}\\b${subject}\\b`).test(value))return false;
 return /\b(?:ya\s+)?(?:pague|deposite|transferi)\b/.test(value)
  ||/\b(?:adjunto|envio|mando|comparto|paso|aqui esta|te dejo)\b[^.!?]{0,40}\b(?:comprobante|recibo|ticket)\b/.test(value)
  ||/\b(?:comprobante|recibo|ticket)\b[^.!?]{0,24}\b(?:pago|transferencia|deposito)\b/.test(value)
  ||/\b(?:pago|transferencia|deposito)\b[^.!?]{0,24}\b(?:realizado|hecho|completado|listo)\b/.test(value);
}
export async function materializeInboundMedia(limit=50){const rows=(await query(`SELECT e.* FROM domain_events e WHERE e.event_type='channel.media.stored' AND NOT EXISTS(SELECT 1 FROM consumer_receipts c WHERE c.consumer='media-sales-v1' AND c.event_id=e.id) ORDER BY e.recorded_at LIMIT $1`,[limit])).rows;
 for(const observation of rows)await withTransaction(async c=>{const claimed=await c.query(`INSERT INTO consumer_receipts(consumer,event_id) VALUES('media-sales-v1',$1) ON CONFLICT DO NOTHING RETURNING event_id`,[observation.id]);if(!claimed.rowCount)return;const p=observation.payload;let asset=await getRecord(c,observation.workspace_id,'asset',p.asset_id);if(!asset)asset=await putRecord(c,{id:p.asset_id,workspaceId:observation.workspace_id,environment:observation.environment,kind:'asset',body:{name:`Archivo recibido ${p.asset_id.slice(0,8)}`,kind:'file',source:'channel_ingress',immutable:true,status:'READY',adapter:'private_file',storage_key:p.storage_key,sha256:p.sha256,size_bytes:p.size_bytes,mime_type:p.mime_type,message_id:p.message_id,envelope_id:p.envelope_id,channel_event_id:observation.id}});
 const message=await getRecord(c,observation.workspace_id,'message',p.message_id);if(!message)return;await save(c,message,{...message.body,asset_id:asset.id,media:{...message.body.media,status:'READY'},media_status:'READY'});const conversation=await getRecord(c,observation.workspace_id,'conversation',p.conversation_id);if(!conversation)return;await event(c,conversation,'message.media_available',{message_id:message.id,asset_id:asset.id},observation.id);
 const receiptMime=['image/png','image/jpeg','application/pdf'].includes(asset.body.mime_type);
 const awaitingReceipt=['receipt_approved','reconciled'].includes(conversation.body.flow_state?.waiting_for??'');
 const earlyPinnedOrder=conversation.body.routing_state==='RESOLVED'&&!!conversation.body.offer_version_id&&!!conversation.body.product_id;
 let earlyPaymentSignal=earlyPinnedOrder&&explicitReceiptIntent(String(message.body.text??''));
 if(earlyPinnedOrder&&!earlyPaymentSignal){
  const previous=(await c.query(
   `SELECT body->>'text' text FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='message'
    AND id<>$3 AND body->>'conversation_id'=$4 AND body->>'direction'='INBOUND'
    AND created_at>=$5::timestamptz-interval '10 minutes' AND created_at<=$5::timestamptz
    ORDER BY created_at DESC LIMIT 1`,
   [message.workspace_id,message.environment,message.id,conversation.id,message.created_at],
  )).rows[0];
  earlyPaymentSignal=explicitReceiptIntent(String(previous?.text??''));
 }
 // Outside the explicit collection state, only payment-labelled media becomes
 // a receipt candidate. Unrelated photos/PDFs remain private chat attachments
 // and are never forwarded to the receipt-vision provider automatically.
 if(receiptMime&&(awaitingReceipt||earlyPaymentSignal)){await applyCommand(c,{id:observation.id,workspace_id:observation.workspace_id,environment:observation.environment,kind:'conversation_command',resource_id:conversation.id,actor_id:'provider-ingress',payload:{type:'receipt_received',asset_id:asset.id}});}
 });return rows.length;
}

/** Message records belong to automation. The channel worker records the final
 * transport failure; this consumer applies it to the conversation once. */
export async function materializeFailedInboundMedia(limit=50){
 const rows=(await query(`SELECT e.* FROM domain_events e WHERE e.event_type='channel.media.download_failed'
  AND e.payload->>'terminal'='true'
  AND NOT EXISTS(SELECT 1 FROM consumer_receipts c WHERE c.consumer='media-sales-failure-v1' AND c.event_id=e.id)
  ORDER BY e.recorded_at LIMIT $1`,[limit])).rows;
 for(const observation of rows)await withTransaction(async c=>{
  const claimed=await c.query(`INSERT INTO consumer_receipts(consumer,event_id) VALUES('media-sales-failure-v1',$1) ON CONFLICT DO NOTHING RETURNING event_id`,[observation.id]);
  if(!claimed.rowCount)return;
  const p=observation.payload;
  const message=await getRecord(c,observation.workspace_id,'message',p.message_id);
  if(!message||message.body.media_status==='READY')return;
  await save(c,message,{...message.body,media:{...message.body.media,status:'FAILED'},media_status:'FAILED',media_failure_reason:p.reason});
  const conversation=await getRecord(c,observation.workspace_id,'conversation',p.conversation_id??message.body.conversation_id);
  if(conversation)await event(c,conversation,'message.media_unavailable',{message_id:message.id,reason:p.reason,attempts:p.attempts},observation.id);
 });
 return rows.length;
}
