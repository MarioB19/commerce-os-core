-- Explicit participant adoption only. Historical rows/policies/effects are not rewritten.
CREATE TABLE warmup_continuity_adoptions (
 id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 account_id uuid NOT NULL,pool_id uuid NOT NULL,profile_id uuid NOT NULL,episode_id uuid,
 version integer NOT NULL CHECK(version>0),previous_id uuid REFERENCES warmup_continuity_adoptions(id),
 origin text NOT NULL CHECK(origin IN('MIGRATION_QR','QR_RELINK')),operation_id uuid NOT NULL,actor_id text NOT NULL CHECK(length(actor_id)>0),
 grant_id uuid NOT NULL,identity_fingerprint text NOT NULL CHECK(identity_fingerprint ~ '^[a-f0-9]{64}$'),
 policy_version text NOT NULL CHECK(policy_version IN('legacy-30d/v1','standard-15d/v1','standard-15d/v2')),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,environment,account_id,version),UNIQUE(workspace_id,environment,operation_id),
 UNIQUE(id,workspace_id,environment),
 FOREIGN KEY(account_id,workspace_id,environment) REFERENCES warmup_states(account_id,workspace_id,environment),
 FOREIGN KEY(pool_id,workspace_id,environment) REFERENCES warmup_pools(id,workspace_id,environment),
 FOREIGN KEY(profile_id,workspace_id,environment) REFERENCES warmup_profiles(id,workspace_id,environment),
 FOREIGN KEY(episode_id,workspace_id,environment) REFERENCES warmup_episodes(id,workspace_id,environment),
 FOREIGN KEY(workspace_id,environment,grant_id) REFERENCES continuous_authorizations(workspace_id,environment,id),
 CHECK(((origin='MIGRATION_QR' AND version=1 AND previous_id IS NULL) OR (origin='QR_RELINK' AND version>1 AND previous_id IS NOT NULL)) IS TRUE),
 CHECK((snapshot->>'workspaceId'=workspace_id AND snapshot->>'environment'=environment AND snapshot->>'accountId'=account_id::text
  AND snapshot->>'poolId'=pool_id::text AND snapshot->>'profileId'=profile_id::text AND snapshot->>'policyVersion'=policy_version
  AND snapshot->>'grantId'=grant_id::text AND snapshot->>'identityFingerprint'=identity_fingerprint
  AND (snapshot->>'episodeId')::uuid IS NOT DISTINCT FROM episode_id) IS TRUE)
);
ALTER TABLE warmup_continuity_adoptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup_continuity_adoptions FORCE ROW LEVEL SECURITY;
CREATE POLICY own_profile ON warmup_continuity_adoptions USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
CREATE FUNCTION guard_legacy_qr_adoption() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE old public.warmup_continuity_adoptions%ROWTYPE; st public.warmup_states%ROWTYPE;
 pool public.warmup_pools%ROWTYPE; profile public.warmup_profiles%ROWTYPE;
 episode public.warmup_episodes%ROWTYPE; grant_state jsonb; connection uuid; item jsonb; live_profile record; group_version integer;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'QR_ADOPTION_IMMUTABLE'; END IF;
 IF current_setting('app.workspace_id',true) IS DISTINCT FROM NEW.workspace_id THEN RAISE EXCEPTION 'QR_ADOPTION_PROFILE_REQUIRED'; END IF;
 IF NEW.origin='MIGRATION_QR' THEN
  IF current_user<>'commerce_api' THEN RAISE EXCEPTION 'QR_ADOPTION_OWNER_REQUIRED'; END IF;
  SELECT id,state INTO live_profile FROM public.profiles WHERE id=NEW.workspace_id FOR SHARE;
  IF NOT FOUND OR live_profile.state<>'ACTIVE' THEN RAISE EXCEPTION 'QR_ADOPTION_OWNER_REQUIRED'; END IF;
  PERFORM 1 FROM public.memberships WHERE workspace_id=NEW.workspace_id AND user_id=NEW.actor_id AND role='owner' AND active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'QR_ADOPTION_OWNER_REQUIRED'; END IF;
 ELSE
  IF current_user NOT IN('commerce_channel','commerce_automation') THEN RAISE EXCEPTION 'QR_ADOPTION_WORKER_REQUIRED'; END IF;
  SELECT * INTO live_profile FROM public.read_locked_continuous_worker_profile();
  IF live_profile.id IS DISTINCT FROM NEW.workspace_id OR live_profile.state IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'QR_ADOPTION_PROFILE_REQUIRED'; END IF;
 END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended(jsonb_build_array('qr-adoption',NEW.workspace_id,NEW.environment,NEW.account_id)::text,0)) THEN RAISE EXCEPTION 'QR_ADOPTION_BUSY'; END IF;
 SELECT * INTO old FROM public.warmup_continuity_adoptions WHERE workspace_id=NEW.workspace_id AND environment=NEW.environment AND account_id=NEW.account_id ORDER BY version DESC LIMIT 1 FOR SHARE;
 IF (old.id IS NULL AND NEW.version<>1) OR (old.id IS NOT NULL AND (NEW.version<>old.version+1 OR NEW.previous_id IS DISTINCT FROM old.id)) THEN RAISE EXCEPTION 'QR_ADOPTION_VERSION_CHANGED'; END IF;
 SELECT * INTO st FROM public.warmup_states WHERE workspace_id=NEW.workspace_id AND environment=NEW.environment AND account_id=NEW.account_id FOR SHARE;
 SELECT * INTO pool FROM public.warmup_pools WHERE id=st.pool_id AND workspace_id=NEW.workspace_id AND environment=NEW.environment FOR SHARE;
 SELECT * INTO profile FROM public.warmup_profiles WHERE id=st.profile_id AND workspace_id=NEW.workspace_id AND environment=NEW.environment;
 IF st.account_id IS NULL OR pool.id IS NULL OR profile.id IS NULL OR pool.continuity_mode<>'LEGACY'
  OR pool.id IS DISTINCT FROM NEW.pool_id OR pool.profile_id IS DISTINCT FROM st.profile_id OR profile.id IS DISTINCT FROM NEW.profile_id OR st.episode_id IS DISTINCT FROM NEW.episode_id
  OR COALESCE(profile.config->>'policy_version','legacy-30d/v1') IS DISTINCT FROM NEW.policy_version
  OR pool.topology IS DISTINCT FROM NEW.snapshot->>'topology' OR pool.purpose IS DISTINCT FROM NEW.snapshot->>'purpose'
  OR pool.program_id IS DISTINCT FROM (NEW.snapshot->>'programId')::uuid OR pool.group_id IS DISTINCT FROM (NEW.snapshot->>'groupId')::uuid
  OR st.version IS DISTINCT FROM (NEW.snapshot->>'stateVersion')::integer OR pool.archived_at IS NOT NULL THEN RAISE EXCEPTION 'QR_ADOPTION_SNAPSHOT_CHANGED'; END IF;
 IF st.episode_id IS NOT NULL THEN
  SELECT * INTO episode FROM public.warmup_episodes WHERE id=st.episode_id AND workspace_id=NEW.workspace_id AND environment=NEW.environment;
  IF episode.id IS NULL OR episode.account_id IS DISTINCT FROM NEW.account_id OR episode.policy_version IS DISTINCT FROM NEW.policy_version OR episode.closed_at IS NOT NULL OR episode.identity_fingerprint IS DISTINCT FROM NEW.identity_fingerprint THEN RAISE EXCEPTION 'QR_ADOPTION_EPISODE_CHANGED'; END IF;
 ELSIF NEW.policy_version<>'legacy-30d/v1' THEN RAISE EXCEPTION 'QR_ADOPTION_EPISODE_CHANGED'; END IF;
 IF pool.group_id IS NOT NULL THEN
  SELECT version INTO group_version FROM public.warmup_groups WHERE id=pool.group_id AND workspace_id=NEW.workspace_id AND environment=NEW.environment;
  IF group_version IS DISTINCT FROM (NEW.snapshot->>'groupVersion')::integer THEN RAISE EXCEPTION 'QR_ADOPTION_GROUP_CHANGED'; END IF;
 ELSIF NEW.snapshot->>'groupVersion' IS NOT NULL THEN RAISE EXCEPTION 'QR_ADOPTION_GROUP_CHANGED'; END IF;
 SELECT c.id INTO connection FROM public.commands c WHERE c.workspace_id=NEW.workspace_id AND c.environment=NEW.environment AND c.resource_id=NEW.account_id::text
  AND c.kind='channel_command' AND c.payload->>'type'='connect' AND c.status='APPLIED' ORDER BY c.created_at DESC,c.id DESC LIMIT 1;
 SELECT a.state INTO grant_state FROM public.continuous_authorizations a JOIN public.channel_sessions s ON s.account_id=a.account_id AND s.workspace_id=a.workspace_id AND s.environment=a.environment
  WHERE a.workspace_id=NEW.workspace_id AND a.environment=NEW.environment AND a.id=NEW.grant_id AND a.account_id=NEW.account_id
   AND a.qr_command_id=connection AND a.state->'source'->>'identityFingerprint'=s.expected_identity_fingerprint
   AND s.expected_identity_fingerprint=NEW.identity_fingerprint AND s.archived_at IS NULL FOR SHARE OF a,s;
 IF grant_state IS NULL OR grant_state->'revokedAt'<>'null'::jsonb OR (grant_state->>'humanPaused')::boolean OR grant_state->'protections'<>'[]'::jsonb
  OR NEW.snapshot->>'connectionId' IS DISTINCT FROM connection::text THEN RAISE EXCEPTION 'QR_ADOPTION_AUTHORITY_CHANGED'; END IF;
 PERFORM public.lock_continuous_human_scope(NEW.workspace_id,NEW.environment,NEW.account_id,grant_state->'source');
 IF public.continuous_human_pause(NEW.workspace_id,NEW.environment,NEW.account_id,grant_state->'source') THEN RAISE EXCEPTION 'QR_ADOPTION_AUTHORITY_CHANGED'; END IF;
 IF jsonb_typeof(NEW.snapshot->'content') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.snapshot->'content') NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'QR_ADOPTION_CONTENT_REQUIRED'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.snapshot->'content') LOOP
  IF NOT EXISTS(SELECT 1 FROM public.warmup_content WHERE workspace_id=NEW.workspace_id AND environment=NEW.environment AND id=(item->>'id')::uuid AND content_hash=item->>'hash' AND origin='HUMAN_REVIEWED') THEN RAISE EXCEPTION 'QR_ADOPTION_CONTENT_CHANGED'; END IF;
 END LOOP;
 IF old.id IS NOT NULL AND (NEW.actor_id IS DISTINCT FROM old.actor_id OR NEW.snapshot-ARRAY['stateVersion','grantId','connectionId'] IS DISTINCT FROM old.snapshot-ARRAY['stateVersion','grantId','connectionId'] OR NEW.grant_id=old.grant_id) THEN RAISE EXCEPTION 'QR_ADOPTION_RELINK_CHANGED'; END IF;
 NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_legacy_qr_adoption() FROM PUBLIC;
CREATE TRIGGER guard_legacy_qr_adoption BEFORE INSERT OR UPDATE OR DELETE ON warmup_continuity_adoptions FOR EACH ROW EXECUTE FUNCTION guard_legacy_qr_adoption();
GRANT SELECT,INSERT ON warmup_continuity_adoptions TO commerce_api,commerce_channel,commerce_automation;
-- Row-lock privilege only; the trigger refuses every UPDATE/DELETE.
GRANT UPDATE(id) ON warmup_continuity_adoptions TO commerce_api,commerce_channel,commerce_automation;

-- Per-effect sources are separate from historical payloads and are sealed only
-- during creation, with tenant/environment and exact participant foreign keys.
ALTER TABLE outbox ADD CONSTRAINT warmup_effect_tenant UNIQUE(id,workspace_id,environment);
ALTER TABLE operation_authorizations ADD CONSTRAINT warmup_legacy_auth_tenant UNIQUE(id,workspace_id,environment);
ALTER TABLE warmup_continuity_adoptions ADD CONSTRAINT warmup_adoption_source UNIQUE(id,workspace_id,environment,account_id,grant_id);
CREATE TABLE warmup_effect_origins (
 effect_id uuid NOT NULL,workspace_id text NOT NULL,environment text NOT NULL,participant_id uuid NOT NULL,
 adoption_id uuid,grant_id uuid,legacy_authorization_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(effect_id,participant_id),
 CHECK(((adoption_id IS NOT NULL AND grant_id IS NOT NULL AND legacy_authorization_id IS NULL) OR
  (adoption_id IS NULL AND grant_id IS NULL AND legacy_authorization_id IS NOT NULL)) IS TRUE),
 FOREIGN KEY(effect_id,workspace_id,environment) REFERENCES outbox(id,workspace_id,environment),
 FOREIGN KEY(participant_id,workspace_id,environment) REFERENCES warmup_states(account_id,workspace_id,environment),
 FOREIGN KEY(adoption_id,workspace_id,environment,participant_id,grant_id) REFERENCES warmup_continuity_adoptions(id,workspace_id,environment,account_id,grant_id),
 FOREIGN KEY(legacy_authorization_id,workspace_id,environment) REFERENCES operation_authorizations(id,workspace_id,environment)
);
ALTER TABLE warmup_effect_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup_effect_origins FORCE ROW LEVEL SECURITY;
CREATE POLICY own_profile ON warmup_effect_origins USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
CREATE FUNCTION guard_warmup_effect_origin() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE effect public.outbox%ROWTYPE; conversation public.warmup_conversations%ROWTYPE; adopted public.warmup_continuity_adoptions%ROWTYPE; auth public.operation_authorizations%ROWTYPE; live_profile record; live_grant jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'QR_EFFECT_ORIGIN_IMMUTABLE'; END IF;
 IF current_user<>'commerce_automation' OR current_setting('app.workspace_id',true) IS DISTINCT FROM NEW.workspace_id THEN RAISE EXCEPTION 'QR_EFFECT_ORIGIN_PROFILE_REQUIRED'; END IF;
 SELECT * INTO live_profile FROM public.read_locked_continuous_worker_profile();
 IF live_profile.id IS DISTINCT FROM NEW.workspace_id OR live_profile.state IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'QR_EFFECT_ORIGIN_PROFILE_REQUIRED'; END IF;
 SELECT * INTO effect FROM public.outbox WHERE id=NEW.effect_id AND workspace_id=NEW.workspace_id AND environment=NEW.environment
  AND xmin::text::bigint=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint FOR SHARE;
 IF effect.id IS NULL OR effect.kind<>'warmup' OR effect.status<>'READY' OR effect.attempts<>0 OR effect.created_at<transaction_timestamp() THEN RAISE EXCEPTION 'QR_EFFECT_ORIGIN_NEW_EFFECT_REQUIRED'; END IF;
 SELECT * INTO conversation FROM public.warmup_conversations WHERE id::text=effect.conversation_id AND workspace_id=NEW.workspace_id AND environment=NEW.environment;
 IF conversation.id IS NULL OR NOT(NEW.participant_id=ANY(CASE WHEN conversation.group_id IS NULL THEN ARRAY[conversation.initiator_id,conversation.peer_id] ELSE conversation.member_ids END)) THEN RAISE EXCEPTION 'QR_EFFECT_ORIGIN_PARTICIPANT_CHANGED'; END IF;
 IF NEW.adoption_id IS NOT NULL THEN
  SELECT * INTO adopted FROM public.warmup_continuity_adoptions WHERE id=NEW.adoption_id AND workspace_id=NEW.workspace_id AND environment=NEW.environment AND account_id=NEW.participant_id;
  IF adopted.id IS NULL OR adopted.pool_id IS DISTINCT FROM conversation.pool_id OR adopted.grant_id IS DISTINCT FROM NEW.grant_id
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(adopted.snapshot->'content') c WHERE c->>'id'=conversation.content_id::text)
   OR (effect.account_id=NEW.participant_id::text AND (effect.continuous_authorization_id IS DISTINCT FROM NEW.grant_id OR effect.authorization_id IS NOT NULL)) THEN RAISE EXCEPTION 'QR_EFFECT_ORIGIN_ADOPTION_CHANGED'; END IF;
  IF adopted.version IS DISTINCT FROM (SELECT max(version) FROM public.warmup_continuity_adoptions WHERE workspace_id=NEW.workspace_id AND environment=NEW.environment AND account_id=NEW.participant_id) THEN RAISE EXCEPTION 'QR_EFFECT_ORIGIN_ADOPTION_CHANGED'; END IF;
  SELECT a.state INTO live_grant FROM public.continuous_authorizations a WHERE a.workspace_id=NEW.workspace_id AND a.environment=NEW.environment AND a.id=NEW.grant_id FOR SHARE;
  IF live_grant IS NULL OR live_grant->'revokedAt'<>'null'::jsonb OR (live_grant->>'humanPaused')::boolean OR live_grant->'protections'<>'[]'::jsonb THEN RAISE EXCEPTION 'QR_EFFECT_ORIGIN_GRANT_BLOCKED'; END IF;
  PERFORM public.lock_continuous_human_scope(NEW.workspace_id,NEW.environment,NEW.participant_id,live_grant->'source');
  IF public.continuous_human_pause(NEW.workspace_id,NEW.environment,NEW.participant_id,live_grant->'source') THEN RAISE EXCEPTION 'QR_EFFECT_ORIGIN_GRANT_BLOCKED'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.warmup_continuity_adoptions WHERE workspace_id=NEW.workspace_id AND environment=NEW.environment AND account_id=NEW.participant_id) THEN RAISE EXCEPTION 'QR_EFFECT_ORIGIN_NO_TTL_FALLBACK'; END IF;
  SELECT * INTO auth FROM public.read_locked_operation_authorization(NEW.legacy_authorization_id,NEW.workspace_id,NEW.environment);
  IF auth.id IS NULL OR auth.revoked_at IS NOT NULL OR auth.expires_at<=clock_timestamp() OR auth.scope->>'pool_id' IS DISTINCT FROM conversation.pool_id::text
   OR NOT(auth.scope->'account_ids' ? NEW.participant_id::text) OR NOT(auth.scope->'content_ids' ? conversation.content_id::text)
   OR (effect.account_id=NEW.participant_id::text AND (effect.authorization_id IS DISTINCT FROM auth.id OR effect.continuous_authorization_id IS NOT NULL)) THEN RAISE EXCEPTION 'QR_EFFECT_ORIGIN_LEGACY_CHANGED'; END IF;
 END IF;
 NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_warmup_effect_origin() FROM PUBLIC;
CREATE TRIGGER guard_warmup_effect_origin BEFORE INSERT OR UPDATE OR DELETE ON warmup_effect_origins FOR EACH ROW EXECUTE FUNCTION guard_warmup_effect_origin();
GRANT SELECT ON warmup_effect_origins TO commerce_api,commerce_channel,commerce_automation;
GRANT INSERT ON warmup_effect_origins TO commerce_automation;

-- Deferred until all turns/origins are written; missing even one participant
-- rolls the entire planning transaction back instead of emitting partial proof.
CREATE FUNCTION require_warmup_effect_origins() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE conversation public.warmup_conversations%ROWTYPE; members uuid[]; mode text;
BEGIN
 IF NEW.kind<>'warmup' THEN RETURN NULL; END IF;
 SELECT * INTO conversation FROM public.warmup_conversations WHERE id::text=NEW.conversation_id AND workspace_id=NEW.workspace_id AND environment=NEW.environment;
 SELECT continuity_mode INTO mode FROM public.warmup_pools WHERE id=conversation.pool_id AND workspace_id=NEW.workspace_id AND environment=NEW.environment;
 IF mode IS DISTINCT FROM 'LEGACY' THEN RETURN NULL; END IF;
 members:=CASE WHEN conversation.group_id IS NULL THEN ARRAY[conversation.initiator_id,conversation.peer_id] ELSE conversation.member_ids END;
 IF NEW.continuous_authorization_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.warmup_continuity_adoptions WHERE workspace_id=NEW.workspace_id AND environment=NEW.environment AND account_id=ANY(members)) THEN
  IF cardinality(members) NOT BETWEEN 2 AND 20 OR EXISTS(SELECT 1 FROM unnest(members) participant WHERE NOT EXISTS(SELECT 1 FROM public.warmup_effect_origins WHERE effect_id=NEW.id AND participant_id=participant AND workspace_id=NEW.workspace_id AND environment=NEW.environment)) THEN RAISE EXCEPTION 'QR_EFFECT_ORIGINS_INCOMPLETE'; END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION require_warmup_effect_origins() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER require_warmup_effect_origins AFTER INSERT ON outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_warmup_effect_origins();

-- Both claim and final emission may read the plan without acquiring UPDATE
-- privileges. Counters/status remain mutable; its origin and budget do not.
CREATE FUNCTION guard_warmup_plan_origin() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.id,NEW.workspace_id,NEW.environment,NEW.account_id,NEW.profile_id,NEW.episode_id,NEW.local_date,NEW.effective_day,NEW.budget)
  IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.environment,OLD.account_id,OLD.profile_id,OLD.episode_id,OLD.local_date,OLD.effective_day,OLD.budget) THEN RAISE EXCEPTION 'WARMUP_PLAN_ORIGIN_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_warmup_plan_origin() FROM PUBLIC;
CREATE TRIGGER guard_warmup_plan_origin BEFORE UPDATE OR DELETE ON warmup_plans FOR EACH ROW EXECUTE FUNCTION guard_warmup_plan_origin();
