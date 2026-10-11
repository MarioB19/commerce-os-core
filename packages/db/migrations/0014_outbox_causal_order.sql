-- now() is shared by every statement in a transaction. UUIDs are not an order.
ALTER TABLE outbox ADD COLUMN dispatch_sequence bigint;
WITH ordered AS (
 SELECT id,row_number() OVER(ORDER BY created_at,id) AS sequence FROM outbox
)
UPDATE outbox o SET dispatch_sequence=ordered.sequence FROM ordered WHERE o.id=ordered.id;
ALTER TABLE outbox ALTER COLUMN dispatch_sequence SET NOT NULL;
ALTER TABLE outbox ALTER COLUMN dispatch_sequence ADD GENERATED ALWAYS AS IDENTITY;
SELECT setval(pg_get_serial_sequence('outbox','dispatch_sequence'),COALESCE(max(dispatch_sequence),1),max(dispatch_sequence) IS NOT NULL) FROM outbox;
CREATE UNIQUE INDEX outbox_dispatch_sequence_unique ON outbox(dispatch_sequence);
CREATE INDEX outbox_conversation_sequence ON outbox(workspace_id,conversation_id,dispatch_sequence DESC);
CREATE INDEX outbox_account_sequence_pending ON outbox(account_id,dispatch_sequence) WHERE status IN('READY','BLOCKED');
GRANT USAGE ON SEQUENCE outbox_dispatch_sequence_seq TO commerce_automation;

CREATE FUNCTION guard_effect_causality() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.dispatch_sequence<>OLD.dispatch_sequence OR NEW.predecessor_id IS DISTINCT FROM OLD.predecessor_id OR NEW.workspace_id<>OLD.workspace_id OR NEW.environment<>OLD.environment OR NEW.account_id<>OLD.account_id OR NEW.conversation_id<>OLD.conversation_id OR NEW.contact_id<>OLD.contact_id THEN
   RAISE EXCEPTION 'IMMUTABLE_EFFECT_CAUSALITY';
  END IF;
 ELSIF NEW.predecessor_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM outbox p WHERE p.id=NEW.predecessor_id AND p.workspace_id=NEW.workspace_id AND p.environment=NEW.environment AND p.conversation_id=NEW.conversation_id AND p.contact_id=NEW.contact_id AND p.dispatch_sequence<NEW.dispatch_sequence
 ) THEN
  RAISE EXCEPTION 'INVALID_EFFECT_PREDECESSOR';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_effect_causality BEFORE INSERT OR UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION guard_effect_causality();
