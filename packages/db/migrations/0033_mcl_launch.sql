-- No external effects or commercial reclassification on migration.
CREATE TABLE mcl_test_scopes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('SIMULATION','REAL')),
 account_id uuid NOT NULL REFERENCES records(id), offer_version_id uuid NOT NULL REFERENCES records(id),
 participants jsonb NOT NULL CHECK(jsonb_typeof(participants)='array'),
 purpose text NOT NULL, actor_id text NOT NULL, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE INDEX mcl_test_scope_lookup ON mcl_test_scopes(workspace_id,environment,account_id,offer_version_id);
CREATE TABLE mcl_sponsorships (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('SIMULATION','REAL')),
 order_id uuid NOT NULL REFERENCES records(id), sponsor_conversation_id uuid NOT NULL REFERENCES records(id),
 core_asset_id uuid NOT NULL REFERENCES records(id), test_scope_id uuid REFERENCES mcl_test_scopes(id),
 approved_total_minor bigint NOT NULL CHECK(approved_total_minor>=0),
 review_difference_minor bigint NOT NULL CHECK(review_difference_minor>=0), eligible boolean NOT NULL,
 status text NOT NULL DEFAULT 'WAITING_BENEFICIARY' CHECK(status IN ('WAITING_BENEFICIARY','ASSIGNED','DELIVERY_PENDING','RECEIPT_CONFIRMED','NOTICE_PENDING')),
 beneficiary_conversation_id uuid REFERENCES records(id), beneficiary_contact_id uuid REFERENCES records(id),
 consent_message_id uuid REFERENCES records(id), assigned_by text, assigned_at timestamptz,
 fulfillment_id uuid REFERENCES records(id), delivery_effect_id uuid REFERENCES outbox(id),
 confirmation_message_id uuid REFERENCES records(id), confirmed_by text, confirmed_at timestamptz,
 notice_effect_id uuid REFERENCES outbox(id), revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,environment,order_id)
);
CREATE UNIQUE INDEX mcl_unique_beneficiary ON mcl_sponsorships(workspace_id,environment,beneficiary_contact_id) WHERE beneficiary_contact_id IS NOT NULL;
GRANT SELECT ON mcl_test_scopes,mcl_sponsorships TO commerce_api,commerce_automation,commerce_channel;
GRANT INSERT ON mcl_test_scopes TO commerce_api;
GRANT UPDATE(revoked_at) ON mcl_test_scopes TO commerce_api;
GRANT INSERT,UPDATE ON mcl_sponsorships TO commerce_automation;

-- A predeclared phone test must never become commercial by a later UI command.
CREATE FUNCTION protect_mcl_test_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.kind='order' AND OLD.body ? 'launch_test_scope_id' AND
 (NEW.body->>'commercial_classification' IS DISTINCT FROM 'TEST' OR NEW.body->>'launch_test_scope_id' IS DISTINCT FROM OLD.body->>'launch_test_scope_id')
 THEN RAISE EXCEPTION 'LAUNCH_TEST_CLASSIFICATION_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mcl_test_order_immutable BEFORE UPDATE ON records FOR EACH ROW EXECUTE FUNCTION protect_mcl_test_order();
