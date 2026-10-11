# Native package and installation publication

The prepared implementation creates a package for the same source SHA and tree
that passed FULL in Cloud Build. It reuses `package-ci.py`, the release metadata
contract and the existing Root `copy-runtime` installer. A Deployment represents
authenticated Root installation and HTTPS readback; it does not establish
physical sales, WhatsApp-number readiness or completion of the product scope.

These modules have local synthetic tests. Native package creation, installation
and GitHub publication have **not** been validated by those tests. Installation
admission and success publication have distinct gates: the former reauthenticates
FULL/package, budget and Root approvals; the latter requires the resulting Root
report and HTTPS proof. A package JSON alone cannot enable success publication.

## Package preparation and execution

`scripts/cloudbuild_native_package.py` supplies the trusted, inline Build config.
The controller passes an authenticated FULL manifest, a digest-pinned private
package image, the trusted driver and canonical packager hashes, and the artifact
bucket. The package Build has an 1800-second timeout, a 600-second queue limit,
SHA256 source provenance and a dedicated package service account. The controller
must reserve this stage in the existing ledger before dispatching CreateBuild.

The package uses a separately reserved GCS source object. Its immutable generation
must contain exactly the FULL source archive bytes. A protected replica receipt
binds the FULL locator, new locator and SHA256; `source_replica()` validates the
binding but does not authenticate a hand-written receipt. The controller must
produce and re-read the native copy before admitting it. This exclusive locator
preserves reconciliation of an ambiguous CreateBuild response without duplicate
builds.

`scripts/cloudbuild-native-package-driver.py` runs from the reviewed package
image, checks its own hash and the candidate SHA/tree/clean checkout, and checks
the candidate `package-ci.py` hash. It invokes the existing source preflight,
builds runtime, web, maintenance and portal for Linux AMD64, then invokes the
existing packager with the provider context. It rechecks source identity and
extracts the resulting archive with the canonical release validator before
emitting one package receipt. Its inner deadline is 1740 seconds. Temporary HOME,
Docker config and context stay outside the source tree. Child processes do not
inherit ambient credentials or Git configuration.

Each child has a 4 MiB stdout and 1 MiB stderr allowance. Overflow terminates its
process group and fails the stage; it never silently truncates a successful
verification. The seven package commands allow at most 35 MiB of child output,
plus small receipts and provider metadata. This bounds the driver output, not
all provider-generated logs or their bill.

The package image needs Git, Python, the required Python dependencies, Docker CLI
and a reviewed Buildx version. It is a separate image from the FULL verifier:
the verifier does not need to build these four product images. Candidate code
can reach the package worker's metadata identity, so that service account must
have only the package stage's admitted capabilities, with no production access.

## Authentic package reads

`GooglePackageReader` receives a token provider and the native FULL reader. It
uses bounded, nonredirecting HTTPS requests and no personal CLI configuration.
It requires native FULL success, exact Build configuration, package UUID,
resolved source generation and native source SHA256. Cloud Logging pagination
continues through empty pages, rejects repeated tokens and requires a completed
query containing exactly one receipt tied to this Build. Both native `jsonPayload`
and the exact package step's `textPayload` prefix are accepted.

Artifact manifest and archive locators require explicit object generations.
Archive download reserves the transfer before GET, uses a new protected file,
and validates size, MD5 from native artifact metadata and SHA256 from the unique
package receipt. A partial file and its reservation survive failure; the module
does not retry it or replace it. This is an input to the existing installer, not
a second installer implementation.

## Deployment publication

`scripts/cloudbuild_native_publisher.py` receives trusted admission, Root and HTTPS
readers, a GitHub API adapter and `DurableEffectJournal`. It requires a separate
write-authorized GitHub credential. The connected source App's read token is not
treated as a publishing credential. Repository ID, private status and current
`main` must match before publication. The actual Root report and both public
version endpoints must satisfy `deployment_payload()`; native admission is read
again after those checks.

Each Deployment and status is a distinct durable action. Only a confirmed new
CAS intent returns `CREATE_ONCE` and permits one POST. Missing responses or failed
result persistence remain uncertain; subsequent calls read existing Deployments
and statuses and cannot repeat that action. An already successful publication is
reconciled. A partial Deployment can gain its separate success status only after
fresh native installation checks. Conflicting or incomplete inventories stop.
The publisher never marks a failed status successful by overwriting it.

The outer publisher stage keeps the existing 900-second allocation. Its concrete
controller wiring must bind the protected journal to that active reservation;
the journal is initialized explicitly once and is never recreated on read.

## Canonical native installation transport

`cloudbuild_native_install.py` adapts the existing `deploy-ci-client.py` from its
hash-pinned trusted image. The client still transfers the same canonical Root
installer, checksums every file, and uses the existing systemd installer and
rollback. Root still authenticates sealed migration, tool and edge approvals.
It does not require a successful report from an installation that has yet to run.

The adapter re-reads the publisher workload identity, exact VM, current `main`,
deployment pause and Actions controls, and authenticated release admission. Its
dedicated service account receives a short-lived ADC token through an isolated
SDK process environment; no personal account, source App write permission or
ambient credential is assumed. The GitHub control reader is separately supplied
by protected configuration. Fresh control/identity/admission checks and a second
durable intent occur immediately before the one Root start command.

The transport deadline is 900 seconds, including 90 seconds reserved for removing
its own ephemeral key. Child output and run times are bounded. The default
historical client keeps its existing rollback wait; the native adapter has its
own bounded poll using the same terminal-unit/fresh-report checks. Timeout leaves
systemd's installer and rollback running and records an uncertain outcome.
Reconciliation reads that existing unit/report and cannot transfer or start it
again. After authenticated terminal readback it invokes canonical staging cleanup,
which independently rechecks terminal state and MainPID. Unknown or running units
retain their staging. Its own key is revoked even when staging cleanup fails.

Transport receipts are private derived records. Publication independently reads
original Root report bytes and HTTPS; a transport receipt cannot substitute for
that custody. No test of this adapter proves that the publisher service account
has working production permissions.

`cloudbuild_publisher_readers.py` provides fixed-origin, bounded HTTPS readers
for the publisher workload identity, VM, GitHub controls and public versions.
The original private connection's `accessReadWriteToken` is acquired at most
once per credential object, kept only in memory, and checked for sufficient TTL
and the exact original repository ID. Obtaining that token does not establish
Deployment write permission. Unknown token acquisition is not retried, and the
public repository's separate authorization is never bypassed. Publication still
requires the actual Deployment POST and authenticated readback.

`NativeRootReadback` invokes the hash-pinned existing
`cloudbuild-installed-readback.py` through the same bounded IAP transport and an
ephemeral OS Login key. It returns that collector's original Root custody data;
it cannot substitute a transport receipt or start the installer.

The prepared publisher image fixes Google Cloud CLI 588.0.0 and uses Ubuntu's
Python instead of shipping an unused bundled interpreter. Its entrypoint is
`/opt/trusted/cloudbuild-publish.py`; credential-free resource configuration is
baked into that image at a fixed read-only path. Image creation and scanning
are still required before admission.

The first local publisher fixture scan found three HIGH findings in the SDK's
Go CRC32C executable. The publisher transport permits only `gcloud compute`
SSH/SCP/OS Login; package downloads use the separate Python reader with native
MD5 and release SHA256 checks. The image excludes the unused
`gcloud-crc32c` storage helper. It does not disable any package checksum, hide
version metadata or waive scan findings. The corrected local fixture image
`sha256:9360f2846f5802684d0fc5195d2fb06deed3e566281257290b7468e9ec99eddb`
passed Trivy with zero HIGH/CRITICAL, retaining 12 MEDIUM and 4 LOW findings.
Its read-only, network-disabled Linux AMD64 smoke passed imports and the allowed
Compute command help paths. The fixture config is never a production configuration
or deployment proof; sealing genuine resource generations requires a new image
digest and its own scan.

## Publisher worker custody and execution

`cloudbuild_publisher_worker.py` imports only image-owned modules. Its native
Build UUID comes from Cloud Build's fixed entrypoint argument and must match the
authentic native Build, active ledger reservation and protected task. The immutable
input body holds release admission, FULL/package/attestor attempt IDs, the
attestor contract, installation attempt, journal locator, trusted client and
collector hashes, transfer allowance and expiry. It contains no publisher plan,
approval or reservation: its hash is known before constructing those documents.

The protected task separately binds that body descriptor, native publisher
contract, plan, approval and admission. The native template hash must equal the
plan's config hash. This avoids a circular body/template hash while preserving
the exact source SHA/tree, image, driver, budget and native UUID bindings. Control
or custody changes, missing historical consumption, expired reservations and
non-WORKING native builds close the gate. Before every new external intent takes
effect, the worker reauthenticates those controls, native FULL/package/attestor
evidence and current GitHub `main`, pause and Actions settings.

Before dispatch, the controller stores a `PUBLISH_PREPARED` task with the same
body, plan and approvals. Its provisional contract UUID is only a template input;
it is never admission to install. The worker allows at most five complete read
observations within an absolute 30-second window for the controller to bind the
actual native UUID in the ledger and publish the final `PUBLISH` task. It verifies
the actual Build against a RAM-only copy of the prepared contract with that UUID,
then permits only the exact prepared-to-bound transition. UNKNOWN, rewind, pause,
expiry or unrelated custody drift stops immediately. No write credential, journal
mutation, package download or Root action occurs while waiting. These observations
each use eight GCS reads and one native Build read, plus their metadata ADC reads;
all must be included in the operating request budget.

INSTALL authenticates the native source archive's Git SHA/tree, clean checkout,
safe Git metadata and regular files, then copies those bytes into a private
directory. Candidate Python modules are never imported by the worker. It reserves
checkout/archive/SCP bytes before writing or downloading, downloads the exact
generation once, and invokes the existing canonical installer. The single
900-second deadline includes preparation and reserves 90 seconds for cleanup;
no helper receives a fresh additional publisher allocation.

RECONCILE reads the existing Root unit/report and existing GitHub Deployment and
statuses. It cannot copy, download, restart Root or POST to GitHub. Incomplete
historical publication stays blocked rather than gaining an automatic new
effect. Both paths require original Root custody and HTTPS before success.
It uses a new native publisher Build, reservation, task body and separately
initialized journal. Its body additionally requires `origin_task_ref`, an
immutable descriptor of the earlier `PUBLISH`/`INSTALL` task. The original
attempt must already be terminal and reconciled in the ledger and must match
the native Build, source archive and template. Its approval and economic
admission are validated at the recorded submission time as historical evidence;
the new execution requires fresh approval and budget for all current reads.
Release admission, dependency IDs, installation number, client/collector pins
and transfer allowance must match the original body. The earlier journal must
exist at its original location and authenticate both transport and Root-start
intents. Its generation and contents remain fixed throughout reconciliation.
No original intent, result, uncertainty or cost is reset or rewritten, and no
missing Deployment or status can create a new intent. A terminal Root receipt
allows the existing transport's bounded staging/key cleanup, never another start.
The worker's tests are local synthetic orchestration and real isolated Git-copy
tests; they do not establish actual publisher permissions or an installation.

Static request accounting for this wiring bounds INSTALL at 18 complete
admission reads and RECONCILE at eight. One INSTALL admission performs 24 GCS
Class B reads and at most 24 other Google API calls plus 11 GitHub reads;
historical reconciliation adds six Class B reads and one native Build read.
Binding acquisition adds at most 40 Class B and five Build reads. Six distinct
INSTALL intents and a conservative six result writes add at most 12 Class A
and 60 Class B operations. Including the initial active/journal reads and the
generation-bound package download yields 12 Class A / 544 Class B for INSTALL
and 290 Class B for RECONCILE, excluding the controller/producer. Each Google
API/GCS request also obtains ADC through two metadata GETs. These are source
path estimates, not a native billing measurement or a general request meter.
Individual JSON response bounds can collectively exceed the transfer allowance's
16 MiB metadata headroom: the 6 GiB field bounds checkout/archive/SCP admission,
not all network bytes. Admission must separately account for those API bytes,
polling, metadata calls and the SDK/IAP's native request fan-out before activation.

## Remaining activation evidence

Before activation, build and scan the trusted package/publisher images, wire ADC
and the canonical Root/IAP transport in those images, authenticate the separate
GitHub write capability, and exercise the complete native sequence with budget
admission. The native FULL, package, Root report, archive custody and HTTPS
evidence must identify the same release. The success publication gate is evaluated
only after those native reads. Local tests do not authorize a new cloud attempt
or establish a deployed result.

The private deployment profile belongs to the original project. A reusable
public profile must keep source-only behavior and require its own connection,
identity, budget and installation settings.

## Package image dependency decision (2026-10-11)

Buildx 0.38.0 still imports the obsolete `github.com/docker/docker` module solely
for automatic builder names. [Moby's migration guidance](https://github.com/moby/moby#go-modules)
states that this old module will receive no updates. The package image therefore
replaces that name generator with a small `crypto/rand.Text()` implementation,
keeping explicit names, name validation and the six-attempt collision check.
Automatic names become `buildx_` plus lowercase random base32; Go documents at
least 128 bits of randomness for [rand.Text](https://pkg.go.dev/crypto/rand#Text).
This removes the deprecated module from the actual dependency graph. It does not
rename a vulnerable package, remove its version metadata or ignore scan findings.

The source archive and patched file are hash checked. Buildx is rebuilt with
Go 1.26.9, `go-archive` 0.3.3 and `x/net` 0.60.0. Its original name validation
and new generator tests run during image creation; a fresh image scan and real
four-image package execution remain required before use.

The first local AMD64 image attempt passed `go test ./store` but reached its
1800-second bound while compiling Buildx under emulation. Cancellation and the
absence of remaining compiler processes were verified; no image was produced.
The revised Dockerfile uses Docker's documented
[native builder and Go cross-compilation](https://docs.docker.com/build/building/multi-platform/#cross-compiling-a-go-application):
store tests run on the builder architecture, dependency inspection and the final
binary target Linux AMD64, and the image smoke executes that final binary. Module
and compiler caches preserve verified inputs across a bounded attempt; no tests
or vulnerability checks are removed.

The final local bounded-output package image built for Linux AMD64 on
2026-10-11 is `sha256:bee55ec4ad8d24d5d2441b4bce86dc10889bca8727e8cace56a1aec040e8879c`.
The native builder's store tests passed before the cached final-layer rebuild.
Trivy 0.75.0 reported zero HIGH and zero CRITICAL findings, retaining 12 MEDIUM,
4 LOW and 1 UNKNOWN without waivers. Its report SHA256 is
`316e1c6fd08a97494ec2db2b41a7e23f6431253cfbd98ea48a0a86e20b3ae023`.
This is local image evidence; the four-image native package stage and installation
remain unproven until their actual admitted Cloud Build runs and Root readbacks.

The final cross-attempt reconciliation worker was rebuilt locally on 11 October
2026 as `sha256:48efc4754da2a952d9c80da907dd7f213fa13e9f6f81723f402346bf41b2af84`.
Its immutable input manifest includes the reviewed worker and 35 unit tests pass.
The resulting Linux amd64 image passed the same bounded, network-disabled smoke
and Trivy reported zero HIGH/CRITICAL, retaining 12 MEDIUM and 4 LOW findings.
[The separate evidence record](evidence/v7-publisher-reconcile-fixture-image-20261011.json)
preserves the earlier fixture scan and binds this later build, scan and smoke by
hash. Both configurations remain synthetic; this is neither a native publisher
Build nor a production installation or permission claim.
