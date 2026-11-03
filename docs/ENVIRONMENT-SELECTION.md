# 租客声明环境，平台选择实现

租客选择授权镜像版本（或 imageId + alias），独立声明 `kind`、`guestOs`、`allowedArchitectures` 和 CPU/内存/临时盘。默认不选节点、宿主或后端。镜像、网络和存储是授权目录的逻辑引用；别名只在受理时固定一次。

```js
const request = {
  image: { imageId, alias: "stable" },
  kind: "container",
  guestOs: "linux",
  allowedArchitectures: ["arm64"], // 可省略
  resources: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 0 },
  networkProfileId,
};
const preview = await client.preview(request);
if (preview.availability === "unsupported") {
  // 当前没有对应组合，调整需求或由管理员提供环境。
} else {
  const receipt = await client.tickets.acquire(request, preparedOptions);
}
```

`guestOs` 是工作负载 OS，独立于宿主 OS。ARM Mac 上 Docker 交付 Linux ARM64；x86 Windows 上 WSL Docker 仍交付 Linux amd64，不是 Windows 原生。省略 OS 沿用镜像行为；显式 OS 冻结进 acceptedRequest，只匹配该 OS 的制品。`placement.guestOs` 从实际分配的不可变制品读出，绝不从宿主推断。旧服务器/回执可没有新字段。

## 能力与等待

- `unsupported`：当前授权目录/实现没有请求的类型、OS、架构或访问 recipe，或请求低于镜像下限。新 Acquire 返回 HTTP 422 / `environment_unsupported`，不创建 Ticket/Claim。幂等恢复始终先返回原 Ticket。
- `temporarily_unavailable`：组合存在，但观测/资格过期、节点准入、控制连接或容量等条件暂时不满足。可以取得排队 Ticket；reasonCodes 保留具体原因。
- `available`：预检时有符合资格的候选，`capacityGuaranteed` 仍为 false。消费者汇总配额、并发容量和配置变化在预留事务重检，不承诺立即交付。

旧版没有 availability 时继续用 phase/reasonCodes。已接受票的环境后来消失可显示 unsupported，按原排队截止收敛，不自动创建替代票。unknown 资源保留 Claim 直到回收查实。

## 内部实现登记与部署

`execution-registry.ts` 集中当前实现类型与限制；`ExecutionProviderDispatcher` 按冻结 Node 配置选择已组合的 ExecutionPort。Tart 整核 CPU、SSH、尽力临时盘、暂不支持托管挂载是当前实现限制，不再套用到所有未来 VM。

原 `EXECUTION_MODE=portainer|tart|simulator|disabled` 保持兼容。新增显式 `EXECUTION_MODE=registered` 组合 Portainer 和 Tart，调度、镜像验证、执行共用启用集合，同时刷新两类 Node 观测。Node 的实际工具、模板、身份和资格仍需满足合同；该配置不会安装工具、准备镜像、生成凭据或修改网络。Simulator 不混入此真实组合。本批未切换运行中的部署。

这是编译时登记表和现有端口，没有动态插件系统。新增实现需提供执行适配器并在 server 组合，按现有管理接口登记/验证 Node 与发布制品；普通租客请求形状不变。高级 allowedProviders/Node/Machine 仍可显式覆盖；公开 provider 使用稳定字符串 ID，SDK 可读未来实现回执，不要求消费者维护后端枚举。内部管理 native identity 和数据库登记仍不是任意第三方热注册协议。当前 Tart 初始化只实现 macOS ARM64；Linux 模板类型声明不等于实现可交付，匹配明确返回 guest_os_unsupported。

本批只做源码、临时 SQLite/Simulator、受控 Tart/SSH 替身与 GUI/SDK 回归。既有 Studio Docker 实机证据保留；未重新宣称实机验收。Tart 真实 VM、Linux guest 初始化、Hyper-V/Windows guest 和 Vesta 多平台验证仍未交付。没有真实 VM、媒体/NAS数据、凭据或宿主网络操作。任务批量、工具环境和结果质量归消费者；Hitchlet 负责通用环境与资源生命周期。
