#!/bin/sh
set -eu

: "${HITCHLET_DOCKER_CONTEXT:?Set the dedicated Docker context explicitly}"
: "${HITCHLET_EXPECTED_ENGINE_ID:?Set the previously reviewed Engine ID}"
: "${HITCHLET_NETWORK_ID:?Set the dedicated allocation network ID}"
: "${HITCHLET_ALLOCATION_ID:?Set the allocation ID}"
: "${HITCHLET_INSTALLATION_ID:?Set the installation ID}"
: "${HITCHLET_RUNTIME_ID:?Set the registered runtime identity ID}"

if [ "$HITCHLET_DOCKER_CONTEXT" = "default" ]; then
  echo "Refusing the default Docker context" >&2
  exit 2
fi

engine_id=$(docker --context "$HITCHLET_DOCKER_CONTEXT" info --format '{{.ID}}')
if [ "$engine_id" != "$HITCHLET_EXPECTED_ENGINE_ID" ]; then
  echo "Refusing unexpected Docker Engine identity" >&2
  exit 3
fi

firewall_backend=$(docker --context "$HITCHLET_DOCKER_CONTEXT" info --format '{{.FirewallBackend}}')
if [ "$firewall_backend" != "iptables" ]; then
  echo "Refusing unsupported Docker firewall backend" >&2
  exit 4
fi

network=$(docker --context "$HITCHLET_DOCKER_CONTEXT" network inspect \
  --format '{{.Id}}|{{.Name}}|{{.Driver}}|{{.EnableIPv6}}|{{index .Labels "io.hitchlet.installation"}}|{{index .Labels "io.hitchlet.runtime"}}|{{index .Labels "io.hitchlet.allocation"}}' \
  "$HITCHLET_NETWORK_ID")
expected_prefix="$HITCHLET_NETWORK_ID|"
case "$network" in
  "$expected_prefix"*) ;;
  *) echo "Refusing network ID mismatch" >&2; exit 5 ;;
esac
old_ifs=$IFS
IFS='|'
set -- $network
IFS=$old_ifs
if [ "$3" != "bridge" ] || [ "$4" != "false" ] || \
   [ "$5" != "$HITCHLET_INSTALLATION_ID" ] || [ "$6" != "$HITCHLET_RUNTIME_ID" ] || \
   [ "$7" != "$HITCHLET_ALLOCATION_ID" ]; then
  echo "Refusing network with unexpected driver, IPv6, or ownership labels" >&2
  exit 6
fi

printf '%s\n' "Dedicated Docker context verified: $HITCHLET_DOCKER_CONTEXT" \
  "Native Engine ID verified: $engine_id" "Firewall backend verified: iptables" \
  "Allocation network verified: $HITCHLET_NETWORK_ID"
