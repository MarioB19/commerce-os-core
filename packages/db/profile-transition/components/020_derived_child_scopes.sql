-- Component 020: fixed-parent scope for all 18 historical child tables.
-- One DO statement is atomic. Local preparation only; native cutover needs the
-- complete reviewed catalog, backups, adoption and consumer closure.
DO $component$
DECLARE bindings jsonb := $bindings$[{"child":"effect_attempts","parent":"outbox","key":"effect_id"},{"child":"consumer_receipts","parent":"domain_events","key":"event_id"},{"child":"retention_plans","parent":"retention_policies","key":"policy_id"},{"child":"retention_files","parent":"retention_tombstones","key":"tombstone_id"},{"child":"warmup_rate_buckets","parent":"records","key":"account_id"},{"child":"warmup_rate_reservations","parent":"outbox","key":"effect_id"},{"child":"warmup_schedule_runs","parent":"warmup_pools","key":"pool_id"},{"child":"creative_attempts","parent":"creative_jobs","key":"job_id"},{"child":"creative_steps","parent":"creative_jobs","key":"job_id"},{"child":"creative_reviews","parent":"creative_artifacts","key":"artifact_id"},{"child":"creative_voice_brief_versions","parent":"creative_voice_briefs","key":"brief_id"},{"child":"creative_batch_versions","parent":"creative_batches","key":"batch_id"},{"child":"commercial_assignment_history","parent":"commercial_assignments","key":"assignment_id"},{"child":"warmup_simulated_events","parent":"warmup_simulation_runs","key":"run_id"},{"child":"warmup_manual_declarations","parent":"warmup_episodes","key":"episode_id"},{"child":"warmup_account_reservations","parent":"records","key":"account_id"},{"child":"warmup_group_receipts","parent":"outbox","key":"effect_id"},{"child":"outbox_gate_schedule","parent":"outbox","key":"effect_id"}]$bindings$;
 expected_triggers jsonb := $triggers$[{"table":"commercial_assignment_history","name":"immutable_assignment_history","sha256":"26b1b61ed41e27827e675dff27d98e416003638eeee3bb25b98d3366a4a4b9e9"},{"table":"creative_batch_versions","name":"creative_batch_version_immutable","sha256":"5be99c24cf6a498b4569d39e8234f1df6950526930c02a6cd5bb4a91c3b9e3ae"},{"table":"creative_reviews","name":"creative_review_immutable","sha256":"18d10d443418e6331726af3024b7821abc54cbc42b6764acc2033a0b8a5ddf2f"},{"table":"creative_voice_brief_versions","name":"creative_voice_brief_version_immutable","sha256":"d3c802c16886086d49823c950f31ae21f640c190cd659473cddea3d20473ad2b"},{"table":"warmup_manual_declarations","name":"immutable_manual_declarations","sha256":"3c3f31c588ea75f345400e97f3ce376c35b9166002517da4a88fd64bb728f4a0"}]$triggers$;
 binding jsonb; trigger_row jsonb; relation text; original text; before_count bigint; after_count bigint;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED'; END IF;
 -- Lock every parent and child in a deterministic order before reading data.
 FOR relation IN SELECT DISTINCT value FROM (
  SELECT value->>'child' AS value FROM jsonb_array_elements(bindings)
  UNION ALL SELECT value->>'parent' FROM jsonb_array_elements(bindings)
 ) all_relations ORDER BY value LOOP
  EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE',relation);
 END LOOP;
 CREATE TEMP TABLE profile_child_originals(table_name text NOT NULL,row_data jsonb NOT NULL) ON COMMIT DROP;
 CREATE TEMP TABLE profile_child_trigger_originals(table_name text NOT NULL,trigger_name text NOT NULL,definition text NOT NULL,definition_sha256 text NOT NULL) ON COMMIT DROP;
 FOR binding IN SELECT value FROM jsonb_array_elements(bindings) LOOP
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=format('public.%I',binding->>'child')::regclass AND attname IN('workspace_id','environment') AND NOT attisdropped) THEN RAISE EXCEPTION 'PROFILE_CHILD_ALREADY_ALTERED'; END IF;
  -- No data is dropped, assigned to another tenant, or silently skipped.
  EXECUTE format('SELECT count(*) FROM public.%I c LEFT JOIN public.%I p ON p.id=c.%I LEFT JOIN public.profiles adopted ON adopted.id=p.workspace_id WHERE p.id IS NULL OR adopted.id IS NULL OR p.environment NOT IN(''REAL'',''SIMULATION'') OR p.environment IS NULL',binding->>'child',binding->>'parent',binding->>'key') INTO before_count;
  IF before_count<>0 THEN RAISE EXCEPTION 'PROFILE_CHILD_PARENT_ADOPTION_REQUIRED'; END IF;
  EXECUTE format('INSERT INTO pg_temp.profile_child_originals SELECT %L,to_jsonb(c) FROM public.%I c',binding->>'child',binding->>'child');
 END LOOP;
 -- Only the five exact immutable triggers may be temporarily replaced. All
 -- other history/policy triggers remain active throughout the backfill.
 FOR trigger_row IN SELECT value FROM jsonb_array_elements(expected_triggers) LOOP
  SELECT pg_get_triggerdef(t.oid,true) INTO original FROM pg_trigger t WHERE t.tgrelid=format('public.%I',trigger_row->>'table')::regclass AND t.tgname=trigger_row->>'name' AND t.tgenabled='O' AND NOT t.tgisinternal;
  IF original IS NULL OR encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM trigger_row->>'sha256' THEN RAISE EXCEPTION 'PROFILE_CHILD_HISTORY_GUARD_CHANGED'; END IF;
  INSERT INTO pg_temp.profile_child_trigger_originals VALUES(trigger_row->>'table',trigger_row->>'name',original,trigger_row->>'sha256');
 END LOOP;
 EXECUTE $guard$
 CREATE FUNCTION pg_temp.profile_child_backfill_only() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
 BEGIN
  IF TG_OP<>'UPDATE' OR OLD.workspace_id IS NOT NULL OR OLD.environment IS NOT NULL OR NEW.workspace_id IS NULL OR NEW.environment NOT IN('REAL','SIMULATION')
   OR (to_jsonb(NEW)-ARRAY['workspace_id','environment']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['workspace_id','environment']) THEN RAISE EXCEPTION 'PROFILE_CHILD_HISTORY_IMMUTABLE'; END IF;
  RETURN NEW;
 END $body$
 $guard$;
 FOR binding IN SELECT value FROM jsonb_array_elements(bindings) LOOP
  EXECUTE format('ALTER TABLE public.%I ADD COLUMN workspace_id text,ADD COLUMN environment text',binding->>'child');
 END LOOP;
 FOR trigger_row IN SELECT value FROM jsonb_array_elements(expected_triggers) LOOP
  EXECUTE format('DROP TRIGGER %I ON public.%I',trigger_row->>'name',trigger_row->>'table');
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION pg_temp.profile_child_backfill_only()',trigger_row->>'name',trigger_row->>'table');
 END LOOP;
 FOR binding IN SELECT value FROM jsonb_array_elements(bindings) LOOP
  EXECUTE format('UPDATE public.%I c SET workspace_id=p.workspace_id,environment=p.environment FROM public.%I p WHERE p.id=c.%I',binding->>'child',binding->>'parent',binding->>'key');
  EXECUTE format('SELECT count(*) FROM ((SELECT row_data FROM pg_temp.profile_child_originals WHERE table_name=%L EXCEPT ALL SELECT to_jsonb(c)-ARRAY[''workspace_id'',''environment''] FROM public.%I c) UNION ALL (SELECT to_jsonb(c)-ARRAY[''workspace_id'',''environment''] FROM public.%I c EXCEPT ALL SELECT row_data FROM pg_temp.profile_child_originals WHERE table_name=%L)) differences',binding->>'child',binding->>'child',binding->>'child',binding->>'child') INTO after_count;
  IF after_count<>0 THEN RAISE EXCEPTION 'PROFILE_CHILD_HISTORY_CHANGED'; END IF;
  EXECUTE format('ALTER TABLE public.%I ALTER COLUMN workspace_id SET NOT NULL,ALTER COLUMN environment SET NOT NULL,ADD CONSTRAINT profile_child_environment CHECK(environment IN(''REAL'',''SIMULATION'')),ADD CONSTRAINT profile_child_profile FOREIGN KEY(workspace_id) REFERENCES public.profiles(id)',binding->>'child');
  -- A named additional key is deliberate; no old FK or uniqueness is removed.
  IF NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=format('public.%I',binding->>'parent')::regclass AND k.conname='v7_child_parent_'||(binding->>'parent') AND k.contype='u') THEN
   EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE(id,workspace_id,environment)',binding->>'parent','v7_child_parent_'||(binding->>'parent'));
  END IF;
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT profile_child_parent FOREIGN KEY(%I,workspace_id,environment) REFERENCES public.%I(id,workspace_id,environment)',binding->>'child',binding->>'key',binding->>'parent');
 END LOOP;
 FOR trigger_row IN SELECT value FROM jsonb_array_elements(expected_triggers) LOOP
  SELECT definition INTO original FROM pg_temp.profile_child_trigger_originals WHERE table_name=trigger_row->>'table' AND trigger_name=trigger_row->>'name';
  EXECUTE format('DROP TRIGGER %I ON public.%I',trigger_row->>'name',trigger_row->>'table');EXECUTE original;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=format('public.%I',trigger_row->>'table')::regclass AND t.tgname=trigger_row->>'name' AND t.tgenabled='O' AND encode(sha256(convert_to(pg_get_triggerdef(t.oid,true),'UTF8')),'hex')=trigger_row->>'sha256') THEN RAISE EXCEPTION 'PROFILE_CHILD_HISTORY_GUARD_NOT_RESTORED'; END IF;
 END LOOP;
 EXECUTE $runtime_guard$
 CREATE FUNCTION public.bind_profile_child_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
 DECLARE parent_table text; parent_key text; scope record; parent_id uuid;
 BEGIN
  CASE TG_TABLE_NAME
   WHEN 'effect_attempts' THEN parent_table:='outbox';parent_key:='effect_id';
   WHEN 'consumer_receipts' THEN parent_table:='domain_events';parent_key:='event_id';
   WHEN 'retention_plans' THEN parent_table:='retention_policies';parent_key:='policy_id';
   WHEN 'retention_files' THEN parent_table:='retention_tombstones';parent_key:='tombstone_id';
   WHEN 'warmup_rate_buckets' THEN parent_table:='records';parent_key:='account_id';
   WHEN 'warmup_rate_reservations' THEN parent_table:='outbox';parent_key:='effect_id';
   WHEN 'warmup_schedule_runs' THEN parent_table:='warmup_pools';parent_key:='pool_id';
   WHEN 'creative_attempts' THEN parent_table:='creative_jobs';parent_key:='job_id';
   WHEN 'creative_steps' THEN parent_table:='creative_jobs';parent_key:='job_id';
   WHEN 'creative_reviews' THEN parent_table:='creative_artifacts';parent_key:='artifact_id';
   WHEN 'creative_voice_brief_versions' THEN parent_table:='creative_voice_briefs';parent_key:='brief_id';
   WHEN 'creative_batch_versions' THEN parent_table:='creative_batches';parent_key:='batch_id';
   WHEN 'commercial_assignment_history' THEN parent_table:='commercial_assignments';parent_key:='assignment_id';
   WHEN 'warmup_simulated_events' THEN parent_table:='warmup_simulation_runs';parent_key:='run_id';
   WHEN 'warmup_manual_declarations' THEN parent_table:='warmup_episodes';parent_key:='episode_id';
   WHEN 'warmup_account_reservations' THEN parent_table:='records';parent_key:='account_id';
   WHEN 'warmup_group_receipts' THEN parent_table:='outbox';parent_key:='effect_id';
   WHEN 'outbox_gate_schedule' THEN parent_table:='outbox';parent_key:='effect_id';
   ELSE RAISE EXCEPTION 'PROFILE_CHILD_TABLE_UNREVIEWED';
  END CASE;
  parent_id:=(to_jsonb(NEW)->>parent_key)::uuid;
  IF TG_OP='UPDATE' AND ((to_jsonb(OLD)->>parent_key) IS DISTINCT FROM parent_id::text OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.environment IS DISTINCT FROM NEW.environment) THEN RAISE EXCEPTION 'PROFILE_CHILD_SCOPE_IMMUTABLE'; END IF;
  EXECUTE format('SELECT workspace_id,environment FROM public.%I WHERE id=$1',parent_table) INTO scope USING parent_id;
  IF scope.workspace_id IS NULL OR scope.environment IS NULL OR current_setting('app.workspace_id',true) IS DISTINCT FROM scope.workspace_id OR current_setting('app.environment',true) IS DISTINCT FROM scope.environment THEN RAISE EXCEPTION 'PROFILE_CHILD_CONTEXT_REQUIRED'; END IF;
  IF (NEW.workspace_id IS NOT NULL AND NEW.workspace_id IS DISTINCT FROM scope.workspace_id) OR (NEW.environment IS NOT NULL AND NEW.environment IS DISTINCT FROM scope.environment) THEN RAISE EXCEPTION 'PROFILE_CHILD_SCOPE_CHANGED'; END IF;
  NEW.workspace_id:=scope.workspace_id;NEW.environment:=scope.environment;RETURN NEW;
 END $body$
 $runtime_guard$;
 REVOKE ALL ON FUNCTION public.bind_profile_child_scope() FROM PUBLIC;
 FOR binding IN SELECT value FROM jsonb_array_elements(bindings) LOOP
  EXECUTE format('CREATE TRIGGER bind_profile_child_scope BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.bind_profile_child_scope()',binding->>'child');
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',binding->>'child');
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',binding->>'child');
  EXECUTE format($policy$CREATE POLICY profile_child_access ON public.%I USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''))$policy$,binding->>'child');
  EXECUTE format($policy$CREATE POLICY profile_child_restriction ON public.%I AS RESTRICTIVE USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''))$policy$,binding->>'child');
 END LOOP;
 DROP FUNCTION pg_temp.profile_child_backfill_only();
 DROP TABLE pg_temp.profile_child_originals,pg_temp.profile_child_trigger_originals;
END
$component$;
