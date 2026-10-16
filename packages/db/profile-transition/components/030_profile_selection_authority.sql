-- Identity-only CAS selection is not conversation content. Apply after020/030,
-- before generating the content-writer fences and the028 inventory seal.
DO $$
DECLARE f record; t oid:='public.profile_session_context'::regclass; owner_id oid;
BEGIN
 LOCK TABLE public.profile_session_context IN ACCESS EXCLUSIVE MODE;
 SELECT relowner INTO owner_id FROM pg_class WHERE oid=t;
 IF (SELECT jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod),attnotnull) ORDER BY attnum) FROM pg_attribute WHERE attrelid=t AND attnum>0 AND NOT attisdropped) IS DISTINCT FROM
 '[ ["session_id","text",true],["user_id","text",true],["workspace_id","text",true],["membership_version","integer",true],["version","integer",true],["updated_at","timestamp with time zone",true] ]'::jsonb THEN RAISE EXCEPTION 'PRIVACY_SELECTION_STRUCTURE_DRIFT';END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=t AND attnum>0 AND attacl IS NOT NULL) THEN RAISE EXCEPTION 'PRIVACY_SELECTION_ACL_DRIFT';END IF;
 IF (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantee),a.privilege_type,a.is_grantable) ORDER BY pg_get_userbyid(a.grantee),a.privilege_type) FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=t AND a.grantee<>owner_id) IS DISTINCT FROM
 '[["commerce_api","INSERT",false],["commerce_api","SELECT",false],["commerce_api","UPDATE",false],["commerce_profile_bootstrap_owner","INSERT",false],["commerce_profile_bootstrap_owner","SELECT",false],["commerce_profile_bootstrap_owner","UPDATE",false]]'::jsonb THEN RAISE EXCEPTION 'PRIVACY_SELECTION_ACL_DRIFT';END IF;
 FOR f IN SELECT * FROM (VALUES
 ('public.list_authenticated_profile_choices(text,text)'::regprocedure,'2efd8c65cd56baddb91fe154b5c658a1ffb0f869be20fee982242bc503f5be45'),
 ('public.select_authenticated_profile(text,text,text,integer)'::regprocedure,'88635ea12dcd79c7cb19dc37a4e3d89086a8c66f848809fafe8b484b872ac241')) x(id,expected_hash) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f.id AND p.prosecdef AND p.proowner='commerce_profile_bootstrap_owner'::regrole AND p.proconfig=ARRAY['search_path=pg_catalog'] AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')=f.expected_hash) THEN RAISE EXCEPTION 'PRIVACY_SELECTION_BOOTSTRAP_DRIFT';END IF;
  IF (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantee),a.privilege_type,a.is_grantable) ORDER BY pg_get_userbyid(a.grantee)) FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f.id) IS DISTINCT FROM
   '[["commerce_api","EXECUTE",false],["commerce_profile_bootstrap_owner","EXECUTE",false]]'::jsonb THEN RAISE EXCEPTION 'PRIVACY_SELECTION_BOOTSTRAP_ACL_DRIFT';END IF;
 END LOOP;
 REVOKE INSERT,UPDATE ON public.profile_session_context FROM commerce_api;
END $$;
