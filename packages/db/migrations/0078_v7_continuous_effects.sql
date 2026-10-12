-- V7 F2 cutover: Continuous effects and worker profile reader (012, 013).
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> promoted from packages/db/profile-transition/012_continuous_effects.sql (source sha256 f380059d2157b7210450afaf032f0a983c2356f789063ef9f7b856ec6f4243e4)
-- Isolated F3 successor to 010. No historical effects are reauthorized.
ALTER TABLE outbox ADD COLUMN continuous_authorization_id uuid;
ALTER TABLE outbox ADD CONSTRAINT continuous_outbox_scope
 FOREIGN KEY(workspace_id,environment,continuous_authorization_id)
 REFERENCES continuous_authorizations(workspace_id,environment,id);
ALTER TABLE outbox ADD CONSTRAINT continuous_outbox_single_authority
 CHECK(continuous_authorization_id IS NULL OR authorization_id IS NULL);
CREATE FUNCTION guard_continuous_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s jsonb;
BEGIN
 IF TG_OP='UPDATE' AND NEW.continuous_authorization_id IS DISTINCT FROM OLD.continuous_authorization_id THEN
  RAISE EXCEPTION 'CONTINUITY_EFFECT_AUTHORITY_IMMUTABLE'; END IF;
 IF NEW.continuous_authorization_id IS NULL THEN RETURN NEW; END IF;
 IF current_setting('app.workspace_id',true) IS DISTINCT FROM NEW.workspace_id THEN
  RAISE EXCEPTION 'CONTINUITY_PROFILE_CONTEXT_REQUIRED'; END IF;
 SELECT a.state INTO s FROM public.continuous_authorizations a WHERE a.workspace_id=NEW.workspace_id
  AND a.environment=NEW.environment AND a.id=NEW.continuous_authorization_id FOR SHARE;
 IF s IS NULL OR s->>'accountId' IS DISTINCT FROM NEW.account_id
  OR (NEW.kind='warmup') IS DISTINCT FROM (s->'source'->>'kind'='VERIFIED_QR_CONNECTION') THEN
  RAISE EXCEPTION 'CONTINUITY_EFFECT_SCOPE_CHANGED'; END IF;
 IF TG_OP='INSERT' AND s->'revokedAt'<>'null'::jsonb THEN RAISE EXCEPTION 'CONTINUITY_REVOKED'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_continuous_effect() FROM PUBLIC;
CREATE TRIGGER guard_continuous_effect BEFORE INSERT OR UPDATE ON outbox
 FOR EACH ROW EXECUTE FUNCTION guard_continuous_effect();
CREATE INDEX outbox_continuity_scope ON outbox(workspace_id,environment,continuous_authorization_id)
 WHERE continuous_authorization_id IS NOT NULL;
-- <<< end 012_continuous_effects.sql

-- >>> promoted from packages/db/profile-transition/013_continuous_worker_profile.sql (source sha256 470594d2918125e317838864bedbaeb327fad054cad09ae17a51593fb43ffaf1)
-- Worker authority reads one profile already selected by the authenticated
-- scheduler. This supplies a locked fact, not authority to select a profile.
CREATE FUNCTION read_locked_continuous_worker_profile()
RETURNS TABLE(id text,state text,version integer,timezone text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected text:=pg_catalog.current_setting('app.workspace_id',true);
BEGIN
 IF selected IS NULL OR length(selected)=0 THEN
  RAISE EXCEPTION 'CONTINUITY_PROFILE_CONTEXT_REQUIRED';
 END IF;
 RETURN QUERY SELECT p.id,p.state,p.version,p.timezone FROM public.profiles p
  WHERE p.id=selected FOR SHARE;
END $$;
REVOKE ALL ON FUNCTION read_locked_continuous_worker_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_locked_continuous_worker_profile() TO commerce_automation,commerce_channel;
-- <<< end 013_continuous_worker_profile.sql
