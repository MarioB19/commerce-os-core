-- Preserve immutable commercial payloads; only lifecycle metadata can change.
-- Each metadata mutation still increments the record revision and snapshots history.
CREATE FUNCTION catalog_archive_only(old_body jsonb,new_body jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT old_body - ARRAY['archived_at','archive_reason'] = new_body - ARRAY['archived_at','archive_reason']
$$;
CREATE FUNCTION catalog_agent_publish_only(old_body jsonb,new_body jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(old_body->>'status','DRAFT')='DRAFT' AND new_body->>'status'='PUBLISHED'
 AND old_body - ARRAY['status','published_at','published_by'] = new_body - ARRAY['status','published_at','published_by']
$$;
CREATE OR REPLACE FUNCTION enforce_agent_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.kind='agent' AND OLD.body->>'status'='PUBLISHED' AND NOT catalog_archive_only(OLD.body,NEW.body) THEN RAISE EXCEPTION 'IMMUTABLE_VERSION'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION enforce_sealed_versions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.kind='agent' AND NOT (catalog_archive_only(OLD.body,NEW.body) OR catalog_agent_publish_only(OLD.body,NEW.body)) THEN RAISE EXCEPTION 'IMMUTABLE_VERSION'; END IF;
 IF OLD.kind='asset' AND OLD.body->>'status'='READY' AND NOT (catalog_archive_only(OLD.body,NEW.body) OR (retention_context_valid() AND NEW.body->>'status'='RETAINED')) THEN RAISE EXCEPTION 'IMMUTABLE_ASSET'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE key text; target text; expected text; ref jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (OLD.kind IN ('offer','bank_profile','receipt_policy') OR (OLD.kind='workflow' AND OLD.body->>'status'='PUBLISHED')) AND NOT (OLD.kind IN ('offer','workflow') AND catalog_archive_only(OLD.body,NEW.body)) THEN RAISE EXCEPTION 'IMMUTABLE_VERSION'; END IF;
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.environment<>OLD.environment OR NEW.kind<>OLD.kind OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
 END IF;
 FOR key,target IN SELECT * FROM jsonb_each_text(NEW.body) LOOP
 expected:=CASE key WHEN 'product_id' THEN 'product' WHEN 'offer_version_id' THEN 'offer' WHEN 'workflow_version_id' THEN 'workflow' WHEN 'agent_version_id' THEN 'agent' WHEN 'payment_profile_version_id' THEN 'bank_profile' WHEN 'receipt_policy_version_id' THEN 'receipt_policy' WHEN 'campaign_id' THEN 'acquisition_campaign' WHEN 'ad_set_id' THEN 'ad_set' WHEN 'ad_id' THEN 'ad' WHEN 'account_id' THEN 'channel_account' WHEN 'contact_id' THEN 'contact' WHEN 'conversation_id' THEN 'conversation' WHEN 'order_id' THEN 'order' WHEN 'asset_id' THEN 'asset' ELSE NULL END;
 IF expected IS NOT NULL AND target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM records r WHERE r.id::text=target AND r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment AND r.kind=expected) THEN RAISE EXCEPTION 'INVALID_SCOPED_REFERENCE: %',key; END IF;
 END LOOP;
 IF NEW.body ? 'fulfillment' THEN FOR ref IN SELECT * FROM jsonb_array_elements(NEW.body->'fulfillment') LOOP IF NOT EXISTS(SELECT 1 FROM records r WHERE r.id::text=ref->>'asset_id' AND r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment AND r.kind='asset') THEN RAISE EXCEPTION 'INVALID_ASSET_REFERENCE'; END IF; END LOOP; END IF;
 RETURN NEW;
END $$;
