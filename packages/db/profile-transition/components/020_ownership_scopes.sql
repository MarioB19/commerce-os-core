-- Local component. Native execution requires the reviewed complete cutover.
DO $ownership$
DECLARE relation text; differences bigint;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED'; END IF;
 LOCK TABLE public.ownership_isolation_receipts,public.profiles,public.records,public.session_ownership IN ACCESS EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid IN('public.ownership_isolation_receipts'::regclass,'public.session_ownership'::regclass) AND attname IN('environment','account_record_id') AND NOT attisdropped) THEN RAISE EXCEPTION 'PROFILE_OWNERSHIP_ALREADY_ALTERED'; END IF;
 -- Joining the original text without a cast rejects noncanonical and orphan
 -- identities without rewriting them or manufacturing a default environment.
 IF EXISTS(SELECT 1 FROM public.session_ownership s LEFT JOIN public.records a ON a.id::text=s.account_id LEFT JOIN public.profiles p ON p.id=a.workspace_id WHERE a.id IS NULL OR p.id IS NULL OR a.kind<>'channel_account' OR a.workspace_id<>s.workspace_id OR a.environment NOT IN('REAL','SIMULATION'))
 OR EXISTS(SELECT 1 FROM public.ownership_isolation_receipts s LEFT JOIN public.records a ON a.id=s.account_id LEFT JOIN public.profiles p ON p.id=a.workspace_id WHERE a.id IS NULL OR p.id IS NULL OR a.kind<>'channel_account' OR a.workspace_id<>s.workspace_id OR a.environment NOT IN('REAL','SIMULATION')) THEN RAISE EXCEPTION 'PROFILE_OWNERSHIP_PARENT_ADOPTION_REQUIRED'; END IF;
 CREATE TEMP TABLE profile_ownership_originals(table_name text NOT NULL,row_data jsonb NOT NULL) ON COMMIT DROP;
 INSERT INTO pg_temp.profile_ownership_originals SELECT 'session_ownership',to_jsonb(s) FROM public.session_ownership s;
 INSERT INTO pg_temp.profile_ownership_originals SELECT 'ownership_isolation_receipts',to_jsonb(s) FROM public.ownership_isolation_receipts s;
 ALTER TABLE public.session_ownership ADD COLUMN environment text,ADD COLUMN account_record_id uuid GENERATED ALWAYS AS (account_id::uuid) STORED;
 ALTER TABLE public.ownership_isolation_receipts ADD COLUMN environment text;
 UPDATE public.session_ownership s SET environment=a.environment FROM public.records a WHERE a.id::text=s.account_id;
 UPDATE public.ownership_isolation_receipts s SET environment=a.environment FROM public.records a WHERE a.id=s.account_id;
 FOR relation IN SELECT unnest(ARRAY['session_ownership','ownership_isolation_receipts']) LOOP
  EXECUTE format('SELECT count(*) FROM ((SELECT row_data FROM pg_temp.profile_ownership_originals WHERE table_name=%L EXCEPT ALL SELECT to_jsonb(s)-ARRAY[''environment'',''account_record_id''] FROM public.%I s) UNION ALL (SELECT to_jsonb(s)-ARRAY[''environment'',''account_record_id''] FROM public.%I s EXCEPT ALL SELECT row_data FROM pg_temp.profile_ownership_originals WHERE table_name=%L)) x',relation,relation,relation,relation) INTO differences;
  IF differences<>0 THEN RAISE EXCEPTION 'PROFILE_OWNERSHIP_HISTORY_CHANGED'; END IF;
  EXECUTE format('ALTER TABLE public.%I ALTER COLUMN environment SET NOT NULL,ADD CONSTRAINT profile_ownership_environment CHECK(environment IN(''REAL'',''SIMULATION'')),ADD CONSTRAINT profile_ownership_profile FOREIGN KEY(workspace_id) REFERENCES public.profiles(id)',relation);
 END LOOP;
 ALTER TABLE public.records ADD CONSTRAINT v7_ownership_parent_records UNIQUE(id,workspace_id,environment);
 ALTER TABLE public.session_ownership ALTER COLUMN account_record_id SET NOT NULL,ADD CONSTRAINT profile_ownership_canonical_id CHECK(account_id=account_record_id::text),ADD CONSTRAINT profile_ownership_parent FOREIGN KEY(account_record_id,workspace_id,environment) REFERENCES public.records(id,workspace_id,environment);
 ALTER TABLE public.ownership_isolation_receipts ADD CONSTRAINT profile_ownership_parent FOREIGN KEY(account_id,workspace_id,environment) REFERENCES public.records(id,workspace_id,environment);
 EXECUTE $guard$
 CREATE FUNCTION public.bind_profile_ownership_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
 DECLARE parent record;
 BEGIN
  IF TG_TABLE_NAME NOT IN('session_ownership','ownership_isolation_receipts') THEN RAISE EXCEPTION 'PROFILE_OWNERSHIP_TABLE_UNREVIEWED'; END IF;
  IF TG_OP='UPDATE' AND (NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.environment IS DISTINCT FROM OLD.environment) THEN RAISE EXCEPTION 'PROFILE_OWNERSHIP_IDENTITY_IMMUTABLE'; END IF;
  SELECT workspace_id,environment INTO parent FROM public.records WHERE id=NEW.account_id::text::uuid AND id::text=NEW.account_id::text AND kind='channel_account';
  IF NOT FOUND OR parent.workspace_id IS DISTINCT FROM NEW.workspace_id OR current_setting('app.workspace_id',true) IS DISTINCT FROM parent.workspace_id OR current_setting('app.environment',true) IS DISTINCT FROM parent.environment THEN RAISE EXCEPTION 'PROFILE_OWNERSHIP_CONTEXT_REQUIRED'; END IF;
  IF NEW.environment IS NOT NULL AND NEW.environment IS DISTINCT FROM parent.environment THEN RAISE EXCEPTION 'PROFILE_OWNERSHIP_ENVIRONMENT_CHANGED'; END IF;
  NEW.environment:=parent.environment;RETURN NEW;
 END $body$
 $guard$;
 REVOKE ALL ON FUNCTION public.bind_profile_ownership_scope() FROM PUBLIC;
 FOR relation IN SELECT unnest(ARRAY['session_ownership','ownership_isolation_receipts']) LOOP
  EXECUTE format('CREATE TRIGGER bind_profile_ownership_scope BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.bind_profile_ownership_scope()',relation);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format($policy$CREATE POLICY profile_ownership_access ON public.%I USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''))$policy$,relation);
  EXECUTE format($policy$CREATE POLICY profile_ownership_restriction ON public.%I AS RESTRICTIVE USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''))$policy$,relation);
 END LOOP;
 DROP TABLE pg_temp.profile_ownership_originals;
END
$ownership$;
