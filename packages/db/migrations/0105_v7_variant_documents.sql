-- V7 F4 (RF-05, RF-06, RF-08, ADR-V7-14): the operator edits one variant document
-- per market; publishing materializes immutable offer/flow/seller/collection
-- records for the existing engine and pins them in a market release. A number
-- assignment may follow a variant: new conversations use its current release,
-- open ones keep their pinned versions. Nothing here creates an effect, a grant
-- or a binding by itself.

-- 1. Variant document, protected collection and lifecycle on the same row.
ALTER TABLE market_variants
 ADD COLUMN document jsonb CHECK(document IS NULL OR jsonb_typeof(document)='object'),
 ADD COLUMN collection_ciphertext text CHECK(collection_ciphertext IS NULL OR (length(collection_ciphertext)<=32768
  AND collection_ciphertext ~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$')),
 ADD COLUMN collection_revision integer NOT NULL DEFAULT 0 CHECK(collection_revision>=0),
 ADD COLUMN materialized jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(materialized)='object'),
 ADD COLUMN published_document_sha256 text CHECK(published_document_sha256 IS NULL OR published_document_sha256 ~ '^[a-f0-9]{64}$'),
 ADD COLUMN archived_at timestamptz;
GRANT UPDATE(document,collection_ciphertext,collection_revision,materialized,published_document_sha256,archived_at) ON market_variants TO commerce_api;

-- Publication keeps the reviewed document and requires an active variant.
CREATE OR REPLACE FUNCTION guard_market_variant() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.release_revision<>0 OR NEW.current_release_id IS NOT NULL OR NEW.published_document_sha256 IS NOT NULL OR NEW.archived_at IS NOT NULL THEN RAISE EXCEPTION 'MARKET_DRAFT_REQUIRED'; END IF;
  IF NEW.source_release_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.market_releases r
   WHERE r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment AND r.id=NEW.source_release_id
    AND r.body->>'family_id'=NEW.family_id::text) THEN RAISE EXCEPTION 'MARKET_COPY_FAMILY_CHANGED'; END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.workspace_id,NEW.environment,NEW.family_id,NEW.created_at,NEW.source_release_id)
  IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.environment,OLD.family_id,OLD.created_at,OLD.source_release_id)
  OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'MARKET_VERSION_CONFLICT'; END IF;
 IF NEW.current_release_id IS DISTINCT FROM OLD.current_release_id THEN
  IF NEW.release_revision<>OLD.release_revision+1 OR NEW.draft IS DISTINCT FROM OLD.draft OR NEW.document IS DISTINCT FROM OLD.document
   OR NEW.archived_at IS NOT NULL THEN RAISE EXCEPTION 'MARKET_RELEASE_TRANSITION'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.market_releases r WHERE r.workspace_id=NEW.workspace_id AND r.environment=NEW.environment
   AND r.variant_id=NEW.id AND r.id=NEW.current_release_id AND r.revision=NEW.release_revision AND r.body->>'family_id'=NEW.family_id::text) THEN
   RAISE EXCEPTION 'MARKET_RELEASE_TRANSITION'; END IF;
 ELSE
  IF NEW.release_revision<>OLD.release_revision OR NEW.published_document_sha256 IS DISTINCT FROM OLD.published_document_sha256 THEN
   RAISE EXCEPTION 'MARKET_RELEASE_TRANSITION'; END IF;
 END IF;
 -- A number that sells this variant must be released before archiving it.
 IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL AND EXISTS(SELECT 1 FROM public.commercial_assignments a
  WHERE a.workspace_id=NEW.workspace_id AND a.environment=NEW.environment AND a.variant_id=NEW.id AND a.state='ACTIVE') THEN
  RAISE EXCEPTION 'VARIANT_HAS_ACTIVE_NUMBERS'; END IF;
 RETURN NEW;
END $$;

ALTER TABLE market_variant_events DROP CONSTRAINT market_variant_events_event_check;
ALTER TABLE market_variant_events ADD CONSTRAINT market_variant_events_event_check
 CHECK(event IN('DRAFT_CREATED','DRAFT_REPLACED','RELEASE_PUBLISHED','SECTION_SAVED','REVIEWED','ARCHIVED','RESTORED','DUPLICATED','MIGRATED'));
ALTER TABLE market_variant_events ADD COLUMN detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(detail)='object' AND length(detail::text)<=4096);

-- 2. Assignments that follow a variant. No revision change: the human
-- assignment of the number to the product stays the same permanent act (D-01).
ALTER TABLE commercial_assignments ADD COLUMN variant_id uuid;
ALTER TABLE commercial_assignments ADD CONSTRAINT commercial_assignment_variant
 FOREIGN KEY(workspace_id,environment,variant_id) REFERENCES market_variants(workspace_id,environment,id);
CREATE INDEX commercial_assignment_variant_idx ON commercial_assignments(workspace_id,environment,variant_id) WHERE variant_id IS NOT NULL;
CREATE FUNCTION guard_assignment_variant() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.variant_id IS NULL OR NEW.state<>'ACTIVE' OR (TG_OP='UPDATE' AND NEW.variant_id IS NOT DISTINCT FROM OLD.variant_id AND NEW.state IS NOT DISTINCT FROM OLD.state) THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.market_variants v WHERE v.workspace_id=NEW.workspace_id AND v.environment=NEW.environment
  AND v.id=NEW.variant_id AND v.family_id=NEW.product_id AND v.archived_at IS NULL AND v.current_release_id IS NOT NULL) THEN
  RAISE EXCEPTION 'ASSIGNMENT_VARIANT_NOT_SELLABLE'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_assignment_variant() FROM PUBLIC;
CREATE TRIGGER guard_assignment_variant BEFORE INSERT OR UPDATE OF variant_id,state ON commercial_assignments
 FOR EACH ROW EXECUTE FUNCTION guard_assignment_variant();

-- 3. The automation worker resolves the current release when a new
-- conversation starts and pins it in its journey snapshot. It never reads the
-- protected collection column.
GRANT SELECT(workspace_id,environment,id,family_id,current_release_id,release_revision,archived_at) ON market_variants TO commerce_automation;
GRANT SELECT ON market_releases TO commerce_automation;
GRANT SELECT,INSERT ON market_journey_snapshots TO commerce_automation;
