CREATE OR REPLACE FUNCTION enforce_record_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE runtime text:=current_setting('role');
BEGIN
 IF runtime='none' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper) THEN
  IF pg_has_role(session_user,'commerce_api','member') THEN runtime:='commerce_api';
  ELSIF pg_has_role(session_user,'commerce_ingress','member') THEN runtime:='commerce_ingress';
  ELSIF pg_has_role(session_user,'commerce_automation','member') THEN runtime:='commerce_automation';
  ELSIF pg_has_role(session_user,'commerce_channel','member') THEN runtime:='commerce_channel'; END IF;
 END IF;
 IF runtime='commerce_api' AND NEW.kind NOT IN ('category','flow_evaluation','product','offer','asset','workflow','agent','bank_profile','receipt_policy','channel_account','acquisition_campaign','ad_set','ad','binding','message_campaign','import_batch','conversion','simulation') THEN RAISE EXCEPTION 'WRITE_OWNER_API'; END IF;
 IF runtime='commerce_automation' AND NEW.kind='asset' THEN
  IF TG_OP<>'INSERT' OR NEW.body->>'source' IS DISTINCT FROM 'channel_ingress' OR NEW.body->>'immutable' IS DISTINCT FROM 'true' OR NEW.body->>'status' IS DISTINCT FROM 'READY' OR NEW.body->>'kind' IS DISTINCT FROM 'file' OR NOT COALESCE(NEW.body->>'sha256' ~ '^[a-f0-9]{64}$',false) OR COALESCE(NEW.body->>'storage_key','')='' OR NOT EXISTS(SELECT 1 FROM inbound_envelopes e WHERE e.id::text=NEW.body->>'envelope_id' AND e.workspace_id=NEW.workspace_id AND e.environment=NEW.environment) OR NOT EXISTS(SELECT 1 FROM records m WHERE m.id::text=NEW.body->>'message_id' AND m.kind='message' AND m.workspace_id=NEW.workspace_id AND m.environment=NEW.environment) THEN RAISE EXCEPTION 'WRITE_OWNER_AUTOMATION_ASSET'; END IF;
 ELSIF runtime='commerce_automation' AND NEW.kind NOT IN ('contact','conversation','message','order','receipt','fulfillment','touchpoint','simulation','import_batch','message_campaign','ai_run','service_heartbeat','incident') THEN RAISE EXCEPTION 'WRITE_OWNER_AUTOMATION'; END IF;
 IF runtime='commerce_channel' AND NEW.kind NOT IN ('channel_account','health_signal','incident','service_heartbeat') THEN RAISE EXCEPTION 'WRITE_OWNER_CHANNEL'; END IF;
 RETURN NEW;
END $$;
-- Optional category and agent revision references stay inside workspace/environment.
CREATE FUNCTION guard_seller_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref text; expected text; key text;
BEGIN
 IF NEW.kind IN ('product','agent') THEN
  FOR key,ref IN SELECT * FROM jsonb_each_text(NEW.body) LOOP
   expected:=CASE key WHEN 'category_id' THEN 'category' WHEN 'series_id' THEN CASE WHEN NEW.kind='agent' THEN 'agent' END WHEN 'source_version_id' THEN CASE WHEN NEW.kind='agent' THEN 'agent' END END;
   IF expected IS NOT NULL AND ref IS NOT NULL AND NOT EXISTS(SELECT 1 FROM records WHERE id::text=ref AND workspace_id=NEW.workspace_id AND environment=NEW.environment AND kind=expected) THEN RAISE EXCEPTION 'INVALID_SCOPED_REFERENCE: %',key; END IF;
  END LOOP;
 END IF;
 IF TG_OP='UPDATE' AND NEW.kind='flow_evaluation' AND (NEW.body->'snapshot' IS DISTINCT FROM OLD.body->'snapshot') THEN RAISE EXCEPTION 'IMMUTABLE_EVALUATION_SNAPSHOT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER seller_reference_integrity BEFORE INSERT OR UPDATE ON records FOR EACH ROW EXECUTE FUNCTION guard_seller_references();
CREATE UNIQUE INDEX agent_revision_child ON records(workspace_id,environment,(body->>'source_version_id')) WHERE kind='agent' AND body ? 'source_version_id';
