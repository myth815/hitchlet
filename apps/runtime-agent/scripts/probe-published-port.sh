#!/bin/sh
set -eu

: "${HITCHLET_DOCKER_CONTEXT:?Set the dedicated Docker context explicitly}"
: "${HITCHLET_EXPECTED_ENGINE_ID:?Set the reviewed native Engine ID}"
: "${HITCHLET_NETWORK_ID:?Set the dedicated allocation network ID}"
: "${HITCHLET_ALLOCATION_ID:?Set the allocation ID}"
: "${HITCHLET_INSTALLATION_ID:?Set the installation ID}"
: "${HITCHLET_RUNTIME_ID:?Set the runtime identity ID}"
: "${HITCHLET_ALLOWED_PROBE_HOST:?Set an SSH host whose real source IP is allowlisted}"
: "${HITCHLET_DENIED_PROBE_HOST:?Set an SSH host whose real source IP is not allowlisted}"
: "${HITCHLET_PUBLISHED_HOST:?Set the IPv4 published host address}"
: "${HITCHLET_PUBLISHED_PORT:?Set the fixed published TCP port}"

case "$HITCHLET_PUBLISHED_HOST" in
  *[!0-9.]*|'') echo "Published host must be an IPv4 address" >&2; exit 2 ;;
esac
case "$HITCHLET_PUBLISHED_PORT" in
  *[!0-9]*|'') echo "Published port must be numeric" >&2; exit 2 ;;
esac
if [ "$HITCHLET_PUBLISHED_PORT" -lt 1 ] || [ "$HITCHLET_PUBLISHED_PORT" -gt 65535 ]; then
  echo "Published port is out of range" >&2
  exit 2
fi
case "$HITCHLET_ALLOWED_PROBE_HOST$HITCHLET_DENIED_PROBE_HOST" in
  *[!A-Za-z0-9_.@-]*) echo "Probe SSH hosts contain unsupported characters" >&2; exit 2 ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$script_dir/preflight-context.sh" >/dev/null

probe() {
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$1" \
    nc -z -w 5 "$HITCHLET_PUBLISHED_HOST" "$HITCHLET_PUBLISHED_PORT"
}

if ! probe "$HITCHLET_ALLOWED_PROBE_HOST"; then
  echo "FAIL: allowed-source probe could not reach the published port" >&2
  exit 1
fi
if probe "$HITCHLET_DENIED_PROBE_HOST"; then
  echo "FAIL: unlisted-source probe reached the published port" >&2
  exit 1
fi
printf '%s\n' \
  "PASS: allowlisted and unlisted source probes behaved as expected" \
  "Confirm both SSH probe hosts egress from the intended real LAN source addresses."
