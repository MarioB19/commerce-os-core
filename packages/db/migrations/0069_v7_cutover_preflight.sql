-- V7 F2 cutover, step 1: preflight and reviewed role adoption helper.
-- Fails before any V7 schema change when the installation cannot be adopted
-- deterministically. Reads metadata and counts only; no row is changed.
DO $preflight$
DECLARE relation record; found text[]; workspaces text[]:=ARRAY[]::text[]; owners integer;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED';
 END IF;
 IF to_regclass('public.profiles') IS NOT NULL THEN RAISE EXCEPTION 'V7_PROFILES_ALREADY_PRESENT'; END IF;
 -- Every public table that carries workspace_id contributes its distinct values.
 FOR relation IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped AND a.attnum>0
  WHERE n.nspname='public' AND c.relkind IN('r','p') ORDER BY c.relname LOOP
  EXECUTE format('SELECT array_agg(DISTINCT workspace_id::text) FROM public.%I',relation.relname) INTO found;
  workspaces:=ARRAY(SELECT DISTINCT w FROM unnest(workspaces||COALESCE(found,ARRAY[]::text[])) w ORDER BY w);
 END LOOP;
 IF cardinality(workspaces)>3 THEN
  RAISE EXCEPTION 'V7_PROFILE_LIMIT_EXCEEDED: % workspaces hold data; the platform admits 3 profiles',cardinality(workspaces);
 END IF;
 IF EXISTS(SELECT 1 FROM unnest(workspaces) w WHERE w IS NULL OR length(w) NOT BETWEEN 1 AND 256) THEN
  RAISE EXCEPTION 'V7_WORKSPACE_IDENTITY_INVALID';
 END IF;
 SELECT count(DISTINCT workspace_id) INTO owners FROM public.memberships WHERE role='owner' AND active;
 IF owners>1 THEN RAISE EXCEPTION 'V7_PRINCIPAL_PROFILE_AMBIGUOUS: % workspaces have active owners',owners; END IF;
 IF (SELECT count(*) FROM public.records WHERE kind='channel_account' AND environment='REAL' AND NOT(body ? 'deleted_at'))>20 THEN
  RAISE EXCEPTION 'V7_PLATFORM_NUMBER_LIMIT_EXCEEDED';
 END IF;
END $preflight$;

-- The historical relation inventory fixes which tables keep the transitional
-- worker boundary in 0096; tables created by V7 keep their own V7 policies.
CREATE TABLE profile_cutover_historical_tables(name text PRIMARY KEY CHECK(length(name) BETWEEN 1 AND 63));
INSERT INTO profile_cutover_historical_tables(name)
 SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN('r','p') AND c.relname<>'profile_cutover_historical_tables';
CREATE TRIGGER immutable_profile_cutover_historical_tables BEFORE UPDATE OR DELETE ON profile_cutover_historical_tables FOR EACH ROW EXECUTE FUNCTION immutable_row();
REVOKE ALL ON profile_cutover_historical_tables FROM PUBLIC,commerce_api,commerce_ingress,commerce_automation,commerce_channel,commerce_maintenance;

-- Roles are cluster-wide. A reviewed V7 role may already exist from another
-- database of the same cluster (isolated test databases, a restored copy).
-- Adopt it only with the exact reviewed attributes, no membership in a
-- non-commerce or privileged role and no object, grant or policy in this
-- database; refuse anything else instead of inheriting it.
CREATE FUNCTION public.v7_ensure_reviewed_role(role_name text,inherit boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE existing record;
BEGIN
 IF role_name IS NULL OR role_name !~ '^commerce_[a-z_]+$' OR inherit IS NULL THEN RAISE EXCEPTION 'V7_ROLE_NAME_INVALID'; END IF;
 SELECT oid,rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolinherit,rolconnlimit,rolvaliduntil,rolconfig
  INTO existing FROM pg_roles WHERE rolname=role_name;
 IF NOT FOUND THEN
  EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION %s',
   role_name,CASE WHEN inherit THEN 'INHERIT' ELSE 'NOINHERIT' END);
  RETURN;
 END IF;
 IF existing.rolcanlogin OR existing.rolsuper OR existing.rolbypassrls OR existing.rolcreatedb OR existing.rolcreaterole
  OR existing.rolreplication OR existing.rolinherit IS DISTINCT FROM inherit OR existing.rolconnlimit<>-1
  OR existing.rolvaliduntil IS NOT NULL OR existing.rolconfig IS NOT NULL THEN
  RAISE EXCEPTION 'V7_ROLE_EXISTING_UNSAFE: %',role_name;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid WHERE m.member=existing.oid
  AND (g.rolsuper OR g.rolbypassrls OR g.rolcreaterole OR g.rolname !~ '^commerce_[a-z_]+$')) THEN
  RAISE EXCEPTION 'V7_ROLE_EXISTING_MEMBERSHIP_UNSAFE: %',role_name;
 END IF;
 -- A role that already owns, is granted or is named by a policy on anything in
 -- this database was not created by the reviewed transition: never inherit it.
 IF EXISTS(SELECT 1 FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass AND d.refobjid=existing.oid
  AND d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database())) THEN
  RAISE EXCEPTION 'V7_ROLE_EXISTING_PRIVILEGED: %',role_name;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.v7_ensure_reviewed_role(text,boolean) FROM PUBLIC;

-- Transitional worker boundary (ADR docs/adr-v7-isolation-model.md): members
-- keep their historical global loops under explicit role policies. The API
-- role is never a member.
SELECT public.v7_ensure_reviewed_role('commerce_worker_global',true);
GRANT commerce_worker_global TO commerce_ingress,commerce_automation,commerce_channel,commerce_maintenance;
DO $$BEGIN
 IF pg_has_role('commerce_api','commerce_worker_global','MEMBER') THEN RAISE EXCEPTION 'V7_API_WORKER_BOUNDARY_REQUIRED'; END IF;
END$$;
