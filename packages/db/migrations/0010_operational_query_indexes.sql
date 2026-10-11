-- Measured query paths: JSONB containment GIN does not accelerate ->> equality.
CREATE INDEX IF NOT EXISTS records_message_effect_lookup ON records(workspace_id,(body->>'effect_id')) WHERE kind='message';
CREATE INDEX IF NOT EXISTS records_id_text_lookup ON records(workspace_id,(id::text));
CREATE INDEX IF NOT EXISTS records_message_provider_dedupe ON records(workspace_id,environment,(body->>'account_id'),(body->>'provider_event_key')) WHERE kind='message';
CREATE INDEX IF NOT EXISTS records_contact_identity_lookup ON records(workspace_id,environment,(body->>'identity')) WHERE kind='contact';
CREATE INDEX IF NOT EXISTS records_contact_alias_lookup ON records USING gin((body->'identity_aliases')) WHERE kind='contact';
CREATE INDEX IF NOT EXISTS records_conversation_contact_account ON records(workspace_id,environment,(body->>'account_id'),(body->>'contact_id')) WHERE kind='conversation';
CREATE INDEX IF NOT EXISTS records_order_conversation ON records(workspace_id,(body->>'conversation_id')) WHERE kind='order';
CREATE INDEX IF NOT EXISTS records_fulfillment_order_asset ON records(workspace_id,(body->>'order_id'),(body->>'asset_id'),(body->>'release_on')) WHERE kind='fulfillment';
CREATE INDEX IF NOT EXISTS records_conversation_assignee ON records(workspace_id,environment,(body->>'assigned_to')) WHERE kind='conversation';
CREATE INDEX IF NOT EXISTS records_binding_account_time ON records(workspace_id,environment,(body->>'account_id'),(body->>'valid_from')) WHERE kind='binding';
CREATE INDEX IF NOT EXISTS records_ai_pending ON records(updated_at) WHERE kind='conversation' AND body->>'ai_pending'='true';
CREATE INDEX IF NOT EXISTS records_receipt_analysis_pending ON records(created_at) WHERE kind='receipt' AND body->>'analysis_status'='PENDING';
CREATE INDEX IF NOT EXISTS domain_events_consumer_type_time ON domain_events(event_type,recorded_at,id);
CREATE INDEX IF NOT EXISTS outbox_provider_message_lookup ON outbox(workspace_id,account_id,provider_message_id);
CREATE INDEX IF NOT EXISTS outbox_execution_results ON outbox(updated_at) WHERE status IN('SENT','DELIVERED','READ','FAILED','UNKNOWN');
CREATE INDEX IF NOT EXISTS outbox_fair_dispatch ON outbox(account_id,created_at,not_before) WHERE status IN('READY','BLOCKED');
CREATE INDEX IF NOT EXISTS outbox_conversation_status ON outbox(workspace_id,conversation_id,status);
CREATE INDEX IF NOT EXISTS outbox_authorization_quota ON outbox(authorization_id,status) WHERE authorization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS outbox_contact_frequency ON outbox(workspace_id,contact_id,claimed_at) WHERE status IN('SENDING','SENT','DELIVERED','READ','UNKNOWN');
-- consumer_receipts primary key (consumer,event_id) already covers anti-joins.
