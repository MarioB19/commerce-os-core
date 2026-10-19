# Controller request budget for the 1,200-minute CI pool

The native FULL pool was expanded on October 18, but the controller request
meter retained a separate 20,000-second CPU ceiling and 40,000 GiB-second
memory ceiling. On October 19 it held 19,685 seconds of charged reservations.
An ATTEST operation reserves 450 seconds, so admission stopped before any
approval even though the FULL pool still had 670 minutes available.

Owner-approved operational change (October 19): derive the currently deployed controller image
`sha256:66ab2b459e7c5ecc8aed58b55b5284ffee038a2352891c3fc2c168bafcc70c2d`
and replace only `cloudbuild_runtime_meter.py`, increasing the two monthly
ceilings to 40,000 CPU seconds and 80,000 GiB-seconds. Preserve the 2,000-request
limit, 450-second per-request ceiling, all existing rows, charges, exclusive
leases, approval gates and unknown-effect recovery. No ledger reset or refund.

At Cloud Run tier-1 request rates of USD0.000024/vCPU-second and
USD0.0000025/GiB-second, the additional reservation ceiling represents USD0.58
before tax, or USD0.6728 with the project's 16% tax assumption, per month.
This is a conservative model for reserved active CPU/memory, not a measured
bill or a provider-wide spending cap. Requests, startup/shutdown and storage
remain separately accounted. Source: https://cloud.google.com/run/pricing
The overall project ceiling stays USD100/month and Actions stays USD0.

Brandon approved this additional ceiling in chat on October 19: ‘Sí, aplica el ajuste y termina el deploy’. The 59 controller/meter tests passed, and image inspection confirmed that only one of 47 trusted files changed. The
candidate application remains `17bbfafd`; no change is merged into main before
its installation. Test the reservation boundary and preservation of historical
charges, compare the derived image's complete trusted directory to its base,
then update only the controller service image while both controls are paused.
The attestor does not use the HTTP request meter and remains unchanged.
