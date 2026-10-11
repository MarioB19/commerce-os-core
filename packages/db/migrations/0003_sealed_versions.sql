CREATE FUNCTION enforce_sealed_versions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.kind='agent' THEN RAISE EXCEPTION 'IMMUTABLE_VERSION'; END IF;
 IF OLD.kind='asset' AND OLD.body->>'status'='READY' THEN RAISE EXCEPTION 'IMMUTABLE_ASSET'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_sealed_versions BEFORE UPDATE ON records FOR EACH ROW EXECUTE FUNCTION enforce_sealed_versions();
CREATE UNIQUE INDEX one_prepared_conversion ON records(workspace_id,environment,(body->>'order_id'),(body->>'destination'),(body->>'event_name')) WHERE kind='conversion';
CREATE OR REPLACE FUNCTION enforce_record_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE runtime text:=current_setting('role');
BEGIN
 IF runtime='none' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper) THEN
  IF pg_has_role(session_user,'commerce_api','member') THEN runtime:='commerce_api';
  ELSIF pg_has_role(session_user,'commerce_ingress','member') THEN runtime:='commerce_ingress';
  ELSIF pg_has_role(session_user,'commerce_automation','member') THEN runtime:='commerce_automation';
  ELSIF pg_has_role(session_user,'commerce_channel','member') THEN runtime:='commerce_channel'; END IF;
 END IF;
 IF runtime='commerce_api' AND NEW.kind NOT IN ('product','offer','asset','workflow','agent','bank_profile','receipt_policy','channel_account','acquisition_campaign','ad_set','ad','binding','message_campaign','import_batch','conversion','simulation') THEN RAISE EXCEPTION 'WRITE_OWNER_API'; END IF;
 IF runtime='commerce_automation' AND NEW.kind NOT IN ('contact','conversation','message','order','receipt','fulfillment','touchpoint','simulation','import_batch','message_campaign','ai_run','service_heartbeat','incident') THEN RAISE EXCEPTION 'WRITE_OWNER_AUTOMATION'; END IF;
 IF runtime='commerce_channel' AND NEW.kind NOT IN ('channel_account','health_signal','incident','service_heartbeat') THEN RAISE EXCEPTION 'WRITE_OWNER_CHANNEL'; END IF;
 RETURN NEW;
END $$;
