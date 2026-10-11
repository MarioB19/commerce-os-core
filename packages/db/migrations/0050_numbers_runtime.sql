-- Existing state references are recorded without re-enrolment or invented graduation.
UPDATE warmup_conversations v SET pool_id=s.pool_id FROM warmup_states s WHERE v.initiator_id=s.account_id AND v.pool_id IS NULL;
GRANT INSERT,UPDATE ON warmup_content_usage TO commerce_api;
GRANT UPDATE ON outbox TO commerce_automation;
-- Narrow identity observation/provisioning capabilities in the channel worker.
GRANT INSERT ON warmup_identities TO commerce_channel;
GRANT UPDATE ON warmup_identities TO commerce_channel;
ALTER TABLE number_operations DROP CONSTRAINT number_operations_action_check;
ALTER TABLE number_operations ADD CONSTRAINT number_operations_action_check CHECK(action IN('PROVISION','EXPAND','DRAIN','GROUP_REFRESH','LINK','RECOVER','IDENTITY_OBSERVE'));
CREATE TABLE number_simulation_groups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'SIMULATION' CHECK(environment='SIMULATION'),provider_id text NOT NULL,name text NOT NULL,account_ids uuid[] NOT NULL,admin_only boolean NOT NULL DEFAULT false,
 fault text NOT NULL DEFAULT 'none' CHECK(fault IN('none','delay','duplicate','out_of_order','accepted_timeout','rejected','peer_disconnected','slow_gateway')),
 UNIQUE(workspace_id,provider_id)
);
GRANT SELECT ON number_simulation_groups TO commerce_api,commerce_channel,commerce_automation;
GRANT INSERT,UPDATE ON number_simulation_groups TO commerce_api;
