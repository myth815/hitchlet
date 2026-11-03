# 租客按需求选择环境：可重复的 VM CLI 测试配方

本配方复用公开 SDK 和 `packages/sdk/examples/resumable-tenant.mjs`，不在 Hitchlet 增加 Vesta 测试调度。消费者负责源码、命令、结果质量和重跑；平台负责环境、Ticket、租约和真实回收。

## 当前可复用的证据与运行条件

Studio 已完成 Tart 2.41.1 / Tahoe macOS 26.6.2 / arm64、4 vCPU / 8 GiB 的正常注册、资格、镜像验证发布及一张真实 CLI Ticket。记录见 [实机验收](TART-STUDIO-CLI-ACCEPTANCE-2026-11-03.md)。工具、封存模板与缓存保留；临时控制面和 Runtime 已关闭，临时认证已清理。旧测试 URL、Ticket 和目录 ID 不是持续在线服务的接入承诺。

下一次运行由运维在具体允许的范围内开启专属服务和认证，返回当前 origin、授权 catalog 和配套 SDK/contracts。消费者不负责注册主机、重建账本或修改网络。现有 Docker 影音服务仍为 `0039abe` 合同：它不接受新 `guestOs` 请求字段。新服务兼容旧 Docker 请求，不等于旧服务能接受新字段；不自动升级现有服务。

## 1. 只声明需求

沿既有保护渠道向进程提供 `HITCHLET_TOKEN`；不要写入任务 spec、源码、日志或 shell 历史。每次逻辑租用使用独立的私有 `HITCHLET_DEMO_STATE_DIR`，恢复时继续相同目录、origin 和消费者身份。

```sh
EXAMPLE=/absolute/path/to/resumable-tenant.mjs
node "$EXAMPLE" catalog
node "$EXAMPLE" preview \
  --version "$VERSION_ID" --network "$NETWORK_PROFILE_ID" \
  --kind vm --guest-os macos --architecture arm64 \
  --cpu-millis 4000 --memory-mib 8192 --scratch-mib 0 \
  --lease-seconds 900 --max-lifetime-seconds 3600
node "$EXAMPLE" acquire-or-resume
node "$EXAMPLE" wait-ready
node "$EXAMPLE" status
```

IDs 来自当前 catalog，不复制历史验收 IDs。默认没有 Node、Machine 或 provider 约束；版本、guest OS、CPU 架构和资源是各自独立的要求。资源参数不静默夹到配额或镜像最小值；由同一 preview / admission 判定给出真实原因。

`availability=unsupported` 表示没有对应可交付能力，不创建 Ticket 来掩盖；`temporarily_unavailable` 可使用原请求排队。preview 不预留容量。连接异常、等待超时都继续原 prepared command / Ticket，不再次 acquire。

`status` 和 `wait-ready` 显示实际 `placement`（含已返回的 guestOs / architecture / provider）、固定 `resourceContract` 和网络模式。`resourceContract` 是已接受的资源约定，不是运行时物理观测；实际测试另记录 guest OS、CPU、内存和工具版本。旧服务缺失 guestOs 时，不从宿主 macOS/Windows 推导 Linux 容器或 VM 的系统。

## 2. 接用和 confirmed 续租

```sh
node "$EXAMPLE" claim
node "$EXAMPLE" renew 1200
node "$EXAMPLE" access-with-adapter --adapter /absolute/path/to/consumer-adapter.mjs
```

adapter 为消费者模块，接收 `{grant, verifyServerHostKey, confirmedExpiresAt}`。按 API 主机指纹确认 SSH 服务端，短期材料仅在内存中用于 SSH，不打印或写到状态文件。`ssh-access-adapter.mjs` 只是 id/Node 连接探针，不能把它的成功当作 Vesta 测试通过。

真正测试的 adapter / 调用 Agent 使用普通 SSH/SFTP：传固定 Git bundle 与校验清单，运行消费者命令，收小日志和报告。平台无需新的媒体或 Vesta API。一次 access 结果未知后，adapter 可能再次被调用；消费者命令须先查询原 run 的结果/检查点，不盲目重跑。

示例不会自动续租；`access-with-adapter` 持有本地状态锁，不支持另开同目录进程在其阻塞期间续租。短测试先 confirmed 续租并把命令时限控制在剩余期限内。本轮真实命令采用此方式。长期任务需消费者在同一执行器中监督 SDK renew / getRenewal 与业务检查点，不能只延长 SSH timeout 或开第二张票。pending 不延长最后确认期限；`resume` 恢复原裁决。controller 离线严格到期强停仍不保证。

## 3. Vesta CLI 的已验消费者配方

已验固定 commit：`6eeaf78426eb77efbc1a6e28595be5c3adf97743`。Node 24.21.0、pnpm 10.28.2；不是任何分支最新状态或整个 Vesta 多平台测试承诺。

消费者先从该版本的干净 Git checkout 导出 bundle 和 SHA256，再传入本票 guest 自有目录。在 guest clone / detach 后再核 commit、tree 和初始工作树。不要用无 `.git` 的源码 tar：该测试读取 `git rev-parse HEAD`。不复制宿主 node_modules、Git 登录或个人工作区。

以下步骤均在本票 guest 的消费者 checkout 运行；工作目录、输入 bundle、结果目录由消费者指定，不能写日常用户工程：

```sh
pnpm install --filter @vesta-ai/cli... --frozen-lockfile --ignore-scripts
node --input-type=module -e "import{mkdirSync,symlinkSync,existsSync,realpathSync}from'node:fs';import{createRequire}from'node:module';import{dirname,resolve}from'node:path';const r=createRequire(resolve('tools/cli-launcher/package.json'));const target=dirname(r.resolve('typescript/package.json'));const link='tools/cli/node_modules/typescript';mkdirSync('tools/cli/node_modules',{recursive:true});if(existsSync(link)){if(realpathSync(link)!==realpathSync(target))throw Error('typescript_link_mismatch')}else symlinkSync(target,link,'junction');"
npm install --prefix "$TEST_ROOT/yaml" --ignore-scripts --no-audit --no-fund --package-lock=false yaml@2.8.3
export NODE_PATH="$TEST_ROOT/yaml/node_modules"
pnpm --filter @vesta-ai/cli build
node --test --test-reporter=tap \
  --test-name-pattern='^public CLI closes native shared build, explicit IO, candidate cwd and literal argv in one request$' \
  tools/cli/test/domain-flow.test.ts
```

TypeScript 链接可能已由 pnpm 创建，核同一目标后复用，不重复创建或覆盖未知链接。所有准备和测试 stdout/stderr 写到消费者结果目录；记录命令退出码。模板准备若有 guest 写入，先 sync、正常关机，再封存；不靠硬 stop 后立即哈希来假定写入已持久化。

消费者结果清单至少包含：源 commit/tree、test 与 lockfile SHA256、实际 guest OS/arch/CPU/内存、Node/pnpm/Git 版本、TAP、退出码、各结果文件 bytes/SHA256，以及 Ticket/generation 与 confirmed expiry。该用例会清自己的 fixture，因此外层 TAP/报告必须放在 fixture 外。先在 guest 生成结果清单，SFTP 取回小结果并逐项核对，不下载整个 guest 工作盘。

## 4. 归还或取消

保存、回读并验证输出后：

```sh
node "$EXAMPLE" confirm-output-and-release --output-saved
```

如果决定放弃任务而非保留业务输出，可以明确取消原票：

```sh
node "$EXAMPLE" cancel --reason 'test no longer needed'
```

取消可能终止未完成工作，不附加“已保存输出”的虚假声明。取消和归还都保存 prepared command；只有认证查询或 `waitUntilReleased` 查实 released 才显示 cleanupConfirmed。未知结果用 `resume`，查询失败保留原状态。同票 access/renew 结果未知时仍可明确 cancel；示例原子保留旧命令引用后提交取消，不强迫先解决不再需要的接用/续租，也不把旧命令记为成功。资源清理 unknown 不清 Claim，不用新票代替旧票。

最后由运维核原生 VM 缺席、Claim 0 和本次临时服务/认证的关闭；模板和缓存是否保留按该次范围说明。消费者业务失败不等于平台释放失败，二者分开记录。本轮新增示例行为用 localhost Simulator 回归验证；真实 macOS ARM 证据复用前次单票，不声称本批又跑了 VM 取消或完整矩阵。

## Docker 影音接入

影音线确认现有 catalog/preview、正常 Ticket/confirmed renew/getAccess、SSH/SFTP、持久存储和 release 接口足够，不需要平台业务 API。镜像按实际 Engine 可达的固定 manifest 使用，loopback registry 不当跨主机地址。源码修正后需重新制品化，不能沿旧 digest 宣称包含新代码。

工具与任务仍由 AI/消费者选择：FFmpeg/ffprobe、FLAC/metaflac、sacd_extract、需要时的 MKVToolNix/MakeMKV，或既有 MediaToolbox 六个 CLI。大媒体留持久位置，收小报告与流式 hash；真实 NAS、外部服务和凭据只按具体任务授予。本次没有访问媒体、更新镜像或创建真实挂载。
