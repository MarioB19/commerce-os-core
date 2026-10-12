-- Preserve global quota counts under FORCE RLS without exposing them to runtime.
DO $quota_authority$
DECLARE spec record; fn oid; migration_owner text:=current_user; relation text; predicate text;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED';END IF;
 LOCK TABLE public.profiles,public.profile_quota_policy,public.profile_quota_load_admissions,public.profile_quota_coverage,public.profile_quota_entries,public.records,public.manual_controls,public.session_ownership,public.commands,public.outbox IN ACCESS EXCLUSIVE MODE;
 FOR spec IN SELECT * FROM (VALUES
  ('public.profile_quota_allocation_guard()','91abb326282cb1e693fbbba372527e533bfb6b07f742bd21149d1c729975aeb7',true),
  ('public.profile_quota_inventory(text)','1d7f200cb4ef24bcd547be74ca995097717351e416c6677ef204d4df4e89af67',true),
  ('public.adopt_profile_quota_inventory(text,text)','7d7541f28f76ecfec88df065dc9eed4997d98d2bb279d637f682aab73f9fc058',true),
  ('public.profile_quota_record_guard()','03eae69aae6de5b92cd79e8eb0795c71482b562440494251ce37ec1690bba4bd',true),
  ('public.profile_quota_day(timestamptz,text)','b8dc2b7785fc72dbe4d22a7b26c344df28ce0f53650a4d42fd98e2468c6c9097',false),
  ('public.profile_quota_lock()','2df015e3f24550d671c097c3d675444150f3e39b48b34b3cc99cf7bcac35d09d',false)
 ) v(identity,sha,definer) LOOP
  fn:=to_regprocedure(spec.identity);
  IF fn IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=fn AND p.prosecdef=spec.definer AND p.proowner=current_user::regrole AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
   AND encode(sha256(convert_to(CASE WHEN spec.definer THEN pg_get_functiondef(fn) ELSE p.prosrc END,'UTF8')),'hex')=spec.sha) THEN RAISE EXCEPTION 'PROFILE_QUOTA_DEFINITION_DRIFT';END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=fn AND(a.grantee<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)) THEN RAISE EXCEPTION 'PROFILE_QUOTA_ACL_DRIFT';END IF;
 END LOOP;
 CREATE ROLE commerce_quota_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
 GRANT USAGE ON SCHEMA public TO commerce_quota_owner;
 GRANT SELECT,UPDATE(id) ON public.profiles TO commerce_quota_owner;
 GRANT SELECT,UPDATE(singleton) ON public.profile_quota_policy TO commerce_quota_owner;
 GRANT SELECT ON public.profile_quota_load_admissions TO commerce_quota_owner;
 GRANT SELECT,INSERT ON public.profile_quota_coverage,public.profile_quota_entries TO commerce_quota_owner;
 GRANT UPDATE(retired_at) ON public.profile_quota_entries TO commerce_quota_owner;
 GRANT SELECT(id,workspace_id,environment,kind,version,created_at,body),UPDATE(id) ON public.records TO commerce_quota_owner;
 GRANT SELECT(workspace_id,scope_type,scope_id,paused),UPDATE(scope_id) ON public.manual_controls TO commerce_quota_owner;
 GRANT SELECT,UPDATE(account_id) ON public.session_ownership TO commerce_quota_owner;
 GRANT SELECT(workspace_id,environment,resource_id,kind,status) ON public.commands TO commerce_quota_owner;
 GRANT SELECT(workspace_id,environment,account_id,status) ON public.outbox TO commerce_quota_owner;
 GRANT EXECUTE ON FUNCTION public.profile_quota_day(timestamptz,text),public.profile_quota_lock() TO commerce_quota_owner;
 -- Small authority/consumption tables are global to this private owner. No
 -- caller inherits this role; the four pinned functions are its only entry.
 FOREACH relation IN ARRAY ARRAY['profiles','profile_quota_policy','profile_quota_load_admissions','profile_quota_coverage','profile_quota_entries'] LOOP
  EXECUTE format('CREATE POLICY quota_authority_global ON public.%I TO commerce_quota_owner USING(true) WITH CHECK(true)',relation);
  EXECUTE format('CREATE POLICY quota_authority_global_guard ON public.%I AS RESTRICTIVE TO commerce_quota_owner USING(true) WITH CHECK(true)',relation);
 END LOOP;
 FOREACH relation IN ARRAY ARRAY['profile_quota_policy','profile_quota_load_admissions','profile_quota_coverage','profile_quota_entries'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',relation);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY quota_migration_owner ON public.%I TO %I USING(true) WITH CHECK(true)',relation,migration_owner);
 END LOOP;
 FOREACH relation IN ARRAY ARRAY['records','manual_controls','session_ownership','commands','outbox'] LOOP
  predicate:='workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')';
  -- manual_controls and session_ownership can still be the original schemas;
  -- exact REAL record identity and pause predicates remain inside the functions.
  IF relation IN('records','commands','outbox') THEN predicate:=predicate||' AND environment=''REAL''';END IF;
  EXECUTE format('CREATE POLICY quota_authority_profile ON public.%I TO commerce_quota_owner USING(%s)',relation,predicate);
  EXECUTE format('CREATE POLICY quota_authority_profile_guard ON public.%I AS RESTRICTIVE TO commerce_quota_owner USING(%s)',relation,predicate);
 END LOOP;
 FOREACH relation IN ARRAY ARRAY['profile_quota_allocation_guard()','profile_quota_inventory(text)','adopt_profile_quota_inventory(text,text)','profile_quota_record_guard()'] LOOP
  EXECUTE 'ALTER FUNCTION public.'||relation||' OWNER TO commerce_quota_owner';
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO %I',relation,migration_owner);
 END LOOP;
END $quota_authority$;
