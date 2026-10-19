# Preserve existing owner API credentials during publication

Release 7's Root review stopped at `COPY_OWNER_AUTH_BINDING_CHANGED` before
installation because production has two legitimate, unrevoked owner API
credentials. The publisher assumed exactly one. On 19 October 2026, Brandon
chose to preserve both credentials, correct the installer, and repeat CI.

The publisher now accepts between 1 and 32 existing owner tokens. This is an
observation bound, like the existing bounds on sessions and owners; it does not
issue credentials or authorize additional access. Every token must have a
unique ID, a valid lifetime, no revocation, the existing REAL permission, and an
active owner membership in the canonical workspace. The same bounded count is
used by the initial copy and first-start aggregate guards. All external-effect
barriers remain closed.

Before/after comparison preserves the complete set, sorted by token ID. Adding,
removing, rotating, revoking, extending, changing permissions, or transferring
any token during publication still stops it. Queries stay read-only and select
no token secret or hash. Existing session lifetime checks remain unchanged.

Regression tests cover two legitimate credentials, reordered observations,
validation of the second credential, duplicate IDs, foreign owners/workspaces,
invalid lifetimes/permissions, inventory limits, and changes during publication.
A read-only diagnostic against production validated all existing identities and
the runtime snapshot with the correction. It did not seal an approval, install
software, or mutate production. The final package still requires native FULL,
attestation, and its own canonical Root observation and seal.
