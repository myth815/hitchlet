# Read-only Docker / native workload evidence

This internal Runtime API complements the existing physical Host Agent and shared
Machine ledger. It does not issue a shutdown permit and does not make a container,
WSL distribution or an empty Docker Engine equivalent to an idle physical host.

`POST /v1/workload-facts` uses the existing Runtime mTLS and bearer authentication.
The request contains only request/installation/Runtime/Engine/Agent identities.
There are no caller-supplied executable, shell, file, mount or network actions.
The response contains fixed container state/ownership fields, distribution boot
and namespace identities, bounded native PID/UID/executable/unit facts, retained
allocation and pending-command counts. It does not return argv, environment,
container environment, credentials or user file contents.

The Runtime serializes this observation with the same network lifecycle journal.
Missing or unknown command results, active/revoked allocation fences, stopped owned
container resources and active foreign containers prevent an idle result. Container
membership/state is read before and after the fixed projection; change means
incomplete evidence. Engine identity is verified on both sides of that read.
An exited process can disappear during collection; PID reuse and inaccessible
process facts remain unknown. A configured system service is background only when
its live MainPID, exact unit, executable and UID match. Its children are not
implicitly approved. Native programs outside this finite inventory remain held.

`nativeWorkloadContextFile` is optional and affects only workload evidence. Native
WSL startup must supply the distribution machine-id, kernel boot-id and PID
namespace from outside the Runtime container. The Runtime never seals that context
for itself. Missing, stale or different context produces unknown workload facts;
it does not prevent existing network/storage APIs or ordinary requests from
starting. A systemd-looking container is not sufficient proof of distribution-wide
visibility. The context is reread per observation so native startup can refresh it
without restarting the Runtime or its allocations.

The normal controller transport checks response identity, request nonce and a
five-second freshness limit. Contradictory `idle` responses fail schema validation.
Physical power still additionally requires the authenticated native Windows boot,
complete running-distribution coverage, native user/workload guards, all physical
Machine Claims and lifecycle operations settled, and fresh prepare/commit checks.
No unconditional WSL/vmmem exception has been installed.

## Native Windows / exact-user WSL observation

The Windows power agent can consume an owner-protected local receipt from the
existing distribution owner's scheduled startup task. This avoids adding a Docker
Runtime bearer token, TLS key or listener merely to observe physical-host work.
The task retains its original user/S4U principal and keeps the distribution running
through its original keeper command. No password is stored by this observer.

The System power agent verifies the producer's exact scheduled-task definition,
principal, live engine PID, native creation time, protected Node executable and
hash, plus coverage of every Windows WSL owner. Each receipt binds registered
distributions, native machine/boot/PID-namespace identities and all configured
Engines. The producer atomically replaces bounded receipts; failed observations
expire rather than publishing a fabricated empty result. Prepare and commit each
read and validate fresh facts. A user-owned distribution is not inferred absent
from System's separate HKCU registration view.

Known busy work is distinct from missing measurements. Complete busy evidence
retains the unmanaged-work hold and cannot authorize power. Unknown input/lock
state remains partial. Windows process reads are reconciled against a second
native snapshot: confirmed exits can disappear, but live unreadable processes,
PID reuse and newly appearing work keep evidence incomplete. Native Linux reads
also detect executable/PID identity drift and new PIDs. A finite service baseline
can identify only its real MainPID; child jobs remain ordinary work.

## Current verification boundary

On 2026-11-07, the original ComputeNode startup was normally restored and its
rootless and rootful Engines, RootlessKit namespace handle and native PID view were
measured. The original OpenClaw node, Portainer agent and Docker services were
preserved. The exact-user receipt producer and updated native PowerAgent are
running; the controller accepted their existing authenticated identity and fresh
observations. No new Runtime token, certificate, listener, network rule or principal
was created. The installed Hyper-V Runtime and its supervisor were not restarted
by the WSL observer rollout.

Current targeted checks include 131 Runtime tests, six pure reconciliation cases
on Windows PowerShell, native PowerShell parsing and real owner/Engine receipt
readback. These are observation/control-recovery results, not an idle shutdown or
ComputeNode Docker lease qualification. The retained authenticated network/storage
Runtime API is a separate deployment concern.

Physical shutdown remains unverified. A connected Windows console, existing WSL
login/work processes and the retained management container are still held. The finite nine-service and exact Portainer-init baseline is activated as described
below. Remaining rootless/OpenClaw processes and user sessions are still protected;
neither a publisher signature nor an arbitrary service descendant is enough to
claim idle. Do not stop those services to manufacture an idle acceptance result.

## 2026-11-07 paired background closeout

The paired native collector, original-user publisher, Windows guard and power
executor now share a hashed distribution/background binding. The installed minimum
baseline covers nine measured systemd service MainPIDs and one exact Portainer
management container. Its Engine, full container ID, image ID, native init PID,
creation ticks, UID/executable and container cgroup must match; a paused or
Hitchlet-owned allocation is never background. An exec child or another container
remains ordinary work. Image/PID/cgroup/policy drift remains unknown/held. The
publisher runs from the existing owner-protected user data directory and retains
its original S4U principal and privileges.

The residual Windows inventory failure was traced to new observer PowerShell and
conhost instances appearing after the initial walk. A bounded catch-up now reads
those instances with the same native identity rules as every other process. It
neither exempts observer descendants nor turns unreadable/new/reused instances
into idle. A finite diagnostic projection records residual PID/identity phases.
Both a candidate and an installed paired readback returned a complete Windows
inventory with no residual diagnostics. Existing console applications, user/WSL
sessions, OpenClaw/rootless processes and unreviewed device services still remain
protected. This confirms the two observation/classification fixes; it does not
qualify an occupied host or prove a physical shutdown.

## Windows session sampling and retained-login policy

The existing policy deliberately treats every interactive login as human presence,
even if locked or disconnected; the native power guard also requires no sessions.
Locking or merely ceasing input therefore does not qualify this policy for power.
This is independent of the older sampling defect that always emitted unknown lock
and input facts whenever a Windows session existed.

A prepared source change queries each session's WTSInfoEx level-1 Unicode record,
checks its session/state/principal binding, maps modern SessionFlags and validates
last-input/current timestamps. It never uses the service's GetLastInputInfo to
infer another desktop's input. The five-second recent-input observation is a
measurement window, not a new shutdown idle policy. Unknown/legacy/failed records
stay partial. Locked/disconnected/quiet logins remain present and block power.
This change passed controlled regression/type/build checks but is not installed or
natively verified: the user then explicitly requested a one-time Windows shutdown.

That separate, explicitly authorized shutdown included force-closing applications.
The OS accepted one command and the existing SSH/Runtime/ICMP endpoints went
unreachable. It is recorded as a manual exception, not an automatic qualification,
and did not change normal guard rules or issue WOL. No current meter was configured,
so no stale wattage sample is presented as a physical power measurement.

Remaining rootless/OpenClaw process identity is known but complete in-process work
state is not. A daemon MainPID, empty container list or low CPU cannot independently
prove no pull/build/request/node command. Those roles are still held. The source
also fixes selecting the original user's systemd manager when a root native observer
checks a user service; it does not grant that service a new background exemption.

## Exact keeper and finite infrastructure roles

An optional `keeper` policy replaces the legacy sleep keeper with a fixed native
helper. The existing owner starts it through its own private child stdio. Its
first report binds the Linux PID, start identity, boot, namespace, executable and
helper identity. Stdin carries no commands or nonce protocol: EOF normally ends
that helper. The collector independently checks the instance and its two WSL
relay parents before classifying exactly those three PIDs as infrastructure.
Another sleep, Node process, relay, child task or changed instance remains work.
Old bindings remain readable; the legacy sleep is not silently approved.

Optional management roles cover only measured WSL base processes, systemd PAM and
udev helpers under registered MainPIDs, the exact unattended-upgrade shutdown
waiter, and the original rootless Docker plumbing. System service MainPIDs still
require exact unit, executable and UID. A root observer queries a configured user
service through that user's manager, rather than root's unrelated user bus.
User-owned rootless tools retain their existing ownership and permissions.

Container infrastructure is anchored to the registered Engine, container ID,
image, native init and cgroup. The shim and proxy checks additionally bind their
actual parent, arguments, ports, addresses and namespaces. With RootlessKit
`--detach-netns`, a proxy belongs to the registered inner RootlessKit namespace;
it need not share dockerd's namespace. Nonempty retained `ExecIDs` prevent shim
and proxy approval; they are not reported as an exact count of running execs.
Other containers and native task PIDs remain visible and held.

Artifact hashes are checked during normal policy registration. Observations check
the registered file identity and process instance on both sides of the read. A
large Node binary is hashed once for keeper-start provenance, rather than read
again on every two-second observation. No listener, bearer, service account or
host network change is added. Existing user-owned tools keep their ownership;
fixed observer/helper assets retain the protected installation model. Policy
changes are included in the existing binding and executor hashes.

The source has controlled role, identity-drift, child-work and EOF regressions.
The task also retained separate real Windows-to-WSL keeper/EOF and management
readbacks. An earlier process-set race and a test preparation error are retained
as unsuccessful evidence, not combined into an invented single all-pass run.
Normal production publisher/guard pairing and fresh readback remain necessary;
these facts do not constitute an automatic-shutdown qualification.

OpenClaw's generic invocation and cleanup lifecycle is a separate owner boundary.
Its service PID, low CPU, catalog `active` flag or empty child list does not prove
that accepted work has settled. This policy does not approve arbitrary OpenClaw
processes, pretend to perform a software update, or stop the service to manufacture
idle. Normal physical power requires complete, fresh work evidence and the usual
user, Claim, lifecycle and prepare/commit protections.
