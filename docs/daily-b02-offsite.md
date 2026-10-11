# Daily encrypted B02 with one operational trigger

The 2026-10-09 [keyless replacement ADR](ADR-20261009-b02-keyless-scheduler.md)
removes the GitHub cron while preserving Actions USD0. The new Google transport
is local source until its image, IAM, inactive resources, Root binding, actual
custody and natural scheduled delivery are verified. Existing historical GitHub
journals and portal release identities remain valid and unchanged.

## Keyless cutover and remaining native gates

1. Publish the reviewed final SHA once with the other incident corrections.
   The package still contains the three Root B02 controllers; app images and
   D36/keys are unchanged by this trigger. Use its exact source SHA and pin a
   reviewed linux/amd64 Cloud SDK base by digest. Build
   `infra/b02-cloud-run.Dockerfile` with `SDK_IMAGE` and `SOURCE_SHA`, record the
   image ID/revision and push only the dedicated transport image. Resolve its
   immutable registry digest before setup. No build occurs on the production VM.
2. Keep both GitHub B02 variables false and verify no other B02 agenda. Run
   `python3 -B scripts/setup-b02-gcp-scheduler.py plan --config PRIVATE_CONFIG
   --output PRIVATE_PLAN`. The closed config fixes `source_sha`, both image
   digests (`image`, `sdk_image`), `schedule_utc` HH:MM, `valid_until`, `bucket`,
   `plan_sha256`, `manual_creator`, and a unique `activation_id`. Source/config,
   provider IDs and secret-dependent plan hashes remain in private custody.
3. Provision only the plan's Job, Scheduler, two service identities and dedicated
   registry after native IAM/cost review. The setup script has no write actions.
   Scheduler must be paused before its selected first slot, and Root remains
   `schedule_enabled=false`. Native IAM must permit only the exact Job/VM/bucket:
   Job execution/task read, Scheduler read, VM lookup, OS Admin Login, IAP22,
   bucket metadata/object create/object read; the executor must not invoke Jobs,
   impersonate users or edit its binding. Verify API service agents and no SA key.
   Do not substitute the production VM service account or personal ADC.
4. `setup-b02-gcp-scheduler.py bind --config PRIVATE_CONFIG --executor-id REAL_ID
   --output PRIVATE_BINDING` fetches Job/Scheduler/OS Login directly with a
   short-lived access token supplied only via stdin JSON `{"access_token":...}`.
   It emits an inactive binding from native IDs, never caller-authored readback.
   Before any activation, review IAM conditions and exact resource definitions.
5. The Root CLI `gcp-observe`, `gcp-seal`, `gcp-apply` receives stdin JSON with
   exactly `access_token` and `binding`, and the existing `--plan-sha256`.
   Seal/apply additionally take the exact observation `--observation-sha256`.
   Each action rereads native Google state and Root/runtime; apply preserves
   old bytes and requires CAS under the four locks. Start with mode `MANUAL`,
   `first_custody_ref=null`. An interrupted PREWRITE blocks further operations;
   no caller may edit its terminal state or bypass the incomplete transition.
6. Execute the first genuine Job manually under the observed personal creator,
   with one task/no retries. Root independently reads execution UUID, creator,
   Job digest/template, task, OS Login UID and current adopted runtime. Its
   durable authorization precedes the single systemd dispatch. Four exports,
   five immutable GCS generations/full downloads, Root ACK, export disposal and
   exact ephemeral-key removal are required. Read back the terminal Cloud Logging
   receipt by its authentic execution UID: it durably preserves the fifth object's
   generation/full hash, ACK and verified key cleanup after `/work` disappears.
   A missing terminal log is unconfirmed custody, even with Root ACK. An actual isolated restore of this
   final ciphertext/COMOSP01 is a separate review gate before enabling schedule.
7. Root `gcp-propose-scheduled --plan-sha256 HASH` receives stdin JSON with exactly
   `access_token`, a new `activation_id` and the authentic `first_custody_ref` from
   the successful manual journal. It rereads the pair and Google state and derives
   the new `SCHEDULED` binding/plan hash without changing them. Preserve every
   other resource/identity/time field, with a new activation ID. Observe/seal/apply
   while Scheduler is still paused. Root requires that exact original manual
   custody receipt, not a status description. After successful CAS and the
   separately reviewed restore, resume only the exact Scheduler. Keep its daily
   HH:MM unchanged. Wait for natural Scheduler logs and the corresponding actual
   Google execution/custody receipt; `jobs.run` never proves scheduled delivery.

The binding expires no later than **2026-11-04T00:00:00Z**, within the original
financial period starting October5. Root authorization and the planned invoker
IAM condition stop new work 30minutes earlier to reserve the full task deadline.
This does **not** delete GCP resources. Before expiry, an operator must pause and
verify the exact own Scheduler, wait for own executions to be terminal, then
remove the own Scheduler/Job, pinned transport images and empty dedicated
registry, and only their IAM grants/two service identities. Read back terminal
delete operations and absence by authentic IDs; preserve the VM, bucket/retention,
Root history and keys. Scheduler paused and retained images still bill. Billing
lag and cleanup require later verification; there is no automatic financial
renewal, second scheduler or claim that a warning budget is a spending cap.

An issued authorization without a run journal remains blocking, including during
publication. The explicit Root `gcp-reconcile-authorization --plan-sha256 HASH`
action receives stdin JSON with exactly `access_token` and `run_id`. It requires
Google execution/task terminal, exact unit PID0 terminal, expired authorization,
no run directory and intact runtime, under four locks. It preserves the slot and
writes a separate immutable `NO_BACKUP_STARTED` receipt; no backup journal or
failure is invented. If any backup directory exists, use that actual journal's
canonical reconciliation instead. Do not delete the permit/claim. An unknown SCP/upload/ACK
preserves the same dump/export/object generation. Existing Root status/export/
ACK/discard primitives may finish transport after diagnosis without executing
another dump. A process-group timeout kills only that invocation's own local
children; remote systemd and ciphertext are independently reconciled.

## Historical GitHub installation procedure

The following describes the retained legacy manual transport and its previous
schedule setup; **do not execute its schedule-enablement step** after this
replacement. There is no cron in the current workflow, and Root rejects a new
GitHub backup once the GCP binding is selected. Historical status/export/ACK
operations remain available. It never justifies increasing Actions above USD0.

## Install and enable in order

1. Read effective WIF trust, lookup/IAP/OS Login permissions, current Actions
   budget and current inventory. The observed fixed estimate is USD110.65 per
   720h within the authorized USD125/30d; traffic and taxes are already authorized
   separately. Update the estimate if inventory or rates change.
   Create/read back an own Standard `us-east1` bucket with uniform access, public
   access prevention, no versioning/Autoclass, lifecycle30d and soft delete7d.
   Grant only `roles/storage.objectCreator`, `roles/storage.objectViewer` and
   `roles/storage.bucketViewer` on that bucket to the existing deploy SA. The
   bucketViewer role supplies the metadata read; if unavailable, stop instead of
   granting project access or a custom role. No SA key, VM SA attachment, VM
   restart or credentials copied into the VM.
2. Review the final source hashes and install only `b02-backup-root.py` and
   `b02_backup_contract.py` under `/opt/commerce-os/private/daily-b02/`, root-owned
   with directory0700/files0600. Build `plan.json` there in root custody, from
   existing authenticated foundation and applied profile references. Keep the
   plan and all secret-dependent reference hashes out of Git/logs/notes.
3. Create **repository** variables `B02_BACKUP_ENABLED=true`,
   `B02_SCHEDULE_ENABLED=false` and `B02_TRANSPORT_JSON`. The latter is JSON with
   exactly `bucket`, `plan_sha256`, `controller_sha256`, `contract_sha256`; these
   are transport pins, never key values/hashes. Continue using the existing five
   `production` GCP variables. Repository gates are deliberate: environment
   variables are unavailable while GitHub evaluates `job.if`.
4. Publish the reviewed workflow through the normal CI. For a complete push diff
   containing only these backup sources and their CI/tests/docs, verification
   remains FULL and app deployment is suppressed. Mixed or unknown diffs retain
   normal conservative release behavior; explicit `mode=release` remains a
   release. Check the run of the actual published SHA.
5. Dispatch `ci.yml` on main with `mode=backup`. Observe the job, terminal remote
   unit, local B02, three independent source/copy hashes, immutable GCS generations,
   complete object downloads, remote custody acknowledgement and ephemeral SSH
   key removal. A manual Mac copy or a prepared workflow does not satisfy this.
6. After that actual receipt, seal a new plan with `schedule_enabled=true`, update
   only its transport pin and set repository `B02_SCHEDULE_ENABLED=true`. Observe
   the next scheduled run independently. Do not enable a second VM scheduler.

Missing enable variables keep the job closed. These are operational configuration
steps, not actions performed by committing this code.

## Private plan contract

The controller verifies physical protected parents, root0600, full plan digest,
root-installed controller sources, retained release metadata and the existing
authenticated foundation before a task. It uses no synthetic `current` symlink
and no operational backup profile with a different key.

| Required field | Meaning |
|---|---|
| `schema_version`, `enabled`, `schedule_enabled` | Version1, explicit manual gate, separate daily gate. |
| `controller_sources` | SHA256 of the two root-installed public source files. |
| `foundation_ref` | Private ref3 (`path`, `bytes`, `sha256`) to the authenticated applied foundation, including VM identity. |
| `promotion_ref`, `applied_plan_ref` | Existing root-private ref3 to the completed promotion and its exact admin plan. The admin plan must bind the same foundation path/SHA, source SHA and maintenance image; promotion.storage and planned_private_storage_dir must both equal storage_path. Their private input hashes stay on the VM. |
| `source_sha`, `release_path`, `maintenance_image` | Current retained release/image from that foundation; no forever-pinned release. |
| `canonical_sources` | Exact ref3 for backup.mjs, backup-database.mjs, postgres-tool.mjs and local-env.mjs under that release. Also checked inside the loaded image. |
| `admin_env_ref`, `restore_env_ref`, `original_minimum_ref` | Applied root-owned owner/restore profiles. The approved original minimum is exactly `/opt/commerce-restore-private/ensayo-9418-20261005/input/backup-key.env`,87bytes,UID2000,0600/nlink1, with protected physical parents; only this reference uses UID2000. Its full reference stays private; original keys compare in RAM. |
| `docker_config_path` | Existing private empty Docker config; fixed local Unix socket. |
| `postgres` | Exact current CID/image, network commerce-os_core, database commerce and user commerce_owner. |
| `storage_path` | Exact private physical encrypted asset store, bound to the authenticated promotion/admin plan. Storage and assets directories must each be UID1000/0700, with protected physical parents allowing root or UID1000 only in this storage check. Other root references remain UID0. |
| `preserved_runtime` | Current container IDs → projection hashes captured with runtime_projection(); inventory/config/PID/StartedAt must match before and after. No fixed count of containers/sessions/assets. |
| `bucket` | Own exact bucket, matching the runner's transport input. |

Use the release's unchanged canonical B02 implementation: REPEATABLE READ READ
ONLY snapshot, pg_dump and physical READY encrypted assets. No runtime.env,
keyfiles or plaintext enter the exported files. The per-run backup.env contains
the original key only inside the VM, is root0600, and is removed after confirmed
owned Docker/PG cleanup. Original profiles and ciphertext are preserved.

## Journals, transport and uncertain outcomes

The run identity is GitHub run ID + attempt. The root journal is durable before
the child. Locks retain controller → ci-deploy → backup-schedule → maintenance-
backup order. Only the tagged/name/image-matched task's Docker containers and
its PostgreSQL application_name are eligible for cleanup. No service restart,
commercial freeze/resume, database repair or retention deletion is performed.

Before any SSH key, dispatch or upload, the runner reads the bucket once with
`gcloud storage buckets describe --raw`. It verifies the exact name, project
number1065291779811, US-EAST1, STANDARD, uniform access and enforced public access
prevention, exact Delete age30 lifecycle,604800s soft delete and disabled
versioning/Autoclass. Changed privacy or retention stops the task before backup.

The runner dispatches one systemd unit with a bounded runtime. A lost response
never causes another dispatch. Exit is checked independently from the report;
then the report is reread. `RUNNING`/`CLEANUP_UNKNOWN`/`LOCAL_CUSTODY_PENDING`
blocks a new task. The same identity returns its journal without repeating B02.
Explicit `reconcile` is available only after the exact remote unit is terminal;
it cannot start another backup or touch unrelated containers.

Only ciphertext, source.json and backup.json are exported to a run-owned0700
OS Login directory and pulled by exact-name SCP. The runner verifies all three
full hashes, then creates unique `b02/daily/<run-id>/` objects with generation=0
preconditions. An unknown create is inspected, never overwritten/reuploaded.
Each exact generation is downloaded in full and hashed independently. Metadata
SHA/size alone cannot pass. A final custody.json is stored/read back and copied
to the VM for the exact journal acknowledgement. Confirmed export copies and
the SSH key are removed; VM ciphertext remains.

An interrupted export or unknown task is preserved for exact inspection. Inspect
that run's journal/unit and directory before retrying; never delete a broad
staging tree or manually fabricate terminal journal state. Transport loss or a
runner timeout does not prove remote cleanup or offsite success.

## Cost guards and proof limits

The job is capped at30 Linux minutes; canonical backup at1500s. The ledger allows
at most37 backup starts in rolling30d, counting failed attempts across all source
versions, transports and modes in the same global history. Total ciphertext
plus receipts must fit1GiB/run. Insufficient disk/unknown custody stops the next
run; no old backup is deleted to force capacity.

The current09Oct continuation raises35 to37 only in the newly validated canonical
package. Nine authentic starts, two required new-source backups and25 natural dates
use36; a single prepublication freshness backup may use37 only if the prior backup
no longer passes the canonical guards. A still-valid backup does not authorize a
redundant refresh. The ledger is never reset, and a new failure consumes the same
finite allowance. No38th start or successful delivery is implied.

The reviewed v5 model is USD122.726758 before tax, including the unchanged A3 reserve
and one separate A4 capped at USD2. USD125 payable, ActionsUSD0 and the original end
before04Nov00UTC remain unchanged. Current credit eligibility, shared consumption,
taxes and remaining forecast require reconciliation before effects; this is not a
bill, a provider hard cap or guaranteed future credit. See the authenticated
[continuation decision](ADR-20261009-b02-keyless-scheduler.md#continuation-with-one-conditional-freshness-start-2026-10-09).

Historical35-start decision, preserved as evidence: the09Oct decision raised30 to35 without changing
the USD125 ceiling, ActionsUSD0 or the original end before04Nov00UTC. Its
preimplementation scenario is USD123.672161 before tax, not a bill or unconditional
bound. Current inventory, network, Registry, logs, all billable invocations,
laboratories and applicable taxes must fit within125 before publication; no extra
allowance or renewal is authorized. See the authenticated decision reference and
conditions in [the B02 ADR](ADR-20261009-b02-keyless-scheduler.md#shared-start-limit-2026-10-09-recorded-before-implementation).
The referenced private `DECISION-v3.md` is SHA256
`2efe7dea944a2d849f16612f7957a6d6fcdac1341a0d3be29e2aa729ae012bb4`;
its measured/reserved scenario leaves USD1.327839 before reconciling applicable taxes.
At that historical cut,7 starts plus3 transition backups left25 daily slots under35;
another failed/manual start consumes that allowance. No successful delivery is
implied, and source or plan changes never reset the counter.

The historical planned reserve was USD22/30d:900 Actions minutes, two full egress legs per
backup, and30d retained objects plus7d soft delete. No credits/minute allowance
were assumed. These Actions estimates describe the previous transport, not current
spending authority. Check provider billing and stored bytes: arbitrary manual workflow
replays, lifecycle lag, taxes and exchange rates are not a provider hard cap.
The first actual run must confirm transfer/time/cost assumptions before schedule.

The07Oct2026 read-only inventory found one e2-standard-4 VM, one100GiB pd-standard
boot disk, one in-use Premium regional IPv4 and no snapshots. Refreshed rates
give USD104.0416848 per720h for that hardware. Backup fixed costs are USD6.61
(USD5.40 Actions + USD1.11 storage reserve + USD0.10 operations), totaling about
USD110.65 against USD125/30d in that historical model, superseding its earlier
USD103 hardware cutoff. The current decision above requires coverage of all
applicable costs within125; those historical estimates do not authorize extra
traffic, taxes or Actions spending. Credits do not establish cost coverage.

GCS is outside the VM but inside the project/account. Full ciphertext custody
proves storage/readback, not restoration or independence from account loss.

References: [GitHub variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables),
[IAM roles](https://docs.cloud.google.com/storage/docs/access-control/iam-roles),
[generation preconditions](https://docs.cloud.google.com/sdk/gcloud/reference/storage/cp),
[backup contract](backup-recovery.md), [publication](publishing-changes.md).
