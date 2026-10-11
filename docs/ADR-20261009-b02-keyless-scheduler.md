# B02: one keyless operational scheduler

Decision recorded before implementation, 2026-10-09. Local implementation is
authorized; provisioning, IAM verification, activation and publication are separate.

Replace only the B02 GitHub schedule with one Cloud Scheduler/Cloud Run Job in
the existing test project and region. Actions remains USD0. No commercial feature,
second B02 timer, VM, service-account key, application secret export or SQL change.
The USD125 first-30-days ceiling requires measured remaining cost and an explicit
expiry; neither a paused Scheduler nor retained images are free.

Keep foundation D36, existing keys and canonical B02/COMOSP01 cryptography. Separate
backup execution IDs (GitHub or actual Google execution UUID) from portal release
IDs (GitHub only). Read Google execution/job/task and OS Login directly using a
short-lived access token supplied over stdin, never a caller-authored observation.
Tokens remain in memory, are not command arguments, references, journals or logs.

An exact Root binding fixes source/image/job/template/principals/target/plan and
finite validity. Under the four existing locks, reserve the daily UTC slot durably
before dump, bind its first execution, and retain the common rolling ledger,
limited to37 starts in30 days by the continuation decision below. Duplicates and unknown states
cannot create another backup. HTTP Scheduler
headers are not assumed to arrive in the Run container: use authenticated execution
creation time within the fixed daily window; native Scheduler logs must separately
prove an actual scheduled delivery. Manual acceptance is explicitly manual.

Cutover requires a genuine first custody receipt and observed inactive Cloud
configuration. It uses reviewed observe/seal/CAS journals, preserving the prior
plan, Root adoption and binding. No arbitrary scalar edits or partial transition
may authorize a run. Existing release/portal IDs and deadline guards stay strict.

The transport has a single global deadline and a bounded, own process group for
every external command. TERM/KILL affect only that group; interrupted SCP, remote
systemd state and immutable object generations require reconciliation, not another
dump. Four exports, five object generations, full readbacks, ACK, exact-key cleanup
and separate restoration proof remain mandatory. A fifth transport image is pinned
separately, without changing the four-image application package.

Integrate this correction with reviewed PR41/42 only after the pilot is complete.
One final SHA/FULL/package/publication (68-to-68 already supported), then final B02
through the new transport, isolated restore, and an actual natural scheduled run.
Prepared code, synthetic tests, installed timers and manual jobs prove none of those
operational outcomes. Setup must not autoactivate or renew financial authority.

Sources: [Scheduler to Jobs](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule),
[execution identity](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs.executions),
[container contract](https://docs.cloud.google.com/run/docs/container-contract),
[cost](https://cloud.google.com/run/pricing). See `daily-b02-offsite.md` for retained
backup/custody constraints and `publishing-changes.md` for publication.

The single daily UTC hour/minute is fixed in the setup binding before provisioning.
It need not be the historical 04:00 UTC: choose enough time for manual backup and
restore, then keep the clock unchanged during activation. This permits the first
natural delivery in the current operational window without a demo cron or manual
Scheduler invocation.

The observed authorization window is fixed to 2026-10-05 through strictly before
2026-11-04T00:00:00Z (Root billing readback 09-Oct 10:14 UTC). The implementation
rejects rolling thirty more days from setup or renewal by changing a binding.
Credits and the warning budget are not a spending cap or proof of zero cost.

Expiry does not delete paid resources. The inactive setup plan contains an explicit
future cleanup sequence for only the owned Scheduler/Job/registry/IAM identities,
with identity/absence readbacks, preserving backups and the production VM. The
invoker IAM cutoff and Root start gate reserve1800seconds before the financial
end; they do not turn paused Scheduler or retained registry into free resources.
An operator must execute and verify that cleanup; no second scheduler is added.

Image startup contract, reviewed before provisioning: Cloud Run `command` replaces
the image ENTRYPOINT, while omitted `args` inherit the image CMD. The transport
image therefore declares the exact Python ENTRYPOINT and an empty CMD. This avoids
duplicating Python/script arguments when the unchanged Job.command is applied.
Verify the built image Config plus a real `--prepared` container with networking
disabled; a Cloud Run probe override alone would hide an incorrect inherited CMD.
Source: [Container command and args](https://docs.cloud.google.com/run/docs/reference/rest/v2/Container).

Native inactive Job readback on 9-Oct confirmed the requested template unchanged,
including explicit maxRetries0 and resource limits. A successful v2 GET omits the
false `reconciling` scalar. Accept that documented ProtoJSON omission only with
positive matching generations and terminalCondition Ready/CONDITION_SUCCEEDED;
reject null, non-booleans, pending/failed conditions and deletion. The immutable
Google response remains evidence; no response rewriting or defaulting of retries.
Source: [ProtoJSON presence](https://protobuf.dev/programming-guides/json/#presence-and-default-values).

The single authorized inactive `--prepared` execution also established the native
v2 resource shape: Execution.job and Task.job/execution are short IDs; Task.name
is `<execution-resource>/tasks/<execution-id>-task0`. Derive only that first task
and bind both short parents to the exact full execution; `/tasks/0` is not an API
resource. This applies equally to authorization and never-started reconciliation.
Task GET omits executionEnvironment, while the unchanged Job/Execution templates
explicitly require GEN2. Allow only that omission or explicit GEN2; reject null,
GEN1 and unspecified. Jobs support only the second generation, per
[execution environments](https://docs.cloud.google.com/run/docs/configuring/execution-environments).
The historical probe intentionally overrides timeout/args and is rejected by the
normal backup execution guard; it is startup/shape evidence, not a backup run or
proof of the later final transport image.

### Native OS Login identity (2026-10-09)

An authenticated own-service-account GET to the numeric IAM identifier was rejected by OS Login. The exact executor email succeeds; its LoginProfile `name` is the bare immutable numeric IAM ID, and a newly created service account can initially have no POSIX accounts. The SDK 585 OS Login client likewise addresses the authenticated account by email. Root and setup therefore query only the fixed executor email endpoint and independently require the returned bare ID to equal the observed immutable IAM identity. The UID and username remain provider-assigned, unique Linux-account requirements; no Unix identity is inferred from email. An empty profile cannot bind or authorize a backup.

Provisioning the account is a separate reviewed bootstrap using the official `users.projects.provisionPosixAccount` method (which returns one PosixAccount), then another authenticated LoginProfile GET. It creates no SSH key and grants no workload role. Provider errors, unknown outcomes and prior receipts remain preserved. Neither this correction nor the bootstrap enables the Scheduler or bypasses Root observation.

Primary references: <https://docs.cloud.google.com/compute/docs/oslogin/rest/v1/users/getLoginProfile> and <https://docs.cloud.google.com/compute/docs/oslogin/rest/v1/users.projects/provisionPosixAccount>.

### Shared start limit (2026-10-09, recorded before implementation)

Historical30-to35 decision, retained as the basis of the installed contract before
the continuation below; its scenario and validation are not reassigned to37.

Raise only `MAX_RUNS` from30 to35. The original30 was a technical cost-planning
assumption, not the user's financial ceiling. Seven observed historical starts,
three backups required by the publication/gateway transitions and25 daily slots
from10-Oct through03-Nov require35 starts. This leaves no allowance for another
failed/manual start and does not prove25 successful deliveries. Re-read the actual
ledger before operational decisions.

Keep the same global journal directory and rolling30-day window. All started
backups count regardless of source SHA, legacy/GCP transport, manual/scheduled mode
or outcome; publication and cutover never reset or partition that history. The
existing four locks, terminal-task reconciliation, duplicate-slot rejection,
1500-second backup deadline and1GiB export limit remain unchanged. Boundary tests
must allow a new start after34 and reject it after35, including the exact30-day
cutoff and mixed historical/GCP journals. `BACKUP_30_DAY_RUN_LIMIT` still names the
window, not the maximum number of starts.

The private preimplementation decision
`b02-35-global-starts-financial-decision-preimplementation-20261009/DECISION-v3.md`
(SHA256 `2efe7dea944a2d849f16612f7957a6d6fcdac1341a0d3be29e2aa729ae012bb4`)
models USD123.672161 **before tax**, leaving USD1.327839 within125 in that scenario.
It is preliminary evidence, not a bill, an unconditional cost bound or expanded
spending authority. The projection includes measured inventory/traffic and
reserves for Registry, logs, billable Job invocations and laboratories. Remaining
consumption and applicable taxes still require reconciliation against current
evidence. Publication remains subject to verifying coverage within the unchanged
USD125 ceiling. Actions remains USD0; no extra allowance or renewal is authorized.
The original period ends strictly before2026-11-04T00:00:00Z, with the existing
start/IAM cutoff at2026-11-03T23:30:00Z and owned-resource cleanup still required.

This is a new canonical source/package, not a scalar edit to an installed
controller. The four-epoch operator must authenticate the old contract for its
prepublication epoch and the new contract for the three later epochs; Root and
portal controller bytes remain identical, and the contract's sole permitted byte
delta is `MAX_RUNS = 30` to `MAX_RUNS = 35`. Existing source, FULL, approvals,
journals and operator preparations remain historical evidence. A fresh final
source, validation and publication must precede use of the new limit.

### Continuation with one conditional freshness start (2026-10-09)

The reviewed private `DECISION-v5.md` (SHA256
`186251debc5dd180111091b8d92372c09506b0274bf7cd3b2057b967ac00d76a`)
and independent financial receipt (SHA256
`81f4cc18a798e11641e2d19e683f7b6e5b328bc219ac47d4ad02bbfc43cb7d68`)
support Root's explicit decision to prepare only `MAX_RUNS = 35` to `MAX_RUNS = 37` in the new canonical
source. Nine authentic starts remain counted. Two further backups cover the new
source with nine services and the adopted ten-service runtime;25 natural dates
remain from10-Oct through03-Nov. The additional single freshness backup is
conditional: do not run it if the prior backup still passes its canonical
source/pair/binding and one-hour guards. This is36 starts without that contingency,
37 with it, not authority for retries or a38th start. The local predeploy dump is
separate from this ledger.

Keep the same rolling30-day global ledger, all outcomes/transports/source epochs,
four locks, deadlines,1GiB export bound and expiry before04-Nov00UTC. Boundary tests
allow a new start after36 and reject it after37, preserving the exact cutoff and
invalid-time checks. Existing30/35 packages and their approvals stay immutable;
only a newly validated and published package may use37.

The revised gross model is USD122.726758 before tax, including the original A3
reserve and a separate A4 laboratory capped at USD2; neither laboratory's deadline
is extended. USD125 payable, ActionsUSD0 and no renewal remain unchanged. This
is conditional modeled coverage with observed eligible credit, not an invoice,
provider hard cap or future credit guarantee. Reconcile credit eligibility,
shared consumption, taxes and remaining forecast before effects; block added
expense if payable cost would exceed125. Preserve previous decisions and receipts.
