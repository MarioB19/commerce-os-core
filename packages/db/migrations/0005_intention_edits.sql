-- Automation may revise an unclaimed intention after immediate API approval invalidation.
GRANT UPDATE(payload,config_hash,approval_hash,authorization_id) ON outbox TO commerce_automation;
