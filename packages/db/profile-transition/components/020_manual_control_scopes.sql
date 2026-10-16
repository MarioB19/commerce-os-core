-- Workspace-wide stops remain shared safety controls; record controls do not.
DO $control_scope$
DECLARE differences bigint;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED';END IF;
 LOCK TABLE public.manual_controls,public.records,public.profiles IN ACCESS EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.manual_controls'::regclass AND attname IN('environment','scope_record_id') AND NOT attisdropped) THEN RAISE EXCEPTION 'PROFILE_CONTROL_ALREADY_ALTERED';END IF;
 IF EXISTS(SELECT 1 FROM public.manual_controls m LEFT JOIN public.profiles p ON p.id=m.workspace_id LEFT JOIN public.records r ON r.id::text=m.scope_id AND r.workspace_id=m.workspace_id AND r.kind=m.scope_type
 WHERE p.id IS NULL OR (m.scope_type='workspace' AND m.scope_id IS DISTINCT FROM m.workspace_id) OR (m.scope_type<>'workspace' AND r.id IS NULL)) THEN RAISE EXCEPTION 'PROFILE_CONTROL_ADOPTION_REQUIRED';END IF;
 CREATE TEMP TABLE profile_control_originals(row_data jsonb) ON COMMIT DROP;
 INSERT INTO pg_temp.profile_control_originals SELECT to_jsonb(m) FROM public.manual_controls m;
 ALTER TABLE public.manual_controls ADD COLUMN environment text,ADD COLUMN scope_record_id uuid GENERATED ALWAYS AS(CASE WHEN scope_type='workspace' THEN NULL ELSE scope_id::uuid END) STORED;
 UPDATE public.manual_controls m SET environment=r.environment FROM public.records r WHERE m.scope_type<>'workspace' AND r.id::text=m.scope_id AND r.workspace_id=m.workspace_id AND r.kind=m.scope_type;
 SELECT count(*) INTO differences FROM ((SELECT row_data FROM pg_temp.profile_control_originals EXCEPT ALL SELECT to_jsonb(m)-ARRAY['environment','scope_record_id'] FROM public.manual_controls m) UNION ALL(SELECT to_jsonb(m)-ARRAY['environment','scope_record_id'] FROM public.manual_controls m EXCEPT ALL SELECT row_data FROM pg_temp.profile_control_originals)) d;
 IF differences<>0 THEN RAISE EXCEPTION 'PROFILE_CONTROL_HISTORY_CHANGED';END IF;
 CREATE UNIQUE INDEX profile_control_record_identity ON public.records(id,workspace_id,environment,kind);
 ALTER TABLE public.manual_controls ADD CONSTRAINT profile_control_shape CHECK(((scope_type='workspace' AND scope_id=workspace_id AND environment IS NULL) OR(scope_type<>'workspace' AND environment IN('REAL','SIMULATION'))) IS TRUE),
 ADD CONSTRAINT profile_control_profile FOREIGN KEY(workspace_id) REFERENCES public.profiles(id),
 ADD CONSTRAINT profile_control_parent FOREIGN KEY(scope_record_id,workspace_id,environment,scope_type) REFERENCES public.records(id,workspace_id,environment,kind);
 EXECUTE $function$
 CREATE FUNCTION public.bind_profile_manual_control() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
 DECLARE env text:=NULLIF(current_setting('app.environment',true),'');parent_environment text;
 BEGIN
  IF TG_OP='DELETE' THEN
   IF current_setting('app.workspace_id',true) IS DISTINCT FROM OLD.workspace_id OR (env IN('REAL','SIMULATION')) IS NOT TRUE OR (OLD.scope_type='workspace' AND env<>'REAL') OR (OLD.scope_type<>'workspace' AND OLD.environment IS DISTINCT FROM env) THEN RAISE EXCEPTION 'PROFILE_CONTROL_CONTEXT_REQUIRED';END IF;
   RETURN OLD;
  END IF;
  IF current_setting('app.workspace_id',true) IS DISTINCT FROM NEW.workspace_id OR (env IN('REAL','SIMULATION')) IS NOT TRUE THEN RAISE EXCEPTION 'PROFILE_CONTROL_CONTEXT_REQUIRED';END IF;
  IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.scope_type,NEW.scope_id,NEW.environment) IS DISTINCT FROM(OLD.workspace_id,OLD.scope_type,OLD.scope_id,OLD.environment) THEN RAISE EXCEPTION 'PROFILE_CONTROL_IDENTITY_IMMUTABLE';END IF;
  IF NEW.scope_type='workspace' THEN
   IF env<>'REAL' THEN RAISE EXCEPTION 'PROFILE_CONTROL_GLOBAL_REAL_REQUIRED';END IF;
   IF NEW.scope_id IS DISTINCT FROM NEW.workspace_id OR NEW.environment IS NOT NULL THEN RAISE EXCEPTION 'PROFILE_CONTROL_GLOBAL_SCOPE_INVALID';END IF;
  ELSE
   SELECT r.environment INTO parent_environment FROM public.records r WHERE r.id::text=NEW.scope_id AND r.workspace_id=NEW.workspace_id AND r.kind=NEW.scope_type FOR SHARE;
   IF NOT FOUND OR parent_environment IS DISTINCT FROM env THEN RAISE EXCEPTION 'PROFILE_CONTROL_PARENT_REQUIRED';END IF;
   IF NEW.environment IS NOT NULL AND NEW.environment IS DISTINCT FROM parent_environment THEN RAISE EXCEPTION 'PROFILE_CONTROL_ENVIRONMENT_CHANGED';END IF;
   NEW.environment:=parent_environment;
  END IF;
  RETURN NEW;
 END $body$
 $function$;
 REVOKE ALL ON FUNCTION public.bind_profile_manual_control() FROM PUBLIC;
 CREATE TRIGGER bind_profile_manual_control BEFORE INSERT OR UPDATE OR DELETE ON public.manual_controls FOR EACH ROW EXECUTE FUNCTION public.bind_profile_manual_control();
 ALTER TABLE public.manual_controls ENABLE ROW LEVEL SECURITY;ALTER TABLE public.manual_controls FORCE ROW LEVEL SECURITY;
 CREATE POLICY profile_control_access ON public.manual_controls USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND current_setting('app.environment',true) IN('REAL','SIMULATION') AND(scope_type='workspace' OR environment=current_setting('app.environment',true)))
 WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND((scope_type='workspace' AND current_setting('app.environment',true)='REAL') OR(scope_type<>'workspace' AND environment=current_setting('app.environment',true))));
 CREATE POLICY profile_control_restriction ON public.manual_controls AS RESTRICTIVE USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND current_setting('app.environment',true) IN('REAL','SIMULATION') AND(scope_type='workspace' OR environment=current_setting('app.environment',true)))
 WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND((scope_type='workspace' AND current_setting('app.environment',true)='REAL') OR(scope_type<>'workspace' AND environment=current_setting('app.environment',true))));
 DROP TABLE pg_temp.profile_control_originals;
END $control_scope$;
