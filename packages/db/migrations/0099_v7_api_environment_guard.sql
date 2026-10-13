-- V7 F2 (ADR-V7-02, docs/adr-v7-isolation-model.md hardening 2): once a request
-- has bound its environment, the API role sees and writes only that environment
-- in every profile table that carries one. Narrowing only: a RESTRICTIVE policy
-- next to v7_api_profile_guard. Before the environment is parsed (no
-- app.environment) the profile guard alone applies, as before; a nullable
-- environment (shared stop rows such as manual_controls) stays visible to both.
DO $api_environment$
DECLARE t record; guard text;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED'; END IF;
 guard:='(NULLIF(current_setting(''app.environment'',true),'''') IS NULL OR environment IS NULL OR environment=current_setting(''app.environment'',true))';
 FOR t IN SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN('r','p')
   AND EXISTS(SELECT 1 FROM pg_policy x WHERE x.polrelid=c.oid AND x.polname='v7_api_profile_guard')
   AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='environment' AND NOT a.attisdropped AND a.attnum>0 AND a.atttypid='pg_catalog.text'::regtype)
  ORDER BY c.relname LOOP
  EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE',t.relname);
  EXECUTE format('CREATE POLICY v7_api_environment_guard ON public.%I AS RESTRICTIVE TO commerce_api USING(%s) WITH CHECK(%s)',t.relname,guard,guard);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polname='v7_api_environment_guard' AND polrelid='public.records'::regclass) THEN RAISE EXCEPTION 'V7_API_ENVIRONMENT_GUARD_INCOMPLETE'; END IF;
END $api_environment$;
