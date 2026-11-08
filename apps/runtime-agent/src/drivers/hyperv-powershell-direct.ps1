$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $inputCommand = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($inputCommand.mode -notin @('inspect', 'apply', 'interactive.inspect', 'interactive.apply')) { throw 'invalid_mode' }
    if ($inputCommand.request.guestOs -ne 'windows' -or $inputCommand.request.architecture -ne 'amd64') { throw 'invalid_platform' }
    $vmId = [Guid]$inputCommand.request.vmId
    $vm = Get-VM -Id $vmId -ErrorAction Stop
    if ($vm.State.ToString() -ne 'Running') { throw 'vm_not_running' }
    # DPAPI-protected PSCredential created by the template owner, never by this action.
    $credential = Import-Clixml -LiteralPath $inputCommand.credentialFile
    if ($credential -isnot [System.Management.Automation.PSCredential]) { throw 'guest_credential_invalid' }
    $interactive = $inputCommand.mode.StartsWith('interactive.')
    $asset = if ($interactive) { 'hyperv-windows-interactive.ps1' } else { 'hyperv-windows-guest.ps1' }
    $program = Get-Content -LiteralPath (Join-Path $PSScriptRoot $asset) -Raw
    $newPassword = $null
    if ($inputCommand.mode -eq 'interactive.apply') {
        $newPassword = ConvertTo-SecureString -String $inputCommand.password -AsPlainText -Force
        $inputCommand.PSObject.Properties.Remove('password')
    }
    $mode = if ($interactive) { $inputCommand.mode.Substring(12) } else { $inputCommand.mode }
    $requestJson = $inputCommand.request | ConvertTo-Json -Depth 12 -Compress
    $result = @(Invoke-Command -VMId $vmId -Credential $credential -ScriptBlock ([ScriptBlock]::Create($program)) -ArgumentList $mode, $requestJson, ([int]$inputCommand.budgetMs), $newPassword -ErrorAction Stop)
    if ($result.Count -ne 1 -or $result[0] -isnot [string]) { throw 'guest_response_invalid' }
    [Console]::Out.WriteLine($result[0])
} catch {
    [Console]::Error.WriteLine('hyperv_guest_channel_failed')
    exit 1
}
