-- Isolated V7 transition: adoption/mounting require the complete F2/F4 gates.
-- Composite identity constraints preserve all existing records and versions.
ALTER TABLE records ADD CONSTRAINT market_record_scope UNIQUE(id,workspace_id,environment,kind);
CREATE TABLE market_families (
 id uuid NOT NULL, workspace_id text NOT NULL REFERENCES profiles(id),
 environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 product_kind text NOT NULL DEFAULT 'product' CHECK(product_kind='product'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,id),
 FOREIGN KEY(id,workspace_id,environment,product_kind) REFERENCES records(id,workspace_id,environment,kind)
);
CREATE TABLE market_variants (
 id uuid NOT NULL, workspace_id text NOT NULL, environment text NOT NULL, family_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483646),
 draft jsonb NOT NULL CHECK(jsonb_typeof(draft)='object'),
 current_release_id uuid, source_release_id uuid, release_revision integer NOT NULL DEFAULT 0 CHECK(release_revision>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,id),
 FOREIGN KEY(workspace_id,environment,family_id) REFERENCES market_families(workspace_id,environment,id)
);
CREATE TABLE market_releases (
 id uuid NOT NULL, workspace_id text NOT NULL, environment text NOT NULL, variant_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,id), UNIQUE(workspace_id,environment,variant_id,revision),
 UNIQUE(workspace_id,environment,variant_id,id),
 FOREIGN KEY(workspace_id,environment,variant_id) REFERENCES market_variants(workspace_id,environment,id),
 CHECK((body->>'id'=id::text AND body->>'variant_id'=variant_id::text AND (body->>'revision')::integer=revision
   AND body->'scope'->>'workspace_id'=workspace_id AND body->'scope'->>'environment'=environment) IS TRUE)
);
ALTER TABLE market_variants ADD CONSTRAINT market_current_release FOREIGN KEY(workspace_id,environment,id,current_release_id)
 REFERENCES market_releases(workspace_id,environment,variant_id,id);
ALTER TABLE market_variants ADD CONSTRAINT market_copy_source FOREIGN KEY(workspace_id,environment,source_release_id)
 REFERENCES market_releases(workspace_id,environment,id);
CREATE TABLE market_journey_snapshots (
 journey_id uuid NOT NULL, workspace_id text NOT NULL, environment text NOT NULL,
 journey_kind text NOT NULL DEFAULT 'conversation' CHECK(journey_kind='conversation'),
 release_id uuid NOT NULL, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,journey_id),
 FOREIGN KEY(journey_id,workspace_id,environment,journey_kind) REFERENCES records(id,workspace_id,environment,kind),
 FOREIGN KEY(workspace_id,environment,release_id) REFERENCES market_releases(workspace_id,environment,id),
 CHECK((body->>'journey_id'=journey_id::text AND body->'release'->>'id'=release_id::text
   AND body->'chat'->>'workspace_id'=workspace_id AND body->'chat'->>'environment'=environment) IS TRUE)
);
CREATE TABLE market_operations (
 workspace_id text NOT NULL REFERENCES profiles(id), environment text NOT NULL CHECK(environment IN('REAL','SIMULATION')),
 actor_id text NOT NULL, operation_id uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,environment,actor_id,operation_id)
);
CREATE TABLE market_variant_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL, environment text NOT NULL,
 variant_id uuid NOT NULL, version integer NOT NULL, event text NOT NULL CHECK(event IN('DRAFT_CREATED','DRAFT_REPLACED','RELEASE_PUBLISHED')),
 actor_id text NOT NULL CHECK(length(actor_id)>0), release_id uuid,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(workspace_id,environment,variant_id,version),
 FOREIGN KEY(workspace_id,environment,variant_id) REFERENCES market_variants(workspace_id,environment,id),
 FOREIGN KEY(workspace_id,environment,release_id) REFERENCES market_releases(workspace_id,environment,id)
);
CREATE FUNCTION guard_market_variant() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.release_revision<>0 OR NEW.current_release_id IS NOT NULL THEN RAISE EXCEPTION 'MARKET_DRAFT_REQUIRED'; END IF;
  IF NEW.source_release_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.market_releases r
   WHERE r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment AND r.id=NEW.source_release_id
    AND r.body->>'family_id'=NEW.family_id::text) THEN RAISE EXCEPTION 'MARKET_COPY_FAMILY_CHANGED'; END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.workspace_id,NEW.environment,NEW.family_id,NEW.created_at,NEW.source_release_id)
  IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.environment,OLD.family_id,OLD.created_at,OLD.source_release_id)
  OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'MARKET_VERSION_CONFLICT'; END IF;
 IF NEW.current_release_id IS DISTINCT FROM OLD.current_release_id THEN
  IF NEW.release_revision<>OLD.release_revision+1 OR NEW.draft IS DISTINCT FROM OLD.draft THEN
   RAISE EXCEPTION 'MARKET_RELEASE_TRANSITION'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.market_releases r WHERE r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment
   AND r.variant_id=NEW.id AND r.id=NEW.current_release_id AND r.revision=NEW.release_revision AND r.body->>'family_id'=NEW.family_id::text) THEN
   RAISE EXCEPTION 'MARKET_RELEASE_TRANSITION'; END IF;
 ELSE
  IF NEW.release_revision<>OLD.release_revision THEN RAISE EXCEPTION 'MARKET_RELEASE_TRANSITION'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_market_variant() FROM PUBLIC;
CREATE TRIGGER guard_market_variant BEFORE INSERT OR UPDATE ON market_variants FOR EACH ROW EXECUTE FUNCTION guard_market_variant();
CREATE FUNCTION guard_market_snapshot() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.market_releases r WHERE r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment
  AND r.id=NEW.release_id AND r.body=NEW.body->'release') THEN RAISE EXCEPTION 'MARKET_SNAPSHOT_RELEASE_CHANGED'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_market_snapshot() FROM PUBLIC;
CREATE TRIGGER guard_market_snapshot BEFORE INSERT ON market_journey_snapshots FOR EACH ROW EXECUTE FUNCTION guard_market_snapshot();
CREATE TRIGGER immutable_market_families BEFORE UPDATE OR DELETE ON market_families FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_market_releases BEFORE UPDATE OR DELETE ON market_releases FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_market_snapshots BEFORE UPDATE OR DELETE ON market_journey_snapshots FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_market_events BEFORE UPDATE OR DELETE ON market_variant_events FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_market_operations BEFORE UPDATE OR DELETE ON market_operations FOR EACH ROW EXECUTE FUNCTION immutable_row();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['market_families','market_variants','market_releases','market_journey_snapshots','market_variant_events','market_operations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY market_profile_scope ON %I USING(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),'''')) WITH CHECK(workspace_id=NULLIF(current_setting(''app.workspace_id'',true),''''))',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,commerce_ingress,commerce_automation,commerce_channel,commerce_api',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO commerce_api',t);
 END LOOP;
END $$;
GRANT UPDATE(draft,version,current_release_id,release_revision,updated_at) ON market_variants TO commerce_api;
CREATE INDEX market_variants_family ON market_variants(workspace_id,environment,family_id,id);
CREATE INDEX market_variants_copy_source ON market_variants(workspace_id,environment,source_release_id);
CREATE INDEX market_snapshots_release ON market_journey_snapshots(workspace_id,environment,release_id);
CREATE INDEX market_events_release ON market_variant_events(workspace_id,environment,release_id);

-- apply_retention_plan locks the records parent before redacting versions. Its
-- asset reference check predates F4; preserve materials pinned only by F4 too.
CREATE INDEX market_release_materials ON market_releases USING gin ((body->'configuration'->'materials') jsonb_path_ops);
CREATE FUNCTION guard_market_material_retention() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.market_releases r WHERE r.workspace_id=OLD.workspace_id AND r.environment=OLD.environment
  AND r.body->'configuration'->'materials' @> jsonb_build_array(jsonb_build_object('id',OLD.id::text))) THEN
  RAISE EXCEPTION 'MARKET_MATERIAL_REFERENCED';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_market_material_retention() FROM PUBLIC;
CREATE TRIGGER guard_market_material_retention BEFORE UPDATE OF body ON records FOR EACH ROW
 WHEN(OLD.kind='asset' AND NEW.body->>'status'='RETAINED' AND OLD.body->>'status' IS DISTINCT FROM 'RETAINED')
 EXECUTE FUNCTION guard_market_material_retention();
