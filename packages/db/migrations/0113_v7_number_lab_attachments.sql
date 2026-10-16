-- V7 RF-19.d: example receipts attached to a «Probar número» run. The bytes
-- are sealed with the laboratory control key (purpose 'attachment', bound to
-- profile, run and id); they are never a REAL asset, a public link or a
-- customer document. An attachment lives and expires with its run (RF-19.o).
DO $$BEGIN
 IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'NUMBER_LAB_ATTACHMENTS_OWNER_REQUIRED';
 END IF;
END$$;

CREATE TABLE commerce_number_lab.attachments (
 workspace_id text NOT NULL,run_id uuid NOT NULL,id uuid NOT NULL,
 actor_id text NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
 mime_type text NOT NULL CHECK(mime_type IN('image/png','image/jpeg','image/webp','application/pdf')),
 size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 4194304),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 content_ciphertext jsonb NOT NULL CHECK(commerce_number_lab.valid_cipher(content_ciphertext)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,run_id,id),UNIQUE(workspace_id,run_id,sha256),
 FOREIGN KEY(workspace_id,run_id) REFERENCES commerce_number_lab.runs(workspace_id,id)
);
CREATE FUNCTION commerce_number_lab.guard_attachment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r commerce_number_lab.runs%ROWTYPE;
BEGIN
 PERFORM commerce_number_lab.lock_profile(NEW.workspace_id);
 SELECT * INTO r FROM commerce_number_lab.runs WHERE workspace_id=NEW.workspace_id AND id=NEW.run_id FOR SHARE;
 IF r.id IS NULL OR r.state IN('COMPLETED','STOPPED') OR r.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'LAB_RUN_UNAVAILABLE'; END IF;
 IF (SELECT count(*) FROM commerce_number_lab.attachments WHERE workspace_id=NEW.workspace_id AND run_id=NEW.run_id)>=20 THEN RAISE EXCEPTION 'LAB_ATTACHMENT_LIMIT'; END IF;
 NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER number_lab_attachment_guard BEFORE INSERT ON commerce_number_lab.attachments FOR EACH ROW EXECUTE FUNCTION commerce_number_lab.guard_attachment();
CREATE TRIGGER number_lab_attachment_immutable BEFORE UPDATE ON commerce_number_lab.attachments FOR EACH ROW EXECUTE FUNCTION public.immutable_row();
ALTER TABLE commerce_number_lab.attachments OWNER TO commerce_number_lab_owner;
ALTER TABLE commerce_number_lab.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_number_lab.attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_scope ON commerce_number_lab.attachments USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
ALTER FUNCTION commerce_number_lab.guard_attachment() OWNER TO commerce_number_lab_owner;
REVOKE ALL ON FUNCTION commerce_number_lab.guard_attachment() FROM PUBLIC;
REVOKE ALL ON commerce_number_lab.attachments FROM PUBLIC;
GRANT SELECT,INSERT ON commerce_number_lab.attachments TO commerce_api;
GRANT SELECT ON commerce_number_lab.attachments TO commerce_number_lab;
