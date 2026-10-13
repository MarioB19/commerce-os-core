-- V7 RF-19.p/h: the automatic buyer of «Probar número». A suite tests every
-- variant a number sells with two scripted journeys, each in its own isolated
-- run (AUTOMATIC mode): a purchase (greeting, offer, collection, receipt,
-- delivery and the post-purchase exclusion of follow-ups) and a silent
-- customer (follow-ups). The person who starts it accepts one cost ceiling;
-- the laboratory worker issues each step through enqueue_suite_step, under
-- that person's authority, and records what each step showed.
DO $$BEGIN
 IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'NUMBER_LAB_SUITES_OWNER_REQUIRED';
 END IF;
END$$;

CREATE TABLE commerce_number_lab.suites (
 workspace_id text NOT NULL REFERENCES public.profiles(id),id uuid NOT NULL,account_id uuid NOT NULL,
 actor_id text NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),start_operation_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'RUNNING' CHECK(state IN('RUNNING','COMPLETED','STOPPED')),
 maximum_microusd bigint NOT NULL CHECK(maximum_microusd BETWEEN 1 AND 9007199254740991),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,start_operation_id),
 CHECK((state='RUNNING')=(completed_at IS NULL))
);
CREATE TABLE commerce_number_lab.suite_cases (
 workspace_id text NOT NULL,suite_id uuid NOT NULL,run_id uuid NOT NULL,variant_id uuid NOT NULL,
 journey text NOT NULL CHECK(journey IN('PURCHASE','FOLLOWUP')),expect_followup boolean NOT NULL,
 attachment_id uuid,state text NOT NULL DEFAULT 'RUNNING' CHECK(state IN('RUNNING','PASSED','FAILED','PARTIAL')),
 phase text NOT NULL DEFAULT 'GREET' CHECK(phase ~ '^[A-Z0-9_]{1,40}$'),steps integer NOT NULL DEFAULT 0 CHECK(steps BETWEEN 0 AND 60),
 checks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(checks)='array' AND jsonb_array_length(checks)<=20),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,suite_id,run_id),UNIQUE(workspace_id,run_id),
 FOREIGN KEY(workspace_id,suite_id) REFERENCES commerce_number_lab.suites(workspace_id,id),
 FOREIGN KEY(workspace_id,run_id) REFERENCES commerce_number_lab.runs(workspace_id,id),
 CHECK((journey='PURCHASE')=(attachment_id IS NOT NULL))
);
CREATE INDEX number_lab_suite_running ON commerce_number_lab.suite_cases(state) WHERE state='RUNNING';
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['suites','suite_cases'] LOOP
  EXECUTE format('ALTER TABLE commerce_number_lab.%I OWNER TO commerce_number_lab_owner',n);
  EXECUTE format('ALTER TABLE commerce_number_lab.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE commerce_number_lab.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY profile_scope ON commerce_number_lab.%I USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')) WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),''''))',n);
  EXECUTE format('REVOKE ALL ON commerce_number_lab.%I FROM PUBLIC',n);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON commerce_number_lab.suites,commerce_number_lab.suite_cases TO commerce_api;
GRANT UPDATE(state,completed_at) ON commerce_number_lab.suites TO commerce_api;
GRANT SELECT ON commerce_number_lab.suites,commerce_number_lab.suite_cases TO commerce_number_lab;
GRANT UPDATE(state,completed_at) ON commerce_number_lab.suites TO commerce_number_lab;
GRANT UPDATE(state,phase,steps,checks,updated_at) ON commerce_number_lab.suite_cases TO commerce_number_lab;

-- Cross-profile discovery for the worker (same pattern as 0108): one ACTIVE
-- profile at a time with its own app.workspace_id; identifiers only. A case
-- is due when its run has no operation queued or in flight (an uncertain one
-- is returned so the worker closes the case as incomplete).
CREATE FUNCTION commerce_number_lab.active_suite_cases(p_limit integer)
RETURNS TABLE(workspace_id text,suite_id uuid,run_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p record; remaining integer:=p_limit; n integer;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>50 THEN RAISE EXCEPTION 'LAB_QUEUE_LIMIT'; END IF;
 PERFORM pg_catalog.set_config('app.workspace_id','',true);
 FOR p IN SELECT f.id FROM public.discover_worker_profiles() f WHERE f.state='ACTIVE' ORDER BY f.id LOOP
  EXIT WHEN remaining<=0;
  PERFORM pg_catalog.set_config('app.workspace_id',p.id,true);
  RETURN QUERY SELECT c.workspace_id,c.suite_id,c.run_id FROM commerce_number_lab.suite_cases c
   JOIN commerce_number_lab.suites s ON s.workspace_id=c.workspace_id AND s.id=c.suite_id AND s.state='RUNNING'
   JOIN commerce_number_lab.runs r ON r.workspace_id=c.workspace_id AND r.id=c.run_id AND r.expires_at>clock_timestamp()
   WHERE c.workspace_id=p.id AND c.state='RUNNING'
    AND NOT EXISTS(SELECT 1 FROM commerce_number_lab.operations o WHERE o.workspace_id=c.workspace_id AND o.run_id=c.run_id AND o.state IN('QUEUED','INTENT'))
   ORDER BY c.updated_at,c.run_id LIMIT remaining;
  GET DIAGNOSTICS n=ROW_COUNT;remaining:=remaining-n;
 END LOOP;
 PERFORM pg_catalog.set_config('app.workspace_id','',true);
END $$;
-- The next scripted step of a running case, as the person who started the
-- suite (same admission guards as any operation of the run).
CREATE FUNCTION commerce_number_lab.enqueue_suite_step(p_workspace text,p_suite uuid,p_run uuid,p_operation uuid,p_expected bigint,p_request text,p_action jsonb)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s commerce_number_lab.suites%ROWTYPE;
BEGIN
 IF p_workspace IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') THEN RAISE EXCEPTION 'LAB_PROFILE_SCOPE'; END IF;
 SELECT * INTO s FROM commerce_number_lab.suites WHERE workspace_id=p_workspace AND id=p_suite FOR SHARE;
 IF s.id IS NULL OR s.state<>'RUNNING' OR NOT EXISTS(SELECT 1 FROM commerce_number_lab.suite_cases c WHERE c.workspace_id=p_workspace AND c.suite_id=p_suite AND c.run_id=p_run AND c.state='RUNNING') THEN RAISE EXCEPTION 'LAB_SUITE_NOT_RUNNING'; END IF;
 INSERT INTO commerce_number_lab.operations(workspace_id,run_id,id,actor_id,request_sha256,expected_version,action_ciphertext) VALUES(p_workspace,p_run,p_operation,s.actor_id,p_request,p_expected,p_action);
END $$;
ALTER FUNCTION commerce_number_lab.active_suite_cases(integer) OWNER TO commerce_number_lab_owner;
ALTER FUNCTION commerce_number_lab.enqueue_suite_step(text,uuid,uuid,uuid,bigint,text,jsonb) OWNER TO commerce_number_lab_owner;
REVOKE ALL ON FUNCTION commerce_number_lab.active_suite_cases(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce_number_lab.enqueue_suite_step(text,uuid,uuid,uuid,bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_number_lab.active_suite_cases(integer),commerce_number_lab.enqueue_suite_step(text,uuid,uuid,uuid,bigint,text,jsonb) TO commerce_number_lab;
