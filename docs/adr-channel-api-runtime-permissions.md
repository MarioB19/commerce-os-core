# Channel API runtime permissions

## Decision · 2026-09-15

The published channel recovery and deletion routes authenticate an owner but fail under the production `commerce_api` database profile. Recovery locks and annotates failed commands; recovery and deletion freeze ownership; alert acknowledgment writes its acknowledgment fields. Those columns were never granted to the API. Opening a recovery incident also conflicts with the record-writer allowlist.

Add an immutable migration granting only `commands(result, updated_at)`, `session_ownership(frozen, updated_at)` and `operational_alerts(acknowledged_at, acknowledged_by)` updates to `commerce_api`. Permit API-owned incident records, which the existing recovery route already creates. Keep command status/payload, ownership identity/generation/lease and destructive history operations outside the API database profile. User RBAC, service-token scopes, owner authentication, revisions, idempotency, fresh-health checks and provider isolation remain required.

Verify the actual HTTP handlers with an authenticated personal owner token and the `commerce_api` database role, and the logout worker with `commerce_channel`, in an isolated fixture database. Cover durable reconciliation, logout, history-preserving deletion, gateway release/reuse and conservative new-account defaults. Negative checks must reject direct command status changes, ownership transfers and deletion of history. No production business records are edited by SQL.

## Expired installer isolation evidence

An unconsumed historical receipt can expire while its ownership remains frozen. The installer may issue a new receipt only when the protected original proof hashes to that owner-written receipt, its original contemporaneous isolation checks pass, and account/workspace/owner/generation still match. A fresh successful complete Docker inventory must prove that the original container has been removed. Merely stopped containers, expired leases, missing evidence, consumed receipts and mismatched ownership remain blocked. Only active REAL WAHA accounts are eligible, with one verified replacement worker.

Preserve the original receipt and write the new proof privately before the insert. The insert rechecks scope, frozen ownership, deletion, expiry and absence of a valid unconsumed receipt, and appends `channel.isolation_reverified` atomically. This remains part of the existing installer attestation mechanism: API and worker roles cannot mint receipts. Command reconciliation remains a separate owner API action requiring evidence that the provider was not reached.

CI includes synthetic proof/hash/container rejection checks and actual PostgreSQL execution of the installer statement, including changed generation, consumed source, unfrozen ownership, deletion, repeat suppression and audit/history preservation.
