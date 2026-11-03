# Go 租客：Docker Linux ARM64 纯合成接入

2026-11-04 00:16–00:18（Asia/Shanghai）完成唯一业务票与双方交叉补证。不访问真实影音、NAS、Music 或旧成人业务。

## 服务与不可变制品

专属 Colima 6 CPU / 8 GiB / 40 GiB；Engine `98531c12-2a3b-4ed6-82c3-08abfb8120a4`，Linux arm64。原 0039abee loopback Controller 服务丢失后按原入口恢复；Runtime、Portainer、registry 和既有身份复用，没有重建 VM。

新租客没有 Node/Python；旧 Controller 的 SSH readiness 却硬编码 `node --version` 和 v24。`d0128a8bc62ad2c98e393fb14a8c03c524a8e101` 移除语言依赖，保留身份、UID/GID1000、workspace 可写和 API 指纹认证。8 项定向回归及 Controller 构建通过。

为避免把全部新 API/迁移带入消费者，制作独立兼容包：基础 `0039abee774a213a77018ebb1a1f5066d023952f` + 上述补丁；只有 `ssh-readiness.js` 和对应 map 不同，其余文件/链接逐项一致。原保留包未热改；先核 Claim0 再优雅替换该 foreground supervisor。SDK/contracts、Runtime 镜像和账本合同不变，不将派生包冒称原始 0039。

- 租客：Go media-curation 0.2.0、FFmpeg/FFprobe、OpenSSH，workspace UID/GID1000、SSH22。
- ARM64 manifest：`sha256:70b993bd037cb2214fbe9a4e156334d9c33ea426bee92f730f52badbde8b0701`。
- config：`sha256:b3fa81fdf4efee61906d5b849d31d26e62c60b6f24fce4623a847f906de0e907`。
- 导出归档 SHA256：`4ae57a317435195c62a62cf29bfa968f84ed33d88fe4f949124926b7df0c67b8`，54,615,040 bytes。
- Go CLI SHA256：`fc00f300bc88a02f245fb3f58571087ec176ee7a06f65bea6b80fb179ec954c5`。
- 正常 validation `ebf7382a-ce41-43a0-ae10-0dfe2de26ac1` succeeded / passed / cleanup complete；version `b23bdd03-7e40-464a-8937-5edc06c2831a` 正常 published，并由既有测试消费者 catalog 回读。没有跳过验证或给镜像补 Node。

制品只发布到该 Engine 可达的现有本机 registry；loopback 引用不是跨主机通用地址。没有新建凭据、改系统网络、安全设置或安装自启。

## 唯一业务票

Ticket `0890341c-9f0d-4dd5-9a48-586c55180d0a`，job `curation-go-20261103-ba106d46`。500 cpuMillis / 512 MiB / scratch0，900 秒；复用既有 ro 合成输入和 rw 持久输出 profile 的唯一子目录，输入总计11,210 bytes。只 claim，没有额外续租测试或重开票。

消费者核 SSH host fingerprint、CLI hash、输入 hash，执行真实 Go CLI，流式回收影片、movie.nfo、curation.json 三个小文件，逐文件核 bytes/SHA后 release。合成影片的可见标题为“试看 · Synthetic Lease Movie”；publication 的 uncertain=true 原样保留，不把合成 completed 当作权威媒体身份、质量、播放器或正式入库验收。

原票最终 released / cleanupStatus complete，prepared=null。管理总览 CPU/内存/scratch Claim 全0，unknownOperations / activeOperations / cleanupBlocked 全0；原生按本安装身份检查租客容器、网络、工作卷均为空。归还后 VM 持久三个文件与消费者清单和本地副本 bytes/SHA 全一致，业务侧独立交叉复核通过。

原始管理、native、持久输出证据及兼容包 manifest 保留在本机任务工作目录，不提交 token、密钥、账本、个人路径或原始运行日志到仓库。业务源码和媒体编排不进入 Hitchlet。

## 当前交付边界

专属基础栈在收口时以前台 supervisor 保留在线，无 LaunchAgent/自启或无人值守可用性保证。租客资源已清理，合成持久输出保留。文档中的历史 ID/健康不是后续实时可租承诺，使用前核当前身份/catalog。

本次不覆盖真实 NAS/影音、外部 API、长作业续租、Windows、完整 Vesta 矩阵或 Controller 离线硬停。后续通用身份 adapter 的29项受控回归属于新示例修正，没有为它再开真实租约。
