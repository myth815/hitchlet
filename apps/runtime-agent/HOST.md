# Physical Host observation role (D20)

The existing package has two independent entry points. `dist/main.js` remains the Linux Docker network Runtime Agent. `dist/host-main.js` is a native physical Host observer for macOS, Windows and systemd Linux. The Host entry point does not import the Engine, firewall or Runtime server and needs no Docker socket, Docker CLI, inbound listener, VM tools or power permissions. Its only network action is outbound HTTPS to the controller. It never executes shutdown, sleep, WOL, smart-plug, lease-stop or arbitrary shell commands. Strict offline lease enforcement remains `false`/unsupported; no guard ACK is generated.

Build with Node 24 and `pnpm install --frozen-lockfile && pnpm build`. Copy the built workspace with its production dependencies to an administrator-owned location, such as `/opt/hitchlet` or `C:\Program Files\Hitchlet`. Preserve `apps/runtime-agent/dist/host-windows.ps1` beside the JavaScript entry point. The script is copied by the package build. Pin the deployed build and keep program/script files unwritable by the observing account.

## Pair and enroll

1. On the intended **physical host OS**, run `node apps/runtime-agent/dist/host-main.js identity`. This generates a local installation UUID, not a hardware attestation or a username. Record it in the Host config as `hostIdentity`.
2. A full-scope administrator registers the corresponding Machine with its actual OS/architecture and calls `POST /v1/agents/pairings` with `{ "machineId": "<uuid>", "hostIdentity": "<local uuid>", "reason": "Install physical Host observer" }`. Save the **entire** JSON response directly to a protected pairing file. The receipt contains installation/Agent/Machine IDs and a five-minute, single-use token; it must not go to application logs or source control.
3. Create a protected config file (`0600` on Unix, restricted Windows ACL). Example:

```json
{
  "controllerOrigin": "https://controller.example.test",
  "hostIdentity": "00000000-0000-4000-8000-000000000001",
  "bindingFile": "/etc/hitchlet/host-binding.json",
  "pairingFile": "/etc/hitchlet/host-pairing.json",
  "caFile": "/etc/hitchlet/controller-ca.pem",
  "intervalMs": 10000
}
```

Use Windows absolute paths on Windows. `caFile` is optional when the controller certificate chains to the system trust store. Configure an HTTPS reverse proxy for the existing controller; Host TLS validation cannot be disabled. Only an HTTPS origin is accepted: no URL credentials, path, query or redirect. Requests have a total 15-second deadline, including a stalled or continuously streaming response.

4. Set `HITCHLET_HOST_AGENT_CONFIG` to the config file and run `node apps/runtime-agent/dist/host-main.js enroll` once. The command explicitly selects the enrollment DTO from the full receipt, verifies the actual local OS/architecture, and stores the returned Host credential through an exclusive temporary file, fsync and atomic rename (`0600` on Unix). It prints only `Host enrollment stored`; credentials are never echoed. It refuses to overwrite an existing binding.
5. Remove the consumed pairing file from the machine. The running service only needs the config, binding and trust file. Protect these and the parent directory against modification by other users. Windows permissions must restrict the config, binding, pairing file and temporary enrollment files to the installer and service identity; Unix mode checks are enforced by the CLI. Start the selected native boot service below.

Pairing is an administrative assertion that this installation is on the registered physical host, not inside Docker, WSL, a VM or a guest SSH namespace. The UUID is bound to the one-time token, Machine, installation, OS and architecture at enrollment. Native virtualization probes add negative evidence; they do not provide cryptographic hardware attestation, and spoofed/nested virtual environments require administrator review. Never pair a guest to represent the enclosing physical Machine.

## Recovery, rotation and observation semantics

The controller stores only SHA-256 hashes of pairing tokens and independent `hch_` Host credentials. Consumer/admin `hcl_` tokens and the D10b Runtime network credential cannot authenticate Host heartbeat/session routes. Host credentials cannot log into consumer/admin routes. Registration summaries exclude tokens/hashes; enrollment and pairing responses are `no-store`.

At startup a Host reads `/v1/agents/{id}/session` with its own credential, then starts a fresh random process `bootId` using the returned controller/session epochs and CAS. A competing boot loses CAS. Historical boot IDs can never be revived, including after controller restart. A running Host automatically queries its own session and starts a new fenced boot when the controller epoch increases. A sender fenced by another Host process in the same controller epoch exits; it does not fight for ownership. Every controller serving process increments the epoch, including observation-only `disabled` mode. Opening a ledger with a CLI does not increment it.

A heartbeat binds the installation, Machine, Agent, controller epoch, sender epoch, boot, safe integer sequence and observation time. SQLite rechecks those bindings at commit. Equal sequence/equal payload is idempotent and returns the **original** receipt time. Changed duplicates, lower sequences, older observation times, old boots and old epochs are rejected. Requests from the future or observations older than 60 seconds are rejected. Resource/session sampling is timestamped at its start. After a network interruption the Host skips a stale pending sample's sequence and obtains fresh evidence, so a possibly committed old request cannot collide with a new payload.

The latest snapshot is stored in `machine_snapshots`; querying after 30 seconds, revocation or controller epoch change returns `fresh=false` and `humanPresence=unknown`. Historical values remain labeled as historical and unknown resource values remain `null`. A new boot clears the old latest snapshot until a new observation arrives. Sequence numbers restart only with a new fenced boot. No snapshot is itself permission to shut down or evidence that a machine is safe to power off.

For a lost credential, enrollment response loss or failure to save the binding, a full administrator reads `GET /v1/agents/{id}` and calls `POST /v1/agents/{id}/revoke` with `expectedSessionEpoch` and a nonempty `reason`. This invalidates the credential, pending pairing and current boot atomically and increments the sender epoch. Read the new summary and create a new pairing with the same Machine plus its current `expectedSessionEpoch`; install the new binding after securely removing the unusable old local binding. Re-pair is allowed only while disabled. Both pair and revoke write actor/request/reason audit records. Expired or lost **unused** pairing receipts can also be replaced while disabled using the current epoch. Existing boots remain in the ledger for fencing. This explicit revoke/re-pair flow is the D20 credential rotation path.

## Native sampling and limits

- **macOS:** fixed `/usr/sbin/sysctl -n kern.hv_vmm_present` must return `0`; a reported VM or unavailable boundary is unknown. Fixed `ioreg -n Root -d1 -a` is converted using `plutil -convert json -o - -`. `IOConsoleUsers` with `kCGSessionLoginDoneKey=true` supplies positive console and switched-session evidence. Missing `CGSSessionScreenIsLocked` remains `locked=unknown`. `who` adds positive remote-session evidence only. Neither empty `who` nor empty IOConsoleUsers proves full all-session absence, so Mac enumeration remains incomplete. Permission/command failure never becomes an empty successful inventory.
- **Linux:** requires systemd `systemd-detect-virt` and `loginctl list-sessions --json=short`, then fixed `show-session` properties for every session. Docker/WSL/VM detection rejects the guest scope. A plain non-systemd installation or an unavailable/unsupported property is unknown. User/user-early/user-light sessions are protected even if online/disconnected, idle or locked; new/unrecognized classes are unknown. Only explicit noninteractive manager/background classes are excluded. Failure during enumeration retains earlier positive sessions and marks enumeration incomplete.
- **Windows:** a fixed bundled PowerShell script calls WTS enumeration and queries every listed session username/domain; any failed native query fails closed. A nonempty username is protected regardless of account name, including service accounts and disconnected WTS sessions. There are no vendor allowlists. WMI native system identity must be available, and known VM/container model/registry evidence rejects the guest scope. WMI alone cannot prove a bare-metal boundary. Lock state is currently `unknown` for listed WTS sessions; no Windows 7 lock-flag inference is made. A native complete empty WTS list can attest no logged-in interactive sessions within the administrator-approved host scope.
- Resource pressure uses a measured CPU-counter interval and OS total/free memory, in bytes and percent (0–100); missing/invalid measurements are `null`, never zero. D20 does not classify all unmanaged processes: `unmanagedActivityHold=null`, whole-probe status stays partial, and this cannot authorize power actions. Complete session evidence is assessed independently of unknown workloads/resources. Positive sessions always protect; partial/incomplete/failed empty evidence is unknown.

The fixed-output fixture tests and local SQLite/HTTPS tests are not Windows/Linux deployment certification or comprehensive Mac session acceptance. Each machine still needs administrator-run native boot, lock/unlock, disconnected RDP/SSH, fast switching, no-login and permission-failure tests before those capabilities can be marked verified. D21 policies/GUI and D22 power dry-run remain separate work. No real power commands are part of D20.

## Start at boot

Run with an account that can enumerate all native sessions and read the required telemetry. A restricted account that cannot do so returns unknown; do not filter the session list to just that account. A service account's own noninteractive daemon does not count as a human, but an interactive login under that account does count.

Linux: install a dedicated service account and a unit such as `/etc/systemd/system/hitchlet-host.service`:

```ini
[Unit]
Description=Hitchlet physical Host observer
After=network-online.target systemd-logind.service
Wants=network-online.target
[Service]
Type=simple
User=hitchlet-host
Environment=HITCHLET_HOST_AGENT_CONFIG=/etc/hitchlet/host.json
ExecStart=/opt/hitchlet/node/bin/node /opt/hitchlet/apps/runtime-agent/dist/host-main.js
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
[Install]
WantedBy=multi-user.target
```

After enrollment, the service is read-only locally. Give the account read access to its `0600` config/binding and required logind metadata under the site's normal permissions. Administrator installation uses `systemctl daemon-reload` and `systemctl enable --now hitchlet-host.service`. Review `journalctl -u hitchlet-host.service` for fixed credential-free errors and controller snapshot freshness. Do not suppress permission errors or replace them with no-session success.

macOS: install a root-owned LaunchDaemon plist under `/Library/LaunchDaemons/test.example.hitchlet-host.plist`, selecting a dedicated local account with sufficient native observation access:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>test.example.hitchlet-host</string>
<key>UserName</key><string>hitchlet-host</string>
<key>ProgramArguments</key><array><string>/opt/hitchlet/node/bin/node</string><string>/opt/hitchlet/apps/runtime-agent/dist/host-main.js</string></array>
<key>EnvironmentVariables</key><dict><key>HITCHLET_HOST_AGENT_CONFIG</key><string>/etc/hitchlet/host.json</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
```

Validate with `plutil -lint`, then administrator installation uses `launchctl bootstrap system <plist path>`. Check `launchctl print system/test.example.hitchlet-host` and controller freshness. A daemon's different OS permission context must be tested; a successful shell probe does not prove the daemon can read IOConsoleUsers. No accessibility automation or logged-in GUI is required by this observer.

Windows: Node is not a Windows SCM service executable. Use the built-in Task Scheduler service for native startup supervision; do not claim that `sc.exe create` can run Node directly. Set a machine-level `HITCHLET_HOST_AGENT_CONFIG` environment variable pointing to a restricted `C:\ProgramData\Hitchlet\host.json`, with Windows paths in that JSON. From an elevated installer PowerShell:

```powershell
$action = New-ScheduledTaskAction -Execute 'C:\Program Files\nodejs\node.exe' -Argument '"C:\Program Files\Hitchlet\apps\runtime-agent\dist\host-main.js"'
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Hitchlet Host Observer' -Action $action -Trigger $trigger -Principal $principal -Settings $settings
```

A site-approved dedicated service identity may replace SYSTEM after all-session WTS/CIM permissions are proven. Restrict program/config ACLs, enroll under the intended identity, then inspect `Get-ScheduledTaskInfo -TaskName 'Hitchlet Host Observer'` and controller freshness after reboot. The task has no user-session login trigger and is independent of RDP console attachment. No Task Scheduler or boot-service installation was executed by the D20 implementation tests.
