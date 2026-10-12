-- V7 F2 cutover: Opaque copies, reference fence, backup files/rows and asset minimization (035-038).
-- Generated from reviewed transition sources; see docs/adr-v7-isolation-model.md.

-- >>> promoted from packages/db/profile-transition/035_privacy_opaque_copies.sql (source sha256 4a4d983f87bdbd0788bbf1628b447ac612f7e98e329e55898c3a1f8a1e4dcf76)
-- V7 F2: 1 role-existence refusal(s) and 2 CREATE ROLE replaced by v7_ensure_reviewed_role (adopts only the exact reviewed safe attributes).
-- Closed opaque-source attestation, before035 copy deletion. No runtime EXECUTE.
-- The separate trusted Root importer must authenticate the reviewed decryptor.
DO $$ BEGIN

 PERFORM public.v7_ensure_reviewed_role('commerce_privacy_opaque_owner',false);
 PERFORM public.v7_ensure_reviewed_role('commerce_privacy_opaque_attestor',false);
END $$;
GRANT USAGE ON SCHEMA public TO commerce_privacy_opaque_owner,commerce_privacy_opaque_attestor;
CREATE TABLE privacy_opaque_implementations(
 id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES profiles(id),parser_sha256 text NOT NULL CHECK(parser_sha256~'^[a-f0-9]{64}$'),capture_sha256 text NOT NULL CHECK(capture_sha256~'^[a-f0-9]{64}$'),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(workspace_id,parser_sha256,capture_sha256)
);
-- No actor gets INSERT here. Implementation adoption is a Root installation task.
CREATE TABLE privacy_opaque_passes(
 id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),journey_id uuid NOT NULL,
 source_version integer NOT NULL CHECK(source_version>0),backup_id uuid NOT NULL REFERENCES privacy_backup_attestations(id),implementation_id uuid NOT NULL REFERENCES privacy_opaque_implementations(id),
 authority_sha256 text NOT NULL CHECK(authority_sha256~'^[a-f0-9]{64}$'),source_set_sha256 text NOT NULL CHECK(source_set_sha256~'^[a-f0-9]{64}$'),
 bindings jsonb NOT NULL CHECK(jsonb_typeof(bindings)='array'),bindings_sha256 text NOT NULL CHECK(bindings_sha256~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,workspace_id,environment,journey_id)
);
ALTER TABLE privacy_opaque_implementations ENABLE ROW LEVEL SECURITY;ALTER TABLE privacy_opaque_implementations FORCE ROW LEVEL SECURITY;
CREATE POLICY privacy_opaque_implementation_scope ON privacy_opaque_implementations TO commerce_privacy_opaque_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND current_setting('app.environment',true)='REAL');
ALTER TABLE privacy_opaque_passes ENABLE ROW LEVEL SECURITY;ALTER TABLE privacy_opaque_passes FORCE ROW LEVEL SECURITY;
CREATE POLICY privacy_opaque_owner_scope ON privacy_opaque_passes TO commerce_privacy_opaque_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL') WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
REVOKE ALL ON privacy_opaque_implementations,privacy_opaque_passes FROM PUBLIC;
GRANT SELECT ON privacy_opaque_implementations TO commerce_privacy_opaque_owner;
GRANT SELECT,INSERT ON privacy_opaque_passes TO commerce_privacy_opaque_owner;
CREATE TRIGGER immutable_privacy_opaque_pass BEFORE UPDATE OR DELETE ON privacy_opaque_passes FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_privacy_opaque_implementation BEFORE UPDATE OR DELETE ON privacy_opaque_implementations FOR EACH ROW EXECUTE FUNCTION immutable_row();
GRANT SELECT ON idempotency,sales_history_imports,reported_sales,records,personal_access_tokens,service_tokens TO commerce_privacy_opaque_owner;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency','sales_history_imports','reported_sales','records'] LOOP
  EXECUTE format('CREATE POLICY privacy_opaque_source ON public.%I FOR SELECT TO commerce_privacy_opaque_owner USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'')',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['personal_access_tokens','service_tokens'] LOOP
  EXECUTE format('CREATE POLICY privacy_opaque_identity ON public.%I FOR SELECT TO commerce_privacy_opaque_owner USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND current_setting(''app.environment'',true)=''REAL'')',t);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION privacy_writer_fence_assert(uuid),privacy_require_writer_fences(),privacy_job_authority(uuid,uuid),privacy_closure_proof(uuid,integer),retention_canonical_json(jsonb) TO commerce_privacy_opaque_owner;

CREATE FUNCTION privacy_opaque_sources(target uuid,expected_version integer,backup uuid,lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');a jsonb;c jsonb;r record;sources jsonb:='[]';keys_value jsonb;set_value jsonb:='[]';n integer:=0;bytes bigint:=0;BEGIN
 IF w IS NULL OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' OR expected_version IS NULL OR expected_version<1 THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_CONTEXT';END IF;
 PERFORM public.privacy_require_writer_fences();PERFORM public.privacy_writer_fence_assert(lease);a:=public.privacy_job_authority(target,backup);c:=public.privacy_closure_proof(target,expected_version);
 IF c->>'verified' IS DISTINCT FROM 'true' OR (c->>'due_at')::timestamptz>clock_timestamp() OR (c->>'source_last_changed_at')::timestamptz>(a->>'backup_snapshot_at')::timestamptz THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_CLOSURE_OR_BACKUP';END IF;
 FOR r IN
  SELECT * FROM (SELECT 'idempotency'::text relation,to_jsonb(i) image,jsonb_build_object('workspace_id',i.workspace_id,'actor_id',i.actor_id,'operation',i.operation,'key',i.key) pk,i.created_at modified FROM public.idempotency i WHERE i.workspace_id=w AND i.environment='REAL' AND i.response ? '_encrypted_response'
  UNION ALL SELECT 'sales_history_imports',to_jsonb(s),jsonb_build_object('id',s.id),greatest(s.created_at,s.committed_at) FROM public.sales_history_imports s WHERE s.workspace_id=w AND s.environment='REAL' AND s.payload_ciphertext NOT LIKE 'REDACTED:%') all_sources
  ORDER BY relation,pk::text LIMIT 129
 LOOP
  n:=n+1;bytes:=bytes+octet_length(r.image::text);IF n>128 OR bytes>33554432 OR octet_length(r.image::text)>12000000 THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_BOUND';END IF;
  IF r.modified IS NULL OR r.modified>(a->>'backup_snapshot_at')::timestamptz THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_BACKUP_BEFORE_SOURCE';END IF;
  keys_value:=jsonb_build_object('relation',r.relation,'key_sha256',encode(public.digest(r.pk::text,'sha256'),'hex'),'source_sha256',encode(public.digest(r.image::text,'sha256'),'hex'));
  set_value:=set_value||jsonb_build_array(keys_value);sources:=sources||jsonb_build_array(keys_value||jsonb_build_object('source_text',r.image::text));
 END LOOP;
 PERFORM public.privacy_writer_fence_assert(lease);IF (a->>'valid_until')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'PRIVACY_BACKUP_UNAVAILABLE';END IF;
 RETURN jsonb_build_object('schema_version',1,'workspace_id',w,'environment','REAL','journey_id',target,'source_version',expected_version,'backup_id',backup,'authority_sha256',encode(public.digest(a::text,'sha256'),'hex'),'source_set_sha256',encode(public.digest(set_value::text,'sha256'),'hex'),'sources',sources,'erasure_authorized',false);
END $$;
ALTER FUNCTION privacy_opaque_sources(uuid,integer,uuid,uuid) OWNER TO commerce_privacy_opaque_owner;
REVOKE ALL ON FUNCTION privacy_opaque_sources(uuid,integer,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_opaque_sources(uuid,integer,uuid,uuid) TO commerce_privacy_opaque_attestor;

CREATE FUNCTION import_privacy_opaque_pass(token uuid,target uuid,expected_version integer,backup uuid,lease uuid,implementation uuid,observations jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE s jsonb;entry jsonb;v jsonb;image jsonb;bind jsonb;bindings_value jsonb:='[]';members jsonb;member jsonb;native record;metadata jsonb;native_hash text;count_value integer;ordinal integer;existing public.privacy_opaque_passes%ROWTYPE;
BEGIN
 IF token IS NULL OR implementation IS NULL OR jsonb_typeof(observations) IS DISTINCT FROM 'array' OR jsonb_array_length(observations)>128 OR octet_length(observations::text)>4194304 OR NOT EXISTS(SELECT 1 FROM public.privacy_opaque_implementations WHERE id=implementation AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'')) THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_ADOPTION_REQUIRED';END IF;
 s:=public.privacy_opaque_sources(target,expected_version,backup,lease);
 IF jsonb_array_length(observations)<>jsonb_array_length(s->'sources') THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_COVERAGE';END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(s->'sources') LOOP
  SELECT count(*),(jsonb_agg(value))->0 INTO count_value,v FROM jsonb_array_elements(observations) WHERE value->>'relation'=entry->>'relation' AND value->>'key_sha256'=entry->>'key_sha256';
  IF count_value<>1 OR v->>'schema_version' IS DISTINCT FROM '1' OR v->>'workspace_id' IS DISTINCT FROM s->>'workspace_id' OR v->>'environment' IS DISTINCT FROM 'REAL' OR v->>'source_sha256' IS DISTINCT FROM entry->>'source_sha256' OR v->>'requires_native_binding' IS DISTINCT FROM 'true' OR v->>'erasure_authorized' IS DISTINCT FROM 'false' OR (v->>'plaintext_sha256'~'^[a-f0-9]{64}$') IS NOT TRUE THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_SOURCE_CHANGED';END IF;
  image:=(entry->>'source_text')::jsonb;
  native_hash:=encode(public.digest(CASE WHEN entry->>'relation'='idempotency' THEN image->'response'->>'_encrypted_response' ELSE image->>'payload_ciphertext' END,'sha256'),'hex');
  IF v->>'ciphertext_sha256' IS DISTINCT FROM native_hash THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_CIPHER_CHANGED';END IF;
  bind:=(entry-'source_text')||jsonb_build_object('ciphertext_sha256',native_hash,'plaintext_sha256',v->>'plaintext_sha256','asset_refs',jsonb_build_array());
  IF entry->>'relation'='idempotency' THEN
   IF v->>'kind' IS DISTINCT FROM 'IDENTITY_CREDENTIAL_CANDIDATE' OR (v-ARRAY['schema_version','relation','key_sha256','workspace_id','environment','source_sha256','ciphertext_sha256','plaintext_sha256','requires_native_binding','erasure_authorized','kind','credential_relation','credential_id','token_sha256','credential_metadata_sha256'])<>'{}'::jsonb THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_IDENTITY_SCHEMA';END IF;
   IF image->>'operation'='personal-token.create' OR image->>'operation'~'^personal-token\.rotate:[a-f0-9-]{36}$' THEN
    IF v->>'credential_relation' IS DISTINCT FROM 'personal_access_tokens' THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_IDENTITY_SCHEMA';END IF;
    SELECT * INTO native FROM public.personal_access_tokens WHERE id=(v->>'credential_id')::uuid AND workspace_id=s->>'workspace_id' AND token_hash=v->>'token_sha256';
    IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_IDENTITY_BINDING';END IF;
    metadata:=jsonb_build_object('id',native.id,'name',native.name,'allowed_environments',native.allowed_environments,'expires_at',to_char(native.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'revoked_at',NULL,'version',1,'created_at',to_char(native.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
   ELSIF image->>'operation' IN('service-token.create','creative.token.create') THEN
    IF v->>'credential_relation' IS DISTINCT FROM 'service_tokens' THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_IDENTITY_SCHEMA';END IF;
    SELECT * INTO native FROM public.service_tokens WHERE id=(v->>'credential_id')::uuid AND workspace_id=s->>'workspace_id' AND token_hash=v->>'token_sha256';
    IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_IDENTITY_BINDING';END IF;
    metadata:=jsonb_build_object('id',native.id,'expires_at',to_char(native.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    IF image->>'operation'='service-token.create' THEN metadata:=metadata||jsonb_build_object('name',native.name,'scopes',native.scopes,'allowed_environments',native.allowed_environments,'resource_ids',native.resource_ids);END IF;
   ELSE RAISE EXCEPTION 'PRIVACY_OPAQUE_OPERATION_UNREVIEWED';END IF;
   IF v->>'credential_metadata_sha256' IS DISTINCT FROM encode(public.digest(public.retention_canonical_json(metadata),'sha256'),'hex') THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_IDENTITY_BINDING';END IF;
   bind:=bind||jsonb_build_object('classification','IDENTITY_ONLY','credential_relation',v->>'credential_relation','credential_id',v->>'credential_id','credential_sha256',encode(public.digest(to_jsonb(native)::text,'sha256'),'hex'));
  ELSE
   IF v->>'kind' IS DISTINCT FROM 'SALES_IMPORT_MEMBERS_CANDIDATE' OR v->>'import_id' IS DISTINCT FROM image->>'id' OR v->>'import_state' IS DISTINCT FROM 'COMMITTED' OR image->>'status' IS DISTINCT FROM 'COMMITTED' OR image->>'committed_at' IS NULL OR jsonb_typeof(v->'members') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'members') NOT BETWEEN 1 AND 1000 OR (v-ARRAY['schema_version','relation','key_sha256','workspace_id','environment','source_sha256','ciphertext_sha256','plaintext_sha256','requires_native_binding','erasure_authorized','kind','import_id','import_state','members'])<>'{}'::jsonb THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_IMPORT_SCHEMA';END IF;
   members:='[]';ordinal:=0;
   FOR member IN SELECT value FROM jsonb_array_elements(v->'members') LOOP
    IF (member-ARRAY['source_key_sha256','content_sha256','reported_body_sha256','eligible'])<>'{}'::jsonb OR member->>'eligible' IS DISTINCT FROM 'true' OR (member->>'source_key_sha256'~'^[a-f0-9]{64}$') IS NOT TRUE OR (member->>'content_sha256'~'^[a-f0-9]{64}$') IS NOT TRUE OR (member->>'reported_body_sha256'~'^[a-f0-9]{64}$') IS NOT TRUE OR EXISTS(SELECT 1 FROM jsonb_array_elements(members)x WHERE x->>'source_key_sha256'=member->>'source_key_sha256') THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_IMPORT_MEMBER';END IF;
    SELECT r.*,o.body->>'conversation_id' journey,encode(public.digest(to_jsonb(r)::text,'sha256'),'hex') row_sha INTO native FROM public.reported_sales r JOIN public.records o ON o.id=r.order_id AND o.workspace_id=r.workspace_id AND o.environment=r.environment AND o.kind='order' WHERE r.workspace_id=s->>'workspace_id' AND r.environment='REAL' AND r.source=image->>'source' AND r.source_key=member->>'source_key_sha256' AND r.content_hash=member->>'content_sha256' AND r.batch_id=(image->>'id')::uuid;
    IF NOT FOUND OR native.journey IS DISTINCT FROM target::text OR member->>'reported_body_sha256' IS DISTINCT FROM encode(public.digest(public.retention_canonical_json(native.body),'sha256'),'hex') THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_IMPORT_SHARED_OR_UNRESOLVED';END IF;
    members:=members||jsonb_build_array(member||jsonb_build_object('index',ordinal,'reported_id',native.id,'order_id',native.order_id,'reported_sha256',native.row_sha));ordinal:=ordinal+1;
   END LOOP;
   IF ordinal<>(SELECT count(*) FROM public.reported_sales WHERE workspace_id=s->>'workspace_id' AND environment='REAL' AND batch_id=(image->>'id')::uuid) THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_IMPORT_COVERAGE';END IF;
   bind:=bind||jsonb_build_object('classification','OWNED_IMPORT','members',members);
  END IF;
  bindings_value:=bindings_value||jsonb_build_array(bind);
 END LOOP;
 -- Reread after all native bindings; authority and lease remain original.
 IF s IS DISTINCT FROM public.privacy_opaque_sources(target,expected_version,backup,lease) THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_SOURCE_CHANGED';END IF;
 SELECT * INTO existing FROM public.privacy_opaque_passes WHERE id=token;
 IF FOUND THEN
  IF (existing.workspace_id,existing.journey_id,existing.source_version,existing.backup_id,existing.implementation_id,existing.authority_sha256,existing.source_set_sha256,existing.bindings) IS DISTINCT FROM(s->>'workspace_id',target,expected_version,backup,implementation,s->>'authority_sha256',s->>'source_set_sha256',bindings_value) THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_PASS_CHANGED';END IF;
 ELSE INSERT INTO public.privacy_opaque_passes(id,workspace_id,journey_id,source_version,backup_id,implementation_id,authority_sha256,source_set_sha256,bindings,bindings_sha256) VALUES(token,s->>'workspace_id',target,expected_version,backup,implementation,s->>'authority_sha256',s->>'source_set_sha256',bindings_value,encode(public.digest(bindings_value::text,'sha256'),'hex'));END IF;
 RETURN jsonb_build_object('schema_version',1,'receipt_uuid',token,'workspace_id',s->>'workspace_id','environment','REAL','journey_id',target,'backup_id',backup,'source_set_sha256',s->>'source_set_sha256','bindings_sha256',encode(public.digest(bindings_value::text,'sha256'),'hex'),'bindings',bindings_value,'erasure_authorized',false);
END $$;
ALTER FUNCTION import_privacy_opaque_pass(uuid,uuid,integer,uuid,uuid,uuid,jsonb) OWNER TO commerce_privacy_opaque_owner;
REVOKE ALL ON FUNCTION import_privacy_opaque_pass(uuid,uuid,integer,uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_privacy_opaque_pass(uuid,uuid,integer,uuid,uuid,uuid,jsonb) TO commerce_privacy_opaque_attestor;
-- Pass verification for031/036. No caller receives EXECUTE until final composition.
CREATE FUNCTION read_privacy_opaque_pass(token uuid,target uuid,backup uuid,lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p public.privacy_opaque_passes%ROWTYPE;s jsonb;b jsonb;m jsonb;row_sha text;BEGIN
 SELECT * INTO STRICT p FROM public.privacy_opaque_passes WHERE id=token AND journey_id=target AND backup_id=backup AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'');
 s:=public.privacy_opaque_sources(target,p.source_version,backup,lease);
 IF (p.authority_sha256,p.source_set_sha256,p.bindings_sha256) IS DISTINCT FROM(s->>'authority_sha256',s->>'source_set_sha256',encode(public.digest(p.bindings::text,'sha256'),'hex')) THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_PASS_CHANGED';END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(p.bindings) LOOP
  IF b->>'classification'='IDENTITY_ONLY' THEN
   IF b->>'credential_relation'='personal_access_tokens' THEN SELECT encode(public.digest(to_jsonb(t)::text,'sha256'),'hex') INTO row_sha FROM public.personal_access_tokens t WHERE id=(b->>'credential_id')::uuid AND workspace_id=p.workspace_id;
   ELSIF b->>'credential_relation'='service_tokens' THEN SELECT encode(public.digest(to_jsonb(t)::text,'sha256'),'hex') INTO row_sha FROM public.service_tokens t WHERE id=(b->>'credential_id')::uuid AND workspace_id=p.workspace_id;
   ELSE RAISE EXCEPTION 'PRIVACY_OPAQUE_PASS_CHANGED';END IF;
   IF row_sha IS DISTINCT FROM b->>'credential_sha256' THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_BINDING_CHANGED';END IF;
  ELSIF b->>'classification'='OWNED_IMPORT' THEN
   FOR m IN SELECT value FROM jsonb_array_elements(b->'members') LOOP
    SELECT encode(public.digest(to_jsonb(r)::text,'sha256'),'hex') INTO row_sha FROM public.reported_sales r JOIN public.records o ON o.id=r.order_id AND o.workspace_id=r.workspace_id AND o.environment=r.environment AND o.kind='order' WHERE r.id=(m->>'reported_id')::uuid AND r.workspace_id=p.workspace_id AND r.environment='REAL' AND o.body->>'conversation_id'=target::text;
    IF row_sha IS DISTINCT FROM m->>'reported_sha256' THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_BINDING_CHANGED';END IF;
   END LOOP;
  ELSE RAISE EXCEPTION 'PRIVACY_OPAQUE_PASS_CHANGED';END IF;
 END LOOP;
 RETURN jsonb_build_object('schema_version',1,'receipt_uuid',p.id,'receipt_sha256',encode(public.digest(to_jsonb(p)::text,'sha256'),'hex'),'workspace_id',p.workspace_id,'environment','REAL','journey_id',p.journey_id,'backup_id',p.backup_id,'source_set_sha256',p.source_set_sha256,'bindings_sha256',p.bindings_sha256,'bindings',p.bindings,'erasure_authorized',false);
END $$;
ALTER FUNCTION read_privacy_opaque_pass(uuid,uuid,uuid,uuid) OWNER TO commerce_privacy_opaque_owner;
REVOKE ALL ON FUNCTION read_privacy_opaque_pass(uuid,uuid,uuid,uuid) FROM PUBLIC;
-- <<< end 035_privacy_opaque_copies.sql

-- >>> promoted from packages/db/profile-transition/components/035_privacy_reference_fence.sql (source sha256 d830a4f892ecbd09bedf34f47479fdb89f0d994c621b745ea02c1697376bb8a9)
-- V7 F2: 1 role-existence refusal(s) and 2 CREATE ROLE replaced by v7_ensure_reviewed_role (adopts only the exact reviewed safe attributes).
-- Additive global reference fence. 030 remains byte-identical.
DO $$ BEGIN

 PERFORM public.v7_ensure_reviewed_role('commerce_privacy_reference_owner',false);
 PERFORM public.v7_ensure_reviewed_role('commerce_privacy_reference_worker',false);
END $$;
GRANT USAGE ON SCHEMA public TO commerce_privacy_reference_owner,commerce_privacy_reference_worker;
CREATE TABLE privacy_reference_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO privacy_reference_epoch DEFAULT VALUES;
CREATE TABLE privacy_reference_leases(
 id uuid PRIMARY KEY,backend_pid integer NOT NULL,epoch bigint NOT NULL CHECK(epoch>0),
 acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),valid_until timestamptz NOT NULL,released_at timestamptz,
 CHECK(valid_until>acquired_at AND valid_until<=acquired_at+interval '30 seconds'),CHECK(released_at IS NULL OR released_at>=acquired_at)
);
ALTER TABLE privacy_reference_epoch ENABLE ROW LEVEL SECURITY;ALTER TABLE privacy_reference_epoch FORCE ROW LEVEL SECURITY;
ALTER TABLE privacy_reference_leases ENABLE ROW LEVEL SECURITY;ALTER TABLE privacy_reference_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY privacy_reference_epoch_owner ON privacy_reference_epoch TO commerce_privacy_reference_owner USING(singleton) WITH CHECK(singleton);
CREATE POLICY privacy_reference_lease_owner ON privacy_reference_leases TO commerce_privacy_reference_owner USING(true) WITH CHECK(true);
REVOKE ALL ON privacy_reference_epoch,privacy_reference_leases FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON privacy_reference_epoch,privacy_reference_leases TO commerce_privacy_reference_owner;
CREATE FUNCTION privacy_reference_lock_key() RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT hashtextextended('commerce-privacy-global-references-v1',0) $$;
CREATE FUNCTION privacy_reference_lock_held() RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock' AND objsubid=1 AND classid=((public.privacy_reference_lock_key()>>32)&4294967295)::oid AND objid=(public.privacy_reference_lock_key()&4294967295)::oid) $$;
REVOKE ALL ON FUNCTION privacy_reference_lock_key(),privacy_reference_lock_held() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_reference_lock_key(),privacy_reference_lock_held() TO commerce_privacy_reference_owner;
CREATE FUNCTION privacy_reference_fence_acquire() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE token uuid:=gen_random_uuid();r bigint;observed timestamptz;deadline timestamptz;BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' OR to_regclass('pg_temp.privacy_reference_session') IS NOT NULL OR public.privacy_reference_lock_held() THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_ACQUIRE_CONTEXT';END IF;
 IF NOT pg_try_advisory_lock(public.privacy_reference_lock_key()) THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_WRITERS_BUSY';END IF;
 BEGIN
  SELECT revision INTO STRICT r FROM public.privacy_reference_epoch WHERE singleton FOR SHARE;
  CREATE TEMP TABLE privacy_reference_session(lease_id uuid PRIMARY KEY) ON COMMIT PRESERVE ROWS;REVOKE ALL ON pg_temp.privacy_reference_session FROM PUBLIC;
  INSERT INTO pg_temp.privacy_reference_session VALUES(token);observed:=clock_timestamp();deadline:=observed+interval '30 seconds';
  INSERT INTO public.privacy_reference_leases(id,backend_pid,epoch,acquired_at,valid_until) VALUES(token,pg_backend_pid(),r,observed,deadline);
 EXCEPTION WHEN OTHERS THEN PERFORM pg_advisory_unlock(public.privacy_reference_lock_key());RAISE;END;
 RETURN jsonb_build_object('lease_id',token,'epoch',r::text,'valid_until',deadline);
END $$;
ALTER FUNCTION privacy_reference_fence_acquire() OWNER TO commerce_privacy_reference_owner;
REVOKE ALL ON FUNCTION privacy_reference_fence_acquire() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_reference_fence_acquire() TO commerce_privacy_reference_worker;
CREATE FUNCTION privacy_reference_fence_assert(token uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public.privacy_reference_leases%ROWTYPE;r bigint;BEGIN
 IF token IS NULL OR current_setting('transaction_isolation') IS DISTINCT FROM 'repeatable read' THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_CONTEXT';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE relname='privacy_reference_session' AND relnamespace=pg_my_temp_schema() AND relpersistence='t' AND relkind='r' AND relowner='commerce_privacy_reference_owner'::regrole) THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_SESSION_INVALID';END IF;
 IF(SELECT lease_id FROM pg_temp.privacy_reference_session) IS DISTINCT FROM token THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_SESSION_INVALID';END IF;
 SELECT * INTO a FROM public.privacy_reference_leases WHERE id=token;
 IF NOT FOUND OR a.backend_pid<>pg_backend_pid() OR a.released_at IS NOT NULL OR a.valid_until<=clock_timestamp() OR NOT public.privacy_reference_lock_held() THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_INVALID';END IF;
 SELECT revision INTO STRICT r FROM public.privacy_reference_epoch WHERE singleton FOR SHARE;
 IF r IS DISTINCT FROM a.epoch THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_EPOCH_CHANGED';END IF;RETURN r;
END $$;
ALTER FUNCTION privacy_reference_fence_assert(uuid) OWNER TO commerce_privacy_reference_owner;
REVOKE ALL ON FUNCTION privacy_reference_fence_assert(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_reference_fence_assert(uuid) TO commerce_privacy_reference_worker;
CREATE FUNCTION privacy_reference_fence_advance(token uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r bigint;BEGIN
 r:=public.privacy_reference_fence_assert(token);
 UPDATE public.privacy_reference_epoch SET revision=revision+1 WHERE singleton AND revision=r RETURNING revision INTO r;
 IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_EPOCH_CHANGED';END IF;
 UPDATE public.privacy_reference_leases SET released_at=clock_timestamp() WHERE id=token;RETURN r;
END $$;
ALTER FUNCTION privacy_reference_fence_advance(uuid) OWNER TO commerce_privacy_reference_owner;
REVOKE ALL ON FUNCTION privacy_reference_fence_advance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_reference_fence_advance(uuid) TO commerce_privacy_reference_worker;
CREATE FUNCTION privacy_reference_writer_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r bigint;BEGIN
 -- REAL and SIMULATION may reference the same filesystem. No environment bypass.
 IF NOT pg_try_advisory_xact_lock_shared(public.privacy_reference_lock_key()) THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_WRITERS_BUSY';END IF;
 SELECT revision INTO STRICT r FROM public.privacy_reference_epoch WHERE singleton FOR SHARE;
 -- FOR SHARE raises serialization failure for an RR snapshot older than advance.
 RETURN COALESCE(NEW,OLD);
END $$;
ALTER FUNCTION privacy_reference_writer_guard() OWNER TO commerce_privacy_reference_owner;
REVOKE ALL ON FUNCTION privacy_reference_writer_guard() FROM PUBLIC;
-- <<< end components/035_privacy_reference_fence.sql

-- >>> promoted from packages/db/profile-transition/components/036_privacy_backup_files.sql (source sha256 c270bc5640e9b5818ea01ed9c8421ceab437226b284e040418c0bf51d9e7e4e5)
-- V7 F2: 1 role-existence refusal(s) and 1 CREATE ROLE replaced by v7_ensure_reviewed_role (adopts only the exact reviewed safe attributes).
-- Install before the final028/030 catalog seals and the restored031 import.
-- Only the existing private backup attestor may import a measured restored set.
DO $$ BEGIN

 PERFORM public.v7_ensure_reviewed_role('commerce_privacy_file_owner',false);
END $$;
GRANT USAGE ON SCHEMA public TO commerce_privacy_file_owner;
CREATE TABLE privacy_backup_file_sets(
 backup_id uuid PRIMARY KEY REFERENCES privacy_backup_attestations(id),workspace_id text NOT NULL REFERENCES profiles(id),
 environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),restore_sha256 text NOT NULL CHECK(restore_sha256~'^[a-f0-9]{64}$'),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256~'^[a-f0-9]{64}$'),
 files jsonb NOT NULL CHECK(jsonb_typeof(files)='array'),files_sha256 text NOT NULL CHECK(files_sha256~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(backup_id,workspace_id,environment)
);
ALTER TABLE privacy_backup_file_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_backup_file_sets FORCE ROW LEVEL SECURITY;
CREATE POLICY privacy_backup_files_scope ON privacy_backup_file_sets TO commerce_privacy_file_owner
 USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL')
 WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
REVOKE ALL ON privacy_backup_file_sets FROM PUBLIC;
GRANT SELECT,INSERT ON privacy_backup_file_sets TO commerce_privacy_file_owner;
CREATE TRIGGER immutable_privacy_backup_file_set BEFORE UPDATE OR DELETE ON privacy_backup_file_sets FOR EACH ROW EXECUTE FUNCTION immutable_row();
GRANT SELECT ON privacy_backup_attestations,privacy_backup_revocations,privacy_jobs TO commerce_privacy_file_owner;
CREATE POLICY privacy_file_backup_reader ON privacy_backup_attestations FOR SELECT TO commerce_privacy_file_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY privacy_file_revocation_reader ON privacy_backup_revocations FOR SELECT TO commerce_privacy_file_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY privacy_file_job_reader ON privacy_jobs FOR SELECT TO commerce_privacy_file_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
GRANT EXECUTE ON FUNCTION privacy_runtime_fingerprint(),privacy_require_writer_fences(),privacy_writer_fence_assert(uuid),privacy_job_authority(uuid,uuid) TO commerce_privacy_file_owner;

CREATE FUNCTION import_privacy_backup_files(backup uuid,restore_receipt text,evidence text,entries jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');b public.privacy_backup_attestations%ROWTYPE;prior public.privacy_backup_file_sets%ROWTYPE;
 e jsonb;normalized jsonb;entry_hash text;seen_assets uuid[]:=ARRAY[]::uuid[];seen_keys text[]:=ARRAY[]::text[];asset uuid;key text;
BEGIN
 IF w IS NULL OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' OR backup IS NULL OR restore_receipt IS NULL OR restore_receipt!~'^[a-f0-9]{64}$' OR evidence IS NULL OR evidence!~'^[a-f0-9]{64}$'
  OR entries IS NULL OR jsonb_typeof(entries)<>'array' OR octet_length(entries::text)>16777216 OR jsonb_array_length(entries)>10000 THEN RAISE EXCEPTION 'PRIVACY_BACKUP_FILES_INPUT';END IF;
 PERFORM public.privacy_require_writer_fences();
 SELECT * INTO b FROM public.privacy_backup_attestations WHERE id=backup AND workspace_id=w;
 IF NOT FOUND OR b.valid_until<=clock_timestamp() OR b.restore_sha256<>restore_receipt OR EXISTS(SELECT 1 FROM public.privacy_backup_revocations WHERE backup_id=backup AND workspace_id=w) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_FILES_AUTHORITY';END IF;
 IF b.topology_sha256 IS DISTINCT FROM public.privacy_runtime_fingerprint() THEN RAISE EXCEPTION 'PRIVACY_BACKUP_TOPOLOGY_CHANGED';END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(entries) LOOP
  IF jsonb_typeof(e)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k) IS DISTINCT FROM ARRAY['asset_id','ciphertext_bytes','ciphertext_sha256','storage_key']
   OR jsonb_typeof(e->'asset_id') IS DISTINCT FROM 'string' OR e->>'asset_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(e->'storage_key') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'ciphertext_sha256') IS DISTINCT FROM 'string' OR e->>'ciphertext_sha256'!~'^[a-f0-9]{64}$'
   OR jsonb_typeof(e->'ciphertext_bytes') IS DISTINCT FROM 'string' OR e->>'ciphertext_bytes'!~'^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'PRIVACY_BACKUP_FILE_DESCRIPTOR';END IF;
  asset:=(e->>'asset_id')::uuid;key:=e->>'storage_key';
  IF key<>asset::text AND key!~('^'||asset::text||'-[a-f0-9]{64}$') THEN RAISE EXCEPTION 'PRIVACY_BACKUP_FILE_KEY';END IF;
  IF (e->>'ciphertext_bytes')::bigint>536870912 OR asset=ANY(seen_assets) OR key=ANY(seen_keys) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_FILES_BOUND';END IF;
  seen_assets:=array_append(seen_assets,asset);seen_keys:=array_append(seen_keys,key);
 END LOOP;
 SELECT COALESCE(jsonb_agg(value ORDER BY value->>'asset_id'),'[]') INTO normalized FROM jsonb_array_elements(entries);
 entry_hash:=encode(public.digest(normalized::text,'sha256'),'hex');
 IF b.valid_until<=clock_timestamp() THEN RAISE EXCEPTION 'PRIVACY_BACKUP_FILES_AUTHORITY';END IF;
 SELECT * INTO prior FROM public.privacy_backup_file_sets WHERE backup_id=backup AND workspace_id=w;
 IF FOUND THEN
  IF(prior.restore_sha256,prior.evidence_sha256,prior.files,prior.files_sha256) IS DISTINCT FROM(restore_receipt,evidence,normalized,entry_hash) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_FILES_CONFLICT';END IF;
  RETURN jsonb_build_object('status','NO_EFFECT','backup_id',backup,'files',jsonb_array_length(normalized),'files_sha256',entry_hash);
 END IF;
 INSERT INTO public.privacy_backup_file_sets(backup_id,workspace_id,restore_sha256,evidence_sha256,files,files_sha256) VALUES(backup,w,restore_receipt,evidence,normalized,entry_hash);
 RETURN jsonb_build_object('status','IMPORTED','backup_id',backup,'files',jsonb_array_length(normalized),'files_sha256',entry_hash);
END $$;
ALTER FUNCTION import_privacy_backup_files(uuid,text,text,jsonb) OWNER TO commerce_privacy_file_owner;
REVOKE ALL ON FUNCTION import_privacy_backup_files(uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_privacy_backup_files(uuid,text,text,jsonb) TO commerce_privacy_attestor;

-- Closed reader for036 candidate derivation only; no EXECUTE adoption here.
CREATE FUNCTION read_privacy_backup_files(job uuid,lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE j public.privacy_jobs%ROWTYPE;b public.privacy_backup_file_sets%ROWTYPE;a jsonb;
BEGIN
 PERFORM public.privacy_require_writer_fences();PERFORM public.privacy_writer_fence_assert(lease);
 SELECT * INTO STRICT j FROM public.privacy_jobs WHERE id=job AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'');
 a:=public.privacy_job_authority(j.journey_id,j.backup_id);
 IF a IS DISTINCT FROM j.manifest->'authority' OR encode(public.digest(j.manifest::text,'sha256'),'hex')<>j.manifest_sha256 THEN RAISE EXCEPTION 'PRIVACY_BACKUP_FILES_JOB_CHANGED';END IF;
 SELECT * INTO STRICT b FROM public.privacy_backup_file_sets WHERE backup_id=j.backup_id AND workspace_id=j.workspace_id AND environment='REAL';
 IF b.files_sha256<>encode(public.digest(b.files::text,'sha256'),'hex') OR NOT EXISTS(SELECT 1 FROM public.privacy_backup_attestations x WHERE x.id=b.backup_id AND x.workspace_id=b.workspace_id AND x.restore_sha256=b.restore_sha256) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_FILES_CHANGED';END IF;
 IF(a->>'valid_until')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'PRIVACY_BACKUP_FILES_AUTHORITY';END IF;
 RETURN jsonb_build_object('backup_id',b.backup_id,'restore_sha256',b.restore_sha256,'evidence_sha256',b.evidence_sha256,'files_sha256',b.files_sha256,'files',b.files,
  'backup_snapshot_unix_ns',((extract(epoch FROM(a->>'backup_snapshot_at')::timestamptz)*1000000000)::numeric(30,0))::text,'valid_until',a->>'valid_until');
END $$;
ALTER FUNCTION read_privacy_backup_files(uuid,uuid) OWNER TO commerce_privacy_file_owner;
REVOKE ALL ON FUNCTION read_privacy_backup_files(uuid,uuid) FROM PUBLIC;
-- <<< end components/036_privacy_backup_files.sql

-- >>> promoted from packages/db/profile-transition/components/037_privacy_backup_rows.sql (source sha256 67b4f95b4c42324bd2b69a664236e62366a65d84e966cb00a41b9cf9d28b4ab4)
-- V7 F2: 1 role-existence refusal(s) and 1 CREATE ROLE replaced by v7_ensure_reviewed_role (adopts only the exact reviewed safe attributes).
-- Install before generated037 readers and final028/030 seals. No erasure RPC.
DO $$ BEGIN

 PERFORM public.v7_ensure_reviewed_role('commerce_privacy_row_owner',false);
END $$;
GRANT USAGE ON SCHEMA public TO commerce_privacy_row_owner;
CREATE TABLE privacy_backup_row_sets(
 backup_id uuid PRIMARY KEY REFERENCES privacy_backup_attestations(id),workspace_id text NOT NULL REFERENCES profiles(id),
 environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),restore_sha256 text NOT NULL CHECK(restore_sha256~'^[a-f0-9]{64}$'),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256~'^[a-f0-9]{64}$'),catalog_sha256 text NOT NULL CHECK(catalog_sha256~'^[a-f0-9]{64}$'),
 row_count bigint NOT NULL CHECK(row_count>=0),page_count integer NOT NULL CHECK(page_count>0),root_sha256 text NOT NULL CHECK(root_sha256~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(backup_id,workspace_id,environment)
);
CREATE TABLE privacy_backup_row_pages(
 backup_id uuid NOT NULL,workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),page_index integer NOT NULL CHECK(page_index>=0),
 row_count integer NOT NULL CHECK(row_count BETWEEN 0 AND 2000),page_sha256 text NOT NULL CHECK(page_sha256~'^[a-f0-9]{64}$'),
 PRIMARY KEY(backup_id,page_index),FOREIGN KEY(backup_id,workspace_id,environment) REFERENCES privacy_backup_row_sets(backup_id,workspace_id,environment)
);
CREATE TABLE privacy_backup_row_entries(
 backup_id uuid NOT NULL,workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),page_index integer NOT NULL,
 relation_name text NOT NULL,key_sha256 text NOT NULL CHECK(key_sha256~'^[a-f0-9]{64}$'),source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),
 PRIMARY KEY(backup_id,relation_name,key_sha256),FOREIGN KEY(backup_id,workspace_id,environment) REFERENCES privacy_backup_row_sets(backup_id,workspace_id,environment),
 FOREIGN KEY(backup_id,page_index) REFERENCES privacy_backup_row_pages(backup_id,page_index) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE privacy_backup_row_seals(
 backup_id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 row_count bigint NOT NULL,page_count integer NOT NULL,root_sha256 text NOT NULL CHECK(root_sha256~'^[a-f0-9]{64}$'),sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(backup_id,workspace_id,environment) REFERENCES privacy_backup_row_sets(backup_id,workspace_id,environment)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['privacy_backup_row_sets','privacy_backup_row_pages','privacy_backup_row_entries','privacy_backup_row_seals'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format($policy$CREATE POLICY privacy_backup_rows_scope ON public.%I TO commerce_privacy_row_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL') WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL')$policy$,t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);EXECUTE format('GRANT SELECT,INSERT ON public.%I TO commerce_privacy_row_owner',t);
  EXECUTE format('CREATE TRIGGER immutable_privacy_backup_rows BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION immutable_row()',t);
 END LOOP;
END $$;
GRANT SELECT ON privacy_backup_attestations,privacy_backup_revocations,privacy_jobs TO commerce_privacy_row_owner;
CREATE POLICY privacy_row_backup_reader ON privacy_backup_attestations FOR SELECT TO commerce_privacy_row_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY privacy_row_revocation_reader ON privacy_backup_revocations FOR SELECT TO commerce_privacy_row_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY privacy_row_job_reader ON privacy_jobs FOR SELECT TO commerce_privacy_row_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
GRANT EXECUTE ON FUNCTION privacy_runtime_fingerprint(),privacy_require_writer_fences(),privacy_writer_fence_assert(uuid),privacy_job_authority(uuid,uuid) TO commerce_privacy_row_owner;

CREATE FUNCTION privacy_backup_row_page_hash(entries jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(public.digest(COALESCE(string_agg((e->>'relation')||':'||(e->>'key_sha256')||':'||(e->>'source_sha256')||chr(10),'' ORDER BY n),''),'sha256'),'hex') FROM jsonb_array_elements(entries) WITH ORDINALITY x(e,n)
$$;
REVOKE ALL ON FUNCTION privacy_backup_row_page_hash(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_backup_row_page_hash(jsonb) TO commerce_privacy_row_owner;

CREATE FUNCTION privacy_backup_rows_import_authority(backup uuid,restore_receipt text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b public.privacy_backup_attestations%ROWTYPE;w text:=NULLIF(current_setting('app.workspace_id',true),'');BEGIN
 IF w IS NULL OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_CONTEXT';END IF;
 PERFORM public.privacy_require_writer_fences();PERFORM public.privacy_backup_row_catalog();
 SELECT * INTO b FROM public.privacy_backup_attestations WHERE id=backup AND workspace_id=w;
 IF NOT FOUND OR b.valid_until<=clock_timestamp() OR b.restore_sha256 IS DISTINCT FROM restore_receipt OR EXISTS(SELECT 1 FROM public.privacy_backup_revocations WHERE backup_id=backup AND workspace_id=w) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_AUTHORITY';END IF;
 IF b.topology_sha256 IS DISTINCT FROM public.privacy_runtime_fingerprint() THEN RAISE EXCEPTION 'PRIVACY_BACKUP_TOPOLOGY_CHANGED';END IF;
END $$;
ALTER FUNCTION privacy_backup_rows_import_authority(uuid,text) OWNER TO commerce_privacy_row_owner;
REVOKE ALL ON FUNCTION privacy_backup_rows_import_authority(uuid,text) FROM PUBLIC;

CREATE FUNCTION import_privacy_backup_rows(backup uuid,restore_receipt text,evidence text,page jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');prior public.privacy_backup_row_sets%ROWTYPE;old_page public.privacy_backup_row_pages%ROWTYPE;
 e jsonb;entries jsonb;catalog jsonb;entry_hash text;index_value integer;count_value bigint;pages_value integer;previous_key text[];current_key text[];
BEGIN
 IF backup IS NULL OR restore_receipt IS NULL OR restore_receipt!~'^[a-f0-9]{64}$' OR evidence IS NULL OR evidence!~'^[a-f0-9]{64}$' OR page IS NULL OR jsonb_typeof(page)<>'object' OR octet_length(page::text)>1048576
 OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(page)k) IS DISTINCT FROM ARRAY['catalog_sha256','entries','page_count','page_index','root_sha256','row_count','schema_version']
 OR page->>'schema_version' IS DISTINCT FROM '1' OR jsonb_typeof(page->'row_count') IS DISTINCT FROM 'string' OR (page->>'row_count'~'^(0|[1-9][0-9]{0,12})$') IS NOT TRUE
 OR jsonb_typeof(page->'page_count') IS DISTINCT FROM 'number' OR (page->>'page_count'~'^[1-9][0-9]{0,8}$') IS NOT TRUE
 OR jsonb_typeof(page->'page_index') IS DISTINCT FROM 'number' OR (page->>'page_index'~'^(0|[1-9][0-9]{0,8})$') IS NOT TRUE
 OR (page->>'root_sha256'~'^[a-f0-9]{64}$') IS NOT TRUE OR jsonb_typeof(page->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(page->'entries')>2000 THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_INPUT';END IF;
 PERFORM public.privacy_backup_rows_import_authority(backup,restore_receipt);catalog:=public.privacy_backup_row_catalog();
 IF page->>'catalog_sha256' IS DISTINCT FROM catalog->>'catalog_sha256' THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROW_CATALOG_CHANGED';END IF;
 entries:=page->'entries';index_value:=(page->>'page_index')::integer;count_value:=(page->>'row_count')::bigint;pages_value:=(page->>'page_count')::integer;
 IF index_value>=pages_value OR (count_value=0 AND (pages_value<>1 OR jsonb_array_length(entries)<>0)) OR (count_value>0 AND jsonb_array_length(entries)=0) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_INPUT';END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(entries) LOOP
  IF jsonb_typeof(e)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e)k) IS DISTINCT FROM ARRAY['key_sha256','relation','source_sha256']
  OR jsonb_typeof(e->'relation') IS DISTINCT FROM 'string' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(catalog->'relations') r WHERE r->>'name'=e->>'relation')
  OR jsonb_typeof(e->'key_sha256') IS DISTINCT FROM 'string' OR (e->>'key_sha256'~'^[a-f0-9]{64}$') IS NOT TRUE
  OR jsonb_typeof(e->'source_sha256') IS DISTINCT FROM 'string' OR (e->>'source_sha256'~'^[a-f0-9]{64}$') IS NOT TRUE THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROW_DESCRIPTOR';END IF;
  current_key:=ARRAY[e->>'relation',e->>'key_sha256'];IF previous_key IS NOT NULL AND previous_key COLLATE "C">=current_key COLLATE "C" THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_ORDER';END IF;previous_key:=current_key;
 END LOOP;
 entry_hash:=public.privacy_backup_row_page_hash(entries);
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy-backup-rows:'||backup::text,0));
 SELECT * INTO prior FROM public.privacy_backup_row_sets WHERE backup_id=backup AND workspace_id=w;
 IF FOUND THEN
  IF(prior.restore_sha256,prior.evidence_sha256,prior.catalog_sha256,prior.row_count,prior.page_count,prior.root_sha256) IS DISTINCT FROM(restore_receipt,evidence,page->>'catalog_sha256',count_value,pages_value,page->>'root_sha256') THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_CONFLICT';END IF;
 ELSE
  INSERT INTO public.privacy_backup_row_sets(backup_id,workspace_id,restore_sha256,evidence_sha256,catalog_sha256,row_count,page_count,root_sha256) VALUES(backup,w,restore_receipt,evidence,page->>'catalog_sha256',count_value,pages_value,page->>'root_sha256');
 END IF;
 SELECT * INTO old_page FROM public.privacy_backup_row_pages WHERE backup_id=backup AND page_index=index_value;
 IF FOUND THEN
  IF(old_page.row_count,old_page.page_sha256) IS DISTINCT FROM(jsonb_array_length(entries),entry_hash) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_CONFLICT';END IF;
  PERFORM public.privacy_backup_rows_import_authority(backup,restore_receipt);
  RETURN jsonb_build_object('status','NO_EFFECT','backup_id',backup,'page_index',index_value,'page_sha256',entry_hash);
 END IF;
 IF EXISTS(SELECT 1 FROM public.privacy_backup_row_seals WHERE backup_id=backup) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_SEALED';END IF;
 INSERT INTO public.privacy_backup_row_pages(backup_id,workspace_id,page_index,row_count,page_sha256) VALUES(backup,w,index_value,jsonb_array_length(entries),entry_hash);
 INSERT INTO public.privacy_backup_row_entries(backup_id,workspace_id,page_index,relation_name,key_sha256,source_sha256) SELECT backup,w,index_value,x.value->>'relation',x.value->>'key_sha256',x.value->>'source_sha256' FROM jsonb_array_elements(entries)x;
 PERFORM public.privacy_backup_rows_import_authority(backup,restore_receipt);
 RETURN jsonb_build_object('status','IMPORTED','backup_id',backup,'page_index',index_value,'page_sha256',entry_hash);
END $$;
ALTER FUNCTION import_privacy_backup_rows(uuid,text,text,jsonb) OWNER TO commerce_privacy_row_owner;
REVOKE ALL ON FUNCTION import_privacy_backup_rows(uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_privacy_backup_rows(uuid,text,text,jsonb) TO commerce_privacy_attestor;

CREATE FUNCTION seal_privacy_backup_rows(backup uuid,restore_receipt text,evidence text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s public.privacy_backup_row_sets%ROWTYPE;p record;idx integer:=0;total bigint:=0;root text:=encode(public.digest('PRIVACY_BACKUP_ROWS_V1','sha256'),'hex');existed boolean;
BEGIN
 PERFORM public.privacy_backup_rows_import_authority(backup,restore_receipt);PERFORM pg_advisory_xact_lock(hashtextextended('privacy-backup-rows:'||backup::text,0));
 SELECT * INTO STRICT s FROM public.privacy_backup_row_sets WHERE backup_id=backup AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'');
 IF s.evidence_sha256 IS DISTINCT FROM evidence THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_CONFLICT';END IF;
 FOR p IN SELECT * FROM public.privacy_backup_row_pages WHERE backup_id=backup ORDER BY page_index LOOP
  IF p.page_index<>idx THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_INCOMPLETE';END IF;
  root:=encode(public.digest(root||chr(10)||p.page_sha256,'sha256'),'hex');idx:=idx+1;total:=total+p.row_count;
 END LOOP;
 IF(idx,total,root) IS DISTINCT FROM(s.page_count,s.row_count,s.root_sha256) OR (SELECT count(*) FROM public.privacy_backup_row_entries WHERE backup_id=backup)<>s.row_count THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_INCOMPLETE';END IF;
 existed:=EXISTS(SELECT 1 FROM public.privacy_backup_row_seals WHERE backup_id=backup);
 IF NOT existed THEN INSERT INTO public.privacy_backup_row_seals(backup_id,workspace_id,row_count,page_count,root_sha256) VALUES(backup,s.workspace_id,total,idx,root);END IF;
 PERFORM public.privacy_backup_rows_import_authority(backup,restore_receipt);
 RETURN jsonb_build_object('status',CASE WHEN existed THEN 'NO_EFFECT' ELSE 'SEALED' END,'backup_id',backup,'row_count',total::text,'page_count',idx,'root_sha256',root,'erasure_authorized',false);
END $$;
ALTER FUNCTION seal_privacy_backup_rows(uuid,text,text) OWNER TO commerce_privacy_row_owner;
REVOKE ALL ON FUNCTION seal_privacy_backup_rows(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seal_privacy_backup_rows(uuid,text,text) TO commerce_privacy_attestor;

-- One031 authority check and one native scan per relation; no runtime grant.
CREATE FUNCTION assert_privacy_backup_rows(job uuid,lease uuid,entries jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j public.privacy_jobs%ROWTYPE;s public.privacy_backup_row_sets%ROWTYPE;a jsonb;e jsonb;spec record;actual jsonb;expected jsonb;keys text[];catalog jsonb;
BEGIN
 IF entries IS NULL OR jsonb_typeof(entries)<>'array' OR jsonb_array_length(entries)>20000 OR octet_length(entries::text)>8388608 THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_INPUT';END IF;
 PERFORM public.privacy_require_writer_fences();PERFORM public.privacy_writer_fence_assert(lease);
 SELECT * INTO STRICT j FROM public.privacy_jobs WHERE id=job AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'');a:=public.privacy_job_authority(j.journey_id,j.backup_id);
 IF a IS DISTINCT FROM j.manifest->'authority' OR encode(public.digest(j.manifest::text,'sha256'),'hex')<>j.manifest_sha256 THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_JOB_CHANGED';END IF;
 SELECT * INTO STRICT s FROM public.privacy_backup_row_sets WHERE backup_id=j.backup_id AND workspace_id=j.workspace_id AND environment='REAL';catalog:=public.privacy_backup_row_catalog();
 IF s.catalog_sha256 IS DISTINCT FROM catalog->>'catalog_sha256' OR NOT EXISTS(SELECT 1 FROM public.privacy_backup_row_seals z WHERE z.backup_id=s.backup_id AND (z.row_count,z.page_count,z.root_sha256)=(s.row_count,s.page_count,s.root_sha256)) OR NOT EXISTS(SELECT 1 FROM public.privacy_backup_attestations b WHERE b.id=s.backup_id AND b.workspace_id=s.workspace_id AND b.restore_sha256=s.restore_sha256) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_UNSEALED';END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(entries) LOOP
  IF jsonb_typeof(e)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e)k) IS DISTINCT FROM ARRAY['key_sha256','relation','source_sha256'] OR NOT EXISTS(SELECT 1 FROM public.privacy_backup_row_entries r WHERE r.backup_id=s.backup_id AND (r.relation_name,r.key_sha256,r.source_sha256)=(e->>'relation',e->>'key_sha256',e->>'source_sha256')) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROW_NOT_COVERED';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(entries)x GROUP BY x.value->>'relation',x.value->>'key_sha256' HAVING count(*)<>1) THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_DUPLICATE';END IF;
 FOR spec IN SELECT value->>'relation' relation FROM jsonb_array_elements(entries) GROUP BY value->>'relation' LOOP
  SELECT array_agg(value->>'key_sha256'),jsonb_agg(value ORDER BY value->>'key_sha256') INTO keys,expected FROM jsonb_array_elements(entries) WHERE value->>'relation'=spec.relation;
  actual:=public.privacy_current_backup_rows(spec.relation,keys,lease);
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROW_CHANGED';END IF;
 END LOOP;
 PERFORM public.privacy_writer_fence_assert(lease);IF(a->>'valid_until')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_AUTHORITY';END IF;
 RETURN jsonb_build_object('schema_version',1,'backup_id',s.backup_id,'restore_sha256',s.restore_sha256,'evidence_sha256',s.evidence_sha256,'rows',jsonb_array_length(entries),'covered',true,'erasure_authorized',false);
END $$;
ALTER FUNCTION assert_privacy_backup_rows(uuid,uuid,jsonb) OWNER TO commerce_privacy_row_owner;
REVOKE ALL ON FUNCTION assert_privacy_backup_rows(uuid,uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION assert_privacy_backup_row(job uuid,lease uuid,relation_name text,key_hash text,source_hash text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT public.assert_privacy_backup_rows(job,lease,jsonb_build_array(jsonb_build_object('relation',relation_name,'key_sha256',key_hash,'source_sha256',source_hash)))
$$;
ALTER FUNCTION assert_privacy_backup_row(uuid,uuid,text,text,text) OWNER TO commerce_privacy_row_owner;
REVOKE ALL ON FUNCTION assert_privacy_backup_row(uuid,uuid,text,text,text) FROM PUBLIC;
-- <<< end components/037_privacy_backup_rows.sql

-- >>> promoted from packages/db/profile-transition/components/038_private_asset_minimization.sql (source sha256 d37ad0126718f159e0284bf74899b88d88e9fec91eeaeece0d015a4478979980)
-- Install after031–037, before final generated028/030/035 seals. No runtime apply/admission.
CREATE TABLE privacy_asset_batches(
 id uuid PRIMARY KEY REFERENCES privacy_record_batches(id),workspace_id text NOT NULL REFERENCES profiles(id),environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),
 journey_id uuid NOT NULL,job_sha256 text NOT NULL CHECK(job_sha256~'^[a-f0-9]{64}$'),opaque_pass_id uuid NOT NULL REFERENCES privacy_opaque_passes(id),
 reference_sha256 text NOT NULL CHECK(reference_sha256~'^[a-f0-9]{64}$'),manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='array'),manifest_sha256 text NOT NULL CHECK(manifest_sha256~'^[a-f0-9]{64}$'),
 file_manifest jsonb NOT NULL CHECK(jsonb_typeof(file_manifest)='object'),file_manifest_sha256 text NOT NULL CHECK(file_manifest_sha256~'^[a-f0-9]{64}$'),candidate jsonb NOT NULL CHECK(jsonb_typeof(candidate)='object'),
 candidate_sha256 text NOT NULL CHECK(candidate_sha256~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(id,workspace_id,environment,journey_id)
);
CREATE TABLE privacy_asset_apply_admissions(
 batch_id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),journey_id uuid NOT NULL,
 backend_pid integer NOT NULL,transaction_id xid8 NOT NULL,profile_lease uuid NOT NULL REFERENCES privacy_writer_leases(id),reference_lease uuid NOT NULL REFERENCES privacy_reference_leases(id),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256~'^[a-f0-9]{64}$'),reference_epoch bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(batch_id,workspace_id,environment,journey_id) REFERENCES privacy_asset_batches(id,workspace_id,environment,journey_id)
);
CREATE TABLE privacy_minimized_assets(
 record_id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),kind text NOT NULL DEFAULT 'asset' CHECK(kind='asset'),
 batch_id uuid NOT NULL,journey_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(record_id,workspace_id,environment,kind) REFERENCES records(id,workspace_id,environment,kind),
 FOREIGN KEY(batch_id,workspace_id,environment,journey_id) REFERENCES privacy_asset_batches(id,workspace_id,environment,journey_id)
);
CREATE TABLE privacy_asset_completions(
 batch_id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL DEFAULT 'REAL' CHECK(environment='REAL'),journey_id uuid NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),FOREIGN KEY(batch_id,workspace_id,environment,journey_id) REFERENCES privacy_asset_batches(id,workspace_id,environment,journey_id)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['privacy_asset_batches','privacy_asset_apply_admissions','privacy_minimized_assets','privacy_asset_completions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY privacy_asset_owner_scope ON public.%I TO commerce_privacy_file_owner USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'') WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''') AND environment=''REAL'' AND current_setting(''app.environment'',true)=''REAL'')',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);EXECUTE format('GRANT SELECT ON public.%I TO commerce_privacy_file_owner',t);
  EXECUTE format('CREATE TRIGGER immutable_privacy_asset_evidence BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.immutable_row()',t);
 END LOOP;
END $$;
GRANT INSERT ON privacy_asset_batches,privacy_minimized_assets,privacy_asset_completions TO commerce_privacy_file_owner;
-- The future final assembler alone may receive INSERT on admissions, after full review.
GRANT SELECT ON records,record_versions TO commerce_privacy_file_owner;
GRANT UPDATE(body) ON records,record_versions TO commerce_privacy_file_owner;
CREATE POLICY privacy_asset_source_scope ON records TO commerce_privacy_file_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL') WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
CREATE POLICY privacy_asset_history_scope ON record_versions TO commerce_privacy_file_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL') WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL' AND current_setting('app.environment',true)='REAL');
GRANT EXECUTE ON FUNCTION privacy_record_authority(uuid,uuid),privacy_reference_fence_assert(uuid),privacy_record_transition(jsonb,jsonb,text,text,text) TO commerce_privacy_file_owner;

-- Fixed ASCII object keys; values remain JSON strings, never concatenated SQL.
-- This matches the private-file manifest's recursively sorted compact JSON.
CREATE FUNCTION privacy_file_canonical_json(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE result text;BEGIN
 IF value IS NULL THEN RAISE EXCEPTION 'PRIVACY_FILE_JSON_REQUIRED';END IF;
 IF jsonb_typeof(value)='object' THEN SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||public.privacy_file_canonical_json(x.value),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(value)x;
 ELSIF jsonb_typeof(value)='array' THEN SELECT '['||COALESCE(string_agg(public.privacy_file_canonical_json(x.value),',' ORDER BY n),'')||']' INTO result FROM jsonb_array_elements(value) WITH ORDINALITY x(value,n);
 ELSE result:=value::text;END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION privacy_file_canonical_json(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_file_canonical_json(jsonb) TO commerce_privacy_file_owner;

CREATE FUNCTION prepare_privacy_asset_minimization(job uuid,opaque_pass uuid,profile_lease uuid,reference_lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE j public.privacy_jobs%ROWTYPE;b public.privacy_asset_batches%ROWTYPE;r public.records%ROWTYPE;v public.record_versions%ROWTYPE;
 refs jsonb;backup jsonb;a jsonb;h jsonb;images jsonb;minimum jsonb:='{"privacy_erased":true,"status":"RETAINED"}';
 manifest_value jsonb:='[]';files_value jsonb:='[]';descriptors jsonb:='[]';pins jsonb:='[]';descriptor jsonb;file_value jsonb;candidate_value jsonb;
 manifest_hash text;file_hash text;candidate_hash text;reference_hash text;source_hash text;history_hash text;backup_at timestamptz;n integer;total integer:=0;total_bytes bigint:=0;file_bytes bigint:=0;
BEGIN
 j:=public.privacy_record_authority(job,profile_lease);PERFORM public.privacy_reference_fences_assert();PERFORM public.privacy_reference_fence_assert(reference_lease);
 refs:=public.read_privacy_asset_references(job,opaque_pass,profile_lease,reference_lease);backup:=public.read_privacy_backup_files(job,profile_lease);
 IF refs->>'workspace_id' IS DISTINCT FROM j.workspace_id OR refs->>'record_batch_id' IS DISTINCT FROM job::text OR refs->>'journey_id' IS DISTINCT FROM j.journey_id::text OR refs->>'environment' IS DISTINCT FROM 'REAL' OR refs->>'erasure_authorized' IS DISTINCT FROM 'false' OR jsonb_typeof(refs->'assets') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'PRIVACY_ASSET_REFERENCE_BINDING';END IF;
 backup_at:=(j.manifest->'authority'->>'backup_snapshot_at')::timestamptz;
 -- Epoch changes only with a fenced transaction. It is validated, but excluded
 -- from stable candidate identity so a read-only recheck cannot renew authority.
 reference_hash:=encode(public.digest((refs-ARRAY['reference_epoch','coverage'])::text,'sha256'),'hex');
 FOR a IN SELECT value FROM jsonb_array_elements(refs->'assets') ORDER BY value->>'asset_id' LOOP
  IF a->>'classification'='SHARED' THEN CONTINUE;END IF;
  IF a->>'classification' IS DISTINCT FROM 'OWNED' THEN RAISE EXCEPTION 'PRIVACY_ASSET_REFERENCE_UNRESOLVED';END IF;
  SELECT * INTO STRICT r FROM public.records WHERE id=(a->>'asset_id')::uuid AND workspace_id=j.workspace_id AND environment='REAL' AND kind='asset' FOR UPDATE;
  source_hash:=encode(public.digest(to_jsonb(r)::text,'sha256'),'hex');
  IF source_hash IS DISTINCT FROM a->>'source_sha256' OR r.created_at>backup_at OR r.updated_at>backup_at OR r.body->>'privacy_erased'='true' THEN RAISE EXCEPTION 'PRIVACY_ASSET_SOURCE_CHANGED';END IF;
  pins:=pins||jsonb_build_array(jsonb_build_object('relation','public.records','key_sha256',encode(public.digest(jsonb_build_object('id',r.id)::text,'sha256'),'hex'),'source_sha256',source_hash));
  images:='[]';n:=0;
  FOR v IN SELECT * FROM public.record_versions WHERE record_id=r.id ORDER BY version FOR UPDATE LOOP
   n:=n+1;total:=total+1;total_bytes:=total_bytes+octet_length(v.body::text);
   IF total>10000 OR total_bytes>16777216 OR v.version<>n OR (v.workspace_id,v.environment,v.kind) IS DISTINCT FROM(r.workspace_id,r.environment,r.kind) OR v.created_at>backup_at OR (v.version=r.version AND v.body<>r.body) THEN RAISE EXCEPTION 'PRIVACY_ASSET_HISTORY_CHANGED';END IF;
   history_hash:=encode(public.digest(to_jsonb(v)::text,'sha256'),'hex');
   SELECT value INTO STRICT h FROM jsonb_array_elements(a->'history') WHERE (value->>'version')::integer=v.version;
   IF history_hash IS DISTINCT FROM h->>'fullrow_sha256' THEN RAISE EXCEPTION 'PRIVACY_ASSET_HISTORY_CHANGED';END IF;
   pins:=pins||jsonb_build_array(jsonb_build_object('relation','public.record_versions','key_sha256',encode(public.digest(jsonb_build_object('record_id',v.record_id,'version',v.version)::text,'sha256'),'hex'),'source_sha256',history_hash));
   images:=images||jsonb_build_array(jsonb_build_object('version',v.version,'source_sha256',history_hash,'minimum_sha256',encode(public.digest(jsonb_set(to_jsonb(v),'{body}',minimum)::text,'sha256'),'hex')));
  END LOOP;
  IF n<>r.version OR n<1 OR n<>jsonb_array_length(a->'history') THEN RAISE EXCEPTION 'PRIVACY_ASSET_HISTORY_CHANGED';END IF;
  manifest_value:=manifest_value||jsonb_build_array(jsonb_build_object('asset_id',r.id,'version',r.version,'source_sha256',source_hash,'minimum_sha256',encode(public.digest(jsonb_set(to_jsonb(r),'{body}',minimum)::text,'sha256'),'hex'),'history',images,'reference_sha256',a->>'reference_sha256'));
  IF COALESCE(r.body->>'kind','file')='file' THEN
   SELECT value INTO STRICT descriptor FROM jsonb_array_elements(backup->'files') WHERE value->>'asset_id'=r.id::text AND value->>'storage_key'=r.body->>'storage_key';
   file_bytes:=file_bytes+(descriptor->>'ciphertext_bytes')::bigint;
   IF file_bytes>2147483648 THEN RAISE EXCEPTION 'PRIVACY_ASSET_FILE_BOUND';END IF;
   descriptors:=descriptors||jsonb_build_array(descriptor);
   files_value:=files_value||jsonb_build_array(descriptor||jsonb_build_object('source_sha256',source_hash,'history_sha256',encode(public.digest(images::text,'sha256'),'hex'),'reference_sha256',a->>'reference_sha256'));
  ELSIF COALESCE(r.body->>'kind','') NOT IN('link','access') THEN RAISE EXCEPTION 'PRIVACY_ASSET_ADAPTER_UNRESOLVED';END IF;
 END LOOP;
 --037 must authenticate the restored complete row, not merely old timestamps.
 PERFORM public.assert_privacy_backup_rows(job,profile_lease,pins);
 manifest_hash:=encode(public.digest(manifest_value::text,'sha256'),'hex');
 file_value:=jsonb_build_object('schema_version',1,'job_id',job,'workspace_id',j.workspace_id,'plan_sha256',manifest_hash,'inventory_sha256',reference_hash,'backup_fence_sha256',encode(public.digest((j.manifest->'authority')::text,'sha256'),'hex'),'files',descriptors);
 file_hash:=encode(public.digest(public.privacy_file_canonical_json(file_value),'sha256'),'hex');
 candidate_value:=jsonb_build_object('schema_version',1,'job_id',job,'workspace_id',j.workspace_id,'plan_sha256',manifest_hash,'inventory_sha256',reference_hash,'backup_fence_sha256',file_value->>'backup_fence_sha256','backup_id',j.backup_id,'restore_sha256',backup->>'restore_sha256','backup_snapshot_unix_ns',backup->>'backup_snapshot_unix_ns','valid_until',backup->>'valid_until','files',files_value,'erasure_authorized',false);
 candidate_hash:=encode(public.digest(candidate_value::text,'sha256'),'hex');candidate_value:=candidate_value||jsonb_build_object('candidate_sha256',candidate_hash);
 PERFORM public.privacy_record_authority(job,profile_lease);PERFORM public.privacy_reference_fence_assert(reference_lease);PERFORM public.privacy_reference_fences_assert();
 SELECT * INTO b FROM public.privacy_asset_batches WHERE id=job;
 IF FOUND THEN
  IF(b.workspace_id,b.journey_id,b.job_sha256,b.opaque_pass_id,b.reference_sha256,b.manifest,b.manifest_sha256,b.file_manifest,b.file_manifest_sha256,b.candidate,b.candidate_sha256) IS DISTINCT FROM(j.workspace_id,j.journey_id,j.manifest_sha256,opaque_pass,reference_hash,manifest_value,manifest_hash,file_value,file_hash,candidate_value,candidate_hash) THEN RAISE EXCEPTION 'PRIVACY_ASSET_BATCH_CHANGED';END IF;
 ELSE
  INSERT INTO public.privacy_asset_batches(id,workspace_id,journey_id,job_sha256,opaque_pass_id,reference_sha256,manifest,manifest_sha256,file_manifest,file_manifest_sha256,candidate,candidate_sha256) VALUES(job,j.workspace_id,j.journey_id,j.manifest_sha256,opaque_pass,reference_hash,manifest_value,manifest_hash,file_value,file_hash,candidate_value,candidate_hash);
 END IF;
 RETURN candidate_value||jsonb_build_object('observed_at',clock_timestamp());
END $$;
ALTER FUNCTION prepare_privacy_asset_minimization(uuid,uuid,uuid,uuid) OWNER TO commerce_privacy_file_owner;
REVOKE ALL ON FUNCTION prepare_privacy_asset_minimization(uuid,uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION privacy_asset_admission(batch uuid) RETURNS public.privacy_asset_apply_admissions LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE a public.privacy_asset_apply_admissions%ROWTYPE;b public.privacy_asset_batches%ROWTYPE;BEGIN
 SELECT * INTO a FROM public.privacy_asset_apply_admissions WHERE batch_id=batch AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL';
 IF NOT FOUND OR a.backend_pid<>pg_backend_pid() OR a.transaction_id<>pg_current_xact_id() THEN RAISE EXCEPTION 'PRIVACY_ASSET_ADMISSION_REQUIRED';END IF;
 SELECT * INTO STRICT b FROM public.privacy_asset_batches WHERE id=batch;
 IF a.manifest_sha256<>b.manifest_sha256 OR a.reference_epoch<>public.privacy_reference_fence_assert(a.reference_lease) THEN RAISE EXCEPTION 'PRIVACY_ASSET_ADMISSION_CHANGED';END IF;
 -- Full031/catalog checks bracket apply. The row predicate checks the same
 -- transaction admission and both live leases; global EX freezes its sources.
 PERFORM public.privacy_writer_fence_assert(a.profile_lease);RETURN a;
END $$;
ALTER FUNCTION privacy_asset_admission(uuid) OWNER TO commerce_privacy_file_owner;
REVOKE ALL ON FUNCTION privacy_asset_admission(uuid) FROM PUBLIC;

CREATE FUNCTION privacy_asset_reference_allowed(workspace text,environment_name text,asset uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF workspace IS NULL OR workspace IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') OR environment_name IS NULL OR environment_name IS DISTINCT FROM current_setting('app.environment',true) THEN RAISE EXCEPTION 'PRIVACY_ASSET_CONTEXT_REQUIRED';END IF;
 RETURN NOT EXISTS(SELECT 1 FROM public.privacy_minimized_assets WHERE record_id=asset AND workspace_id=workspace AND environment=environment_name);
END $$;
ALTER FUNCTION privacy_asset_reference_allowed(text,text,uuid) OWNER TO commerce_privacy_file_owner;
REVOKE ALL ON FUNCTION privacy_asset_reference_allowed(text,text,uuid) FROM PUBLIC;

CREATE FUNCTION privacy_asset_transition(prior jsonb,next_image jsonb,relation_name text,operation text,actor text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE rid uuid;m public.privacy_minimized_assets%ROWTYPE;b public.privacy_asset_batches%ROWTYPE;e jsonb;h jsonb;v integer;
BEGIN
 IF relation_name NOT IN('records','record_versions') THEN RAISE EXCEPTION 'PRIVACY_ASSET_RELATION';END IF;
 IF COALESCE(prior,next_image)->>'workspace_id' IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') OR COALESCE(prior,next_image)->>'environment' IS DISTINCT FROM current_setting('app.environment',true) THEN RAISE EXCEPTION 'PRIVACY_ASSET_CONTEXT_REQUIRED';END IF;
 rid:=(COALESCE(prior,next_image)->>CASE WHEN relation_name='records' THEN 'id' ELSE 'record_id' END)::uuid;
 SELECT * INTO m FROM public.privacy_minimized_assets WHERE record_id=rid;
 IF NOT FOUND THEN
  IF operation<>'DELETE' AND EXISTS(SELECT 1 FROM public.privacy_minimized_assets x WHERE x.workspace_id=next_image->>'workspace_id' AND x.environment=next_image->>'environment' AND position(x.record_id::text IN lower((next_image->'body')::text))>0) THEN
   --033 validates native032 correction and snapshot, not a caller permission flag.
   IF public.privacy_record_transition(prior,next_image,relation_name,operation,actor)='CORRECTION' THEN RETURN 'CORRECTION';END IF;
   RAISE EXCEPTION 'PRIVACY_ASSET_REFERENCE_RESURRECTION';
  END IF;RETURN 'UNCHANGED';
 END IF;
 IF operation='UPDATE' AND actor='commerce_privacy_file_owner' AND prior-'body'=next_image-'body' THEN
  PERFORM public.privacy_asset_admission(m.batch_id);SELECT * INTO STRICT b FROM public.privacy_asset_batches WHERE id=m.batch_id;
  SELECT value INTO STRICT e FROM jsonb_array_elements(b.manifest) WHERE value->>'asset_id'=rid::text;v:=(next_image->>'version')::integer;
  h:=CASE WHEN relation_name='records' THEN e ELSE e->'history'->(v-1) END;
  IF h->>'source_sha256'=encode(public.digest(prior::text,'sha256'),'hex') AND h->>'minimum_sha256'=encode(public.digest(next_image::text,'sha256'),'hex') THEN RETURN 'MINIMIZE';END IF;
 END IF;RAISE EXCEPTION 'PRIVACY_ASSET_RESURRECTION';
END $$;
ALTER FUNCTION privacy_asset_transition(jsonb,jsonb,text,text,text) OWNER TO commerce_privacy_file_owner;
REVOKE ALL ON FUNCTION privacy_asset_transition(jsonb,jsonb,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_asset_transition(jsonb,jsonb,text,text,text),privacy_asset_reference_allowed(text,text,uuid) TO commerce_api,commerce_ingress,commerce_automation,commerce_channel,commerce_maintenance,commerce_results,commerce_results_reader,commerce_ai,commerce_number_lab,commerce_financial_retention,commerce_privacy_record_eraser;
CREATE FUNCTION privacy_minimized_asset_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 PERFORM public.privacy_asset_transition(CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,TG_TABLE_NAME,TG_OP,current_user);RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER aa_privacy_minimized_asset_guard BEFORE INSERT OR UPDATE OR DELETE ON records FOR EACH ROW EXECUTE FUNCTION privacy_minimized_asset_guard();
CREATE TRIGGER aa_privacy_minimized_asset_version_guard BEFORE INSERT OR UPDATE OR DELETE ON record_versions FOR EACH ROW EXECUTE FUNCTION privacy_minimized_asset_guard();
CREATE FUNCTION privacy_asset_snapshot_skip(prior jsonb,next_image jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.privacy_minimized_assets WHERE record_id=(next_image->>'id')::uuid) THEN RETURN false;END IF;
 RETURN public.privacy_asset_transition(prior,next_image,'records','UPDATE','commerce_privacy_file_owner')='MINIMIZE';
END $$;
ALTER FUNCTION privacy_asset_snapshot_skip(jsonb,jsonb) OWNER TO commerce_privacy_file_owner;
REVOKE ALL ON FUNCTION privacy_asset_snapshot_skip(jsonb,jsonb) FROM PUBLIC;
DO $$ DECLARE native_owner text;BEGIN
 SELECT pg_get_userbyid(proowner) INTO STRICT native_owner FROM pg_proc WHERE oid='public.snapshot_record()'::regprocedure;
 EXECUTE format('GRANT EXECUTE ON FUNCTION public.privacy_asset_snapshot_skip(jsonb,jsonb),public.privacy_asset_transition(jsonb,jsonb,text,text,text) TO %I',native_owner);
END $$;

CREATE FUNCTION apply_privacy_asset_minimization(batch uuid,profile_lease uuid,reference_lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE b public.privacy_asset_batches%ROWTYPE;a public.privacy_asset_apply_admissions%ROWTYPE;e jsonb;h jsonb;prior jsonb;result_value jsonb;total integer:=0;BEGIN
 a:=public.privacy_asset_admission(batch);
 IF(a.profile_lease,a.reference_lease) IS DISTINCT FROM(profile_lease,reference_lease) THEN RAISE EXCEPTION 'PRIVACY_ASSET_ADMISSION_REQUIRED';END IF;
 SELECT * INTO STRICT b FROM public.privacy_asset_batches WHERE id=batch;
 PERFORM public.privacy_record_authority(batch,profile_lease);PERFORM public.privacy_reference_fences_assert();
 IF encode(public.digest(b.manifest::text,'sha256'),'hex')<>b.manifest_sha256 OR encode(public.digest(public.privacy_file_canonical_json(b.file_manifest),'sha256'),'hex')<>b.file_manifest_sha256 THEN RAISE EXCEPTION 'PRIVACY_ASSET_BATCH_CHANGED';END IF;
 SELECT result INTO result_value FROM public.privacy_asset_completions WHERE batch_id=batch;
 IF FOUND THEN RETURN result_value||jsonb_build_object('status','NO_EFFECT');END IF;
 -- The private final assembler validated035/037 in this same fenced transaction
 -- BEFORE changing033/copies. Admission cannot survive a COMMIT or backend switch.
 FOR e IN SELECT value FROM jsonb_array_elements(b.manifest) LOOP
  SELECT to_jsonb(r) INTO STRICT prior FROM public.records r WHERE id=(e->>'asset_id')::uuid AND workspace_id=b.workspace_id AND environment='REAL' FOR UPDATE;
  IF encode(public.digest(prior::text,'sha256'),'hex')<>e->>'source_sha256' THEN RAISE EXCEPTION 'PRIVACY_ASSET_SOURCE_CHANGED';END IF;
  INSERT INTO public.privacy_minimized_assets(record_id,workspace_id,batch_id,journey_id,source_version) VALUES((e->>'asset_id')::uuid,b.workspace_id,batch,b.journey_id,(e->>'version')::integer);
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(b.manifest) LOOP
  FOR h IN SELECT value FROM jsonb_array_elements(e->'history') LOOP
   UPDATE public.record_versions SET body='{"privacy_erased":true,"status":"RETAINED"}' WHERE record_id=(e->>'asset_id')::uuid AND workspace_id=b.workspace_id AND environment='REAL' AND version=(h->>'version')::integer;
   IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_ASSET_HISTORY_CHANGED';END IF;total:=total+1;
  END LOOP;
  UPDATE public.records SET body='{"privacy_erased":true,"status":"RETAINED"}' WHERE id=(e->>'asset_id')::uuid AND workspace_id=b.workspace_id AND environment='REAL' AND version=(e->>'version')::integer;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_ASSET_SOURCE_CHANGED';END IF;
 END LOOP;
 PERFORM public.privacy_asset_admission(batch);PERFORM public.privacy_record_authority(batch,profile_lease);PERFORM public.privacy_reference_fences_assert();
 result_value:=jsonb_build_object('schema_version',1,'status','MINIMIZED','batch_id',batch,'job_id',batch,'workspace_id',b.workspace_id,'environment','REAL','journey_id',b.journey_id,'manifest_sha256',b.manifest_sha256,'file_manifest_sha256',b.file_manifest_sha256,'assets',jsonb_array_length(b.manifest),'versions',total,'files',jsonb_array_length(b.file_manifest->'files'),'erasure_authorized',false);
 INSERT INTO public.privacy_asset_completions(batch_id,workspace_id,journey_id,result) VALUES(batch,b.workspace_id,b.journey_id,result_value);RETURN result_value;
END $$;
ALTER FUNCTION apply_privacy_asset_minimization(uuid,uuid,uuid) OWNER TO commerce_privacy_file_owner;
REVOKE ALL ON FUNCTION apply_privacy_asset_minimization(uuid,uuid,uuid) FROM PUBLIC;

-- Source-pinned033 extensions, with all prior gates preserved.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.guard_record()'::regprocedure AND p.prorettype='trigger'::regtype AND p.prosecdef=false AND p.proconfig IS NULL AND encode(public.digest(p.prosrc,'sha256'),'hex')='3c80f70cab408979300f105ce71bb93b3a345d6d635711e364db1c9054dde529') THEN RAISE EXCEPTION 'PRIVACY_ASSET_LEGACY_DRIFT: guard_record';END IF;END $$;

CREATE OR REPLACE FUNCTION guard_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE key text; target text; expected text; ref jsonb;
BEGIN
 IF current_user='commerce_privacy_file_owner' AND TG_OP='UPDATE' AND public.privacy_asset_transition(to_jsonb(OLD),to_jsonb(NEW),'records',TG_OP,current_user)='MINIMIZE' THEN RETURN NEW;END IF;
 IF current_user='commerce_privacy_record_eraser' AND TG_OP='UPDATE' AND public.privacy_record_transition(to_jsonb(OLD),to_jsonb(NEW),'records',TG_OP,current_user)='MINIMIZE' THEN RETURN NEW;END IF;

 IF TG_OP='UPDATE' THEN
  IF (OLD.kind IN ('offer','bank_profile','receipt_policy') OR (OLD.kind='workflow' AND OLD.body->>'status'='PUBLISHED')) AND NOT (OLD.kind IN ('offer','workflow') AND catalog_archive_only(OLD.body,NEW.body)) THEN RAISE EXCEPTION 'IMMUTABLE_VERSION'; END IF;
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.environment<>OLD.environment OR NEW.kind<>OLD.kind OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
 END IF;
 FOR key,target IN SELECT * FROM jsonb_each_text(NEW.body) LOOP
 expected:=CASE key WHEN 'product_id' THEN 'product' WHEN 'offer_version_id' THEN 'offer' WHEN 'workflow_version_id' THEN 'workflow' WHEN 'agent_version_id' THEN 'agent' WHEN 'payment_profile_version_id' THEN 'bank_profile' WHEN 'receipt_policy_version_id' THEN 'receipt_policy' WHEN 'campaign_id' THEN 'acquisition_campaign' WHEN 'ad_set_id' THEN 'ad_set' WHEN 'ad_id' THEN 'ad' WHEN 'account_id' THEN 'channel_account' WHEN 'contact_id' THEN 'contact' WHEN 'conversation_id' THEN 'conversation' WHEN 'order_id' THEN 'order' WHEN 'asset_id' THEN 'asset' ELSE NULL END;
 IF expected IS NOT NULL AND target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM records r WHERE r.id::text=target AND r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment AND r.kind=expected) THEN RAISE EXCEPTION 'INVALID_SCOPED_REFERENCE: %',key; END IF;
 END LOOP;
 IF NEW.body ? 'fulfillment' THEN FOR ref IN SELECT * FROM jsonb_array_elements(NEW.body->'fulfillment') LOOP IF NOT EXISTS(SELECT 1 FROM records r WHERE r.id::text=ref->>'asset_id' AND r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment AND r.kind='asset') THEN RAISE EXCEPTION 'INVALID_ASSET_REFERENCE'; END IF; END LOOP; END IF;
 RETURN NEW;
END $$;

DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.snapshot_record()'::regprocedure AND p.prorettype='trigger'::regtype AND p.prosecdef=true AND p.proconfig=ARRAY['search_path=pg_catalog, public'] AND encode(public.digest(p.prosrc,'sha256'),'hex')='36a03fe2f1ab58d06ace828c360c367b3b20928d2f6673b5dd99e1791b1c782d') THEN RAISE EXCEPTION 'PRIVACY_ASSET_LEGACY_DRIFT: snapshot_record';END IF;END $$;

CREATE OR REPLACE FUNCTION snapshot_record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='UPDATE' AND public.privacy_asset_snapshot_skip(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' AND public.privacy_record_snapshot_skip(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;
 INSERT INTO record_versions(record_id,workspace_id,environment,kind,version,body) VALUES(NEW.id,NEW.workspace_id,NEW.environment,NEW.kind,NEW.version,NEW.body); RETURN NEW; END $$;

DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.immutable_row()'::regprocedure AND p.prorettype='trigger'::regtype AND p.prosecdef=false AND p.proconfig IS NULL AND encode(public.digest(p.prosrc,'sha256'),'hex')='f074159c972af5fed850e504db0caa554dc9b954506fce5fa821f4ea0719e688') THEN RAISE EXCEPTION 'PRIVACY_ASSET_LEGACY_DRIFT: immutable_row';END IF;END $$;

CREATE OR REPLACE FUNCTION immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='record_versions' AND TG_OP='UPDATE' AND current_user='commerce_privacy_file_owner' AND public.privacy_asset_transition(to_jsonb(OLD),to_jsonb(NEW),'record_versions',TG_OP,current_user)='MINIMIZE' THEN RETURN NEW;END IF;
 IF TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='record_versions' AND TG_OP='UPDATE' AND current_user='commerce_privacy_record_eraser' AND public.privacy_record_transition(to_jsonb(OLD),to_jsonb(NEW),'record_versions',TG_OP,current_user)='MINIMIZE' THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='record_versions' AND TG_OP='UPDATE' AND retention_context_valid() THEN RETURN NEW; END IF; RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END $$;

DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.guard_retained_asset_references()'::regprocedure AND p.prorettype='trigger'::regtype AND p.prosecdef=false AND p.proconfig IS NULL AND encode(public.digest(p.prosrc,'sha256'),'hex')='b90098014d388f7e924740e64097a8cb0f67ed18e3026a5eac8784efa28ee572') THEN RAISE EXCEPTION 'PRIVACY_ASSET_LEGACY_DRIFT: guard_retained_asset_references';END IF;END $$;

CREATE OR REPLACE FUNCTION guard_retained_asset_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref text; asset_state text;
BEGIN
 IF current_user='commerce_privacy_file_owner' AND TG_OP='UPDATE' AND public.privacy_asset_transition(to_jsonb(OLD),to_jsonb(NEW),'records',TG_OP,current_user)='MINIMIZE' THEN RETURN NEW;END IF;
 IF current_user='commerce_privacy_record_eraser' AND TG_OP='UPDATE' AND public.privacy_record_transition(to_jsonb(OLD),to_jsonb(NEW),'records',TG_OP,current_user)='MINIMIZE' THEN RETURN NEW;END IF;


 -- Existing references in an authenticated032 classification correction are
 -- technical identities. No new reference, body field or asset read is allowed.
 IF current_user='commerce_financial_retention' AND TG_OP='UPDATE' THEN
  IF OLD.kind NOT IN('order','receipt') OR (NEW.body-ARRAY['commercial_classification','classification_decision']) IS DISTINCT FROM (OLD.body-ARRAY['commercial_classification','classification_decision']) OR NOT EXISTS(
   SELECT 1 FROM public.financial_retention_corrections c JOIN public.financial_retention_installations i ON i.attestation_id=c.attestation_id AND i.workspace_id=c.workspace_id AND i.environment=c.environment AND i.journey_id=c.journey_id
   WHERE c.workspace_id=OLD.workspace_id AND c.environment=OLD.environment AND c.record_id=OLD.id AND c.record_kind=OLD.kind AND c.before_version=OLD.version AND c.after_version=NEW.version AND c.body_sha256=encode(public.digest(NEW.body::text,'sha256'),'hex')
  ) THEN RAISE EXCEPTION 'FINANCIAL_RETENTION_REFERENCE_CHANGED';END IF;
  RETURN NEW;
 END IF;
 FOR ref IN SELECT DISTINCT value #>> '{}' FROM (
  SELECT jsonb_path_query(NEW.body,'$.**.asset_id') value
  UNION ALL SELECT jsonb_path_query(NEW.body,'$.**.evidence_asset_id') value
 ) references_found WHERE jsonb_typeof(value)='string' LOOP
  SELECT r.body->>'status' INTO asset_state FROM records r WHERE r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment AND r.kind='asset' AND r.id::text=ref FOR SHARE;
  IF asset_state='RETAINED' THEN RAISE EXCEPTION 'INVALID_RETAINED_ASSET_REFERENCE'; END IF;
 END LOOP;
 RETURN NEW;
END $$;

-- Used by the host capture adapter only after private adoption. The opaque pass
-- is resolved from the native batch, never supplied in a file-deletion request.
CREATE FUNCTION read_privacy_asset_candidates(job uuid,profile_lease uuid,reference_lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE opaque uuid;BEGIN
 PERFORM public.privacy_record_authority(job,profile_lease);
 SELECT opaque_pass_id INTO STRICT opaque FROM public.privacy_asset_batches WHERE id=job AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND environment='REAL';
 RETURN public.prepare_privacy_asset_minimization(job,opaque,profile_lease,reference_lease);
END $$;
ALTER FUNCTION read_privacy_asset_candidates(uuid,uuid,uuid) OWNER TO commerce_privacy_file_owner;
REVOKE ALL ON FUNCTION read_privacy_asset_candidates(uuid,uuid,uuid) FROM PUBLIC;
-- <<< end components/038_private_asset_minimization.sql
