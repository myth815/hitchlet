# 一期基线代码审查修复候选

基底 `e7d07a481970c54b58accb3bb86e4e8b668dd66a`。本轮只提交本地候选；未推送、部署、迁移或运行现场。二期暂停。

## 范围与责任

470 个基线跟踪文件中，411 个项目自有运行代码、工具/配置、测试与验收脚本完成审查；59 个非执行文档、license 和依赖解析锁排除出代码分母。生成输出和第三方依赖未当作项目代码重审。逐文件说明见 `coverage.json`，32 个门族见 `gates.json` / `GATES.md`。旧历史分支不在范围。

- `hitchlet_phase1_integration`：Controller/application/storage，133 文件。
- `review_h_runtime`：Provider/Runtime/host/guest/tooling，143 文件。
- `review_h_client`：contracts/SDK/GUI/package tooling，134 文件。
- 主线：补读设计 typecheck 配置、整合和提交。
- 非作者复核覆盖 Controller、Runtime、SDK/GUI 的最终 diff，以及包配对和消费者接口。所有文件由对应原作者独占修改。

## 已改

- 已停用 consumer 仍可在原 scope/owner 校验下读自己的库存和清理证明；撤销凭据不放行。
- 清理证明忽略两种明确无效果的终止续租失败；有额外效果/unknown 仍拒绝。cleanup result 随同票保留，防止票尚在而证明先被 30 天清理删除；已丢失历史不补造。
- Provider revision 完成更新检查真实 CAS 行数，晚到失败事务不留下新修订；只读管理 preview 不再声明写请求幂等键。
- 已由共享 schema 验证的私有 storage subpath 不重复验证；SMB 根路径的独立授权保留。
- GUI 保留 unknown 命令原 key/body；仅 SDK 明确标记终态 rejected 才清除。SDK 保留真实 HTTP 状态。读取既存 prepared 项不再截断为八项，新准入上限仍为八。
- 打包 provenance 纳入 workspace 配置。
- SSH readiness 限制既有 probe 输出；新建 power lock 写入失败只清理同 inode；Tart bootstrap 对本次排他创建的公开目录/文件设置约定权限，已有不合规目录仍拒绝且不扩大权限。

## 实际验证

Linux x64 / Node 24.22.1，现有依赖，无真实 provider、秘密、网络服务或 SQL 生产连接。

- contracts/SDK 标准 clean→tsc→provenance、Controller build/schema-copy、Runtime build/assets-copy、GUI typecheck/build 通过；变更文件格式检查通过。
- contracts+SDK：113/113；之后 SDK 真实 HTTP status 小修再定向 2/2。GUI 最终 62/62；包配对/打包 11/11。
- Controller 首轮 601/605；四个 fixture 不一致修正后仅复跑受影响 3/3 和 1/1，通过。
- Runtime 首轮 444 通过、2 失败、18 既有跳过；两个 umask 失败修复后在显式 0077 下复跑两个正例及一个既存目录拒绝负例，3/3。未再跑完整套件。
- SSH/power 122/122、Controller 修复 13/13 等定向结果有重叠，不与上述数量相加。

全套首轮失败与随后定向通过分开记录，不能称所有套件在最终树同时全量重跑过。Linux 本地测试不证明真实 Docker、macOS Tart 或 Windows 行为。

## 保留与后续

保留唯一 owner/lease/generation/Engine/完整库存、原 key 查回和查实回收约束。ACL-aware 存储收窄、管理全局视图门等只有潜在线索，未盲删。恢复期旧幂等回执可能已失去当前权威，因此未移动恢复门。

本候选必须由原 Studio 唯一执行者在当前准入下构建实际对应的 Controller/contracts/SDK/Runtime，再用既有一期入口验证两张新票、逐票清理及服务/媒体恢复。不得借用过去的窗口或将旧实跑产物重标为本候选。新一轮实机结果尚未产生。
