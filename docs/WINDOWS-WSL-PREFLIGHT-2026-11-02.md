# Windows/WSL Runtime preflight evidence — 2026-11-02

## Result

This was a bounded, synthetic container smoke test on a Windows 11 Pro for Workstations host (build 26200) using WSL2, Linux amd64, kernel `6.18.54.1-microsoft-standard-WSL2`. Docker was 29.9.1 in rootless mode with cgroup v2 and systemd; `br_netfilter` was present. Docker reported `MemoryLimit`, `SwapLimit`, `CpuCfsPeriod`, `CpuCfsQuota`, and `PidsLimit` as available, with cpuset and `io.*` limit warnings. These metadata are observations, not qualification evidence.

This test issued no formal Hitchlet request or Claim and did not deploy an authenticated Runtime Agent. This test does not grant Windows/WSL a Hitchlet Engine or Host qualification.

## Verified in the smoke test

- A locally owned synthetic container used the official `docker.io/library/node` multi-architecture image at index digest `sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`, explicitly selected as `linux/amd64`; it reported Node `v24.22.2` and UID 1000.
- The test used a newly created protected directory on the E: ComputeNode ext4 VHDX. D: and F: were not accessed. The container had `network=none`, read-only root filesystem, all capabilities dropped, `no-new-privileges`, and a tmpfs for writable output.
- Inside the container, `cpu.max` was `50000 100000`, `memory.max` was `536870912`, `memory.swap.max` was `0`, and `pids.max` was `128`. Writing to the kernel read-only mount returned `EROFS`.
- The 18-byte synthetic input `b'hitchlet-smoke-v1\n'` had SHA-256 `c67d92a12e4f622af7ce861f5406876e69fd5eed9edbdd0af89e0f0f79137c91`; its final hash was unchanged. A temporary `/work` output was read back into a protected local result file. Its SHA-256, `d2dc243410c5146a333115ed766cd75cce59d318333a278b9e392d497f3da9e3`, matched the container receipt.
- Two short-lived owned probe containers were created cumulatively, with at most one running at a time. After the first container's tmpfs output could not be retrieved with Docker `cp`, it was ownership-cleaned and the readback method was corrected to controlled `container exec`; the successful retry retained the same isolation. Both containers are now absent, and an ownership-label query returned no matches. No custom network or volume was created; the pre-existing `portainer_agent` remained running.

The official Node image cache, synthetic input/output, and protected test receipt were retained. Earlier Windows transfer retries failed before container creation; they were not container isolation failures. A maintenance wrapper completed login without unlocking an old private key, creating new long-lived credentials, changing Windows security settings, or performing power operations.

## Not verified / remaining qualification work

This did not exercise Hitchlet's formal request, Claim, SSH, renew, or release flow, and produced no Node qualification report. It did not test source CIDR policy, egress allowlists, or host, management, and peer isolation; `network=none` does not cover those boundaries.

The known `docker0` bridge was visible, but the unprivileged WSL user received `permission denied` from `iptables -S DOCKER-USER`; a `nsenter` attempt was also unavailable. This does not establish that a correctly deployed Agent could never inspect the required rules. The standard Runtime Agent configuration path was unreadable or not found, and an authenticated Runtime Agent was not confirmed.

The next qualification step needs an authorized Runtime Agent with `NET_ADMIN` in the correct Engine and network namespace, plus hooks limited to an owned allocation in `INPUT` and `DOCKER-USER`. It must verify each existing qualification condition against that allocation. No privilege escalation, firewall rule writes, service installation, or new long-lived identity was performed here. If those additional permissions or host rule changes are needed, obtain explicit authorization first; do not switch to rootful mode solely because of the mode label.

Windows and WSL remain without formal Hitchlet qualification.
