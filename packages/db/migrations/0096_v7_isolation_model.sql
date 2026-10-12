-- V7 F2 cutover: row isolation model (docs/adr-v7-isolation-model.md).
-- * commerce_api: FORCE RLS on every table holding profile data, with a
--   RESTRICTIVE policy requiring app.workspace_id. Absent context denies.
-- * Workers (members of commerce_worker_global) keep their historical global
--   loops on historical tables only while no profile context is installed; a
--   transaction that installs app.workspace_id is held to that profile.
-- * Other reviewed V7 roles that hold privileges on a table that had no RLS
--   receive a context-bound policy; existing V7 policies are preserved.
-- No grant is added, no role gains BYPASSRLS and no row is read or changed.
CREATE FUNCTION public.v7_worker_global_without_context() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT NULLIF(current_setting('app.workspace_id',true),'') IS NULL
  AND NULLIF(current_setting('app.environment',true),'') IS NULL
  AND pg_has_role(current_user,'commerce_worker_global','USAGE')
$$;
REVOKE ALL ON FUNCTION public.v7_worker_global_without_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.v7_worker_global_without_context() TO PUBLIC;

DO $isolation$
DECLARE t record; p record; r record; scope_column text; ctx text; worker text; was_enabled boolean; historical boolean;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED'; END IF;
 FOR t IN SELECT c.oid,c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN('r','p') AND (c.relname='profiles' OR EXISTS(SELECT 1 FROM pg_attribute a
   WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped AND a.attnum>0))
  ORDER BY c.relname LOOP
  EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE',t.relname);
  scope_column:=CASE WHEN t.relname='profiles' THEN 'id' ELSE 'workspace_id' END;
  ctx:=format('%I=NULLIF(current_setting(''app.workspace_id'',true),'''')',scope_column);
  worker:=format('(NULLIF(current_setting(''app.workspace_id'',true),'''') IS NULL OR %I=current_setting(''app.workspace_id'',true))',scope_column);
  was_enabled:=t.relrowsecurity;
  historical:=EXISTS(SELECT 1 FROM public.profile_cutover_historical_tables h WHERE h.name=t.relname);
  -- Roles with privileges on a table that had no RLS keep access only inside
  -- their profile context. Worker roles on historical tables are handled below.
  IF NOT was_enabled THEN
   FOR r IN SELECT DISTINCT g.rolname FROM pg_roles g WHERE g.rolname ~ '^commerce_[a-z_]+$' AND NOT g.rolsuper
    AND g.oid<>(SELECT relowner FROM pg_class WHERE oid=t.oid)
    AND (has_table_privilege(g.oid,t.oid,'SELECT,INSERT,UPDATE,DELETE') OR has_any_column_privilege(g.oid,t.oid,'SELECT,INSERT,UPDATE'))
    AND NOT EXISTS(SELECT 1 FROM pg_policy x WHERE x.polrelid=t.oid AND g.oid=ANY(x.polroles))
    AND g.rolname<>'commerce_api'
    AND NOT (historical AND g.rolname IN('commerce_ingress','commerce_automation','commerce_channel','commerce_maintenance','commerce_worker_global'))
    ORDER BY g.rolname LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I AS PERMISSIVE TO %I USING(%s) WITH CHECK(%s)',left('v7_profile_'||r.rolname,63),t.relname,r.rolname,ctx,ctx);
   END LOOP;
  END IF;
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t.relname);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t.relname);
  -- Narrowing only: the API never sees another profile, whatever other
  -- permissive policy exists. Context is installed by withProfileTransaction.
  EXECUTE format('CREATE POLICY v7_api_profile_guard ON public.%I AS RESTRICTIVE TO commerce_api USING(%s) WITH CHECK(%s)',t.relname,ctx,ctx);
  IF NOT was_enabled AND NOT EXISTS(SELECT 1 FROM pg_policy x WHERE x.polrelid=t.oid AND x.polpermissive AND 'commerce_api'::regrole=ANY(x.polroles)) THEN
   EXECUTE format('CREATE POLICY v7_api_profile ON public.%I AS PERMISSIVE TO commerce_api USING(%s) WITH CHECK(%s)',t.relname,ctx,ctx);
  END IF;
  IF historical THEN
   EXECUTE format('CREATE POLICY v7_worker_global ON public.%I AS PERMISSIVE TO commerce_worker_global USING(%s) WITH CHECK(%s)',t.relname,worker,worker);
   -- Reviewed V7 restrictive policies on historical tables keep binding every
   -- role inside a context; only a worker transaction without any profile
   -- context retains its historical global loop.
   FOR p IN SELECT x.polname,pg_get_expr(x.polqual,x.polrelid) q,pg_get_expr(x.polwithcheck,x.polrelid) c
    FROM pg_policy x WHERE x.polrelid=t.oid AND NOT x.polpermissive AND x.polroles='{0}'::oid[] ORDER BY x.polname LOOP
    IF p.q IS NOT NULL THEN EXECUTE format('ALTER POLICY %I ON public.%I USING(public.v7_worker_global_without_context() OR (%s))',p.polname,t.relname,p.q); END IF;
    IF p.c IS NOT NULL THEN EXECUTE format('ALTER POLICY %I ON public.%I WITH CHECK(public.v7_worker_global_without_context() OR (%s))',p.polname,t.relname,p.c); END IF;
   END LOOP;
  END IF;
 END LOOP;
 -- Postconditions of the model.
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p')
   AND (c.relname='profiles' OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped AND a.attnum>0))
   AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR NOT EXISTS(SELECT 1 FROM pg_policy x WHERE x.polrelid=c.oid AND x.polname='v7_api_profile_guard' AND NOT x.polpermissive)))
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname ~ '^commerce_' AND (rolbypassrls OR rolsuper))
  OR pg_has_role('commerce_api','commerce_worker_global','MEMBER') THEN
  RAISE EXCEPTION 'V7_ISOLATION_MODEL_INCOMPLETE';
 END IF;
END $isolation$;

-- Scope-binding triggers of the historical tables follow the same boundary: a
-- worker transaction without context derives the scope from the exact parent
-- record, as before V7; any transaction with context must match it exactly.
DO $bind$
DECLARE definition text; patched text;
BEGIN
 -- Each replacement must hit the reviewed source exactly once.
 CREATE TEMP TABLE v7_bind_patches(fn text,old text,new text) ON COMMIT DROP;
 INSERT INTO pg_temp.v7_bind_patches VALUES
 ('public.bind_profile_child_scope()',
  'OR current_setting(''app.workspace_id'',true) IS DISTINCT FROM scope.workspace_id OR current_setting(''app.environment'',true) IS DISTINCT FROM scope.environment THEN',
  'OR (NOT public.v7_worker_global_without_context() AND (current_setting(''app.workspace_id'',true) IS DISTINCT FROM scope.workspace_id OR current_setting(''app.environment'',true) IS DISTINCT FROM scope.environment)) THEN'),
 ('public.bind_profile_ownership_scope()',
  'OR current_setting(''app.workspace_id'',true) IS DISTINCT FROM parent.workspace_id OR current_setting(''app.environment'',true) IS DISTINCT FROM parent.environment THEN',
  'OR (NOT public.v7_worker_global_without_context() AND (current_setting(''app.workspace_id'',true) IS DISTINCT FROM parent.workspace_id OR current_setting(''app.environment'',true) IS DISTINCT FROM parent.environment)) THEN'),
 ('public.bind_profile_manual_control()',
  'DECLARE env text:=NULLIF(current_setting(''app.environment'',true),'''');parent_environment text;',
  'DECLARE worker_global boolean:=public.v7_worker_global_without_context();env text:=NULLIF(current_setting(''app.environment'',true),'''');parent_environment text;'),
 ('public.bind_profile_manual_control()',
  'IF TG_OP=''DELETE'' THEN'||chr(10)||'   IF current_setting(',
  'IF TG_OP=''DELETE'' THEN'||chr(10)||'   IF worker_global THEN RETURN OLD; END IF;'||chr(10)||'   IF current_setting('),
 ('public.bind_profile_manual_control()',
  '  IF current_setting(''app.workspace_id'',true) IS DISTINCT FROM NEW.workspace_id OR (env IN(''REAL'',''SIMULATION'')) IS NOT TRUE THEN RAISE EXCEPTION ''PROFILE_CONTROL_CONTEXT_REQUIRED'';END IF;',
  '  IF worker_global THEN'||chr(10)||
  '   IF TG_OP=''UPDATE'' AND (NEW.workspace_id,NEW.scope_type,NEW.scope_id,NEW.environment) IS DISTINCT FROM(OLD.workspace_id,OLD.scope_type,OLD.scope_id,OLD.environment) THEN RAISE EXCEPTION ''PROFILE_CONTROL_IDENTITY_IMMUTABLE'';END IF;'||chr(10)||
  '   IF NEW.scope_type=''workspace'' THEN'||chr(10)||
  '    IF NEW.scope_id IS DISTINCT FROM NEW.workspace_id OR NEW.environment IS NOT NULL THEN RAISE EXCEPTION ''PROFILE_CONTROL_GLOBAL_SCOPE_INVALID'';END IF;'||chr(10)||
  '    RETURN NEW;'||chr(10)||
  '   END IF;'||chr(10)||
  '   SELECT r.environment INTO parent_environment FROM public.records r WHERE r.id::text=NEW.scope_id AND r.workspace_id=NEW.workspace_id AND r.kind=NEW.scope_type FOR SHARE;'||chr(10)||
  '   IF NOT FOUND OR (NEW.environment IS NOT NULL AND NEW.environment IS DISTINCT FROM parent_environment) THEN RAISE EXCEPTION ''PROFILE_CONTROL_PARENT_REQUIRED'';END IF;'||chr(10)||
  '   NEW.environment:=parent_environment;RETURN NEW;'||chr(10)||
  '  END IF;'||chr(10)||
  '  IF current_setting(''app.workspace_id'',true) IS DISTINCT FROM NEW.workspace_id OR (env IN(''REAL'',''SIMULATION'')) IS NOT TRUE THEN RAISE EXCEPTION ''PROFILE_CONTROL_CONTEXT_REQUIRED'';END IF;');
 FOR definition IN SELECT DISTINCT fn FROM pg_temp.v7_bind_patches ORDER BY 1 LOOP
  SELECT pg_get_functiondef(definition::regprocedure) INTO patched;
  DECLARE patch record; BEGIN
   FOR patch IN SELECT * FROM pg_temp.v7_bind_patches WHERE fn=definition LOOP
    IF (length(patched)-length(replace(patched,patch.old,'')))<>length(patch.old) THEN RAISE EXCEPTION 'V7_SCOPE_BINDING_DEFINITION_DRIFT: %',definition; END IF;
    patched:=replace(patched,patch.old,patch.new);
   END LOOP;
  END;
  EXECUTE patched;
 END LOOP;
 DROP TABLE pg_temp.v7_bind_patches;
END $bind$;
