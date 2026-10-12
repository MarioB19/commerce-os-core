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
