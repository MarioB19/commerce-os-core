-- Control database only, after 019/021 bridge. Closed read/lock capability;
-- no credential ciphertext, new admission, settlement or provider operation.
GRANT SELECT ON public.ai_attempts,public.ai_credentials TO commerce_number_lab_owner;
GRANT UPDATE(attempt_id) ON public.ai_attempts TO commerce_number_lab_owner;
GRANT UPDATE(id) ON public.ai_runtime_grants,public.ai_credentials TO commerce_number_lab_owner;
GRANT SELECT(user_id,workspace_id,active,role,version),UPDATE(user_id) ON public.memberships TO commerce_number_lab_owner;
CREATE FUNCTION commerce_number_lab.lock_cached_seller(w text,rid uuid,oid uuid,aid uuid,vid uuid,lid uuid,gid uuid,snapshot text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r commerce_number_lab.runs%ROWTYPE;o commerce_number_lab.operations%ROWTYPE;b commerce_number_lab.ai_bindings%ROWTYPE;
 a public.ai_attempts%ROWTYPE;g public.ai_runtime_grants%ROWTYPE;k public.ai_credentials%ROWTYPE;p public.ai_model_prices%ROWTYPE;
 v commerce_number_lab.run_releases%ROWTYPE;t timestamptz;deadline timestamptz;
BEGIN
 IF w IS NULL OR w IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'')
 OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL'
 OR rid IS NULL OR oid IS NULL OR aid IS NULL OR vid IS NULL OR lid IS NULL OR gid IS NULL
 OR snapshot IS NULL OR snapshot !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'LAB_AI_CACHE_SCOPE'; END IF;
 PERFORM public.ai_scope_lock(w,'REAL');
 PERFORM commerce_number_lab.lock_profile(w);
 SELECT * INTO r FROM commerce_number_lab.runs WHERE workspace_id=w AND id=rid FOR SHARE;
 SELECT * INTO o FROM commerce_number_lab.operations WHERE workspace_id=w AND run_id=rid AND id=oid FOR SHARE;
 SELECT * INTO b FROM commerce_number_lab.ai_bindings WHERE workspace_id=w AND budget_environment='REAL' AND attempt_id=aid;
 SELECT * INTO v FROM commerce_number_lab.run_releases WHERE workspace_id=w AND run_id=rid AND variant_id=vid;
 SELECT * INTO a FROM public.ai_attempts WHERE workspace_id=w AND environment='REAL' AND attempt_id=aid FOR SHARE;
 IF r.id IS NULL OR r.state IN('COMPLETED','STOPPED') OR r.snapshot_sha256<>snapshot OR o.id IS NULL OR o.state<>'INTENT'
 OR b.attempt_id IS NULL OR (b.run_id,b.variant_id,b.release_id,b.snapshot_sha256,b.grant_id,b.capability)
 IS DISTINCT FROM (rid,vid,lid,snapshot,gid,'chat') OR v.release_id IS DISTINCT FROM lid
 OR a.attempt_id IS NULL OR a.state<>'SUCCEEDED' OR a.intent_at IS NULL OR a.settled_at IS NULL OR a.is_test
 OR a.conversation_id IS NOT NULL OR (a.lab_binding_id,a.variant_id,a.grant_id,a.request_sha256,a.request_bytes,a.capability,a.task)
 IS DISTINCT FROM (aid,vid,gid,b.request_sha256,b.request_bytes,'chat','laboratory.chat') THEN RETURN NULL; END IF;
 -- The original operation can be terminal; it is never re-admitted.
 IF NOT EXISTS(SELECT 1 FROM commerce_number_lab.operations old WHERE old.workspace_id=w AND old.run_id=rid AND old.id=b.operation_id AND old.state IN('INTENT','APPLIED')) THEN RETURN NULL; END IF;
 SELECT * INTO g FROM public.ai_runtime_grants WHERE workspace_id=w AND environment='REAL' AND id=gid FOR SHARE;
 SELECT * INTO k FROM public.ai_credentials WHERE workspace_id=w AND environment='REAL' AND id=a.credential_id FOR SHARE;
 SELECT * INTO p FROM public.ai_model_prices WHERE (provider,model,model_revision,price_version)=(a.provider,a.model,a.model_revision,a.price_version);
 IF g.id IS NULL OR g.revoked_at IS NOT NULL OR g.version<>a.grant_version
 OR (g.variant_id,g.task,g.is_test,g.provider,g.model,g.model_revision,g.price_version,g.credential_id)
 IS DISTINCT FROM (a.variant_id,a.task,a.is_test,a.provider,a.model,a.model_revision,a.price_version,a.credential_id)
 OR k.id IS NULL OR NOT k.enabled OR k.state<>'VERIFIED' OR k.revision<>a.credential_revision OR k.provider<>a.provider
 OR p.provider IS NULL OR (g.provider,g.model,g.model_revision,g.price_version)
 IS DISTINCT FROM (v.quote->>'provider',v.quote->>'model',v.quote->>'modelRevision',v.quote->>'priceVersion') THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.memberships WHERE user_id=g.actor_id AND workspace_id=w AND active AND role='owner' AND version=g.actor_membership_version FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 t:=clock_timestamp();deadline:=least(r.expires_at,g.expires_at,p.valid_until);
 IF deadline<=t OR p.valid_from>t OR a.settled_at>t OR a.intent_at>a.settled_at THEN RETURN NULL; END IF;
 RETURN to_jsonb(p)||jsonb_build_object('valid_until_cache',deadline,'observed_at',t,'request_sha256',a.request_sha256,'request_bytes',a.request_bytes);
END $$;
ALTER FUNCTION commerce_number_lab.lock_cached_seller(text,uuid,uuid,uuid,uuid,uuid,uuid,text) OWNER TO commerce_number_lab_owner;
REVOKE ALL ON FUNCTION commerce_number_lab.lock_cached_seller(text,uuid,uuid,uuid,uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_number_lab.lock_cached_seller(text,uuid,uuid,uuid,uuid,uuid,uuid,text) TO commerce_number_lab;
