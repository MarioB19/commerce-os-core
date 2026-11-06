-- V7.2: additive group programs. Historical QR/direct authority keeps its shape.
ALTER TABLE warmup_pools DROP CONSTRAINT warmup_pools_continuity_mode_check;
ALTER TABLE warmup_pools ADD CONSTRAINT warmup_pools_continuity_mode_check CHECK(continuity_mode IN('LEGACY','QR_CONTINUOUS','QR_GROUP'));
ALTER TABLE warmup_pools ADD CONSTRAINT qr_group_pool_shape CHECK(continuity_mode<>'QR_GROUP' OR
 (topology='group' AND program_id IS NOT NULL AND group_id IS NOT NULL AND authorization_id IS NULL));

-- Existing enrollment remains unchanged; prospective QR enrollment waits for a group.
ALTER TABLE warmup_states ADD COLUMN group_required boolean NOT NULL DEFAULT false;
ALTER TABLE warmup_states ALTER COLUMN group_required SET DEFAULT true;

ALTER TABLE warmup_content DROP CONSTRAINT warmup_content_origin_check;
ALTER TABLE warmup_content ADD CONSTRAINT warmup_content_origin_check CHECK(origin IN('HUMAN_REVIEWED','SYSTEM_QR_POLICY','LIBRARY'));
ALTER TABLE warmup_content DROP CONSTRAINT qr_content_origin;
ALTER TABLE warmup_content ADD CONSTRAINT qr_content_origin CHECK(
 (origin='HUMAN_REVIEWED' AND policy_version IS NULL) OR
 (origin='SYSTEM_QR_POLICY' AND policy_version='system-qr-checks/v1') OR
 (origin='LIBRARY' AND policy_version IS NOT NULL));
ALTER TABLE warmup_content ADD COLUMN message_hashes text[] NOT NULL DEFAULT '{}';
CREATE INDEX warmup_content_text_hashes ON warmup_content USING gin(message_hashes);
CREATE TABLE warmup_library_releases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 version text NOT NULL,name text NOT NULL,source text NOT NULL CHECK(source IN('BUNDLED','IMPORTED')),
 content_ids uuid[] NOT NULL,manifest jsonb NOT NULL,sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,environment,version),UNIQUE(id,workspace_id,environment)
);
CREATE TRIGGER immutable_warmup_library BEFORE UPDATE OR DELETE ON warmup_library_releases FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE warmup_program_operations (
 id uuid NOT NULL,workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 actor_id text NOT NULL,request_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,environment,id)
);
CREATE TRIGGER immutable_warmup_program_operation BEFORE UPDATE OR DELETE ON warmup_program_operations FOR EACH ROW EXECUTE FUNCTION immutable_row();
ALTER TABLE warmup_library_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup_library_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE warmup_program_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup_program_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_scope ON warmup_library_releases USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''));
CREATE POLICY profile_scope ON warmup_program_operations USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment=NULLIF(current_setting('app.environment',true),''));
REVOKE ALL ON warmup_library_releases,warmup_program_operations FROM PUBLIC;
GRANT SELECT ON warmup_library_releases,warmup_program_operations TO commerce_api,commerce_channel,commerce_automation,commerce_maintenance;
GRANT INSERT ON warmup_library_releases,warmup_program_operations TO commerce_api;
GRANT UPDATE(released_at) ON warmup_content_usage TO commerce_api;

CREATE FUNCTION request_active_warmup_group_refresh(env text,program uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE workspace text:=current_setting('app.workspace_id',true); p public.warmup_programs%ROWTYPE;
BEGIN
 IF workspace IS NULL OR env IS DISTINCT FROM current_setting('app.environment',true) THEN RAISE EXCEPTION 'GROUP_PROFILE_REQUIRED'; END IF;
 SELECT * INTO p FROM public.warmup_programs WHERE id=program AND workspace_id=workspace AND environment=env AND status='ACTIVE' AND scope->>'mode'='QR_GROUP';
 IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_ACTIVE_PROGRAM_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.number_operations WHERE workspace_id=workspace AND environment=env AND action='GROUP_REFRESH' AND input->>'group_id'=p.group_id::text AND state IN('REQUESTED','RESERVED','PREPARING')) THEN
  INSERT INTO public.number_operations(workspace_id,environment,actor_id,action,input) VALUES(workspace,env,'system:group-warmup','GROUP_REFRESH',jsonb_build_object('group_id',p.group_id,'account_ids',p.account_ids));
 END IF;
END $$;
REVOKE ALL ON FUNCTION request_active_warmup_group_refresh(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_active_warmup_group_refresh(text,uuid) TO commerce_automation;

-- Origin tables remain append-only; program revision and recipient scope are
-- also checked at final emission. Direct workers cannot consume group programs.
CREATE FUNCTION guard_qr_group_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.warmup_pools%ROWTYPE; g public.warmup_programs%ROWTYPE;
BEGIN
 IF NEW.kind<>'warmup' OR TG_OP='UPDATE' THEN RETURN NEW; END IF;
 SELECT * INTO p FROM public.warmup_pools WHERE id::text=NEW.payload->>'warmup_pool_id' AND workspace_id=NEW.workspace_id AND environment=NEW.environment;
 IF p.continuity_mode='QR_CONTINUOUS' AND EXISTS(SELECT 1 FROM public.warmup_states WHERE account_id::text=NEW.account_id AND group_required) THEN RAISE EXCEPTION 'GROUP_SELECTION_REQUIRED'; END IF;
 IF p.continuity_mode='QR_GROUP' THEN
  SELECT * INTO g FROM public.warmup_programs WHERE id=p.program_id AND workspace_id=p.workspace_id AND environment=p.environment;
  IF g.status<>'ACTIVE' OR NEW.payload->>'program_revision' IS DISTINCT FROM g.version::text OR NEW.payload->>'library_version' IS DISTINCT FROM g.scope->>'libraryVersion'
   OR NEW.continuous_authorization_id IS NULL OR NEW.authorization_id IS NOT NULL OR NOT (g.scope->'senderIds' ? NEW.account_id)
   OR NEW.payload->>'group_protocol' IS DISTINCT FROM 'v1' THEN RAISE EXCEPTION 'QR_GROUP_EFFECT_SCOPE_INVALID'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_qr_group_effect() FROM PUBLIC;
CREATE TRIGGER guard_qr_group_effect BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION guard_qr_group_effect();
