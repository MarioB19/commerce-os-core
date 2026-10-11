-- Immutable effective-time assignments may supersede older versions; tied scopes may not conflict.
CREATE FUNCTION guard_binding_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ad_parent text; campaign_parent text; scope_key text;
BEGIN
 IF NEW.kind<>'binding' THEN RETURN NEW; END IF;
 IF NEW.body->>'ad_id' IS NOT NULL THEN
  SELECT body->>'ad_set_id' INTO ad_parent FROM records WHERE id::text=NEW.body->>'ad_id' AND workspace_id=NEW.workspace_id AND environment=NEW.environment AND kind='ad';
  IF NEW.body->>'ad_set_id' IS NOT NULL AND NEW.body->>'ad_set_id' IS DISTINCT FROM ad_parent THEN RAISE EXCEPTION 'INVALID_BINDING_AD_SET'; END IF;
 END IF;
 IF COALESCE(NEW.body->>'ad_set_id',ad_parent) IS NOT NULL THEN
  SELECT body->>'campaign_id' INTO campaign_parent FROM records WHERE id::text=COALESCE(NEW.body->>'ad_set_id',ad_parent) AND workspace_id=NEW.workspace_id AND environment=NEW.environment AND kind='ad_set';
  IF NEW.body->>'campaign_id' IS NOT NULL AND NEW.body->>'campaign_id' IS DISTINCT FROM campaign_parent THEN RAISE EXCEPTION 'INVALID_BINDING_CAMPAIGN'; END IF;
 END IF;
 scope_key:=CASE WHEN NEW.body->>'ad_id' IS NOT NULL THEN 'ad:'||(NEW.body->>'ad_id') WHEN NEW.body->>'ad_set_id' IS NOT NULL THEN 'ad_set:'||(NEW.body->>'ad_set_id') WHEN NEW.body->>'campaign_id' IS NOT NULL THEN 'campaign:'||(NEW.body->>'campaign_id') ELSE 'account' END;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id||':'||NEW.environment||':'||(NEW.body->>'account_id')||':'||scope_key,0));
 IF EXISTS(SELECT 1 FROM records r WHERE r.kind='binding' AND r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment AND r.body->>'account_id'=NEW.body->>'account_id' AND (r.body->>'valid_from')::timestamptz=(NEW.body->>'valid_from')::timestamptz AND CASE WHEN r.body->>'ad_id' IS NOT NULL THEN 'ad:'||(r.body->>'ad_id') WHEN r.body->>'ad_set_id' IS NOT NULL THEN 'ad_set:'||(r.body->>'ad_set_id') WHEN r.body->>'campaign_id' IS NOT NULL THEN 'campaign:'||(r.body->>'campaign_id') ELSE 'account' END=scope_key) THEN RAISE EXCEPTION 'AMBIGUOUS_BINDING_SCOPE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_binding_scope BEFORE INSERT ON records FOR EACH ROW EXECUTE FUNCTION guard_binding_scope();
