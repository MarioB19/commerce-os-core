CREATE TABLE consumer_receipts(consumer text NOT NULL,event_id uuid NOT NULL,processed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(consumer,event_id));
GRANT SELECT,INSERT ON consumer_receipts TO commerce_channel,commerce_automation;
