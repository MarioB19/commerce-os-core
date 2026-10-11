CREATE TABLE operational_settings (
  workspace_id text NOT NULL,
  environment text NOT NULL CHECK(environment IN ('SIMULATION','REAL')),
  version integer NOT NULL CHECK(version>0),
  body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  PRIMARY KEY(workspace_id,environment)
);
ALTER TABLE operation_authorizations ADD COLUMN configuration_version integer NOT NULL DEFAULT 0 CHECK(configuration_version>=0);

CREATE TABLE ownership_isolation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES records(id),
  workspace_id text NOT NULL,
  previous_owner_id text NOT NULL,
  generation integer NOT NULL CHECK(generation>0),
  method text NOT NULL CHECK(method='container_stopped_and_access_revoked'),
  evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  verified_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX ownership_isolation_available ON ownership_isolation_receipts(account_id,generation,verified_at DESC) WHERE consumed_at IS NULL;
REVOKE ALL ON operational_settings,ownership_isolation_receipts FROM PUBLIC;
GRANT SELECT ON operational_settings TO commerce_api,commerce_automation,commerce_channel,commerce_ingress;
GRANT INSERT,UPDATE ON operational_settings TO commerce_api;
GRANT SELECT ON ownership_isolation_receipts TO commerce_api,commerce_channel;
GRANT UPDATE(consumed_at) ON ownership_isolation_receipts TO commerce_channel;

-- Workers may lock approval records while checking a send, but may never grant/revoke approvals.
CREATE FUNCTION read_locked_operation_authorization(authorization_id uuid,workspace text,env text)
RETURNS SETOF operation_authorizations LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT * FROM public.operation_authorizations WHERE id=authorization_id AND workspace_id=workspace AND environment=env AND revoked_at IS NULL AND expires_at>now() FOR SHARE;
$$;
REVOKE ALL ON FUNCTION read_locked_operation_authorization(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_locked_operation_authorization(uuid,text,text) TO commerce_api,commerce_automation,commerce_channel;
