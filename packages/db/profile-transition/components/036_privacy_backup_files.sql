-- Install before the final028/030 catalog seals and the restored031 import.
-- Only the existing private backup attestor may import a measured restored set.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_privacy_file_owner') THEN RAISE EXCEPTION 'PRIVACY_FILE_ROLE_EXISTS';END IF;
 CREATE ROLE commerce_privacy_file_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT;
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
