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
 CREATE ROLE commerce_authorization_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
 CREATE ROLE commerce_isolation_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
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
