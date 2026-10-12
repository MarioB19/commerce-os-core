-- V7 F2 cutover: Composed 020 scope components: identity bootstrap, derived children, ownership, privileged readers, Meta, idempotency and manual controls.
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> V7 F2: explicit quarantine before the 020 scope components.
-- A control or channel-ownership row whose exact historical record does not
-- exist in the same workspace cannot receive an environment without inventing
-- one. It is moved, byte for byte, to an owner-only quarantine ledger instead
-- of being assigned to any profile. Such rows were already inert: every
-- historical reader matches them by the exact record ID and workspace.
CREATE TABLE profile_adoption_quarantine(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 table_name text NOT NULL CHECK(table_name IN('manual_controls','session_ownership','ownership_isolation_receipts')),
 reason text NOT NULL CHECK(reason IN('SCOPE_RECORD_MISSING','WORKSPACE_SCOPE_MISMATCH','CHANNEL_ACCOUNT_MISSING')),
 workspace_id text NOT NULL,
 row_data jsonb NOT NULL CHECK(jsonb_typeof(row_data)='object'),
 quarantined_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_profile_adoption_quarantine BEFORE UPDATE OR DELETE ON profile_adoption_quarantine FOR EACH ROW EXECUTE FUNCTION immutable_row();
REVOKE ALL ON profile_adoption_quarantine FROM PUBLIC,commerce_api,commerce_ingress,commerce_automation,commerce_channel,commerce_maintenance;
DO $quarantine$
DECLARE before_total bigint; after_total bigint; moved bigint;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED'; END IF;
 LOCK TABLE public.manual_controls,public.session_ownership,public.ownership_isolation_receipts,public.records,public.copy_source_isolation_challenges IN ACCESS EXCLUSIVE MODE;
 SELECT (SELECT count(*) FROM public.manual_controls)+(SELECT count(*) FROM public.session_ownership)+(SELECT count(*) FROM public.ownership_isolation_receipts) INTO before_total;
 IF EXISTS(SELECT 1 FROM public.ownership_isolation_receipts o JOIN public.copy_source_isolation_challenges c ON c.completed_receipt_id=o.id
  WHERE NOT EXISTS(SELECT 1 FROM public.records r WHERE r.id=o.account_id AND r.workspace_id=o.workspace_id AND r.kind='channel_account')) THEN
  RAISE EXCEPTION 'V7_REFERENCED_OWNERSHIP_RECEIPT_ORPHAN';
 END IF;
 WITH moved_rows AS (DELETE FROM public.manual_controls m WHERE m.scope_type='workspace' AND m.scope_id IS DISTINCT FROM m.workspace_id RETURNING m.*)
 INSERT INTO public.profile_adoption_quarantine(table_name,reason,workspace_id,row_data) SELECT 'manual_controls','WORKSPACE_SCOPE_MISMATCH',workspace_id,to_jsonb(moved_rows) FROM moved_rows;
 WITH moved_rows AS (DELETE FROM public.manual_controls m WHERE m.scope_type<>'workspace' AND NOT EXISTS(SELECT 1 FROM public.records r
   WHERE r.id::text=m.scope_id AND r.workspace_id=m.workspace_id AND r.kind=m.scope_type) RETURNING m.*)
 INSERT INTO public.profile_adoption_quarantine(table_name,reason,workspace_id,row_data) SELECT 'manual_controls','SCOPE_RECORD_MISSING',workspace_id,to_jsonb(moved_rows) FROM moved_rows;
 WITH moved_rows AS (DELETE FROM public.session_ownership s WHERE NOT EXISTS(SELECT 1 FROM public.records r
   WHERE r.id::text=s.account_id AND r.workspace_id=s.workspace_id AND r.kind='channel_account') RETURNING s.*)
 INSERT INTO public.profile_adoption_quarantine(table_name,reason,workspace_id,row_data) SELECT 'session_ownership','CHANNEL_ACCOUNT_MISSING',workspace_id,to_jsonb(moved_rows) FROM moved_rows;
 WITH moved_rows AS (DELETE FROM public.ownership_isolation_receipts o WHERE NOT EXISTS(SELECT 1 FROM public.records r
   WHERE r.id=o.account_id AND r.workspace_id=o.workspace_id AND r.kind='channel_account') RETURNING o.*)
 INSERT INTO public.profile_adoption_quarantine(table_name,reason,workspace_id,row_data) SELECT 'ownership_isolation_receipts','CHANNEL_ACCOUNT_MISSING',workspace_id,to_jsonb(moved_rows) FROM moved_rows;
 SELECT count(*) INTO moved FROM public.profile_adoption_quarantine;
 SELECT (SELECT count(*) FROM public.manual_controls)+(SELECT count(*) FROM public.session_ownership)+(SELECT count(*) FROM public.ownership_isolation_receipts) INTO after_total;
 IF after_total+moved<>before_total OR EXISTS(SELECT 1 FROM public.profile_adoption_quarantine q LEFT JOIN public.profiles p ON p.id=q.workspace_id WHERE p.id IS NULL) THEN
  RAISE EXCEPTION 'V7_QUARANTINE_COUNT_MISMATCH';
 END IF;
END $quarantine$;
-- <<< end quarantine

-- >>> promoted from packages/db/profile-transition/components/020_profile_identity_bootstrap.sql (source sha256 5cd1876cee602630d4a65fb2742d447e28a4e13a4b829d419781616b5491e8c7)
-- V7 F2: 0 role-existence refusal(s) and 1 CREATE ROLE replaced by v7_ensure_reviewed_role (adopts only the exact reviewed safe attributes).
-- Component of the reviewed 020 cutover. Not an automatic migration.
-- Run only as the schema migration owner, in the same atomic data transition.
SELECT public.v7_ensure_reviewed_role('commerce_profile_bootstrap_owner',false);
GRANT USAGE ON SCHEMA public TO commerce_profile_bootstrap_owner;
GRANT SELECT(id,"userId","expiresAt"),UPDATE(id) ON session TO commerce_profile_bootstrap_owner;
GRANT SELECT(user_id,workspace_id,role,active,version),UPDATE(user_id) ON memberships TO commerce_profile_bootstrap_owner;
GRANT SELECT(id,business_name,state,timezone,version),UPDATE(id) ON profiles TO commerce_profile_bootstrap_owner;
GRANT SELECT,INSERT,UPDATE ON profile_session_context TO commerce_profile_bootstrap_owner;
CREATE POLICY profile_bootstrap_membership ON memberships TO commerce_profile_bootstrap_owner USING(true);
CREATE POLICY profile_bootstrap_profile ON profiles TO commerce_profile_bootstrap_owner USING(true);
CREATE POLICY profile_bootstrap_selection ON profile_session_context TO commerce_profile_bootstrap_owner USING(true) WITH CHECK(true);

CREATE FUNCTION list_authenticated_profile_choices(native_session text,native_user text)
RETURNS TABLE(id text,business_name text,state text,timezone text,role text,membership_version integer,selected boolean,selection_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'PROFILE_BOOTSTRAP_OUTSIDE_SCOPE_REQUIRED'; END IF;
 IF native_session IS NULL OR length(native_session)=0 OR native_user IS NULL OR length(native_user)=0 THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
 PERFORM 1 FROM public.session s WHERE s.id=native_session AND s."userId"=native_user AND s."expiresAt">clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
 IF (SELECT count(*) FROM public.memberships m JOIN public.profiles p ON p.id=m.workspace_id WHERE m.user_id=native_user AND m.active)>3 THEN RAISE EXCEPTION 'PROFILE_BOOTSTRAP_BOUND'; END IF;
 IF EXISTS(SELECT 1 FROM public.memberships m JOIN public.profiles p ON p.id=m.workspace_id WHERE m.user_id=native_user AND m.active AND (m.role NOT IN('owner','operator','viewer') OR m.version<1 OR p.version<1)) THEN RAISE EXCEPTION 'PROFILE_ROLE_ADOPTION_REQUIRED'; END IF;
 RETURN QUERY SELECT p.id,p.business_name,p.state,p.timezone,m.role,m.version,
  COALESCE(c.workspace_id=p.id AND c.membership_version=m.version,false),c.version
 FROM public.memberships m JOIN public.profiles p ON p.id=m.workspace_id
 LEFT JOIN public.profile_session_context c ON c.session_id=native_session AND c.user_id=native_user
 WHERE m.user_id=native_user AND m.active ORDER BY p.business_name,p.id FOR SHARE OF m,p;
 PERFORM 1 FROM public.session s WHERE s.id=native_session AND s."userId"=native_user AND s."expiresAt">clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
END $$;
ALTER FUNCTION list_authenticated_profile_choices(text,text) OWNER TO commerce_profile_bootstrap_owner;
REVOKE ALL ON FUNCTION list_authenticated_profile_choices(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_authenticated_profile_choices(text,text) TO commerce_api;

CREATE FUNCTION select_authenticated_profile(native_session text,native_user text,target_profile text,expected_version integer)
RETURNS TABLE(workspace_id text,version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old_selection public.profile_session_context%ROWTYPE; member_row record; profile_row record;
BEGIN
 IF NULLIF(current_setting('app.workspace_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'PROFILE_BOOTSTRAP_OUTSIDE_SCOPE_REQUIRED'; END IF;
 IF native_session IS NULL OR length(native_session)=0 OR native_user IS NULL OR length(native_user)=0 THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
 IF target_profile IS NULL OR length(target_profile) NOT BETWEEN 1 AND 256 OR expected_version IS NULL OR expected_version<0 OR expected_version>=2147483647 THEN RAISE EXCEPTION 'PROFILE_SELECTION_INVALID'; END IF;
 PERFORM 1 FROM public.session s WHERE s.id=native_session AND s."userId"=native_user AND s."expiresAt">clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
 SELECT c.* INTO old_selection FROM public.profile_session_context c WHERE c.session_id=native_session AND c.user_id=native_user FOR UPDATE;
 IF COALESCE(old_selection.version,0)<>expected_version THEN RAISE EXCEPTION 'PROFILE_SELECTION_CHANGED'; END IF;
 SELECT m.role,m.active,m.version INTO member_row FROM public.memberships m WHERE m.user_id=native_user AND m.workspace_id=target_profile FOR SHARE;
 IF NOT FOUND OR member_row.active IS DISTINCT FROM true THEN RAISE EXCEPTION 'PROFILE_MEMBERSHIP_REQUIRED'; END IF;
 IF member_row.role NOT IN('owner','operator','viewer') OR member_row.version<1 THEN RAISE EXCEPTION 'PROFILE_ROLE_ADOPTION_REQUIRED'; END IF;
 SELECT p.state,p.version INTO profile_row FROM public.profiles p WHERE p.id=target_profile FOR SHARE;
 IF NOT FOUND OR profile_row.state NOT IN('ACTIVE','SUSPENDED') OR profile_row.version<1 THEN RAISE EXCEPTION 'PROFILE_UNAVAILABLE'; END IF;
 PERFORM 1 FROM public.session s WHERE s.id=native_session AND s."userId"=native_user AND s."expiresAt">clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
 RETURN QUERY INSERT INTO public.profile_session_context AS c(session_id,user_id,workspace_id,membership_version,version)
 VALUES(native_session,native_user,target_profile,member_row.version,1)
 ON CONFLICT(session_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,membership_version=EXCLUDED.membership_version,version=c.version+1,updated_at=clock_timestamp()
 WHERE c.user_id=native_user AND c.version=expected_version RETURNING c.workspace_id,c.version;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_SELECTION_CHANGED'; END IF;
 PERFORM 1 FROM public.session s WHERE s.id=native_session AND s."userId"=native_user AND s."expiresAt">clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_SESSION_EXPIRED'; END IF;
END $$;
ALTER FUNCTION select_authenticated_profile(text,text,text,integer) OWNER TO commerce_profile_bootstrap_owner;
REVOKE ALL ON FUNCTION select_authenticated_profile(text,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION select_authenticated_profile(text,text,text,integer) TO commerce_api;
-- <<< end components/020_profile_identity_bootstrap.sql

-- >>> promoted from packages/db/profile-transition/components/020_derived_child_scopes.sql (source sha256 a15e24fe684c7fc977d74dc086aed6c9f35ac158aa9e70f06dc8b06bc251f361)
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
-- <<< end components/020_derived_child_scopes.sql

-- >>> promoted from packages/db/profile-transition/components/020_ownership_scopes.sql (source sha256 427ad00fbc60ba938a05096cca9aa14a2906c1aa4393c785979c72d09bd2f1af)
-- Local component. Native execution requires the reviewed complete cutover.
DO $ownership$
DECLARE relation text; differences bigint;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED'; END IF;
 LOCK TABLE public.ownership_isolation_receipts,public.profiles,public.records,public.session_ownership IN ACCESS EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid IN('public.ownership_isolation_receipts'::regclass,'public.session_ownership'::regclass) AND attname IN('environment','account_record_id') AND NOT attisdropped) THEN RAISE EXCEPTION 'PROFILE_OWNERSHIP_ALREADY_ALTERED'; END IF;
 -- Joining the original text without a cast rejects noncanonical and orphan
 -- identities without rewriting them or manufacturing a default environment.
 IF EXISTS(SELECT 1 FROM public.session_ownership s LEFT JOIN public.records a ON a.id::text=s.account_id LEFT JOIN public.profiles p ON p.id=a.workspace_id WHERE a.id IS NULL OR p.id IS NULL OR a.kind<>'channel_account' OR a.workspace_id<>s.workspace_id OR a.environment NOT IN('REAL','SIMULATION'))
 OR EXISTS(SELECT 1 FROM public.ownership_isolation_receipts s LEFT JOIN public.records a ON a.id=s.account_id LEFT JOIN public.profiles p ON p.id=a.workspace_id WHERE a.id IS NULL OR p.id IS NULL OR a.kind<>'channel_account' OR a.workspace_id<>s.workspace_id OR a.environment NOT IN('REAL','SIMULATION')) THEN RAISE EXCEPTION 'PROFILE_OWNERSHIP_PARENT_ADOPTION_REQUIRED'; END IF;
 CREATE TEMP TABLE profile_ownership_originals(table_name text NOT NULL,row_data jsonb NOT NULL) ON COMMIT DROP;
 INSERT INTO pg_temp.profile_ownership_originals SELECT 'session_ownership',to_jsonb(s) FROM public.session_ownership s;
 INSERT INTO pg_temp.profile_ownership_originals SELECT 'ownership_isolation_receipts',to_jsonb(s) FROM public.ownership_isolation_receipts s;
 ALTER TABLE public.session_ownership ADD COLUMN environment text,ADD COLUMN account_record_id uuid GENERATED ALWAYS AS (account_id::uuid) STORED;
 ALTER TABLE public.ownership_isolation_receipts ADD COLUMN environment text;
 UPDATE public.session_ownership s SET environment=a.environment FROM public.records a WHERE a.id::text=s.account_id;
 UPDATE public.ownership_isolation_receipts s SET environment=a.environment FROM public.records a WHERE a.id=s.account_id;
 FOR relation IN SELECT unnest(ARRAY['session_ownership','ownership_isolation_receipts']) LOOP
  EXECUTE format('SELECT count(*) FROM ((SELECT row_data FROM pg_temp.profile_ownership_originals WHERE table_name=%L EXCEPT ALL SELECT to_jsonb(s)-ARRAY[''environment'',''account_record_id''] FROM public.%I s) UNION ALL (SELECT to_jsonb(s)-ARRAY[''environment'',''account_record_id''] FROM public.%I s EXCEPT ALL SELECT row_data FROM pg_temp.profile_ownership_originals WHERE table_name=%L)) x',relation,relation,relation,relation) INTO differences;
  IF differences<>0 THEN RAISE EXCEPTION 'PROFILE_OWNERSHIP_HISTORY_CHANGED'; END IF;
  EXECUTE format('ALTER TABLE public.%I ALTER COLUMN environment SET NOT NULL,ADD CONSTRAINT profile_ownership_environment CHECK(environment IN(''REAL'',''SIMULATION'')),ADD CONSTRAINT profile_ownership_profile FOREIGN KEY(workspace_id) REFERENCES public.profiles(id)',relation);
 END LOOP;
 ALTER TABLE public.records ADD CONSTRAINT v7_ownership_parent_records UNIQUE(id,workspace_id,environment);
 ALTER TABLE public.session_ownership ALTER COLUMN account_record_id SET NOT NULL,ADD CONSTRAINT profile_ownership_canonical_id CHECK(account_id=account_record_id::text),ADD CONSTRAINT profile_ownership_parent FOREIGN KEY(account_record_id,workspace_id,environment) REFERENCES public.records(id,workspace_id,environment);
 ALTER TABLE public.ownership_isolation_receipts ADD CONSTRAINT profile_ownership_parent FOREIGN KEY(account_id,workspace_id,environment) REFERENCES public.records(id,workspace_id,environment);
 EXECUTE $guard$
 CREATE FUNCTION public.bind_profile_ownership_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
 DECLARE parent record;
 BEGIN
  IF TG_TABLE_NAME NOT IN('session_ownership','ownership_isolation_receipts') THEN RAISE EXCEPTION 'PROFILE_OWNERSHIP_TABLE_UNREVIEWED'; END IF;
  IF TG_OP='UPDATE' AND (NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.environment IS DISTINCT FROM OLD.environment) THEN RAISE EXCEPTION 'PROFILE_OWNERSHIP_IDENTITY_IMMUTABLE'; END IF;
  SELECT workspace_id,environment INTO parent FROM public.records WHERE id=NEW.account_id::text::uuid AND id::text=NEW.account_id::text AND kind='channel_account';
  IF NOT FOUND OR parent.workspace_id IS DISTINCT FROM NEW.workspace_id OR current_setting('app.workspace_id',true) IS DISTINCT FROM parent.workspace_id OR current_setting('app.environment',true) IS DISTINCT FROM parent.environment THEN RAISE EXCEPTION 'PROFILE_OWNERSHIP_CONTEXT_REQUIRED'; END IF;
  IF NEW.environment IS NOT NULL AND NEW.environment IS DISTINCT FROM parent.environment THEN RAISE EXCEPTION 'PROFILE_OWNERSHIP_ENVIRONMENT_CHANGED'; END IF;
  NEW.environment:=parent.environment;RETURN NEW;
 END $body$
 $guard$;
 REVOKE ALL ON FUNCTION public.bind_profile_ownership_scope() FROM PUBLIC;
 FOR relation IN SELECT unnest(ARRAY['session_ownership','ownership_isolation_receipts']) LOOP
  EXECUTE format('CREATE TRIGGER bind_profile_ownership_scope BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.bind_profile_ownership_scope()',relation);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format($policy$CREATE POLICY profile_ownership_access ON public.%I USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''))$policy$,relation);
  EXECUTE format($policy$CREATE POLICY profile_ownership_restriction ON public.%I AS RESTRICTIVE USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''))$policy$,relation);
 END LOOP;
 DROP TABLE pg_temp.profile_ownership_originals;
END
$ownership$;
-- <<< end components/020_ownership_scopes.sql

-- >>> promoted from packages/db/profile-transition/components/020_privileged_read_scopes.sql (source sha256 4fcb60dfb21b04cf8cd408ea70ff5e60d7ae90f3595b2a34180037639fefc84d)
-- V7 F2: 0 role-existence refusal(s) and 2 CREATE ROLE replaced by v7_ensure_reviewed_role (adopts only the exact reviewed safe attributes).
-- Local component of the reviewed cutover; no native invocation is authorized.
DO $readers$
DECLARE spec record; definition text; relation text;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED'; END IF;
 LOCK TABLE public.copy_source_isolation_challenges,public.memberships,public.operation_authorizations,public.ownership_isolation_receipts,public.records,public.channel_sessions IN ACCESS EXCLUSIVE MODE;
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.ownership_isolation_receipts'::regclass AND attname='environment' AND attnotnull AND NOT attisdropped) THEN RAISE EXCEPTION 'PROFILE_OWNERSHIP_SCOPE_REQUIRED'; END IF;
 FOR spec IN SELECT * FROM (VALUES
  ('public.read_locked_operation_authorization(uuid,text,text)','e5690ca0bc9008f8fc34a05c6fcf982cc7aed93c6de8dc1a2046046bcff78dbe',ARRAY['commerce_api','commerce_automation','commerce_channel']),
  ('public.read_copy_source_isolation_receipt(uuid,text,text,integer,uuid)','d6931b401611a98bdd4db5e669cedc25ddc9ff7974af3715641973bed1990d73',ARRAY['commerce_channel'])
 ) v(identity,sha,callers) LOOP
  SELECT pg_get_functiondef(p.oid) INTO definition FROM pg_proc p WHERE p.oid=to_regprocedure(spec.identity) AND p.prosecdef;
  IF definition IS NULL OR encode(sha256(convert_to(definition,'UTF8')),'hex')<>spec.sha THEN RAISE EXCEPTION 'PROFILE_READER_DEFINITION_DRIFT'; END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee
    WHERE p.oid=to_regprocedure(spec.identity) AND a.grantee<>p.proowner AND (r.rolname IS NULL OR NOT r.rolname=ANY(spec.callers) OR a.privilege_type<>'EXECUTE' OR a.is_grantable)) THEN RAISE EXCEPTION 'PROFILE_READER_ACL_DRIFT'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(spec.callers) expected(name) WHERE NOT EXISTS(
   SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a JOIN pg_roles r ON r.oid=a.grantee
   WHERE p.oid=to_regprocedure(spec.identity) AND r.rolname=expected.name AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)) THEN RAISE EXCEPTION 'PROFILE_READER_ACL_DRIFT'; END IF;
 END LOOP;
 PERFORM public.v7_ensure_reviewed_role('commerce_authorization_reader',false);
 PERFORM public.v7_ensure_reviewed_role('commerce_isolation_reader',false);
 GRANT USAGE ON SCHEMA public TO commerce_authorization_reader,commerce_isolation_reader;
 GRANT SELECT,UPDATE(id) ON public.operation_authorizations TO commerce_authorization_reader;
 GRANT SELECT(id,account_id,workspace_id,environment,previous_owner_id,generation,method,consumed_at,verified_at),UPDATE(id) ON public.ownership_isolation_receipts TO commerce_isolation_reader;
 GRANT SELECT(id,account_id,workspace_id,environment,completed_receipt_id,previous_owner_id,generation,source_project,billing_enabled,technical_observed_at,issued_at,primary_revocation_reported_at,primary_report_source,expires_at,credential_generation,primary_device_id,responsible_user_id),UPDATE(id) ON public.copy_source_isolation_challenges TO commerce_isolation_reader;
 GRANT SELECT(id,account_id,workspace_id,environment,credential_generation,primary_device_id,responsible_user_id,archived_at),UPDATE(id) ON public.channel_sessions TO commerce_isolation_reader;
 GRANT SELECT(id,workspace_id,environment,kind,body),UPDATE(id) ON public.records TO commerce_isolation_reader;
 GRANT SELECT(user_id,workspace_id,active),UPDATE(user_id) ON public.memberships TO commerce_isolation_reader;
 CREATE POLICY authorization_reader_scope ON public.operation_authorizations TO commerce_authorization_reader USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''));
 CREATE POLICY authorization_reader_scope_guard ON public.operation_authorizations AS RESTRICTIVE TO commerce_authorization_reader USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''));
 FOREACH relation IN ARRAY ARRAY['ownership_isolation_receipts','copy_source_isolation_challenges','channel_sessions','records'] LOOP
  EXECUTE format($policy$CREATE POLICY isolation_reader_scope ON public.%I TO commerce_isolation_reader USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL')$policy$,relation);
  EXECUTE format($policy$CREATE POLICY isolation_reader_scope_guard ON public.%I AS RESTRICTIVE TO commerce_isolation_reader USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL')$policy$,relation);
 END LOOP;
 CREATE POLICY isolation_reader_membership ON public.memberships TO commerce_isolation_reader USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND current_setting('app.environment',true)='REAL');
 CREATE POLICY isolation_reader_membership_guard ON public.memberships AS RESTRICTIVE TO commerce_isolation_reader USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND current_setting('app.environment',true)='REAL');
 EXECUTE $function$
 CREATE OR REPLACE FUNCTION public.read_locked_operation_authorization(authorization_id uuid,workspace text,env text)
 RETURNS SETOF public.operation_authorizations LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
 DECLARE v_authorization public.operation_authorizations%ROWTYPE;
 BEGIN
  IF authorization_id IS NULL OR workspace IS NULL OR workspace='' OR env IS NULL OR env NOT IN('REAL','SIMULATION')
   OR current_setting('app.workspace_id',true) IS DISTINCT FROM workspace OR current_setting('app.environment',true) IS DISTINCT FROM env THEN RAISE EXCEPTION 'PROFILE_READER_CONTEXT_REQUIRED'; END IF;
  SELECT a.* INTO v_authorization FROM public.operation_authorizations a WHERE a.id=authorization_id AND a.workspace_id=workspace AND a.environment=env FOR SHARE;
  IF NOT FOUND OR v_authorization.revoked_at IS NOT NULL OR v_authorization.expires_at<=clock_timestamp() THEN RETURN; END IF;
  RETURN NEXT v_authorization;
 END $body$
 $function$;
 ALTER FUNCTION public.read_locked_operation_authorization(uuid,text,text) OWNER TO commerce_authorization_reader;
 REVOKE ALL ON FUNCTION public.read_locked_operation_authorization(uuid,text,text) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION public.read_locked_operation_authorization(uuid,text,text) TO commerce_api,commerce_automation,commerce_channel;
 EXECUTE $function$
 CREATE OR REPLACE FUNCTION public.read_copy_source_isolation_receipt(p_account_id uuid,p_workspace_id text,p_previous_owner_id text,p_generation integer,p_receipt_id uuid)
 RETURNS TABLE(id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
 DECLARE v_receipt uuid;
 BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_workspace_id='' OR p_previous_owner_id IS NULL OR p_previous_owner_id='' OR p_generation IS NULL OR p_generation<1
   OR current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace_id OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' THEN RAISE EXCEPTION 'PROFILE_READER_CONTEXT_REQUIRED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('channel-command:'||p_account_id::text,0));
  SELECT r.id INTO v_receipt FROM public.ownership_isolation_receipts r
  WHERE r.account_id=p_account_id AND r.workspace_id=p_workspace_id AND r.environment='REAL' AND r.previous_owner_id=p_previous_owner_id AND r.generation=p_generation
   AND r.method='source_billing_disabled_and_primary_device_revoked' AND r.consumed_at IS NULL
   AND (p_receipt_id IS NULL OR r.id=p_receipt_id) ORDER BY r.verified_at DESC LIMIT 1 FOR UPDATE;
  IF v_receipt IS NULL THEN RETURN; END IF;
  -- Keep authority bindings locked through COMMIT, then re-evaluate clock time.
 PERFORM r.id FROM public.ownership_isolation_receipts r
  JOIN public.copy_source_isolation_challenges c ON c.completed_receipt_id=r.id AND c.account_id=r.account_id AND c.workspace_id=r.workspace_id
  JOIN public.channel_sessions s ON s.account_id=c.account_id AND s.workspace_id=c.workspace_id AND s.environment=c.environment
  JOIN public.records a ON a.id=c.account_id AND a.workspace_id=c.workspace_id AND a.environment=c.environment
  JOIN public.memberships m ON m.workspace_id=c.workspace_id AND m.user_id=c.responsible_user_id AND m.active
  WHERE r.id=v_receipt AND r.account_id=p_account_id AND r.workspace_id=p_workspace_id AND r.previous_owner_id=p_previous_owner_id AND r.generation=p_generation AND r.environment='REAL'
   AND r.method='source_billing_disabled_and_primary_device_revoked' AND r.consumed_at IS NULL
   AND r.verified_at<=clock_timestamp() AND r.verified_at>clock_timestamp()-interval '24 hours'
   AND c.previous_owner_id=r.previous_owner_id AND c.generation=r.generation
   AND c.environment='REAL' AND c.source_project='vibe-conversa-prod' AND NOT c.billing_enabled
   AND c.technical_observed_at<=c.issued_at AND c.technical_observed_at>r.verified_at-interval '24 hours'
   AND c.primary_revocation_reported_at>=c.issued_at AND c.primary_revocation_reported_at<=r.verified_at
   AND c.primary_report_source IN ('owner_confirmation','personal_owner_report')
   AND c.expires_at>clock_timestamp() AND c.credential_generation=s.credential_generation
   AND c.primary_device_id=s.primary_device_id AND c.responsible_user_id=s.responsible_user_id
   AND s.archived_at IS NULL AND a.kind='channel_account' AND a.body->>'provider'='waha'
   AND (p_receipt_id::uuid IS NULL OR r.id=p_receipt_id) ORDER BY r.verified_at DESC LIMIT 1 FOR SHARE OF c,s,a,m;
  IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT r.id FROM public.ownership_isolation_receipts r
  JOIN public.copy_source_isolation_challenges c ON c.completed_receipt_id=r.id AND c.account_id=r.account_id AND c.workspace_id=r.workspace_id
  JOIN public.channel_sessions s ON s.account_id=c.account_id AND s.workspace_id=c.workspace_id AND s.environment=c.environment
  JOIN public.records a ON a.id=c.account_id AND a.workspace_id=c.workspace_id AND a.environment=c.environment
  WHERE r.id=v_receipt AND r.account_id=p_account_id AND r.workspace_id=p_workspace_id AND r.previous_owner_id=p_previous_owner_id AND r.generation=p_generation AND r.environment='REAL'
   AND r.method='source_billing_disabled_and_primary_device_revoked' AND r.consumed_at IS NULL
   AND r.verified_at<=clock_timestamp() AND r.verified_at>clock_timestamp()-interval '24 hours'
   AND c.previous_owner_id=r.previous_owner_id AND c.generation=r.generation
   AND c.environment='REAL' AND c.source_project='vibe-conversa-prod' AND NOT c.billing_enabled
   AND c.technical_observed_at<=c.issued_at AND c.technical_observed_at>r.verified_at-interval '24 hours'
   AND c.primary_revocation_reported_at>=c.issued_at AND c.primary_revocation_reported_at<=r.verified_at
   AND c.primary_report_source IN ('owner_confirmation','personal_owner_report')
   AND c.expires_at>clock_timestamp() AND c.credential_generation=s.credential_generation
   AND c.primary_device_id=s.primary_device_id AND c.responsible_user_id=s.responsible_user_id
   AND s.archived_at IS NULL AND a.kind='channel_account' AND a.body->>'provider'='waha'
   AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=c.workspace_id AND m.user_id=c.responsible_user_id AND m.active)
   AND (p_receipt_id::uuid IS NULL OR r.id=p_receipt_id) ORDER BY r.verified_at DESC LIMIT 1;
 END $body$
 $function$;
 ALTER FUNCTION public.read_copy_source_isolation_receipt(uuid,text,text,integer,uuid) OWNER TO commerce_isolation_reader;
 REVOKE ALL ON FUNCTION public.read_copy_source_isolation_receipt(uuid,text,text,integer,uuid) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION public.read_copy_source_isolation_receipt(uuid,text,text,integer,uuid) TO commerce_channel;
END
$readers$;
-- <<< end components/020_privileged_read_scopes.sql

-- >>> promoted from packages/db/profile-transition/components/020_meta_inventory_scopes.sql (source sha256 3109e5ffa5cf450cd3e3e2ad0e55cbfb5576f40105fe359c5eec166442bac14f)
-- Historical META_API inventories are exclusively REAL. No trigger is disabled.
DO $meta_scope$
DECLARE differences bigint; relation text;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED';END IF;
 LOCK TABLE public.meta_syncs,public.meta_links,public.profiles IN ACCESS EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.meta_syncs'::regclass AND attname='environment' AND NOT attisdropped) THEN RAISE EXCEPTION 'PROFILE_META_ALREADY_ALTERED';END IF;
 IF EXISTS(SELECT 1 FROM public.meta_syncs s LEFT JOIN public.profiles p ON p.id=s.workspace_id WHERE p.id IS NULL OR (s.inventory->>'source'='META_API') IS NOT TRUE)
 OR EXISTS(SELECT 1 FROM public.meta_links l LEFT JOIN public.meta_syncs s ON(s.id,s.workspace_id)=(l.sync_id,l.workspace_id) WHERE s.id IS NULL OR l.environment IS DISTINCT FROM 'REAL') THEN RAISE EXCEPTION 'PROFILE_META_ADOPTION_REQUIRED';END IF;
 CREATE TEMP TABLE profile_meta_originals(table_name text,row_data jsonb) ON COMMIT DROP;
 INSERT INTO pg_temp.profile_meta_originals SELECT 'meta_syncs',to_jsonb(s) FROM public.meta_syncs s;
 INSERT INTO pg_temp.profile_meta_originals SELECT 'meta_links',to_jsonb(l) FROM public.meta_links l;
 ALTER TABLE public.meta_syncs ADD COLUMN environment text GENERATED ALWAYS AS ('REAL'::text) STORED NOT NULL;
 ALTER TABLE public.meta_syncs ADD CONSTRAINT profile_meta_source CHECK((inventory->>'source'='META_API') IS TRUE),ADD CONSTRAINT profile_meta_scope_identity UNIQUE(id,workspace_id,environment),ADD CONSTRAINT profile_meta_profile FOREIGN KEY(workspace_id) REFERENCES public.profiles(id);
 ALTER TABLE public.meta_links ADD CONSTRAINT profile_meta_parent FOREIGN KEY(sync_id,workspace_id,environment) REFERENCES public.meta_syncs(id,workspace_id,environment);
 FOR relation IN SELECT unnest(ARRAY['meta_syncs','meta_links']) LOOP
  EXECUTE format('SELECT count(*) FROM ((SELECT row_data FROM pg_temp.profile_meta_originals WHERE table_name=%L EXCEPT ALL SELECT %s FROM public.%I s) UNION ALL (SELECT %s FROM public.%I s EXCEPT ALL SELECT row_data FROM pg_temp.profile_meta_originals WHERE table_name=%L)) x',relation,CASE WHEN relation='meta_syncs' THEN 'to_jsonb(s)-''environment''' ELSE 'to_jsonb(s)' END,relation,CASE WHEN relation='meta_syncs' THEN 'to_jsonb(s)-''environment''' ELSE 'to_jsonb(s)' END,relation,relation) INTO differences;
  IF differences<>0 THEN RAISE EXCEPTION 'PROFILE_META_HISTORY_CHANGED';END IF;
 END LOOP;
 EXECUTE $function$
 CREATE FUNCTION public.bind_profile_meta_inventory() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
 BEGIN
  IF TG_TABLE_NAME NOT IN('meta_syncs','meta_links') OR current_setting('app.workspace_id',true) IS DISTINCT FROM NEW.workspace_id OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' THEN RAISE EXCEPTION 'PROFILE_META_CONTEXT_REQUIRED';END IF;
  RETURN NEW;
 END $body$
 $function$;
 REVOKE ALL ON FUNCTION public.bind_profile_meta_inventory() FROM PUBLIC;
 FOR relation IN SELECT unnest(ARRAY['meta_syncs','meta_links']) LOOP
  EXECUTE format('CREATE TRIGGER bind_profile_meta_inventory BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.bind_profile_meta_inventory()',relation);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',relation);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format($policy$CREATE POLICY profile_meta_access ON public.%I USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''))$policy$,relation);
  EXECUTE format($policy$CREATE POLICY profile_meta_restriction ON public.%I AS RESTRICTIVE USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''))$policy$,relation);
 END LOOP;
 DROP TABLE pg_temp.profile_meta_originals;
END $meta_scope$;
-- <<< end components/020_meta_inventory_scopes.sql

-- >>> V7 F2: deterministic idempotency adoption map (input of the next component).
-- Built inside this migration from the stored rows only; no external input.
-- Environment evidence, in order: the stored response's own environment, the
-- environment of its data object. Encrypted, retained or silent responses are
-- assigned REAL. That assignment only decides where an old key replays: the
-- primary key still spans both environments, so a retry from the other
-- environment fails with a conflict and never executes the operation twice.
CREATE TEMP TABLE profile_idempotency_scope_adoptions(workspace_id text,actor_id text,operation text,key text,row_sha256 text,environment text,evidence_sha256 text) ON COMMIT DROP;
INSERT INTO pg_temp.profile_idempotency_scope_adoptions(workspace_id,actor_id,operation,key,row_sha256,environment,evidence_sha256)
SELECT i.workspace_id,i.actor_id,i.operation,i.key,h.row_sha256,e.environment,
 encode(public.digest(convert_to(jsonb_build_array('v7-idempotency-adoption/v1',e.rule,h.row_sha256)::text,'UTF8'),'sha256'),'hex')
FROM public.idempotency i
CROSS JOIN LATERAL (SELECT encode(public.digest(convert_to(to_jsonb(i)::text,'UTF8'),'sha256'),'hex') AS row_sha256) h
CROSS JOIN LATERAL (SELECT CASE
  WHEN jsonb_typeof(i.response)='object' AND i.response->>'environment' IN('REAL','SIMULATION') THEN i.response->>'environment'
  WHEN jsonb_typeof(i.response)='object' AND jsonb_typeof(i.response->'data')='object' AND i.response->'data'->>'environment' IN('REAL','SIMULATION') THEN i.response->'data'->>'environment'
  ELSE 'REAL' END AS environment,CASE
  WHEN jsonb_typeof(i.response)='object' AND i.response->>'environment' IN('REAL','SIMULATION') THEN 'RESPONSE_ENVIRONMENT'
  WHEN jsonb_typeof(i.response)='object' AND jsonb_typeof(i.response->'data')='object' AND i.response->'data'->>'environment' IN('REAL','SIMULATION') THEN 'RESPONSE_DATA_ENVIRONMENT'
  ELSE 'UNPROVEN_REPLAY_ONLY_IN_REAL' END AS rule) e;
-- <<< end idempotency adoption map

-- >>> promoted from packages/db/profile-transition/components/020_idempotency_scopes.sql (source sha256 59a34a8e69fe29af513564301315db254ac183832f196f09d8a95a06c05042a2)
-- Requires an independently authenticated complete historical adoption map.
-- pg_temp.profile_idempotency_scope_adoptions columns (all text):
-- workspace_id,actor_id,operation,key,row_sha256,environment,evidence_sha256.
-- row_sha256 = encode(digest(convert_to(to_jsonb(original_row)::text,'UTF8'),'sha256'),'hex').
DO $idempotency_scope$
DECLARE differences bigint;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED';END IF;
 LOCK TABLE public.idempotency,public.profiles IN ACCESS EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.idempotency'::regclass AND attname IN('environment','scope_adoption_sha256') AND NOT attisdropped) THEN RAISE EXCEPTION 'PROFILE_IDEMPOTENCY_ALREADY_ALTERED';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=to_regclass('pg_temp.profile_idempotency_scope_adoptions') AND c.relnamespace=pg_my_temp_schema() AND c.relpersistence='t' AND c.relkind='r' AND r.rolname=current_user) THEN RAISE EXCEPTION 'PROFILE_IDEMPOTENCY_MAP_REQUIRED';END IF;
 IF (SELECT count(*) FROM pg_temp.profile_idempotency_scope_adoptions)<>(SELECT count(*) FROM public.idempotency)
 OR EXISTS(SELECT 1 FROM pg_temp.profile_idempotency_scope_adoptions GROUP BY workspace_id,actor_id,operation,key HAVING count(*)<>1)
 OR EXISTS(SELECT 1 FROM pg_temp.profile_idempotency_scope_adoptions a LEFT JOIN public.idempotency i ON(i.workspace_id,i.actor_id,i.operation,i.key)=(a.workspace_id,a.actor_id,a.operation,a.key) LEFT JOIN public.profiles p ON p.id=i.workspace_id WHERE i.key IS NULL OR p.id IS NULL OR
  (a.environment IN('REAL','SIMULATION') AND a.evidence_sha256 ~ '^[a-f0-9]{64}$' AND a.row_sha256=encode(public.digest(convert_to(to_jsonb(i)::text,'UTF8'),'sha256'),'hex')) IS NOT TRUE)
 THEN RAISE EXCEPTION 'PROFILE_IDEMPOTENCY_ADOPTION_REQUIRED';END IF;
 CREATE TEMP TABLE profile_idempotency_originals(row_data jsonb) ON COMMIT DROP;
 INSERT INTO pg_temp.profile_idempotency_originals SELECT to_jsonb(i) FROM public.idempotency i;
 ALTER TABLE public.idempotency ADD COLUMN environment text,ADD COLUMN scope_adoption_sha256 text;
 UPDATE public.idempotency i SET environment=a.environment,scope_adoption_sha256=a.evidence_sha256 FROM pg_temp.profile_idempotency_scope_adoptions a WHERE(i.workspace_id,i.actor_id,i.operation,i.key)=(a.workspace_id,a.actor_id,a.operation,a.key);
 SELECT count(*) INTO differences FROM ((SELECT row_data FROM pg_temp.profile_idempotency_originals EXCEPT ALL SELECT to_jsonb(i)-ARRAY['environment','scope_adoption_sha256'] FROM public.idempotency i) UNION ALL (SELECT to_jsonb(i)-ARRAY['environment','scope_adoption_sha256'] FROM public.idempotency i EXCEPT ALL SELECT row_data FROM pg_temp.profile_idempotency_originals)) x;
 IF differences<>0 THEN RAISE EXCEPTION 'PROFILE_IDEMPOTENCY_HISTORY_CHANGED';END IF;
 ALTER TABLE public.idempotency ALTER COLUMN environment SET NOT NULL,ADD CONSTRAINT profile_idempotency_environment CHECK(environment IN('REAL','SIMULATION')),ADD CONSTRAINT profile_idempotency_adoption CHECK(scope_adoption_sha256 IS NULL OR scope_adoption_sha256 ~ '^[a-f0-9]{64}$'),ADD CONSTRAINT profile_idempotency_profile FOREIGN KEY(workspace_id) REFERENCES public.profiles(id);
 EXECUTE $function$
 CREATE FUNCTION public.bind_profile_idempotency() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
 DECLARE env text:=NULLIF(current_setting('app.environment',true),'');
 BEGIN
  IF current_setting('app.workspace_id',true) IS DISTINCT FROM NEW.workspace_id OR (env IN('REAL','SIMULATION')) IS NOT TRUE THEN RAISE EXCEPTION 'PROFILE_IDEMPOTENCY_CONTEXT_REQUIRED';END IF;
  IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.actor_id,NEW.operation,NEW.key,NEW.environment,NEW.scope_adoption_sha256) IS DISTINCT FROM(OLD.workspace_id,OLD.actor_id,OLD.operation,OLD.key,OLD.environment,OLD.scope_adoption_sha256) THEN RAISE EXCEPTION 'PROFILE_IDEMPOTENCY_IDENTITY_IMMUTABLE';END IF;
  IF TG_OP='INSERT' AND NEW.scope_adoption_sha256 IS NOT NULL THEN RAISE EXCEPTION 'PROFILE_IDEMPOTENCY_ADOPTION_RUNTIME_FORBIDDEN';END IF;
  IF NEW.environment IS NOT NULL AND NEW.environment IS DISTINCT FROM env THEN RAISE EXCEPTION 'PROFILE_IDEMPOTENCY_ENVIRONMENT_CHANGED';END IF;
  NEW.environment:=env;RETURN NEW;
 END $body$
 $function$;
 REVOKE ALL ON FUNCTION public.bind_profile_idempotency() FROM PUBLIC;
 CREATE TRIGGER bind_profile_idempotency BEFORE INSERT OR UPDATE ON public.idempotency FOR EACH ROW EXECUTE FUNCTION public.bind_profile_idempotency();
 ALTER TABLE public.idempotency ENABLE ROW LEVEL SECURITY;ALTER TABLE public.idempotency FORCE ROW LEVEL SECURITY;
 CREATE POLICY profile_idempotency_access ON public.idempotency USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''));
 CREATE POLICY profile_idempotency_restriction ON public.idempotency AS RESTRICTIVE USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''));
 DROP TABLE pg_temp.profile_idempotency_originals;
END $idempotency_scope$;
-- <<< end components/020_idempotency_scopes.sql

-- >>> promoted from packages/db/profile-transition/components/020_manual_control_scopes.sql (source sha256 66ea96f9548ae58fd73f5b0924f83dce7b8577b1852a2a0a0c5ef07eb258dcf8)
-- Workspace-wide stops remain shared safety controls; record controls do not.
DO $control_scope$
DECLARE differences bigint;
BEGIN
 IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED';END IF;
 LOCK TABLE public.manual_controls,public.records,public.profiles IN ACCESS EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.manual_controls'::regclass AND attname IN('environment','scope_record_id') AND NOT attisdropped) THEN RAISE EXCEPTION 'PROFILE_CONTROL_ALREADY_ALTERED';END IF;
 IF EXISTS(SELECT 1 FROM public.manual_controls m LEFT JOIN public.profiles p ON p.id=m.workspace_id LEFT JOIN public.records r ON r.id::text=m.scope_id AND r.workspace_id=m.workspace_id AND r.kind=m.scope_type
 WHERE p.id IS NULL OR (m.scope_type='workspace' AND m.scope_id IS DISTINCT FROM m.workspace_id) OR (m.scope_type<>'workspace' AND r.id IS NULL)) THEN RAISE EXCEPTION 'PROFILE_CONTROL_ADOPTION_REQUIRED';END IF;
 CREATE TEMP TABLE profile_control_originals(row_data jsonb) ON COMMIT DROP;
 INSERT INTO pg_temp.profile_control_originals SELECT to_jsonb(m) FROM public.manual_controls m;
 ALTER TABLE public.manual_controls ADD COLUMN environment text,ADD COLUMN scope_record_id uuid GENERATED ALWAYS AS(CASE WHEN scope_type='workspace' THEN NULL ELSE scope_id::uuid END) STORED;
 UPDATE public.manual_controls m SET environment=r.environment FROM public.records r WHERE m.scope_type<>'workspace' AND r.id::text=m.scope_id AND r.workspace_id=m.workspace_id AND r.kind=m.scope_type;
 SELECT count(*) INTO differences FROM ((SELECT row_data FROM pg_temp.profile_control_originals EXCEPT ALL SELECT to_jsonb(m)-ARRAY['environment','scope_record_id'] FROM public.manual_controls m) UNION ALL(SELECT to_jsonb(m)-ARRAY['environment','scope_record_id'] FROM public.manual_controls m EXCEPT ALL SELECT row_data FROM pg_temp.profile_control_originals)) d;
 IF differences<>0 THEN RAISE EXCEPTION 'PROFILE_CONTROL_HISTORY_CHANGED';END IF;
 CREATE UNIQUE INDEX profile_control_record_identity ON public.records(id,workspace_id,environment,kind);
 ALTER TABLE public.manual_controls ADD CONSTRAINT profile_control_shape CHECK(((scope_type='workspace' AND scope_id=workspace_id AND environment IS NULL) OR(scope_type<>'workspace' AND environment IN('REAL','SIMULATION'))) IS TRUE),
 ADD CONSTRAINT profile_control_profile FOREIGN KEY(workspace_id) REFERENCES public.profiles(id),
 ADD CONSTRAINT profile_control_parent FOREIGN KEY(scope_record_id,workspace_id,environment,scope_type) REFERENCES public.records(id,workspace_id,environment,kind);
 EXECUTE $function$
 CREATE FUNCTION public.bind_profile_manual_control() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
 DECLARE env text:=NULLIF(current_setting('app.environment',true),'');parent_environment text;
 BEGIN
  IF TG_OP='DELETE' THEN
   IF current_setting('app.workspace_id',true) IS DISTINCT FROM OLD.workspace_id OR (env IN('REAL','SIMULATION')) IS NOT TRUE OR (OLD.scope_type='workspace' AND env<>'REAL') OR (OLD.scope_type<>'workspace' AND OLD.environment IS DISTINCT FROM env) THEN RAISE EXCEPTION 'PROFILE_CONTROL_CONTEXT_REQUIRED';END IF;
   RETURN OLD;
  END IF;
  IF current_setting('app.workspace_id',true) IS DISTINCT FROM NEW.workspace_id OR (env IN('REAL','SIMULATION')) IS NOT TRUE THEN RAISE EXCEPTION 'PROFILE_CONTROL_CONTEXT_REQUIRED';END IF;
  IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.scope_type,NEW.scope_id,NEW.environment) IS DISTINCT FROM(OLD.workspace_id,OLD.scope_type,OLD.scope_id,OLD.environment) THEN RAISE EXCEPTION 'PROFILE_CONTROL_IDENTITY_IMMUTABLE';END IF;
  IF NEW.scope_type='workspace' THEN
   IF env<>'REAL' THEN RAISE EXCEPTION 'PROFILE_CONTROL_GLOBAL_REAL_REQUIRED';END IF;
   IF NEW.scope_id IS DISTINCT FROM NEW.workspace_id OR NEW.environment IS NOT NULL THEN RAISE EXCEPTION 'PROFILE_CONTROL_GLOBAL_SCOPE_INVALID';END IF;
  ELSE
   SELECT r.environment INTO parent_environment FROM public.records r WHERE r.id::text=NEW.scope_id AND r.workspace_id=NEW.workspace_id AND r.kind=NEW.scope_type FOR SHARE;
   IF NOT FOUND OR parent_environment IS DISTINCT FROM env THEN RAISE EXCEPTION 'PROFILE_CONTROL_PARENT_REQUIRED';END IF;
   IF NEW.environment IS NOT NULL AND NEW.environment IS DISTINCT FROM parent_environment THEN RAISE EXCEPTION 'PROFILE_CONTROL_ENVIRONMENT_CHANGED';END IF;
   NEW.environment:=parent_environment;
  END IF;
  RETURN NEW;
 END $body$
 $function$;
 REVOKE ALL ON FUNCTION public.bind_profile_manual_control() FROM PUBLIC;
 CREATE TRIGGER bind_profile_manual_control BEFORE INSERT OR UPDATE OR DELETE ON public.manual_controls FOR EACH ROW EXECUTE FUNCTION public.bind_profile_manual_control();
 ALTER TABLE public.manual_controls ENABLE ROW LEVEL SECURITY;ALTER TABLE public.manual_controls FORCE ROW LEVEL SECURITY;
 CREATE POLICY profile_control_access ON public.manual_controls USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND current_setting('app.environment',true) IN('REAL','SIMULATION') AND(scope_type='workspace' OR environment=current_setting('app.environment',true)))
 WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND((scope_type='workspace' AND current_setting('app.environment',true)='REAL') OR(scope_type<>'workspace' AND environment=current_setting('app.environment',true))));
 CREATE POLICY profile_control_restriction ON public.manual_controls AS RESTRICTIVE USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND current_setting('app.environment',true) IN('REAL','SIMULATION') AND(scope_type='workspace' OR environment=current_setting('app.environment',true)))
 WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND((scope_type='workspace' AND current_setting('app.environment',true)='REAL') OR(scope_type<>'workspace' AND environment=current_setting('app.environment',true))));
 DROP TABLE pg_temp.profile_control_originals;
END $control_scope$;
-- <<< end components/020_manual_control_scopes.sql
