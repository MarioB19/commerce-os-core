-- V7 F2 cutover: row isolation model (docs/adr-v7-isolation-model.md).
-- * commerce_api: FORCE RLS on every table holding profile data, with a
--   RESTRICTIVE policy requiring app.workspace_id. Absent context denies.
-- * Workers (members of commerce_worker_global) keep their historical global
--   loops on historical tables only while no profile context is installed; a
--   transaction that installs app.workspace_id is held to that profile.
-- * Other reviewed V7 roles that hold privileges on a table that had no RLS
--   receive a context-bound policy; existing V7 policies are preserved.
-- No grant is added, no role gains BYPASSRLS and no row is read or changed.
-- The worker is the acting role or, inside a SECURITY DEFINER function or
-- trigger owned by a reviewed role, the connecting worker login.
CREATE FUNCTION public.v7_worker_global_without_context() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT NULLIF(current_setting('app.workspace_id',true),'') IS NULL
  AND NULLIF(current_setting('app.environment',true),'') IS NULL
  AND (pg_has_role(current_user,'commerce_worker_global','USAGE') OR pg_has_role(session_user,'commerce_worker_global','USAGE'))
$$;
REVOKE ALL ON FUNCTION public.v7_worker_global_without_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.v7_worker_global_without_context() TO PUBLIC;
-- Same predicate for SECURITY DEFINER guards, which receive the invoking role.
CREATE FUNCTION public.v7_worker_global_without_context(actor text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT NULLIF(current_setting('app.workspace_id',true),'') IS NULL
  AND NULLIF(current_setting('app.environment',true),'') IS NULL
  AND actor IS NOT NULL AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=actor)
  AND pg_has_role(actor,'commerce_worker_global','USAGE')
$$;
REVOKE ALL ON FUNCTION public.v7_worker_global_without_context(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.v7_worker_global_without_context(text) TO PUBLIC;
-- Trigger functions that are themselves SECURITY DEFINER see their owner as
-- current_user; the connecting login identifies the worker service instead.
CREATE FUNCTION public.v7_worker_session_without_context() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT public.v7_worker_global_without_context(session_user::text)
$$;
REVOKE ALL ON FUNCTION public.v7_worker_session_without_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.v7_worker_session_without_context() TO PUBLIC;

DO $isolation$
DECLARE t record; p record; r record; scope_column text; ctx text; worker text; was_enabled boolean; historical boolean; closed boolean;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED'; END IF;
 FOR t IN SELECT c.oid,c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN('r','p') AND (c.relname='profiles' OR EXISTS(SELECT 1 FROM pg_attribute a
   WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped AND a.attnum>0))
  ORDER BY c.relname LOOP
  EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE',t.relname);
  -- A table already closed to every role by a forced RESTRICTIVE false policy
  -- (retired creative custody, 020) stays exactly as reviewed: no policy is
  -- added or widened, so no worker or API path can reopen it.
  closed:=EXISTS(SELECT 1 FROM pg_policy x WHERE x.polrelid=t.oid AND NOT x.polpermissive AND x.polroles='{0}'::oid[]
   AND pg_get_expr(x.polqual,x.polrelid)='false' AND COALESCE(pg_get_expr(x.polwithcheck,x.polrelid),'false')='false');
  IF closed THEN
   IF NOT t.relrowsecurity OR NOT (SELECT relforcerowsecurity FROM pg_class WHERE oid=t.oid) THEN RAISE EXCEPTION 'V7_CLOSED_TABLE_NOT_FORCED: %',t.relname; END IF;
   CONTINUE;
  END IF;
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
  -- integration_secrets already had reviewed RLS before V7 (field visibility
  -- per runtime role, 0018): it keeps exactly its role policies.
  IF historical AND t.relname<>'integration_secrets' THEN
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
   AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR NOT EXISTS(SELECT 1 FROM pg_policy x WHERE x.polrelid=c.oid AND NOT x.polpermissive
    AND (x.polname='v7_api_profile_guard' OR (x.polroles='{0}'::oid[] AND pg_get_expr(x.polqual,x.polrelid)='false')))))
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
 -- Privacy minimization guards (033/038) fire on every records/record_versions
 -- write. A worker without context keeps writing its historical records; the
 -- resurrection checks below the context line still use the row's own scope.
 INSERT INTO pg_temp.v7_bind_patches VALUES
 ('public.privacy_record_transition(jsonb,jsonb,text,text,text)',
  ' IF COALESCE(prior,next_image)->>''workspace_id'' IS DISTINCT FROM NULLIF(current_setting(''app.workspace_id'',true),'''') OR COALESCE(prior,next_image)->>''environment'' IS DISTINCT FROM current_setting(''app.environment'',true) THEN RAISE EXCEPTION ''PRIVACY_RECORD_CONTEXT_REQUIRED'';END IF;',
  ' IF NOT public.v7_worker_global_without_context(actor) AND (COALESCE(prior,next_image)->>''workspace_id'' IS DISTINCT FROM NULLIF(current_setting(''app.workspace_id'',true),'''') OR COALESCE(prior,next_image)->>''environment'' IS DISTINCT FROM current_setting(''app.environment'',true)) THEN RAISE EXCEPTION ''PRIVACY_RECORD_CONTEXT_REQUIRED'';END IF;'),
 ('public.privacy_asset_transition(jsonb,jsonb,text,text,text)',
  ' IF COALESCE(prior,next_image)->>''workspace_id'' IS DISTINCT FROM NULLIF(current_setting(''app.workspace_id'',true),'''') OR COALESCE(prior,next_image)->>''environment'' IS DISTINCT FROM current_setting(''app.environment'',true) THEN RAISE EXCEPTION ''PRIVACY_ASSET_CONTEXT_REQUIRED'';END IF;',
  ' IF NOT public.v7_worker_global_without_context(actor) AND (COALESCE(prior,next_image)->>''workspace_id'' IS DISTINCT FROM NULLIF(current_setting(''app.workspace_id'',true),'''') OR COALESCE(prior,next_image)->>''environment'' IS DISTINCT FROM current_setting(''app.environment'',true)) THEN RAISE EXCEPTION ''PRIVACY_ASSET_CONTEXT_REQUIRED'';END IF;');
 -- Quota guard (014): a worker without context admits a REAL product, number or
 -- conversation into the profile of the explicit new record; every profile and
 -- platform limit below still applies. The API always needs its context.
 INSERT INTO pg_temp.v7_bind_patches VALUES
 ('public.profile_quota_record_guard()',
  ' IF current_setting(''app.workspace_id'',true) IS DISTINCT FROM NEW.workspace_id THEN RAISE EXCEPTION ''PROFILE_QUOTA_CONTEXT_REQUIRED''; END IF;',
  ' IF NOT public.v7_worker_session_without_context() AND current_setting(''app.workspace_id'',true) IS DISTINCT FROM NEW.workspace_id THEN RAISE EXCEPTION ''PROFILE_QUOTA_CONTEXT_REQUIRED''; END IF;');
 -- Privileged readers (020): a worker without context reads the authorization
 -- or isolation receipt of the explicit effect/account record it processes;
 -- with any context, the exact workspace/environment is still required.
 INSERT INTO pg_temp.v7_bind_patches VALUES
 -- An effect or pool without a temporal authorization has none to read
 -- (historical contract): no row, never a context error.
 ('public.read_locked_operation_authorization(uuid,text,text)',
  ' IF authorization_id IS NULL OR workspace IS NULL',
  ' IF authorization_id IS NULL THEN RETURN; END IF;'||chr(10)||'  IF workspace IS NULL'),
 ('public.read_locked_operation_authorization(uuid,text,text)',
  '   OR current_setting(''app.workspace_id'',true) IS DISTINCT FROM workspace OR current_setting(''app.environment'',true) IS DISTINCT FROM env THEN RAISE EXCEPTION ''PROFILE_READER_CONTEXT_REQUIRED'';',
  '   OR (NOT public.v7_worker_session_without_context() AND (current_setting(''app.workspace_id'',true) IS DISTINCT FROM workspace OR current_setting(''app.environment'',true) IS DISTINCT FROM env)) THEN RAISE EXCEPTION ''PROFILE_READER_CONTEXT_REQUIRED'';'),
 ('public.read_copy_source_isolation_receipt(uuid,text,text,integer,uuid)',
  '   OR current_setting(''app.workspace_id'',true) IS DISTINCT FROM p_workspace_id OR current_setting(''app.environment'',true) IS DISTINCT FROM ''REAL'' THEN RAISE EXCEPTION ''PROFILE_READER_CONTEXT_REQUIRED'';',
  '   OR (NOT public.v7_worker_session_without_context() AND (current_setting(''app.workspace_id'',true) IS DISTINCT FROM p_workspace_id OR current_setting(''app.environment'',true) IS DISTINCT FROM ''REAL'')) THEN RAISE EXCEPTION ''PROFILE_READER_CONTEXT_REQUIRED'';');
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

-- The reader roles' own policies (020) follow the same transitional rule: the
-- definer reads for a worker session without context, only the exact row the
-- function's arguments name; any installed context is still enforced.
DO $readers$
DECLARE p record;
BEGIN
 FOR p IN SELECT c.relname,pol.polname,pg_get_expr(pol.polqual,pol.polrelid) qual FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND pol.polname IN('authorization_reader_scope','authorization_reader_scope_guard',
  'isolation_reader_scope','isolation_reader_scope_guard','isolation_reader_membership','isolation_reader_membership_guard') ORDER BY 1,2 LOOP
  EXECUTE format('ALTER POLICY %I ON public.%I USING (public.v7_worker_session_without_context() OR (%s))',p.polname,p.relname,p.qual);
 END LOOP;
 IF (SELECT count(*) FROM pg_policy WHERE polname IN('authorization_reader_scope','authorization_reader_scope_guard','isolation_reader_scope','isolation_reader_scope_guard',
  'isolation_reader_membership','isolation_reader_membership_guard') AND pg_get_expr(polqual,polrelid) LIKE '%v7_worker_session_without_context()%')<>12 THEN
  RAISE EXCEPTION 'V7_READER_POLICY_DRIFT';
 END IF;
END $readers$;
