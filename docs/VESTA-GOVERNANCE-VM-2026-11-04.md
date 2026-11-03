# Vesta governance text：Ubuntu ARM VM 新用例验收

2026-11-04 01:44（Asia/Shanghai）完成。此轮固定新CLI `5e6dba54f3fcd2f52f2c66fda6a6d2dd86946c3d`，不是再次执行旧`6eeaf784`的domain-flow用例。

## 输入、环境与版本

- 源tree：`680034fe2f5b8b796ea36ae0c425238bcc711afb`；新commit只更改governance command、其测试和CLI README。
- 缓存基线bundle SHA256 `e4e0b36ee0502b681a0f51d9811617ad71997ce90aa96923f21eb08df4091fb1`，已在专属验收模板中。
- 增量bundle4,512 bytes，SHA256 `cb665f401c413b0459f950f5f9300b8f27bbfe809d45963be5db22229edd79a1`；guest核两份SHA，fetch增量后checkout固定commit，并核tree/test/lock hash。未再次传输456MB基线。
- 复用Tart2.41.1与Ubuntu24.04.5 / arm64封存模板，digest `sha256:3d6cd94e22b5cfe864ea261428bec3b84b1e83210828fe739f59d6dd436a6b8c`；没有新镜像下载或模板修改。此模板含历史CLI测试输入，是专属验收基线，不将其冒称无业务内容的通用生产镜像。
- guest4vCPU / 4GiB配置、Linux可用MemTotal4,086,210,560 bytes；Node24.21.0、pnpm10.28.2，默认NAT，最多一台活动VM。
- Hitchlet源码`297604c6ad958ed93a469c20f29243527cf0ef7b`；Controller/Runtime生产源码与已构建产物复用，关键源/编译hash另存本地回执。未为这次新CLI用例重跑整库或重做宿主工具准备。

原模板与来源证据复用；新的临时Runtime身份通过正常发现/真实资源、SSH和恢复回收资格，再经正常镜像validation/publish，没有把旧身份的报告改时间当新资格。资格与验证克隆依次回收后才申请唯一业务票。

## 真实执行与输出

```sh
node --test --test-reporter=tap --test-name-pattern='governance text' tools/cli/test/governance.test.ts
```

TAP **pass3 / fail0，exit0**，SHA256 `768b8e8caeddef6e0c2298d9b9a44a13b4af2862c631026f8026b44c93fb831e`。覆盖新文本/JSON reports投影与事实复用、真实失败诊断、多目标和非法format；受控取消/未确认清理的文本投影不是新的native取消资格。

唯一业务Ticket `a8181f77-d6aa-475f-a54e-301cf65e794d`；逻辑版本`d26f86a8-4836-4b59-bf08-1a772a367e04`，消费者仅声明vm/Linux/arm64和4000m/4096MiB/scratch0、NAT与版本，没有指定宿主/provider。先claim和confirmed续租1200秒，在本票指纹校验后经SSH运行；最后8个TAP/环境/日志/manifest等小文件流式保存并逐项核bytes/SHA。原prepared命令使用原子保存，没有新票、重复执行或旧空检查点问题。

## 终态和边界

Ticket released / cleanupStatus complete，Allocation `658bb30e-9ed5-4de2-b879-5378145cd19c`经精确native身份查实complete absent。资格、制品验证和租客的三份owned manifest均查实absent；Claim CPU/内存/scratch全0，unknownOperations / activeOperations / cleanupBlocked全0。

节点已禁用；本轮33112 Controller /33446 Runtime已停止且不监听。仅本轮token、私钥、master和加密secret版本已删除；token无自动TTL，失效方式为停止唯一服务并处置材料，不宣称自动到期或平台revocation记录。模板/cache保留，没有更改现有Docker/影音、宿主网络、安全设置、系统信任或自启。

实际环境、原始TAP、源与编译hash、API/native/文件证明保留本机任务工作目录，未将原始日志、个人路径或秘密提交Git。一次辅助默认沙箱SQLite读到database locked，最终改用正常API和精确native manifest补证，未改数据库；旧辅助恢复helper的一次lsof端口诊断已改为窄socket读回，没有读取媒体内容或绕过Music访问限制。

本轮只增加**新CLI版本的Linux ARM VM单元格**。此前macOS ARM VM的旧用例证据保持原样，不因此宣称新governance用例在macOS VM或Windows通过。未覆盖完整CI/GUI矩阵、平台挂载、宿主压力/人员presence或离线严格到期强停；它们不作为普通短CLI任务新增门槛。
