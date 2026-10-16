-- RF19 control store. This does not provision the separate canonical engine DB.
-- Refuse existing roles: inherited/direct privileges cannot become lab authority.
DO $$ BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname IN('commerce_number_lab','commerce_number_lab_owner')) THEN RAISE EXCEPTION 'LAB_ROLE_ALREADY_EXISTS'; END IF;
 CREATE ROLE commerce_number_lab NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
 CREATE ROLE commerce_number_lab_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
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
