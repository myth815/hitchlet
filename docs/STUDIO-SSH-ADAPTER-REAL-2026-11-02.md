# SSH 参考适配器 Studio 实机回执（2026-11-02）

`b3de033` 的 `packages/sdk/examples/ssh-access-adapter.mjs` 已经在原 Studio 隔离验收栈完成一次真实连接，验证时间为北京时间 **2026-11-02 21:48:51**。本轮新增且仅新增一张租客 Ticket / 一个 Allocation，没有以旧 probe 替代新 factory。

| 项目                                | 实际值                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Engine                              | `98531c12-2a3b-4ed6-82c3-08abfb8120a4`                                    |
| 固定镜像 digest                     | `sha256:5cf584cab167af0b6a3dc2271809657d4c6368270f356e1a079031493f321a86` |
| 已发布 version                      | `5024a62d-8f54-4525-807c-5173c7304c78`                                    |
| Node                                | `2ad42e38-9b26-4c87-a596-08b918fbe807`                                    |
| 新 Ticket                           | `e5f45191-6156-4ab6-aaa5-9616ec37418a`                                    |
| 新 Allocation                       | `39e916b8-7a0b-470e-8b77-ed90c6fc65f1`                                    |
| API 与实际 SSH host-key fingerprint | `SHA256:EoMFNebm1x9b+VbWmM+Fxu5NYta8oxhgWmVWGIDsvZ0`                      |
| 新 factory 安全摘要                 | `uid=1000, gid=1000, nodeVersion=v24.22.2`                                |

开始前核验旧票全部 released、活动 claim=0、原管理端口无冲突。复用原 profile、Engine、管理容器和保护凭据；资格记录仍有效至北京时间 2026-11-03 16:30:24.563。正常原生 Host 为 fresh/present/partial，沿用原有 90% 显式测试策略与 bounded attended 预算，未调整 Host policy、资格、网络或 allowlist。

通过 public SDK 的 catalog/preview 核实同一已发布版本、Node、网络及双存储请求：原 18 字节合成输入只读、既有隔离输出 profile 可写，资源为 500 CPU millis / 512 MiB。随后由既有 CLI 保存原请求/Prepared/幂等键并执行 queued→ready→Claim→access-with-adapter。消费者临时 wrapper 注入现有 `ssh2` 公共包的 Client，调用新 `createSshAdapter`；CLI 提供的 raw host-key verifier 与真实 API 指纹精确匹配后，真实私钥认证及固定 `id -un && id -u && id -g && node --version` 探针成功。

安全摘要保存到新保护目录的 `probe-summary.json`（455 字节），SHA-256 为 `7d724f339285ee817dcd5ccbd5283bdaa8d1eacb58aa265934c67c59ca9359b3`，同时保存了非秘密输出确认回执。未覆盖旧输出；客户端 AccessGrant 私钥仅在内存交给 wrapper/Client，没有写入状态、文件或日志。复用原管理凭据，未新增长期认证或访问。

确认结果已保存后，通过原 CLI 显式归还同一 Ticket，最终为 `consumer_release / released / cleanup complete`。本票容器、网络、临时 workspace 逐个 Docker inspect 确认 absent；controller 干净关闭后只读核账也为 desired/observed absent、唯一新增 claim released、全局 activeClaims=0。原两张租客票保持 released，当前累计三张均已回收。

原输入及三份持久输出在本轮前后 SHA-256 一致：输入 `c67d92a1...37c91`，首轮结果 `d2deb797...75d57`，可靠性结果 `a1ab7a26...7b47b`，资格输出 `8a76e304...9d579`。未重做资格全探针、续租/掉线或 CPU 压测，也未拉新基础镜像、重建栈或修改全局网络/服务。

最终原生 controller/Host/HTTPS 代理、三个管理容器及 `hitchlet-studio-acceptance` profile 恢复为停止；`default` 仍 Running。保护状态与本次非秘密回执保留。使用指南见 [SDK examples](../packages/sdk/examples/README.md)。本轮仅更新文档并检查格式/diff，复用此前 25 个 adapter mock 和 1 个 Simulator 联合场景，不重复运行。

这次实机证据只适用于上述 Studio Engine、镜像、原网络/存储及新 adapter 的固定只读探针。不代表 Windows/WSL、媒体业务或生产部署已验；本轮未使用 Windows/WSL。关闭本地 SSH connection 不保证远端任务终止，也不提供 strict offline enforcement；消费者仍须遵守最后 confirmed 期限。
