Studio 服务归属修复

Lima user-v2 是两个 Colima profile 共用的用户进程。当前 macOS 上它的网络授权归属跟随创建它的责任服务组；控制面 LaunchAgent bootout 后，该责任组已 terminated，而 usernet 仍运行，出现 NAS445=111 和持续 node LocalNetwork 事件。改变 WorkingDirectory 再 bootstrap 同一 Label 并不会让旧进程自动归入新组。

最小调整保持现有一个 LaunchAgent：稳定的父进程负责原 Colima 启动和 TLS33101，控制面/Host observer 是可重载子进程。HITCHLET_STUDIO_RELEASE_FILE 指向一个仅含 releaseDirectory 的本地 JSON。正常更新先确认 Claim/在途操作清零，再原子修改该指针，对这个父进程发 SIGHUP；不使用 launchctl kickstart/bootout 重启父进程。新路径会在停止旧子进程前检查。重载等待旧子进程退出，不强杀；失败时保留父进程和责任组，清楚报错，不假称新服务成功。不增加第二服务、凭据、网络规则或业务调度。

同一组归属已经失效时，不能仅靠 SIGHUP 让旧 usernet 迁组。因此需要一次正常的共享网络生命周期恢复：确认两套 profile 无业务后按原配置正常停止；只有原 usernet 确认退出，才由原 Hitchlet LaunchAgent 先启动专用 profile 建立新责任主体，再恢复默认 profile。不强杀 usernet、不变更权限或路由。CIFS 是临时挂载，VM正常停止后需用原受保护身份重新挂载原RO及精确RW子树；不把口令写入配置，临时文件即清。Runtime绑定的挂载可见性须在挂载恢复后正常重启本任务Runtime核实。

本次只做真实存储小标记验证及正常SDK preview，不申请业务票、不重复媒体/租约全链测试。源码窄回归：3项实际子进程生命周期测试及10项既有Studio状态入口测试通过。

本次实测结果：原两个Engine身份保持，稳定父进程下重新建立usernet后直接NAS445恢复。原Music挂载恢复为CIFS只读，输出仅为`Music/Library-v2/自动整理`的完整UNC挂载。热重载原0039+d0128至SMBroot兼容候选时，父进程与usernet PID均保持；随后真实mTLS核对三个存储修订，NAS49字节和local42字节标记哈希一致。正常存储资格登记保留原四项并加入三项，正常租客preview返回eligible节点。仅探针写入/清理，没有业务Ticket或媒体文件修改。

`HITCHLET_STUDIO_RELEASE_FILE` 为可选，文件内容为`{"releaseDirectory":"/absolute/release/path"}`；不设置时仍使用脚本所属发布目录。更新前先确认无在途租约/Claim，原子更新指针后向运行中的原父进程发`SIGHUP`；不要用Node调试信号`SIGUSR1`。父进程收到子进程异常或有界停止失败会记录错误并保留自身；这不代表控制面健康，正常健康检查仍以33100的实际ready为准。不会无限重试或强杀未知进程。

宿主正常重启或显式停止整个LaunchAgent仍会结束其责任组；按原维护顺序处理两个Colima，不能把热重载保证说成任意宿主生命周期下都保持。SMB当前仍为既有临时挂载，本轮没有把凭据写入启动配置，也未承诺系统重启自动恢复NAS挂载。
