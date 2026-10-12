-- Requires022. Anonymous exact duration frequencies, no customer identifiers.
CREATE FUNCTION result_latencies_valid(v jsonb,c jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE kind text;item record;n numeric;s numeric;expected_n numeric;expected_s numeric;
BEGIN
 IF v IS NULL OR jsonb_typeof(v)<>'object' OR NOT(v ?& ARRAY['response','sale']) OR (SELECT count(*) FROM jsonb_object_keys(v))<>2 OR NOT public.result_counters_valid(c) THEN RETURN false;END IF;
 FOREACH kind IN ARRAY ARRAY['response','sale'] LOOP
  IF jsonb_typeof(v->kind)<>'object' THEN RETURN false;END IF;n:=0;s:=0;
  FOR item IN SELECT key,value FROM jsonb_each(v->kind) LOOP
   IF item.key !~ '^(0|[1-9][0-9]{0,29})$' OR jsonb_typeof(item.value)<>'string' OR (item.value#>>'{}') !~ '^[1-9][0-9]{0,29}$' THEN RETURN false;END IF;
   n:=n+(item.value#>>'{}')::numeric;s:=s+item.key::numeric*(item.value#>>'{}')::numeric;
  END LOOP;
  expected_n:=(c->>(kind||'_samples'))::numeric;expected_s:=(c->>(kind||'_ms_sum'))::numeric;
  IF n>expected_n OR s>expected_s OR (n=expected_n AND s<>expected_s) THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;
REVOKE ALL ON FUNCTION result_latencies_valid(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION result_latencies_valid(jsonb,jsonb) TO commerce_results,commerce_api;
ALTER TABLE result_metric_daily ADD COLUMN latencies jsonb NOT NULL DEFAULT '{"response":{},"sale":{}}' CHECK(result_latencies_valid(latencies,counters));
ALTER TABLE result_metric_sealed ADD COLUMN latencies jsonb NOT NULL DEFAULT '{"response":{},"sale":{}}' CHECK(result_latencies_valid(latencies,counters));
CREATE OR REPLACE FUNCTION result_facts_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE f jsonb;
BEGIN
 IF v IS NULL OR jsonb_typeof(v)<>'array' OR jsonb_array_length(v)>1000 THEN RETURN false;END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(v) LOOP
  IF jsonb_typeof(f)<>'object' OR NOT(f ?& ARRAY['grain','counters']) OR (SELECT count(*) FROM jsonb_object_keys(f))<>(CASE WHEN f ? 'latencies' THEN 3 ELSE 2 END) OR
   NOT public.result_grain_valid(f->'grain') OR NOT public.result_counters_valid(f->'counters') OR NOT public.result_latencies_valid(COALESCE(f->'latencies','{"response":{},"sale":{}}'::jsonb),f->'counters') THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;
-- Existing rows remain incomplete until a full source recollection. Missing
-- sealed observations stay explicitly incomplete; no synthetic distribution.
UPDATE result_projection_state SET phase='PENDING';
