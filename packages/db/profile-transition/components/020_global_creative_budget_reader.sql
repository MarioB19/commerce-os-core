-- Fixed aggregate only. No provider call, accounting mutation or budget adoption.
DO $budget_owner$
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED'; END IF;
 LOCK TABLE public.creative_budgets,public.creative_global_budgets,public.creative_provider_operations,public.integration_diagnostics IN ACCESS EXCLUSIVE MODE;
 CREATE ROLE commerce_global_budget_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
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
