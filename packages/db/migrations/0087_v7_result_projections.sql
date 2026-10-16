-- V7 F2 cutover: Result projections and source reader (022).
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> promoted from packages/db/profile-transition/022_result_projections.sql (source sha256 73cebd5d8e56272fd900149a80fa7ad5405051d2b47b3480cf9bf383ba85740a)
-- V7 F2: 1 role-existence refusal(s) and 1 CREATE ROLE replaced by v7_ensure_reviewed_role (adopts only the exact reviewed safe attributes).
-- Anonymous metrics and restricted source deduplication. Not an executable
-- retention policy: no conversation/content is erased by this transition.
DO $$ BEGIN

 PERFORM public.v7_ensure_reviewed_role('commerce_results',false);
END $$;
GRANT USAGE ON SCHEMA public TO commerce_results;
CREATE FUNCTION result_counters_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE names text[]:=ARRAY['started','responded','offered','collection_sent','receipt_received','payment_approved','revenue_minor','sales','attributed_revenue_minor','attributed_sales','response_ms_sum','response_samples','sale_ms_sum','sale_samples','ai_cost_microusd','ai_cost_unknown_attempts','ai_input_tokens','ai_output_tokens','ai_cache_read_tokens','ai_cache_write_tokens','ai_audio_input_tokens','ai_tokens_unknown_attempts']; k text;
BEGIN
 IF v IS NULL OR jsonb_typeof(v)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(v))<>cardinality(names) THEN RETURN false;END IF;
 FOREACH k IN ARRAY names LOOP
  IF NOT(v ? k) OR jsonb_typeof(v->k)<>'string' OR v->>k !~ '^(0|[1-9][0-9]{0,29})$' THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;
CREATE FUNCTION result_grain_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE k text; dimensions jsonb; d date;
BEGIN
 IF v IS NULL OR jsonb_typeof(v)<>'object' OR NOT(v ?& ARRAY['day','currency','timezone','dimensions']) OR
  (SELECT count(*) FROM jsonb_object_keys(v))<>(CASE WHEN v ? 'ai_unattributed' THEN 5 ELSE 4 END) OR
  (v ? 'ai_unattributed' AND v->'ai_unattributed'<>'true'::jsonb) THEN RETURN false;END IF;
 IF jsonb_typeof(v->'day')<>'string' OR v->>'day' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR
  jsonb_typeof(v->'currency')<>'string' OR v->>'currency' !~ '^[A-Z]{3}$' OR
  jsonb_typeof(v->'timezone')<>'string' OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=v->>'timezone') THEN RETURN false;END IF;
 d:=(v->>'day')::date;IF NOT isfinite(d) OR d::text<>v->>'day' THEN RETURN false;END IF;
 dimensions:=v->'dimensions';
 IF jsonb_typeof(dimensions)<>'object' OR NOT(dimensions ?& ARRAY['family_id','variant_id','market','account_id','campaign_id','ad_id','touch']) OR
  (SELECT count(*) FROM jsonb_object_keys(dimensions))<>7 THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['family_id','variant_id','account_id'] LOOP
  IF jsonb_typeof(dimensions->k)<>'null' AND (jsonb_typeof(dimensions->k)<>'string' OR
    dimensions->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') THEN RETURN false;END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['campaign_id','ad_id'] LOOP
  IF jsonb_typeof(dimensions->k)<>'null' AND (jsonb_typeof(dimensions->k)<>'string' OR dimensions->>k !~ '^[0-9]+$') THEN RETURN false;END IF;
 END LOOP;
 IF jsonb_typeof(dimensions->'market')<>'null' AND (jsonb_typeof(dimensions->'market')<>'string' OR length(dimensions->>'market')>160) THEN RETURN false;END IF;
 IF jsonb_typeof(dimensions->'touch')<>'string' OR dimensions->>'touch' NOT IN('FIRST_CONTACT','REMARKETING','UNKNOWN') THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION result_facts_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE f jsonb;
BEGIN
 IF v IS NULL OR jsonb_typeof(v)<>'array' OR jsonb_array_length(v)>1000 THEN RETURN false;END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(v) LOOP
  IF jsonb_typeof(f)<>'object' OR NOT(f ?& ARRAY['grain','counters']) OR (SELECT count(*) FROM jsonb_object_keys(f))<>2 OR
   NOT public.result_grain_valid(f->'grain') OR NOT public.result_counters_valid(f->'counters') THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION result_counters_valid(jsonb),result_grain_valid(jsonb),result_facts_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION result_counters_valid(jsonb),result_grain_valid(jsonb),result_facts_valid(jsonb) TO commerce_results,commerce_api;
CREATE TABLE result_metric_daily(
 workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 grain_hash text NOT NULL CHECK(grain_hash ~ '^[a-f0-9]{64}$'),grain jsonb NOT NULL CHECK(result_grain_valid(grain)),
 counters jsonb NOT NULL CHECK(result_counters_valid(counters)),
 PRIMARY KEY(workspace_id,environment,grain_hash)
);
CREATE INDEX result_metric_daily_period ON result_metric_daily(workspace_id,environment,(grain->>'currency'),(grain->>'day'));
-- Sealed totals contain the same anonymous shape, never a source/client ID.
CREATE TABLE result_metric_sealed(LIKE result_metric_daily INCLUDING ALL);
ALTER TABLE result_metric_sealed ADD FOREIGN KEY(workspace_id) REFERENCES profiles(id);
CREATE TABLE result_projection_sources(
 workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 kind text NOT NULL CHECK(kind IN('COHORT','FINANCIAL','AI')),source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 revision bigint NOT NULL CHECK(revision>0),fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 facts jsonb, sealed_at timestamptz,
 PRIMARY KEY(workspace_id,environment,kind,source_digest),
 CHECK((sealed_at IS NULL AND facts IS NOT NULL AND result_facts_valid(facts)) OR (sealed_at IS NOT NULL AND facts IS NULL))
);
CREATE TABLE result_projection_state(
 workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
 phase text NOT NULL DEFAULT 'PENDING' CHECK(phase IN('PENDING','READY')),
 source_watermark timestamptz,completed_at timestamptz,source_count bigint CHECK(source_count>=0),
 PRIMARY KEY(workspace_id,environment),CHECK((source_watermark IS NULL)=(completed_at IS NULL)),
 CHECK(source_watermark<=completed_at)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['result_metric_daily','result_metric_sealed','result_projection_sources','result_projection_state'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY result_projection_scope ON %I USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'') WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'')',t);
  EXECUTE format('CREATE POLICY result_projection_scope_guard ON %I AS RESTRICTIVE USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'') WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'')',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,commerce_api,commerce_ingress,commerce_channel,commerce_automation',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO commerce_results',t);
 END LOOP;
END $$;
GRANT SELECT ON result_metric_daily,result_projection_state TO commerce_api;
CREATE POLICY result_ready_reader ON result_metric_daily AS RESTRICTIVE FOR SELECT TO commerce_api
 USING(EXISTS(SELECT 1 FROM result_projection_state s WHERE s.workspace_id=result_metric_daily.workspace_id
  AND s.environment=result_metric_daily.environment AND s.phase='READY'));
-- A committed partial worker batch can never retain the previous READY marker.
-- SQL triggers cover direct worker DML as well as the TypeScript port.
CREATE FUNCTION invalidate_result_projection() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE w text:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
BEGIN
 INSERT INTO public.result_projection_state(workspace_id,phase) VALUES(w,'PENDING')
  ON CONFLICT(workspace_id,environment) DO UPDATE SET phase='PENDING';
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION invalidate_result_projection() FROM PUBLIC;
CREATE TRIGGER result_daily_pending AFTER INSERT OR UPDATE OR DELETE ON result_metric_daily FOR EACH ROW EXECUTE FUNCTION invalidate_result_projection();
CREATE TRIGGER result_sealed_pending AFTER INSERT OR UPDATE OR DELETE ON result_metric_sealed FOR EACH ROW EXECUTE FUNCTION invalidate_result_projection();
CREATE TRIGGER result_source_pending AFTER INSERT OR UPDATE OR DELETE ON result_projection_sources FOR EACH ROW EXECUTE FUNCTION invalidate_result_projection();

-- Goals and their immutable command receipts have always been REAL-only.
-- Defaults preserve existing insert contracts, scoped FKs prevent future drift.
ALTER TABLE result_goals ADD CONSTRAINT result_goal_environment_identity UNIQUE(workspace_id,environment,id);
ALTER TABLE result_goal_events ADD COLUMN environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL');
ALTER TABLE result_goal_events ADD CONSTRAINT result_goal_event_environment FOREIGN KEY(workspace_id,environment,goal_id) REFERENCES result_goals(workspace_id,environment,id);
ALTER TABLE result_goal_operations ADD COLUMN environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL');
-- <<< end 022_result_projections.sql

-- >>> promoted from packages/db/profile-transition/components/022_result_source_reader.sql (source sha256 43cdc09a8baec88605788b63acfe7b2fb70ad14f0f140e4a8bad86b841e37bac)
-- V7 F2: 1 role-existence refusal(s) and 1 CREATE ROLE replaced by v7_ensure_reviewed_role (adopts only the exact reviewed safe attributes).
-- Requires 017,019,022. Historical transition017 remains byte-identical.
CREATE OR REPLACE VIEW result_journey_facts WITH(security_invoker=true,security_barrier=true) AS
 SELECT c.workspace_id,c.environment,c.id journey_id,COALESCE(s.body->'release'->'locale'->>'timezone',p.timezone) timezone,
  COALESCE(result_observed_at(c.body->>'started_at'),c.created_at) started_at,
  COALESCE(s.body->'release'->'locale'->>'currency',offer.body->>'currency',sale_order.body->>'currency') currency,
  COALESCE(s.body->'release'->>'family_id',c.body->>'product_id') family_id,
  s.body->'release'->>'variant_id' variant_id,s.body->'release'->'locale'->>'market' market,
  c.body->>'account_id' account_id,
  CASE WHEN attribution.n=1 THEN attribution.campaign_id END campaign_id,
  CASE WHEN attribution.n=1 THEN attribution.ad_id END ad_id,
  CASE WHEN c.body->'origin'->>'source'='remarketing' AND c.body->'origin'->>'evidence_ref' IS NOT NULL THEN 'REMARKETING'
   WHEN c.body->>'started_at' IS NOT NULL AND c.body->>'historical_only' IS DISTINCT FROM 'true' THEN 'FIRST_CONTACT' ELSE 'UNKNOWN' END touch,
  outgoing.first_response_at,
  (outgoing.offer_seen OR result_observed_at(sale_order.body->>'committed_at') IS NOT NULL) offered,
  outgoing.collection_sent,
  EXISTS(SELECT 1 FROM records r WHERE r.workspace_id=c.workspace_id AND r.environment=c.environment AND r.kind='receipt'
   AND r.body->>'conversation_id'=c.id::text AND COALESCE(r.body->>'commercial_classification','COMMERCIAL') NOT IN('FALSE','TEST')
   AND r.body->>'duplicate_of' IS NULL) receipt_received,
  paid.first_sale_at
 FROM records c JOIN profiles p ON p.id=c.workspace_id
 LEFT JOIN market_journey_snapshots s ON s.workspace_id=c.workspace_id AND s.environment=c.environment AND s.journey_id=c.id
 LEFT JOIN records offer ON offer.workspace_id=c.workspace_id AND offer.environment=c.environment AND offer.kind='offer' AND offer.id::text=c.body->>'offer_version_id'
 LEFT JOIN LATERAL(SELECT o.body FROM records o WHERE o.workspace_id=c.workspace_id AND o.environment=c.environment AND o.kind='order'
  AND o.body->>'conversation_id'=c.id::text ORDER BY o.created_at,o.id LIMIT 1) sale_order ON true
 LEFT JOIN LATERAL(SELECT count(*) n,min(m.campaign_id) campaign_id,min(m.ad_id) ad_id FROM meta_ad_metadata m
  WHERE m.workspace_id=c.workspace_id AND m.environment=c.environment
   AND m.ad_id=COALESCE(sale_order.body->'attribution'->>'ad_id',c.body->'origin'->>'ad_id')
   AND COALESCE(sale_order.body->'attribution'->>'classification',c.body->'origin'->>'classification') IN('observed','manual')
   AND (COALESCE(sale_order.body->'attribution'->>'meta_ad_account_id',c.body->'origin'->>'meta_ad_account_id') IS NULL
    OR m.meta_ad_account_id=COALESCE(sale_order.body->'attribution'->>'meta_ad_account_id',c.body->'origin'->>'meta_ad_account_id'))) attribution ON true
 LEFT JOIN LATERAL(SELECT min(result_observed_at(o.result->>'accepted_at')) first_response_at,
   COALESCE(bool_or(o.payload->>'purpose' IN('offer','agreement') OR o.payload->>'workflow_recipe_step' IN('3','5')),false) offer_seen,
   COALESCE(bool_or(o.payload->>'purpose'='collection'),false) collection_sent
  FROM outbox o WHERE o.workspace_id=c.workspace_id AND o.environment=c.environment AND o.conversation_id=c.id::text
   AND o.kind<>'warmup' AND o.payload->>'kind' IS DISTINCT FROM 'grant' AND o.status IN('SENT','DELIVERED','READ')
   AND o.provider_message_id IS NOT NULL AND result_observed_at(o.result->>'accepted_at')>=COALESCE(result_observed_at(c.body->>'started_at'),c.created_at)) outgoing ON true
 LEFT JOIN LATERAL(SELECT min(pc.effective_at) first_sale_at FROM payment_contributions pc
  JOIN records o ON o.id=pc.order_id AND o.workspace_id=pc.workspace_id AND o.environment=pc.environment AND o.kind='order'
  JOIN records r ON r.id=pc.receipt_id AND r.workspace_id=pc.workspace_id AND r.environment=pc.environment AND r.kind='receipt'
  WHERE pc.workspace_id=c.workspace_id AND pc.environment=c.environment AND o.body->>'conversation_id'=c.id::text
   AND pc.currency=COALESCE(s.body->'release'->'locale'->>'currency',offer.body->>'currency',sale_order.body->>'currency')
   AND o.body->>'commercial_classification' IS DISTINCT FROM 'TEST' AND COALESCE(r.body->>'commercial_classification','COMMERCIAL') NOT IN('FALSE','TEST')
   AND r.body->>'duplicate_of' IS NULL AND r.body->>'status'='APPROVED') paid ON true
 WHERE c.workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND c.kind='conversation' AND c.environment='REAL' AND c.body->>'privacy_erased' IS DISTINCT FROM 'true' AND c.body->>'commercial_classification' IS DISTINCT FROM 'TEST'
  AND c.body->>'is_test' IS DISTINCT FROM 'true' AND NOT(c.body ? 'number_flow_test_id') AND NOT(c.body ? 'launch_test_id')
  AND NOT EXISTS(SELECT 1 FROM records o WHERE o.workspace_id=c.workspace_id AND o.environment=c.environment AND o.kind='order'
   AND o.body->>'conversation_id'=c.id::text AND o.body->>'commercial_classification'='TEST');
CREATE OR REPLACE VIEW result_payment_facts WITH(security_invoker=true,security_barrier=true) AS
 SELECT pc.workspace_id,pc.environment,pc.id contribution_id,pc.order_id,pc.amount_minor,pc.currency,pc.effective_at,min(pc.effective_at) OVER(PARTITION BY pc.workspace_id,pc.environment,pc.order_id) first_order_payment_at,
  j.journey_id,j.timezone,j.family_id,j.variant_id,j.market,j.account_id,j.campaign_id,j.ad_id,
  CASE WHEN EXISTS(SELECT 1 FROM outbox x WHERE x.workspace_id=pc.workspace_id AND x.environment=pc.environment
   AND x.conversation_id=j.journey_id::text AND x.payload->>'purpose'='remarketing' AND x.status IN('SENT','DELIVERED','READ')
   AND x.provider_message_id IS NOT NULL AND result_observed_at(x.result->>'accepted_at')<=pc.effective_at AND result_observed_at(x.result->>'accepted_at')>=pc.effective_at-interval '7 days') THEN 'REMARKETING' ELSE j.touch END touch
 FROM payment_contributions pc JOIN records o ON o.id=pc.order_id AND o.workspace_id=pc.workspace_id AND o.environment=pc.environment AND o.kind='order'
 JOIN records r ON r.id=pc.receipt_id AND r.workspace_id=pc.workspace_id AND r.environment=pc.environment AND r.kind='receipt'
 JOIN result_journey_facts j ON j.workspace_id=pc.workspace_id AND j.environment=pc.environment AND j.journey_id::text=o.body->>'conversation_id'
 WHERE pc.workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND pc.environment='REAL' AND o.body->>'commercial_classification' IS DISTINCT FROM 'TEST'
  AND COALESCE(r.body->>'commercial_classification','COMMERCIAL') NOT IN('FALSE','TEST') AND r.body->>'duplicate_of' IS NULL AND r.body->>'status'='APPROVED';

-- Only this closed reader can access the commercial source tables. The writer
-- retains no direct SELECT on records, messages, credentials or their content.
DO $$ BEGIN

 PERFORM public.v7_ensure_reviewed_role('commerce_results_reader',false);
END $$;
GRANT USAGE ON SCHEMA public TO commerce_results_reader;
GRANT SELECT ON records,profiles,market_journey_snapshots,outbox,meta_ad_metadata,payment_contributions,
 result_journey_facts,result_payment_facts,result_ai_cost_facts,ai_attempts,market_variants TO commerce_results_reader;
GRANT EXECUTE ON FUNCTION result_observed_at(text) TO commerce_results_reader;
CREATE FUNCTION read_result_source_page(source_kind text,after_id uuid,page_limit integer)
 RETURNS TABLE(source_id uuid,facts jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');
BEGIN
 IF w IS NULL OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' THEN RAISE EXCEPTION 'RESULT_SOURCE_SCOPE_REQUIRED';END IF;
 IF source_kind IS NULL OR source_kind NOT IN('COHORT','FINANCIAL','AI') OR page_limit IS NULL OR page_limit<1 OR page_limit>250 THEN RAISE EXCEPTION 'RESULT_SOURCE_PAGE_INVALID';END IF;
 IF source_kind='COHORT' THEN
  RETURN QUERY SELECT j.journey_id,jsonb_build_array(jsonb_build_object('grain',jsonb_build_object('day',(j.started_at AT TIME ZONE j.timezone)::date::text,'currency',j.currency,'timezone',j.timezone,'dimensions',jsonb_build_object('family_id',j.family_id,'variant_id',j.variant_id,'market',j.market,'account_id',j.account_id,'campaign_id',j.campaign_id,'ad_id',j.ad_id,'touch',j.touch)),'counters',jsonb_build_object('started','0','responded','0','offered','0','collection_sent','0','receipt_received','0','payment_approved','0','revenue_minor','0','sales','0','attributed_revenue_minor','0','attributed_sales','0','response_ms_sum','0','response_samples','0','sale_ms_sum','0','sale_samples','0','ai_cost_microusd','0','ai_cost_unknown_attempts','0','ai_input_tokens','0','ai_output_tokens','0','ai_cache_read_tokens','0','ai_cache_write_tokens','0','ai_audio_input_tokens','0','ai_tokens_unknown_attempts','0')||jsonb_build_object('started','1','responded',(j.first_response_at IS NOT NULL)::integer::text,'offered',j.offered::integer::text,'collection_sent',j.collection_sent::integer::text,'response_ms_sum',CASE WHEN j.first_response_at>=j.started_at THEN floor(extract(epoch FROM(j.first_response_at-j.started_at))*1000)::text ELSE '0' END,'response_samples',COALESCE((j.first_response_at>=j.started_at)::integer,0)::text))) FROM public.result_journey_facts j
   WHERE j.workspace_id=w AND j.environment='REAL' AND (after_id IS NULL OR j.journey_id>after_id) ORDER BY j.journey_id LIMIT page_limit;
 ELSIF source_kind='FINANCIAL' THEN
  RETURN QUERY SELECT j.journey_id,jsonb_build_array(jsonb_build_object('grain',jsonb_build_object('day',(j.started_at AT TIME ZONE j.timezone)::date::text,'currency',j.currency,'timezone',j.timezone,'dimensions',jsonb_build_object('family_id',j.family_id,'variant_id',j.variant_id,'market',j.market,'account_id',j.account_id,'campaign_id',j.campaign_id,'ad_id',j.ad_id,'touch',j.touch)),'counters',jsonb_build_object('started','0','responded','0','offered','0','collection_sent','0','receipt_received','0','payment_approved','0','revenue_minor','0','sales','0','attributed_revenue_minor','0','attributed_sales','0','response_ms_sum','0','response_samples','0','sale_ms_sum','0','sale_samples','0','ai_cost_microusd','0','ai_cost_unknown_attempts','0','ai_input_tokens','0','ai_output_tokens','0','ai_cache_read_tokens','0','ai_cache_write_tokens','0','ai_audio_input_tokens','0','ai_tokens_unknown_attempts','0')||jsonb_build_object('receipt_received',j.receipt_received::integer::text,'payment_approved',(j.first_sale_at IS NOT NULL)::integer::text,'sale_ms_sum',CASE WHEN j.first_sale_at>=j.started_at THEN floor(extract(epoch FROM(j.first_sale_at-j.started_at))*1000)::text ELSE '0' END,'sale_samples',COALESCE((j.first_sale_at>=j.started_at)::integer,0)::text)))||COALESCE(p.facts,'[]'::jsonb)
   FROM public.result_journey_facts j LEFT JOIN LATERAL(
    SELECT jsonb_agg(jsonb_build_object('grain',g.grain,'counters',jsonb_build_object('started','0','responded','0','offered','0','collection_sent','0','receipt_received','0','payment_approved','0','revenue_minor','0','sales','0','attributed_revenue_minor','0','attributed_sales','0','response_ms_sum','0','response_samples','0','sale_ms_sum','0','sale_samples','0','ai_cost_microusd','0','ai_cost_unknown_attempts','0','ai_input_tokens','0','ai_output_tokens','0','ai_cache_read_tokens','0','ai_cache_write_tokens','0','ai_audio_input_tokens','0','ai_tokens_unknown_attempts','0')||jsonb_build_object(
     'revenue_minor',g.revenue_minor,'sales',g.sales,'attributed_revenue_minor',g.attributed_revenue_minor,'attributed_sales',g.attributed_sales)) ORDER BY g.grain::text) facts
    FROM (SELECT jsonb_build_object('day',(p.effective_at AT TIME ZONE p.timezone)::date::text,'currency',p.currency,'timezone',p.timezone,'dimensions',jsonb_build_object('family_id',p.family_id,'variant_id',p.variant_id,'market',p.market,'account_id',p.account_id,'campaign_id',p.campaign_id,'ad_id',p.ad_id,'touch',p.touch)) grain,sum(p.amount_minor)::text revenue_minor,
      count(DISTINCT p.order_id) FILTER(WHERE p.effective_at=p.first_order_payment_at)::text sales,
      COALESCE(sum(p.amount_minor) FILTER(WHERE p.ad_id IS NOT NULL),0)::text attributed_revenue_minor,
      count(DISTINCT p.order_id) FILTER(WHERE p.ad_id IS NOT NULL AND p.effective_at=p.first_order_payment_at)::text attributed_sales
     FROM public.result_payment_facts p WHERE p.workspace_id=w AND p.environment='REAL' AND p.journey_id=j.journey_id GROUP BY 1) g
   ) p ON true WHERE j.workspace_id=w AND j.environment='REAL' AND (after_id IS NULL OR j.journey_id>after_id) ORDER BY j.journey_id LIMIT page_limit;
 ELSE
  RETURN QUERY SELECT a.attempt_id,jsonb_build_array(jsonb_build_object('grain',jsonb_build_object('day',(a.occurred_at AT TIME ZONE COALESCE(j.timezone,'UTC'))::date::text,'currency',COALESCE(j.currency,'USD'),'timezone',COALESCE(j.timezone,'UTC'),'dimensions',jsonb_build_object('family_id',COALESCE(j.family_id,v.family_id::text),'variant_id',a.variant_id::text,'market',j.market,'account_id',j.account_id,'campaign_id',j.campaign_id,'ad_id',j.ad_id,'touch',COALESCE(j.touch,'UNKNOWN')))||CASE WHEN j.journey_id IS NULL THEN jsonb_build_object('ai_unattributed',true) ELSE '{}'::jsonb END,'counters',jsonb_build_object('started','0','responded','0','offered','0','collection_sent','0','receipt_received','0','payment_approved','0','revenue_minor','0','sales','0','attributed_revenue_minor','0','attributed_sales','0','response_ms_sum','0','response_samples','0','sale_ms_sum','0','sale_samples','0','ai_cost_microusd','0','ai_cost_unknown_attempts','0','ai_input_tokens','0','ai_output_tokens','0','ai_cache_read_tokens','0','ai_cache_write_tokens','0','ai_audio_input_tokens','0','ai_tokens_unknown_attempts','0')||jsonb_build_object('ai_cost_microusd',COALESCE(a.measured_cost_microusd,0)::text,'ai_cost_unknown_attempts',(a.measured_cost_microusd IS NULL)::integer::text,'ai_input_tokens',COALESCE(a.input_tokens,0)::text,'ai_output_tokens',COALESCE(a.output_tokens,0)::text,'ai_cache_read_tokens',COALESCE(a.cache_read_tokens,0)::text,'ai_cache_write_tokens',COALESCE(a.cache_write_tokens,0)::text,'ai_audio_input_tokens',COALESCE(a.audio_input_tokens,0)::text,'ai_tokens_unknown_attempts',(a.input_tokens IS NULL OR a.output_tokens IS NULL OR a.cache_read_tokens IS NULL OR a.cache_write_tokens IS NULL OR a.audio_input_tokens IS NULL)::integer::text))) FROM public.result_ai_cost_facts a
   JOIN public.market_variants v ON v.workspace_id=a.workspace_id AND v.environment=a.environment AND v.id=a.variant_id
   LEFT JOIN public.result_journey_facts j ON j.workspace_id=a.workspace_id AND j.environment=a.environment AND j.journey_id=a.conversation_id
   WHERE a.workspace_id=w AND a.environment='REAL' AND a.operation_class='OPERATION' AND a.intent_at IS NOT NULL
    AND (after_id IS NULL OR a.attempt_id>after_id) ORDER BY a.attempt_id LIMIT page_limit;
 END IF;
END $$;
ALTER FUNCTION read_result_source_page(text,uuid,integer) OWNER TO commerce_results_reader;
REVOKE ALL ON FUNCTION read_result_source_page(text,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_result_source_page(text,uuid,integer) TO commerce_results;
-- <<< end components/022_result_source_reader.sql
