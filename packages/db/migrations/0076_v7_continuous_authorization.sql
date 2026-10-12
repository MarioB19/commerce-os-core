-- V7 F2 cutover: Continuous commercial authorization (010).
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> promoted from packages/db/profile-transition/010_continuous_authorization.sql (source sha256 2a892f076920e327f2a1a6a1b5c324b8d87a84506c4e4d64681c5535434f686b)
-- Isolated F3 transition. Apply only with the reviewed profile adoption and consumers.
-- Reject missing/null fields as well as unknown fields at the SQL boundary.
CREATE FUNCTION valid_continuous_state(s jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE
 SET search_path=pg_catalog AS $$
DECLARE p jsonb; reasons text[]:=ARRAY[]::text[]; created timestamptz;
BEGIN
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR NOT s ?& ARRAY['id','workspaceId','environment','accountId','source','createdBy','createdAt','version','humanPaused','revokedAt','protections']
  OR s-ARRAY['id','workspaceId','environment','accountId','source','createdBy','createdAt','version','humanPaused','revokedAt','protections']<>'{}'::jsonb THEN RETURN false; END IF;
 IF (jsonb_typeof(s->'id')='string' AND (s->>'id')::uuid IS NOT NULL
  AND jsonb_typeof(s->'accountId')='string' AND (s->>'accountId')::uuid IS NOT NULL
  AND jsonb_typeof(s->'workspaceId')='string' AND length(s->>'workspaceId') BETWEEN 1 AND 256
  AND s->>'environment' IN('REAL','SIMULATION')
  AND jsonb_typeof(s->'createdBy')='string' AND length(s->>'createdBy') BETWEEN 1 AND 256
  AND jsonb_typeof(s->'createdAt')='string' AND s->>'createdAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
  AND jsonb_typeof(s->'version')='number' AND s->>'version' ~ '^[1-9][0-9]*$'
  AND (s->>'version')::numeric BETWEEN 1 AND 9007199254740991
  AND jsonb_typeof(s->'humanPaused')='boolean' AND jsonb_typeof(s->'protections')='array'
  AND jsonb_typeof(s->'source')='object') IS NOT TRUE THEN RETURN false; END IF;
 created:=(s->>'createdAt')::timestamptz;
 IF s->'revokedAt'<>'null'::jsonb AND (jsonb_typeof(s->'revokedAt')='string'
  AND s->>'revokedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
  AND (s->>'revokedAt')::timestamptz>=created) IS NOT TRUE THEN RETURN false; END IF;
 p:=s->'source';
 IF p->>'kind'='COMMERCIAL_ASSIGNMENT' THEN
  IF (p ?& ARRAY['kind','assignmentId','assignmentRevision','bindingId']
   AND p-ARRAY['kind','assignmentId','assignmentRevision','bindingId']='{}'::jsonb
   AND jsonb_typeof(p->'assignmentId')='string' AND (p->>'assignmentId')::uuid IS NOT NULL
   AND jsonb_typeof(p->'bindingId')='string' AND (p->>'bindingId')::uuid IS NOT NULL
   AND jsonb_typeof(p->'assignmentRevision')='number' AND p->>'assignmentRevision' ~ '^[1-9][0-9]*$'
   AND (p->>'assignmentRevision')::numeric BETWEEN 1 AND 9007199254740991) IS NOT TRUE THEN RETURN false; END IF;
 ELSIF p->>'kind'='VERIFIED_QR_CONNECTION' THEN
  IF (p ?& ARRAY['kind','connectionId','identityFingerprint'] AND p-ARRAY['kind','connectionId','identityFingerprint']='{}'::jsonb
   AND jsonb_typeof(p->'connectionId')='string' AND (p->>'connectionId')::uuid IS NOT NULL
   AND jsonb_typeof(p->'identityFingerprint')='string' AND p->>'identityFingerprint' ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN RETURN false; END IF;
 ELSE RETURN false; END IF;
 IF jsonb_array_length(s->'protections')>6 THEN RETURN false; END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(s->'protections') LOOP
  IF (jsonb_typeof(p)='object' AND p ?& ARRAY['reason','incidentId','observedAt','evidenceSha256']
   AND p-ARRAY['reason','incidentId','observedAt','evidenceSha256']='{}'::jsonb
   AND p->>'reason' IN('CHANNEL_DOWN','AI_UNAVAILABLE','QUOTA_EXHAUSTED','IDENTITY_CHANGED','SEND_UNCERTAIN','PROFILE_SUSPENDED')
   AND NOT(p->>'reason'=ANY(reasons)) AND jsonb_typeof(p->'incidentId')='string' AND (p->>'incidentId')::uuid IS NOT NULL
   AND jsonb_typeof(p->'observedAt')='string' AND p->>'observedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
   AND (p->>'observedAt')::timestamptz>=created AND jsonb_typeof(p->'evidenceSha256')='string'
   AND p->>'evidenceSha256' ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN RETURN false; END IF;
  reasons:=array_append(reasons,p->>'reason');
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow OR invalid_datetime_format THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION valid_continuous_state(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION valid_continuous_state(jsonb) TO commerce_api,commerce_channel,commerce_automation;
ALTER TABLE records ADD CONSTRAINT continuous_record_scope UNIQUE(id,workspace_id,environment,kind);
ALTER TABLE commercial_assignments ADD CONSTRAINT continuous_assignment_scope UNIQUE(id,workspace_id,environment,account_id);
ALTER TABLE commands ADD CONSTRAINT continuous_command_scope UNIQUE(id,workspace_id,environment);
CREATE TABLE continuous_authorizations (
 id uuid NOT NULL, workspace_id text NOT NULL REFERENCES profiles(id),
 environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 account_id uuid NOT NULL, account_kind text NOT NULL DEFAULT 'channel_account' CHECK(account_kind='channel_account'),
 assignment_id uuid, binding_id uuid, binding_kind text NOT NULL DEFAULT 'binding' CHECK(binding_kind='binding'),
 qr_command_id uuid, source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 version bigint NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
 state jsonb NOT NULL CHECK(valid_continuous_state(state) IS TRUE),
 PRIMARY KEY(workspace_id,environment,id), UNIQUE(workspace_id,environment,source_hash),
 FOREIGN KEY(account_id,workspace_id,environment,account_kind) REFERENCES records(id,workspace_id,environment,kind),
 FOREIGN KEY(assignment_id,workspace_id,environment,account_id) REFERENCES commercial_assignments(id,workspace_id,environment,account_id),
 FOREIGN KEY(binding_id,workspace_id,environment,binding_kind) REFERENCES records(id,workspace_id,environment,kind),
 FOREIGN KEY(qr_command_id,workspace_id,environment) REFERENCES commands(id,workspace_id,environment),
 CHECK((state->>'id'=id::text AND state->>'workspaceId'=workspace_id AND state->>'environment'=environment
  AND state->>'accountId'=account_id::text AND (state->>'version')::bigint=version
  AND jsonb_typeof(state->'humanPaused')='boolean' AND jsonb_typeof(state->'protections')='array') IS TRUE),
 CHECK(((assignment_id IS NOT NULL AND binding_id IS NOT NULL AND qr_command_id IS NULL
  AND state->'source'->>'kind'='COMMERCIAL_ASSIGNMENT' AND state->'source'->>'assignmentId'=assignment_id::text
  AND state->'source'->>'bindingId'=binding_id::text)
  OR (assignment_id IS NULL AND binding_id IS NULL AND qr_command_id IS NOT NULL
  AND state->'source'->>'kind'='VERIFIED_QR_CONNECTION' AND state->'source'->>'connectionId'=qr_command_id::text)) IS TRUE)
);
CREATE TABLE continuous_authorization_events (
 event_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 workspace_id text NOT NULL, environment text NOT NULL, authorization_id uuid NOT NULL,
 version bigint NOT NULL, operation_id uuid NOT NULL, event jsonb NOT NULL CHECK(jsonb_typeof(event)='object'),
 state jsonb NOT NULL CHECK(jsonb_typeof(state)='object'), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,authorization_id,version),
 FOREIGN KEY(workspace_id,environment,authorization_id) REFERENCES continuous_authorizations(workspace_id,environment,id)
);
CREATE TABLE continuous_authorization_operations (
 workspace_id text NOT NULL REFERENCES profiles(id), environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 actor_key text NOT NULL CHECK(length(actor_key)>0), operation_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,environment,actor_key,operation_id)
);
CREATE FUNCTION continuous_human_scope(account uuid, source jsonb) RETURNS text LANGUAGE sql IMMUTABLE
 SET search_path=pg_catalog AS $$
 SELECT CASE source->>'kind' WHEN 'COMMERCIAL_ASSIGNMENT' THEN 'assignment:'||(source->>'assignmentId')
 WHEN 'VERIFIED_QR_CONNECTION' THEN 'warmup:'||account::text END
$$;
CREATE FUNCTION lock_continuous_human_scope(workspace text, env text, account uuid, source jsonb)
 RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE scope text;
BEGIN
 IF current_setting('app.workspace_id',true) IS DISTINCT FROM workspace THEN RAISE EXCEPTION 'CONTINUITY_PROFILE_CONTEXT_REQUIRED'; END IF;
 scope:=public.continuous_human_scope(account,source);
 IF scope IS NULL THEN RAISE EXCEPTION 'CONTINUITY_SOURCE_REQUIRED'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended(jsonb_build_array('continuous-human',workspace,env,scope)::text,0)) THEN
  RAISE EXCEPTION 'CONTINUITY_SCOPE_BUSY'; END IF;
END $$;
CREATE FUNCTION continuous_human_pause(workspace text, env text, account uuid, source jsonb)
 RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT e.event->>'type'='HUMAN_PAUSED'
 FROM public.continuous_authorizations a JOIN public.continuous_authorization_events e
 ON e.workspace_id=a.workspace_id AND e.environment=a.environment AND e.authorization_id=a.id
 WHERE a.workspace_id=workspace AND a.environment=env
 AND public.continuous_human_scope(a.account_id,a.state->'source')=public.continuous_human_scope(account,source)
 AND e.event->>'type' IN('HUMAN_PAUSED','HUMAN_RESUMED') ORDER BY e.event_sequence DESC LIMIT 1),false)
$$;
REVOKE ALL ON FUNCTION continuous_human_scope(uuid,jsonb),lock_continuous_human_scope(text,text,uuid,jsonb),continuous_human_pause(text,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION continuous_human_scope(uuid,jsonb),lock_continuous_human_scope(text,text,uuid,jsonb),continuous_human_pause(text,text,uuid,jsonb) TO commerce_api,commerce_channel,commerce_automation;
CREATE FUNCTION guard_continuous_authorization() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE is_owner boolean;
BEGIN
 IF current_setting('app.workspace_id',true) IS DISTINCT FROM NEW.workspace_id THEN
  RAISE EXCEPTION 'CONTINUITY_PROFILE_CONTEXT_REQUIRED'; END IF;
 SELECT pg_get_userbyid(c.relowner)=current_user INTO is_owner FROM pg_class c WHERE c.oid=TG_RELID;
 IF TG_OP='INSERT' THEN
  PERFORM public.lock_continuous_human_scope(NEW.workspace_id,NEW.environment,NEW.account_id,NEW.state->'source');
  IF NEW.version<>1 OR NEW.state->'humanPaused' IS DISTINCT FROM to_jsonb(public.continuous_human_pause(NEW.workspace_id,NEW.environment,NEW.account_id,NEW.state->'source')) OR NEW.state->'revokedAt' IS DISTINCT FROM 'null'::jsonb
   OR NEW.state->'protections' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'CONTINUITY_INITIAL_STATE_REQUIRED'; END IF;
  IF NEW.assignment_id IS NOT NULL THEN
   IF NOT is_owner AND current_user<>'commerce_api' THEN RAISE EXCEPTION 'CONTINUITY_HUMAN_ORIGIN_REQUIRED'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.commercial_assignments a
    WHERE a.id=NEW.assignment_id AND a.workspace_id=NEW.workspace_id AND a.environment=NEW.environment
     AND a.account_id=NEW.account_id AND a.binding_id=NEW.binding_id AND a.state='ACTIVE'
     AND a.revision=(NEW.state->'source'->>'assignmentRevision')::bigint) THEN
    RAISE EXCEPTION 'CONTINUITY_ASSIGNMENT_CHANGED'; END IF;
  ELSE
   IF NOT is_owner AND current_user<>'commerce_channel' THEN RAISE EXCEPTION 'CONTINUITY_VERIFIED_CONNECTION_REQUIRED'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.commands c JOIN public.channel_sessions s
    ON s.workspace_id=c.workspace_id AND s.environment=c.environment AND s.account_id::text=c.resource_id
    WHERE c.id=NEW.qr_command_id AND c.workspace_id=NEW.workspace_id AND c.environment=NEW.environment
     AND c.resource_id=NEW.account_id::text AND c.kind='channel_command' AND c.payload->>'type'='connect'
     AND c.status='APPLIED' AND c.actor_id=NEW.state->>'createdBy'
     AND s.archived_at IS NULL AND s.observed_state='CONNECTED' AND s.auth_state='VERIFIED'
     AND s.health_expires_at>clock_timestamp() AND s.provider_observed_at>=c.created_at
     AND s.expected_identity_fingerprint=NEW.state->'source'->>'identityFingerprint') THEN
    RAISE EXCEPTION 'CONTINUITY_VERIFIED_CONNECTION_REQUIRED'; END IF;
  END IF;
  RETURN NEW;
 END IF;
 -- Direct SQL writers also participate in the group fence. A row-first caller
 -- gets an immediate conflict instead of waiting in a group/row lock cycle.
 PERFORM public.lock_continuous_human_scope(NEW.workspace_id,NEW.environment,NEW.account_id,NEW.state->'source');
 IF (to_jsonb(NEW)-'version'-'state') IS DISTINCT FROM (to_jsonb(OLD)-'version'-'state')
  OR NEW.version<>OLD.version+1
  OR (NEW.state-'version'-'humanPaused'-'revokedAt'-'protections') IS DISTINCT FROM
     (OLD.state-'version'-'humanPaused'-'revokedAt'-'protections') THEN
  RAISE EXCEPTION 'CONTINUITY_IMMUTABLE_OR_VERSION_CHANGED'; END IF;
 IF OLD.state->'revokedAt'<>'null'::jsonb THEN RAISE EXCEPTION 'CONTINUITY_REVOKED'; END IF;
 IF NOT is_owner THEN
  IF current_user='commerce_api' THEN
   IF NEW.state->'protections' IS DISTINCT FROM OLD.state->'protections' THEN
    RAISE EXCEPTION 'CONTINUITY_INTERNAL_PROTECTION_REQUIRED'; END IF;
  ELSIF current_user IN('commerce_channel','commerce_automation') THEN
   IF (NEW.state->'humanPaused',NEW.state->'revokedAt') IS DISTINCT FROM (OLD.state->'humanPaused',OLD.state->'revokedAt') THEN
    RAISE EXCEPTION 'CONTINUITY_HUMAN_COMMAND_REQUIRED'; END IF;
  ELSE RAISE EXCEPTION 'CONTINUITY_ROLE_REJECTED'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_continuous_authorization() FROM PUBLIC;
CREATE TRIGGER guard_continuous_authorization BEFORE INSERT OR UPDATE ON continuous_authorizations
 FOR EACH ROW EXECUTE FUNCTION guard_continuous_authorization();
CREATE FUNCTION require_continuous_authorization_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.continuous_authorization_events e WHERE e.workspace_id=NEW.workspace_id
  AND e.environment=NEW.environment AND e.authorization_id=NEW.id AND e.version=NEW.version AND e.state=NEW.state) THEN
  RAISE EXCEPTION 'CONTINUITY_ATOMIC_EVENT_REQUIRED'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION require_continuous_authorization_event() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER require_continuous_authorization_event AFTER INSERT OR UPDATE ON continuous_authorizations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_continuous_authorization_event();
CREATE FUNCTION require_continuous_human_pause() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE paused boolean;
BEGIN
 paused:=public.continuous_human_pause(NEW.workspace_id,NEW.environment,NEW.account_id,NEW.state->'source');
 IF EXISTS(SELECT 1 FROM public.continuous_authorizations a WHERE a.workspace_id=NEW.workspace_id AND a.environment=NEW.environment
  AND public.continuous_human_scope(a.account_id,a.state->'source')=public.continuous_human_scope(NEW.account_id,NEW.state->'source')
  AND a.state->'revokedAt'='null'::jsonb AND a.state->'humanPaused' IS DISTINCT FROM to_jsonb(paused)) THEN
  RAISE EXCEPTION 'CONTINUITY_HUMAN_PAUSE_NOT_PRESERVED'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION require_continuous_human_pause() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER require_continuous_human_pause AFTER INSERT OR UPDATE ON continuous_authorizations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_continuous_human_pause();
CREATE FUNCTION guard_continuous_event_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s jsonb; kind text; is_owner boolean;
BEGIN
 SELECT a.state INTO s FROM public.continuous_authorizations a WHERE a.workspace_id=NEW.workspace_id
  AND a.environment=NEW.environment AND a.id=NEW.authorization_id AND a.version=NEW.version;
 IF s IS NULL OR s IS DISTINCT FROM NEW.state THEN RAISE EXCEPTION 'CONTINUITY_EVENT_STATE_REQUIRED'; END IF;
 SELECT pg_get_userbyid(c.relowner)=current_user INTO is_owner FROM pg_class c WHERE c.oid=TG_RELID;
 kind:=NEW.event->>'type';
 IF kind IN('HUMAN_PAUSED','HUMAN_RESUMED','REVOKED') THEN
  IF NOT is_owner AND current_user<>'commerce_api' THEN RAISE EXCEPTION 'CONTINUITY_HUMAN_EVENT_REQUIRED'; END IF;
  IF (kind='HUMAN_PAUSED' AND s->'humanPaused' IS DISTINCT FROM 'true'::jsonb)
   OR (kind='HUMAN_RESUMED' AND s->'humanPaused' IS DISTINCT FROM 'false'::jsonb)
   OR (kind='REVOKED' AND s->'revokedAt'='null'::jsonb) THEN RAISE EXCEPTION 'CONTINUITY_EVENT_STATE_REQUIRED'; END IF;
 ELSIF kind IN('PROTECTION_ASSERTED','PROTECTION_CLEARED') THEN
  IF NOT is_owner AND current_user NOT IN('commerce_channel','commerce_automation') THEN RAISE EXCEPTION 'CONTINUITY_WORKER_EVENT_REQUIRED'; END IF;
 ELSIF kind='CREATED' THEN
  IF NEW.version<>1 OR (NOT is_owner AND current_user<>CASE s->'source'->>'kind' WHEN 'COMMERCIAL_ASSIGNMENT' THEN 'commerce_api' ELSE 'commerce_channel' END)
   THEN RAISE EXCEPTION 'CONTINUITY_CREATION_EVENT_REQUIRED'; END IF;
 ELSE RAISE EXCEPTION 'CONTINUITY_EVENT_KIND_REQUIRED'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_continuous_event_insert() FROM PUBLIC;
CREATE TRIGGER guard_continuous_event_insert BEFORE INSERT ON continuous_authorization_events
 FOR EACH ROW EXECUTE FUNCTION guard_continuous_event_insert();
CREATE TRIGGER continuous_events_immutable BEFORE UPDATE OR DELETE ON continuous_authorization_events
 FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER continuous_operations_immutable BEFORE UPDATE OR DELETE ON continuous_authorization_operations
 FOR EACH ROW EXECUTE FUNCTION immutable_row();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['continuous_authorizations','continuous_authorization_events','continuous_authorization_operations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY continuous_profile_scope ON %I USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')) WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),''''))',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,commerce_api,commerce_ingress,commerce_automation,commerce_channel,commerce_maintenance',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO commerce_api,commerce_channel',t);
  EXECUTE format('GRANT SELECT ON %I TO commerce_automation',t);
 END LOOP;
END $$;
GRANT INSERT ON continuous_authorization_events,continuous_authorization_operations TO commerce_automation;
-- Do not allow OVERRIDING SYSTEM VALUE to forge the ordering of human acts.
REVOKE INSERT ON continuous_authorization_events FROM commerce_api,commerce_channel,commerce_automation;
GRANT INSERT(workspace_id,environment,authorization_id,version,operation_id,event,state) ON continuous_authorization_events TO commerce_api,commerce_channel,commerce_automation;
GRANT USAGE ON SEQUENCE continuous_authorization_events_event_sequence_seq TO commerce_api,commerce_channel,commerce_automation;
GRANT UPDATE(version,state) ON continuous_authorizations TO commerce_api,commerce_channel,commerce_automation;
CREATE INDEX continuous_account_scope ON continuous_authorizations(workspace_id,environment,account_id,id);
-- <<< end 010_continuous_authorization.sql
