-- V7 F4 (RF-14.d, RF-13.d): the monthly AI budget configured by the owner keeps
-- covering the seller across month boundaries. The owner's limit is a standing
-- instruction; this function only opens the current month (from now) and, in
-- its last three days, the next one, with that same limit for every configured
-- key. It never changes a running period, never raises a limit and never opens
-- anything without a configured limit. Same rules as ensureBudgetPeriods.
CREATE FUNCTION open_ai_budget_periods(p_workspace text,p_environment text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE lim bigint; moment timestamptz:=clock_timestamp(); m integer; s timestamptz; e timestamptz; f timestamptz; pid uuid; opened integer:=0;
BEGIN
 IF p_environment NOT IN('REAL','SIMULATION') OR NULLIF(current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'AI_BUDGET_CONTEXT_REQUIRED'; END IF;
 SELECT monthly_limit_microusd INTO lim FROM public.ai_profile_preferences WHERE workspace_id=p_workspace AND environment=p_environment;
 IF lim IS NULL THEN RETURN 0; END IF;
 PERFORM public.ai_scope_lock(p_workspace,p_environment);
 FOR m IN 0..1 LOOP
  s:=date_trunc('month',moment AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'+make_interval(months=>m);
  e:=s+interval '1 month';
  IF m=1 AND e-interval '1 month'-moment>=interval '3 days' THEN CONTINUE; END IF;
  SELECT id INTO pid FROM public.ai_budget_periods WHERE workspace_id=p_workspace AND environment=p_environment AND starts_at<e AND ends_at>s ORDER BY starts_at LIMIT 1;
  IF pid IS NULL THEN
   f:=CASE WHEN m=0 THEN greatest(s,moment-interval '1 minute') ELSE s END;
   IF e-f<interval '1 day' THEN CONTINUE; END IF;
   pid:=gen_random_uuid();
   INSERT INTO public.ai_budget_periods(id,workspace_id,environment,starts_at,ends_at,profile_limit_microusd) VALUES(pid,p_workspace,p_environment,f,e,lim);
   opened:=opened+1;
  END IF;
  INSERT INTO public.ai_key_budgets(workspace_id,environment,period_id,credential_id,limit_microusd)
   SELECT p_workspace,p_environment,pid,k.id,(SELECT profile_limit_microusd FROM public.ai_budget_periods WHERE id=pid)
   FROM public.ai_credentials k WHERE k.workspace_id=p_workspace AND k.environment=p_environment ON CONFLICT DO NOTHING;
  pid:=NULL;
 END LOOP;
 RETURN opened;
END $$;
REVOKE ALL ON FUNCTION open_ai_budget_periods(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_ai_budget_periods(text,text) TO commerce_automation,commerce_api;
-- Profiles with a configured limit (identifiers only) for the hourly opener.
CREATE FUNCTION ai_budget_scopes() RETURNS TABLE(workspace_id text,environment text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p.workspace_id,p.environment FROM public.ai_profile_preferences p JOIN public.profiles f ON f.id=p.workspace_id
 WHERE p.monthly_limit_microusd IS NOT NULL AND f.state='ACTIVE' ORDER BY 1,2
$$;
REVOKE ALL ON FUNCTION ai_budget_scopes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_budget_scopes() TO commerce_automation;
