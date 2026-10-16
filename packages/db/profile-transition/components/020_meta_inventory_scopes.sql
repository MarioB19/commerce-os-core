-- Historical META_API inventories are exclusively REAL. No trigger is disabled.
DO $meta_scope$
DECLARE differences bigint; relation text;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED';END IF;
 LOCK TABLE public.meta_syncs,public.meta_links,public.profiles IN ACCESS EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.meta_syncs'::regclass AND attname='environment' AND NOT attisdropped) THEN RAISE EXCEPTION 'PROFILE_META_ALREADY_ALTERED';END IF;
 IF EXISTS(SELECT 1 FROM public.meta_syncs s LEFT JOIN public.profiles p ON p.id=s.workspace_id WHERE p.id IS NULL OR (s.inventory->>'source'='META_API') IS NOT TRUE)
 OR EXISTS(SELECT 1 FROM public.meta_links l LEFT JOIN public.meta_syncs s ON(s.id,s.workspace_id)=(l.sync_id,l.workspace_id) WHERE s.id IS NULL OR l.environment IS DISTINCT FROM 'REAL') THEN RAISE EXCEPTION 'PROFILE_META_ADOPTION_REQUIRED';END IF;
 CREATE TEMP TABLE profile_meta_originals(table_name text,row_data jsonb) ON COMMIT DROP;
 INSERT INTO pg_temp.profile_meta_originals SELECT 'meta_syncs',to_jsonb(s) FROM public.meta_syncs s;
 INSERT INTO pg_temp.profile_meta_originals SELECT 'meta_links',to_jsonb(l) FROM public.meta_links l;
 ALTER TABLE public.meta_syncs ADD COLUMN environment text GENERATED ALWAYS AS ('REAL'::text) STORED NOT NULL;
 ALTER TABLE public.meta_syncs ADD CONSTRAINT profile_meta_source CHECK((inventory->>'source'='META_API') IS TRUE),ADD CONSTRAINT profile_meta_scope_identity UNIQUE(id,workspace_id,environment),ADD CONSTRAINT profile_meta_profile FOREIGN KEY(workspace_id) REFERENCES public.profiles(id);
 ALTER TABLE public.meta_links ADD CONSTRAINT profile_meta_parent FOREIGN KEY(sync_id,workspace_id,environment) REFERENCES public.meta_syncs(id,workspace_id,environment);
 FOR relation IN SELECT unnest(ARRAY['meta_syncs','meta_links']) LOOP
  EXECUTE format('SELECT count(*) FROM ((SELECT row_data FROM pg_temp.profile_meta_originals WHERE table_name=%L EXCEPT ALL SELECT %s FROM public.%I s) UNION ALL (SELECT %s FROM public.%I s EXCEPT ALL SELECT row_data FROM pg_temp.profile_meta_originals WHERE table_name=%L)) x',relation,CASE WHEN relation='meta_syncs' THEN 'to_jsonb(s)-''environment''' ELSE 'to_jsonb(s)' END,relation,CASE WHEN relation='meta_syncs' THEN 'to_jsonb(s)-''environment''' ELSE 'to_jsonb(s)' END,relation,relation) INTO differences;
  IF differences<>0 THEN RAISE EXCEPTION 'PROFILE_META_HISTORY_CHANGED';END IF;
 END LOOP;
 EXECUTE $function$
 CREATE FUNCTION public.bind_profile_meta_inventory() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
 BEGIN
  IF TG_TABLE_NAME NOT IN('meta_syncs','meta_links') OR current_setting('app.workspace_id',true) IS DISTINCT FROM NEW.workspace_id OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' THEN RAISE EXCEPTION 'PROFILE_META_CONTEXT_REQUIRED';END IF;
  RETURN NEW;
 END $body$
 $function$;
 REVOKE ALL ON FUNCTION public.bind_profile_meta_inventory() FROM PUBLIC;
 FOR relation IN SELECT unnest(ARRAY['meta_syncs','meta_links']) LOOP
  EXECUTE format('CREATE TRIGGER bind_profile_meta_inventory BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.bind_profile_meta_inventory()',relation);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',relation);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format($policy$CREATE POLICY profile_meta_access ON public.%I USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''))$policy$,relation);
  EXECUTE format($policy$CREATE POLICY profile_meta_restriction ON public.%I AS RESTRICTIVE USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''))$policy$,relation);
 END LOOP;
 DROP TABLE pg_temp.profile_meta_originals;
END $meta_scope$;
