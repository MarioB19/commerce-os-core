# Owner sessions during the copy publication

Main52cf/run37723205219 stopped in validation with
`COPY_FROZEN_OWNER_BARRIERS_CHANGED`. A fresh read-only transaction observed
six login rows, two login subjects, three active owner memberships and one PAT;
all twenty external-effect barriers remained zero. Four original containers,
D36/current and HTTPS readiness were preserved. No preparation or activation
was reached.

The copy guard must validate legitimate owner access independently of the
historical four-row/two-owner count. Keep a bounded private observation:
0–32 session rows, 1–8 distinct active owners of the PAT workspace and exactly
one valid PAT. Every session subject must belong to that owner set. Preserve
unique identities, UTC/12h lifecycle, PAT permissions and expiry, and compare
all private session/token/membership identities before and after each phase.
Changes during publication still stop it; expired sessions cannot be revived.

This change grants no role, creates no session and writes no authentication
data. It neither removes rows to satisfy a count nor opens any effect barrier.
The snapshot is established afresh under the existing publication lock and
kept private. Concurrent logins or membership changes require a fresh attempt
after reconciliation; they cannot be accepted midway through a release.

Portal/CI installation and HTTPS readback remain separate requirements.
