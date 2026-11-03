import type {
  HyperVExecutionProviderOptions,
  HyperVSshEvidence,
} from "./hyperv-provider.js";
import { runSshReadinessCommand } from "./ssh-readiness-command.js";

const LINUX_CHECK =
  "id -un && uname -s && uname -m && test -w /tmp && printf 'hitchlet-scratch-writable\\n'";
// Fixed public source, never interpolates a path, credential or command from a tenant.
// Only the guest's random one-byte TEMP file is written; it is deleted in finally.
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$path=$null
try {
  $os=Get-CimInstance -ClassName Win32_OperatingSystem
  $cpu=@(Get-CimInstance -ClassName Win32_Processor)
  if ($os.OSType -ne 18 -or $cpu.Count -eq 0 -or @($cpu | Where-Object { $_.Architecture -ne 9 -or $_.AddressWidth -ne 64 }).Count -gt 0) { throw 'guest_environment_mismatch' }
  $name=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  $name=$name.Substring($name.LastIndexOf('\')+1)
  $path=[IO.Path]::Combine([IO.Path]::GetTempPath(),('hitchlet-probe-'+[Guid]::NewGuid().ToString('N')))
  $file=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $file.WriteByte(0); $file.Flush() } finally { $file.Dispose() }
  [Console]::Out.WriteLine($name)
  [Console]::Out.WriteLine('Windows')
  [Console]::Out.WriteLine('amd64')
  [Console]::Out.WriteLine('hitchlet-scratch-writable')
} finally { if ($path -and [IO.File]::Exists($path)) { [IO.File]::Delete($path) } }
`;
const WINDOWS_CHECK =
  "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand " +
  Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64");
export type HyperVSshProbeInput = Parameters<
  HyperVExecutionProviderOptions["ssh"]["verify"]
>[0];
/** Native guest check only; does not require Node, Python, administrator elevation or host changes. */
export async function probeHyperVSsh(
  input: HyperVSshProbeInput,
  now = Date.now,
): Promise<HyperVSshEvidence> {
  if (
    input.architecture !== "amd64" ||
    !["windows", "linux"].includes(input.guestOs)
  )
    throw Error("Hyper-V SSH guest environment is unsupported");
  const output = await runSshReadinessCommand(
    input,
    input.guestOs === "windows" ? WINDOWS_CHECK : LINUX_CHECK,
    "Hyper-V",
    now,
  );
  const lines = output.stdout.replace(/\r/g, "").trimEnd().split("\n");
  const os =
    lines[1] === "Windows"
      ? "windows"
      : lines[1] === "Linux"
        ? "linux"
        : undefined;
  const arch =
    lines[2] === "amd64" || lines[2] === "x86_64" ? "amd64" : undefined;
  const accountMatches =
    input.guestOs === "windows"
      ? lines[0]?.toLowerCase() === input.username.toLowerCase()
      : lines[0] === input.username;
  if (
    output.exitCode !== 0 ||
    lines.length !== 4 ||
    !accountMatches ||
    os !== input.guestOs ||
    arch !== input.architecture ||
    lines[3] !== "hitchlet-scratch-writable"
  )
    throw Error("Hyper-V SSH guest facts or scratch check did not match");
  return {
    authenticated: true,
    username: input.username,
    hostKeyFingerprint: input.hostKeyFingerprint,
    clientPublicKeyFingerprint: input.clientPublicKeyFingerprint,
    guestOs: os,
    architecture: arch,
    scratchWritable: true,
  };
}
export function createHyperVReadinessPorts(): Pick<
  HyperVExecutionProviderOptions,
  "ssh"
> {
  return { ssh: { verify: probeHyperVSsh } };
}
