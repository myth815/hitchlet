# Studio ARM candidate acceptance — 2026-11-03

Candidate source: `0547222c359ac9d35a3416a2ba19385d5a616a1a`. This is a bounded Docker/Studio ARM acceptance, not media-business, Tart, Windows, or production deployment certification.

## Build and environment

The new explicit output-write authorization allowed the previously denied contracts build to succeed on its single authorized retry. SDK, GUI, Controller and Runtime/native Host builds then passed. Native tooling was Node 24.21.0 and pnpm 10.28.2; GUI no-emit checking also passed. No sandbox, filesystem modes, global network, or authentication configuration was changed.

The earlier Colima `Broken` label was caused by sandbox denial of host boot-session metadata (`operation not permitted`). An authorized read-only check showed `Stopped`. The retained `hitchlet-studio-acceptance` profile resumed normally without repair or recreation: 6 CPUs, 8 GiB RAM, Docker context `colima-hitchlet-studio-acceptance`, Engine `98531c12-2a3b-4ed6-82c3-08abfb8120a4`, Docker 29.5.2, Linux arm64. Global Docker context remained `default`.

The first real native Controller startup exposed an ESM/CommonJS interoperability defect: named `utils` import from `ssh2` failed on Node 24.21 even in Portainer mode. The candidate fixes that through the CommonJS default export. Four focused SSH readiness tests passed, including a separate Node process importing the compiled provider. The earlier app-only image import smoke had not covered this server composition dependency.

## Exact artifacts

Both final images were built from the formal Dockerfiles on that Engine using the existing legacy builder; Buildx was not installed. Runtime supplied `TARGETARCH=arm64` explicitly. Both carry the candidate's full OCI revision label and are Linux arm64.

| Artifact                                    | Identity                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| Controller/GUI local image ID               | `sha256:d3fc2fd3e210cbec48bbe6525cb379ff84acecd3d314adc4a08f98a334f28bbe` |
| Runtime local image ID                      | `sha256:0726e370471cb21482b8776d04c7eb598e32c55fe18abc8e2d6b3a54f28546e8` |
| Node 24.22.0 bookworm base pull digest      | `sha256:925de64a85319052d6971ae81ef2417da956e8a3a2c4a0fac732327970f017f5` |
| Node 24.22.0 bookworm-slim base pull digest | `sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4` |
| contracts 0.1.0 local tarball SHA-256       | `5170ebaad46bf5e2bda41262d1c0317a695938ca38b1cc07888c99f3bf8f4d4f`        |
| SDK 0.1.0 local tarball SHA-256             | `45217cabc60e0c11122a0ef2d6308930d48db899abf436d8fb30b0e69b2b909d`        |

Image IDs are local immutable identities, not published registry digests. Nothing was published to a registry. The pair manifest records the same source revision and matching build fingerprints. A separate consumer installed the actual local archives with npm and zod 4.1.12, without lifecycle scripts. Package-name imports and the installed example's real Controller health request passed for this candidate. The injected-transport contract check belonged to the earlier `b32c2cc` preparation and is not counted as a new test of `0547222`. An initial offline pnpm attempt needed private-package metadata; the documented npm flow succeeded after obtaining the pinned public zod dependency. No registry credential was used or created.

The final Controller image passed a no-network, read-only, cap-drop-all smoke: UID 1000, Node 24.22.0, native SQLite, GUI assets, application and compiled Tart SSH imports. The Runtime image included Docker CLI 29.5.2, iptables and conntrack; its actual authenticated startup and resource operations were exercised below.

## One real synthetic lifecycle

The real lease used the retained topology: newly built native Controller and Mac Host, plus the final candidate Runtime container. Its original mounts, host network/pid mode, read-only root and NET_ADMIN-only capability configuration were preserved. Existing protected credentials and journal were reused; no new long-term identity was configured. The production Controller image was tested separately as described above, not deployed over a new persistent containerized control plane.

Exactly one new Ticket, `ada108e4-e22c-4d88-8e86-ad54aebadf6f`, created Allocation `9ca7f359-5234-4724-895d-bd778b916812`. The installed candidate SDK reused the authorized version, Node, network, synthetic read-only input and persistent output profiles. The unchanged tenant image remained pinned to `sha256:5cf584cab167af0b6a3dc2271809657d4c6368270f356e1a079031493f321a86`. No qualification or policy was fabricated or relaxed.

- UTC 06:56:38: preview eligible, acquire accepted; 06:56:45: ready and claim confirmed.
- SSH authenticated only after the raw server-key SHA-256 fingerprint matched the API grant. Private material stayed in memory. UID/GID 1000, tenant Node 24.22.2, and the 18-byte synthetic input hash matched; an input write failed with EROFS.
- Actual cgroup values: `cpu.max=50000 100000`, `memory.max=536870912`, `memory.swap.max=0`, `pids.max=512`.
- A unique synthetic JSON output was saved and checked locally before release. SHA-256: `e0e34d802b5940ec086f7032689fd5f24f855ef4f7e666be7bdec5e354497cfd`.
- UTC 06:56:46: renewal confirmed, lease version 3→4; expiry moved from 07:11:45.260Z to 07:16:45.877Z. The SDK's pending response was not treated as confirmation.
- UTC 06:56:50: `consumer_release / released`. Afterward exact Docker container, network and workspace-volume inspections each returned not found. The persistent output hash remained identical.

After clean Controller shutdown, the cold ledger showed this Allocation desired/observed absent and cleanup complete; all five cumulative Claims were released and all four cumulative Tickets released. No live ledger lock was bypassed: cold inspection occurred after the Controller closed.

## Retention and limits

Native Controller, Host and HTTPS proxy were stopped. The three dedicated management containers and Colima profile were stopped and retained. The original stopped Runtime container remains as a rollback container named `hitchlet-studio-runtime-agent-before-b32c2cc`; the superseded intermediate candidate container was removed by exact ID. Final candidate images, build cache, protected configuration/journal/ledger and synthetic outputs remain local. No secrets, databases or raw configuration were committed.

This reuses prior per-Engine isolation evidence and adds the current-artifact synthetic lifecycle; it is not a new full qualification, high-load test or long outage experiment. Host partial/attended guarantees remain unchanged. Controller-offline hard expiry remains unsupported, and whole Tart Runtime FD-loss recovery remains unproven. No NAS/media job, Vesta integration, Windows/WSL validation, real Tart VM, power action or production deployment occurred.
