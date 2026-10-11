-- A deployment hold stops external effects without changing commercial authorization revision.
ALTER TABLE operational_settings ADD COLUMN release_hold boolean NOT NULL DEFAULT false;
ALTER TABLE operational_settings ADD COLUMN release_hold_at timestamptz;
ALTER TABLE session_ownership ADD COLUMN release_frozen boolean NOT NULL DEFAULT false;
CREATE INDEX session_ownership_release_frozen ON session_ownership(workspace_id,account_id) WHERE release_frozen;
