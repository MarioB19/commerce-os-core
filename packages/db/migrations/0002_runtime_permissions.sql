-- Database ownership boundaries. Runtime login roles inherit exactly one profile.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_api') THEN CREATE ROLE commerce_api NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_ingress') THEN CREATE ROLE commerce_ingress NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_automation') THEN CREATE ROLE commerce_automation NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_channel') THEN CREATE ROLE commerce_channel NOLOGIN; END IF; END $$;
GRANT USAGE ON SCHEMA public TO commerce_api,commerce_ingress,commerce_automation,commerce_channel;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO commerce_api,commerce_automation,commerce_channel;
GRANT SELECT ON records,manual_controls,inbound_envelopes TO commerce_ingress;
REVOKE ALL ON "user",session,account,verification,memberships,service_tokens FROM commerce_ingress,commerce_automation,commerce_channel;
GRANT SELECT,INSERT,UPDATE,DELETE ON "user",session,account,verification,memberships,service_tokens TO commerce_api;
GRANT INSERT,UPDATE ON records TO commerce_api,commerce_automation,commerce_channel;
GRANT INSERT ON inbound_envelopes TO commerce_ingress,commerce_automation;
GRANT UPDATE(status,error,processed_at) ON inbound_envelopes TO commerce_automation;
GRANT INSERT ON commands,idempotency,manual_controls,operation_authorizations,domain_events TO commerce_api;
GRANT UPDATE ON manual_controls,operation_authorizations,idempotency TO commerce_api;
GRANT UPDATE(approval_hash,authorization_id,status,updated_at) ON outbox TO commerce_api;
GRANT INSERT,UPDATE ON timers TO commerce_automation;
GRANT INSERT ON outbox,domain_events TO commerce_automation;
GRANT UPDATE(status,result,updated_at) ON commands TO commerce_automation,commerce_channel;
GRANT UPDATE ON outbox,session_ownership TO commerce_channel;
GRANT INSERT ON session_ownership,effect_attempts,domain_events TO commerce_channel;
GRANT UPDATE ON effect_attempts TO commerce_channel;
GRANT UPDATE(status,result,updated_at) ON outbox TO commerce_automation;
GRANT INSERT,UPDATE ON manual_controls TO commerce_automation,commerce_channel;
ALTER FUNCTION snapshot_record() SECURITY DEFINER;
ALTER FUNCTION snapshot_record() SET search_path=pg_catalog,public;
CREATE FUNCTION enforce_record_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE runtime text:=current_setting('role');
BEGIN
 IF runtime='commerce_api' AND NEW.kind NOT IN ('product','offer','asset','workflow','agent','bank_profile','receipt_policy','channel_account','acquisition_campaign','ad_set','ad','binding','message_campaign','import_batch','conversion','simulation') THEN RAISE EXCEPTION 'WRITE_OWNER_API'; END IF;
 IF runtime='commerce_automation' AND NEW.kind NOT IN ('contact','conversation','message','order','receipt','fulfillment','touchpoint','simulation','import_batch','message_campaign','ai_run','service_heartbeat','incident') THEN RAISE EXCEPTION 'WRITE_OWNER_AUTOMATION'; END IF;
 IF runtime='commerce_channel' AND NEW.kind NOT IN ('channel_account','health_signal','incident','service_heartbeat') THEN RAISE EXCEPTION 'WRITE_OWNER_CHANNEL'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER enforce_record_writer BEFORE INSERT OR UPDATE ON records FOR EACH ROW EXECUTE FUNCTION enforce_record_writer();
CREATE FUNCTION enforce_agent_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.kind='agent' AND OLD.body->>'status'='PUBLISHED' THEN RAISE EXCEPTION 'IMMUTABLE_VERSION'; END IF; RETURN NEW; END $$;
CREATE TRIGGER immutable_published_agent BEFORE UPDATE ON records FOR EACH ROW EXECUTE FUNCTION enforce_agent_version();
CREATE FUNCTION guard_envelope_original() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id<>OLD.workspace_id OR NEW.environment<>OLD.environment OR NEW.account_id<>OLD.account_id OR NEW.provider<>OLD.provider OR NEW.provider_event_id<>OLD.provider_event_id OR NEW.payload_ciphertext<>OLD.payload_ciphertext OR NEW.metadata<>OLD.metadata OR NEW.occurred_at<>OLD.occurred_at OR NEW.received_at<>OLD.received_at THEN RAISE EXCEPTION 'IMMUTABLE_ENVELOPE'; END IF; RETURN NEW; END $$;
CREATE TRIGGER immutable_envelope BEFORE UPDATE ON inbound_envelopes FOR EACH ROW EXECUTE FUNCTION guard_envelope_original();
