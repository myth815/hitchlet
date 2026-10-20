param([ValidateSet('inventory','boot','permissions','watch','shutdown','abort')][string]$Action='inventory', [string]$CacheFile='', [string]$ProtectedPath='', [string]$LeaseFile='', [int]$ExecutorPid=0, [long]$ExecutorStartedTicks=0, [long]$NotAfterUptimeMs=0, [long]$ControllerNotAfterMs=0, [string]$CycleId='', [int]$WatchLauncherPid=0, [long]$WatchLauncherStartedTicks=0, [int]$WatchHelperPid=0, [long]$WatchHelperStartedTicks=0)
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
  $complete=$true
  $processes=@($liveProcesses | Where-Object {$_.ProcessId -notin @(0,4)} | ForEach-Object {
    $p=$_; $path=[string]$p.ExecutablePath; $hash=''; $signed=$false; $thumbprint=''; $creationTicks=''
    if($p.CreationDate -is [DateTime]) {$creationTicks=$p.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)}
    # Kernel pseudo-processes have no userspace executable and cannot carry an arbitrary task.
    if ($p.ParentProcessId -eq 4 -and $p.Name -in @('Registry','Memory Compression','Secure System')) { return }
    if ($p.ProcessId -eq $PID -or $p.ProcessId -eq $ExecutorPid) { return }
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
        if (!$env:SystemDrive -or !$path.StartsWith($env:SystemDrive+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'image_outside_system_volume'}
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
    } catch {$complete=$false}
    [pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;name=[string]$p.Name;path=$path;sha256=$hash;microsoftSigned=[bool]$signed;signerThumbprint=$thumbprint;creationTicks=$creationTicks}
  })
  $services=@($liveServices | Where-Object {$_.State -eq 'Running'} | ForEach-Object { [pscustomobject]@{name=[string]$_.Name;pid=[int]$_.ProcessId} })
  # wslservice is a daemon, not a running distribution; vmmemWSL may have no .exe suffix.
  $wslRunning=[bool](@($processes | Where-Object {$_.name -match '^(vmmem.*|wslhost|wslrelay)(\.exe)?$'}).Count -gt 0)
  $tasks=@($liveTasks | Where-Object {$_.State -eq 'Running'} | ForEach-Object { $task=$_; foreach($a in $task.Actions) {[pscustomobject]@{path=([string]$task.TaskPath+[string]$task.TaskName);executable=[string]$a.Execute;arguments=[string]$a.Arguments}} })
  if ($CacheFile) {
    try { $temp=$CacheFile+'.tmp'; $cache | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $temp -Encoding UTF8; Move-Item -LiteralPath $temp -Destination $CacheFile -Force }
    catch {
      if ($_.CategoryInfo.Category -in @('PermissionDenied','SecurityError') -or $_.Exception -is [UnauthorizedAccessException] -or $_.Exception -is [System.Security.SecurityException]) {exit 71}
      # Retry only explicit Windows sharing/lock violations, not arbitrary storage/configuration errors.
      if (($_.Exception.HResult -band 0xffff) -in @(32,33)) {exit 70}
      exit 72
    }
  }
  [pscustomobject]@{complete=[bool]$complete;wslRunning=$wslRunning;runningTasks=$tasks;bootRecordId=$boot.bootRecordId;bootTime=$boot.bootTime;processes=$processes;services=$services} | ConvertTo-Json -Depth 6 -Compress
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
