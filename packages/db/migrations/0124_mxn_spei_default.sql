-- The selected release owns the frozen destination and its encrypted details.
CREATE TABLE profile_mxn_spei_defaults (
 workspace_id text NOT NULL REFERENCES profiles(id),
 environment text NOT NULL CHECK (environment IN ('REAL','SIMULATION')),
 revision integer NOT NULL CHECK (revision > 0),
 release_id uuid,
 PRIMARY KEY (workspace_id, environment),
 FOREIGN KEY (workspace_id, environment, release_id)
   REFERENCES market_releases(workspace_id, environment, id)
);
ALTER TABLE profile_mxn_spei_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_mxn_spei_defaults FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_mxn_spei_scope ON profile_mxn_spei_defaults
 USING (workspace_id = nullif(current_setting('app.workspace_id',true),'')
   AND environment = nullif(current_setting('app.environment',true),''));
REVOKE ALL ON profile_mxn_spei_defaults FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON profile_mxn_spei_defaults TO commerce_api;
