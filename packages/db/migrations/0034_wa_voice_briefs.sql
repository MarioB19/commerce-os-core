-- Long WhatsApp voice inputs have an immutable history independent from ad duration/scenes.
CREATE TABLE creative_voice_briefs (
 id UUID PRIMARY KEY, workspace_id TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 project_id UUID NOT NULL, title TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,environment,project_id) REFERENCES creative_projects(workspace_id,environment,id)
);
CREATE TABLE creative_voice_brief_versions (
 id UUID PRIMARY KEY, brief_id UUID NOT NULL REFERENCES creative_voice_briefs(id),version INTEGER NOT NULL,
 body JSONB NOT NULL,sha256 TEXT NOT NULL,created_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(brief_id,version)
);
CREATE TRIGGER creative_voice_brief_version_immutable BEFORE UPDATE OR DELETE ON creative_voice_brief_versions FOR EACH ROW EXECUTE FUNCTION creative_immutable_row();
ALTER TABLE creative_voice_operations ALTER COLUMN recipe_id DROP NOT NULL;
ALTER TABLE creative_voice_operations ADD COLUMN brief_id UUID REFERENCES creative_voice_briefs(id);
ALTER TABLE creative_voice_operations ADD CONSTRAINT voice_exactly_one_source CHECK((recipe_id IS NOT NULL)::int+(brief_id IS NOT NULL)::int=1);
ALTER TABLE creative_voice_operations ADD CONSTRAINT voice_brief_input_version FOREIGN KEY(brief_id,input_version) REFERENCES creative_voice_brief_versions(brief_id,version);
CREATE UNIQUE INDEX creative_voice_brief_one_consumption ON creative_voice_operations(brief_id,input_version)
 WHERE status IN('REQUESTED','RUNNING','UNKNOWN','PAID_PENDING_STORAGE','DERIVED','CONFLICT');
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_api') THEN GRANT SELECT,INSERT,UPDATE ON creative_voice_briefs,creative_voice_brief_versions TO commerce_api; END IF;
END $$;
