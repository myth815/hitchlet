# `hitchlet-node-ssh-v1` Docker recipe

This directory is the fixed Node 24 SSH bootstrap image recipe consumed by the current Portainer Provider. The recipe is intentionally narrow: a fresh container creates its own SSH host keys, accepts a per-allocation public bootstrap key for the `workspace` account, and exposes only SSH on container port 22. It is not a general image-build framework or proof that a node is safe to rent.

Build from the repository root with this directory as the build context:

```sh
: "${HITCHLET_DOCKER_CONTEXT:?set a dedicated non-default Linux Docker context}"
docker --context "$HITCHLET_DOCKER_CONTEXT" build \
  -f docker/node-ssh-v1/Dockerfile \
  -t hitchlet-node-ssh-v1:local docker/node-ssh-v1
```

For an isolated Engine, make the Docker context explicit on every Docker command, including build, push, and inspection. Register the resulting image as a draft artifact through the controller's image workflow, then verify and pin its immutable registry digest and platform. The consumer/Provider contract accepts only `hitchlet-node-ssh-v1`, contract version `1`, `identityReset=true`, SSH on port 22, account `workspace`, Portainer published-port discovery, and authenticated SSH host-key fingerprint readiness. See [`docker-recipe.ts`](../../apps/controller/src/domain/docker-recipe.ts) and [`assertNodeSshRecipe`](../../apps/controller/src/providers/portainer-provider.ts) for the current authority; other bootstrap methods, ports, arbitrary mounts, and protocols are rejected.

## Runtime identity and access

The build removes any SSH host-key files inherited from the base image. On a newly created container, [`entrypoint.sh`](entrypoint.sh) runs `ssh-keygen -A` and starts `sshd`; thus each allocation gets a distinct host identity from its own container filesystem. A restart of that same container keeps its identity, while a newly created allocation must be fingerprinted and verified again. Do not bake shared private SSH host keys into an image or reuse a host-key fingerprint as an allocation identity.

The Provider uploads the bootstrap public key through Docker’s archive API to `/run/hitchlet/authorized_keys`; at startup it is copied to `/workspace/.ssh/authorized_keys` with owner-only permissions, and removed from the bootstrap path. Root login, password and keyboard-interactive authentication, forwarding, tunnels, and user environments are disabled. SSH accepts only the `workspace` account. The SSH daemon's privileged master process starts as root, but authenticated sessions run as the non-root `workspace` user. The Provider probes `id -un`, Node's major version, and write access to `/workspace`; see its `probeSsh` implementation in [`portainer-provider.ts`](../../apps/controller/src/providers/portainer-provider.ts).

The Provider creates a separate writable named volume mounted at `/workspace` for each allocation; this is the default per-tenant workspace. An allocation may also request an explicitly granted persistent storage profile, whose fixed source/revision, container target, and read-only/read-write mode are checked against the profile and mounted as an additional bind mount. The contract can express local, NFS, and SMB profiles; current real evidence covers local and NFS 4.2 only, so other protocols require per-Node testing before they are promised. Profiles use configured roots and do not allow arbitrary host paths, Docker sockets, host networking, or user-supplied mount options. Existing service data must use an authorized profile rather than being added to the image or workspace volume.

## Container security contract

The Provider sets `Privileged=false`, `CapDrop=["ALL"]`, and adds exactly these seven capabilities:

```text
CHOWN DAC_OVERRIDE FOWNER SETGID SETUID SYS_CHROOT NET_BIND_SERVICE
```

It also sets `no-new-privileges:true`, enforces the frozen CPU/memory limits, and disables IPv6 in both `net.ipv6.conf.all` and `net.ipv6.conf.default`. Only the allocated host TCP port is bound to container port 22. Authorized storage profile mounts are checked separately against their frozen grant and exact target/mode. These settings and readback checks are in [`containerMatchesFrozen`](../../apps/controller/src/providers/portainer-provider.ts). Keep this capability list synchronized with that implementation; do not add broad capabilities or privileged mode to make a workload pass.

This recipe does not support arbitrary startup commands, user accounts, protocols or exposed ports, arbitrary persistent host paths, multiple network attachments, host networking, IPv6, offline lease enforcement, or unverified resource guarantees. On removal, the per-allocation workspace volume follows its documented cleanup lifecycle; explicitly granted external storage sources and outputs are not deleted by container removal. Unknown or mismatched mount boundaries fail closed. A successful SSH probe validates bootstrap identity and basic workspace usability only; real Engine, network isolation, resource enforcement, storage, and lifecycle acceptance remain separate checks.
