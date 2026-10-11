-- The operations monitor owns durable operational metrics. Preserve all other writer boundaries.
CREATE OR REPLACE FUNCTION enforce_record_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE runtime text:=current_setting('role');
BEGIN
 IF runtime='none' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper) THEN
  IF pg_has_role(session_user,'commerce_api','member') THEN runtime:='commerce_api';
  ELSIF pg_has_role(session_user,'commerce_ingress','member') THEN runtime:='commerce_ingress';
  ELSIF pg_has_role(session_user,'commerce_automation','member') THEN runtime:='commerce_automation';
  ELSIF pg_has_role(session_user,'commerce_channel','member') THEN runtime:='commerce_channel'; END IF;
 END IF;
 IF runtime='commerce_api' AND NEW.kind NOT IN ('category','flow_evaluation','product','offer','asset','workflow','agent','bank_profile','receipt_policy','channel_account','acquisition_campaign','ad_set','ad','binding','message_campaign','import_batch','conversion','simulation','incident') THEN RAISE EXCEPTION 'WRITE_OWNER_API'; END IF;
 IF runtime='commerce_automation' AND NEW.kind='asset' THEN
  IF TG_OP<>'INSERT' OR NEW.body->>'source' IS DISTINCT FROM 'channel_ingress' OR NEW.body->>'immutable' IS DISTINCT FROM 'true' OR NEW.body->>'status' IS DISTINCT FROM 'READY' OR NEW.body->>'kind' IS DISTINCT FROM 'file' OR NOT COALESCE(NEW.body->>'sha256' ~ '^[a-f0-9]{64}$',false) OR COALESCE(NEW.body->>'storage_key','')='' OR NOT EXISTS(SELECT 1 FROM inbound_envelopes e WHERE e.id::text=NEW.body->>'envelope_id' AND e.workspace_id=NEW.workspace_id AND e.environment=NEW.environment) OR NOT EXISTS(SELECT 1 FROM records m WHERE m.id::text=NEW.body->>'message_id' AND m.kind='message' AND m.workspace_id=NEW.workspace_id AND m.environment=NEW.environment) THEN RAISE EXCEPTION 'WRITE_OWNER_AUTOMATION_ASSET'; END IF;
 ELSIF runtime='commerce_automation' AND NEW.kind NOT IN ('contact','conversation','message','order','receipt','fulfillment','touchpoint','simulation','import_batch','message_campaign','ai_run','service_heartbeat','incident','operational_metric') THEN RAISE EXCEPTION 'WRITE_OWNER_AUTOMATION'; END IF;
 IF runtime='commerce_channel' AND NEW.kind NOT IN ('channel_account','health_signal','incident','service_heartbeat') THEN RAISE EXCEPTION 'WRITE_OWNER_CHANNEL'; END IF;
 RETURN NEW;
END $$;
