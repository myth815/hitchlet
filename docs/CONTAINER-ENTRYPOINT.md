# Container entrypoint leases

The Portainer backend supports a fixed `hitchlet-container-entrypoint-v1`
recipe for containers that need no interactive inbound endpoint. Existing
`hitchlet-node-ssh-v1` artifacts and omitted-access requests retain their SSH
semantics. Register a new immutable artifact for this recipe; existing frozen
Tickets are unchanged.

Use this bootstrap/access metadata through the normal image registration,
validation, cleanup and publication workflow:

```json
{
  "bootstrap": {
    "mechanism": "hitchlet-container-entrypoint-v1",
    "contractVersion": "1",
    "identityReset": true
  },
  "access": {
    "accessProtocols": [],
    "ports": [],
    "account": "workspace",
    "allowedSourceCidrs": [],
    "discovery": "none",
    "readiness": "container-running"
  }
}
```

For subsequent version/artifact registration, place `bootstrap` inside the
existing `requirements` object. The consumer's ordinary acquire request must
explicitly contain `"access": {"protocol": "none"}`. No extra Node access
capability or manual approval is introduced for the absence of an endpoint.
The matching, quota, capacity, network and storage qualification checks remain.

The provider preserves the image ENTRYPOINT, uses no extra command arguments,
and runs this recipe as UID/GID 1000:1000, verified in Docker readback.
Prepare startup configuration through existing authorized storage mounts before
acquire; for example, map approved project and home subdirectories to `/work`
and `/persist/home`. The image entrypoint reads the consumer's existing startup
file there. Workload clients belong in the immutable image. Persistent private
keys stay in the approved mounted home, outside images, API input and logs.
Hitchlet does not interpret the consumer's control-session configuration.

The provider starts the container and verifies its running state, frozen image,
resource limits, mount sources and authenticated network readback. It creates no
SSH material, uploads no authorized_keys, publishes no port and executes no SSH
probe. `ready` and `bootstrapComplete` describe resource delivery, not consumer
registration, Git progress or application health. Owner claim and renewal use
the existing lease API and do not wait for an external session to connect. An
exited container does not satisfy `container-running` readiness.

`getAccess` returns HTTP409 with `error.code=access_not_applicable` for a claimed
no-access Ticket. It returns no endpoint or authentication material. The
ordinary inventory and completed cleanup proof still account for all receipt
entries and expose only the three owned resources. Persistent references are
detached, never destroyed. The proof continues to report I/O and whole-scope
write exclusion as unknown.

Consumer session shutdown is independent of resource cleanup. A session closing
does not release capacity; a failed session unregister is not a cleanup gate.
The owner releases through the ordinary API after handling its data, and
Hitchlet verifies network revocation and owned-object absence before releasing
capacity. Approved persistent home and project data remain.

The Runtime network envelope already accepts zero published ports. This recipe
does not change firewall rules or add egress grants. Outbound clients need the
existing approved destination/protocol/port grants. Unmarked egress retains its
forwarded-only behavior. Explicit same-host destinations use the normal profile
with `destinationScope: "host"`; see [Host egress](HOST-EGRESS.md). This does not
grant network access merely by selecting the entrypoint recipe.
