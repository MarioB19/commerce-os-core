-- Apply only after 019 and 021 control. REAL here is the key/budget domain;
-- every bound execution is independently SIMULATION/TEST. No credential copy.
CREATE TABLE commerce_number_lab.run_releases (
 workspace_id text NOT NULL,run_id uuid NOT NULL,variant_id uuid NOT NULL,release_id uuid NOT NULL,
 source_environment text NOT NULL DEFAULT 'REAL' CHECK(source_environment='REAL'),release_sha256 text NOT NULL CHECK(release_sha256 ~ '^[a-f0-9]{64}$'),
 quote jsonb NOT NULL CHECK(jsonb_typeof(quote)='object'),maximum_calls integer NOT NULL CHECK(maximum_calls BETWEEN 1 AND 960),
 PRIMARY KEY(workspace_id,run_id,variant_id),FOREIGN KEY(workspace_id,run_id) REFERENCES commerce_number_lab.runs(workspace_id,id),
 FOREIGN KEY(workspace_id,source_environment,release_id) REFERENCES public.market_releases(workspace_id,environment,id),
 FOREIGN KEY(workspace_id,source_environment,variant_id) REFERENCES public.market_variants(workspace_id,environment,id)
);
CREATE TABLE commerce_number_lab.ai_bindings (
 workspace_id text NOT NULL,budget_environment text NOT NULL DEFAULT 'REAL' CHECK(budget_environment='REAL'),
 credential_environment text NOT NULL DEFAULT 'REAL' CHECK(credential_environment='REAL'),execution_environment text NOT NULL DEFAULT 'SIMULATION' CHECK(execution_environment='SIMULATION'),operation_class text NOT NULL DEFAULT 'TEST' CHECK(operation_class='TEST'),
 attempt_id uuid NOT NULL,run_id uuid NOT NULL,operation_id uuid NOT NULL,variant_id uuid NOT NULL,release_id uuid NOT NULL,
 snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),grant_id uuid NOT NULL,
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),request_bytes integer NOT NULL CHECK(request_bytes BETWEEN 1 AND 8388608),capability text NOT NULL CHECK(capability IN('chat','vision','audio')),
 maximum_microusd bigint NOT NULL CHECK(maximum_microusd BETWEEN 1 AND 9007199254740991),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,budget_environment,attempt_id),FOREIGN KEY(workspace_id,run_id,operation_id) REFERENCES commerce_number_lab.operations(workspace_id,run_id,id),
 FOREIGN KEY(workspace_id,run_id,variant_id) REFERENCES commerce_number_lab.run_releases(workspace_id,run_id,variant_id),
 FOREIGN KEY(workspace_id,budget_environment,grant_id) REFERENCES public.ai_runtime_grants(workspace_id,environment,id)
);
ALTER TABLE public.ai_attempts ADD COLUMN lab_binding_id uuid;
ALTER TABLE public.ai_attempts ADD CONSTRAINT number_lab_attempt_binding FOREIGN KEY(workspace_id,environment,lab_binding_id) REFERENCES commerce_number_lab.ai_bindings(workspace_id,budget_environment,attempt_id);
GRANT SELECT ON public.market_releases,public.market_variants,public.ai_runtime_grants,public.ai_model_prices TO commerce_number_lab_owner;
GRANT EXECUTE ON FUNCTION public.ai_scope_lock(text,text) TO commerce_number_lab_owner;
CREATE FUNCTION commerce_number_lab.guard_release() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r commerce_number_lab.runs%ROWTYPE;m public.market_releases%ROWTYPE;p public.ai_model_prices%ROWTYPE;maximum numeric;
BEGIN
 PERFORM commerce_number_lab.lock_profile(NEW.workspace_id);
 SELECT * INTO r FROM commerce_number_lab.runs WHERE workspace_id=NEW.workspace_id AND id=NEW.run_id FOR UPDATE;
 SELECT * INTO m FROM public.market_releases WHERE workspace_id=NEW.workspace_id AND environment='REAL' AND id=NEW.release_id;
 IF r.id IS NULL OR r.state<>'READY' OR r.expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM commerce_number_lab.operations WHERE workspace_id=NEW.workspace_id AND run_id=NEW.run_id) OR m.id IS NULL OR m.variant_id<>NEW.variant_id OR m.sha256<>NEW.release_sha256 THEN RAISE EXCEPTION 'LAB_RELEASE_BINDING'; END IF;
 SELECT * INTO p FROM public.ai_model_prices WHERE (provider,model,model_revision,price_version)=(NEW.quote->>'provider',NEW.quote->>'model',NEW.quote->>'modelRevision',NEW.quote->>'priceVersion');
 IF p.provider IS NULL OR p.valid_until<=clock_timestamp() OR p.valid_from>clock_timestamp() THEN RAISE EXCEPTION 'LAB_PRICE_REQUIRED'; END IF;
 maximum:=ceil((p.input_ceiling::numeric*greatest(p.input_rate,p.cache_read_rate,p.cache_write_rate,p.audio_input_rate)+p.output_ceiling::numeric*p.output_rate)/1000000);
 IF NEW.quote IS DISTINCT FROM jsonb_build_object('profileId',NEW.workspace_id,'provider',p.provider,'model',p.model,'modelRevision',p.model_revision,'priceVersion',p.price_version,'maximumMicrousd',maximum,'currency','USD','maximumInputTokens',p.input_ceiling,'maximumOutputTokens',p.output_ceiling)
 OR NEW.maximum_calls+COALESCE((SELECT sum(maximum_calls) FROM commerce_number_lab.run_releases WHERE workspace_id=NEW.workspace_id AND run_id=NEW.run_id),0)>r.maximum_ai_calls
 OR NEW.maximum_calls*maximum+COALESCE((SELECT sum(maximum_calls::numeric*(quote->>'maximumMicrousd')::numeric) FROM commerce_number_lab.run_releases WHERE workspace_id=NEW.workspace_id AND run_id=NEW.run_id),0)>r.maximum_microusd THEN RAISE EXCEPTION 'LAB_ESTIMATE_BINDING'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION commerce_number_lab.guard_ai_binding() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r commerce_number_lab.runs%ROWTYPE;v commerce_number_lab.run_releases%ROWTYPE;g public.ai_runtime_grants%ROWTYPE;o commerce_number_lab.operations%ROWTYPE;
BEGIN
 -- Same serial budget lock as 019; lab reserves cannot race ordinary AI.
 PERFORM public.ai_scope_lock(NEW.workspace_id,'REAL');PERFORM commerce_number_lab.lock_profile(NEW.workspace_id);
 SELECT * INTO r FROM commerce_number_lab.runs WHERE workspace_id=NEW.workspace_id AND id=NEW.run_id FOR UPDATE;
 SELECT * INTO o FROM commerce_number_lab.operations WHERE workspace_id=NEW.workspace_id AND run_id=NEW.run_id AND id=NEW.operation_id;
 SELECT * INTO v FROM commerce_number_lab.run_releases WHERE workspace_id=NEW.workspace_id AND run_id=NEW.run_id AND variant_id=NEW.variant_id;
 SELECT * INTO g FROM public.ai_runtime_grants WHERE workspace_id=NEW.workspace_id AND environment='REAL' AND id=NEW.grant_id;
 IF r.id IS NULL OR r.state IN('COMPLETED','STOPPED') OR r.snapshot_sha256<>NEW.snapshot_sha256 OR o.id IS NULL OR o.state<>'INTENT' OR v.variant_id IS NULL OR v.release_id<>NEW.release_id OR g.id IS NULL OR g.is_test OR g.variant_id<>NEW.variant_id OR g.task<>'laboratory.'||NEW.capability
 OR g.revoked_at IS NOT NULL OR g.expires_at<=clock_timestamp() OR r.expires_at<=clock_timestamp()
 OR (g.provider,g.model,g.model_revision,g.price_version) IS DISTINCT FROM (v.quote->>'provider',v.quote->>'model',v.quote->>'modelRevision',v.quote->>'priceVersion') OR NEW.maximum_microusd<>(v.quote->>'maximumMicrousd')::numeric THEN RAISE EXCEPTION 'LAB_AI_AUTHORITY'; END IF;
 IF (SELECT count(*) FROM commerce_number_lab.ai_bindings WHERE workspace_id=NEW.workspace_id AND run_id=NEW.run_id)>=r.maximum_ai_calls OR (SELECT count(*) FROM commerce_number_lab.ai_bindings WHERE workspace_id=NEW.workspace_id AND run_id=NEW.run_id AND variant_id=NEW.variant_id)>=v.maximum_calls
 OR NEW.maximum_microusd+COALESCE((SELECT sum(maximum_microusd) FROM commerce_number_lab.ai_bindings WHERE workspace_id=NEW.workspace_id AND run_id=NEW.run_id),0)>r.maximum_microusd THEN RAISE EXCEPTION 'LAB_AI_LIMIT'; END IF;
 NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE FUNCTION commerce_number_lab.guard_bound_attempt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b commerce_number_lab.ai_bindings%ROWTYPE;r commerce_number_lab.runs%ROWTYPE;o commerce_number_lab.operations%ROWTYPE;
BEGIN
 IF NEW.task NOT LIKE 'laboratory.%' THEN IF NEW.lab_binding_id IS NOT NULL THEN RAISE EXCEPTION 'LAB_BINDING_FORBIDDEN'; END IF;RETURN NEW; END IF;
 SELECT * INTO b FROM commerce_number_lab.ai_bindings WHERE workspace_id=NEW.workspace_id AND budget_environment='REAL' AND attempt_id=NEW.attempt_id;
 IF b.attempt_id IS NULL OR NEW.environment<>'REAL' OR NEW.is_test OR NEW.conversation_id IS NOT NULL OR (NEW.variant_id,NEW.grant_id,NEW.request_sha256,NEW.request_bytes,NEW.capability,NEW.reserved_microusd,NEW.task)
 IS DISTINCT FROM (b.variant_id,b.grant_id,b.request_sha256,b.request_bytes,b.capability,b.maximum_microusd,'laboratory.'||b.capability) THEN RAISE EXCEPTION 'LAB_AI_BINDING_REQUIRED'; END IF;
 IF TG_OP='INSERT' THEN NEW.lab_binding_id:=b.attempt_id;ELSIF NEW.lab_binding_id IS DISTINCT FROM OLD.lab_binding_id THEN RAISE EXCEPTION 'LAB_BINDING_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' OR NEW.state='INTENT' THEN
  PERFORM public.ai_scope_lock(NEW.workspace_id,'REAL');PERFORM commerce_number_lab.lock_profile(NEW.workspace_id);
  SELECT * INTO o FROM commerce_number_lab.operations WHERE workspace_id=NEW.workspace_id AND run_id=b.run_id AND id=b.operation_id FOR SHARE;
  SELECT * INTO r FROM commerce_number_lab.runs WHERE workspace_id=NEW.workspace_id AND id=b.run_id FOR SHARE;
  IF r.id IS NULL OR r.state IN('COMPLETED','STOPPED') OR r.snapshot_sha256<>b.snapshot_sha256 OR o.id IS NULL OR o.state<>'INTENT' OR r.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'LAB_AI_RUN_CHANGED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER number_lab_release_guard BEFORE INSERT ON commerce_number_lab.run_releases FOR EACH ROW EXECUTE FUNCTION commerce_number_lab.guard_release();
CREATE TRIGGER number_lab_release_immutable BEFORE UPDATE OR DELETE ON commerce_number_lab.run_releases FOR EACH ROW EXECUTE FUNCTION public.immutable_row();
CREATE TRIGGER number_lab_ai_binding_guard BEFORE INSERT ON commerce_number_lab.ai_bindings FOR EACH ROW EXECUTE FUNCTION commerce_number_lab.guard_ai_binding();
CREATE TRIGGER number_lab_ai_binding_immutable BEFORE UPDATE OR DELETE ON commerce_number_lab.ai_bindings FOR EACH ROW EXECUTE FUNCTION public.immutable_row();
-- Name sorts before ai_attempt_guard, so 019 sees the final immutable identity.
CREATE TRIGGER aaa_number_lab_attempt_guard BEFORE INSERT OR UPDATE ON public.ai_attempts FOR EACH ROW EXECUTE FUNCTION commerce_number_lab.guard_bound_attempt();
DO $$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY['run_releases','ai_bindings'] LOOP
  EXECUTE format('ALTER TABLE commerce_number_lab.%I OWNER TO commerce_number_lab_owner',n);
  EXECUTE format('ALTER TABLE commerce_number_lab.%I ENABLE ROW LEVEL SECURITY',n);EXECUTE format('ALTER TABLE commerce_number_lab.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY profile_scope ON commerce_number_lab.%I USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')) WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),''''))',n);
 END LOOP;
 FOREACH n IN ARRAY ARRAY['guard_release()','guard_ai_binding()','guard_bound_attempt()'] LOOP
  EXECUTE 'ALTER FUNCTION commerce_number_lab.'||n||' OWNER TO commerce_number_lab_owner';EXECUTE 'REVOKE ALL ON FUNCTION commerce_number_lab.'||n||' FROM PUBLIC';
 END LOOP;
END $$;
GRANT SELECT,INSERT ON commerce_number_lab.run_releases TO commerce_api;
GRANT SELECT ON commerce_number_lab.run_releases TO commerce_number_lab,commerce_ai;
GRANT SELECT,INSERT ON commerce_number_lab.ai_bindings TO commerce_number_lab;
GRANT SELECT ON commerce_number_lab.ai_bindings TO commerce_api,commerce_ai;
GRANT USAGE ON SCHEMA commerce_number_lab TO commerce_ai;
-- Keep all 019 columns/types; only classification uses the immutable native
-- binding. Reservations and pre-settlement rows are TEST, never real business.
CREATE OR REPLACE VIEW public.result_ai_cost_facts WITH (security_invoker=true) AS
 SELECT a.workspace_id,a.environment,a.conversation_id,a.variant_id,a.attempt_id,a.provider,a.model,a.model_revision,a.price_version,a.task,
 CASE WHEN a.is_test OR a.lab_binding_id IS NOT NULL THEN 'TEST' ELSE 'OPERATION' END AS operation_class,
 COALESCE(a.settled_at,a.intent_at,a.created_at) AS occurred_at,a.created_at,a.intent_at,a.settled_at,a.state AS status,
 a.measured_cost_microusd,a.input_tokens,a.output_tokens,a.cache_read_tokens,a.cache_write_tokens,a.audio_input_tokens FROM public.ai_attempts a;
GRANT EXECUTE ON FUNCTION public.ai_scope_lock(text,text) TO commerce_number_lab;
