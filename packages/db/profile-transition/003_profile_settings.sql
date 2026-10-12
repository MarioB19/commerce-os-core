-- Isolated staged schema, not an automatic migration or production cutover.
CREATE OR REPLACE FUNCTION guard_profile_identity() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'PROFILE_IDENTITY_IMMUTABLE'; END IF;
 IF NEW.business_name IS DISTINCT FROM OLD.business_name OR NEW.timezone IS DISTINCT FROM OLD.timezone THEN
  IF current_setting('app.workspace_id',true) IS DISTINCT FROM OLD.id THEN
   RAISE EXCEPTION 'PROFILE_SETTINGS_CONTEXT_REQUIRED';
  END IF;
  NEW.version:=OLD.version+1;
  NEW.updated_at:=clock_timestamp();
 ELSE
  NEW.version:=OLD.version;
  NEW.updated_at:=OLD.updated_at;
 END IF;
 RETURN NEW;
END $$;
GRANT UPDATE(business_name,timezone) ON profiles TO commerce_api;
