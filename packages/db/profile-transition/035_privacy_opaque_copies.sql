-- Closed opaque-source attestation, before035 copy deletion. No runtime EXECUTE.
-- The separate trusted Root importer must authenticate the reviewed decryptor.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('commerce_privacy_opaque_owner','commerce_privacy_opaque_attestor')) THEN RAISE EXCEPTION 'PRIVACY_OPAQUE_ROLE_EXISTS';END IF;
 CREATE ROLE commerce_privacy_opaque_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
 CREATE ROLE commerce_privacy_opaque_attestor NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
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
