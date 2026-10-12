-- V7 F2 cutover: Per-profile AI admission (019).
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> promoted from packages/db/profile-transition/019_ai_admission.sql (source sha256 9c5e7a1704f5341c24f98344db5b5ae65af1fff5c89a4936d9c4900467436e29)
-- V7 F2: 1 role-existence refusal(s) and 1 CREATE ROLE replaced by v7_ensure_reviewed_role (adopts only the exact reviewed safe attributes).
-- V7 isolated transition; no runtime mount or credential is provisioned here.
DO $$ BEGIN

 PERFORM public.v7_ensure_reviewed_role('commerce_ai',true);
END $$;
GRANT USAGE ON SCHEMA public TO commerce_ai;
CREATE TABLE ai_model_prices (
 provider text NOT NULL CHECK(provider IN('openai','anthropic','google')), model text NOT NULL,
 model_revision text NOT NULL, price_version text NOT NULL,
 valid_from timestamptz NOT NULL, valid_until timestamptz NOT NULL CHECK(valid_until>valid_from),
 input_ceiling integer NOT NULL CHECK(input_ceiling BETWEEN 1 AND 2000000),
 output_ceiling integer NOT NULL CHECK(output_ceiling BETWEEN 1 AND 128000),
 input_rate bigint NOT NULL CHECK(input_rate>0), output_rate bigint NOT NULL CHECK(output_rate>0),
 cache_read_rate bigint NOT NULL CHECK(cache_read_rate>=0), cache_write_rate bigint NOT NULL CHECK(cache_write_rate>=0), audio_input_rate bigint NOT NULL CHECK(audio_input_rate>=0),
 model_document jsonb NOT NULL CHECK(jsonb_typeof(model_document)='object'),
 PRIMARY KEY(provider,model,model_revision,price_version)
);
CREATE TRIGGER immutable_ai_prices BEFORE UPDATE OR DELETE ON ai_model_prices FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE ai_credentials (
 id uuid NOT NULL, workspace_id text NOT NULL REFERENCES profiles(id), environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 provider text NOT NULL CHECK(provider IN('openai','anthropic','google')), revision integer NOT NULL CHECK(revision>0),
 enabled boolean NOT NULL DEFAULT true, state text NOT NULL DEFAULT 'UNVERIFIED' CHECK(state IN('UNVERIFIED','VERIFIED')),
 verified_attempt uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,id), UNIQUE(workspace_id,environment,provider)
);
CREATE TABLE ai_credential_versions (
 workspace_id text NOT NULL, environment text NOT NULL, credential_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 verification_attempt uuid NOT NULL, ciphertext jsonb NOT NULL CHECK((jsonb_typeof(ciphertext)='object' AND ciphertext-ARRAY['version','iv','tag','ciphertext']='{}'::jsonb AND ciphertext->'version'='1'::jsonb AND jsonb_typeof(ciphertext->'iv')='string' AND ciphertext->>'iv' ~ '^[A-Za-z0-9+/]{16}$' AND jsonb_typeof(ciphertext->'tag')='string' AND ciphertext->>'tag' ~ '^[A-Za-z0-9+/]{22}==$' AND jsonb_typeof(ciphertext->'ciphertext')='string' AND length(ciphertext->>'ciphertext') BETWEEN 4 AND 10924 AND ciphertext->>'ciphertext' ~ '^[A-Za-z0-9+/]+={0,2}$') IS TRUE), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,credential_id,revision), UNIQUE(workspace_id,environment,verification_attempt),
 FOREIGN KEY(workspace_id,environment,credential_id) REFERENCES ai_credentials(workspace_id,environment,id)
);
ALTER TABLE ai_credentials ADD CONSTRAINT ai_current_key FOREIGN KEY(workspace_id,environment,id,revision)
 REFERENCES ai_credential_versions(workspace_id,environment,credential_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER immutable_ai_keys BEFORE UPDATE OR DELETE ON ai_credential_versions FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE ai_credential_operations (
 workspace_id text NOT NULL REFERENCES profiles(id), environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 actor_id text NOT NULL, operation_id uuid NOT NULL, request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL CHECK((jsonb_typeof(result)='object' AND result-ARRAY['credentialId','revision','state','verificationRequired','verificationAttemptId']='{}'::jsonb AND result->>'credentialId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' AND jsonb_typeof(result->'revision')='number' AND (result->>'revision')::numeric BETWEEN 1 AND 2147483647 AND (result->>'revision')::numeric=trunc((result->>'revision')::numeric) AND result->>'state'='UNVERIFIED' AND result->'verificationRequired'='true'::jsonb AND result->>'verificationAttemptId'=operation_id::text) IS TRUE), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,actor_id,operation_id)
);
CREATE TRIGGER immutable_ai_key_operations BEFORE UPDATE OR DELETE ON ai_credential_operations FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE ai_budget_periods (
 id uuid NOT NULL, workspace_id text NOT NULL REFERENCES profiles(id), environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>=starts_at+interval '1 day'),
 profile_limit_microusd bigint NOT NULL CHECK(profile_limit_microusd BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY(workspace_id,environment,id)
);
CREATE TABLE ai_key_budgets (
 workspace_id text NOT NULL, environment text NOT NULL, period_id uuid NOT NULL, credential_id uuid NOT NULL,
 limit_microusd bigint NOT NULL CHECK(limit_microusd BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY(workspace_id,environment,period_id,credential_id),
 FOREIGN KEY(workspace_id,environment,period_id) REFERENCES ai_budget_periods(workspace_id,environment,id),
 FOREIGN KEY(workspace_id,environment,credential_id) REFERENCES ai_credentials(workspace_id,environment,id)
);
CREATE TABLE ai_runtime_grants (
 id uuid NOT NULL, workspace_id text NOT NULL, environment text NOT NULL, credential_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), variant_id uuid, task text NOT NULL CHECK(task ~ '^[a-z][a-z0-9._-]{0,63}$'),
 is_test boolean NOT NULL DEFAULT false, test_request_sha256 text, test_request_bytes integer, provider text NOT NULL, model text NOT NULL, model_revision text NOT NULL, price_version text NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, actor_id text NOT NULL CHECK(length(actor_id)>0), actor_membership_version integer NOT NULL CHECK(actor_membership_version>0),
 PRIMARY KEY(workspace_id,environment,id),
 FOREIGN KEY(workspace_id,environment,credential_id) REFERENCES ai_credentials(workspace_id,environment,id),
 FOREIGN KEY(workspace_id,environment,variant_id) REFERENCES market_variants(workspace_id,environment,id),
 FOREIGN KEY(provider,model,model_revision,price_version) REFERENCES ai_model_prices(provider,model,model_revision,price_version),
 CHECK(((is_test AND variant_id IS NULL AND task='credential.verify' AND test_request_sha256 ~ '^[a-f0-9]{64}$' AND test_request_bytes BETWEEN 1 AND 4096) OR (NOT is_test AND variant_id IS NOT NULL AND task<>'credential.verify' AND test_request_sha256 IS NULL AND test_request_bytes IS NULL)) IS TRUE)
);
CREATE TABLE ai_attempts (
 attempt_id uuid NOT NULL, workspace_id text NOT NULL, environment text NOT NULL,
 variant_id uuid, conversation_id uuid, conversation_kind text NOT NULL DEFAULT 'conversation' CHECK(conversation_kind='conversation'),
 task text NOT NULL, is_test boolean NOT NULL, grant_id uuid NOT NULL, grant_version integer NOT NULL,
 credential_id uuid NOT NULL, credential_revision integer NOT NULL,
 provider text NOT NULL, model text NOT NULL, model_revision text NOT NULL, price_version text NOT NULL,
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'), request_bytes integer NOT NULL CHECK(request_bytes BETWEEN 1 AND 8388608),
 capability text NOT NULL CHECK(capability IN('chat','vision','audio')),
 reserved_microusd bigint NOT NULL CHECK(reserved_microusd BETWEEN 1 AND 9007199254740991),
 charged_microusd bigint NOT NULL CHECK(charged_microusd BETWEEN 0 AND 9007199254740991), measured_cost_microusd bigint,
 state text NOT NULL CHECK(state IN('RESERVED','INTENT','SUCCEEDED','REJECTED','UNCERTAIN')), code text,
 input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, audio_input_tokens bigint,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), authorized_until timestamptz NOT NULL,
 intent_at timestamptz, settled_at timestamptz,
 PRIMARY KEY(workspace_id,environment,attempt_id),
 FOREIGN KEY(workspace_id,environment,grant_id) REFERENCES ai_runtime_grants(workspace_id,environment,id),
 FOREIGN KEY(workspace_id,environment,credential_id,credential_revision) REFERENCES ai_credential_versions(workspace_id,environment,credential_id,revision),
 FOREIGN KEY(workspace_id,environment,variant_id) REFERENCES market_variants(workspace_id,environment,id),
 FOREIGN KEY(conversation_id,workspace_id,environment,conversation_kind) REFERENCES records(id,workspace_id,environment,kind),
 FOREIGN KEY(provider,model,model_revision,price_version) REFERENCES ai_model_prices(provider,model,model_revision,price_version),
 CHECK(((input_tokens IS NULL AND output_tokens IS NULL AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL AND audio_input_tokens IS NULL AND measured_cost_microusd IS NULL)
 OR (input_tokens BETWEEN 0 AND 9007199254740991 AND output_tokens BETWEEN 0 AND 9007199254740991 AND cache_read_tokens BETWEEN 0 AND 9007199254740991 AND cache_write_tokens BETWEEN 0 AND 9007199254740991 AND audio_input_tokens BETWEEN 0 AND 9007199254740991 AND measured_cost_microusd BETWEEN 0 AND 9007199254740991)) IS TRUE)
);
CREATE TABLE ai_attempt_allocations (
 workspace_id text NOT NULL, environment text NOT NULL, attempt_id uuid NOT NULL, period_id uuid NOT NULL, credential_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,environment,attempt_id,period_id),
 FOREIGN KEY(workspace_id,environment,attempt_id) REFERENCES ai_attempts(workspace_id,environment,attempt_id),
 FOREIGN KEY(workspace_id,environment,period_id,credential_id) REFERENCES ai_key_budgets(workspace_id,environment,period_id,credential_id)
);
CREATE TABLE ai_attempt_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL, attempt_id uuid NOT NULL,
 state text NOT NULL, code text, charged_microusd bigint NOT NULL, measured_cost_microusd bigint,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(workspace_id,environment,attempt_id) REFERENCES ai_attempts(workspace_id,environment,attempt_id)
);
-- A denied admission is not a provider attempt or measured expense. Preserve the
-- first closed cause/request identity so a recovered dependency cannot rewrite it.
CREATE TABLE ai_admission_denials (
 workspace_id text NOT NULL, environment text NOT NULL, attempt_id uuid NOT NULL, grant_id uuid NOT NULL,
 variant_id uuid, conversation_id uuid, task text NOT NULL, request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 cause text NOT NULL CHECK(cause IN('PROFILE_INACTIVE','OWNER_CHANGED','KEY_UNAVAILABLE','GRANT_CHANGED','AUTHORITY_EXPIRED','BUDGET_EXCEEDED','BUDGET_UNCONFIGURED')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,environment,attempt_id),
 FOREIGN KEY(workspace_id,environment,grant_id) REFERENCES ai_runtime_grants(workspace_id,environment,id)
);
CREATE TRIGGER immutable_ai_denials BEFORE UPDATE OR DELETE ON ai_admission_denials FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE FUNCTION ai_scope_lock(w text,e text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF w IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') OR e NOT IN('REAL','SIMULATION') THEN RAISE EXCEPTION 'AI_SCOPE_REQUIRED'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('commerce.ai.admission.v1:'||w||':'||e,0)) THEN RAISE EXCEPTION 'AI_ADMISSION_BUSY'; END IF;
END $$;
CREATE FUNCTION guard_ai_denial() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g public.ai_runtime_grants%ROWTYPE;
BEGIN
 PERFORM public.ai_scope_lock(NEW.workspace_id,NEW.environment);
 SELECT * INTO g FROM public.ai_runtime_grants WHERE workspace_id=NEW.workspace_id AND environment=NEW.environment AND id=NEW.grant_id;
 IF g.id IS NULL OR (g.variant_id,g.task) IS DISTINCT FROM (NEW.variant_id,NEW.task) THEN RAISE EXCEPTION 'AI_DENIAL_SCOPE'; END IF;
 IF NEW.conversation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.records WHERE id=NEW.conversation_id AND workspace_id=NEW.workspace_id AND environment=NEW.environment AND kind='conversation') THEN RAISE EXCEPTION 'AI_DENIAL_SCOPE'; END IF;
 NEW.recorded_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER ai_denial_guard BEFORE INSERT ON ai_admission_denials FOR EACH ROW EXECUTE FUNCTION guard_ai_denial();
CREATE FUNCTION guard_ai_budget() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 PERFORM public.ai_scope_lock(NEW.workspace_id,NEW.environment);
 IF EXISTS(SELECT 1 FROM public.ai_budget_periods p WHERE p.workspace_id=NEW.workspace_id AND p.environment=NEW.environment AND p.starts_at<NEW.ends_at AND p.ends_at>NEW.starts_at) THEN RAISE EXCEPTION 'AI_BUDGET_PERIOD_OVERLAP'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_budget_period_guard BEFORE INSERT ON ai_budget_periods FOR EACH ROW EXECUTE FUNCTION guard_ai_budget();
CREATE TRIGGER immutable_ai_budget_periods BEFORE UPDATE OR DELETE ON ai_budget_periods FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_ai_key_budgets BEFORE UPDATE OR DELETE ON ai_key_budgets FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE FUNCTION guard_ai_configuration() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 PERFORM public.ai_scope_lock(NEW.workspace_id,NEW.environment);
 IF TG_TABLE_NAME='ai_credentials' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.revision<>1 OR NEW.state<>'UNVERIFIED' OR NEW.verified_attempt IS NOT NULL THEN RAISE EXCEPTION 'AI_UNVERIFIED_KEY_REQUIRED'; END IF;
  ELSIF (NEW.id,NEW.workspace_id,NEW.environment,NEW.provider,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.environment,OLD.provider,OLD.created_at) THEN RAISE EXCEPTION 'AI_KEY_SCOPE_IMMUTABLE';
  ELSIF NEW.revision=OLD.revision+1 THEN
   IF NEW.state<>'UNVERIFIED' OR NEW.verified_attempt IS NOT NULL THEN RAISE EXCEPTION 'AI_KEY_REVERIFY_REQUIRED'; END IF;
  ELSIF NEW.revision=OLD.revision THEN
   IF NEW.state IS DISTINCT FROM OLD.state OR NEW.verified_attempt IS DISTINCT FROM OLD.verified_attempt THEN
    IF NEW.state<>'VERIFIED' OR NOT EXISTS(SELECT 1 FROM public.ai_attempts a WHERE a.workspace_id=NEW.workspace_id AND a.environment=NEW.environment AND a.attempt_id=NEW.verified_attempt AND a.is_test AND a.state='SUCCEEDED' AND a.credential_id=NEW.id AND a.credential_revision=NEW.revision) THEN RAISE EXCEPTION 'AI_KEY_TEST_REQUIRED'; END IF;
   END IF;
  ELSE RAISE EXCEPTION 'AI_KEY_VERSION_CONFLICT'; END IF;
 ELSE
  IF TG_OP='INSERT' AND (NEW.version<>1 OR NEW.revoked_at IS NOT NULL) THEN RAISE EXCEPTION 'AI_INITIAL_GRANT_REQUIRED'; END IF;
  IF TG_OP='UPDATE' AND ((NEW.id,NEW.workspace_id,NEW.environment,NEW.credential_id,NEW.variant_id,NEW.task,NEW.is_test,NEW.test_request_sha256,NEW.test_request_bytes,NEW.provider,NEW.model,NEW.model_revision,NEW.price_version,NEW.actor_id,NEW.actor_membership_version)
    IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.environment,OLD.credential_id,OLD.variant_id,OLD.task,OLD.is_test,OLD.test_request_sha256,OLD.test_request_bytes,OLD.provider,OLD.model,OLD.model_revision,OLD.price_version,OLD.actor_id,OLD.actor_membership_version)
    OR NEW.version<>OLD.version+1 OR OLD.revoked_at IS NOT NULL OR NEW.expires_at>OLD.expires_at) THEN RAISE EXCEPTION 'AI_GRANT_TRANSITION_FORBIDDEN'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_key_guard BEFORE INSERT OR UPDATE ON ai_credentials FOR EACH ROW EXECUTE FUNCTION guard_ai_configuration();
CREATE TRIGGER ai_grant_guard BEFORE INSERT OR UPDATE ON ai_runtime_grants FOR EACH ROW EXECUTE FUNCTION guard_ai_configuration();

CREATE FUNCTION guard_ai_attempt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p public.ai_model_prices%ROWTYPE; g public.ai_runtime_grants%ROWTYPE; k public.ai_credentials%ROWTYPE; b record; moment timestamptz:=clock_timestamp(); covered timestamptz; maximum numeric; measured numeric;
BEGIN
 PERFORM public.ai_scope_lock(NEW.workspace_id,NEW.environment);
 SELECT * INTO p FROM public.ai_model_prices WHERE (provider,model,model_revision,price_version)=(NEW.provider,NEW.model,NEW.model_revision,NEW.price_version);
 IF NOT FOUND THEN RAISE EXCEPTION 'AI_PRICE_REQUIRED'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['state','code','charged_microusd','measured_cost_microusd','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','audio_input_tokens','intent_at','settled_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','code','charged_microusd','measured_cost_microusd','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','audio_input_tokens','intent_at','settled_at']) THEN RAISE EXCEPTION 'AI_ATTEMPT_IDENTITY_IMMUTABLE'; END IF;
  IF OLD.state NOT IN('RESERVED','INTENT') OR NEW.state NOT IN('INTENT','SUCCEEDED','REJECTED','UNCERTAIN') OR (OLD.state='INTENT' AND NEW.state='INTENT') OR (OLD.state='RESERVED' AND NEW.state='SUCCEEDED') THEN RAISE EXCEPTION 'AI_ATTEMPT_TRANSITION_FORBIDDEN'; END IF;
 END IF;
 IF TG_OP='INSERT' OR NEW.state='INTENT' THEN
  PERFORM 1 FROM public.profiles WHERE id=NEW.workspace_id AND state='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_PROFILE_INACTIVE'; END IF;
  SELECT * INTO g FROM public.ai_runtime_grants WHERE workspace_id=NEW.workspace_id AND environment=NEW.environment AND id=NEW.grant_id FOR SHARE;
  SELECT * INTO k FROM public.ai_credentials WHERE workspace_id=NEW.workspace_id AND environment=NEW.environment AND id=NEW.credential_id FOR SHARE;
  IF g.id IS NULL OR g.revoked_at IS NOT NULL OR g.version<>NEW.grant_version OR (g.variant_id,g.task,g.is_test,g.provider,g.model,g.model_revision,g.price_version,g.credential_id)
   IS DISTINCT FROM (NEW.variant_id,NEW.task,NEW.is_test,NEW.provider,NEW.model,NEW.model_revision,NEW.price_version,NEW.credential_id) THEN RAISE EXCEPTION 'AI_GRANT_CHANGED'; END IF;
  PERFORM 1 FROM public.memberships WHERE user_id=g.actor_id AND workspace_id=NEW.workspace_id AND active AND role='owner' AND version=g.actor_membership_version FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_GRANT_OWNER_CHANGED'; END IF;
  IF k.id IS NULL OR NOT k.enabled OR k.revision<>NEW.credential_revision OR k.provider<>NEW.provider OR (NOT NEW.is_test AND k.state<>'VERIFIED') THEN RAISE EXCEPTION 'AI_CREDENTIAL_UNAVAILABLE'; END IF;
  IF NEW.is_test AND (NEW.request_sha256 IS DISTINCT FROM g.test_request_sha256 OR NEW.request_bytes IS DISTINCT FROM g.test_request_bytes OR NEW.capability<>'chat') THEN RAISE EXCEPTION 'AI_MINIMAL_TEST_REQUEST_REQUIRED'; END IF;
  IF NEW.is_test AND (NEW.variant_id IS NOT NULL OR NEW.conversation_id IS NOT NULL OR NEW.task<>'credential.verify') THEN RAISE EXCEPTION 'AI_TEST_SCOPE'; END IF;
  IF NEW.is_test AND NOT EXISTS(SELECT 1 FROM public.ai_credential_versions v WHERE (v.workspace_id,v.environment,v.credential_id,v.revision,v.verification_attempt)=(NEW.workspace_id,NEW.environment,NEW.credential_id,NEW.credential_revision,NEW.attempt_id)) THEN RAISE EXCEPTION 'AI_KEY_TEST_OPERATION_REQUIRED'; END IF;
  IF NOT NEW.is_test AND NEW.variant_id IS NULL THEN RAISE EXCEPTION 'AI_VARIANT_REQUIRED'; END IF;
  moment:=clock_timestamp();
  IF p.valid_from>moment OR p.valid_until<NEW.authorized_until OR g.expires_at<NEW.authorized_until OR NEW.authorized_until<=moment THEN RAISE EXCEPTION 'AI_AUTHORITY_EXPIRED'; END IF;
  IF NOT (p.model_document->'capabilities' ? NEW.capability) THEN RAISE EXCEPTION 'AI_CAPABILITY_REQUIRED'; END IF;
  IF NEW.conversation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.market_journey_snapshots j JOIN public.market_releases r ON (r.workspace_id,r.environment,r.id)=(j.workspace_id,j.environment,j.release_id)
   WHERE (j.workspace_id,j.environment,j.journey_id)=(NEW.workspace_id,NEW.environment,NEW.conversation_id) AND r.variant_id=NEW.variant_id) THEN RAISE EXCEPTION 'AI_CONVERSATION_VARIANT_CHANGED'; END IF;
 END IF;
 IF TG_OP='INSERT' THEN
  NEW.created_at:=moment; NEW.authorized_until:=moment+interval '60 seconds';
  IF p.valid_until<NEW.authorized_until OR g.expires_at<NEW.authorized_until THEN RAISE EXCEPTION 'AI_AUTHORITY_WINDOW_REQUIRED'; END IF;
  maximum:=ceil((p.input_ceiling::numeric*greatest(p.input_rate,p.cache_read_rate,p.cache_write_rate,p.audio_input_rate)+p.output_ceiling::numeric*p.output_rate)/1000000);
  IF NEW.state<>'RESERVED' OR NEW.reserved_microusd<>maximum OR NEW.charged_microusd<>maximum OR NEW.intent_at IS NOT NULL OR NEW.settled_at IS NOT NULL OR NEW.code IS NOT NULL OR NEW.input_tokens IS NOT NULL OR NEW.measured_cost_microusd IS NOT NULL THEN RAISE EXCEPTION 'AI_RESERVATION_REQUIRED'; END IF;
  covered:=moment;
  FOR b IN SELECT bp.*,kb.limit_microusd FROM public.ai_budget_periods bp JOIN public.ai_key_budgets kb ON (kb.workspace_id,kb.environment,kb.period_id)=(bp.workspace_id,bp.environment,bp.id) AND kb.credential_id=NEW.credential_id
   WHERE bp.workspace_id=NEW.workspace_id AND bp.environment=NEW.environment AND bp.starts_at<NEW.authorized_until AND bp.ends_at>moment ORDER BY bp.starts_at FOR SHARE OF bp,kb LOOP
   IF b.starts_at>covered THEN RAISE EXCEPTION 'AI_BUDGET_COVERAGE_REQUIRED'; END IF;
   IF maximum+COALESCE((SELECT sum(a.charged_microusd) FROM public.ai_attempt_allocations x JOIN public.ai_attempts a USING(workspace_id,environment,attempt_id) WHERE x.workspace_id=NEW.workspace_id AND x.environment=NEW.environment AND x.period_id=b.id),0)>b.profile_limit_microusd
    OR maximum+COALESCE((SELECT sum(a.charged_microusd) FROM public.ai_attempt_allocations x JOIN public.ai_attempts a USING(workspace_id,environment,attempt_id) WHERE x.workspace_id=NEW.workspace_id AND x.environment=NEW.environment AND x.period_id=b.id AND x.credential_id=NEW.credential_id),0)>b.limit_microusd THEN RAISE EXCEPTION 'AI_BUDGET_EXCEEDED'; END IF;
   covered:=greatest(covered,b.ends_at);
  END LOOP;
  IF covered<NEW.authorized_until THEN RAISE EXCEPTION 'AI_BUDGET_COVERAGE_REQUIRED'; END IF;
 ELSIF NEW.state='INTENT' THEN
  IF NEW.code IS NOT NULL OR NEW.measured_cost_microusd IS NOT NULL OR NEW.input_tokens IS NOT NULL OR NEW.settled_at IS NOT NULL OR NEW.charged_microusd<>OLD.charged_microusd THEN RAISE EXCEPTION 'AI_INTENT_SHAPE'; END IF;
  NEW.intent_at:=moment;
 ELSE
  NEW.intent_at:=OLD.intent_at; NEW.settled_at:=moment;
  IF NEW.input_tokens IS NOT NULL THEN
   measured:=ceil((NEW.input_tokens::numeric*p.input_rate+NEW.output_tokens::numeric*p.output_rate+NEW.cache_read_tokens::numeric*p.cache_read_rate+NEW.cache_write_tokens::numeric*p.cache_write_rate+NEW.audio_input_tokens::numeric*p.audio_input_rate)/1000000);
   IF measured IS DISTINCT FROM NEW.measured_cost_microusd THEN RAISE EXCEPTION 'AI_MEASURED_COST_INVALID'; END IF;
  END IF;
  IF NEW.state='SUCCEEDED' THEN
   IF NEW.input_tokens IS NULL OR NEW.code IS NOT NULL OR NEW.input_tokens::numeric+NEW.cache_read_tokens+NEW.cache_write_tokens+NEW.audio_input_tokens>p.input_ceiling OR NEW.output_tokens>p.output_ceiling OR NEW.measured_cost_microusd>NEW.reserved_microusd OR NEW.charged_microusd<>NEW.measured_cost_microusd THEN RAISE EXCEPTION 'AI_SUCCESS_USAGE_REQUIRED'; END IF;
  ELSIF NEW.code IS NULL OR NEW.code NOT IN('CONFIGURATION','CAPABILITY','PRICE_EXPIRED','BUDGET','INPUT_LIMIT','CREDENTIAL_SCOPE','ALREADY_ATTEMPTED','AUTHORITY','HTTP_REJECTED','HTTP_UNKNOWN','NETWORK_UNKNOWN','RESPONSE_LIMIT','OUTPUT_REJECTED','USAGE_MISSING','USAGE_INVALID','USAGE_EXCEEDED','RECORD_UNKNOWN') OR NEW.charged_microusd<>greatest(OLD.charged_microusd,COALESCE(NEW.measured_cost_microusd,0)) THEN RAISE EXCEPTION 'AI_UNCERTAIN_RESERVATION_RETAINED'; END IF;
 END IF;
 IF NEW.state IN('RESERVED','INTENT') AND NEW.authorized_until<=clock_timestamp() THEN RAISE EXCEPTION 'AI_AUTHORITY_EXPIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_attempt_guard BEFORE INSERT OR UPDATE ON ai_attempts FOR EACH ROW EXECUTE FUNCTION guard_ai_attempt();
CREATE FUNCTION record_ai_attempt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO public.ai_attempt_allocations(workspace_id,environment,attempt_id,period_id,credential_id)
   SELECT NEW.workspace_id,NEW.environment,NEW.attempt_id,id,NEW.credential_id FROM public.ai_budget_periods WHERE workspace_id=NEW.workspace_id AND environment=NEW.environment AND starts_at<NEW.authorized_until AND ends_at>NEW.created_at;
 END IF;
 INSERT INTO public.ai_attempt_events(workspace_id,environment,attempt_id,state,code,charged_microusd,measured_cost_microusd) VALUES(NEW.workspace_id,NEW.environment,NEW.attempt_id,NEW.state,NEW.code,NEW.charged_microusd,NEW.measured_cost_microusd);
 IF NEW.is_test AND NEW.state='SUCCEEDED' THEN UPDATE public.ai_credentials SET state='VERIFIED',verified_attempt=NEW.attempt_id,updated_at=clock_timestamp() WHERE workspace_id=NEW.workspace_id AND environment=NEW.environment AND id=NEW.credential_id AND revision=NEW.credential_revision; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_attempt_record AFTER INSERT OR UPDATE ON ai_attempts FOR EACH ROW EXECUTE FUNCTION record_ai_attempt();
CREATE TRIGGER immutable_ai_events BEFORE UPDATE OR DELETE ON ai_attempt_events FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_ai_allocations BEFORE UPDATE OR DELETE ON ai_attempt_allocations FOR EACH ROW EXECUTE FUNCTION immutable_row();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ai_admission_denials','ai_credential_operations','ai_credentials','ai_credential_versions','ai_budget_periods','ai_key_budgets','ai_runtime_grants','ai_attempts','ai_attempt_allocations','ai_attempt_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY ai_profile_scope ON %I USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')) WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),''''))',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,commerce_api,commerce_automation,commerce_channel,commerce_ingress,commerce_ai',t);
 END LOOP;
END $$;
GRANT SELECT ON ai_model_prices TO commerce_api,commerce_ai;
GRANT SELECT ON ai_admission_denials TO commerce_api,commerce_ai;
GRANT INSERT ON ai_admission_denials TO commerce_ai;
GRANT SELECT ON ai_credentials,ai_runtime_grants,ai_budget_periods,ai_key_budgets,ai_attempts,ai_attempt_allocations,ai_attempt_events TO commerce_api,commerce_ai;
GRANT SELECT,INSERT ON ai_credential_operations TO commerce_api;
GRANT INSERT ON ai_credentials,ai_credential_versions,ai_runtime_grants,ai_budget_periods,ai_key_budgets TO commerce_api;
GRANT UPDATE(revision,enabled,state,verified_attempt,updated_at) ON ai_credentials TO commerce_api;
GRANT UPDATE(version,expires_at,revoked_at) ON ai_runtime_grants TO commerce_api;
GRANT SELECT ON ai_credential_versions TO commerce_ai;
GRANT INSERT ON ai_attempts TO commerce_ai;
GRANT UPDATE(state,code,charged_microusd,measured_cost_microusd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,audio_input_tokens,intent_at,settled_at) ON ai_attempts TO commerce_ai;
REVOKE ALL ON FUNCTION ai_scope_lock(text,text),guard_ai_budget(),guard_ai_denial(),guard_ai_configuration(),guard_ai_attempt(),record_ai_attempt() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_scope_lock(text,text) TO commerce_ai,commerce_api;
CREATE INDEX ai_attempts_reporting ON ai_attempts(workspace_id,environment,created_at,attempt_id);
CREATE INDEX ai_allocations_budget ON ai_attempt_allocations(workspace_id,environment,period_id,credential_id);

CREATE VIEW result_ai_cost_facts WITH (security_invoker=true) AS
 SELECT workspace_id,environment,conversation_id,variant_id,attempt_id,provider,model,model_revision,price_version,task,
 CASE WHEN is_test THEN 'TEST' ELSE 'OPERATION' END AS operation_class,
 COALESCE(settled_at,intent_at,created_at) AS occurred_at,created_at,intent_at,settled_at,state AS status,
 measured_cost_microusd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,audio_input_tokens
 FROM ai_attempts;
REVOKE ALL ON result_ai_cost_facts FROM PUBLIC;
GRANT SELECT ON result_ai_cost_facts TO commerce_api;

CREATE UNIQUE INDEX ai_one_key_verification ON ai_attempts(workspace_id,environment,credential_id,credential_revision) WHERE is_test;
-- <<< end 019_ai_admission.sql
