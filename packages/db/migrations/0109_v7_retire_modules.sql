-- V7 F8-E: retire the V5 Inteligencia, SearchAPI, R2 library, creative studio,
-- finished-asset intake, provider/integration diagnostics and sponsorship tables.
-- Their routes, loops and packages left the runtime in F8. A table with rows
-- is dropped only when its latest receipt from scripts/v7-retirement-export.ts
-- (a verified encrypted export, taken on the V5 schema before the V7
-- publication or on 0108) still matches: same row count and SHA-256 of the
-- ordered JSONB row texts over the columns that export saw (columns a later
-- migration added, such as derived scope columns, are left out). Otherwise the
-- whole migration aborts with RETIREMENT_EXPORT_REQUIRED:<table> and nothing
-- changes. Row security must never make a table look empty, so only the
-- installation superuser (or a role with BYPASSRLS) may run it. No CASCADE: an
-- unexpected dependency from a kept object also aborts. The receipts stay in
-- platform_retirement_ledger; the commerce_global_budget_reader role stays
-- (without grants). Object storage (R2) is not touched here.
DO $retire$
DECLARE
 retired text[]:=ARRAY[
  'intelligence_searches','intelligence_runs','intelligence_offers','intelligence_observations','intelligence_analyses',
  'intelligence_opportunities','intelligence_analysis_batches','intelligence_corpus_evaluations',
  'creative_artifacts','creative_assets','creative_attempts','creative_batch_versions','creative_batches','creative_budgets',
  'creative_conformities','creative_devices','creative_global_budgets','creative_jobs','creative_members','creative_pairings',
  'creative_playbook_receipts','creative_projects','creative_provider_operations','creative_quotes','creative_recipe_intakes',
  'creative_recipe_versions','creative_recipes','creative_reviews','creative_settings','creative_steps','creative_storage_usage',
  'creative_uploads','creative_voice_brief_versions','creative_voice_briefs','creative_voice_operations',
  'finished_asset_intakes','provider_diagnostics','integration_diagnostics','mcl_sponsorships'];
 t text; n bigint; digest text; receipt jsonb; seen text[]; present text[]; extra text[];
 settings text[][]:=ARRAY[['TimeZone','UTC'],['DateStyle','ISO, MDY'],['IntervalStyle','postgres'],['extra_float_digits','1'],['bytea_output','hex']];
 previous text[]:='{}'; i integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'RETIREMENT_OWNER_BYPASS_REQUIRED';
 END IF;
 -- The exporter renders rows under the same pinned output settings.
 FOR i IN 1..array_length(settings,1) LOOP
  previous:=previous||current_setting(settings[i][1]);
  PERFORM set_config(settings[i][1],settings[i][2],true);
 END LOOP;
 FOREACH t IN ARRAY retired LOOP
  IF to_regclass('public.'||t) IS NULL THEN RAISE EXCEPTION 'RETIREMENT_TABLE_MISSING:%',t; END IF;
  EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE',t);
  EXECUTE format('SELECT count(*)::bigint FROM public.%I',t) INTO n;
  CONTINUE WHEN n=0;
  SELECT l.snapshot INTO receipt FROM public.platform_retirement_ledger l WHERE l.workspace_id='@v7-retirement' AND l.kind='V7_RETIREMENT_EXPORT'
   AND l.disposition='EXPORTED_VERIFIED' AND l.snapshot->>'table'=t ORDER BY l.id DESC LIMIT 1;
  IF receipt IS NULL OR jsonb_typeof(receipt->'columns')<>'array' THEN RAISE EXCEPTION 'RETIREMENT_EXPORT_REQUIRED:%',t; END IF;
  seen:=ARRAY(SELECT jsonb_array_elements_text(receipt->'columns'));
  present:=ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=('public.'||t)::regclass AND a.attnum>0 AND NOT a.attisdropped);
  IF cardinality(seen)=0 OR NOT seen<@present THEN RAISE EXCEPTION 'RETIREMENT_EXPORT_REQUIRED:%',t; END IF;
  extra:=ARRAY(SELECT unnest(present) EXCEPT SELECT unnest(seen));
  EXECUTE format($q$SELECT count(*)::bigint,encode(sha256(convert_to(coalesce(string_agg(j,E'\n' ORDER BY j),''),'UTF8')),'hex') FROM (SELECT (to_jsonb(x)-$1)::text AS j FROM public.%I x) s$q$,t)
   INTO n,digest USING extra;
  IF n<>(receipt->>'row_count')::bigint OR digest IS DISTINCT FROM receipt->>'plaintext_sha256' THEN
   RAISE EXCEPTION 'RETIREMENT_EXPORT_REQUIRED:%',t;
  END IF;
 END LOOP;
 FOR i IN 1..array_length(settings,1) LOOP PERFORM set_config(settings[i][1],previous[i],true); END LOOP;
END
$retire$;

DROP TABLE intelligence_searches,intelligence_runs,intelligence_offers,intelligence_observations,intelligence_analyses,
 intelligence_opportunities,intelligence_analysis_batches,intelligence_corpus_evaluations,
 creative_artifacts,creative_assets,creative_attempts,creative_batch_versions,creative_batches,creative_budgets,
 creative_conformities,creative_devices,creative_global_budgets,creative_jobs,creative_members,creative_pairings,
 creative_playbook_receipts,creative_projects,creative_provider_operations,creative_quotes,creative_recipe_intakes,
 creative_recipe_versions,creative_recipes,creative_reviews,creative_settings,creative_steps,creative_storage_usage,
 creative_uploads,creative_voice_brief_versions,creative_voice_briefs,creative_voice_operations,
 finished_asset_intakes,provider_diagnostics,integration_diagnostics,mcl_sponsorships;

-- Functions whose only callers or triggers were the retired tables.
DROP FUNCTION creative_immutable_row();
DROP FUNCTION v5_block_new_sponsorship();
DROP FUNCTION v5_block_remote_production();
DROP FUNCTION read_profile_global_budget(text);
