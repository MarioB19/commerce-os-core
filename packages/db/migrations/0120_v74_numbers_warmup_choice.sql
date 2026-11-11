-- V7.4: números y calentamiento sin fricción. Additive; no row is rewritten.
-- See docs/adr-v7-4-numbers-warmup.md.
--
-- D. The owner's warm-up choice lives on the number itself
-- (records.body.warmup_mode: absent or REQUIRED = waits for a warm-up group,
-- DECLARED_READY = «ya está preparado; no iniciar calentamiento»). It is
-- written in the same insert that creates the number. These guards make the
-- «ya está preparado» choice hold at the database whatever path tries to
-- register the number, reserve it in a program or queue a warm-up message
-- from it: a worker tick, a reconnection, legacy adoption, a restart or a
-- release. Existing numbers have no value and keep their behaviour; nothing
-- is classified in bulk and no program is started by this migration.
CREATE FUNCTION number_declared_ready(account uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.records WHERE id=account AND kind='channel_account' AND body->>'warmup_mode'='DECLARED_READY');
$$;
REVOKE ALL ON FUNCTION number_declared_ready(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION number_declared_ready(uuid) TO commerce_api,commerce_channel,commerce_automation,commerce_maintenance;

CREATE FUNCTION guard_declared_ready_warmup() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF public.number_declared_ready(NEW.account_id) THEN RAISE EXCEPTION 'WARMUP_NOT_REQUESTED_BY_OWNER'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_declared_ready_warmup() FROM PUBLIC;
CREATE TRIGGER guard_declared_ready_state BEFORE INSERT ON warmup_states FOR EACH ROW EXECUTE FUNCTION guard_declared_ready_warmup();
CREATE TRIGGER guard_declared_ready_reservation BEFORE INSERT ON warmup_account_reservations FOR EACH ROW EXECUTE FUNCTION guard_declared_ready_warmup();

-- Final guard on emission: no warm-up effect is queued from a number declared
-- ready, in any warm-up mode. The V7.2 checks of this trigger are unchanged.
CREATE OR REPLACE FUNCTION guard_qr_group_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.warmup_pools%ROWTYPE; g public.warmup_programs%ROWTYPE;
BEGIN
 IF NEW.kind<>'warmup' OR TG_OP='UPDATE' THEN RETURN NEW; END IF;
 IF NEW.account_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' AND public.number_declared_ready(NEW.account_id::uuid) THEN RAISE EXCEPTION 'WARMUP_NOT_REQUESTED_BY_OWNER'; END IF;
 SELECT * INTO p FROM public.warmup_pools WHERE id::text=NEW.payload->>'warmup_pool_id' AND workspace_id=NEW.workspace_id AND environment=NEW.environment;
 IF p.continuity_mode='QR_CONTINUOUS' AND EXISTS(SELECT 1 FROM public.warmup_states WHERE account_id::text=NEW.account_id AND group_required) THEN RAISE EXCEPTION 'GROUP_SELECTION_REQUIRED'; END IF;
 IF p.continuity_mode='QR_GROUP' THEN
  SELECT * INTO g FROM public.warmup_programs WHERE id=p.program_id AND workspace_id=p.workspace_id AND environment=p.environment;
  IF g.status<>'ACTIVE' OR NEW.payload->>'program_revision' IS DISTINCT FROM g.version::text OR NEW.payload->>'library_version' IS DISTINCT FROM g.scope->>'libraryVersion'
   OR NEW.continuous_authorization_id IS NULL OR NEW.authorization_id IS NOT NULL OR NOT (g.scope->'senderIds' ? NEW.account_id)
   OR NEW.payload->>'group_protocol' IS DISTINCT FROM 'v1' THEN RAISE EXCEPTION 'QR_GROUP_EFFECT_SCOPE_INVALID'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_qr_group_effect() FROM PUBLIC;

-- C. The no-network simulator can describe a group that also holds members
-- outside the profile (they have no account, session or QR here).
ALTER TABLE number_simulation_groups ADD COLUMN external_members smallint NOT NULL DEFAULT 0 CHECK(external_members BETWEEN 0 AND 20);
