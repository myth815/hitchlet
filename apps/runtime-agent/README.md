# Linux Runtime Agent: Docker network and fixed storage facts

The `dist/main.js` entry point implements the D10b network boundary. The independent D20 native physical Host observation entry point is documented in [HOST.md](HOST.md); it requires no Docker socket and does not change this Runtime network deployment. Portainer creates and removes networks and containers. The Agent accepts four schema-checked actions (`network.ensure`, `inspect`, `revoke`, `remove`) and invokes fixed Docker/iptables argument vectors; there is no shell, command string, or caller-supplied interface in the protocol. The config schema, daemon startup, TLS client-certificate checks, and local Engine binding are defined in [`main.ts`](src/main.ts), [`server.ts`](src/server.ts), [`engine.ts`](src/engine.ts), and [`worker.ts`](src/worker.ts); treat those files as the field and behavior authority.

The supported Engine must report the Docker 29 `FirewallBackend.Driver=iptables`, expose `DOCKER-USER`, and run on the Linux host where the Agent can inspect the local daemon and its firewall rules. nftables-only Engines, remote TCP Engine endpoints, IPv6 allocation networks, dynamic host ports, and published IPv6 listeners fail closed. The host must already have `br_netfilter` loaded. If it is absent, stop deployment and have a host administrator handle module loading and persistence under that host's normal change policy; the Agent never loads modules, receives `SYS_MODULE`, or changes the global `net.bridge.bridge-nf-call-iptables` sysctl. It checks the module and each owned bridge's `nf_call_iptables` state; `ensure` and `revoke` enable/read back only that owned bridge's flag, while `inspect` only verifies it. If `br_netfilter`, the per-bridge flag, or its readback cannot be proven, that allocation is rejected. See [`engine.ts`](src/engine.ts) for the exact checks.

For each fully inspected allocation, `ensure` and `revoke` also disable and read back IPv6 only on that owned bridge; `inspect` only verifies the setting. Tenant containers must be created with both `net.ipv6.conf.all.disable_ipv6=1` and `net.ipv6.conf.default.disable_ipv6=1` in Docker HostConfig. No host-wide IPv6 setting or unrelated interface is changed. Docker network and container identity, bridge name/gateway, userland-proxy mode, and fixed published-port bindings are read from the local Engine before rules are installed. Userland-proxy traffic is covered by a host `INPUT` rule for the exact IPv4 binding; DNAT/routed traffic uses `DOCKER-USER`/`FORWARD`. Rules deny tenant-to-host access, same-bridge peer traffic, undeclared ingress and undeclared egress; explicit source/port ingress and destination/protocol/port egress are allowed. Management denies precede established-flow permits, and matching existing flows are removed before a policy update is acknowledged. The fixed firewall compiler and readback logic are in [`firewall.ts`](src/firewall.ts).

## Build and start

The Agent requires Node 24, the official Docker CLI 29, iptables commands, `conntrack-tools`, `iproute2`, the local Docker Unix socket, the host network namespace, and access to the Engine's `DOCKER-USER` chain. The [Dockerfile](Dockerfile) defines the image contents and pinned CLI default. Build only against an explicitly selected, isolated Linux Docker context; never rely on the caller's default context:

```sh
: "${HITCHLET_DOCKER_CONTEXT:?set a dedicated non-default Linux Docker context}"
docker --context "$HITCHLET_DOCKER_CONTEXT" build \
  -f apps/runtime-agent/Dockerfile -t hitchlet-runtime-agent:0.1.0 .
```

The Runtime Agent image runs as root inside its container because it must manage host firewall rules and write the narrow bridge IPv6 sysctl mount. It drops all Linux capabilities and adds only `NET_ADMIN`; it uses a read-only root filesystem and a separately persisted journal directory. The local Docker socket remains a full privileged control-plane channel even when mounted read-only at the filesystem level. Restrict it to this trusted management Agent; never expose the socket, host network, or Agent capabilities to tenant containers. Rootless/user-namespace configurations or socket/sysctl permissions that prevent exact local inspection and writes are unsupported and must fail closed.

```sh
node --version # must report v24.x
corepack pnpm --version # must report pnpm 10 or newer
```

The deployable image contains Node 24, official Docker CLI 29, iptables, `conntrack-tools`, and `iproute2`. Run it in the Linux Docker host's network namespace so Engine identity and bridge inspection refer to the same local daemon. The Agent reads userland-proxy mode from Docker 29's `FirewallBackend.Info.EnableUserlandProxy`, not from a guessed daemon default or an unmounted host config file. Do not bind-mount another `/proc` or `/sys` over container views. Mount only the host's `/proc/sys/net/ipv6/conf` at a dedicated writable target; this lets the Agent change IPv6 state on a fully verified allocation bridge while leaving unrelated interfaces untouched. If the host prevents writes, the operation fails before firewall changes.

Prepare a strict JSON config file using the fields and validation in [`main.ts`](src/main.ts): `host`, `port`, `installationId`, `runtimeIdentityId`, `nativeEngineId`, `agentId`, `dockerHost`, `ipv6SysctlRoot`, `journalFile`, `tokenFile`, `caFile`, `certFile`, and `keyFile`. The installation/runtime/agent IDs must match the controller's paired Agent; the configured native Engine ID must match the local Engine read through the Unix socket. For a Linux service set `dockerHost` to `unix:///var/run/docker.sock` and `ipv6SysctlRoot` to `/proc/sys/net/ipv6/conf`. The listener requires a trusted client certificate and an additional bearer token; see [`server.ts`](src/server.ts). Keep token and private key files root-readable only (mode `0600`), and pass only a non-secret config path through the service environment. Credentials are not accepted through argv, logged, or written to the journal.

Start it under a service manager with:

```sh
HITCHLET_RUNTIME_AGENT_CONFIG=/etc/hitchlet/runtime-agent.json node /opt/hitchlet/runtime-agent/dist/main.js
```

For an isolated Linux Engine host, an explicit-context container launch is:

```sh
: "${HITCHLET_DOCKER_CONTEXT:?set a dedicated non-default Linux Docker context}"
docker --context "$HITCHLET_DOCKER_CONTEXT" build \
  -f apps/runtime-agent/Dockerfile -t hitchlet-runtime-agent:0.1.0 .
docker --context "$HITCHLET_DOCKER_CONTEXT" run --detach --name hitchlet-runtime-agent --restart unless-stopped \
  --network host --pid=host --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  --cap-drop ALL --cap-add NET_ADMIN --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly \
  --mount type=bind,source=/proc/sys/net/ipv6/conf,target=/run/host-ipv6-conf,rw \
  --mount type=bind,source=/etc/hitchlet/runtime-agent,target=/run/hitchlet,readonly \
  --mount type=bind,source=/var/lib/hitchlet-runtime-agent,target=/var/lib/hitchlet-runtime-agent \
  hitchlet-runtime-agent:0.1.0
```

Create `/etc/hitchlet/runtime-agent/runtime-agent.json` with `journalFile` set to `/var/lib/hitchlet-runtime-agent/journal.json`, `dockerHost` set to `unix:///var/run/docker.sock`, `ipv6SysctlRoot` set to `/run/host-ipv6-conf`, and credential paths under `/run/hitchlet`. Set `host` and `port` to the controller-facing management interface and port; make the journal directory writable only to the Agent's container identity. Run these commands on the Linux Engine host, not on a workstation whose context merely points elsewhere. The Agent itself does not use Docker contexts: it passes the configured local Unix socket to Docker CLI and verifies the configured native Engine ID before every action.

The journal file is atomically replaced and fsynced after durable state changes. A corrupt journal or unsupported Engine prevents startup/action. The caller must create and inspect the dedicated bridge and stopped containers through Portainer, including stable allocation labels and fully allocated IPv4 host port bindings, before `ensure`; the Agent verifies them against the local Engine before installing rules. Start containers only after an `installed` result whose `rulesetHash` matches the plan. During cleanup, send `revoke`, stop/delete the containers and delete the bridge through Portainer, then send `remove`; the Agent checks its authenticated Engine for absence itself.

The controller side exports `buildRuntimeNetworkPlan`, `buildRuntimeNetworkCommand`, `hashRuntimeNetworkRules`, `readRuntimeNetworkCredentialFiles`, and `RuntimeNetworkHttpClient` from `apps/controller/src/providers/runtime-network-client.ts`. Application code should provide `loadCredentials()` backed by its versioned secret store; the file loader is only for explicit service deployments. Use a new `commandId` for a new command and retain the original command object for same-command retries. `expectedRulesetHash` is SHA-256 over the shared compiler's exact managed iptables argv material; `contentHash` is SHA-256 over the complete command with only its own field omitted.

## Explicit-context preflight

This read-only helper refuses the default Docker context and requires the expected native Engine ID on every run. It never changes Docker context or creates, starts, stops, or deletes resources:

```sh
export HITCHLET_DOCKER_CONTEXT='your-isolated-linux-context'
export HITCHLET_EXPECTED_ENGINE_ID='the-Engine-ID-you-independently-verified'
export HITCHLET_NETWORK_ID='the-dedicated-allocation-network-ID'
export HITCHLET_ALLOCATION_ID='the-allocation-ID'
./apps/runtime-agent/scripts/preflight-context.sh
```

Run that on the operator workstation before any manual lab command. All Docker commands, including build and run, must keep the explicit `docker --context "$HITCHLET_DOCKER_CONTEXT"` prefix. Do not use `docker context use`, the default context, or a command that omits the selected context. Replace the example context name and IDs with values from the isolated host; no lab-specific identity is part of this repository.

For a real published TCP port probe, configure an SSH-accessible allowed LAN client and a denied LAN client, then run `scripts/probe-published-port.sh` with `HITCHLET_ALLOWED_PROBE_HOST`, `HITCHLET_DENIED_PROBE_HOST`, `HITCHLET_PUBLISHED_HOST`, and `HITCHLET_PUBLISHED_PORT` set. The script reruns the explicit-context/Engine/network preflight and makes no Docker changes. Confirm the clients egress from the intended allowlisted and unlisted source addresses; hostnames alone do not prove source identity.

## Required real-network evidence

Unit tests exercise the rule compiler, persistent command replay, epoch/control-version fencing, ensure/revoke serialization, durable revoke tombstones, local-Engine rejection, and absence-gated remove. They do not prove packet isolation or constitute M1 acceptance. For the isolated target Engine, capture a before/after `iptables-save` snapshot and real probes for all of the following before recording a node as verified:

- An allowed source reaches the declared published TCP/UDP entry; an unlisted source cannot reach it.
- INPUT blocks tenant-to-host services, while FORWARD blocks an unlisted external destination and allows an explicitly granted NAS data protocol/port.
- A NAS management port on the same address is denied while its granted data port remains reachable.
- Adding a management deny terminates an already established matching flow as well as preventing new flows.
- The container cannot reach another container on the bridge, regardless of source allowlists.
- The bridge has IPv6 disabled in Docker network inspection and the live interface sysctl; probes over IPv6 fail.
- Docker and Agent restarts preserve the rules before workloads are allowed to start. Repeat the allow/deny and NAS probes after restart.

The real probes must originate from the actual allowed and denied LAN paths. A loopback-only probe, mocked Engine, successful API response, or preflight alone is not evidence of isolation. Keep the target context isolated from unrelated workloads; the Agent never flushes global firewall state and only manages its allocation-owned rules and jumps.


## D23 fixed storage and real image capacity

`POST /v1/storage-facts` uses the same mTLS and bearer boundary as network actions.
It returns fixed source evidence, actual DockerRootDir filesystem capacity, and
(optionally for takeover) installation-owned container/network/volume labels.
It has no mount/unmount/shell action and never creates a missing source directory.
Administrators pre-mount local/NFS/SMB roots on the **same Linux daemon host**.
Unsupported protocols, missing capabilities or absent mounts fail closed; simulator
facts do not attest real Docker storage.

Add `storageRoots` to the protected Agent config, e.g.:

```json
[
  {"sourceRef":"/srv/hitchlet/approved/local","protocol":"local","secretVersionRef":null,"mountPoint":"/srv/hitchlet/approved","mountSource":"/dev/actual-host-device"},
  {"sourceRef":"/srv/hitchlet/approved/nas","protocol":"nfs","secretVersionRef":"secret:00000000000000000000000000000000","mountPoint":"/srv/hitchlet/approved/nas","mountSource":"nas.example:/export/hitchlet"}
]
```

These are examples: obtain exact mount source/mountpoint from the deployed Agent
view; never guess the device. `sourceRef`, protocol and secret revision must
exactly match the immutable authorized storage profile. SMB uses protocol `smb`,
actual filesystem `cifs` and exact `//server/share` mount source. NAS authentication
is performed by the host's pre-mounted filesystem; Hitchlet does not interpolate
credentials into mount options. Its separate secret reference identifies that
approved mount credential version and must still be available before prepare.
Local profiles normally use null. Secret rotation requires explicit new mount/
profile/Agent static approval; it does not retarget frozen grants.

The Agent container requires `--pid=host` to compare `/proc/1/mountinfo` with
`/proc/self/mountinfo`, a same-absolute-path readonly `rslave` bind of the approved
parent, and a same-path readonly bind of the daemon's actual DockerRootDir. For
example add (only after preparing those host paths):

```sh
--mount type=bind,source=/srv/hitchlet/approved,target=/srv/hitchlet/approved,readonly,bind-propagation=rslave
--mount type=bind,source=/var/lib/docker,target=/var/lib/docker,readonly
```

Use the actual DockerRootDir, which may differ from `/var/lib/docker`. The host
parent must propagate unmount events; verify propagation during deployment. An
Agent overlay directory or wrong local bind cannot prove host source/capacity:
checks compare filesystem type/source, major:minor and mount-root-relative mapping
against host PID1. A legitimate host bind root such as `/docker` is allowed;
mount-root need not equal mountpoint. Self namespace IDs are excluded from frozen
evidence, so replacing the Agent container preserves evidence when the host mount
and source inode are unchanged. Actual host remount/source replacement invalidates
it and requires explicit reconciliation.

Approved root and every ancestor of a selected source must prevent the shipped
workspace uid1000 from renaming components. No symlinks are accepted; tenant-owner
write, group-write (including ACL masks) and world-write ancestors are rejected,
except root/admin-owned sticky parents protecting a non-tenant-owned next entry.
The selected source itself may be writable for an independent output grant.
Administrator changes remain trusted; these checks do not claim to eliminate all
TOCTOU races against a privileged host administrator. NFS/SMB server permissions
must honor this identity and prevent tenant parent replacement. Verify read-only
writes fail and a separate authorized output works with the actual deployed UID.

Persistent bind targets may nest under `/workspace/persistent`; `/workspace`
itself remains the per-allocation owned volume. Grants cannot overlap each other
or reserved control targets. Docker binds disable recursive submount inclusion
and use rprivate propagation; readback checks exact source/target/RW. Persistent
references are always manifest `reference`/`keep`, never destroy objects. Cleanup
removes the container before its temporary volume and never recursively visits
NAS paths. Missing/unmounted/replaced roots prevent preparation/readiness, while
cleanup and persistent source preservation remain possible.

To rotate Runtime control: prepare a new independent bearer secret, stop the
Agent, replace token/config atomically and restart with the same journal/Engine
identity; update the controller Node Runtime credential configuration. Old bearer
HTTP401/403 and new authenticated facts prove takeover; an epoch number or timeout
alone does not. Do not grant SYS_ADMIN for this storage protocol. D23 only reads
mount facts; host mount administration stays outside Hitchlet.
