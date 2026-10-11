# Worker runtime and recovery

Automation proposes outbox intents, materializes incoming messages, advances versioned workflows and persistent waits, and owns sales projections. Channel owns claims, HTTP, acknowledgements, health and session state. Ingress persists protected original envelopes before ACK. `consumer_receipts` deduplicates channel consumption of normalized provider observations.

Test entrypoints have no startup side effects: `apps/automation-worker/src/runtime.ts` exports `automationTick`; `apps/channel-worker/src/runtime.ts` exports `channelTick`; `apps/ingress/src/server.ts` exports `buildIngress`. Production `index.ts` files start independent services. pg-boss holds wakeup references only; each worker also scans durable facts. Inbound, commands and result projections run every 250 ms; flow/timer and dispatch scans run every 500 ms. AI, receipt analysis, health, media and lifecycle run in independent nonoverlapping loops. Queue loss therefore does not delete timers or effects. Repeated jobs recheck durable state. External HTTP/AI never holds a PostgreSQL transaction open.

## Execution and controls

Workflows support explicit conditions, subflows limited to five nested levels, messages, configurable fulfillment, bank instructions, commitment, receipt approval, legacy reconcile compatibility, handoff, approvals, waits and terminal steps. Graph validation rejects unsupported node types, missing targets, cycles, unknown operators and arbitrary code. Each conversation pins an immutable published workflow or the versioned built-in `default-sales-v2` template (historical v1 snapshots retained). Published revisions do not edit existing runs. Default template chooses its delivery policy from the offer's fulfillment release conditions.

Simulation creates ordinary canonical contacts/conversations/orders in SIMULATION and keeps a durable virtual clock. Advancing accepts customer text (same materialization path) or an explicit `commitment`/`human_approved` event. Import history remains inert and carries provenance; it never starts a live workflow. Message campaigns re-evaluate contacts, consent, controls, offer match, snapshot approval and expiry before creating effects, and channel repeats these gates at dispatch. Cancellation does not undo an already accepted remote message.

`DISPATCH_FROZEN=true`, `REAL_SENDS_ENABLED=false`, and `ALLOW_REAL_OPERATIONS=false` independently prevent real sends. Simulation has no external provider and uses durable manual controls. Restore inserts workspace pauses for all environments. Enabling environment flags alone is insufficient: each real effect also needs an unexpired, unrevoked, version-specific authorization plus current approval hash. Changing effect content clears approval. Channel validates published offer/flow, account and audience scope, takeover, suppression across accounts, business window/template, expiry, current ownership/health, causal predecessor and frequency/message quota. No queue promises exactly one remote delivery.

## UNKNOWN and effects in flight

Channel commits READY/BLOCKED → SENDING plus an attempt before HTTP. Final gates run again after private asset preparation. A successful provider ID records acceptance, which differs from delivered/read acknowledgements. A timeout, lost response or abandoned attempt becomes UNKNOWN. Successors wait. No automatic retry of UNKNOWN occurs after restart. Late HTTP results append evidence to the attempt/event; they do not silently erase uncertainty. Owner-only resolution requires evidence and chooses confirmed sent, confirmed not sent (CANCELLED), or keep unknown. A new send is a new deliberately authorized effect.

Private access fulfillment uses separate grant and notification effects. The grant's access value is encrypted in durable result data. Notification depends on confirmed grant; a lost grant response blocks notification until reconciled. The protected delivery service configuration is `DELIVERY_GATEWAY_URL`, `DELIVERY_GATEWAY_ORIGIN`, `DELIVERY_GATEWAY_TOKEN`. Assets carry the private resource reference, not gateway credentials. Grant endpoint contract and fixture evidence are in `packages/fulfillment`.

## Ownership and isolation

Each process gets a fresh owner ID; the optional CHANNEL_OWNER_ID is only its prefix. Heartbeats renew an unexpired lease. A process cannot seize a different owner's session merely because the lease expired. Transfer remains frozen until previous owner isolation and in-flight/UNKNOWN reconciliation are demonstrated. Active old lease, missing prior freeze or unresolved effects rejects transfer.

The transfer command additionally requires a fresh, signed proof installed through a protected operator channel. Set `OWNERSHIP_PROOF_DIR` and `OWNERSHIP_PROOF_KEY` only for the channel process. The command's `isolation_evidence` is an alphanumeric filename reference. The file `{reference}.json` contains `{data,signature}` where signature is HMAC-SHA256 hex over `JSON.stringify(data)`. Data fields are account_id, previous_owner_id, previous_generation, method, evidence_sha256, verified_at. Allowed methods: credential_revocation, network_isolation, container_stopped_and_access_revoked. Proof is valid for five minutes. An operator must actually verify the stated infrastructure isolation and sign outside the product; the application cannot prove VM/network isolation from a lease. No default proof/key is supplied. This preserves a concrete dependency for real failover rather than claiming transparent native fencing.

## Operational limits

Health signals retain source, scope, observation and expiry. Unknown account-quality support is shown as unavailable and is not a ban predictor. Session and explicit restriction observations feed per-account gates. Worker heartbeats represent local process/database life, not provider socket health. Dispatch candidates use per-account ranking so a blocked backlog cannot consume the entire batch ahead of healthy accounts. Limits are initial engineering settings; no ten-real-session capacity claim is made from simulation.

Use `/livez` and `/readyz` on each service. The automation endpoint also exposes sanitized Prometheus text metrics. External VPS monitoring and restore procedures are separately documented by infrastructure; an in-host worker cannot detect complete host loss by itself.


## Additional local verification

The PostgreSQL automation suite exercises takeover and suppression during a deliberately held AI response, persistent virtual timers, campaign cancellation and invalidated approval, a blocked-account backlog, and a deliberately held provider HTTP call while a second account proceeds. Channel runs at most five account groups concurrently by default (`CHANNEL_ACCOUNT_CONCURRENCY`, bounded 1–10) and sends serially within each account group. Consumer projection also propagates later DELIVERED/READ evidence into ordinary message history.

Human workflow approval uses `approve_step`, requires the expected immutable workflow version and `flow_state.waiting_node_id` (falling back to `node_id`), plus an identified actor and reason. A changed node/version invalidates that approval. The actual approval records an event before advancing through the existing workflow. Simulation scripts are explicit data actions with a durable cursor, never executable code.

Under ADR-004, authenticated media observations are downloaded only by the channel worker, limited and stored encrypted outside the vault. Automation inserts a sealed evidence asset from the channel event and updates the incoming message. Payment-context PDFs/images enter receipt analysis; incomplete or unrecognized evidence requires human review. Tests cover encrypted storage, immutable asset projection and repeated-consumer deduplication. Production channel storage needs write access to the private asset volume for this path.

Production pg-boss schemas are separate: `JOB_SCHEMA=pgboss_automation` and `pgboss_channel`, owned by their corresponding restricted login roles. This grants queue maintenance without expanding business-table permissions.


Interrupted lifecycle commands that had committed a processing owner are marked FAILED with `CHANNEL_COMMAND_INTERRUPTED_REQUIRES_REVIEW` after 90 seconds. They are not replayed. A subsequent late result appends evidence without changing that failure. The operator must check the actual gateway state before issuing a new command.

Receipt arrival and approval supersede pending collection/follow-up intents, preserving grants and fulfillments. Causal traversal can bypass a cancelled collection only when its recorded `superseded_before_send` flag is true and attempts remain zero; it then checks the original predecessor. Manual cancellation, attempted effects and UNKNOWN remain barriers.

## Durable effect ordering decision — 2026-09-05

Multiple workflow nodes can propose effects inside one transaction, where PostgreSQL `now()` is identical. UUID ordering therefore cannot select their causal predecessor. Migration 0014 adds an immutable database-generated dispatch sequence. Proposals acquire the existing conversation transaction lock before reading its latest sequence, and dispatch uses that same order within each account. Dispatch acquires the conversation lock before its outbox row, matching control cancellation and avoiding an inverted-lock deadlock. The database rejects later or differently scoped predecessors and changes to an established causal edge. Backfilling existing rows preserves their stored edges; it does not claim to reconstruct missing historical causality.

Five PostgreSQL regression tests cover same-transaction timestamps, concurrent proposals, scoped immutable edges, an uncertain middle effect blocking its successors, and cancellation while dispatch is waiting for the conversation lock. The final load run after 0014 processed 500 simulated conversations, 2,500 incoming and 2,500 outgoing messages, with 125 one-pixel images per direction and no pending envelopes or HTTP failures in 124.96 seconds. ACK p95 was 32.68 ms and durable-to-materialized p95 224.65 ms. This isolated local harness uses production runtime functions and real PostgreSQL, but synthetic replies and 68-byte media; it does not establish VPS capacity, AI latency, typical media capacity or ten real sessions. Full evidence and resource measurements are in `docs/evidence/load-profile.json`; the previous run remains separately preserved.

## Receipt sales and Insights — 06-sep-2026

See [receipt_sales_v1](campaign-receipt-sales.md). Approval recognizes money, cancels collections and satisfies legacy reconcile waits without writing RECONCILED. Restoration, corrections and analytical backfill do not advance workflows or deliver again. The independent production Insights loop scans every 5 s, outside inbound/AI processing; durable jobs control hourly/configurable official GET reads with leases, bounded retries and atomic per-account range replacement. Tests exercise the same runtime functions with isolated PostgreSQL.
