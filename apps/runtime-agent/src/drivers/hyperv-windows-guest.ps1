param([string]$Mode, [string]$PublicRequestJson, [int]$BudgetMs)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$watch = [Diagnostics.Stopwatch]::StartNew()
$r = $PublicRequestJson | ConvertFrom-Json
if ($Mode -notin @('inspect','apply') -or $r.guestOs -ne 'windows' -or $r.architecture -ne 'amd64' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'guest_platform_invalid' }
if ($r.account -notmatch '^[a-zA-Z_][a-zA-Z0-9_.-]{0,31}$' -or $BudgetMs -lt 1 -or $BudgetMs -gt 30000) { throw 'guest_request_invalid' }
$root = Join-Path $env:ProgramData 'Hitchlet'
$config = Join-Path $root 'sshd_config'
$stateFile = Join-Path $root 'bootstrap-state.json'
$hostKey = Join-Path $root 'ssh_host_ed25519_key'
$authorized = Join-Path $root 'authorized_keys'
$sshd = Join-Path $env:SystemRoot 'System32\OpenSSH\sshd.exe'
$keygen = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh-keygen.exe'
$sha = [Security.Cryptography.SHA256]::Create()
function Fingerprint([string]$key) {
    $parts = $key.Trim() -split ' +'
    if ($parts.Count -lt 2 -or $parts[0] -cne 'ssh-ed25519') { throw 'guest_key_invalid' }
    $blob = [Convert]::FromBase64String($parts[1])
    return 'SHA256:' + [Convert]::ToBase64String($sha.ComputeHash($blob)).TrimEnd('=')
}
if ((Fingerprint $r.clientPublicKey) -cne $r.clientPublicKeyFingerprint) { throw 'guest_client_key_mismatch' }
$requestHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($PublicRequestJson))).Replace('-','').ToLowerInvariant()
$service = Get-CimInstance Win32_Service -Filter "Name='sshd'"
$expectedServicePath = '"' + $sshd + '" -f "' + $config + '"'
# Template prepares this dedicated SSH service/account once. No installer,
# service takeover, firewall change, user creation or workload runtime is hidden here.
if (!$service -or $service.PathName.ToLowerInvariant() -cne $expectedServicePath.ToLowerInvariant() -or !(Test-Path -LiteralPath $sshd) -or !(Test-Path -LiteralPath $keygen)) { throw 'guest_template_ssh_not_prepared' }
$account = Get-LocalUser -Name $r.account -ErrorAction Stop
function PrivateAcl([string]$path, [bool]$directory) {
    if ($directory) { $acl = New-Object Security.AccessControl.DirectorySecurity } else { $acl = New-Object Security.AccessControl.FileSecurity }
    $acl.SetAccessRuleProtection($true,$false)
    # ssh-keygen creates the key as the bootstrap user; LocalSystem sshd requires a privileged owner.
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        if ($directory) {
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        } else { $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow') }
        $acl.AddAccessRule($rule)
    }
    if ($directory) {
        # Traverse only; private host keys/state do not inherit tenant read rights.
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($account.SID,'Traverse','None','None','Allow')))
    }
    Set-Acl -LiteralPath $path -AclObject $acl
}
function WriteState($state) {
    $temporary = Join-Path $root ('state-' + [Guid]::NewGuid().ToString() + '.tmp')
    $state | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding UTF8
    PrivateAcl $temporary $false
    # Windows PowerShell 5.1 binds $null to an empty string for this .NET string argument.
    if (Test-Path -LiteralPath $stateFile) { [IO.File]::Replace($temporary,$stateFile,[NullString]::Value) }
    else { [IO.File]::Move($temporary,$stateFile) }
}
function ReadApplied($state) {
    if ($state.requestHash -cne $requestHash) { throw 'guest_bootstrap_identity_changed' }
    if (!(Test-Path -LiteralPath ($hostKey+'.pub')) -or !(Test-Path -LiteralPath $authorized) -or !(Test-Path -LiteralPath $config)) { return $null }
    $current = Get-CimInstance Win32_Service -Filter "Name='sshd'"
    if ($current.State -ne 'Running') { return $null }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue | Where-Object {$_.OwningProcess -eq $current.ProcessId})
    if ($listeners.Count -eq 0 -or (Get-Content -LiteralPath $authorized -Raw).Trim() -cne $r.clientPublicKey.Trim()) { return $null }
    $configBytes = [IO.File]::ReadAllBytes($config)
    $configHash = [BitConverter]::ToString($sha.ComputeHash($configBytes)).Replace('-','').ToLowerInvariant()
    if (!$state.configHash -or $state.configHash -cne $configHash) { return $null }
    $public = (Get-Content -LiteralPath ($hostKey+'.pub') -Raw).Trim()
    $keyFingerprint = Fingerprint $public
    if ($state.hostKeyFingerprint -cne $keyFingerprint) { return $null }
    $receipt = [ordered]@{}
    foreach ($property in $r.PSObject.Properties) { if ($property.Name -ne 'clientPublicKey') { $receipt[$property.Name] = $property.Value } }
    $receipt.status='applied';$receipt.hostPublicKey=$public;$receipt.hostKeyFingerprint=$keyFingerprint;$receipt.observedAt=[DateTime]::UtcNow.ToString('o')
    return $receipt
}
$state = $null
if (Test-Path -LiteralPath $stateFile) {
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $applied = ReadApplied $state
    if ($applied) { $applied | ConvertTo-Json -Depth 12 -Compress; return }
    @{status='unknown';reason='guest_initialization_incomplete_or_changed'} | ConvertTo-Json -Compress; return
}
if ((Test-Path -LiteralPath $hostKey) -or (Test-Path -LiteralPath $config) -or (Test-Path -LiteralPath $authorized)) { throw 'guest_unowned_ssh_material_present' }
if ($service.State -ne 'Stopped' -or @(Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue).Count -ne 0) { throw 'guest_ssh_port_in_use' }
if ($Mode -eq 'inspect') { @{status='not_applied'} | ConvertTo-Json -Compress; return }
New-Item -ItemType Directory -Path $root -Force | Out-Null
PrivateAcl $root $true
$state = [ordered]@{requestHash=$requestHash;status='preparing';configHash=$null;hostKeyFingerprint=$null}
WriteState $state
& $keygen -t ed25519 -N '""' -f $hostKey -q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'guest_host_key_generation_failed' }
PrivateAcl $hostKey $false
$r.clientPublicKey.Trim() | Set-Content -LiteralPath $authorized -Encoding Ascii
PrivateAcl $authorized $false
$acl = Get-Acl -LiteralPath $authorized
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($account.SID,'Read','Allow')))
Set-Acl -LiteralPath $authorized -AclObject $acl
@("Port 22", "ListenAddress 0.0.0.0", "HostKey `"$hostKey`"", "AuthorizedKeysFile `"$authorized`"", "AllowUsers $($r.account)", "PubkeyAuthentication yes", "PasswordAuthentication no", "KbdInteractiveAuthentication no", "AllowTcpForwarding no", "PermitTunnel no", "Subsystem sftp internal-sftp") | Set-Content -LiteralPath $config -Encoding Ascii
PrivateAcl $config $false
& $sshd -t -f $config
if ($LASTEXITCODE -ne 0) { throw 'guest_sshd_config_invalid' }
$state.configHash=[BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($config))).Replace('-','').ToLowerInvariant()
$state.hostKeyFingerprint=Fingerprint ((Get-Content -LiteralPath ($hostKey+'.pub') -Raw).Trim())
WriteState $state
Start-Service -Name sshd
while ($watch.ElapsedMilliseconds -lt $BudgetMs) {
    $applied=ReadApplied $state
    if ($applied) { $state.status='applied';WriteState $state;$applied | ConvertTo-Json -Depth 12 -Compress;return }
    Start-Sleep -Milliseconds 100
}
@{status='unknown';reason='guest_ssh_start_not_confirmed'} | ConvertTo-Json -Compress
