-- Gate retries are wall-clock scheduler metadata, not business-time or
-- business-effect mutations. A paused SIMULATION clock must not strand a
-- transient advisory-lock/capacity retry forever.
CREATE TABLE outbox_gate_schedule(
  effect_id uuid PRIMARY KEY REFERENCES outbox(id) ON DELETE CASCADE,
  next_check_at timestamptz NOT NULL,
  last_reason text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_gate_schedule_due_idx ON outbox_gate_schedule(next_check_at,effect_id);
GRANT SELECT,INSERT,UPDATE,DELETE ON outbox_gate_schedule TO commerce_channel;

-- Health probes append several immutable observations per account every minute.
-- This index lets the effective-state reader seek directly to the newest
-- candidate for each account/dimension instead of loading the full history.
CREATE INDEX records_health_effective_lookup ON records(
  workspace_id,
  environment,
  (body->>'account_id'),
  (body->>'dimension'),
  (COALESCE(body->>'scope','account')),
  (body->>'observed_at') DESC,
  created_at DESC,
  id DESC
) WHERE kind='health_signal';
