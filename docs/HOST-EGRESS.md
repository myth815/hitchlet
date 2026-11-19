# Explicit Docker host egress

An ordinary network profile may explicitly authorize tenant-initiated TCP
connections to services on the selected Docker host. Use a new immutable profile
revision and the existing consumer authorization and frozen grant workflow:

```json
{
  "allowedEgress": [
    {
      "cidr": "203.0.113.10/32",
      "protocol": "tcp",
      "ports": [8443],
      "destinationScope": "host"
    },
    {
      "cidr": "203.0.113.11/32",
      "protocol": "tcp",
      "ports": [22],
      "destinationScope": "host"
    }
  ],
  "allowedIngressSourceCidrs": [],
  "ipv6": "disabled"
}
```

These are documentation addresses and example ports, not a usable deployment
configuration. Replace them only with the separately approved endpoints. Host
scope requires a single explicit IPv4 `/32`, TCP and a nonempty list of numeric
ports 1–65535. Wildcards, unspecified `0.0.0.0`, DNS names, broader subnets, IPv6
and UDP are not accepted for host scope.

Omitting `destinationScope` keeps the existing forwarded-only behavior. Explicit
`"forward"` is equivalent for generated rules. Neither option permits host INPUT.
No default field is inserted into old profile data or frozen plans. Empty egress
continues to deny tenant-initiated connections. Existing SSH recipe and frozen
lease behavior remain; choosing the entrypoint recipe alone grants no egress.

Host entries are frozen with their profile revision and preserved through the
resolved provision contract and the authenticated Runtime network command. They
are supported by Docker; VM acquire/validation does not reinterpret them as
forwarded or trusted-NAT grants. They
compile only into the allocation's private INPUT chain. Each rule matches that
allocation bridge, source subnet, exact destination, TCP and destination port.
A host-scoped destination does not also create a FORWARD permission. An address
that actually routes off-host therefore does not gain access from a host grant.

Management denies remain first, including before established traffic. Active
host grants then allow only their explicit tuples. Revoke replaces these with
tuple-specific DROP before the legacy gateway reply allowance, so an established
connection to a granted gateway service is also refused. Existing quarantine,
conntrack flushing, exact rule/hash readback, durable revoke tombstone and owned
hook/chain removal remain in force. No global INPUT/OUTPUT policy is changed.

Rebuild and pair Controller and Runtime with the same contracts package. The
Runtime TypeScript executor is unchanged, but its shared rule compiler/schema
changes and must be included in the Runtime image. Rebuild SDK for the admin
profile input schema. Older Runtime schemas reject the new field; do not mix
components or strip the field as a fallback. No database schema migration or
automatic profile/old-lease rewrite is needed. Older unmarked plans retain their
exact generated rule hashes.

This implementation does not publish ports, start a host service, alter its
binding/TLS/Git policy, override management denies or configure a live profile.
The host address must route to the selected host and the approved service must
listen there. These remain real deployment facts to verify. Synthetic tests of
the compiler, transport, journal and in-memory firewall are not live reachability
or real Docker acceptance.
