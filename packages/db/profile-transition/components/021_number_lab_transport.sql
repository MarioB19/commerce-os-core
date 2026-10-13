-- Dedicated fresh engine database only, before sealing its installation marker.
-- Shared dispatch and ACK consumers use these finite operational tables.
DO $$ DECLARE n text;occupied boolean;BEGIN
 IF current_database() !~ '^commerce_lab_engine_[a-z0-9_]+$' OR to_regclass('commerce_number_lab_engine.installation') IS NULL THEN RAISE EXCEPTION 'LAB_ENGINE_DATABASE_REQUIRED';END IF;
 IF EXISTS(SELECT 1 FROM commerce_number_lab_engine.installation) THEN RAISE EXCEPTION 'LAB_ENGINE_ALREADY_SEALED';END IF;
 FOREACH n IN ARRAY ARRAY['effect_attempts','outbox_gate_schedule','number_dispatch_slots','number_capacity_slots','inbound_envelopes','consumer_receipts','warmup_conversations','warmup_simulation_runs','warmup_turns'] LOOP
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I)',n) INTO occupied;
  IF occupied THEN RAISE EXCEPTION 'LAB_ENGINE_EMPTY_DATABASE_REQUIRED: %',n;END IF;
 END LOOP;
END $$;
GRANT UPDATE(claim_id,claimed_at,attempts,provider_message_id) ON outbox TO commerce_lab_engine;
GRANT SELECT,INSERT,UPDATE ON effect_attempts,inbound_envelopes,number_dispatch_slots TO commerce_lab_engine;
GRANT SELECT,INSERT ON consumer_receipts TO commerce_lab_engine;
GRANT SELECT,INSERT,UPDATE,DELETE ON outbox_gate_schedule TO commerce_lab_engine;
DO $$ DECLARE n text;condition text;BEGIN
 FOREACH n IN ARRAY ARRAY['effect_attempts','outbox_gate_schedule','number_dispatch_slots','inbound_envelopes','consumer_receipts'] LOOP
  condition:=CASE
   WHEN n IN('effect_attempts','outbox_gate_schedule') THEN 'EXISTS(SELECT 1 FROM public.outbox o WHERE o.id=effect_id AND o.workspace_id=current_setting(''app.workspace_id'',true) AND o.environment=''SIMULATION'')'
   WHEN n='consumer_receipts' THEN 'consumer=''channel-v1'' AND EXISTS(SELECT 1 FROM public.domain_events e WHERE e.id=event_id AND e.workspace_id=current_setting(''app.workspace_id'',true) AND e.environment=''SIMULATION'' AND e.event_type=''provider.ack.observed'')'
   ELSE 'workspace_id=current_setting(''app.workspace_id'',true) AND environment=''SIMULATION''' END;
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY lab_transport_scope ON public.%I TO commerce_lab_engine USING(%s) WITH CHECK(%s)',n,condition,condition);
  EXECUTE format('CREATE POLICY lab_transport_scope_restrictive ON public.%I AS RESTRICTIVE TO commerce_lab_engine USING(%s) WITH CHECK(%s)',n,condition,condition);
 END LOOP;
 -- Physical capacity and warm-up data cannot exist in a commercial-only lab.
 FOREACH n IN ARRAY ARRAY['number_capacity_slots','warmup_conversations','warmup_simulation_runs','warmup_turns'] LOOP
  EXECUTE format('GRANT SELECT ON public.%I TO commerce_lab_engine',n);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY lab_transport_empty ON public.%I TO commerce_lab_engine USING(false)',n);
  EXECUTE format('CREATE POLICY lab_transport_empty_restrictive ON public.%I AS RESTRICTIVE TO commerce_lab_engine USING(false) WITH CHECK(false)',n);
 END LOOP;
END $$;

-- V7 RF-19.o (D-18): when a test's 30 days end, the platform maintenance
-- (superuser only; no grant) removes everything the run left in this engine:
-- every scoped row of its workspace and its execution/driver receipts.
CREATE FUNCTION commerce_number_lab_engine.purge_run(p_run uuid) RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t record;w text:='number-lab:'||p_run::text;n integer:=0;c integer;
BEGIN
 IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN RAISE EXCEPTION 'LAB_RETENTION_SUPERUSER_REQUIRED'; END IF;
 IF p_run IS NULL THEN RAISE EXCEPTION 'LAB_RETENTION_RUN_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM commerce_number_lab_engine.executions e WHERE e.run_id=p_run AND e.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'LAB_RETENTION_RUN_NOT_EXPIRED'; END IF;
 PERFORM set_config('session_replication_role','replica',true);
 FOR t IN SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables x ON x.table_schema=c.table_schema AND x.table_name=c.table_name AND x.table_type='BASE TABLE'
   WHERE c.table_schema='public' AND c.column_name='workspace_id' ORDER BY c.table_name LOOP
  EXECUTE format('DELETE FROM public.%I WHERE workspace_id::text=$1',t.table_name) USING w;GET DIAGNOSTICS c=ROW_COUNT;n:=n+c;
 END LOOP;
 DELETE FROM commerce_number_lab_engine.driver_receipts WHERE run_id=p_run;GET DIAGNOSTICS c=ROW_COUNT;n:=n+c;
 DELETE FROM commerce_number_lab_engine.materializations WHERE run_id=p_run;GET DIAGNOSTICS c=ROW_COUNT;n:=n+c;
 DELETE FROM commerce_number_lab_engine.executions WHERE run_id=p_run;GET DIAGNOSTICS c=ROW_COUNT;n:=n+c;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION commerce_number_lab_engine.purge_run(uuid) FROM PUBLIC;
