-- V7 RF-19.o (D-18): a «Probar número» test keeps its transcript 30 days
-- (runs.expires_at). After that the platform maintenance (cluster owner, never
-- an application role) shreds its sealed content: the capture, every action
-- and result (the transcript lives inside results) become unreadable random
-- ciphertext and its example receipts are deleted. Run, operation and AI
-- binding rows stay as content-free history because AI accounting references
-- them. The laboratory engine rows and receipt files follow from the receipt.
DO $$BEGIN
 IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'NUMBER_LAB_RETENTION_OWNER_REQUIRED';
 END IF;
END$$;

CREATE TABLE commerce_number_lab.retention_receipts (
 workspace_id text NOT NULL,run_id uuid NOT NULL,
 expired_at timestamptz NOT NULL,purged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 operations integer NOT NULL CHECK(operations>=0),attachment_keys text[] NOT NULL DEFAULT '{}',
 engine_purged_at timestamptz,files_purged_at timestamptz,
 PRIMARY KEY(workspace_id,run_id),FOREIGN KEY(workspace_id,run_id) REFERENCES commerce_number_lab.runs(workspace_id,id),
 CHECK(array_position(attachment_keys,NULL) IS NULL)
);
ALTER TABLE commerce_number_lab.retention_receipts OWNER TO commerce_number_lab_owner;
ALTER TABLE commerce_number_lab.retention_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_number_lab.retention_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_scope ON commerce_number_lab.retention_receipts USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
REVOKE ALL ON commerce_number_lab.retention_receipts FROM PUBLIC;
GRANT SELECT ON commerce_number_lab.retention_receipts TO commerce_api;

-- Unreadable but structurally valid ciphertext (no key can open it).
CREATE FUNCTION commerce_number_lab.shredded_cipher() RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version',1,
  'iv',encode(substring(decode(replace(gen_random_uuid()::text,'-',''),'hex') from 1 for 12),'base64'),
  'tag',encode(decode(replace(gen_random_uuid()::text,'-',''),'hex'),'base64'),
  'ciphertext',encode(decode(replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),'hex'),'base64'))
$$;
-- Superuser maintenance only: no grant to any role. Guards are bypassed with
-- session_replication_role for this transaction; nothing is deleted except
-- the example receipts (leaf rows), so no reference can dangle.
CREATE FUNCTION commerce_number_lab.purge_expired_runs(p_limit integer)
 RETURNS TABLE(workspace_id text,run_id uuid,operations integer,attachment_keys text[])
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r record;keys text[];n integer;
BEGIN
 IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN RAISE EXCEPTION 'LAB_RETENTION_SUPERUSER_REQUIRED'; END IF;
 PERFORM set_config('session_replication_role','replica',true);
 FOR r IN SELECT x.workspace_id,x.id,x.expires_at FROM commerce_number_lab.runs x
   WHERE x.expires_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM commerce_number_lab.retention_receipts p WHERE p.workspace_id=x.workspace_id AND p.run_id=x.id)
   ORDER BY x.expires_at,x.id LIMIT least(greatest(coalesce(p_limit,1),1),500) FOR UPDATE OF x LOOP
  SELECT coalesce(array_agg(a.id::text||'-'||a.sha256 ORDER BY a.id),'{}') INTO keys FROM commerce_number_lab.attachments a WHERE a.workspace_id=r.workspace_id AND a.run_id=r.id;
  DELETE FROM commerce_number_lab.attachments a WHERE a.workspace_id=r.workspace_id AND a.run_id=r.id;
  UPDATE commerce_number_lab.operations o SET action_ciphertext=commerce_number_lab.shredded_cipher(),
   result_ciphertext=CASE WHEN o.result_ciphertext IS NULL THEN NULL ELSE commerce_number_lab.shredded_cipher() END
   WHERE o.workspace_id=r.workspace_id AND o.run_id=r.id;
  GET DIAGNOSTICS n=ROW_COUNT;
  UPDATE commerce_number_lab.runs x SET snapshot_ciphertext=commerce_number_lab.shredded_cipher(),state=CASE WHEN x.state IN('COMPLETED','STOPPED') THEN x.state ELSE 'STOPPED' END
   WHERE x.workspace_id=r.workspace_id AND x.id=r.id;
  INSERT INTO commerce_number_lab.retention_receipts(workspace_id,run_id,expired_at,operations,attachment_keys) VALUES(r.workspace_id,r.id,r.expires_at,n,keys);
  workspace_id:=r.workspace_id;run_id:=r.id;operations:=n;attachment_keys:=keys;RETURN NEXT;
 END LOOP;
END $$;
ALTER FUNCTION commerce_number_lab.shredded_cipher() OWNER TO commerce_number_lab_owner;
REVOKE ALL ON FUNCTION commerce_number_lab.shredded_cipher() FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce_number_lab.purge_expired_runs(integer) FROM PUBLIC;
