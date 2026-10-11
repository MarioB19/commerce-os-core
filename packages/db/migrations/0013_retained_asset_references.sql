-- Serialize new references with retention's FOR UPDATE asset lock. Historic references still prevent planning.
CREATE FUNCTION guard_retained_asset_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref text; asset_state text;
BEGIN
 FOR ref IN SELECT DISTINCT value #>> '{}' FROM (
  SELECT jsonb_path_query(NEW.body,'$.**.asset_id') value
  UNION ALL SELECT jsonb_path_query(NEW.body,'$.**.evidence_asset_id') value
 ) references_found WHERE jsonb_typeof(value)='string' LOOP
  SELECT r.body->>'status' INTO asset_state FROM records r WHERE r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment AND r.kind='asset' AND r.id::text=ref FOR SHARE;
  IF asset_state='RETAINED' THEN RAISE EXCEPTION 'INVALID_RETAINED_ASSET_REFERENCE'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_retained_asset_references BEFORE INSERT OR UPDATE ON records FOR EACH ROW EXECUTE FUNCTION guard_retained_asset_references();
