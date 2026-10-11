-- Additive session control. Ownership remains in session_ownership.
CREATE TABLE channel_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL UNIQUE REFERENCES records(id),
 workspace_id text NOT NULL, environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 provider text NOT NULL, gateway_id text NOT NULL, remote_session_name text NOT NULL,
 expected_identity_fingerprint text, storage_ref text,
 credential_generation integer NOT NULL DEFAULT 1 CHECK(credential_generation>0),
 backup_ref text, backup_verified_at timestamptz, backup_status text NOT NULL DEFAULT 'UNKNOWN',
 desired_state text NOT NULL DEFAULT 'STOPPED' CHECK(desired_state IN('STOPPED','RUNNING')),
 observed_state text NOT NULL DEFAULT 'UNKNOWN' CHECK(observed_state IN('STOPPED','STARTING','CONNECTED','RECONNECTING','QR_REQUIRED','AUTH_FAILURE','UNKNOWN')),
 auth_state text NOT NULL DEFAULT 'UNKNOWN' CHECK(auth_state IN('UNKNOWN','VERIFIED','QR_REQUIRED','PASSKEY_REQUIRED','REVOKED','IDENTITY_CONFLICT')),
 raw_state text NOT NULL DEFAULT 'UNKNOWN', operational_pause boolean NOT NULL DEFAULT true,
 recovery_enabled boolean NOT NULL DEFAULT false, last_connected_at timestamptz, stable_since timestamptz,
 last_health_at timestamptz, provider_observed_at timestamptz, health_expires_at timestamptz,
 disconnected_at timestamptz, disconnect_reason text, reason_source text,
 retry_count integer NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 5), retry_window_started_at timestamptz,
 next_retry_at timestamptz, last_attempt_id uuid, recovery_blocker text,
 primary_device_id text, responsible_user_id text, primary_last_used_at timestamptz,
 primary_usage_source text, primary_usage_recorded_by text, primary_usage_revision integer NOT NULL DEFAULT 0,
 inventory jsonb NOT NULL DEFAULT '{}', recovery_stage text NOT NULL DEFAULT 'NONE',
 revision integer NOT NULL DEFAULT 1, archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX channel_sessions_gateway_exclusive ON channel_sessions(gateway_id) WHERE environment='REAL' AND provider='waha' AND gateway_id NOT LIKE 'unconfigured:%' AND archived_at IS NULL;
CREATE INDEX channel_sessions_health_queue ON channel_sessions(last_health_at NULLS FIRST) WHERE archived_at IS NULL;
CREATE TABLE channel_session_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL REFERENCES channel_sessions(id),
 workspace_id text NOT NULL, environment text NOT NULL, account_id uuid NOT NULL,
 kind text NOT NULL, actor_id text NOT NULL, source text NOT NULL, evidence jsonb NOT NULL DEFAULT '{}',
 observed_at timestamptz NOT NULL DEFAULT now(), recorded_at timestamptz NOT NULL DEFAULT now(), revision integer NOT NULL
);
CREATE INDEX channel_session_event_history ON channel_session_events(account_id,recorded_at DESC);
ALTER TABLE operational_alerts ADD COLUMN account_id uuid REFERENCES records(id), ADD COLUMN episode text,
 ADD COLUMN evidence jsonb NOT NULL DEFAULT '{}', ADD COLUMN resolved_at timestamptz,
 ADD COLUMN acknowledged_at timestamptz, ADD COLUMN acknowledged_by text;
CREATE UNIQUE INDEX session_alert_active ON operational_alerts(workspace_id,environment,account_id,kind) WHERE account_id IS NOT NULL AND resolved_at IS NULL;
CREATE FUNCTION channel_gateway_key(w text,e text,ref text) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT regexp_replace(regexp_replace(lower(config->>'base_url'),'/+$',''),':80$','') FROM integration_settings WHERE workspace_id=w AND environment=e AND key='waha:'||ref),'unconfigured:'||ref)
$$;
CREATE FUNCTION sync_channel_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected text;
BEGIN
 IF NEW.kind<>'channel_account' THEN RETURN NEW; END IF;
 IF NEW.workspace_id<>OLD.workspace_id OR NEW.environment<>OLD.environment THEN RAISE EXCEPTION 'CHANNEL_SESSION_SCOPE_IMMUTABLE'; END IF;
 SELECT expected_identity_fingerprint INTO expected FROM channel_sessions WHERE account_id=NEW.id;
 IF expected IS NOT NULL THEN
   -- Never clear or substitute identity through generic account/lifecycle updates.
   IF NEW.body->>'identity_fingerprint' IS NULL THEN
     NEW.body=NEW.body||jsonb_build_object('identity_fingerprint',expected,'identity_verified',false,'sending_enabled',false);
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_channel_identity BEFORE UPDATE ON records FOR EACH ROW EXECUTE FUNCTION sync_channel_session();
CREATE FUNCTION upsert_channel_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind<>'channel_account' THEN RETURN NEW; END IF;
 INSERT INTO channel_sessions(account_id,workspace_id,environment,provider,gateway_id,remote_session_name,expected_identity_fingerprint,archived_at)
 VALUES(NEW.id,NEW.workspace_id,NEW.environment,COALESCE(NEW.body->>'provider','unknown'),CASE WHEN NEW.body->>'provider'='waha' THEN channel_gateway_key(NEW.workspace_id,NEW.environment,COALESCE(NEW.body->>'gateway_ref','WAHA')) ELSE NEW.id::text END,COALESCE(NEW.body->>'session','default'),NEW.body->>'identity_fingerprint',(NEW.body->>'deleted_at')::timestamptz)
 ON CONFLICT(account_id) DO UPDATE SET gateway_id=EXCLUDED.gateway_id,remote_session_name=EXCLUDED.remote_session_name,archived_at=EXCLUDED.archived_at,
 expected_identity_fingerprint=COALESCE(channel_sessions.expected_identity_fingerprint,EXCLUDED.expected_identity_fingerprint);
 RETURN NEW;
END $$;
CREATE TRIGGER populate_channel_session AFTER INSERT OR UPDATE ON records FOR EACH ROW EXECUTE FUNCTION upsert_channel_session();
INSERT INTO channel_sessions(account_id,workspace_id,environment,provider,gateway_id,remote_session_name,expected_identity_fingerprint,archived_at)
 SELECT id,workspace_id,environment,COALESCE(body->>'provider','unknown'),CASE WHEN body->>'provider'='waha' THEN channel_gateway_key(workspace_id,environment,COALESCE(body->>'gateway_ref','WAHA')) ELSE id::text END,COALESCE(body->>'session','default'),body->>'identity_fingerprint',(body->>'deleted_at')::timestamptz FROM records WHERE kind='channel_account';
CREATE FUNCTION reserve_changed_gateway() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.key LIKE 'waha:%' THEN UPDATE channel_sessions s SET gateway_id=channel_gateway_key(NEW.workspace_id,NEW.environment,substring(NEW.key from 6)) FROM records r WHERE s.account_id=r.id AND r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment AND r.body->>'provider'='waha' AND COALESCE(r.body->>'gateway_ref','WAHA')=substring(NEW.key from 6); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reserve_integration_gateway AFTER INSERT OR UPDATE ON integration_settings FOR EACH ROW EXECUTE FUNCTION reserve_changed_gateway();
GRANT SELECT,INSERT,UPDATE ON channel_sessions TO commerce_api,commerce_channel,commerce_automation;
GRANT SELECT,INSERT ON channel_session_events TO commerce_api,commerce_channel,commerce_automation;

-- Enforce tenancy even for role-scoped SQL writers, not only HTTP routes.
CREATE FUNCTION validate_channel_session_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM records WHERE id=NEW.account_id AND workspace_id=NEW.workspace_id AND environment=NEW.environment AND kind='channel_account') THEN RAISE EXCEPTION 'CHANNEL_SESSION_SCOPE_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER channel_session_scope BEFORE INSERT OR UPDATE ON channel_sessions FOR EACH ROW EXECUTE FUNCTION validate_channel_session_scope();
ALTER TABLE channel_sessions ADD UNIQUE(id,account_id,workspace_id,environment);
ALTER TABLE channel_session_events ADD FOREIGN KEY(session_id,account_id,workspace_id,environment) REFERENCES channel_sessions(id,account_id,workspace_id,environment);
