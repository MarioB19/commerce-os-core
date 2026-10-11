-- Additive. Existing episodes, policies and authorizations retain their scope.
ALTER TABLE warmup_pools DROP CONSTRAINT warmup_pools_workspace_id_environment_key;
ALTER TABLE warmup_pools ADD COLUMN topology text NOT NULL DEFAULT 'direct' CHECK(topology IN('direct','group'));
ALTER TABLE warmup_pools ADD COLUMN purpose text NOT NULL DEFAULT 'preparation' CHECK(purpose IN('preparation','maintenance'));
ALTER TABLE warmup_pools ADD COLUMN archived_at timestamptz;
ALTER TABLE warmup_pools ADD COLUMN program_id uuid;
CREATE TABLE warmup_groups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 provider text NOT NULL,group_fingerprint text NOT NULL,group_ciphertext text NOT NULL,name text NOT NULL,version integer NOT NULL DEFAULT 1,
 members jsonb NOT NULL DEFAULT '[]',permissions jsonb NOT NULL DEFAULT '{}',capabilities jsonb NOT NULL DEFAULT '{}',
 observed_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,source text NOT NULL,retired_at timestamptz,
 UNIQUE(workspace_id,environment,provider,group_fingerprint),UNIQUE(id,workspace_id,environment)
);
ALTER TABLE warmup_pools ADD COLUMN group_id uuid REFERENCES warmup_groups(id);
CREATE UNIQUE INDEX warmup_active_group ON warmup_pools(group_id) WHERE enabled AND archived_at IS NULL;
CREATE TABLE warmup_programs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 actor_id text NOT NULL,version integer NOT NULL DEFAULT 1,name text NOT NULL,topology text NOT NULL CHECK(topology IN('direct','group')),
 purpose text NOT NULL DEFAULT 'preparation' CHECK(purpose IN('preparation','maintenance')),group_id uuid,
 profile_id uuid NOT NULL,account_ids uuid[] NOT NULL,content_ids uuid[] NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','REVIEWED','AUTHORIZED','ACTIVE','PAUSED','COMPLETED','ARCHIVED')),
 scope jsonb NOT NULL DEFAULT '{}',review_hash text,review_dependencies jsonb,authorization_id uuid REFERENCES operation_authorizations(id),pool_id uuid REFERENCES warmup_pools(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(group_id,workspace_id,environment) REFERENCES warmup_groups(id,workspace_id,environment),
 FOREIGN KEY(profile_id,workspace_id,environment) REFERENCES warmup_profiles(id,workspace_id,environment),UNIQUE(id,workspace_id,environment)
);
ALTER TABLE warmup_pools ADD CONSTRAINT warmup_pool_program FOREIGN KEY(program_id) REFERENCES warmup_programs(id);
CREATE TABLE warmup_episodes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES records(id),workspace_id text NOT NULL,environment text NOT NULL,
 version integer NOT NULL DEFAULT 1,policy_version text NOT NULL,identity_fingerprint text NOT NULL,timezone text NOT NULL,
 started_at timestamptz NOT NULL,completed_at timestamptz,closed_at timestamptz,previous_episode_id uuid REFERENCES warmup_episodes(id),historical_evidence jsonb NOT NULL DEFAULT '{}',created_by text NOT NULL,
 UNIQUE(id,workspace_id,environment)
);
CREATE UNIQUE INDEX warmup_current_episode ON warmup_episodes(account_id) WHERE closed_at IS NULL;
CREATE TABLE warmup_manual_declarations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),episode_id uuid NOT NULL REFERENCES warmup_episodes(id),task text NOT NULL CHECK(task IN('authentic_profile','responsible_device','consented_contacts','human_conversations')),
 status text NOT NULL CHECK(status IN('COMPLETED','PENDING','UNVERIFIABLE')),actor text NOT NULL,source text NOT NULL CHECK(source='operator_declaration'),
 recorded_at timestamptz NOT NULL,local_date date NOT NULL,note text NOT NULL DEFAULT '',supersedes_id uuid REFERENCES warmup_manual_declarations(id)
);
CREATE TRIGGER immutable_manual_declarations BEFORE UPDATE OR DELETE ON warmup_manual_declarations FOR EACH ROW EXECUTE FUNCTION immutable_row();
ALTER TABLE warmup_states ADD COLUMN episode_id uuid REFERENCES warmup_episodes(id);
CREATE TABLE warmup_account_reservations (
 account_id uuid PRIMARY KEY REFERENCES records(id),program_id uuid NOT NULL REFERENCES warmup_programs(id),created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE warmup_conversations ADD COLUMN pool_id uuid REFERENCES warmup_pools(id);
ALTER TABLE warmup_conversations ADD COLUMN group_id uuid REFERENCES warmup_groups(id);
ALTER TABLE warmup_conversations ADD COLUMN membership_version integer;
ALTER TABLE warmup_conversations ADD COLUMN member_ids uuid[];
ALTER TABLE warmup_turns ADD COLUMN recipient_ids uuid[];
CREATE TABLE warmup_group_receipts (
 effect_id uuid NOT NULL REFERENCES outbox(id),receiver_id uuid NOT NULL REFERENCES records(id),sender_id uuid NOT NULL REFERENCES records(id),group_id uuid NOT NULL REFERENCES warmup_groups(id),membership_version integer NOT NULL,
 provider_message_id text NOT NULL,delivery_source text NOT NULL CHECK(delivery_source IN('authenticated_receive','participant_ack')),
 envelope_id text NOT NULL,observed_at timestamptz NOT NULL,PRIMARY KEY(effect_id,receiver_id,delivery_source)
);
CREATE TABLE warmup_group_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,environment text NOT NULL,account_id uuid NOT NULL REFERENCES records(id),group_fingerprint text NOT NULL,canonical_key text NOT NULL,
 envelope_id text NOT NULL,classification text NOT NULL,observed_at timestamptz NOT NULL,UNIQUE(account_id,canonical_key)
);
ALTER TABLE warmup_content_usage DROP CONSTRAINT warmup_content_usage_pkey;
ALTER TABLE warmup_content_usage ADD COLUMN reserved_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE warmup_content_usage ADD COLUMN consumed_at timestamptz;
ALTER TABLE warmup_content_usage ADD COLUMN released_at timestamptz;
ALTER TABLE warmup_content_usage ADD PRIMARY KEY(workspace_id,environment,account_id,content_hash,conversation_id);
CREATE TABLE warmup_library_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,environment text NOT NULL,version integer NOT NULL DEFAULT 1,
 body jsonb NOT NULL,approved_content_id uuid REFERENCES warmup_content(id),created_by text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE number_capacity_slots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,environment text NOT NULL,host_ref text NOT NULL DEFAULT 'primary',slot integer NOT NULL CHECK(slot BETWEEN 1 AND 20),
 version integer NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'AVAILABLE' CHECK(state IN('AVAILABLE','RESERVED','PREPARING','PREPARED','QR_PENDING','CONNECTED','DRAINING','ERROR','UNKNOWN')),
 account_id uuid REFERENCES records(id),operation_id uuid,gateway_ref text,readback jsonb NOT NULL DEFAULT '{}',updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,environment,host_ref,slot),UNIQUE(account_id)
);
CREATE TABLE number_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,environment text NOT NULL,actor_id text NOT NULL,version integer NOT NULL DEFAULT 1,
 action text NOT NULL CHECK(action IN('PROVISION','EXPAND','DRAIN','GROUP_REFRESH','LINK','RECOVER')),
 state text NOT NULL DEFAULT 'REQUESTED' CHECK(state IN('REQUESTED','RESERVED','PREPARING','SUCCEEDED','HUMAN_ACTION_REQUIRED','FAILED','UNKNOWN','CANCELLED')),
 input jsonb NOT NULL,result jsonb NOT NULL DEFAULT '{}',lease_owner text,lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE number_capacity_slots ADD CONSTRAINT capacity_operation FOREIGN KEY(operation_id) REFERENCES number_operations(id);
CREATE TABLE number_capacity_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,environment text NOT NULL,host_ref text NOT NULL,observed_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,source text NOT NULL,metrics jsonb NOT NULL
);
-- A pre-group coordinator must never send a direct message for a group pool.
CREATE FUNCTION guard_group_effect_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='warmup' AND EXISTS(SELECT 1 FROM warmup_pools p WHERE p.id::text=NEW.payload->>'warmup_pool_id' AND p.topology='group') AND NEW.payload->>'group_protocol' IS DISTINCT FROM 'v1' THEN RAISE EXCEPTION 'GROUP_WORKER_VERSION_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_group_effect_version BEFORE INSERT OR UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION guard_group_effect_version();
-- Retain the legacy guard for direct effects; group effects require the exact persisted turn and snapshot.
CREATE OR REPLACE FUNCTION guard_warmup_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND NEW.kind IS DISTINCT FROM OLD.kind THEN RAISE EXCEPTION 'EFFECT_KIND_IMMUTABLE'; END IF;
 IF NEW.kind='warmup' AND NOT EXISTS(
 SELECT 1 FROM warmup_turns t JOIN warmup_conversations v ON v.id=t.conversation_id JOIN warmup_states a ON a.account_id=t.sender_id JOIN warmup_states b ON b.account_id=t.recipient_id
 WHERE t.id::text=NEW.payload->>'warmup_turn_id' AND t.workspace_id=NEW.workspace_id AND t.environment=NEW.environment AND t.sender_id::text=NEW.account_id AND t.recipient_id::text=NEW.contact_id AND t.conversation_id::text=NEW.conversation_id AND a.pool_id=b.pool_id
 AND ((v.group_id IS NULL AND ((t.sender_id=v.initiator_id AND t.recipient_id=v.peer_id) OR(t.sender_id=v.peer_id AND t.recipient_id=v.initiator_id)))
 OR(v.group_id IS NOT NULL AND NEW.payload->>'group_protocol'='v1' AND v.pool_id=a.pool_id AND t.sender_id=ANY(v.member_ids) AND t.recipient_ids @> ARRAY[t.recipient_id] AND NOT t.sender_id=ANY(t.recipient_ids)))) THEN RAISE EXCEPTION 'WARMUP_EFFECT_SCOPE_INVALID'; END IF;
 RETURN NEW; END $$;
GRANT SELECT ON warmup_groups,warmup_programs,warmup_episodes,warmup_manual_declarations,warmup_account_reservations,warmup_group_receipts,warmup_group_events,warmup_library_drafts,number_capacity_slots,number_operations,number_capacity_observations TO commerce_api,commerce_automation,commerce_channel,commerce_maintenance;
GRANT INSERT,UPDATE ON warmup_programs,warmup_episodes,warmup_library_drafts,number_capacity_slots,number_operations TO commerce_api;
GRANT INSERT ON warmup_manual_declarations,warmup_account_reservations TO commerce_api;
GRANT DELETE ON warmup_account_reservations TO commerce_api;
GRANT INSERT,UPDATE ON warmup_groups,number_operations,number_capacity_slots TO commerce_channel;
GRANT INSERT ON number_capacity_observations,warmup_group_receipts,warmup_group_events TO commerce_channel,commerce_automation;
GRANT UPDATE ON warmup_programs,warmup_episodes,warmup_groups TO commerce_automation;
GRANT UPDATE ON warmup_content_usage TO commerce_channel,commerce_automation;
GRANT UPDATE ON warmup_pools,warmup_groups TO commerce_channel;
ALTER TABLE warmup_group_events ADD COLUMN event_ciphertext text;
ALTER TABLE warmup_group_events ADD COLUMN correlated boolean NOT NULL DEFAULT false;
GRANT UPDATE ON warmup_group_events TO commerce_automation,commerce_channel;
ALTER TABLE channel_sessions ADD COLUMN observed_identity_ciphertext text;
GRANT UPDATE(observed_identity_ciphertext) ON channel_sessions TO commerce_channel;
