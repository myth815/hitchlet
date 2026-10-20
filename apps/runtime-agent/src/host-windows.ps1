# Read-only WTS enumeration. No account-name exclusions: service accounts logged on interactively count.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class HitchletSessions {
 [StructLayout(LayoutKind.Sequential)] public struct Session { public int Id; public IntPtr Station; public int State; }
 public class Item { public int id; public string user; public string domain; public int state; public int protocol; }
 [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool WTSEnumerateSessions(IntPtr server,int reserved,int version,out IntPtr sessions,out int count);
 [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool WTSQuerySessionInformation(IntPtr server,int session,int info,out IntPtr buffer,out int bytes);
 [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
 static string Query(int id,int info) { IntPtr p; int bytes; if(!WTSQuerySessionInformation(IntPtr.Zero,id,info,out p,out bytes)) throw new InvalidOperationException("wts_query_failed"); try { return Marshal.PtrToStringUni(p) ?? ""; } finally { WTSFreeMemory(p); } }
 static int Protocol(int id) { IntPtr p; int bytes; if(!WTSQuerySessionInformation(IntPtr.Zero,id,16,out p,out bytes)) throw new InvalidOperationException("wts_protocol_failed"); try { if(bytes<2)throw new InvalidOperationException("wts_protocol_incomplete"); return (int)(ushort)Marshal.ReadInt16(p); } finally {WTSFreeMemory(p);} }
 public static Item[] Read() { IntPtr p; int count; if(!WTSEnumerateSessions(IntPtr.Zero,0,1,out p,out count)) throw new InvalidOperationException("wts_enumeration_failed"); var result=new List<Item>(); try { for(int i=0;i<count;i++){var s=(Session)Marshal.PtrToStructure(IntPtr.Add(p,i*Marshal.SizeOf(typeof(Session))),typeof(Session)); string user=Query(s.Id,5); if(user.Length>0)result.Add(new Item{id=s.Id,user=user,domain=Query(s.Id,7),state=s.State,protocol=Protocol(s.Id)});} } finally {WTSFreeMemory(p);} return result.ToArray(); }
}
'@
$system = Get-CimInstance -ClassName Win32_ComputerSystem
# The administrator pairs this native service on the physical Machine. WMI provides known-guest
# negative evidence, not cryptographic proof: nested virtualization/spoofed SMBIOS require deployment review.
$vendor = [string]$system.Manufacturer
$model = [string]$system.Model
$product = Get-CimInstance -ClassName Win32_ComputerSystemProduct
$systemUuid = [Guid]::Empty
$validUuid = [Guid]::TryParse([string]$product.UUID, [ref]$systemUuid) -and $systemUuid -ne [Guid]::Empty
$nativeIdentityAvailable = $validUuid -and -not [string]::IsNullOrWhiteSpace([string]$product.UUID) -and -not [string]::IsNullOrWhiteSpace($vendor) -and -not [string]::IsNullOrWhiteSpace($model)
$virtualModel = ($vendor + ' ' + $model) -match 'Virtual|VMware|KVM|QEMU|Xen|Parallels|Hyper-V|Amazon|Google'
if (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\ContainerType') { $virtualModel = $true }
[pscustomobject]@{ physical = [bool]($nativeIdentityAvailable -and -not $virtualModel); complete = $true; sessions = @([HitchletSessions]::Read()) } | ConvertTo-Json -Depth 5 -Compress
