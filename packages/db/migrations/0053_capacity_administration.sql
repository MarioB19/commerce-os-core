GRANT INSERT ON number_capacity_observations TO commerce_api;
-- Reserve explicitly configured legacy gateways without claiming physical readback.
INSERT INTO number_capacity_slots(workspace_id,environment,host_ref,slot,state,account_id,gateway_ref,readback)
 SELECT r.workspace_id,r.environment,'primary',substring(i.config->>'base_url' from 'waha-([0-9]{2}):')::integer,'RESERVED',r.id,r.body->>'gateway_ref',jsonb_build_object('verified',false,'source','existing_integration_metadata')
 FROM records r JOIN integration_settings i ON i.workspace_id=r.workspace_id AND i.environment=r.environment AND i.key='waha:'||COALESCE(r.body->>'gateway_ref','WAHA')
 WHERE r.kind='channel_account' AND NOT r.body?'deleted_at' AND r.body->>'provider'='waha' AND i.config->>'base_url' ~ '^http://waha-(0[1-9]|1[0-9]|20):3000$'
 ON CONFLICT DO NOTHING;
ALTER TABLE channel_sessions ADD COLUMN health_probe_until timestamptz;
ALTER TABLE channel_sessions ADD COLUMN health_probe_owner text;
