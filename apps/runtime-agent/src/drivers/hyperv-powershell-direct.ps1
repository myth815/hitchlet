$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $inputCommand = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($inputCommand.mode -notin @('inspect', 'apply')) { throw 'invalid_mode' }
    if ($inputCommand.request.guestOs -ne 'windows' -or $inputCommand.request.architecture -ne 'amd64') { throw 'invalid_platform' }
    $vmId = [Guid]$inputCommand.request.vmId
    $vm = Get-VM -Id $vmId -ErrorAction Stop
    if ($vm.State.ToString() -ne 'Running') { throw 'vm_not_running' }
    # DPAPI-protected PSCredential created by the template owner, never by this action.
    $credential = Import-Clixml -LiteralPath $inputCommand.credentialFile
    if ($credential -isnot [System.Management.Automation.PSCredential]) { throw 'guest_credential_invalid' }
    $program = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'hyperv-windows-guest.ps1') -Raw
    $requestJson = $inputCommand.request | ConvertTo-Json -Depth 12 -Compress
    $result = @(Invoke-Command -VMId $vmId -Credential $credential -ScriptBlock ([ScriptBlock]::Create($program)) -ArgumentList $inputCommand.mode, $requestJson, ([int]$inputCommand.budgetMs) -ErrorAction Stop)
    if ($result.Count -ne 1 -or $result[0] -isnot [string]) { throw 'guest_response_invalid' }
    [Console]::Out.WriteLine($result[0])
} catch {
    [Console]::Error.WriteLine('hyperv_guest_channel_failed')
    exit 1
}
