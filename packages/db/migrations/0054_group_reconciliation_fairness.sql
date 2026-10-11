ALTER TABLE warmup_group_events ADD COLUMN last_reconciled_at timestamptz;
CREATE INDEX warmup_group_events_reconciliation_queue ON warmup_group_events(last_reconciled_at NULLS FIRST,observed_at) WHERE NOT correlated AND classification='GROUP_EVENT';
