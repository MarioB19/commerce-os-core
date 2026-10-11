-- Paid response, binary storage and immutable recipe derivation are independent recovery points.
CREATE TABLE creative_voice_operations (
 id UUID PRIMARY KEY,workspace_id TEXT NOT NULL,environment TEXT NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 project_id UUID NOT NULL,recipe_id UUID NOT NULL,input_version INTEGER NOT NULL,input_sha TEXT NOT NULL,
 actor_id TEXT NOT NULL,request JSONB NOT NULL,request_sha TEXT NOT NULL,estimated_cost_usd NUMERIC(14,6) NOT NULL,
 max_cost_usd NUMERIC(14,6),expires_at TIMESTAMPTZ NOT NULL,
 status TEXT NOT NULL CHECK(status IN('QUOTED','REQUESTED','RUNNING','UNKNOWN','PAID_PENDING_STORAGE','DERIVED','CONFLICT','FAILED')),
 provider_operation_id UUID REFERENCES creative_provider_operations(id),audio_upload_id UUID REFERENCES creative_uploads(id),alignment_upload_id UUID REFERENCES creative_uploads(id),
 audio_asset_id UUID REFERENCES creative_assets(id),alignment_asset_id UUID REFERENCES creative_assets(id),derived_recipe_version INTEGER,
 validation_issues JSONB NOT NULL DEFAULT '[]',error_code TEXT,version INTEGER NOT NULL DEFAULT 1,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,environment,project_id) REFERENCES creative_projects(workspace_id,environment,id),
 FOREIGN KEY(recipe_id,input_version) REFERENCES creative_recipe_versions(recipe_id,version),
 FOREIGN KEY(recipe_id,derived_recipe_version) REFERENCES creative_recipe_versions(recipe_id,version)
);
CREATE UNIQUE INDEX creative_voice_one_consumption ON creative_voice_operations(recipe_id,input_version)
 WHERE status IN('REQUESTED','RUNNING','UNKNOWN','PAID_PENDING_STORAGE','DERIVED','CONFLICT');
CREATE INDEX creative_voice_recovery ON creative_voice_operations(workspace_id,environment,status,updated_at);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_api') THEN GRANT SELECT,INSERT,UPDATE ON creative_voice_operations TO commerce_api; END IF;
END $$;
