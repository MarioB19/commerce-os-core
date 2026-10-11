import {query,withTransaction,getRecord,decrypt,encrypt,appendEvent} from '@commerce/db';

/** Channel owns provider reads; automation owns ingesta. This is not a forged provider webhook. */
export async function materializeProviderHistory(limit=25){
 const rows=(await query(`SELECT e.* FROM domain_events e WHERE e.event_type='channel.history.observed'
  AND NOT EXISTS(SELECT 1 FROM consumer_receipts c WHERE c.consumer='inbound-history-v1' AND c.event_id=e.id)
  ORDER BY e.recorded_at LIMIT $1`,[limit])).rows;
 for(const source of rows)await withTransaction(async c=>{
  const claimed=await c.query("INSERT INTO consumer_receipts(consumer,event_id) VALUES('inbound-history-v1',$1) ON CONFLICT DO NOTHING RETURNING event_id",[source.id]);if(!claimed.rowCount)return;
  const a=await getRecord(c,source.workspace_id,'channel_account',source.aggregate_id);
  if(!a||a.environment!==source.environment||a.body.deleted_at||a.body.provider!=='waha'||a.body.identity_fingerprint!==source.payload.identity_fingerprint){await appendEvent(c,{workspace_id:source.workspace_id,environment:source.environment,event_type:'channel.history.rejected',aggregate_id:source.aggregate_id,causation_id:source.id,payload:{reason:'HISTORY_ACCOUNT_IDENTITY_CHANGED'}});return;}
  const messages=JSON.parse(decrypt(source.payload.messages_ciphertext));
  if(!Array.isArray(messages)||messages.length>100)throw new Error('HISTORY_CAPTURE_INVALID');
  let inserted=0;
  for(const message of messages){
   const payload={id:'history:'+message.id,event:'message',session:a.body.session??'default',payload:message};
   const result=await c.query(`INSERT INTO inbound_envelopes(workspace_id,environment,account_id,provider,provider_event_id,payload_ciphertext,metadata,occurred_at)
    VALUES($1,$2,$3,'waha',$4,$5,$6,now()) ON CONFLICT(workspace_id,account_id,provider,provider_event_id) DO NOTHING RETURNING id`,[a.workspace_id,a.environment,a.id,payload.id,encrypt(payload),{source:'provider_history',capture_event_id:source.id,provider_event_at:new Date(Number(message.timestamp)*1000).toISOString(),historical_only:true}]);inserted+=result.rowCount??0;
  }
  await appendEvent(c,{workspace_id:a.workspace_id,environment:a.environment,event_type:'channel.history.imported',aggregate_id:a.id,causation_id:source.id,payload:{inserted,captured:messages.length,truncated:source.payload.truncated,external_effects:0}});
 });
 return rows.length;
}
