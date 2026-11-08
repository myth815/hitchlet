param([ValidateSet('inventory','boot','permissions','watch','shutdown','abort')][string]$Action='inventory', [string]$CacheFile='', [string]$OwnedRuntimeExecutable='', [string]$ProtectedPath='', [string]$LeaseFile='', [int]$ExecutorPid=0, [long]$ExecutorStartedTicks=0, [long]$NotAfterUptimeMs=0, [long]$ControllerNotAfterMs=0, [string]$CycleId='', [int]$WatchLauncherPid=0, [long]$WatchLauncherStartedTicks=0, [int]$WatchHelperPid=0, [long]$WatchHelperStartedTicks=0, [string]$ObserverTask='', [string]$ObserverDefinitionSha256='', [string]$ObserverOwnerSid='', [string]$ObserverRuntimeSha256='')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Assert-PrivatePath([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) {$Path=Split-Path -Parent $Path}
  $acl=Get-Acl -LiteralPath $Path
  $trusted=@('S-1-5-18','S-1-5-32-544',[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  try {$trusted+=@(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | ForEach-Object {$_.SID.Value})} catch {}
  $owner=($acl.GetOwner([System.Security.Principal.SecurityIdentifier])).Value
  if ($owner -notin $trusted) {throw 'power_path_owner_untrusted'}
  foreach($ace in $acl.Access) {
    $sid=$ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    # Read-only consumers are allowed; any write/delete/ACL rights outside the service/admin boundary fail.
    if ($ace.AccessControlType -eq 'Allow' -and (([int]$ace.FileSystemRights -band 0x000d0156) -ne 0) -and $sid -notin $trusted) {throw 'power_path_writable_by_untrusted_identity'}
  }
}
function Read-BootInstance {
  # Event data is immutable across clock correction. Never use CIM LastBootUpTime/TimeCreated/current time.
  $event=Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Kernel-General';Id=12} -MaxEvents 1 -ErrorAction Stop
  if (!$event -or $event.LogName -cne 'System' -or $event.ProviderName -cne 'Microsoft-Windows-Kernel-General' -or $event.Id -ne 12 -or !$event.RecordId -or $event.RecordId -le 0) {throw 'boot_event_invalid'}
  [xml]$xml=$event.ToXml()
  $data=@($xml.Event.EventData.Data | Where-Object {$_.Name -ceq 'StartTime'})
  if ($data.Count -ne 1) {throw 'boot_event_start_invalid'}
  $text=[string]$data[0].InnerText
  $start=[DateTimeOffset]::MinValue
  if ($text -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$' -or ![DateTimeOffset]::TryParse($text,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal,[ref]$start) -or $start -eq [DateTimeOffset]::MinValue) {throw 'boot_event_start_invalid'}
  return @{bootRecordId=([long]$event.RecordId).ToString([Globalization.CultureInfo]::InvariantCulture);bootTime=$start.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ',[Globalization.CultureInfo]::InvariantCulture)}
}
# Reconcile one bounded sample, not an exemption for short-lived process names.
# Failed reads are harmless only after the exact instance is confirmed absent.
function Reconcile-NativeProcessSnapshot($Initial, $Final, $Facts, $Failed, $Ignored) {
  $state=@{complete=$true};$diagnostics=[Collections.Generic.List[object]]::new();$before=@{};$after=@{}
  foreach($p in $Initial){$before[[string]$p.ProcessId]=$p}
  foreach($p in $Final){$after[[string]$p.ProcessId]=$p}
  $kept=@($Facts|Where-Object{
    $key=[string]$_.pid;$live=$after[$key];$old=$before[$key]
    if(!$live){return $false}
    if(!$old -or $old.CreationDate -isnot [DateTime] -or $live.CreationDate -isnot [DateTime] -or $old.CreationDate.ToUniversalTime().Ticks -ne $live.CreationDate.ToUniversalTime().Ticks){$state.complete=$false;$diagnostics.Add(@{kind='process_identity_changed';pid=[int]$_.pid;name=[string]$live.Name;parentPid=[int]$live.ParentProcessId})}
    if($Failed.ContainsKey($key)){$state.complete=$false;$diagnostics.Add(@{kind='live_read_failed';pid=[int]$_.pid;name=[string]$live.Name;parentPid=[int]$live.ParentProcessId;stage=[string]$Failed[$key].stage;code=[string]$Failed[$key].code})}
    return $true
  })
  foreach($p in $Final){
    if($p.ProcessId -in $Ignored -or ($p.ParentProcessId -eq 4 -and $p.Name -in @('Registry','Memory Compression','Secure System'))){continue}
    if(!$before.ContainsKey([string]$p.ProcessId)){$state.complete=$false;$diagnostics.Add(@{kind='new_instance';pid=[int]$p.ProcessId;name=[string]$p.Name;parentPid=[int]$p.ParentProcessId})}
  }
  return @{complete=[bool]$state.complete;processes=$kept;diagnostics=@($diagnostics.ToArray()|Select-Object -First 256)}
}
if ($Action -eq 'permissions') {Assert-PrivatePath $ProtectedPath; '{"private":true}'; exit}
if ($CacheFile) { Assert-PrivatePath (Split-Path -Parent $CacheFile); if(Test-Path -LiteralPath $CacheFile) {Assert-PrivatePath $CacheFile} }

if ($Action -eq 'boot') { $boot=Read-BootInstance; $boot.executorStartedTicks=(Get-Process -Id $ExecutorPid).StartTime.ToUniversalTime().Ticks.ToString(); $boot | ConvertTo-Json -Compress; exit }
if ($Action -eq 'inventory') {
  # Missing/cleared startup evidence is fatal, outside the temporary live-enumeration retry path.
  $boot=Read-BootInstance
  # Cache only Authenticode/hash work. Every pass still enumerates live PIDs/services/tasks and checks
  # volume/file identity, size and last-write metadata; changed identity invalidates the cache.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class HitchletFileIdentity {
 [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write; public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
 public static string Read(string path) {using(var h=CreateFileW(path,0,7,IntPtr.Zero,3,0,IntPtr.Zero)){Info i;if(h.IsInvalid||!GetFileInformationByHandle(h,out i))throw new InvalidOperationException("file_identity_unknown");return i.Volume+":"+i.IndexHigh+":"+i.IndexLow+":"+i.SizeHigh+":"+i.SizeLow+":"+i.Write.dwHighDateTime+":"+i.Write.dwLowDateTime;}}
}
public static class HitchletObserverArgv {
 [DllImport("shell32.dll",SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)]string command,out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 public static string[] Read(string command) {int n;var p=CommandLineToArgvW(command,out n);if(p==IntPtr.Zero)throw new InvalidOperationException("observer_argv_unavailable");try{if(n<1||n>64)throw new InvalidOperationException("observer_argv_limit");var a=new string[n];for(int i=0;i<n;i++)a[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size));return a;}finally{LocalFree(p);}}
}
public static class HitchletProcessImage {
 // Strip only the exact extended DOS drive prefix. UNC/device/relative forms remain unchanged.
 public static string NormalizeLocalDosPath(string path) {
   if(path!=null && path.Length>=7 && path[0]=='\\' && path[1]=='\\' && path[2]=='?' && path[3]=='\\' && ((path[4]>='A'&&path[4]<='Z')||(path[4]>='a'&&path[4]<='z')) && path[5]==':' && path[6]=='\\')return path.Substring(4);
   return path;
 }
 [DllImport("kernel32.dll",SetLastError=true)] static extern SafeProcessHandle OpenProcess(uint access,bool inherit,uint processId);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern bool QueryFullProcessImageNameW(SafeProcessHandle process,uint flags,StringBuilder path,ref uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(SafeProcessHandle process,out long created,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(SafeProcessHandle process,out uint code);
 // CIM truncates native 100ns UTC ticks to microseconds. No tolerance window or rounding up.
 public static bool SameCreationMicrosecond(long nativeUtcTicks,long cimUtcTicks) {
   return nativeUtcTicks>0 && nativeUtcTicks<=DateTime.MaxValue.Ticks && cimUtcTicks>0 && cimUtcTicks<=DateTime.MaxValue.Ticks && cimUtcTicks%10==0 && nativeUtcTicks/10==cimUtcTicks/10;
 }
 static long Creation(SafeProcessHandle process) {
   uint code;long created,exited,kernel,user;
   if(!GetProcessTimes(process,out created,out exited,out kernel,out user)||!GetExitCodeProcess(process,out code)||code!=259)throw new InvalidOperationException("process_identity_unavailable");
   return DateTime.FromFileTimeUtc(created).Ticks;
 }
 public static string Read(int processId,long cimUtcTicks) {
   if(processId<=0||!SameCreationMicrosecond(cimUtcTicks,cimUtcTicks))throw new InvalidOperationException("process_creation_unknown");
   using(var process=OpenProcess(0x1000,false,(uint)processId)) {
     if(process.IsInvalid)throw new InvalidOperationException("process_limited_query_unavailable");
     long created=Creation(process);
     if(!SameCreationMicrosecond(created,cimUtcTicks))throw new InvalidOperationException("process_identity_changed");
     var path=new StringBuilder(32768);uint size=(uint)path.Capacity;
     if(!QueryFullProcessImageNameW(process,0,path,ref size)||size==0||size>=path.Capacity)throw new InvalidOperationException("process_image_query_failed");
     if(Creation(process)!=created)throw new InvalidOperationException("process_identity_changed");
     return path.ToString();
   }
 }
}
'@
  $cache=@{}
  if ($CacheFile -and (Test-Path -LiteralPath $CacheFile)) { try { $saved=Get-Content -LiteralPath $CacheFile -Raw | ConvertFrom-Json; foreach($entry in $saved.PSObject.Properties) {$cache[$entry.Name]=$entry.Value} } catch {$cache=@{}} }
  # Reserved exits are consumed as fixed codes by Node. ACL/compilation remain outside this retry path.
  try {
    $liveProcesses=@(Get-CimInstance Win32_Process)
    $liveServices=@(Get-CimInstance Win32_Service)
    $liveTasks=@(Get-ScheduledTask)
  } catch {
    if ($_.CategoryInfo.Category -in @('PermissionDenied','SecurityError') -or $_.Exception -is [UnauthorizedAccessException] -or $_.Exception -is [System.Security.SecurityException] -or $_.Exception.HResult -in @(-2147217405,-2147024891)) {exit 71}
    exit 70
  }
  $complete=$true;$failedProcessIds=@{}
  function Read-NativeProcessFact($p) {
    if($p.ProcessId -in @(0,4)){return}
    $path=[string]$p.ExecutablePath; $hash=''; $signed=$false; $thumbprint=''; $creationTicks=''
    if($p.CreationDate -is [DateTime]) {$creationTicks=$p.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)}
    # Kernel pseudo-processes have no userspace executable and cannot carry an arbitrary task.
    if ($p.ParentProcessId -eq 4 -and $p.Name -in @('Registry','Memory Compression','Secure System')) { return }
    if ($p.ProcessId -eq $PID -or $p.ProcessId -eq $ExecutorPid) { return }
    # Hyper-V/WSL memory processes have no executable image. Keep them as workload
    # blockers below without treating their documented pseudo-process shape as a failed inventory.
    if ($p.Name -match '^vmmem(?:WSL)?$') {
      $owner='';try{$o=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid;if($o.ReturnValue -ne 0){throw 'owner_unknown'};$owner=$o.Sid}catch{$failedProcessIds[[string]$p.ProcessId]=@{stage='owner';code='owner_sid_unavailable'}}
      [pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;ownerSid=$owner;name=[string]$p.Name;path='';sha256='';microsoftSigned=$false;signerThumbprint='';creationTicks=$creationTicks}
      return
    }
    try {
      if (($WatchLauncherPid -gt 0 -and $p.ProcessId -eq $WatchLauncherPid) -or ($WatchHelperPid -gt 0 -and $p.ProcessId -eq $WatchHelperPid)) {
        $isLauncher=($p.ProcessId -eq $WatchLauncherPid)
        $expectedParent=$WatchLauncherPid; $expectedTicks=$WatchHelperStartedTicks
        if($isLauncher) {$expectedParent=$ExecutorPid; $expectedTicks=$WatchLauncherStartedTicks}
        if(!$creationTicks -or $p.ParentProcessId -ne $expectedParent -or ![HitchletProcessImage]::SameCreationMicrosecond($expectedTicks,[long]$creationTicks)) {throw 'owned_watch_identity_changed'}
        $path=[HitchletProcessImage]::NormalizeLocalDosPath([HitchletProcessImage]::Read([int]$p.ProcessId,[long]$creationTicks))
        $expectedPath=Join-Path $PSHOME 'powershell.exe'
        if($isLauncher) {
          $executor=@($liveProcesses | Where-Object {$_.ProcessId -eq $ExecutorPid})
          if($executor.Count -ne 1 -or $executor[0].CreationDate -isnot [DateTime]) {throw 'owned_watch_parent_unknown'}
          $expectedPath=[HitchletProcessImage]::Read($ExecutorPid,$executor[0].CreationDate.ToUniversalTime().Ticks)
        }
        $expectedPath=[HitchletProcessImage]::NormalizeLocalDosPath($expectedPath)
        if(![string]::Equals($path,$expectedPath,[StringComparison]::OrdinalIgnoreCase)) {throw 'owned_watch_image_changed'}
        # Only the two live owned instances bypass file hash work; no other Node/PS descendant does.
      } else {
        if (!$path) {
          if ($p.CreationDate -isnot [DateTime]) {throw 'process_creation_unknown'}
          $path=[HitchletProcessImage]::Read([int]$p.ProcessId,$p.CreationDate.ToUniversalTime().Ticks)
        }
        # Unknown workload images on other volumes/shares are blockers, not permission to open them.
        # The executor is identified separately above and its fixed artifacts are checked by Node.
        $path=[HitchletProcessImage]::NormalizeLocalDosPath($path)
        $isOwnedRuntime=$OwnedRuntimeExecutable -and [string]::Equals($path,$OwnedRuntimeExecutable,[StringComparison]::OrdinalIgnoreCase)
        if (!$isOwnedRuntime -and (!$env:SystemDrive -or !$path.StartsWith($env:SystemDrive+'\',[StringComparison]::OrdinalIgnoreCase))) {throw 'image_outside_system_volume'}
        if ($isOwnedRuntime) {Assert-PrivatePath $OwnedRuntimeExecutable}
        $identity=[HitchletFileIdentity]::Read($path)
        $entry=$cache[$path]
        if (!$entry -or $entry.identity -ne $identity) {
          $hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
          $sig=Get-AuthenticodeSignature -LiteralPath $path
          $signed=($sig.Status -eq 'Valid' -and $sig.SignerCertificate.Subject -match '(?:^|, )O=Microsoft Corporation(?:,|$)')
          if ($sig.Status -eq 'Valid') {$thumbprint=$sig.SignerCertificate.Thumbprint}
          if ([HitchletFileIdentity]::Read($path) -ne $identity) {throw 'executable_changed_during_review'}
          $entry=@{identity=$identity;sha256=$hash;microsoftSigned=[bool]$signed;signerThumbprint=$thumbprint};$cache[$path]=$entry
        }
        $hash=[string]$entry.sha256;$signed=[bool]$entry.microsoftSigned;$thumbprint=[string]$entry.signerThumbprint
      }
    } catch {$failedProcessIds[[string]$p.ProcessId]=@{stage='image';code='native_process_image_unverifiable'}}
    $library=$null
    # Only a single quoted DLL and a fixed entry point are eligible for review.
    # General rundll32/script arguments remain unsupported workload processes.
    if ($p.Name -ieq 'rundll32.exe' -and $signed -and $p.CommandLine -match '^(?:"[^\"]*rundll32\.exe"|[^\s"]*rundll32\.exe)\s+"([^\"]+\.dll)"\s+([A-Za-z_][A-Za-z0-9_@]*)$') {
      $dll=$Matches[1];$entryPoint=$Matches[2]
      try {
        $dll=[HitchletProcessImage]::NormalizeLocalDosPath($dll)
        if (!$dll.StartsWith($env:SystemDrive+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'library_outside_system_volume'}
        $identity=[HitchletFileIdentity]::Read($dll)
        $dllHash=(Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant()
        $dllSig=Get-AuthenticodeSignature -LiteralPath $dll
        if ($dllSig.Status -eq 'Valid' -and [HitchletFileIdentity]::Read($dll) -eq $identity) {
          $library=@{path=$dll;sha256=$dllHash;signerThumbprint=$dllSig.SignerCertificate.Thumbprint;entryPoint=$entryPoint}
        }
      } catch {$library=$null}
    }
    $owner='';if(($OwnedRuntimeExecutable -and [string]::Equals($path,$OwnedRuntimeExecutable,[StringComparison]::OrdinalIgnoreCase)) -or $p.Name -match '^(wsl|wslhost|wslrelay)(\.exe)?$'){try{$o=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid;if($o.ReturnValue -ne 0){throw 'owner_unknown'};$owner=$o.Sid}catch{$failedProcessIds[[string]$p.ProcessId]=@{stage='owner';code='owner_sid_unavailable'}}}
    [pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;ownerSid=$owner;name=[string]$p.Name;path=$path;sha256=$hash;microsoftSigned=[bool]$signed;signerThumbprint=$thumbprint;creationTicks=$creationTicks;hostedLibrary=$library}
  }
  $processes=@(foreach($p in $liveProcesses){Read-NativeProcessFact $p})
  $services=@($liveServices | Where-Object {$_.State -eq 'Running'} | ForEach-Object { [pscustomobject]@{name=[string]$_.Name;pid=[int]$_.ProcessId} })
  # wslservice is a daemon, not a running distribution; vmmemWSL may have no .exe suffix.
  $wslRunning=[bool](@($processes | Where-Object {$_.name -match '^(vmmem.*|wslhost|wslrelay)(\.exe)?$'}).Count -gt 0)
  $distributions=@();$wslLocalComplete=$true
  if($wslRunning){
    try {
      $names=@(& "$env:SystemRoot\System32\wsl.exe" --list --running --quiet|ForEach-Object{($_ -replace "`0",'').Trim()}|Where-Object{$_})
      if($LASTEXITCODE -ne 0){throw 'running_distributions_unavailable'}
      if($names.Count){$registrations=@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'|ForEach-Object{Get-ItemProperty $_.PSPath})
      foreach($name in $names){$match=@($registrations|Where-Object{$_.DistributionName -ceq $name});if($match.Count -ne 1){throw 'distribution_registration_unavailable'};$distributions+=@{name=$name;registrationId=([guid]$match[0].PSChildName).ToString()}}}
    } catch {$wslLocalComplete=$false}
  }

  # Only fixed task definitions with a live Scheduler engine and the exact action image can be reviewed.
  # No task XML, action data or additional command lines leave the native probe.
  $runningEngines=@{}
  try {$scheduler=New-Object -ComObject 'Schedule.Service';$scheduler.Connect();foreach($t in $scheduler.GetRunningTasks(1)){$runningEngines[[string]$t.Path]=@{pid=[int]$t.EnginePID;instance=[string]$t.InstanceGuid}}} catch {}
  function Task-DefinitionHash($task) {
    $xml=Export-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath
    $sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$xml)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
  }
  $tasks=@($liveTasks | Where-Object {$_.State -eq 'Running'} | ForEach-Object {
    $task=$_;$path=[string]$task.TaskPath+[string]$task.TaskName
    $definition='';$principal='';$kind='unsupported';$image='';$hash='';$thumb='';$loaded=$false;$engine=0
    try {
      $definition=Task-DefinitionHash $task
      $principal=if($task.Principal.UserId){[string]$task.Principal.UserId}else{[string]$task.Principal.GroupId}
      if($principal -and $principal -notmatch '^S-1-'){$principal=([Security.Principal.NTAccount]$principal).Translate([Security.Principal.SecurityIdentifier]).Value}
      if($runningEngines.ContainsKey($path)){$engine=$runningEngines[$path].pid}
      $actions=@($task.Actions);if($actions.Count -ne 1){throw 'multiple_task_actions_not_reviewed'};$a=$actions[0]
      if($a.CimClass.CimClassName -eq 'MSFT_TaskExecAction'){$kind='exec';$image=[Environment]::ExpandEnvironmentVariables([string]$a.Execute)}
      elseif($a.CimClass.CimClassName -eq 'MSFT_TaskComHandlerAction') {
        $kind='com';$cls=[string]$a.ClassId;if($cls -notmatch '^\{[0-9A-Fa-f-]{36}\}$'){throw 'task_com_identity_invalid'}
        $key=Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\CLSID\'+$cls+'\InprocServer32')
        $image=[Environment]::ExpandEnvironmentVariables([string]$key.'(default)')
      }
      if(!$image -or !$image.StartsWith($env:SystemDrive+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'task_image_outside_system_volume'}
      $identity=[HitchletFileIdentity]::Read($image);$entry=$cache['task:'+ $image]
      if(!$entry -or $entry.identity -ne $identity){$hash=(Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant();$sig=Get-AuthenticodeSignature -LiteralPath $image;if($sig.Status -ne 'Valid' -or [HitchletFileIdentity]::Read($image) -ne $identity){throw 'task_image_unverified'};$entry=@{identity=$identity;sha256=$hash;signerThumbprint=$sig.SignerCertificate.Thumbprint};$cache['task:'+ $image]=$entry}
      $hash=[string]$entry.sha256;$thumb=[string]$entry.signerThumbprint
      $original=@($liveProcesses|Where-Object{$_.ProcessId -eq $engine});if($engine -le 4 -or $original.Count -ne 1 -or $original[0].CreationDate -isnot [DateTime]){throw 'task_engine_identity_unknown'}
      $null=[HitchletProcessImage]::Read($engine,$original[0].CreationDate.ToUniversalTime().Ticks)
      if($kind -eq 'com' -and $engine -gt 4){$loaded=[bool](@((Get-Process -Id $engine -ErrorAction Stop).Modules|Where-Object{[string]::Equals($_.FileName,$image,[StringComparison]::OrdinalIgnoreCase)}).Count -eq 1)}
      elseif($kind -eq 'exec' -and $engine -gt 4){$loaded=$true}
      $current=@($scheduler.GetRunningTasks(1)|Where-Object{$_.Path -ceq $path -and $_.EnginePID -eq $engine -and $_.InstanceGuid -ceq $runningEngines[$path].instance})
      if($current.Count -ne 1 -or (Task-DefinitionHash $task) -cne $definition){throw 'task_definition_or_instance_changed'}
    } catch {$loaded=$false}
    foreach($a in $task.Actions){[pscustomobject]@{path=$path;executable=[string]$a.Execute;arguments=[string]$a.Arguments;definitionSha256=$definition;principalId=$principal;actionKind=$kind;actionPath=$image;actionSha256=$hash;actionSignerThumbprint=$thumb;enginePid=$engine;loadedActionVerified=[bool]$loaded}}
  })
  if ($CacheFile) {
    try { $temp=$CacheFile+'.tmp'; $cache | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $temp -Encoding UTF8; Move-Item -LiteralPath $temp -Destination $CacheFile -Force }
    catch {
      if ($_.CategoryInfo.Category -in @('PermissionDenied','SecurityError') -or $_.Exception -is [UnauthorizedAccessException] -or $_.Exception -is [System.Security.SecurityException]) {exit 71}
      # Retry only explicit Windows sharing/lock violations, not arbitrary storage/configuration errors.
      if (($_.Exception.HResult -band 0xffff) -in @(32,33)) {exit 70}
      exit 72
    }
  }
  try {
    # Bounded catch-up reads identities of new instances; it never exempts them.
    # Concurrent observer helpers and genuine jobs both enter the normal guard.
    $endProcesses=@(Get-CimInstance Win32_Process)
    for($round=0;$round -lt 2;$round++){
      $seen=@{};foreach($p in $liveProcesses){$seen[[string]$p.ProcessId]=$true}
      $new=@($endProcesses|Where-Object{!$seen.ContainsKey([string]$_.ProcessId) -and $_.ProcessId -notin @(0,4,$PID,$ExecutorPid)})
      if(!$new.Count){break}
      if($new.Count -gt 256){break}
      foreach($p in $new){$liveProcesses+=@($p);$processes+=@(Read-NativeProcessFact $p)}
      $endProcesses=@(Get-CimInstance Win32_Process)
    }
    $reconciled=Reconcile-NativeProcessSnapshot $liveProcesses $endProcesses $processes $failedProcessIds @(0,4,$PID,$ExecutorPid)
    $complete=$complete -and $reconciled.complete;$processes=$reconciled.processes
  } catch {$complete=$false;$reconciled=@{diagnostics=@(@{kind='enumeration_failed';pid=0;name='';parentPid=0})}}
  try {
  # Diagnostic only: candidate fixed observer plumbing must still remain incomplete/held.
  # Never infer an exemption from a producer parent or merely from a signed image.
  function Observer-ImageRole([string]$image) {
    if([string]::Equals($image,$env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe',[StringComparison]::OrdinalIgnoreCase)){return 'powershell'}
    if([string]::Equals($image,$env:SystemRoot+'\System32\wsl.exe',[StringComparison]::OrdinalIgnoreCase)){return 'wsl_system'}
    if([string]::Equals($image,$env:ProgramFiles+'\WSL\wsl.exe',[StringComparison]::OrdinalIgnoreCase)){return 'wsl_store'}
    if([string]::Equals($image,$env:ProgramFiles+'\WSL\wslhost.exe',[StringComparison]::OrdinalIgnoreCase)){return 'wsl_host'}
    if([string]::Equals($image,$env:SystemRoot+'\System32\conhost.exe',[StringComparison]::OrdinalIgnoreCase)){return 'conhost'}
    return ''
  }
  function Observer-TextHash([string]$text) {$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
  $observerProducer=$null;$producerFact=$null
  if($ObserverTask -and $ObserverDefinitionSha256 -match '^[a-f0-9]{64}$' -and $ObserverOwnerSid -match '^S-1-5-[0-9-]+$' -and $ObserverRuntimeSha256 -match '^[a-f0-9]{64}$'){
    $bound=@($tasks|Where-Object{$_.path -ceq $ObserverTask -and $_.definitionSha256 -ceq $ObserverDefinitionSha256 -and $_.principalId -ceq $ObserverOwnerSid -and $_.enginePid -gt 4})
    if($bound.Count -eq 1){
      $pf=@($processes|Where-Object{$_.pid -eq $bound[0].enginePid -and $_.ownerSid -ceq $ObserverOwnerSid -and $_.sha256 -ceq $ObserverRuntimeSha256 -and [string]::Equals($_.path,$OwnedRuntimeExecutable,[StringComparison]::OrdinalIgnoreCase)})
      if($pf.Count -eq 1){$producerFact=$pf[0];$observerProducer=@($endProcesses|Where-Object{$_.ProcessId -eq $producerFact.pid -and $_.CreationDate -is [DateTime] -and $_.CreationDate.ToUniversalTime().Ticks.ToString() -ceq $producerFact.creationTicks})|Select-Object -First 1}
    }
  }
  if($observerProducer){
    $byPid=@{};foreach($x in $endProcesses){$byPid[[string]$x.ProcessId]=$x};$metadataCache=@{};$recorded=0
    foreach($d in $reconciled.diagnostics){
      if($d.kind -cne 'new_instance' -or $recorded -ge 16){continue}
      $at=$byPid[[string]$d.pid];$nodes=@();$valid=$true
      for($depth=0;$depth -lt 4 -and $at -and $at.ProcessId -ne $observerProducer.ProcessId;$depth++){
        $role=Observer-ImageRole ([HitchletProcessImage]::NormalizeLocalDosPath([string]$at.ExecutablePath))
        if(!$role -or $at.CreationDate -isnot [DateTime] -or $at.CreationDate.ToUniversalTime().Ticks -lt $observerProducer.CreationDate.ToUniversalTime().Ticks){$valid=$false;break}
        $nodes+=@($at);$at=$byPid[[string]$at.ParentProcessId]
      }
      if(!$valid -or !$at -or $at.ProcessId -ne $observerProducer.ProcessId -or !$nodes.Count){continue}
      $chain=@()
      foreach($x in $nodes){
        $key=([string]$x.ProcessId)+':'+$x.CreationDate.ToUniversalTime().Ticks.ToString()
        if(!$metadataCache.ContainsKey($key)){
          $m=@{pid=[int]$x.ProcessId;parentPid=[int]$x.ParentProcessId;creationTicks=$x.CreationDate.ToUniversalTime().Ticks.ToString();role=(Observer-ImageRole ([HitchletProcessImage]::NormalizeLocalDosPath([string]$x.ExecutablePath)));status='unavailable';ownerSid=$null;imageSha256=$null;argvSha256=$null;argc=0}
          try {
            $image=[HitchletProcessImage]::NormalizeLocalDosPath([HitchletProcessImage]::Read([int]$x.ProcessId,$x.CreationDate.ToUniversalTime().Ticks))
            if((Observer-ImageRole $image) -cne $m.role){throw 'observer_image_changed'}
            $identity=[HitchletFileIdentity]::Read($image);$m.imageSha256=(Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant()
            $owner=Invoke-CimMethod -InputObject $x -MethodName GetOwnerSid;if($owner.ReturnValue -ne 0 -or ([string]$owner.Sid) -notmatch '^S-1-5-[0-9-]+$'){throw 'observer_owner_unknown'};$m.ownerSid=[string]$owner.Sid
            $arguments=[HitchletObserverArgv]::Read([string]$x.CommandLine);$m.argc=$arguments.Length;$tail=[string[]]@($arguments|Select-Object -Skip 1);$m.argvSha256=Observer-TextHash ($tail.Length.ToString([Globalization.CultureInfo]::InvariantCulture)+':'+[string]::Join([string][char]0,$tail))
            $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$x.ProcessId)
            if(!$current){$m.status='exited'}elseif($current.CreationDate.ToUniversalTime().Ticks -ne $x.CreationDate.ToUniversalTime().Ticks -or $current.ParentProcessId -ne $x.ParentProcessId -or $current.CommandLine -cne $x.CommandLine -or [HitchletFileIdentity]::Read($image) -cne $identity){$m.status='changed'}else{$ownerAfter=Invoke-CimMethod -InputObject $current -MethodName GetOwnerSid;if($ownerAfter.ReturnValue -ne 0 -or $ownerAfter.Sid -cne $m.ownerSid){$m.status='changed'}else{$null=[HitchletProcessImage]::Read([int]$x.ProcessId,$x.CreationDate.ToUniversalTime().Ticks);$m.status='stable'}}
          } catch {$current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$x.ProcessId);if(!$current){$m.status='exited'}}
          $metadataCache[$key]=$m
        }
        $chain+=@($metadataCache[$key])
      }
      $producerNow=Get-CimInstance Win32_Process -Filter ('ProcessId='+$observerProducer.ProcessId)
      if($producerNow -and $producerNow.CreationDate.ToUniversalTime().Ticks -eq $observerProducer.CreationDate.ToUniversalTime().Ticks){$d['observer']=@{producerPid=[int]$observerProducer.ProcessId;producerCreationTicks=$producerFact.creationTicks;chain=$chain};$recorded++}
    }
  }
  } catch {
    # New optional metadata is not safety evidence and must not change the original inventory result.
  }
  [pscustomobject]@{complete=[bool]$complete;wslRunning=$wslRunning;runningDistributions=$distributions;localWslEnumerationComplete=$wslLocalComplete;runningTasks=$tasks;bootRecordId=$boot.bootRecordId;bootTime=$boot.bootTime;processes=$processes;services=$services;diagnostics=$reconciled.diagnostics} | ConvertTo-Json -Depth 6 -Compress
  exit
}
# Native local API only. Never use shutdown.exe /t (which implies force for nonzero timeouts).
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HitchletNormalShutdown {
 // ERROR_NO_SHUTDOWN_IN_PROGRESS is safe only for abort, including a repeated watchdog cancellation.
 public static bool Confirmed(bool ok,bool abort,int error) {return ok || (abort && error==1116);}
 // Only the still-live original executor may acknowledge no outstanding submitter and confirmed Abort.
 public static bool SettledCancellationValid(string state,string cycle,string expectedCycle,int parentPid,int expectedPid,long parentStart,long expectedStart,bool parentAlive) {
   return state=="settled_cancelled" && !String.IsNullOrEmpty(expectedCycle) && String.Equals(cycle,expectedCycle,StringComparison.Ordinal) && parentAlive && parentPid>0 && parentPid==expectedPid && parentStart>0 && parentStart==expectedStart;
 }
 [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
 public static long UptimeMs() {return checked((long)GetTickCount64());}
 public static bool PermitValid(long uptimeNowMs,long notAfterUptimeMs,long utcNowMs,long controllerNotAfterMs) {return uptimeNowMs>=0 && notAfterUptimeMs>uptimeNowMs && controllerNotAfterMs>0 && controllerNotAfterMs>utcNowMs;}
 [StructLayout(LayoutKind.Sequential)] struct LUID { public uint Low; public int High; }
 [StructLayout(LayoutKind.Sequential)] struct TP { public uint Count; public LUID Luid; public uint Attributes; }
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LookupPrivilegeValue(string system,string name,out LUID luid);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token,bool disable,ref TP state,uint size,IntPtr previous,IntPtr required);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern bool InitiateSystemShutdownExW(string machine,string message,uint timeout,bool force,bool reboot,uint reason);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern bool AbortSystemShutdownW(string machine);
 public static bool Run(bool abort,long notAfterUptimeMs=0,long controllerNotAfterMs=0,int executorPid=0,long startedTicks=0) {
   IntPtr token; if(!OpenProcessToken(GetCurrentProcess(),0x28,out token))throw new InvalidOperationException("shutdown_privilege_unavailable");
   try { LUID luid; if(!LookupPrivilegeValue(null,"SeShutdownPrivilege",out luid))throw new InvalidOperationException("shutdown_privilege_unavailable"); TP state=new TP{Count=1,Luid=luid,Attributes=2}; if(!AdjustTokenPrivileges(token,false,ref state,0,IntPtr.Zero,IntPtr.Zero)||Marshal.GetLastWin32Error()!=0)throw new InvalidOperationException("shutdown_privilege_unavailable");
     if(!abort) {var p=System.Diagnostics.Process.GetProcessById(executorPid);if(p.HasExited||p.StartTime.ToUniversalTime().Ticks!=startedTicks||!PermitValid(UptimeMs(),notAfterUptimeMs,DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),controllerNotAfterMs))throw new InvalidOperationException("shutdown_permit_expired_or_parent_lost");}
     bool ok=abort?AbortSystemShutdownW(null):InitiateSystemShutdownExW(null,"Hitchlet: normal idle shutdown; sign in to cancel",60,false,false,0x80000000|0x00040000);
     int error=Marshal.GetLastWin32Error(); if(!Confirmed(ok,abort,error))throw new InvalidOperationException("native_power_request_failed_"+error); return true;
   } finally {CloseHandle(token);}
 }
}
'@
if ($Action -eq 'watch') {
  Assert-PrivatePath $LeaseFile
  $parent=Get-Process -Id $ExecutorPid -ErrorAction Stop
  $parentStart=$parent.StartTime.ToUniversalTime().Ticks
  $initialLease=Get-Content -LiteralPath $LeaseFile -Raw | ConvertFrom-Json
  $watchCycleId=[string]$initialLease.cycleId
  $parsedCycle=[guid]::Empty
  if($initialLease.state -cne 'armed' -or ![guid]::TryParseExact($watchCycleId,'D',[ref]$parsedCycle)) {throw 'watch_initial_cycle_invalid'}
  $until=[HitchletNormalShutdown]::UptimeMs()+120000
  $unsafe=$false;$announced=$false
  $chain=@(Get-CimInstance Win32_Process -Filter "ProcessId=$WatchLauncherPid OR ProcessId=$PID")
  $launcher=@($chain | Where-Object {$_.ProcessId -eq $WatchLauncherPid})
  $self=@($chain | Where-Object {$_.ProcessId -eq $PID})
  if($WatchLauncherPid -le 0 -or $launcher.Count -ne 1 -or $self.Count -ne 1 -or $launcher[0].ParentProcessId -ne $ExecutorPid -or $self[0].ParentProcessId -ne $WatchLauncherPid) {throw 'watch_launch_chain_invalid'}
  $ready=@{event='ready';launcherPid=$WatchLauncherPid;launcherStartedTicks=(Get-Process -Id $WatchLauncherPid).StartTime.ToUniversalTime().Ticks.ToString();watchPid=$PID;watchStartedTicks=(Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks.ToString()}
  [Console]::WriteLine(($ready | ConvertTo-Json -Compress));[Console]::Out.Flush()
  while ([HitchletNormalShutdown]::UptimeMs() -lt $until) {
    try {
      $lease=Get-Content -LiteralPath $LeaseFile -Raw | ConvertFrom-Json
      if ([string]$lease.cycleId -cne $watchCycleId) {throw 'watch_cycle_changed'}
      $current=Get-Process -Id $ExecutorPid -ErrorAction Stop
      $parentAlive=(!$current.HasExited -and $current.StartTime.ToUniversalTime().Ticks -eq $parentStart)
      if ([HitchletNormalShutdown]::SettledCancellationValid([string]$lease.state,[string]$lease.cycleId,$watchCycleId,[int]$lease.executorPid,$ExecutorPid,[long]$lease.executorStartedTicks,$parentStart,$parentAlive)) {exit}
      if ($lease.state -ceq 'cancelled' -and !$unsafe -and $parentAlive) {exit}
      if (!$parentAlive -or $lease.state -cne 'armed' -or [long]$lease.expiresAtUptimeMs -le [HitchletNormalShutdown]::UptimeMs()) {$unsafe=$true}
    } catch {$unsafe=$true}
    if ($unsafe) {
      # Keep aborting after lost/dead parents or unproven cancellation: a spawned submitter may run late.
      # Only a live original parent with all submitters closed and confirmed Abort may end this early.
      try {[void][HitchletNormalShutdown]::Run($true)} catch {}
      if (!$announced) {try {[Console]::WriteLine('{"event":"aborting"}');[Console]::Out.Flush()} catch {}; $announced=$true}
    }
    Start-Sleep -Milliseconds 500
  }
  try {[void][HitchletNormalShutdown]::Run($true)} catch {}
  exit
}
if ($Action -eq 'shutdown') {
  try {
    Assert-PrivatePath $LeaseFile
    $lease=Get-Content -LiteralPath $LeaseFile -Raw | ConvertFrom-Json
    if ($lease.cycleId -ne $CycleId -or $lease.state -ne 'armed' -or [long]$lease.expiresAtUptimeMs -le [HitchletNormalShutdown]::UptimeMs()) {throw 'shutdown_watchdog_lease_invalid'}
    $accepted=[HitchletNormalShutdown]::Run($false,$NotAfterUptimeMs,$ControllerNotAfterMs,$ExecutorPid,$ExecutorStartedTicks)
  } catch {
    # Fixed classifications only. Ordinary ACL/script errors remain ordinary failure, never transient.
    $message=$_.Exception.GetBaseException().Message
    if ($message -ceq 'shutdown_permit_expired_or_parent_lost') {exit 73}
    if ($message -ceq 'shutdown_watchdog_lease_invalid') {exit 74}
    if ($message -ceq 'shutdown_privilege_unavailable') {exit 75}
    if ($message -cmatch '^native_power_request_failed_[0-9]{1,10}$') {exit 76}
    throw
  }
} else {$accepted=[HitchletNormalShutdown]::Run($true)}
[pscustomobject]@{accepted=[bool]$accepted} | ConvertTo-Json -Compress
