-- V7 F2 cutover: QR continuous warm-up and legacy adoption ledger (015, 016).
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> promoted from packages/db/profile-transition/015_auto_qr_warmup.sql (source sha256 d4fb32483b8c4a1a54651edbfd674a27a8099fbca74d56294d3351dc99cb63e7)
-- Called historical row triggers resolve public relations; runtime roles must
-- not create shadow objects there and pg_temp is explicitly last.
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['commerce_api','commerce_channel','commerce_automation','commerce_ingress','commerce_maintenance'] LOOP
  IF has_schema_privilege(role_name,'public','CREATE') THEN RAISE EXCEPTION 'QR_PUBLIC_SCHEMA_NOT_CLOSED'; END IF;
 END LOOP;
END $$;
-- Prospective V7 only; historical pools, grants, episodes and credits stay intact.
ALTER TABLE warmup_pools ADD COLUMN continuity_mode text NOT NULL DEFAULT 'LEGACY'
 CHECK(continuity_mode IN('LEGACY','QR_CONTINUOUS'));
ALTER TABLE warmup_pools ADD CONSTRAINT qr_pool_shape CHECK(continuity_mode<>'QR_CONTINUOUS' OR
 (topology='direct' AND purpose='preparation' AND program_id IS NULL AND group_id IS NULL AND authorization_id IS NULL));
CREATE UNIQUE INDEX warmup_one_qr_pool ON warmup_pools(workspace_id,environment) WHERE continuity_mode='QR_CONTINUOUS';
ALTER TABLE warmup_identities ALTER COLUMN profile_ciphertext DROP NOT NULL;
ALTER TABLE warmup_identities ADD COLUMN qr_verified_at timestamptz;
ALTER TABLE warmup_identities ADD COLUMN qr_command_id uuid;
ALTER TABLE warmup_identities ADD COLUMN qr_identity_fingerprint text;
ALTER TABLE warmup_identities ADD CONSTRAINT qr_identity_origin FOREIGN KEY(qr_command_id,workspace_id,environment)
 REFERENCES commands(id,workspace_id,environment);
ALTER TABLE warmup_identities ADD CONSTRAINT qr_identity_shape CHECK(
 ((qr_verified_at IS NULL AND qr_command_id IS NULL AND qr_identity_fingerprint IS NULL AND profile_ciphertext IS NOT NULL)
 OR (qr_verified_at IS NOT NULL AND qr_command_id IS NOT NULL AND qr_identity_fingerprint ~ '^[a-f0-9]{64}$')) IS TRUE);
ALTER TABLE warmup_content ADD COLUMN origin text NOT NULL DEFAULT 'HUMAN_REVIEWED'
 CHECK(origin IN('HUMAN_REVIEWED','SYSTEM_QR_POLICY'));
ALTER TABLE warmup_content ADD COLUMN policy_version text;
ALTER TABLE warmup_content ADD CONSTRAINT qr_content_origin CHECK(
 (origin='HUMAN_REVIEWED' AND policy_version IS NULL) OR (origin='SYSTEM_QR_POLICY' AND policy_version='system-qr-checks/v1'));

-- Invoker triggers see the original runtime role for direct writes. Closed
-- SECURITY DEFINER enrollment executes as the migration owner; no broad grants.
CREATE FUNCTION protect_qr_warmup_origin() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID)) THEN
  IF TG_TABLE_NAME='warmup_pools' THEN
   IF (TG_OP='INSERT' AND NEW.continuity_mode='QR_CONTINUOUS') OR
    (TG_OP='UPDATE' AND (NEW.continuity_mode IS DISTINCT FROM OLD.continuity_mode OR
     (OLD.continuity_mode='QR_CONTINUOUS' AND (NEW.workspace_id,NEW.environment,NEW.profile_id,NEW.allow_small_pool_concentration,NEW.topology,NEW.purpose,NEW.program_id,NEW.group_id,NEW.authorization_id)
      IS DISTINCT FROM (OLD.workspace_id,OLD.environment,OLD.profile_id,OLD.allow_small_pool_concentration,OLD.topology,OLD.purpose,OLD.program_id,OLD.group_id,OLD.authorization_id)))) THEN RAISE EXCEPTION 'QR_ORIGIN_IMMUTABLE'; END IF;
  ELSIF TG_TABLE_NAME='warmup_identities' THEN
   IF (TG_OP='INSERT' AND NEW.qr_verified_at IS NOT NULL) OR
    (TG_OP='UPDATE' AND (NEW.qr_verified_at,NEW.qr_command_id,NEW.qr_identity_fingerprint) IS DISTINCT FROM (OLD.qr_verified_at,OLD.qr_command_id,OLD.qr_identity_fingerprint)) THEN RAISE EXCEPTION 'QR_ORIGIN_IMMUTABLE'; END IF;
  ELSIF TG_TABLE_NAME='warmup_content' AND NEW.origin='SYSTEM_QR_POLICY' THEN RAISE EXCEPTION 'QR_ORIGIN_IMMUTABLE';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION protect_qr_warmup_origin() FROM PUBLIC;
CREATE TRIGGER protect_qr_pool BEFORE INSERT OR UPDATE ON warmup_pools FOR EACH ROW EXECUTE FUNCTION protect_qr_warmup_origin();
CREATE TRIGGER protect_qr_identity BEFORE INSERT OR UPDATE ON warmup_identities FOR EACH ROW EXECUTE FUNCTION protect_qr_warmup_origin();
CREATE TRIGGER protect_qr_content BEFORE INSERT OR UPDATE ON warmup_content FOR EACH ROW EXECUTE FUNCTION protect_qr_warmup_origin();

-- Fixed system-owned library, not a caller body or a fictional human approval.
CREATE FUNCTION qr_warmup_system_library() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $function$
 SELECT $library$[{"body":{"label":"Comprobación interna 01","turns":[{"kind":"text","text":"Comprobación interna 01: prueba interna entre números de este negocio."},{"kind":"text","text":"Comprobación interna 01: respuesta interna de recepción."},{"kind":"text","text":"Comprobación interna 01: comprobación del orden de los mensajes."},{"kind":"text","text":"Comprobación interna 01: respuesta interna en el orden previsto."},{"kind":"text","text":"Comprobación interna 01: fin del intercambio de comprobación."},{"kind":"text","text":"Comprobación interna 01: cierre interno del intercambio."}],"ownership_confirmed":true},"content_hash":"f6cf01902b982d7c57105e2f7d396a4c2290384804b94e7f208adc5e505c6995"},{"body":{"label":"Comprobación interna 02","turns":[{"kind":"text","text":"Comprobación interna 02: prueba interna entre números de este negocio."},{"kind":"text","text":"Comprobación interna 02: respuesta interna de recepción."},{"kind":"text","text":"Comprobación interna 02: comprobación del orden de los mensajes."},{"kind":"text","text":"Comprobación interna 02: respuesta interna en el orden previsto."},{"kind":"text","text":"Comprobación interna 02: fin del intercambio de comprobación."},{"kind":"text","text":"Comprobación interna 02: cierre interno del intercambio."}],"ownership_confirmed":true},"content_hash":"068ef4ada0a075603e275ffe8771ff2ca80ac8190ea949474ef99010a766467c"},{"body":{"label":"Comprobación interna 03","turns":[{"kind":"text","text":"Comprobación interna 03: prueba interna entre números de este negocio."},{"kind":"text","text":"Comprobación interna 03: respuesta interna de recepción."},{"kind":"text","text":"Comprobación interna 03: comprobación del orden de los mensajes."},{"kind":"text","text":"Comprobación interna 03: respuesta interna en el orden previsto."},{"kind":"text","text":"Comprobación interna 03: fin del intercambio de comprobación."},{"kind":"text","text":"Comprobación interna 03: cierre interno del intercambio."}],"ownership_confirmed":true},"content_hash":"0971380b5721608eb487f598444471848723b15c1082077ebcb493f505dcd6a9"},{"body":{"label":"Comprobación interna 04","turns":[{"kind":"text","text":"Comprobación interna 04: prueba interna entre números de este negocio."},{"kind":"text","text":"Comprobación interna 04: respuesta interna de recepción."},{"kind":"text","text":"Comprobación interna 04: comprobación del orden de los mensajes."},{"kind":"text","text":"Comprobación interna 04: respuesta interna en el orden previsto."},{"kind":"text","text":"Comprobación interna 04: fin del intercambio de comprobación."},{"kind":"text","text":"Comprobación interna 04: cierre interno del intercambio."}],"ownership_confirmed":true},"content_hash":"d00a4c5abfc491bd4290a259808aa734938ffa1f25610820a164e589a6f8b423"},{"body":{"label":"Comprobación interna 05","turns":[{"kind":"text","text":"Comprobación interna 05: prueba interna entre números de este negocio."},{"kind":"text","text":"Comprobación interna 05: respuesta interna de recepción."},{"kind":"text","text":"Comprobación interna 05: comprobación del orden de los mensajes."},{"kind":"text","text":"Comprobación interna 05: respuesta interna en el orden previsto."},{"kind":"text","text":"Comprobación interna 05: fin del intercambio de comprobación."},{"kind":"text","text":"Comprobación interna 05: cierre interno del intercambio."}],"ownership_confirmed":true},"content_hash":"f81251bdc9b4a1399ddba50553e8571329c491ffd7fda7b8458c9d2b8f8afa48"},{"body":{"label":"Comprobación interna 06","turns":[{"kind":"text","text":"Comprobación interna 06: prueba interna entre números de este negocio."},{"kind":"text","text":"Comprobación interna 06: respuesta interna de recepción."},{"kind":"text","text":"Comprobación interna 06: comprobación del orden de los mensajes."},{"kind":"text","text":"Comprobación interna 06: respuesta interna en el orden previsto."},{"kind":"text","text":"Comprobación interna 06: fin del intercambio de comprobación."},{"kind":"text","text":"Comprobación interna 06: cierre interno del intercambio."}],"ownership_confirmed":true},"content_hash":"b3a8b4d69c85d0aefc4138cb9cd8e8894fd9350fcdd817eca03487916e0615d5"},{"body":{"label":"Comprobación interna 07","turns":[{"kind":"text","text":"Comprobación interna 07: prueba interna entre números de este negocio."},{"kind":"text","text":"Comprobación interna 07: respuesta interna de recepción."},{"kind":"text","text":"Comprobación interna 07: comprobación del orden de los mensajes."},{"kind":"text","text":"Comprobación interna 07: respuesta interna en el orden previsto."},{"kind":"text","text":"Comprobación interna 07: fin del intercambio de comprobación."},{"kind":"text","text":"Comprobación interna 07: cierre interno del intercambio."}],"ownership_confirmed":true},"content_hash":"6ee4bb290a8fe8e5820bc5dcba90a4e52163d63d047d868cf15357ba76b87703"},{"body":{"label":"Comprobación interna 08","turns":[{"kind":"text","text":"Comprobación interna 08: prueba interna entre números de este negocio."},{"kind":"text","text":"Comprobación interna 08: respuesta interna de recepción."},{"kind":"text","text":"Comprobación interna 08: comprobación del orden de los mensajes."},{"kind":"text","text":"Comprobación interna 08: respuesta interna en el orden previsto."},{"kind":"text","text":"Comprobación interna 08: fin del intercambio de comprobación."},{"kind":"text","text":"Comprobación interna 08: cierre interno del intercambio."}],"ownership_confirmed":true},"content_hash":"c894f17a290960b722404904f050ab09458f63fc5b2ac5dbfb965ec0cd78ca05"},{"body":{"label":"Comprobación interna 09","turns":[{"kind":"text","text":"Comprobación interna 09: prueba interna entre números de este negocio."},{"kind":"text","text":"Comprobación interna 09: respuesta interna de recepción."},{"kind":"text","text":"Comprobación interna 09: comprobación del orden de los mensajes."},{"kind":"text","text":"Comprobación interna 09: respuesta interna en el orden previsto."},{"kind":"text","text":"Comprobación interna 09: fin del intercambio de comprobación."},{"kind":"text","text":"Comprobación interna 09: cierre interno del intercambio."}],"ownership_confirmed":true},"content_hash":"5788334b638bead1683e94b1a2aaf69fb9b9b168095a85f59847c247235130e6"},{"body":{"label":"Comprobación interna 10","turns":[{"kind":"text","text":"Comprobación interna 10: prueba interna entre números de este negocio."},{"kind":"text","text":"Comprobación interna 10: respuesta interna de recepción."},{"kind":"text","text":"Comprobación interna 10: comprobación del orden de los mensajes."},{"kind":"text","text":"Comprobación interna 10: respuesta interna en el orden previsto."},{"kind":"text","text":"Comprobación interna 10: fin del intercambio de comprobación."},{"kind":"text","text":"Comprobación interna 10: cierre interno del intercambio."}],"ownership_confirmed":true},"content_hash":"e49371716ccc042a081dd0c17bb9da4f8d29b30a2d7417f305eb6970ccdc08e1"},{"body":{"label":"Comprobación interna 11","turns":[{"kind":"text","text":"Comprobación interna 11: prueba interna entre números de este negocio."},{"kind":"text","text":"Comprobación interna 11: respuesta interna de recepción."},{"kind":"text","text":"Comprobación interna 11: comprobación del orden de los mensajes."},{"kind":"text","text":"Comprobación interna 11: respuesta interna en el orden previsto."},{"kind":"text","text":"Comprobación interna 11: fin del intercambio de comprobación."},{"kind":"text","text":"Comprobación interna 11: cierre interno del intercambio."}],"ownership_confirmed":true},"content_hash":"bcdba6cf8c2429bf44b04e423bb7e7f4ee8f8b058b9d0559bc62c9dcf9957abb"},{"body":{"label":"Comprobación interna 12","turns":[{"kind":"text","text":"Comprobación interna 12: prueba interna entre números de este negocio."},{"kind":"text","text":"Comprobación interna 12: respuesta interna de recepción."},{"kind":"text","text":"Comprobación interna 12: comprobación del orden de los mensajes."},{"kind":"text","text":"Comprobación interna 12: respuesta interna en el orden previsto."},{"kind":"text","text":"Comprobación interna 12: fin del intercambio de comprobación."},{"kind":"text","text":"Comprobación interna 12: cierre interno del intercambio."}],"ownership_confirmed":true},"content_hash":"842746fc7ba3b4c4f4b13966233237fbe0808f93c53f231e148e7404f8804c05"}]$library$::jsonb
$function$;
-- library sha256 ad8f8eb7af3e4cdbc6bdfa5931c5771b2a1940e431350773c45b38dbe517811a
REVOKE ALL ON FUNCTION qr_warmup_system_library() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qr_warmup_system_library() TO commerce_channel,commerce_automation;

CREATE FUNCTION enroll_current_qr_warmup(env text,account uuid,grant_id uuid,session_revision integer,
 observed_ciphertext text,canonical_fingerprint text,canonical_ciphertext text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE workspace text:=current_setting('app.workspace_id',true); p public.profiles%ROWTYPE;
 s public.channel_sessions%ROWTYPE; g public.continuous_authorizations%ROWTYPE; c public.commands%ROWTYPE;
 a public.records%ROWTYPE; old public.warmup_states%ROWTYPE; wp public.warmup_pools%ROWTYPE;
 ident public.warmup_identities%ROWTYPE; episode public.warmup_episodes%ROWTYPE;
 profile_id uuid; item jsonb; at timestamptz:=clock_timestamp(); changed boolean:=false;
BEGIN
 IF workspace IS NULL OR length(workspace)=0 OR env NOT IN('REAL','SIMULATION') THEN RAISE EXCEPTION 'QR_PROFILE_CONTEXT_REQUIRED'; END IF;
 SELECT * INTO p FROM public.profiles WHERE id=workspace AND state='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'QR_PROFILE_INACTIVE'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended(jsonb_build_array('qr-enrollment',workspace,env)::text,0)) THEN RAISE EXCEPTION 'QR_ENROLLMENT_BUSY'; END IF;
 SELECT * INTO g FROM public.continuous_authorizations WHERE workspace_id=workspace AND environment=env AND id=grant_id AND account_id=account;
 IF NOT FOUND OR g.state->'source'->>'kind'<>'VERIFIED_QR_CONNECTION' THEN RAISE EXCEPTION 'QR_GRANT_REQUIRED'; END IF;
 PERFORM public.lock_continuous_human_scope(workspace,env,account,g.state->'source');
 SELECT * INTO g FROM public.continuous_authorizations WHERE workspace_id=workspace AND environment=env AND id=grant_id FOR SHARE;
 IF g.state->'revokedAt'<>'null'::jsonb OR (g.state->>'humanPaused')::boolean OR g.state->'protections'<>'[]'::jsonb
  OR public.continuous_human_pause(workspace,env,account,g.state->'source') THEN RETURN jsonb_build_object('state','AUTHORITY_BLOCKED'); END IF;
 SELECT * INTO c FROM public.commands WHERE workspace_id=workspace AND environment=env AND resource_id=account::text
  AND kind='channel_command' AND payload->>'type'='connect' AND status='APPLIED' ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE;
 SELECT * INTO s FROM public.channel_sessions WHERE workspace_id=workspace AND environment=env AND account_id=account FOR SHARE;
 SELECT * INTO a FROM public.records WHERE id=account AND workspace_id=workspace AND environment=env AND kind='channel_account' FOR SHARE;
 IF c.id IS NULL OR c.id IS DISTINCT FROM g.qr_command_id OR s.account_id IS NULL OR a.id IS NULL
  OR s.revision IS DISTINCT FROM session_revision OR s.archived_at IS NOT NULL OR s.desired_state IS DISTINCT FROM 'RUNNING'
  OR s.operational_pause OR s.observed_state IS DISTINCT FROM 'CONNECTED' OR s.auth_state IS DISTINCT FROM 'VERIFIED'
  OR s.health_expires_at IS NULL OR s.health_expires_at<=at OR s.provider_observed_at IS NULL OR s.provider_observed_at<c.created_at OR s.provider_observed_at>at
  OR s.expected_identity_fingerprint IS DISTINCT FROM g.state->'source'->>'identityFingerprint'
  OR s.observed_identity_ciphertext IS DISTINCT FROM observed_ciphertext OR observed_ciphertext IS NULL
  OR a.body->>'identity_fingerprint' IS DISTINCT FROM s.expected_identity_fingerprint
  OR a.body->>'identity_verified' IS DISTINCT FROM 'true' OR a.body->>'identity_conflict'='true'
  OR a.body->>'status' IS DISTINCT FROM 'WORKING' OR a.body ? 'deleted_at'
  OR (env='REAL' AND a.body->>'provider' IS DISTINCT FROM 'waha')
  OR (env='SIMULATION' AND a.body->>'provider' IS DISTINCT FROM 'simulator') THEN RAISE EXCEPTION 'QR_CONNECTION_CHANGED'; END IF;
 IF canonical_fingerprint IS NULL OR canonical_fingerprint!~'^[a-f0-9]{64}$' OR canonical_ciphertext IS NULL
  OR canonical_ciphertext NOT LIKE 'v1.%' OR length(canonical_ciphertext)>2048 THEN RAISE EXCEPTION 'QR_CIPHERTEXT_REQUIRED'; END IF;
 SELECT * INTO old FROM public.warmup_states WHERE account_id=account FOR UPDATE;
 IF FOUND AND NOT EXISTS(SELECT 1 FROM public.warmup_pools WHERE id=old.pool_id AND workspace_id=workspace AND environment=env AND continuity_mode='QR_CONTINUOUS')
  THEN RETURN jsonb_build_object('state','LEGACY_ADOPTION_REQUIRED'); END IF;
 IF EXISTS(SELECT 1 FROM public.warmup_account_reservations WHERE account_id=account) THEN RETURN jsonb_build_object('state','EXISTING_PROGRAM_PRESERVED'); END IF;
 SELECT * INTO ident FROM public.warmup_identities WHERE account_id=account FOR UPDATE;
 IF FOUND AND (ident.workspace_id<>workspace OR ident.environment<>env OR ident.address_fingerprint<>canonical_fingerprint)
  THEN RAISE EXCEPTION 'QR_REGISTERED_IDENTITY_CHANGED'; END IF;
 SELECT * INTO episode FROM public.warmup_episodes WHERE account_id=account AND closed_at IS NULL FOR SHARE;
 IF FOUND AND (episode.workspace_id<>workspace OR episode.environment<>env OR episode.policy_version<>'standard-15d/v2'
  OR episode.identity_fingerprint<>s.expected_identity_fingerprint) THEN RETURN jsonb_build_object('state','EPISODE_ADOPTION_REQUIRED'); END IF;
 IF old.account_id IS NOT NULL AND (episode.id IS NULL OR old.episode_id IS DISTINCT FROM episode.id OR old.identity_id IS DISTINCT FROM ident.id) THEN RETURN jsonb_build_object('state','EPISODE_ADOPTION_REQUIRED'); END IF;
 SELECT * INTO wp FROM public.warmup_pools WHERE workspace_id=workspace AND environment=env AND continuity_mode='QR_CONTINUOUS' FOR UPDATE;
 IF FOUND AND (NOT wp.enabled OR wp.paused OR wp.breaker_open OR wp.archived_at IS NOT NULL)
  THEN RETURN jsonb_build_object('state','POOL_STOP_PRESERVED'); END IF;
 IF wp.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.warmup_profiles WHERE id=wp.profile_id AND workspace_id=workspace AND environment=env AND config->>'policy_version'='standard-15d/v2') THEN RAISE EXCEPTION 'QR_POOL_POLICY_CHANGED'; END IF;
 IF wp.id IS NULL THEN
  INSERT INTO public.warmup_profiles(workspace_id,environment,config) VALUES(workspace,env,jsonb_build_object(
   'name','Preparación automática QR','policy_version','standard-15d/v2','mode','standard','timezone',p.timezone,
   'start_hour',9,'end_hour',18,'profile_wait_hours',24,'weekend_factor',0.5,'rate_per_minute',2,
   'jitter_seconds',60,'ack_maturity_minutes',30,'min_ack_samples',20,'inbound_light_days',10)) RETURNING id INTO profile_id;
  INSERT INTO public.warmup_pools(workspace_id,environment,profile_id,enabled,allow_small_pool_concentration,continuity_mode)
   VALUES(workspace,env,profile_id,true,true,'QR_CONTINUOUS') RETURNING * INTO wp;
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(public.qr_warmup_system_library()) LOOP
  IF EXISTS(SELECT 1 FROM public.warmup_content WHERE workspace_id=workspace AND environment=env AND content_hash=item->>'content_hash'
   AND (body IS DISTINCT FROM item->'body' OR origin<>'SYSTEM_QR_POLICY' OR policy_version IS DISTINCT FROM 'system-qr-checks/v1')) THEN RAISE EXCEPTION 'QR_CONTENT_CONFLICT'; END IF;
  INSERT INTO public.warmup_content(workspace_id,environment,content_hash,body,approved_by,origin,policy_version)
   VALUES(workspace,env,item->>'content_hash',item->'body','SYSTEM_QR_POLICY:system-qr-checks/v1','SYSTEM_QR_POLICY','system-qr-checks/v1') ON CONFLICT DO NOTHING;
 END LOOP;
 IF ident.id IS NULL THEN
  INSERT INTO public.warmup_identities(workspace_id,environment,account_id,address_fingerprint,address_ciphertext,profile_ciphertext,ownership_evidence,
   qr_verified_at,qr_command_id,qr_identity_fingerprint) VALUES(workspace,env,account,canonical_fingerprint,canonical_ciphertext,NULL,
   'VERIFIED_QR_CONNECTION:'||c.id::text,s.provider_observed_at,c.id,s.expected_identity_fingerprint) RETURNING * INTO ident; changed:=true;
 ELSIF ident.qr_command_id IS DISTINCT FROM c.id OR ident.qr_identity_fingerprint IS DISTINCT FROM s.expected_identity_fingerprint THEN
  UPDATE public.warmup_identities SET qr_verified_at=s.provider_observed_at,qr_command_id=c.id,qr_identity_fingerprint=s.expected_identity_fingerprint WHERE id=ident.id RETURNING * INTO ident; changed:=true;
 END IF;
 IF episode.id IS NULL THEN
  INSERT INTO public.warmup_episodes(account_id,workspace_id,environment,policy_version,identity_fingerprint,timezone,started_at,created_by)
   VALUES(account,workspace,env,'standard-15d/v2',s.expected_identity_fingerprint,p.timezone,at,'SYSTEM_QR_POLICY') RETURNING * INTO episode;changed:=true;
 END IF;
 IF old.account_id IS NULL THEN
  INSERT INTO public.warmup_states(account_id,workspace_id,environment,pool_id,identity_id,profile_id,status,reason,enrolled_at,profile_ready_at,episode_id)
   VALUES(account,workspace,env,wp.id,ident.id,wp.profile_id,'AWAITING_PEER','OWN_PEER_REQUIRED',at,at,episode.id);changed:=true;
 END IF;
 IF changed THEN INSERT INTO public.domain_events(id,workspace_id,environment,event_type,aggregate_id,correlation_id,actor,payload,occurred_at)
  VALUES(gen_random_uuid(),workspace,env,'warmup.qr_enrollment_observed',account::text,gen_random_uuid(),jsonb_build_object('kind','SYSTEM_QR_POLICY'),
   jsonb_build_object('pool_id',wp.id,'episode_id',episode.id,'connection_id',c.id,'authorization_id',g.id,'policy_version','standard-15d/v2'),at);END IF;
 IF s.health_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'QR_CONNECTION_EXPIRED'; END IF;
 RETURN jsonb_build_object('state',CASE WHEN changed THEN 'ENROLLED' ELSE 'ALREADY_ENROLLED' END,'pool_id',wp.id,'episode_id',episode.id,'identity_id',ident.id);
END $$;
REVOKE ALL ON FUNCTION enroll_current_qr_warmup(text,uuid,uuid,integer,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enroll_current_qr_warmup(text,uuid,uuid,integer,text,text,text) TO commerce_channel,commerce_automation;
-- <<< end 015_auto_qr_warmup.sql

-- >>> promoted from packages/db/profile-transition/016_legacy_qr_warmup_adoption.sql (source sha256 a8a25389f954b5728e0c6f5da9390e45be5f5263a98c64bcf7fc91cd41f536c6)
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
-- <<< end 016_legacy_qr_warmup_adoption.sql
