# D22b 原生正常关机与 WOL

本模块实现 Windows 物理 Host 的 opt-in 正常关机和常驻控制器本地 LAN WOL。默认自动电源关闭。D22a 的策略、预演、合成 accepted/off 事件仍完全隔离，不能启用本模块。sleep、强制结束应用、智能插座、VM/云和任意远程命令均不在本模块内。

代码与合成故障测试不代表任何机器已验收。逐机报告必须来自同一控制器账本中的资格运行；本轮实机结果由独立主审另行记录。没有登记 Docker Node 的资格只证明物理 Host 恢复，不证明 Docker ready。已登记的全部 Node 必须重新报告健康且观测未过期，才可结束恢复。

## 准备与安装

所有 Host 与控制器必须保持可靠的系统时间同步。未同步、仅依赖 Local CMOS Clock 的主机不满足安装前提；未来时间的 Host 观测会被拒绝，这是闭锁行为，不能通过放宽时间校验代替修复同步。校时本身不构成新 OS boot。

控制器必须常驻于不会被关闭的机器，使用持久 SQLite 和 HTTPS。当前只实现固定本机私有 IPv4 `/24` LAN 广播（UDP 9）：配置的接口必须真实存在且 netmask 为 `255.255.255.0`。跨网络 SSH 转发、用户手动发送 WOL、ping/ARP 和测试时重建反向隧道都不构成本产品的自动唤醒证据。可将专用 controller 容器放在目标 LAN，使用 host 网络和 HTTPS 反代；给控制器/数据库/必要网络服务设置系统 Hold。

Node 24 / pnpm 10 构建：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @hitchlet/runtime-agent deploy --legacy --prod /tmp/hitchlet-host-power
```

部署 runtime-agent 的 `dist/`、`package.json` 和生产 `node_modules/`（包括 contracts 与 zod），保持相对布局。原 `dist/host-main.js` 仍是 observer-only：身份生成、enroll 和观测均不会静默获得关机权限。先按 [Host Agent 安装说明](../apps/runtime-agent/README.md) 完成物理 Host 配对/enroll。停止与新 power 入口竞争同一身份的 observer 进程。

Windows 用独立目录保存代码、binding、配置、guard、journal 和缓存。服务以 SYSTEM 运行时，目录及文件所有者设为 Administrators 或 SYSTEM，关闭普通用户写入。例（路径仅为示例）：

```powershell
icacls C:\HitchletPower /inheritance:r
icacls C:\HitchletPower /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'
icacls C:\HitchletPower /setowner '*S-1-5-32-544' /T
```

程序启动会检查配置/binding/guard/代码及 journal 目录的写入边界；缓存每次采样也检查私有 ACL。不得把缓存放在 Users 可写目录。配置只能由安装操作员修改，修改后重启相应服务；HTTP 没有写 verified/上传任意报告的接口。

普通 Machine API 支持无 Node 的物理登记：

```json
{
  "name": "physical-host-review",
  "hostOs": "windows",
  "architecture": "amd64",
  "capacity": { "cpuMillis": 1000, "memoryMiB": 1024, "scratchMiB": 0 },
  "powerOnly": true
}
```

向 `POST /v1/machines` 提交后，通过既有 HumanUsePolicy 和 admission API 保存真实保守预算并显式启用 Machine。`powerOnly:true` 仅避免自动添加“外部 Docker 底座”Hold，不发明 Node、不验证任何能力，也不免除其他 Hold。既有 Docker Machine 的 Hold 不自动释放；必须先确认工作确实停止，再通过正式管理流程处理保护。

## 本机工作负载守卫

只读采样：

```powershell
node C:\HitchletPower\dist\host-power-main.js inventory C:\HitchletPower\inventory-cache.json
```

该输出包含本机进程路径/哈希/签名指纹、运行服务/计划任务和原生 OS 启动时间，只在私有安装目录保存，不提交仓库。**不能自动把整个快照转成批准基线**。操作员必须逐项确认 Windows 系统进程及正常可停止的硬件/安全服务；先停止并确认已有业务任务，不为通过测试停风扇等安全服务。

`guard.json` 的严格结构：

- `version:1`；`acknowledgement:"Only reviewed Windows system services run; all other work is stopped"`。
- `systemExecutables:[{name,sha256}]`：仅实际 Windows 目录内、有效 Microsoft 签名且固定哈希的已审系统程序。
- `systemServices:[name]`：已审系统服务清单。这里与 `reviewedServices.serviceName` 均使用实际 SCM 服务名称，支持空格、Unicode 与普通标点，保留原字符串作精确比较，不会拼接到命令。名称为 1–256 字符，拒绝纯空白、斜杠/反斜杠和控制字符；有空格不等于通配匹配，也不放宽服务 PID、文件哈希或签名审核。
- `reviewedServices:[{serviceName,path,sha256,signerThumbprint}]`：逐个批准的有限服务程序；必须匹配当前运行的该服务 PID/子进程树、精确绝对路径/文件哈希/有效签名证书指纹。可用于风扇、硬件或显卡服务；不允许批准一般脚本引擎。
- 可选 `agentTask:{path,executable,arguments}`：仅自有开机任务的完整任务路径及精确 action。任务直接运行 node.exe + 本入口 + 固定配置路径；不常驻 PowerShell/cmd wrapper。

所有其他进程、运行任务、未知/不完整清单均阻止关机。PowerShell/cmd/Node/Python 等通用解释器不能经 reviewedServices 批准（仅当前 executor 和自己启动的有限 watchdog/probe PID 例外）。OpenSSH 仅可批准监听服务本身；连接子进程仍阻塞。WSL 的 vmmem/vmmemWSL/wslhost 表示活动工作负载，支持无 `.exe` 名称；wslservice 常驻守护服务本身不等于 running distro，但它仍须按服务边界审阅。当前没有自动识别/暂停 WSL 内业务任务的支持。存在无法证明的任务就保持阻塞或常开。

CIM 进程映像路径为空时，清单仅用 `PROCESS_QUERY_LIMITED_INFORMATION` 在同一进程 handle 上查询 `QueryFullProcessImageNameW(flags=0)` 和 `GetProcessTimes`，并检查退出状态。创建时间按实测的 CIM 微秒截断比较：CIM UTC ticks 必须是 10 的倍数，且 `nativeTicks/10 == cimTicks/10`，不采用宽容差；身份不一致、无创建时间、查询拒绝/失败或已退出仍为 incomplete。补全路径不会直接获准，也不启用 SeDebug、猜目录或新增进程名豁免。路径进入系统卷检查前，只将严格的 `\\?\<ASCII 盘符>:\` 前缀移除为普通本地 DOS 路径；普通路径保持原值，UNC/设备/相对盘符形式不改写，其他盘符规范化后仍按原系统卷检查阻塞。清单只打开系统盘上的进程映像获取签名与哈希。其他卷或网络共享上的未知进程只记录 OS 元数据并阻塞，不为判断空闲而读取其文件；因此本阶段的已审服务也限于系统盘。executor 本身以实际 PID 单独识别，其固定安装制品由独立指纹检查。

性能缓存只缓存 Authenticode/哈希，键包含 NTFS volume/file ID、大小和 last-write；每轮重新枚举 PID/服务/任务、验证文件身份和私有 ACL。缓存不是宽限许可，未知或文件变化仍否决；prepared/commit 仍各做一次本机检查，超过五秒就拒绝，不能放宽 token 时限来掩盖慢探测。

算出规范 guard hash（各 OS 均可执行）：

```sh
node dist/host-power-main.js guard-hash /private/path/guard.json
node dist/host-power-main.js executor-hash
```

独立 `power.json`：

```json
{
  "controllerOrigin": "https://controller.example:3443",
  "bindingFile": "C:\\HitchletPower\\binding.json",
  "caFile": "C:\\HitchletPower\\ca.pem",
  "guardFile": "C:\\HitchletPower\\guard.json",
  "journalFile": "C:\\HitchletPower\\power-journal.json",
  "enableNormalPower": true
}
```

本机 opt-in 常驻入口：

```powershell
node C:\HitchletPower\dist\host-power-main.js run C:\HitchletPower\power.json
```

以 SYSTEM 的 AtStartup 任务运行上述固定 node.exe action、配置准确 `agentTask`，并设置不因运行时长停止、单实例执行；或用既有合格原生服务管理器直接启动同一 action。生产部署不依赖交互登录。SYSTEM 自启、网络/TLS 和新 OS boot 后自动重连均须实机取证，不能用人工重启服务代替。一个专用任务的创建例：

```powershell
$action = New-ScheduledTaskAction -Execute 'C:\Node24\node.exe' -Argument '"C:\HitchletPower\dist\host-power-main.js" run "C:\HitchletPower\power.json"'
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName HitchletPower -Action $action -Trigger $trigger -Principal $principal -Settings $settings
```

把该任务完整路径、`$action.Execute` 和 `$action.Arguments` 原样写入 guard 的 `agentTask`，然后重新计算 guard hash。代码不自动注册/修改其他任务。已审的本地 Administrators 成员所有者/显式 ACE 也属于可信安装边界；无法枚举成员时收紧为 SYSTEM/Admins/当前执行者，按上述 ACL 示例部署。

OS boot 标识只来自 System 日志中精确 `Microsoft-Windows-Kernel-General` / event 12 的最新启动记录：正 `EventRecordId` 加事件内不可变的 `EventData.StartTime`，按固定 UTC 100ns 格式生成原有 UUID。启动和每次 inventory 都核对同一记录；不使用 CIM `LastBootUpTime`、事件 `TimeCreated`、当前墙钟、进程 UUID 或未公开注册表字段回退，NTP 校时不能更换锁或证明重启。缺失、无效、清除或轮转后不可读的启动事件均闭锁；同进程中事件改变也停止，不能静默切换身份。该证据依赖 Windows 保护的本机 System 日志，操作员不得清除/导入日志来制造恢复证据；新正常关机/WOL 后必须实测新事件和新 ID，不能仅凭事件格式宣称资格通过。既有本机 journal 必须带固定 `bootEvidence:"system-event-v1"`；缺标记的旧时钟算法记录直接闭锁，不迁移猜测，也不能因新 hash 不同而假称已经重启。升级前须先查实并取消旧待关机责任，再由操作员处理旧记录。

启动取得锁后，先恢复本机 journal、作废遗留 prepared token，再连接控制器。开机初期已明确分类的网络暂不可达/超时或临时 HTTP 状态以五秒间隔安全等待，不依赖 Task Restart；不会生成新 process boot 或重放电源动作，已提交但响应丢失的 boot 仍重试原请求。认证/绑定、证书、协议或未知配置错误会退出，不以无限网络重试掩盖；SIGTERM/SIGINT 可中止等待。退出只有在 journal 初始化已完成、取消确认安全后才释放本进程锁；取消不明或 journal 无法判定时保留锁及恢复责任，需要操作员查实。同一 OS boot 使用同一 lock 路径；正常退出会移除，崩溃保留以阻止第二个执行者抢占。新 OS boot 自动使用新 lock 并作废旧 journal，不需人工删锁。若同一 boot 崩溃，需要先查实并取消原关机，再由操作员处理旧 lock；不得删除 journal 或重放旧 token。

本机 inventory 明确超时或实时 CIM/计划任务采样不可用时，先确认取消已有本机许可，再继续下一轮采样；本轮不续心跳、不请求电源动作，旧事实会失鲜。每进程/文件竞态仍只产生 incomplete，不扩大批准基线。PowerShell 普通非零退出、ACL/安装/缓存配置错误、认证/TLS/协议错误仍停止；取消不明仍保留锁。stderr 只输出固定 `phase/code`，不输出原始 Error、路径或命令。完成安装目录 ACL 验证后，fatal 还原子覆盖 `${journalFile}.failure.json`，仅保存最近一条 `{at,phase,code}`；记录失败不替代原错误、不改变锁。成功运行不写该文件，旧记录仅表示最近一次失败。

最终关机路径的最近一次失败另存 `${journalFile}.shutdown-attempt.json`，绑定 cycle ID，保留 `watch_arm/preflight/native_shutdown` 阶段、固定 code、uptime 累计耗时及本机/控制器剩余时间，最多三个检查点；后续 `abort_unconfirmed` 不覆盖最初原因。记录只在失败路径结束后写入，API 前不写盘，成功不写以免延迟 accepted receipt。原生 PS 仅给自有期限/父身份、lease、权限和 OS 拒绝提供固定分类，不保存原始 stderr、异常或命令。该文件表示最近失败，不能作为当前成功或关机完成的证明。两次本机检查及五秒许可均不因此放宽；helper 启动、ACL/编译和 API 总耗时必须落在剩余许可内，资格时应记录实际开销。

## 控制器配置与逐机资格

控制器环境变量 `HITCHLET_POWER_CONFIG` 指向私有启动 JSON（POSIX mode 0600），格式：

```json
{
  "machines": [
    {
      "machineId": "11111111-1111-4111-8111-111111111111",
      "agentId": "22222222-2222-4222-8222-222222222222",
      "enabled": true,
      "automatic": false,
      "idleSeconds": 1800,
      "guardHash": "<64 lowercase hex>",
      "executorHash": "<64 lowercase hex>",
      "route": {
        "id": "33333333-3333-4333-8333-333333333333",
        "kind": "local_lan",
        "interfaceAddress": "192.168.50.2",
        "broadcastAddress": "192.168.50.255",
        "macAddress": "02:00:00:00:00:01"
      }
    }
  ]
}
```

示例的地址/UUID/MAC仅说明字段，必须替换为安装端实际受保护绑定。`enabled:true` 只允许有 live guard 的显式资格运行；`automatic` 默认 false，未完成资格也不能开启自动执行。测试可明确缩短 `idleSeconds`，变更后必须重新资格，不能把短测试策略报告用于其他空闲策略。

GUI Machine 面板的“原生正常关机与 WOL（D22b 实际执行）”独立于“电源策略与隔离预演”。API/SDK：

| 请求                                                                               | 行为                                                                                                                                         |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/machines/{id}/power-executions`                                           | 配置是否启用、实际资格、阻塞和有限历史；不返回 prepared token                                                                                |
| `POST /v1/machines/{id}/power-executions` `{qualification:true}`                   | 显式资格运行：在线 WOL 探针→后续新鲜 Host 观测→连续空闲→drain/正常关机→等待受理后的 expected-off→人工请求本产品 WOL→新 OS boot/Host/依赖恢复 |
| 同端点 `{qualification:false}`                                                     | 仅已经通过并在可信配置引用报告 ID 的绑定可启动                                                                                               |
| `POST /.../power-executions/{cycleId}/command` `{expectedVersion,action:"cancel"}` | CAS 取消；OS 尚可取消时请求 Abort，无法查实则有界转手动                                                                                      |
| 同端点 `{expectedVersion,action:"wake",provisionDeadlineMs}`                       | 收紧原截止并请求本产品有界 WOL；不能延长旧窗口                                                                                               |
| `POST /v1/agents/{agentId}/power`                                                  | 仅独立 Host credential/session 认证的 prepare/commit/accepted/cancel exchange；无管理员合成回执入口                                          |

管理写入沿用 full admin、CSRF 与管理 journal；SDK 默认一次发送、不自动重试未知结果。使用 `onManagementPrepared`/`resumeManagement` 保留原 body/key 恢复；响应不明时先查历史和状态，禁止另启一次关机。

成功的资格 Operation 必须真实包含同一绑定的在线 WOL、新 OS boot 恢复和 accepted Agent receipt；这仍需操作员审阅实机行为与范围。审核后把该 Operation ID 配入同一机器的 `qualificationId`，再显式选择 `automatic:true` 并重启 controller。executorHash 绑定固定 dist 文件、原生脚本和协议 schema 的实际 SHA-256 指纹；native 启动和本机复核上报/核对实际指纹，不能用固定版本字符串冒充。升级软件后重新取指纹并重新资格。引用不存在/失败的报告、修改 executor/guard/route/agent/空闲策略，都会保持未验证，管理 API 无法伪造。

自动需求只读取已冻结 Ticket 的 allowed Machine/Node/provider/architecture 和镜像类型的结构匹配；它不是可预留容量保证。idle/drain/commit 之前出现匹配 queued Ticket 会取消关机。off_expected 下经过资格的 automatic 机器可按匹配需求 WOL；控制器账本最终仍要求 on + fresh/healthy 和全部现有准入条件后才实际预留。deadline 取旧 cycle、五分钟和该 Ticket 既有 queue/provision 截止最早者。

## 安全状态与实机验收

实际状态保存在独立 `operations.kind=power.execution`，复用 SQLite/events/audit 和 agent_commands/agent_receipts，不增加第二个资源账本。原子 drain 增加 machine epoch/版本，完整输入 CAS 覆盖 Claim/Hold/活动操作/Host/策略以及匹配 queued demand。仅本 cycle 持有的 drain 可恢复；外部 disable/epoch/版本变化不会被覆盖。

控制器维护暂停、低磁盘或恢复期间禁止发起新的关机，最终提交也在同一 SQLite 事务复核这些状态；已有取消和恢复义务保留。GUI 仅展示最近 100 次执行，资格引用按精确 ID 读取，不会因历史窗口滚动而失效。Agent receipt 的 boot 标识记录认证进程 session；独立 OS boot 标识用于证明重启，二者不混用。

本机所有电源有效期统一使用 Windows system uptime 毫秒：Node `floor(os.uptime()*1000)` 与原生 helper 的 `GetTickCount64` 同源，覆盖样本 freshness、prepared token、OS API 前最后截止、通信 lease、受理后的本机上限和 helper 自限。依据为固定 Node 24 官方源码的 [GetUptime → uv_uptime](https://raw.githubusercontent.com/nodejs/node/v24.22.0/src/node_os.cc) 与 [Windows uv_uptime → GetTickCount64](https://raw.githubusercontent.com/nodejs/node/v24.22.0/deps/uv/src/win/util.c)。控制器 offer/commit 的绝对 UTC 截止仍前后校验；收到时的正剩余时间只会收紧为不可延长的本机 uptime 截止，API 前同时检查两者。回拨不能延长本机许可；前调导致绝对截止到达仍拒绝。本机 journal/lease 使用明确 `expiresAtUptimeMs`，OS helper 接收 `notAfterUptimeMs` 及独立的 `controllerNotAfterMs`，旧墙钟字段不猜迁移。逐机资格须比较 Node/native uptime 并验证回拨向量，不能凭跨进程各自的进程运行时间混算。

prepare offer 有自己的五秒窗口，首次本机复核前后均须未过期；复核通过后才生成一次性 prepared token，从签发时刻独立计五秒。commit 再次本机复核，必须同时满足本地 token 原截止和控制器 commit 截止，后者不能延长前者；OS API 前仍校验两者更早的原截止。Windows 使用 `InitiateSystemShutdownExW(force=false,reboot=false,timeout=60)`，API 调用前再次校验原 deadline、父 PID/启动身份与已 armed watchdog lease；没有 `/f`、强制 kill 或 AC 操作。重复 Abort 返回 Windows `ERROR_NO_SHUTDOWN_IN_PROGRESS(1116)` 时代表已无待执行关机，按取消已确认处理；仅 abort 的此错误可接受，其他错误仍失败。主审应在无 pending 关机时连续执行两次固定 `host-power-windows.ps1 -Action abort`，均须返回 `accepted:true`，并验证真实 watchdog 先取消后的重复清理。正常 API 的 accepted **不保证关机完成**，应用可以阻止关机。[Microsoft API 说明](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-initiatesystemshutdownexw)

受理后的稳态每轮只复用本轮一次真实完整采样；安全样本在采样开始时记系统 uptime，超过五秒、未知或不安全就取消许可。Host 心跳仅重发 pending 时不算新采样，不能借旧事实继续电源轮询或续租。prepare/commit 仍各独立实采，首次 accepted 后使用 commit 自身更新的样本；每个有效控制器响应后先复核该样本，再续独立 watchdog 的五秒通信 lease，不额外执行一次完整采样来延长轮次。样本失效或取消无法确认仍按既有闭锁/保留责任处理。

Windows PowerShell watch 由固定两跳启动：主 Node 以 `detached:true` 启动随制品发布的 `host-power-watch-launcher.js`，该 launcher 只以 `detached:false` 启动同目录 PS 的固定 `watch` action。它转发真实 PS ready；自身启动不算 ready，原父输出管道关闭也不退出或重启 PS，最多 130 秒退出。Node 官方 [Windows libuv 进程源码](https://raw.githubusercontent.com/nodejs/node/v24.22.0/deps/uv/src/win/process.c) 说明非 detached 子进程属于父进程关闭时清理的 Job；因此不能直接把主进程的 PS spawn 改为 attached。外层 SYSTEM 任务 Job 是否仍会连带终止整个链，必须按实际部署硬杀验证，两跳本身不冒充这项资格。

launcher 纳入 executorHash；必须部署完整 dist，不能只复制原有文件名单。两层只转发有界固定 ready/aborting 协议，双 PID 的原生创建 ticks、父子关系和固定映像路径都要匹配；inventory 每轮再以 limited query 验证 live identity，仅这两条明确实例可跳过文件哈希，不能批准任意 Node/PowerShell 或后代。缺任一实例、PID 重用、身份或路径不符、helper 不健康均闭锁。

OS 请求前启动独立 fixed-action watchdog。它仅能取消本机正常关机，绑定具体 cycle 的私有 lease 文件并每 500ms 检查执行者 PID/启动身份与五秒控制通信租约；父进程硬崩溃、通信失联或 lease 不合法会持续 Abort（覆盖已启动 OS helper 后才提交的竞态）。父进程也监视 watchdog 失败，失效 lease 不可重新续期。watchdog 启动时固定捕获 cycle，后续 lease 换 cycle 也按不安全处理。失联后恢复的原执行者仅在本轮唯一 shutdown 子进程真实 `close`（或明确尚未开始提交）、禁止该轮后续提交、再收到正常 Abort 确认后，才写内部 `settled_cancelled` 终态；helper 同时验证原父 PID/创建身份仍存活且 cycle 精确一致，才可在 unsafe 后提前退出。普通 cancelled 不解除 unsafe；父进程已死、PID 复用、提交结束未知或 Abort 未确认时继续原 120 秒重复取消保护，保留 unknown journal/锁责任。`execFile` 的错误回调、error、timeout、killed 或 exit 事件本身都不当作子进程 close；关闭确认有界等待失败也不会解除保护。watchdog 最长原保护窗 120 秒，之后取消并退出；不依赖父进程 finally。需要实机 `Stop-Process -Id <executorPid> -Force`、断连和新登录注入，证明 60 秒 grace 内取消。测试命令只用于杀测试执行者，不得强杀用户工作负载。[AbortSystemShutdown 说明](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-abortsystemshutdownw)

有自己的 authenticated accepted receipt、随后 Host 心跳停止且至少 120 秒，才可 `off_expected`，此时 `observedPower=unknown`。没有断电传感器就不宣称 off_confirmed。WOL 最多三次、间隔 30 秒，attempt 先持久后发送，重启不能重复消耗同一 attempt 或重开截止。受理后只有符合既有 Host freshness 规则的新在线事实（认证未撤销，observedAt ≤ receivedAt ≤ 当前时间，两者均在最多 30 秒窗口内）才会因新的人/未知/不完整信息取消；最后一期安全心跳过期属于失去在线证据，不会被缓存重解释成新不安全事实，也不跳过 120 秒等待。Claim/Hold/活动操作等独立账本保护仍立即生效。新鲜同一 OS boot 在线事实使旧 expected-off 失效；新进程 session 不等于新 OS boot。恢复的真人登录/高压不会强行延续关机条件：新 OS boot、完整会话/资源事实及所有 Node 健康后结束电源恢复，实际人员/工作负载状态继续交 HumanUsePolicy 决定准入。

已确认的同 OS boot 本地 Abort 会把 `cancelled` 与 `cancelReportPending=true` 原子保存到现有私有 journal。网络恢复后用原 cycle 的现有 `cancelled` 事件重报；丢失响应或同 OS boot Agent 重启可继续重报，只有匹配该 cycle 的有效 `none` 响应才持久清除待报位，随后回到普通 poll。已 cancelled 的普通清理不重复置位，未知 Abort 不产生该事实；旧 journal 缺字段默认 false，新 OS boot 明确清 false，不向 WOL 恢复发送旧取消。控制器在同原 OS boot 的 draining/committing/shutdown_requested 接受该主动事实、保留 accepted 审计，只在事务终判仍拥有 drain 时恢复准入；重复事件幂等，管理员 fence 不被覆盖，off_expected/waking 不被旧取消中止。既有 cancel_pending 是已明确下发 cancel 指令的响应路径，仍允许新的在线 OS boot 回应 cancelled，以完成该明确取消；不把它误作主动旧事实。验收须包含同一 controller 进程/epoch 的短暂断联恢复，例如仅暂停/恢复测试 controller 容器，不能只靠重启 controller 的 fence 证明。

`cancel_pending` 也有原截止上界。新需求发生在可能不可撤回的已受理关机后，仍保存 receipt/截止；仅 own epoch/绑定有效、已验证 automatic 路由、120 秒且心跳消失，才可续 expected-off 进行需求恢复。其余无法确认取消或外部 fence 变化转 manual，不永久挂起，不以旧 token 再关机。

逐机验收至少记录：初始身份/OSboot/guard/路由/策略哈希、WSL/业务任务已安全停止的事实、连续空闲与零 Claim/Hold/操作、drain epoch、两次本机复核实际耗时、accepted receipt、登录/新增需求/策略/进程硬崩溃/网络失联竞态、expected-off unknown 与原截止、真实 UDP attempts、新 OSboot、自启认证 Host、每个已登记 Docker Node 的新鲜健康及最终清理/正常关机。未完成项目必须标为未验证，不以合成测试替代。
