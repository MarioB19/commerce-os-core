-- Warmup alternates two owned accounts, so recipient changes within one typed conversation.
-- Commercial predecessor scope remains unchanged.
CREATE OR REPLACE FUNCTION guard_effect_causality() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.dispatch_sequence<>OLD.dispatch_sequence OR NEW.predecessor_id IS DISTINCT FROM OLD.predecessor_id OR NEW.workspace_id<>OLD.workspace_id OR NEW.environment<>OLD.environment OR NEW.account_id<>OLD.account_id OR NEW.conversation_id<>OLD.conversation_id OR NEW.contact_id<>OLD.contact_id THEN
   RAISE EXCEPTION 'IMMUTABLE_EFFECT_CAUSALITY';
  END IF;
 ELSIF NEW.predecessor_id IS NOT NULL THEN
  IF NEW.kind='warmup' THEN
   IF NOT EXISTS(
    SELECT 1 FROM outbox p
    JOIN warmup_turns previous_turn ON previous_turn.effect_id=p.id
    JOIN warmup_turns next_turn ON next_turn.id::text=NEW.payload->>'warmup_turn_id'
    JOIN warmup_states a ON a.account_id=next_turn.sender_id
    JOIN warmup_states b ON b.account_id=next_turn.recipient_id
    WHERE p.id=NEW.predecessor_id AND p.kind='warmup' AND p.workspace_id=NEW.workspace_id AND p.environment=NEW.environment
      AND p.conversation_id=NEW.conversation_id AND p.dispatch_sequence<NEW.dispatch_sequence
      AND next_turn.conversation_id=previous_turn.conversation_id AND next_turn.position=previous_turn.position+1
      AND next_turn.sender_id=previous_turn.recipient_id AND next_turn.recipient_id=previous_turn.sender_id AND a.pool_id=b.pool_id
   ) THEN RAISE EXCEPTION 'INVALID_EFFECT_PREDECESSOR'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM outbox p WHERE p.id=NEW.predecessor_id AND p.kind<>'warmup' AND p.workspace_id=NEW.workspace_id AND p.environment=NEW.environment AND p.conversation_id=NEW.conversation_id AND p.contact_id=NEW.contact_id AND p.dispatch_sequence<NEW.dispatch_sequence) THEN
   RAISE EXCEPTION 'INVALID_EFFECT_PREDECESSOR';
  END IF;
 END IF;
 RETURN NEW;
END $$;
