param([string]$Mode,[string]$RequestJson,[int]$BudgetMs,[Security.SecureString]$InteractivePassword)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $r = $RequestJson | ConvertFrom-Json
    if ($Mode -notin @('inspect','apply') -or $r.account -cne 'workspace' -or $r.guestOs -ne 'windows' -or $r.architecture -ne 'amd64') { throw 'request_invalid' }
    if ($BudgetMs -lt 1 -or $BudgetMs -gt 30000) { throw 'budget_invalid' }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $account = Get-LocalUser -Name 'workspace' -ErrorAction Stop
    if (-not $account.Enabled) { throw 'account_disabled' }
    $root = Join-Path $env:ProgramData 'Hitchlet'
    # This protected directory is created by the existing bootstrap. Never alter its ACL.
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'bootstrap_root_missing' }
    $path = Join-Path $root 'interactive-access.json'
    $expected = [ordered]@{ identity=$r.identity; nonce=$r.nonce; passwordHash=$r.passwordHash; account='workspace'; vmId=$r.vmId; guestOs='windows'; architecture='amd64' }
    function Receipt([string]$status) {
        $v = [ordered]@{}
        foreach($key in $expected.Keys) { $v[$key]=$expected[$key] }
        $v.status=$status
        $v | ConvertTo-Json -Depth 16 -Compress
    }
    function Inspect-Marker {
        if (-not (Test-Path -LiteralPath $path)) { return 'not_applied' }
        try {
            $m = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
            foreach($key in $expected.Keys) {
                if (($m.$key | ConvertTo-Json -Depth 16 -Compress) -cne ($expected[$key] | ConvertTo-Json -Depth 16 -Compress)) { return 'unknown' }
            }
            $current = Get-LocalUser -Name 'workspace' -ErrorAction Stop
            if ($m.state -ne 'applied' -or $m.sid -ne $current.SID.Value -or -not $current.Enabled -or $m.passwordLastSet -ne $current.PasswordLastSet.ToUniversalTime().ToString('o')) { return 'unknown' }
            return 'applied'
        } catch { return 'unknown' }
    }
    $status = Inspect-Marker
    if ($Mode -eq 'inspect' -or $status -ne 'not_applied') { Receipt $status; return }
    if ($null -eq $InteractivePassword) { throw 'material_required' }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($InteractivePassword)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ($plain.Length -lt 40 -or $plain.Length -gt 128) { throw 'material_invalid' }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($plain)) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
        if ($hash -cne $r.passwordHash) { throw 'material_mismatch' }
    } finally { $plain=$null; [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $marker = [ordered]@{}
    foreach($key in $expected.Keys) { $marker[$key]=$expected[$key] }
    $marker.sid=$account.SID.Value; $marker.state='preparing'; $marker.passwordLastSet=$null
    # CreateNew never overwrites a previous attempt, including an uncertain one.
    try { $file = [IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None) }
    catch { Receipt 'unknown'; return }
    try {
        $bytes=[Text.Encoding]::UTF8.GetBytes(($marker | ConvertTo-Json -Depth 16 -Compress))
        $file.Write($bytes,0,$bytes.Length); $file.Flush($true)
    } finally { $file.Dispose() }
    if ($watch.ElapsedMilliseconds -ge $BudgetMs) { Receipt 'unknown'; return }
    Set-LocalUser -Name 'workspace' -Password $InteractivePassword -ErrorAction Stop
    $current=Get-LocalUser -Name 'workspace' -ErrorAction Stop
    if ($current.SID.Value -ne $marker.sid -or -not $current.Enabled) { Receipt 'unknown'; return }
    $marker.state='applied'; $marker.passwordLastSet=$current.PasswordLastSet.ToUniversalTime().ToString('o')
    $temp=$path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
    try {
        $file=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $bytes=[Text.Encoding]::UTF8.GetBytes(($marker | ConvertTo-Json -Depth 16 -Compress)); $file.Write($bytes,0,$bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
        [IO.File]::Replace($temp,$path,[System.Management.Automation.Language.NullString]::Value)
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
    Receipt (Inspect-Marker)
} catch {
    # No PowerShell exception rendering: arguments may contain private material.
    throw 'interactive_guest_outcome_unknown'
}
