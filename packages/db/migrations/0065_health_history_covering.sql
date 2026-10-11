-- Preserve arbitrary historical evidence: INCLUDE must not introduce a new
-- B-tree tuple-size failure for long text. A null-safe total of <=1024 bytes
-- across every text key/payload leaves ample space for UUID/timestamps/headers.
-- The complementary index retains the original keys and reaches rare outliers
-- without scanning normal history. Queries must retain both disjoint branches.
CREATE INDEX health_observation_history_cover_idx ON health_observation_index(
 workspace_id,environment,account_id,dimension,observed_at
) INCLUDE(record_id,status,source,expires_at) WHERE isfinite(observed_at)
 AND (octet_length(workspace_id)::bigint+octet_length(environment)+COALESCE(octet_length(account_id),0)+COALESCE(octet_length(dimension),0)+COALESCE(octet_length(status),0)+COALESCE(octet_length(source),0))<=1024;
CREATE INDEX health_observation_history_wide_idx ON health_observation_index(
 workspace_id,environment,account_id,dimension,observed_at
) WHERE isfinite(observed_at)
 AND (octet_length(workspace_id)::bigint+octet_length(environment)+COALESCE(octet_length(account_id),0)+COALESCE(octet_length(dimension),0)+COALESCE(octet_length(status),0)+COALESCE(octet_length(source),0))>1024;
