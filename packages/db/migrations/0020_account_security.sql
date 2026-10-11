-- Global identity facts. Deliberately independent of commercial environments/revisions.
CREATE TABLE identity_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text, actor_id text,
 event_type text NOT NULL, outcome text NOT NULL, correlation_id text NOT NULL,
 job_id uuid, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX identity_audit_user ON identity_audit(user_id,occurred_at);
CREATE TRIGGER immutable_identity_audit BEFORE UPDATE OR DELETE ON identity_audit FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE identity_rate_limits (
 bucket text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE identity_mail_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL,
 enabled boolean NOT NULL DEFAULT false, config jsonb NOT NULL, secret_ciphertext text,
 updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 diagnostic_code text, diagnosed_at timestamptz
);
CREATE TABLE identity_reset_links (
 digest text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX identity_reset_links_user ON identity_reset_links(user_id);
CREATE TABLE identity_mail_jobs (
 id uuid PRIMARY KEY, link_digest text UNIQUE NOT NULL,
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 payload_ciphertext text, expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENDING','ACCEPTED','FAILED','EXPIRED','UNCERTAIN','CANCELLED')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 claimed_at timestamptz, finished_at timestamptz, diagnostic_code text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX identity_mail_pending ON identity_mail_jobs(available_at) WHERE status='PENDING';
