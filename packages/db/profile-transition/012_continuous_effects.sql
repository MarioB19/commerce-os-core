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
