-- ADR-005 hardening: the database independently verifies the exact approved manifest.
CREATE FUNCTION retention_canonical_json(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE result text; item record;
BEGIN
 IF jsonb_typeof(value)='object' THEN
  result:=''; FOR item IN SELECT key,val FROM jsonb_each(value) AS e(key,val) ORDER BY key COLLATE "C" LOOP result:=result||CASE WHEN result='' THEN '' ELSE ',' END||to_jsonb(item.key)::text||':'||retention_canonical_json(item.val); END LOOP;RETURN '{'||result||'}';
 ELSIF jsonb_typeof(value)='array' THEN
  result:=''; FOR item IN SELECT val FROM jsonb_array_elements(value) AS e(val) LOOP result:=result||CASE WHEN result='' THEN '' ELSE ',' END||retention_canonical_json(item.val); END LOOP;RETURN '['||result||']';
 ELSE RETURN value::text; END IF;
END $$;
CREATE FUNCTION guard_retention_plan() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE item jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.policy_id IS DISTINCT FROM OLD.policy_id OR NEW.plan_digest IS DISTINCT FROM OLD.plan_digest OR NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'IMMUTABLE_RETENTION_PLAN'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.status IS DISTINCT FROM 'PLANNED' OR NEW.plan_digest IS DISTINCT FROM encode(digest(retention_canonical_json(NEW.manifest),'sha256'),'hex') THEN RAISE EXCEPTION 'RETENTION_PLAN_DIGEST_MISMATCH'; END IF;
 IF jsonb_typeof(NEW.manifest->'candidates') IS DISTINCT FROM 'array' OR NEW.manifest->>'policy_id' IS DISTINCT FROM NEW.policy_id::text OR NOT EXISTS(SELECT 1 FROM retention_policies p WHERE p.id=NEW.policy_id AND p.workspace_id=NEW.manifest->>'workspace_id' AND p.environment=NEW.manifest->>'environment') OR (NEW.manifest->>'planned_at')::timestamptz IS DISTINCT FROM NEW.created_at THEN RAISE EXCEPTION 'RETENTION_SCOPE_MISMATCH'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(NEW.manifest->'candidates') LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR COALESCE(item->>'kind','') NOT IN('envelope','message','conversation','ai_run','asset','outbox','idempotency') OR NOT COALESCE(item->>'snapshot_hash' ~ '^[a-f0-9]{64}$',false) THEN RAISE EXCEPTION 'RETENTION_CANDIDATE_INVALID'; END IF;
  IF item->>'kind'='idempotency' THEN
   IF NOT COALESCE(item->>'id' ~ '^[a-f0-9]{64}$',false) OR COALESCE(item->>'actor_id','')='' OR COALESCE(item->>'operation','')='' OR COALESCE(item->>'key','')='' THEN RAISE EXCEPTION 'RETENTION_CANDIDATE_INVALID'; END IF;
  ELSE
   IF NOT COALESCE(item->>'id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) THEN RAISE EXCEPTION 'RETENTION_CANDIDATE_INVALID'; END IF;
  END IF;
  IF item->>'kind' IN('message','conversation','ai_run','asset') AND NOT COALESCE(item->>'version' ~ '^[1-9][0-9]*$',false) THEN RAISE EXCEPTION 'RETENTION_CANDIDATE_INVALID'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_retention_plan BEFORE INSERT OR UPDATE ON retention_plans FOR EACH ROW EXECUTE FUNCTION guard_retention_plan();
REVOKE UPDATE ON retention_plans FROM commerce_maintenance;
REVOKE INSERT ON retention_files FROM commerce_maintenance;
REVOKE UPDATE ON retention_files FROM commerce_maintenance;
GRANT UPDATE(status,removed_at,error) ON retention_files TO commerce_maintenance;
ALTER FUNCTION apply_retention_plan(uuid,text,boolean) RENAME TO apply_retention_plan_internal;
REVOKE ALL ON FUNCTION apply_retention_plan_internal(uuid,text,boolean) FROM commerce_maintenance,PUBLIC;
CREATE FUNCTION apply_retention_plan(plan_uuid uuid,confirmed_digest text,allow_real boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE plan retention_plans%ROWTYPE;
BEGIN
 SELECT * INTO plan FROM retention_plans WHERE id=plan_uuid FOR UPDATE;
 IF NOT FOUND OR confirmed_digest IS NULL OR plan.plan_digest IS DISTINCT FROM confirmed_digest OR plan.plan_digest IS DISTINCT FROM encode(digest(retention_canonical_json(plan.manifest),'sha256'),'hex') THEN RAISE EXCEPTION 'RETENTION_PLAN_DIGEST_MISMATCH'; END IF;
 IF plan.manifest->>'environment'='REAL' AND allow_real IS DISTINCT FROM true THEN RAISE EXCEPTION 'REAL_RETENTION_NOT_AUTHORIZED'; END IF;
 RETURN apply_retention_plan_internal(plan_uuid,confirmed_digest,allow_real);
END $$;
REVOKE ALL ON FUNCTION apply_retention_plan(uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_retention_plan(uuid,text,boolean) TO commerce_maintenance;
