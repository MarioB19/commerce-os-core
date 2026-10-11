CREATE TABLE finished_asset_intakes (
 upload_id uuid PRIMARY KEY REFERENCES creative_uploads(id),asset_id uuid NOT NULL REFERENCES creative_assets(id),workspace_id text NOT NULL,environment text NOT NULL,
 product_id uuid NOT NULL REFERENCES records(id),offer_id uuid REFERENCES records(id),source text NOT NULL CHECK(source='CODEX'),
 origin_reference text NOT NULL,rights jsonb NOT NULL,review jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finished_asset_product ON finished_asset_intakes(workspace_id,environment,product_id);
GRANT SELECT,INSERT ON finished_asset_intakes TO commerce_api;
