# Verifier image validation — 2026-10-11

The Linux AMD64 verifier candidate built from `infra/cloudbuild/Dockerfile.verify`
passed a native Trivy image scan with **0 HIGH and 0 CRITICAL** findings. The scan
retains 30 MEDIUM, 18 LOW and 1 UNKNOWN finding. No ignore file, waiver or
`--ignore-unfixed` was used. This validates the image security gate; it does not
establish a successful FULL run or an installed CI service.

The candidate uses an updated Ubuntu 24.04 runtime, Node 24.20.0, npm 11.20.0,
pnpm 10.34.5, Docker CLI 29.9.0 and the rebuilt Compose 5.6.0 dependency closure.
Buildx belongs in the package image; the verifier's complete FULL sequence does
not build product images. FULL stages and security thresholds remain unchanged.

| Evidence | SHA256 / value |
| --- | --- |
| Local image ID | `5dd08b19782bb9dc6cfb470dc072d12793cea8570c9ce798611b3fda52f56412` |
| Dockerfile | `c1991147978c03f242505d5249fc419d6f8ac4c6e7d16d89264987b0b39eaa6d` |
| Trusted verification runner | `cb42b27e057482620516fb45deaa089043f5017fed12bc1585517ebe6abee814` |
| Native image scan JSON | `ee0763046654926fb644c47da684f58bba121fbb9f3b108d849f434a5785ee46` |
| Scanner | Trivy 0.75.0 |
| Vulnerability database | `03cacb40452ceb74afdfca072cb82f79ee884dfac006ef24a4dfdad133b0f917` |
| Database updated / next update | 2026-10-10 18:59:50Z / 2026-10-11 18:59:50Z |
| Build finished | 2026-10-11 15:23:19Z |

A constrained local smoke check ran without networking, with a read-only
filesystem, one CPU and 512 MiB, and confirmed the installed tool versions.
The image remains subject to registry digest verification and a complete native
FULL run for the exact candidate source. No cloud build or deployment was created
by this image build and scan.
