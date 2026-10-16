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
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_results_reader') THEN RAISE EXCEPTION 'RESULT_READER_ROLE_ALREADY_EXISTS';END IF;
 CREATE ROLE commerce_results_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
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
