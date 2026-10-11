-- Additive validation for catalog references. No historical rows are changed.
CREATE FUNCTION guard_catalog_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref text; expected text; key text;
BEGIN
 IF NEW.kind NOT IN ('product','workflow','offer') THEN RETURN NEW; END IF;
 IF NEW.kind='product' THEN
  FOR ref IN SELECT jsonb_array_elements_text(COALESCE(NEW.body->'asset_ids','[]'::jsonb)) LOOP
   IF NOT EXISTS(SELECT 1 FROM records WHERE id::text=ref AND workspace_id=NEW.workspace_id AND environment=NEW.environment AND kind='asset') THEN RAISE EXCEPTION 'INVALID_SCOPED_REFERENCE: asset_ids'; END IF;
  END LOOP;
 END IF;
 FOR key,ref IN SELECT * FROM jsonb_each_text(NEW.body) LOOP
  expected:=CASE key WHEN 'workflow_template_version_id' THEN 'workflow' WHEN 'series_id' THEN NEW.kind WHEN 'source_version_id' THEN NEW.kind WHEN 'parent_id' THEN CASE WHEN NEW.kind='workflow' THEN 'workflow' ELSE NULL END WHEN 'restored_from_version_id' THEN 'workflow' ELSE NULL END;
  IF expected IS NOT NULL AND ref IS NOT NULL AND NOT EXISTS(SELECT 1 FROM records WHERE id::text=ref AND workspace_id=NEW.workspace_id AND environment=NEW.environment AND kind=expected) THEN RAISE EXCEPTION 'INVALID_SCOPED_REFERENCE: %',key; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_reference_integrity BEFORE INSERT OR UPDATE ON records FOR EACH ROW EXECUTE FUNCTION guard_catalog_references();
