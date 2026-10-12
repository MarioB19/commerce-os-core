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
