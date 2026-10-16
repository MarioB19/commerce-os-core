-- Requires an independently authenticated complete historical adoption map.
-- pg_temp.profile_idempotency_scope_adoptions columns (all text):
-- workspace_id,actor_id,operation,key,row_sha256,environment,evidence_sha256.
-- row_sha256 = encode(digest(convert_to(to_jsonb(original_row)::text,'UTF8'),'sha256'),'hex').
DO $idempotency_scope$
DECLARE differences bigint;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED';END IF;
 LOCK TABLE public.idempotency,public.profiles IN ACCESS EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.idempotency'::regclass AND attname IN('environment','scope_adoption_sha256') AND NOT attisdropped) THEN RAISE EXCEPTION 'PROFILE_IDEMPOTENCY_ALREADY_ALTERED';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=to_regclass('pg_temp.profile_idempotency_scope_adoptions') AND c.relnamespace=pg_my_temp_schema() AND c.relpersistence='t' AND c.relkind='r' AND r.rolname=current_user) THEN RAISE EXCEPTION 'PROFILE_IDEMPOTENCY_MAP_REQUIRED';END IF;
 IF (SELECT count(*) FROM pg_temp.profile_idempotency_scope_adoptions)<>(SELECT count(*) FROM public.idempotency)
 OR EXISTS(SELECT 1 FROM pg_temp.profile_idempotency_scope_adoptions GROUP BY workspace_id,actor_id,operation,key HAVING count(*)<>1)
 OR EXISTS(SELECT 1 FROM pg_temp.profile_idempotency_scope_adoptions a LEFT JOIN public.idempotency i ON(i.workspace_id,i.actor_id,i.operation,i.key)=(a.workspace_id,a.actor_id,a.operation,a.key) LEFT JOIN public.profiles p ON p.id=i.workspace_id WHERE i.key IS NULL OR p.id IS NULL OR
  (a.environment IN('REAL','SIMULATION') AND a.evidence_sha256 ~ '^[a-f0-9]{64}$' AND a.row_sha256=encode(public.digest(convert_to(to_jsonb(i)::text,'UTF8'),'sha256'),'hex')) IS NOT TRUE)
 THEN RAISE EXCEPTION 'PROFILE_IDEMPOTENCY_ADOPTION_REQUIRED';END IF;
 CREATE TEMP TABLE profile_idempotency_originals(row_data jsonb) ON COMMIT DROP;
 INSERT INTO pg_temp.profile_idempotency_originals SELECT to_jsonb(i) FROM public.idempotency i;
 ALTER TABLE public.idempotency ADD COLUMN environment text,ADD COLUMN scope_adoption_sha256 text;
 UPDATE public.idempotency i SET environment=a.environment,scope_adoption_sha256=a.evidence_sha256 FROM pg_temp.profile_idempotency_scope_adoptions a WHERE(i.workspace_id,i.actor_id,i.operation,i.key)=(a.workspace_id,a.actor_id,a.operation,a.key);
 SELECT count(*) INTO differences FROM ((SELECT row_data FROM pg_temp.profile_idempotency_originals EXCEPT ALL SELECT to_jsonb(i)-ARRAY['environment','scope_adoption_sha256'] FROM public.idempotency i) UNION ALL (SELECT to_jsonb(i)-ARRAY['environment','scope_adoption_sha256'] FROM public.idempotency i EXCEPT ALL SELECT row_data FROM pg_temp.profile_idempotency_originals)) x;
 IF differences<>0 THEN RAISE EXCEPTION 'PROFILE_IDEMPOTENCY_HISTORY_CHANGED';END IF;
 ALTER TABLE public.idempotency ALTER COLUMN environment SET NOT NULL,ADD CONSTRAINT profile_idempotency_environment CHECK(environment IN('REAL','SIMULATION')),ADD CONSTRAINT profile_idempotency_adoption CHECK(scope_adoption_sha256 IS NULL OR scope_adoption_sha256 ~ '^[a-f0-9]{64}$'),ADD CONSTRAINT profile_idempotency_profile FOREIGN KEY(workspace_id) REFERENCES public.profiles(id);
 EXECUTE $function$
 CREATE FUNCTION public.bind_profile_idempotency() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
 DECLARE env text:=NULLIF(current_setting('app.environment',true),'');
 BEGIN
  IF current_setting('app.workspace_id',true) IS DISTINCT FROM NEW.workspace_id OR (env IN('REAL','SIMULATION')) IS NOT TRUE THEN RAISE EXCEPTION 'PROFILE_IDEMPOTENCY_CONTEXT_REQUIRED';END IF;
  IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.actor_id,NEW.operation,NEW.key,NEW.environment,NEW.scope_adoption_sha256) IS DISTINCT FROM(OLD.workspace_id,OLD.actor_id,OLD.operation,OLD.key,OLD.environment,OLD.scope_adoption_sha256) THEN RAISE EXCEPTION 'PROFILE_IDEMPOTENCY_IDENTITY_IMMUTABLE';END IF;
  IF TG_OP='INSERT' AND NEW.scope_adoption_sha256 IS NOT NULL THEN RAISE EXCEPTION 'PROFILE_IDEMPOTENCY_ADOPTION_RUNTIME_FORBIDDEN';END IF;
  IF NEW.environment IS NOT NULL AND NEW.environment IS DISTINCT FROM env THEN RAISE EXCEPTION 'PROFILE_IDEMPOTENCY_ENVIRONMENT_CHANGED';END IF;
  NEW.environment:=env;RETURN NEW;
 END $body$
 $function$;
 REVOKE ALL ON FUNCTION public.bind_profile_idempotency() FROM PUBLIC;
 CREATE TRIGGER bind_profile_idempotency BEFORE INSERT OR UPDATE ON public.idempotency FOR EACH ROW EXECUTE FUNCTION public.bind_profile_idempotency();
 ALTER TABLE public.idempotency ENABLE ROW LEVEL SECURITY;ALTER TABLE public.idempotency FORCE ROW LEVEL SECURITY;
 CREATE POLICY profile_idempotency_access ON public.idempotency USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''));
 CREATE POLICY profile_idempotency_restriction ON public.idempotency AS RESTRICTIVE USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''));
 DROP TABLE pg_temp.profile_idempotency_originals;
END $idempotency_scope$;
