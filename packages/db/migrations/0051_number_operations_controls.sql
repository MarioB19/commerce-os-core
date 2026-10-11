CREATE TABLE number_link_access (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL,environment text NOT NULL,account_id uuid NOT NULL REFERENCES records(id),actor_id text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT ON number_link_access TO commerce_api;
-- Aggregate concurrency reservations are shared by all replicas and environments.
CREATE TABLE number_dispatch_slots (
 workspace_id text NOT NULL,environment text NOT NULL,effect_id uuid PRIMARY KEY REFERENCES outbox(id),owner_id text NOT NULL,reserved_at timestamptz NOT NULL DEFAULT now(),released_at timestamptz
);
GRANT SELECT,INSERT,UPDATE ON number_dispatch_slots TO commerce_channel;
CREATE INDEX number_dispatch_slots_active ON number_dispatch_slots(workspace_id,environment) WHERE released_at IS NULL;
-- Operational expansion cannot attach a second account to an occupied place.
CREATE UNIQUE INDEX number_capacity_account_unique ON number_capacity_slots(account_id) WHERE account_id IS NOT NULL;
