import { describe, expect, it } from "vitest";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NativeBootRecordSchema,
  nativeBootId,
} from "../src/host-power-storage.js";
import { nativeUptimeMs } from "../src/host-power.js";

/** Uses the exact production Add-Type block; no second implementation of the timestamp rule. */
describe.runIf(process.platform === "win32")(
  "native limited process image fallback",
  () => {
    it("reads the same immutable real System startup event twice without relying on CIM boot time", async () => {
      const production = fileURLToPath(
        new URL("../src/host-power-windows.ps1", import.meta.url),
      );
      const read = async () => {
        const { stdout } = await promisify(execFile)(
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-File",
            production,
            "-Action",
            "boot",
            "-ExecutorPid",
            String(process.pid),
          ],
          {
            timeout: 15000,
            maxBuffer: 4096,
            windowsHide: true,
            encoding: "utf8",
          },
        );
        const raw = JSON.parse(stdout) as Record<string, unknown>;
        return NativeBootRecordSchema.parse({
          bootRecordId: raw.bootRecordId,
          bootTime: raw.bootTime,
        });
      };
      const first = await read(),
        second = await read();
      expect(second).toEqual(first);
      expect(nativeBootId(first.bootRecordId, first.bootTime)).toBe(
        nativeBootId(second.bootRecordId, second.bootTime),
      );
    });
    it("rejects missing/invalid boot events without a CIM or current-time fallback in the production reader", async () => {
      const source = await readFile(
        new URL("../src/host-power-windows.ps1", import.meta.url),
        "utf8",
      );
      const reader = source.match(
        /function Read-BootInstance \{[\s\S]*?\r?\n\}/,
      )?.[0];
      expect(reader).toBeTruthy();
      const dir = await mkdtemp(join(tmpdir(), "hitchlet-boot-event-"));
      try {
        const script = join(dir, "boot-event-test.ps1");
        await writeFile(
          script,
          `$ErrorActionPreference='Stop'
${reader}
function Get-CimInstance {throw 'cim_boot_fallback_forbidden'}
function Get-Date {throw 'wall_clock_fallback_forbidden'}
function Get-WinEvent {param($FilterHashtable,$MaxEvents,$ErrorAction)
 if($FilterHashtable.LogName -cne 'System' -or $FilterHashtable.ProviderName -cne 'Microsoft-Windows-Kernel-General' -or $FilterHashtable.Id -ne 12 -or $MaxEvents -ne 1){throw 'wrong_boot_query'}
 return $script:event
}
function New-FixtureEvent($record,$data) {
 $e=[pscustomobject]@{LogName='System';ProviderName='Microsoft-Windows-Kernel-General';Id=12;RecordId=$record;Xml=('<Event><EventData>'+ $data +'</EventData></Event>')}
 $e|Add-Member -MemberType ScriptMethod -Name ToXml -Value {return $this.Xml}
 return $e
}
$script:event=New-FixtureEvent 123 '<Data Name="StartTime">2026-10-20T10:00:00.1234567Z</Data>'
$first=Read-BootInstance
$second=Read-BootInstance
if($first.bootRecordId -cne '123' -or $first.bootTime -cne '2026-10-20T10:00:00.1234567Z' -or $second.bootTime -cne $first.bootTime){throw 'boot_event_not_stable'}
$bad=@($null,(New-FixtureEvent 0 '<Data Name="StartTime">2026-10-20T10:00:00Z</Data>'),(New-FixtureEvent 123 '<Data Name="StartTime">invalid</Data>'),(New-FixtureEvent 123 ''),(New-FixtureEvent 123 '<Data Name="StartTime">2026-10-20T10:00:00Z</Data><Data Name="StartTime">2026-10-20T10:00:00Z</Data>'))
$rejected=0
foreach($candidate in $bad){$script:event=$candidate;try{[void](Read-BootInstance)}catch{if($_.Exception.Message -match 'fallback_forbidden'){throw};$rejected++}}
if($rejected -ne $bad.Count){throw 'invalid_boot_event_allowed'}
@{stable=$true;invalidRejected=$rejected;noFallback=$true}|ConvertTo-Json -Compress
`,
          "utf8",
        );
        const { stdout } = await promisify(execFile)(
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script],
          {
            timeout: 15000,
            maxBuffer: 4096,
            windowsHide: true,
            encoding: "utf8",
          },
        );
        expect(JSON.parse(stdout)).toEqual({
          stable: true,
          invalidRejected: 5,
          noFallback: true,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    it("confirms only successful API calls or abort's known no-pending state without calling any power API", async () => {
      const source = await readFile(
        new URL("../src/host-power-windows.ps1", import.meta.url),
        "utf8",
      );
      const native = [
        ...source.matchAll(
          /Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/g,
        ),
      ][1]?.[1];
      expect(native).toContain("public static class HitchletNormalShutdown");
      const dir = await mkdtemp(join(tmpdir(), "hitchlet-abort-confirm-"));
      try {
        const script = join(dir, "abort-confirmation-test.ps1");
        await writeFile(
          script,
          `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${native}
'@
$cases=@(@($true,$true,0,$true),@($true,$false,0,$true),@($false,$true,1116,$true),@($false,$false,1116,$false),@($false,$true,5,$false),@($false,$false,5,$false),@($false,$true,0,$false))
foreach($case in $cases){if([HitchletNormalShutdown]::Confirmed($case[0],$case[1],$case[2]) -ne $case[3]){throw 'unexpected_abort_confirmation'}}
$permits=@(@(1000,6000,1000000,1005000,$true),@(6000,6000,1,1005000,$false),@(6001,6000,1,1005000,$false),@(2000,6000,1005000,1005000,$false),@(2000,6000,1,1005000,$true),@(-1,6000,1,1005000,$false))
foreach($case in $permits){if([HitchletNormalShutdown]::PermitValid($case[0],$case[1],$case[2],$case[3]) -ne $case[4]){throw 'unexpected_permit_deadline'}}
$cycle='11111111-1111-4111-8111-111111111111'
$other='22222222-2222-4222-8222-222222222222'
$settled=@(@('settled_cancelled',$cycle,$cycle,17,17,123,123,$true,$true),@('cancelled',$cycle,$cycle,17,17,123,123,$true,$false),@('armed',$cycle,$cycle,17,17,123,123,$true,$false),@('settled_cancelled',$other,$cycle,17,17,123,123,$true,$false),@('settled_cancelled',$cycle,'',17,17,123,123,$true,$false),@('settled_cancelled',$cycle,$cycle,18,17,123,123,$true,$false),@('settled_cancelled',$cycle,$cycle,17,17,124,123,$true,$false),@('settled_cancelled',$cycle,$cycle,17,17,123,123,$false,$false),@('settled_cancelled',$cycle,$cycle,0,0,123,123,$true,$false),@('settled_cancelled',$cycle,$cycle,17,17,0,0,$true,$false))
foreach($case in $settled){if([HitchletNormalShutdown]::SettledCancellationValid($case[0],$case[1],$case[2],$case[3],$case[4],$case[5],$case[6],$case[7]) -ne $case[8]){throw 'unexpected_settled_cancellation'}}
@{cases=$cases.Count;permitCases=$permits.Count;settledCases=$settled.Count;uptimeMs=[HitchletNormalShutdown]::UptimeMs();noPowerApiCalled=$true}|ConvertTo-Json -Compress
`,
          "utf8",
        );
        const beforeUptime = nativeUptimeMs();
        const { stdout } = await promisify(execFile)(
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script],
          {
            timeout: 15000,
            maxBuffer: 4096,
            windowsHide: true,
            encoding: "utf8",
          },
        );
        const afterUptime = nativeUptimeMs();
        const result = JSON.parse(stdout) as { uptimeMs: number };
        expect(result).toEqual({
          cases: 7,
          permitCases: 6,
          settledCases: 10,
          uptimeMs: expect.any(Number),
          noPowerApiCalled: true,
        });
        expect(result.uptimeMs).toBeGreaterThanOrEqual(beforeUptime);
        // Node's floor(seconds*1000) can round one tick down; no wall-clock tolerance is involved.
        expect(result.uptimeMs).toBeLessThanOrEqual(afterUptime + 1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    it("marks only live-enumeration unavailability retryable and separates permission failure in the production helper", async () => {
      const source = await readFile(
        new URL("../src/host-power-windows.ps1", import.meta.url),
        "utf8",
      );
      const dir = await mkdtemp(join(tmpdir(), "hitchlet-inventory-errors-"));
      try {
        for (const [name, body, expected] of [
          ["unavailable", "throw 'fixture_unavailable'", 70],
          [
            "permission",
            "throw [UnauthorizedAccessException]::new('fixture_denied')",
            71,
          ],
        ] as const) {
          const script = join(dir, `${name}.ps1`);
          await writeFile(
            script,
            source.replace(
              "$ErrorActionPreference='Stop'",
              `$ErrorActionPreference='Stop'\nfunction Get-CimInstance { ${body} }`,
            ),
            "utf8",
          );
          await expect(
            promisify(execFile)(
              "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-File",
                script,
                "-Action",
                "inventory",
              ],
              {
                timeout: 15000,
                maxBuffer: 4096,
                windowsHide: true,
                encoding: "utf8",
              },
            ),
          ).rejects.toMatchObject({ code: expected });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    it("normalizes only extended DOS drive paths and fails closed on wrong/missing/exited process identity", async () => {
      const source = await readFile(
        new URL("../src/host-power-windows.ps1", import.meta.url),
        "utf8",
      );
      const native = source.match(
        /Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/,
      );
      expect(native?.[1]).toBeTruthy();
      const normalizationCases = [
        {
          input: String.raw`\\?\C:\Windows\System32\service.exe`,
          expected: String.raw`C:\Windows\System32\service.exe`,
        },
        {
          input: String.raw`\\?\c:\Windows\service.exe`,
          expected: String.raw`c:\Windows\service.exe`,
        },
        {
          input: String.raw`\\?\D:\work\service.exe`,
          expected: String.raw`D:\work\service.exe`,
        },
        ...[
          String.raw`C:\Windows\service.exe`,
          String.raw`D:\work\service.exe`,
          String.raw`\\server\share\service.exe`,
          String.raw`\\?\UNC\server\share\service.exe`,
          String.raw`\\.\C:\Windows\service.exe`,
          String.raw`\\?\GLOBALROOT\Device\HarddiskVolume1\service.exe`,
          String.raw`\??\C:\Windows\service.exe`,
          String.raw`\\?\C:relative.exe`,
          String.raw`\\?\C:/Windows/service.exe`,
          String.raw`\\?\1:\service.exe`,
          String.raw`\\?\Ｃ:\service.exe`,
          "",
        ].map((input) => ({ input, expected: input })),
      ];
      const caseJson = JSON.stringify(normalizationCases).replace(
        /[^\x00-\x7f]/g,
        (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
      );
      const dir = await mkdtemp(join(tmpdir(), "hitchlet-image-query-"));
      try {
        const script = join(dir, "read-only-image-test.ps1");
        await writeFile(
          script,
          `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${native![1]}
'@
$pathCases=@'
${caseJson}
'@|ConvertFrom-Json
foreach($case in $pathCases){if([HitchletProcessImage]::NormalizeLocalDosPath($case.input) -cne $case.expected){throw 'path_normalization_changed_scope'}}
$foreign=[HitchletProcessImage]::NormalizeLocalDosPath('\\\\?\\D:\\work\\service.exe')
if($foreign.StartsWith('C:\\',[StringComparison]::OrdinalIgnoreCase)){throw 'foreign_volume_allowed'}
$base=[long]638000000000000000
for($i=0;$i -lt 10;$i++){if(![HitchletProcessImage]::SameCreationMicrosecond($base+$i,$base)){throw 'valid_microsecond_rejected'}}
foreach($pair in @(@($base+10,$base),@($base,$base+1),@(0,$base),@($base,0),@(-1,$base))){if([HitchletProcessImage]::SameCreationMicrosecond($pair[0],$pair[1])){throw 'invalid_microsecond_allowed'}}
$p=Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
$ticks=$p.CreationDate.ToUniversalTime().Ticks
$path=[HitchletProcessImage]::Read($PID,$ticks)
if([string]::IsNullOrWhiteSpace($path)){throw 'current_image_missing'}
$wrong=$false;try{[void][HitchletProcessImage]::Read($PID,$ticks+10)}catch{$wrong=$true}
$missing=$false;try{[void][HitchletProcessImage]::Read($PID,0)}catch{$missing=$true}
$unknown=$false;try{[void][HitchletProcessImage]::Read([int]::MaxValue,$ticks)}catch{$unknown=$true}
$child=Start-Process -FilePath "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command','[Threading.Thread]::Sleep(3000)') -WindowStyle Hidden -PassThru
$childCim=Get-CimInstance Win32_Process -Filter "ProcessId=$($child.Id)"
if(!$childCim -or !$childCim.CreationDate){throw 'test_child_not_observed'}
$childTicks=$childCim.CreationDate.ToUniversalTime().Ticks
if(!$child.WaitForExit(10000)){throw 'test_child_did_not_exit'}
$exited=$false;try{[void][HitchletProcessImage]::Read($child.Id,$childTicks)}catch{$exited=$true}
@{wrongIdentityRejected=$wrong;missingCreationRejected=$missing;unknownPidRejected=$unknown;exitedPidRejected=$exited;currentImageFound=$true;normalizationCases=$pathCases.Count;outsideVolumeBlocked=$true}|ConvertTo-Json -Compress
`,
          "utf8",
        );
        const { stdout } = await promisify(execFile)(
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script],
          {
            timeout: 20000,
            maxBuffer: 4096,
            windowsHide: true,
            encoding: "utf8",
          },
        );
        expect(JSON.parse(stdout)).toEqual({
          wrongIdentityRejected: true,
          missingCreationRejected: true,
          unknownPidRejected: true,
          exitedPidRejected: true,
          currentImageFound: true,
          normalizationCases: normalizationCases.length,
          outsideVolumeBlocked: true,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 30000);
  },
);
