-- V7 F2 cutover: Global quota authority, global creative budget reader and retired creative custody (020).
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> promoted from packages/db/profile-transition/components/020_global_quota_authority.sql (source sha256 7ea96139ae2b71c24edadb7f6d95906eb4a4891df6d80ce8f79d7ccd4573ace7)
-- V7 F2: 0 role-existence refusal(s) and 1 CREATE ROLE replaced by v7_ensure_reviewed_role (adopts only the exact reviewed safe attributes).
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
 PERFORM public.v7_ensure_reviewed_role('commerce_quota_owner',false);
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
-- <<< end components/020_global_quota_authority.sql

-- >>> promoted from packages/db/profile-transition/components/020_global_creative_budget_reader.sql (source sha256 608386cc241752d69196b6b77d0530c28adc75967efb47f1f4686caef77d1b91)
-- V7 F2: 0 role-existence refusal(s) and 1 CREATE ROLE replaced by v7_ensure_reviewed_role (adopts only the exact reviewed safe attributes).
-- Fixed aggregate only. No provider call, accounting mutation or budget adoption.
DO $budget_owner$
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED'; END IF;
 LOCK TABLE public.creative_budgets,public.creative_global_budgets,public.creative_provider_operations,public.integration_diagnostics IN ACCESS EXCLUSIVE MODE;
 PERFORM public.v7_ensure_reviewed_role('commerce_global_budget_reader',false);
END
$budget_owner$;
GRANT USAGE ON SCHEMA public TO commerce_global_budget_reader;
GRANT SELECT(workspace_id,limit_usd,spent_usd,reserved_usd) ON creative_budgets TO commerce_global_budget_reader;
GRANT SELECT(workspace_id,limit_usd,version,expires_at,external_status,external_reserved_usd,external_expires_at) ON creative_global_budgets TO commerce_global_budget_reader;
GRANT SELECT(workspace_id,status,confirmed_cost) ON creative_provider_operations TO commerce_global_budget_reader;
GRANT SELECT(workspace_id,status,confirmed_cost_usd) ON integration_diagnostics TO commerce_global_budget_reader;
DO $budget_policies$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['creative_budgets','creative_global_budgets','creative_provider_operations','integration_diagnostics'] LOOP
  EXECUTE format($policy$CREATE POLICY global_budget_reader_scope ON public.%I TO commerce_global_budget_reader USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND current_setting('app.environment',true) IN('REAL','SIMULATION'))$policy$,relation);
  EXECUTE format($policy$CREATE POLICY global_budget_reader_guard ON public.%I AS RESTRICTIVE TO commerce_global_budget_reader USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND current_setting('app.environment',true) IN('REAL','SIMULATION'))$policy$,relation);
 END LOOP;
END
$budget_policies$;
CREATE FUNCTION read_profile_global_budget(workspace text)
RETURNS TABLE(configured boolean,limit_usd numeric,spent_usd numeric,reserved_usd numeric,external_reserved_usd numeric,unknown_cost_operations bigint,version integer,expires_at timestamptz,expired boolean,external_status text,external_expired boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF workspace IS NULL OR length(workspace) NOT BETWEEN 1 AND 256 OR current_setting('app.workspace_id',true) IS DISTINCT FROM workspace OR current_setting('app.environment',true) IS NULL OR current_setting('app.environment',true) NOT IN('REAL','SIMULATION') THEN RAISE EXCEPTION 'PROFILE_GLOBAL_BUDGET_SCOPE_REQUIRED'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('creative-provider:'||workspace,0));
 RETURN QUERY SELECT g.workspace_id IS NOT NULL,COALESCE(g.limit_usd,a.provider_limit),a.spent,a.reserved,COALESCE(g.external_reserved_usd,0),
  (SELECT count(*) FROM public.creative_provider_operations o WHERE o.workspace_id=workspace AND (o.status='UNKNOWN' OR o.status='CONFIRMED' AND o.confirmed_cost IS NULL))+
  (SELECT count(*) FROM public.integration_diagnostics d WHERE d.workspace_id=workspace AND (d.status='UNKNOWN' OR d.status='PARTIAL' AND d.confirmed_cost_usd IS NULL)),
  COALESCE(g.version,0),g.expires_at,COALESCE(g.expires_at<=clock_timestamp(),false),COALESCE(g.external_status,'NONE'),COALESCE(g.external_expires_at<=clock_timestamp(),false)
 FROM (SELECT COALESCE(sum(b.limit_usd),0) provider_limit,COALESCE(sum(b.spent_usd),0) spent,COALESCE(sum(b.reserved_usd),0) reserved FROM public.creative_budgets b WHERE b.workspace_id=workspace) a
 LEFT JOIN public.creative_global_budgets g ON g.workspace_id=workspace;
END $$;
ALTER FUNCTION read_profile_global_budget(text) OWNER TO commerce_global_budget_reader;
REVOKE ALL ON FUNCTION read_profile_global_budget(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_profile_global_budget(text) TO commerce_api,commerce_automation;
-- <<< end components/020_global_creative_budget_reader.sql

-- >>> promoted from packages/db/profile-transition/components/020_retired_creative_custody.sql (source sha256 781da99a4a547f75fdb93ceb508e665b43207f59949472d5bc8facece4a19b51)
-- Retired device credentials remain intact administrative history, never runtime authority.
DO $retired_creative$
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED';
 END IF;
 LOCK TABLE public.creative_devices,public.creative_pairings IN ACCESS EXCLUSIVE MODE;
 IF NOT EXISTS(SELECT 1 FROM public.schema_migrations WHERE name='0042_v5_platform_retirement.sql' AND sha256='91059aeb557c2627d2b09513f4015e863dd791e4b6ae242d6aad20f2ce91669f') THEN
  RAISE EXCEPTION 'PROFILE_CREATIVE_RETIREMENT_SOURCE_REQUIRED';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_policy WHERE polrelid IN('public.creative_devices'::regclass,'public.creative_pairings'::regclass))
 OR EXISTS(SELECT 1 FROM pg_class WHERE oid IN('public.creative_devices'::regclass,'public.creative_pairings'::regclass) AND (relrowsecurity OR relforcerowsecurity)) THEN
  RAISE EXCEPTION 'PROFILE_CREATIVE_CUSTODY_ALREADY_ALTERED';
 END IF;
 IF EXISTS(SELECT 1 FROM public.creative_devices WHERE status IS DISTINCT FROM 'REVOKED' OR revoked_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.creative_pairings WHERE status NOT IN('EXPIRED','CONSUMED')) THEN
  RAISE EXCEPTION 'PROFILE_CREATIVE_RETIREMENT_INCOMPLETE';
 END IF;
 ALTER TABLE public.creative_devices ENABLE ROW LEVEL SECURITY;
 ALTER TABLE public.creative_devices FORCE ROW LEVEL SECURITY;
 ALTER TABLE public.creative_pairings ENABLE ROW LEVEL SECURITY;
 ALTER TABLE public.creative_pairings FORCE ROW LEVEL SECURITY;
 -- A restrictive deny also survives an accidental later permissive policy.
 -- No runtime role receives a history/custodian bypass or credential projection.
 CREATE POLICY retired_creative_custody ON public.creative_devices AS RESTRICTIVE TO PUBLIC USING(false) WITH CHECK(false);
 CREATE POLICY retired_creative_custody ON public.creative_pairings AS RESTRICTIVE TO PUBLIC USING(false) WITH CHECK(false);
END
$retired_creative$;
-- <<< end components/020_retired_creative_custody.sql
