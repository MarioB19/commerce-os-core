# ADR V7.3 — Meta portfolios, account reporting and resumable history

Status: implementation authorized by Brandon on 2026-11-08. Production release
is delegated to Claude; this change prepares the candidate and release handoff.

## Contract

A profile selects at most five distinct Meta business portfolios. Every accessible
ad account owned by a selected portfolio is included. A connection is a versioned,
encrypted system-user credential, not a portfolio. Connections and portfolios are
many-to-many through account access. Account IDs, never names or token aliases,
identify facts. Duplicate access paths do not duplicate spend or revenue.

The owner enters/rotates secrets in an interactive session. Profile API tokens can
read inventory/reports and perform permitted selection/state/read-sync operations.
No token appears in responses, jobs, audit events, logs or exports. The existing
profile authority and REAL worker scopes apply to every added relation.

## Compatibility and migration

Migration 0119 is additive. Existing configured V7 credentials gain a legacy
connection referencing their exact original revision. The profile worker validates
the original encrypted envelope and appends a new connection-bound envelope before
using it; history is retained. An installation with no old token needs no adoption.
The singular endpoints remain a compatibility interface; a new multi-connection
client uses named connection endpoints. Old report consumers retain existing fields.

The legacy worker remains for clients that still create only a singular V7 token.
Once a profile has named connections its reads use the V7.3 queue exclusively;
legacy pending jobs are closed without discarding previously persisted insights.
Both worker paths recover abandoned final attempts. New connections never schedule
advertising writes, conversions, messages or budget changes.

## Inventory and historical ownership

Discover every account page with business{id,name}; /me/businesses alone is not
complete evidence (both real tokens returned empty there). Complete discovery
marks lost access only for that connection, and only after its last page. Partial
or failed discovery cannot revoke unvisited assets. Unknown owners stay unknown.

The first observed owner is an explicitly labelled current-owner baseline, not
proof of ownership before discovery. Later ownership changes are recorded with an
effective account-local day; earlier report days keep their established mapping.
Accounts reached through several credentials have one canonical fact stream.

## Work and coverage

Queue a fixed initial 90-calendar-day range in seven-day chunks, newest first.
Re-read seven inclusive days hourly and 30 daily. These are refresh windows, not
retention limits. Tasks retain pagination cursors and stage complete windows before
replacing facts. Empty successful windows have coverage; missing metrics do not
become zero. Expired leases, retries, token rotation, incomplete pagination and
rate limits have durable outcomes. One failed connection/account does not block
other accounts. Bound each tick and coordinate reads by credential.

Persist only while the connection revision, active selection and lease still
match. Report progress by account and scope. Repeating a manual operation UUID
returns that operation; a failed operation is resumed explicitly and never
replayed as an unrelated import. Source facts retain the existing ad/campaign
reconciliation and payment attribution rules.

## Reports

Expose portfolio and account filters/groups through the same API, web and MCP
service and CSV. Validate profile ownership and account/portfolio membership.
Preserve campaigns, ads, products, unattributed sales and existing report fields.
Calculate ratios from sums, never averages of account ratios. Evaluate coverage
per account; healthy rows remain usable when another account is incomplete.
Combine only comparable currency/calendar groups. Account-local dates also govern
attributed payments. Missing attribution stays in the profile's unattributed
bucket; it is never allocated by phone, product, campaign name or a proportional
rule. Meta conversations and approved Commerce payments remain separate sources.

## Delivery and verification

Cover five versus six portfolios, concurrent selection, overlapping credentials,
90-day coverage, pagination, interrupted third attempts, rotation mid-read,
independent failures, currencies/timezones, attribution and RLS. Exercise new UI
and MCP contracts, migration from 0118, installer 118→119, cold restore and the
existing relevant regression suites. Release handoff identifies exact candidate,
checks and remaining production-only gates. Connect Brandon's two existing
portfolios only after the V7.3 deployment is verified.

Local verification and the pending native release gates are recorded in
[the V7.3 release handoff](v7-3-meta-release.md).
