-- Better Auth 1.7 adds explicit provider issuer to credential identity.
ALTER TABLE account ADD COLUMN issuer text;
UPDATE account SET issuer='local:credential' WHERE "providerId"='credential';
ALTER TABLE account ALTER COLUMN issuer SET NOT NULL;
CREATE UNIQUE INDEX account_identity ON account(issuer,"accountId");
