-- Read-only external inventory, isolated from runtime messaging and catalogue records.
CREATE TABLE meta_syncs (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 inventory jsonb NOT NULL CHECK(inventory->>'source'='META_API'),
 UNIQUE(id,workspace_id)
);
CREATE INDEX meta_sync_workspace_created ON meta_syncs(workspace_id,created_at DESC);
CREATE TABLE meta_links (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 environment text NOT NULL CHECK(environment='REAL'),
 sync_id uuid NOT NULL,
 chain_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 supersedes_id uuid REFERENCES meta_links(id),
 actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 body jsonb NOT NULL,
 UNIQUE(workspace_id,chain_id,revision),
 UNIQUE(supersedes_id),
 FOREIGN KEY(sync_id,workspace_id) REFERENCES meta_syncs(id,workspace_id)
);
CREATE INDEX meta_link_workspace_portfolio ON meta_links(workspace_id,(body->>'portfolio_id'));
CREATE FUNCTION immutable_meta_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_META_EVIDENCE'; END $$;
CREATE TRIGGER immutable_meta_sync BEFORE UPDATE OR DELETE ON meta_syncs FOR EACH ROW EXECUTE FUNCTION immutable_meta_evidence();
CREATE TRIGGER immutable_meta_link BEFORE UPDATE OR DELETE ON meta_links FOR EACH ROW EXECUTE FUNCTION immutable_meta_evidence();
GRANT SELECT,INSERT ON meta_syncs,meta_links TO commerce_api;
