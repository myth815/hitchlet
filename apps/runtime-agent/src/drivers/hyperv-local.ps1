# Internal fixed native actions. JSON stdin contains VM ownership/spec or bounded console input.
# This file never enables Hyper-V, changes a host switch/firewall or creates credentials.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$r=[Console]::In.ReadToEnd() | ConvertFrom-Json
if($r.action -notin @('facts','prepare','inspect','import','configure','start','stop','remove','console')){throw 'hyperv_action_unsupported'}
$available=$null -ne (Get-Command Get-VM -ErrorAction SilentlyContinue)
if($r.action -eq 'facts'){
 $facts=@{available=$available;hostArchitecture=[string]$env:PROCESSOR_ARCHITECTURE;implementedOperations=@('inspect','import','configure','start','stop','remove')}
 if($available){
  $computer=Get-CimInstance Win32_ComputerSystem
  $module=Get-Module Hyper-V -ListAvailable | Sort-Object Version -Descending | Select-Object -First 1
  $facts.hostOS='windows';$facts.hostCpuCount=[int]$computer.NumberOfLogicalProcessors;$facts.hostMemoryBytes=[long]$computer.TotalPhysicalMemory;$facts.hyperVVersion=$module.Version.ToString()
 }
 $facts | ConvertTo-Json -Depth 8 -Compress
 exit
}
if(!$available){throw 'hyperv_tools_unavailable'}
function Full([string]$p){return [IO.Path]::GetFullPath($p).TrimEnd('\')}
function Inside([string]$root,[string]$p){return (Full $p).StartsWith((Full $root)+'\',[StringComparison]::OrdinalIgnoreCase)}
$directory=Full $r.directory
if($directory -notmatch '^[A-Za-z]:\\' -or (Split-Path -Leaf $directory) -notmatch '^[a-f0-9]{64}$'){throw 'hyperv_directory_not_owned_root'}
if(!$r.owner.StartsWith('hitchlet/v1/'+(Split-Path -Leaf $directory))){throw 'hyperv_owner_key_mismatch'}
$marker=Join-Path $directory '.hitchlet-owner.json'
function Assert-NoReparse([string]$path){
 $p=$path
 while($p){
  if(Test-Path -LiteralPath $p){if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'hyperv_reparse_path'}}
  $next=Split-Path -Parent $p;if($next -eq $p){break};$p=$next
 }
}
function Assert-Tree([string]$path){
 Assert-NoReparse $path
 $pending=New-Object 'System.Collections.Generic.Stack[string]';$pending.Push($path)
 while($pending.Count){
  foreach($item in Get-ChildItem -LiteralPath $pending.Pop() -Force){
   if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'hyperv_owned_tree_reparse'}
   if($item.PSIsContainer){$pending.Push($item.FullName)}
  }
 }
}
function Read-Marker{
 Assert-NoReparse $marker
 $m=Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
 if($m.owner -cne $r.owner -or $m.specHash -cne $r.specHash){throw 'hyperv_directory_owner_mismatch'}
 return $m
}
function Write-Marker([string]$phase){
 $tmp=$marker+'.tmp';[IO.File]::WriteAllText($tmp,(@{owner=$r.owner;specHash=$r.specHash;phase=$phase}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 Move-Item -LiteralPath $tmp -Destination $marker -Force
}
function Find-OwnedVm{
 # Query errors remain errors. A hidden/inaccessible known ID is never called absent.
 $all=@(Get-VM -ErrorAction Stop)
 if($r.vmId){
  $id=[Guid]::Parse([string]$r.vmId)
  $systems=@(Get-CimInstance -Namespace 'root/virtualization/v2' -ClassName Msvm_ComputerSystem -Filter ("Name='"+$id.ToString()+"'") -ErrorAction Stop)
  $found=@($all | Where-Object {$_.Id -eq $id})
  $others=@($all | Where-Object {$_.Id -ne $id -and (Inside $directory $_.ConfigurationLocation)})
  if($others.Count -gt 0){throw 'hyperv_untracked_vm_in_allocation_directory'}
  if($systems.Count -gt 0 -and $found.Count -eq 0){throw 'hyperv_known_vm_not_visible'}
 }else{
  $found=@($all | Where-Object {(Inside $directory $_.ConfigurationLocation) -or $_.Notes -ceq $r.owner})
 }
 if($found.Count -gt 1){throw 'hyperv_native_identity_ambiguous'}
 if($found.Count -eq 0){return $null}
 return $found[0]
}
function Vm-Observation($vm){
 $m=Read-Marker
 if($vm.Notes -cne $r.owner){throw 'hyperv_vm_owner_not_confirmed'}
 $attached=@(Get-VMHardDiskDrive -VM $vm -ErrorAction Stop | ForEach-Object {[string]$_.Path})
 $paths=New-Object 'System.Collections.Generic.List[string]'
 foreach($disk in $attached){
  $chain=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $current=$disk
  while($current){
   if(!(Inside $directory $current)){throw 'hyperv_disk_parent_outside_allocation'}
   Assert-NoReparse $current
   if(!$chain.Add((Full $current))){throw 'hyperv_disk_parent_cycle'}
   if(!$paths.Contains($current)){$paths.Add($current)}
   $current=[string](Get-VHD -Path $current -ErrorAction Stop).ParentPath
  }
 }
 $disks=@($paths.ToArray())
 foreach($p in @($vm.ConfigurationLocation,$vm.SnapshotFileLocation,$vm.SmartPagingFilePath)+$disks){
  if($p -and !(Inside $directory $p)){throw 'hyperv_native_path_outside_allocation'}
  if($p){Assert-NoReparse $p}
 }
 $cpu=Get-VMProcessor -VM $vm -ErrorAction Stop
 $memory=Get-VMMemory -VM $vm -ErrorAction Stop
 $nics=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
 $addresses=@($nics | ForEach-Object {$_.IPAddresses} | Where-Object {$_ -match '^\d{1,3}(\.\d{1,3}){3}$'})
 $state='other';if([string]$vm.State -eq 'Running'){$state='running'}elseif([string]$vm.State -eq 'Off'){$state='stopped'}
 return @{presence='present';inventoryComplete=$true;directoryPresent=$true;vm=@{id=$vm.Id.ToString();owner=[string]$r.owner;directory=$directory;configurationPath=[string]$vm.ConfigurationLocation;diskPaths=$disks;cpus=[int]$cpu.Count;memoryMiB=[int64]($memory.Startup/1MB);dynamicMemory=[bool]$memory.DynamicMemoryEnabled;generation=[int]$vm.Generation;state=$state;switchNames=@($nics | ForEach-Object {[string]$_.SwitchName});dynamicMac=($nics.Count -eq 1 -and [bool]$nics[0].DynamicMacAddressEnabled);ipv4=$addresses}}
}
function Observe{
 $vm=Find-OwnedVm
 if($vm){return Vm-Observation $vm}
 if(Test-Path -LiteralPath $directory){
  if((Test-Path -LiteralPath $marker) -or !(($r.vmId) -and @(Get-ChildItem -LiteralPath $directory -Force).Count -eq 0)){$null=Read-Marker}
  return @{presence='unknown';inventoryComplete=$true;directoryPresent=$true;reason='owned_files_remain'}
 }
 return @{presence='absent';inventoryComplete=$true;directoryPresent=$false}
}
function Get-OwnedVm{
 $vm=Find-OwnedVm
 if(!$vm){return $null}
 $null=Vm-Observation $vm
 return $vm
}
function Check-Template{
 if($env:PROCESSOR_ARCHITECTURE -ne 'AMD64'){throw 'hyperv_native_amd64_required'}
 if(!$r.spec -or $r.spec.template.configPath -notmatch '\.vmcx$'){throw 'hyperv_template_invalid'}
 if((Get-FileHash -LiteralPath $r.spec.template.configPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $r.spec.template.configSha256){throw 'hyperv_template_config_changed'}
 if($r.spec.resources.cpus -lt 1 -or $r.spec.resources.memoryMiB -lt 512){throw 'hyperv_resources_invalid'}
 if(@(Get-VMSwitch -ErrorAction Stop | Where-Object {$_.Name -ceq $r.spec.switchName}).Count -ne 1){throw 'hyperv_existing_switch_unavailable'}
}
Assert-NoReparse $directory
if($r.action -eq 'prepare'){
 Check-Template
 if(!(Test-Path -LiteralPath (Split-Path -Parent $directory))){throw 'hyperv_work_root_missing'}
 @{prepared=$true}|ConvertTo-Json -Compress;exit
}
if($r.action -eq 'import'){
 $before=Observe
 if($before.presence -ne 'absent'){throw 'hyperv_import_must_not_repeat'}
 Check-Template
 New-Item -ItemType Directory -Path $directory | Out-Null
 Write-Marker 'importing'
 $vm=Import-VM -Path $r.spec.template.configPath -Copy -GenerateNewId -VirtualMachinePath (Join-Path $directory 'vm') -VhdDestinationPath (Join-Path $directory 'disks') -SnapshotFilePath (Join-Path $directory 'checkpoints') -SmartPagingFilePath (Join-Path $directory 'paging') -Confirm:$false -ErrorAction Stop
 $r.vmId=$vm.Id.ToString()
 # Persist native ownership before resource/network configuration or guest start.
 Set-VM -VM $vm -Notes $r.owner -ErrorAction Stop
 Write-Marker 'owned'
}
if($r.action -eq 'configure'){
 $vm=Get-OwnedVm;if(!$vm -or [string]$vm.State -ne 'Off'){throw 'hyperv_configuration_requires_owned_stopped_vm'}
 Check-Template
 $nics=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop);if($nics.Count -ne 1){throw 'hyperv_single_nic_required'}
 Set-VM -VM $vm -Notes $r.owner -AutomaticStartAction Nothing -ErrorAction Stop
 Set-VMProcessor -VM $vm -Count $r.spec.resources.cpus -ErrorAction Stop
 Set-VMMemory -VM $vm -DynamicMemoryEnabled $false -StartupBytes ([int64]$r.spec.resources.memoryMiB*1MB) -ErrorAction Stop
 Set-VMNetworkAdapter -VMNetworkAdapter $nics[0] -DynamicMacAddress -ErrorAction Stop
 Connect-VMNetworkAdapter -VMNetworkAdapter $nics[0] -SwitchName $r.spec.switchName -ErrorAction Stop
 Write-Marker 'owned'
}
if($r.action -eq 'start'){
 $vm=Get-OwnedVm;if(!$vm){throw 'hyperv_vm_missing'}
 if([string]$vm.State -ne 'Running'){Start-VM -VM $vm -ErrorAction Stop | Out-Null}
}
if($r.action -in @('stop','remove')){
 $vm=Get-OwnedVm
 if($vm -and [string]$vm.State -ne 'Off'){Stop-VM -VM $vm -TurnOff -Confirm:$false -ErrorAction Stop | Out-Null}
 if($r.action -eq 'remove'){
  if($vm){
   $vm=Get-OwnedVm;if([string]$vm.State -ne 'Off'){throw 'hyperv_stop_not_confirmed'}
   Remove-VM -VM $vm -Force -Confirm:$false -ErrorAction Stop
  }
  if(Find-OwnedVm){throw 'hyperv_vm_still_present'}
  # Remove-VM does not delete VHDX. Only the exact marked allocation tree is removed.
  if(Test-Path -LiteralPath $directory){
   Assert-Tree $directory
   $children=@(Get-ChildItem -LiteralPath $directory -Force)
   if($children.Count -gt 0){
    $null=Read-Marker
    # Keep the ownership marker through any busy-file/partial deletion failure.
    foreach($item in $children){if($item.FullName -ine $marker){Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop}}
    Remove-Item -LiteralPath $marker -Force -ErrorAction Stop
   }elseif(!$r.vmId){throw 'hyperv_empty_directory_identity_unknown'}
   [IO.Directory]::Delete($directory)
  }
 }
}
if($r.action -eq 'console'){
 $vm=Get-OwnedVm
 if(!$vm -or [string]$vm.State -ne 'Running'){throw 'console_owned_running_vm_required'}
 $system=@(Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_ComputerSystem -Filter ("Name='"+$vm.Id.ToString()+"'"))
 if($system.Count -ne 1){throw 'console_vm_identity_unknown'}
 $kind=[string]$r.console.kind
 if($kind -eq 'access'){
  $null=Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_Keyboard -List
  $null=Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_VirtualSystemManagementService -List
  @{status='available'}|ConvertTo-Json -Compress;exit
 }
 if($kind -eq 'frame'){
  $width=[int]$r.console.width;$height=[int]$r.console.height
  if($width -lt 16 -or $width -gt 1024 -or $height -lt 16 -or $height -gt 768){throw 'console_frame_bounds'}
  $settings=@($system[0].GetRelated('Msvm_VirtualSystemSettingData','Msvm_SettingsDefineState',$null,$null,'SettingData','ManagedElement',$false,$null))
  $manager=@(Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_VirtualSystemManagementService)
  if($settings.Count -ne 1 -or $manager.Count -ne 1){throw 'console_setting_ambiguous'}
  $params=$manager[0].GetMethodParameters('GetVirtualSystemThumbnailImage')
  $params['TargetSystem']=$settings[0].Path.Path;$params['WidthPixels']=[UInt16]$width;$params['HeightPixels']=[UInt16]$height
  $out=$manager[0].InvokeMethod('GetVirtualSystemThumbnailImage',$params,$null)
  if([UInt32]$out['ReturnValue'] -ne 0){throw 'console_frame_not_completed'}
  [byte[]]$pixels=$out['ImageData'];if($pixels.Length -ne 2*$width*$height){throw 'console_frame_length'}
  @{status='captured';frame=@{width=$width;height=$height;pixelFormat='rgb565le';dataBase64=[Convert]::ToBase64String($pixels)}}|ConvertTo-Json -Depth 4 -Compress;exit
 }
 if($kind -in @('key','text','secure_attention')){
  $keyboard=@($system[0].GetRelated('Msvm_Keyboard'))
  if($keyboard.Count -ne 1){throw 'console_keyboard_ambiguous'}
  if($kind -eq 'secure_attention'){
   $out=$keyboard[0].TypeCtrlAltDel()
  }elseif($kind -eq 'text'){
   $text=[string]$r.console.text;if($text.Length -lt 1 -or $text.Length -gt 2048){throw 'console_text_bounds'}
   $out=$keyboard[0].TypeText($text)
  }else{
   $key=[int]$r.console.keyCode;if($key -lt 1 -or $key -gt 255){throw 'console_key_bounds'}
   $out=$keyboard[0].TypeKey([UInt32]$key)
  }
 }elseif($kind -eq 'pointer'){
  $mouse=@($system[0].GetRelated('Msvm_SyntheticMouse'))
  if($mouse.Count -ne 1){throw 'console_mouse_ambiguous'}
  $x=[int]$r.console.x;$y=[int]$r.console.y
  if($x -lt 0 -or $x -gt 65535 -or $y -lt 0 -or $y -gt 65535){throw 'console_pointer_bounds'}
  $out=$mouse[0].SetAbsolutePosition([Int32]$x,[Int32]$y)
  if([UInt32]$out.ReturnValue -ne 0){throw 'console_pointer_not_completed'}
  if($r.console.click -eq $true){$out=$mouse[0].ClickButton([UInt32]1)}
 }else{throw 'console_action_invalid'}
 if([UInt32]$out.ReturnValue -ne 0){throw 'console_input_not_completed'}
 @{status='completed'}|ConvertTo-Json -Compress;exit
}
Observe | ConvertTo-Json -Depth 12 -Compress
