# Studio ARM release candidate preparation

This note separates the isolated StudioARM evidence collected on 2026-11-02 from this source revision. It is a preparation record, not a release or a new acceptance report.

2026-11-03 update: the explicit build-write authorization succeeded; the Colima label was diagnosed as a sandbox metadata-read failure, and one current-candidate real lifecycle completed with cleanup. Exact artifacts, the startup compatibility fix, evidence and limits are in [the candidate acceptance receipt](STUDIO-ARM-RC-2026-11-03.md). The preparation constraints below describe the earlier checkpoint and the procedure for future candidates.

## 历史准备检查点（下方不是当前实时阻塞）

截至2026-11-04，构建授权、Colima恢复与多次实际闭环已有后续结果；当前跨消费者入口见 [消费者接入现状](CONSUMER-READINESS.md)。下方保留早期准备和被拒构建的历史，不能据此认定当前仍 Broken、Tart guard 仍关闭或要求重新执行旧验收。Go 兼容包的基础 revision + 单点补丁及文件摘要属于明确记录的派生候选；不得将它冒称原始0039，也无需为了一个 SSH 修正强制升级全部 SDK/API。新发布应按实际变更验证配套兼容性。

## What the evidence establishes

The 2026-11-02 isolated Studio Engine run exercised the `colima-hitchlet-studio-acceptance` context and the `hitchlet-studio-acceptance` profile. Its Colima VM was configured for 6 CPUs and 8 GiB; the default Docker context was not changed. The report covered an isolated Engine/profile, pinned artifact digest, real SSH, renew, output persistence/hash, release proof, and reclamation. It did not use NAS media. The latest acceptance stack was stopped after the run. These results describe that recorded environment and source only.

The recorded Engine is `98531c12-2a3b-4ed6-82c3-08abfb8120a4`; the synthetic tenant image is pinned to `sha256:5cf584cab167af0b6a3dc2271809657d4c6368270f356e1a079031493f321a86`. Reuse unchanged, still-valid evidence instead of rebuilding that tenant image solely for a control-plane release. See the [real container acceptance](STUDIO-REAL-ACCEPTANCE-2026-11-02.md), [reliability evidence](STUDIO-RELIABILITY-2026-11-02.md), and [real SSH adapter receipt](STUDIO-SSH-ADAPTER-REAL-2026-11-02.md) for their exact scope and recorded deadlines.

The 2026-11-03 read-only check still found that dedicated profile: `colima list --json` reported `Broken`, while `colima -p hitchlet-studio-acceptance status` reported `is not running`. This establishes that it is not currently running; the cause of the `Broken` label was not diagnosed. No start, repair, or recreation was attempted. Resolve its readiness before scheduling the real candidate acceptance rather than assuming the retained installation can already resume.

Preparation baseline `245d6bf` and the upcoming source changes have not been built or retested as a release. A package version such as `0.1.0` does not identify a release by itself. A candidate must pair Controller, GUI, Runtime Agent, native Host, SDK, and contracts from the same Git revision. Record the actual platform, base-image identities/digests, resulting image digests, and exported archive hash after a future authorized build; do not infer them from tags or this document. Retain the native Host artifact with its built `runtime-agent` entry point. A Linux Runtime container is not a replacement for that Host artifact.

## Build boundary

The current build attempt stopped at TypeScript `TS5033` / `EPERM` while writing `packages/contracts/dist`; the escalated retry was denied by automatic review. The repository is outside the selected execution environment's writable roots. File attributes were normal and no active hooks were found. Do not work around this with permission changes, a new output directory, a copied checkout, or another build route. Resume only when the platform grants recognized write access to the repository/output path and a materially new approval or execution context permits the build.

The Dockerfiles now use the existing project Node `24.22.0` base version consistently. Their final images accept the optional `HITCHLET_BUILD_REVISION` OCI revision label; an unset value remains `unknown` and is not release provenance. The Runtime-specific Docker ignore file explicitly excludes environment files, database state, data, secrets, keys, and generated output because Dockerfile-specific ignore rules govern that build context. No image has been built from these edits.

The paired local SDK entry is `node scripts/prepare-sdk-pair.mjs /absolute/empty/output`; it requires successful, fresh contracts and SDK builds first. The [consumer installation guide](../packages/sdk/examples/README.md#install-the-sdk-in-a-separate-consumer-project) covers exact local tarballs, archive hashes, and the package-name import smoke. That flow has only synthetic packaging evidence in this batch; neither real SDK archives nor a clean consumer installation have been produced.

The source-only distribution regression entry is `node --test scripts/sdk-pair.test.mjs`; its temporary packages and archives are fixtures, not Hitchlet release artifacts.

## Future candidate build and acceptance

Proceed only after build authorization and a clean, reviewed source revision:

1. Build the Controller/GUI and Runtime images for the recorded target platform, passing the same full Git revision as `HITCHLET_BUILD_REVISION`. Build the native Host package from that revision and keep its `runtime-agent` entry point. Do not publish or deploy during preparation.
2. Record the source revision, toolchain, target platform, base image references and resolved digests, image digests, native Host artifact identity, and exported archive SHA-256. Inspect both final images for the revision label and confirm the packaged application versions, while treating package versions as secondary metadata.
3. Use only the isolated `colima-hitchlet-studio-acceptance` context and `hitchlet-studio-acceptance` profile. Confirm the current Engine identity, zero pending Claims, a current capability report, and valid authorized mounts and network evidence before any synthetic workload. Check the report deadline and re-test only conditions whose evidence is expired or otherwise stale. Do not change the global Docker context.
4. Confirm the Host is explicitly partial and use only its bounded attended budget. Check the available-memory-derived pressure against the recorded 90% threshold. Read back the effective 500m CPU / 512 MiB synthetic allocation limits. Verify the intended mount sources and permitted network path from current authenticated evidence.
5. Run one synthetic 18-byte input case: acquire, wait ready, claim, verify real SSH, renew, write and hash the output, release, then confirm the release proof and Claim count returns to zero. Do not involve NAS media, pressure testing, real VM/Tart, or offline hard-stop claims. Offline enforcement remains unsupported and the Tart guard remains closed.
6. If a create is deliberately slow or interrupted, exercise only the targeted cleanup/restart recovery path and wait for deletion to be confirmed before checking Claim release. At the end, restore only this owned acceptance stack to its declared stopped, retained state; leave unrelated services untouched.

A release record is complete only after that newly built candidate and its exact paired artifacts pass this scoped acceptance. This guide does not authorize a build, deployment, external network use, or credential handling; reuse an existing authorized credential and journal path only under separate explicit deployment approval.

## 2026-11-05：镜像发布与正常容量预留

真实 `file0.3.6-mcp0.3.2` 验证通过后，JAV 的正常容量预留递增了同节点的 CAS version，导致旧服务把配置未变的报告拒绝为409；本次通过一个自然任务边界的短窗口完成正常验证/发布，旧成功报告和所有旧版保留，未改线上包或重启服务。

源码现在以已验证的 capabilities、runtime config、provider evidence、制品/网络/存储修订及有效期决定报告能否复用，不再将历史 `snapshot.nodeVersion` 当作配置身份。提交事务仍使用**本次读取的** Node.version 做CAS，运行时探测期间发生的变更会拒绝提交，重新读取后可重试发布，无须为了普通预留重跑镜像验证。能力、配置、权限及制品变化仍不能复用旧报告。

13项针对性回归与controller标准构建通过，覆盖纯version递增、真实配置/能力变化、探测时预留竞态、有效期/撤销及制品/live版本校验。这是源码修复；当前保留的0039兼容服务未切换，后续应在正常协调窗口升级，不能声称线上已消除此409。
