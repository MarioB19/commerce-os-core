-- V7 F2 cutover: Number laboratory and its application-database bridges (021).
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> promoted from packages/db/profile-transition/021_number_laboratory.sql (source sha256 7680c70b83411abc56a97ac66722068c3779381bfe5a41a1acb822651df31e24)
-- V7 F2: 1 role-existence refusal(s) and 2 CREATE ROLE replaced by v7_ensure_reviewed_role (adopts only the exact reviewed safe attributes).
-- RF19 control store. This does not provision the separate canonical engine DB.
-- Refuse existing roles: inherited/direct privileges cannot become lab authority.
DO $$ BEGIN

 PERFORM public.v7_ensure_reviewed_role('commerce_number_lab',true);
 PERFORM public.v7_ensure_reviewed_role('commerce_number_lab_owner',true);
END $$;
CREATE SCHEMA commerce_number_lab AUTHORIZATION commerce_number_lab_owner;
REVOKE ALL ON SCHEMA commerce_number_lab FROM PUBLIC;
GRANT USAGE ON SCHEMA commerce_number_lab TO commerce_api,commerce_number_lab;
GRANT USAGE ON SCHEMA public TO commerce_number_lab_owner;
GRANT SELECT,UPDATE(id) ON profiles TO commerce_number_lab_owner;
CREATE FUNCTION commerce_number_lab.valid_cipher(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT (jsonb_typeof(v)='object' AND v-ARRAY['version','iv','tag','ciphertext']='{}'::jsonb
 AND v->'version'='1'::jsonb AND jsonb_typeof(v->'iv')='string' AND v->>'iv' ~ '^[A-Za-z0-9+/]{16}$'
 AND jsonb_typeof(v->'tag')='string' AND v->>'tag' ~ '^[A-Za-z0-9+/]{22}==$'
 AND jsonb_typeof(v->'ciphertext')='string' AND length(v->>'ciphertext') BETWEEN 4 AND 11184812
 AND v->>'ciphertext' ~ '^[A-Za-z0-9+/]+={0,2}$') IS TRUE
$$;
CREATE TABLE commerce_number_lab.runs (
 workspace_id text NOT NULL REFERENCES public.profiles(id),id uuid NOT NULL,source_account_id uuid NOT NULL,
 actor_id text NOT NULL CHECK(length(actor_id)>0),start_operation_id uuid NOT NULL,start_request_sha256 text NOT NULL CHECK(start_request_sha256 ~ '^[a-f0-9]{64}$'),
 snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),estimate_sha256 text NOT NULL CHECK(estimate_sha256 ~ '^[a-f0-9]{64}$'),
 engine_sha256 text NOT NULL CHECK(engine_sha256 ~ '^[a-f0-9]{64}$'),snapshot_ciphertext jsonb NOT NULL CHECK(commerce_number_lab.valid_cipher(snapshot_ciphertext)),
 execution_environment text NOT NULL DEFAULT 'SIMULATION' CHECK(execution_environment='SIMULATION'),operation_class text NOT NULL DEFAULT 'TEST' CHECK(operation_class='TEST'),
 mode text NOT NULL CHECK(mode IN('CHAT','AUTOMATIC')),version bigint NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
 state text NOT NULL DEFAULT 'READY' CHECK(state IN('READY','RUNNING','PARTIAL','COMPLETED','STOPPED')),
 virtual_now timestamptz NOT NULL,maximum_ai_calls integer NOT NULL CHECK(maximum_ai_calls BETWEEN 1 AND 19200),
 maximum_microusd bigint NOT NULL CHECK(maximum_microusd BETWEEN 1 AND 9007199254740991),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 days',
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,start_operation_id)
);
CREATE TABLE commerce_number_lab.operations (
 workspace_id text NOT NULL,run_id uuid NOT NULL,id uuid NOT NULL,actor_id text NOT NULL CHECK(length(actor_id)>0),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),expected_version bigint NOT NULL CHECK(expected_version BETWEEN 1 AND 9007199254740991),
 action_ciphertext jsonb NOT NULL CHECK(commerce_number_lab.valid_cipher(action_ciphertext)),
 state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN('QUEUED','INTENT','APPLIED','FAILED','UNKNOWN')),
 result_ciphertext jsonb CHECK(result_ciphertext IS NULL OR commerce_number_lab.valid_cipher(result_ciphertext)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),intent_at timestamptz,completed_at timestamptz,
 PRIMARY KEY(workspace_id,run_id,id),UNIQUE(workspace_id,id),FOREIGN KEY(workspace_id,run_id) REFERENCES commerce_number_lab.runs(workspace_id,id),
 CHECK((state IN('QUEUED','INTENT') AND result_ciphertext IS NULL AND completed_at IS NULL) OR (state IN('APPLIED','FAILED','UNKNOWN') AND result_ciphertext IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX number_lab_one_pending ON commerce_number_lab.operations(workspace_id,run_id) WHERE state IN('QUEUED','INTENT','UNKNOWN');
CREATE TABLE commerce_number_lab.events (
 workspace_id text NOT NULL,run_id uuid NOT NULL,operation_id uuid NOT NULL,sequence bigint GENERATED ALWAYS AS IDENTITY,
 state text NOT NULL CHECK(state IN('QUEUED','INTENT','APPLIED','FAILED','UNKNOWN')),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,run_id,sequence),FOREIGN KEY(workspace_id,run_id,operation_id) REFERENCES commerce_number_lab.operations(workspace_id,run_id,id)
);
CREATE FUNCTION commerce_number_lab.lock_profile(w text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s text;
BEGIN
 IF w IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') THEN RAISE EXCEPTION 'LAB_PROFILE_SCOPE'; END IF;
 SELECT state INTO s FROM public.profiles WHERE id=w FOR SHARE;
 IF s IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'LAB_PROFILE_INACTIVE'; END IF;
END $$;
CREATE FUNCTION commerce_number_lab.guard_run() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t timestamptz;
BEGIN
 IF NEW.workspace_id IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') THEN RAISE EXCEPTION 'LAB_PROFILE_SCOPE'; END IF;
 IF TG_OP='INSERT' THEN PERFORM commerce_number_lab.lock_profile(NEW.workspace_id); END IF;t:=clock_timestamp();
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.state<>'READY' THEN RAISE EXCEPTION 'LAB_INITIAL_STATE'; END IF;
  NEW.created_at:=t;NEW.expires_at:=t+interval '30 days';NEW.virtual_now:=t;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','version','virtual_now']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','virtual_now']) THEN RAISE EXCEPTION 'LAB_RUN_IMMUTABLE'; END IF;
  IF OLD.state IN('COMPLETED','STOPPED') OR NEW.version<>OLD.version+1 OR NEW.virtual_now<OLD.virtual_now OR NEW.virtual_now>OLD.virtual_now+interval '24 hours' THEN RAISE EXCEPTION 'LAB_RUN_TRANSITION'; END IF;
  IF NEW.state='READY' THEN RAISE EXCEPTION 'LAB_RUN_TRANSITION'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION commerce_number_lab.guard_operation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r commerce_number_lab.runs%ROWTYPE;t timestamptz;
BEGIN
 IF NEW.workspace_id IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') THEN RAISE EXCEPTION 'LAB_PROFILE_SCOPE'; END IF;
 IF TG_OP='INSERT' OR NEW.state='INTENT' THEN PERFORM commerce_number_lab.lock_profile(NEW.workspace_id); END IF;
 SELECT * INTO r FROM commerce_number_lab.runs WHERE workspace_id=NEW.workspace_id AND id=NEW.run_id FOR UPDATE;
 t:=clock_timestamp();IF NOT FOUND OR ((TG_OP='INSERT' OR NEW.state='INTENT') AND (r.expires_at<=t OR r.state IN('COMPLETED','STOPPED'))) THEN RAISE EXCEPTION 'LAB_RUN_UNAVAILABLE'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.expected_version<>r.version OR NEW.state<>'QUEUED' OR NEW.intent_at IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.result_ciphertext IS NOT NULL THEN RAISE EXCEPTION 'LAB_OPERATION_ADMISSION'; END IF;
  NEW.created_at:=t;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','result_ciphertext','intent_at','completed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','result_ciphertext','intent_at','completed_at']) THEN RAISE EXCEPTION 'LAB_OPERATION_IMMUTABLE'; END IF;
  IF OLD.state='QUEUED' AND NEW.state='INTENT' THEN
   IF r.version<>OLD.expected_version THEN RAISE EXCEPTION 'LAB_VERSION_CHANGED'; END IF;NEW.intent_at:=t;NEW.completed_at:=NULL;
  ELSIF OLD.state='INTENT' AND NEW.state IN('APPLIED','FAILED','UNKNOWN') THEN
   NEW.intent_at:=OLD.intent_at;NEW.completed_at:=t;
  ELSE RAISE EXCEPTION 'LAB_OPERATION_REPLAY'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION commerce_number_lab.record_operation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO commerce_number_lab.events(workspace_id,run_id,operation_id,state) VALUES(NEW.workspace_id,NEW.run_id,NEW.id,NEW.state);RETURN NEW;
END $$;
CREATE TRIGGER number_lab_run_guard BEFORE INSERT OR UPDATE ON commerce_number_lab.runs FOR EACH ROW EXECUTE FUNCTION commerce_number_lab.guard_run();
CREATE TRIGGER number_lab_operation_guard BEFORE INSERT OR UPDATE ON commerce_number_lab.operations FOR EACH ROW EXECUTE FUNCTION commerce_number_lab.guard_operation();
CREATE TRIGGER number_lab_operation_event AFTER INSERT OR UPDATE ON commerce_number_lab.operations FOR EACH ROW EXECUTE FUNCTION commerce_number_lab.record_operation();
CREATE TRIGGER number_lab_event_immutable BEFORE UPDATE OR DELETE ON commerce_number_lab.events FOR EACH ROW EXECUTE FUNCTION public.immutable_row();
DO $$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY['runs','operations','events'] LOOP
  EXECUTE format('ALTER TABLE commerce_number_lab.%I OWNER TO commerce_number_lab_owner',n);
  EXECUTE format('ALTER TABLE commerce_number_lab.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE commerce_number_lab.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY profile_scope ON commerce_number_lab.%I USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')) WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),''''))',n);
 END LOOP;
 FOREACH n IN ARRAY ARRAY['valid_cipher(jsonb)','lock_profile(text)','guard_run()','guard_operation()','record_operation()'] LOOP
  EXECUTE 'ALTER FUNCTION commerce_number_lab.'||n||' OWNER TO commerce_number_lab_owner';
  EXECUTE 'REVOKE ALL ON FUNCTION commerce_number_lab.'||n||' FROM PUBLIC';
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION commerce_number_lab.valid_cipher(jsonb) TO commerce_api,commerce_number_lab;
GRANT SELECT,INSERT ON commerce_number_lab.runs,commerce_number_lab.operations TO commerce_api;
GRANT SELECT ON commerce_number_lab.events TO commerce_api;
GRANT SELECT ON commerce_number_lab.runs,commerce_number_lab.operations,commerce_number_lab.events TO commerce_number_lab;
GRANT UPDATE(state,result_ciphertext) ON commerce_number_lab.operations TO commerce_number_lab;
GRANT UPDATE(state,version,virtual_now) ON commerce_number_lab.runs TO commerce_number_lab;
-- <<< end 021_number_laboratory.sql

-- >>> promoted from packages/db/profile-transition/components/021_number_lab_ai_bridge.sql (source sha256 28293cfce9637eb002182f89a1b4dacabf4a93d95625951e3b82dbca1f2ddd30)
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
-- <<< end components/021_number_lab_ai_bridge.sql

-- >>> promoted from packages/db/profile-transition/components/021_number_lab_driver_control.sql (source sha256 f74ded2fcb8a9a7407fdd9913e32046bdaad10ebbe1f4df2087168bc91b0afd0)
-- Control database only: this is not installed in the dedicated engine.
-- The existing closed reader exposes no profile data and locks ACTIVE state.
DO $$ BEGIN
 IF to_regprocedure('commerce_number_lab.lock_profile(text)') IS NULL
  OR current_database() ~ '^commerce_lab_engine_' THEN
  RAISE EXCEPTION 'LAB_CONTROL_DATABASE_REQUIRED';
 END IF;
END $$;
GRANT EXECUTE ON FUNCTION commerce_number_lab.lock_profile(text) TO commerce_number_lab;
-- <<< end components/021_number_lab_driver_control.sql

-- >>> promoted from packages/db/profile-transition/components/021_number_lab_cached_ai.sql (source sha256 0fa01fbeb05064243087e6f5b71e5da8d5ac88c4b6b2c7482c42f98909833935)
-- Control database only, after 019/021 bridge. Closed read/lock capability;
-- no credential ciphertext, new admission, settlement or provider operation.
GRANT SELECT ON public.ai_attempts,public.ai_credentials TO commerce_number_lab_owner;
GRANT UPDATE(attempt_id) ON public.ai_attempts TO commerce_number_lab_owner;
GRANT UPDATE(id) ON public.ai_runtime_grants,public.ai_credentials TO commerce_number_lab_owner;
GRANT SELECT(user_id,workspace_id,active,role,version),UPDATE(user_id) ON public.memberships TO commerce_number_lab_owner;
CREATE FUNCTION commerce_number_lab.lock_cached_seller(w text,rid uuid,oid uuid,aid uuid,vid uuid,lid uuid,gid uuid,snapshot text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r commerce_number_lab.runs%ROWTYPE;o commerce_number_lab.operations%ROWTYPE;b commerce_number_lab.ai_bindings%ROWTYPE;
 a public.ai_attempts%ROWTYPE;g public.ai_runtime_grants%ROWTYPE;k public.ai_credentials%ROWTYPE;p public.ai_model_prices%ROWTYPE;
 v commerce_number_lab.run_releases%ROWTYPE;t timestamptz;deadline timestamptz;
BEGIN
 IF w IS NULL OR w IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'')
 OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL'
 OR rid IS NULL OR oid IS NULL OR aid IS NULL OR vid IS NULL OR lid IS NULL OR gid IS NULL
 OR snapshot IS NULL OR snapshot !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'LAB_AI_CACHE_SCOPE'; END IF;
 PERFORM public.ai_scope_lock(w,'REAL');
 PERFORM commerce_number_lab.lock_profile(w);
 SELECT * INTO r FROM commerce_number_lab.runs WHERE workspace_id=w AND id=rid FOR SHARE;
 SELECT * INTO o FROM commerce_number_lab.operations WHERE workspace_id=w AND run_id=rid AND id=oid FOR SHARE;
 SELECT * INTO b FROM commerce_number_lab.ai_bindings WHERE workspace_id=w AND budget_environment='REAL' AND attempt_id=aid;
 SELECT * INTO v FROM commerce_number_lab.run_releases WHERE workspace_id=w AND run_id=rid AND variant_id=vid;
 SELECT * INTO a FROM public.ai_attempts WHERE workspace_id=w AND environment='REAL' AND attempt_id=aid FOR SHARE;
 IF r.id IS NULL OR r.state IN('COMPLETED','STOPPED') OR r.snapshot_sha256<>snapshot OR o.id IS NULL OR o.state<>'INTENT'
 OR b.attempt_id IS NULL OR (b.run_id,b.variant_id,b.release_id,b.snapshot_sha256,b.grant_id,b.capability)
 IS DISTINCT FROM (rid,vid,lid,snapshot,gid,'chat') OR v.release_id IS DISTINCT FROM lid
 OR a.attempt_id IS NULL OR a.state<>'SUCCEEDED' OR a.intent_at IS NULL OR a.settled_at IS NULL OR a.is_test
 OR a.conversation_id IS NOT NULL OR (a.lab_binding_id,a.variant_id,a.grant_id,a.request_sha256,a.request_bytes,a.capability,a.task)
 IS DISTINCT FROM (aid,vid,gid,b.request_sha256,b.request_bytes,'chat','laboratory.chat') THEN RETURN NULL; END IF;
 -- The original operation can be terminal; it is never re-admitted.
 IF NOT EXISTS(SELECT 1 FROM commerce_number_lab.operations old WHERE old.workspace_id=w AND old.run_id=rid AND old.id=b.operation_id AND old.state IN('INTENT','APPLIED')) THEN RETURN NULL; END IF;
 SELECT * INTO g FROM public.ai_runtime_grants WHERE workspace_id=w AND environment='REAL' AND id=gid FOR SHARE;
 SELECT * INTO k FROM public.ai_credentials WHERE workspace_id=w AND environment='REAL' AND id=a.credential_id FOR SHARE;
 SELECT * INTO p FROM public.ai_model_prices WHERE (provider,model,model_revision,price_version)=(a.provider,a.model,a.model_revision,a.price_version);
 IF g.id IS NULL OR g.revoked_at IS NOT NULL OR g.version<>a.grant_version
 OR (g.variant_id,g.task,g.is_test,g.provider,g.model,g.model_revision,g.price_version,g.credential_id)
 IS DISTINCT FROM (a.variant_id,a.task,a.is_test,a.provider,a.model,a.model_revision,a.price_version,a.credential_id)
 OR k.id IS NULL OR NOT k.enabled OR k.state<>'VERIFIED' OR k.revision<>a.credential_revision OR k.provider<>a.provider
 OR p.provider IS NULL OR (g.provider,g.model,g.model_revision,g.price_version)
 IS DISTINCT FROM (v.quote->>'provider',v.quote->>'model',v.quote->>'modelRevision',v.quote->>'priceVersion') THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.memberships WHERE user_id=g.actor_id AND workspace_id=w AND active AND role='owner' AND version=g.actor_membership_version FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 t:=clock_timestamp();deadline:=least(r.expires_at,g.expires_at,p.valid_until);
 IF deadline<=t OR p.valid_from>t OR a.settled_at>t OR a.intent_at>a.settled_at THEN RETURN NULL; END IF;
 RETURN to_jsonb(p)||jsonb_build_object('valid_until_cache',deadline,'observed_at',t,'request_sha256',a.request_sha256,'request_bytes',a.request_bytes);
END $$;
ALTER FUNCTION commerce_number_lab.lock_cached_seller(text,uuid,uuid,uuid,uuid,uuid,uuid,text) OWNER TO commerce_number_lab_owner;
REVOKE ALL ON FUNCTION commerce_number_lab.lock_cached_seller(text,uuid,uuid,uuid,uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_number_lab.lock_cached_seller(text,uuid,uuid,uuid,uuid,uuid,uuid,text) TO commerce_number_lab;
-- <<< end components/021_number_lab_cached_ai.sql
