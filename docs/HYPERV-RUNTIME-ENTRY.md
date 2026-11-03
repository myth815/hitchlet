# Hyper-V Runtime 正常入口（源码/本地组合验证）

2026-11-04，接续 `a669339`。本批只实现入口与持久身份，未在Windows启动服务、创建真实根目录/凭据或启用Hyper-V。

## 入口与配置

`apps/runtime-agent/dist/hyperv-main.js` 是正常Node入口；通过 `HITCHLET_HYPERV_RUNTIME_CONFIG` 指定JSON配置。字段为host（默认127.0.0.1）、port、installationId、runtimeIdentityId、stateDirectory、workRoot、tokenFile、caFile、certFile、keyFile。port和已有认证文件引用由实际部署提供，不自动选择/开放宿主网络、生成token或安装服务。

- stateDirectory是专属本地状态目录；workRoot是专属Windows绝对目录。状态文件固定在stateDirectory下：namespace.json、journal.json、allocations/，不会散落到未知用户目录。
- `node dist/hyperv-main.js --init` 显式创建工作根/状态目录及新的namespace标记，不生成密钥、证书、密码或租客票。UUID只是native namespace身份，不是认证凭据。目标已有marker时不能覆盖；不得把初始化当作修复失联原资源或重置身份的捷径。
- `node dist/hyperv-main.js` 只读原namespace及已有认证启动原mTLS server，不自动init。installation/runtime、配置工作根及实际目录realpath/device/inode必须与原marker相符，避免绑定另一份资源目录。没有新增enabled开关；这是持久资源归属绑定，不是任意禁止运行的总闸。
- 非Windows开发机不能把Windows路径误作本机相对目录；本地测试只注入窄目录观测函数，不在Studio创建E盘样式目录。Windows真实File ID/NTFS、ACL和掉电持久性仍未验；不拿POSIX mode或本地inode替身当Windows安全/持久性证明。
- 支持每namespace一个Runtime进程、同一部署配置。普通重复启动由同一HTTP监听地址冲突阻止；没有额外锁服务。不同配置/端口并发写同一根仍未资格验证，不承诺该部署模式。关停仅关闭本Runtime listener，不替控制器销毁VM、不关闭宿主。

## 与已有能力的实际接线

`createHyperVRuntimeApplication` 读持久namespace，组合原HyperVLocalDriver、FileJournal和认证Hyper-V server。CLI采用原生runner；不把模拟runner放进配置或自动登记为可租。host组件缺失时facts可诚实available=false，没有通过空的健康接口伪造资格。

没有原生模板初始化渠道时仍not_implemented，不凭启动server就返回租客access。完整模板/盘身份、实际guest初始化、生产resolver、节点资格、live发布证明和Operation plan映射继续按[provider边界](HYPERV-PROVIDER.md)推进；本入口没有自动启用这些内容。

## 实际验证与远端状态

8项新增入口/namespace用例、3项相邻Tart入口及4项Hyper-V server回归通过。新增用例涵盖显式一次初始化/不覆盖、正常启动不换ID、目录/installation/runtime变化拒绝、坏marker不重置、不制造认证、编译模块无导入副作用，以及本机临时mTLS从真实application工厂返回绑定namespace和available=false事实；native root与runner均为受控替身，未执行VM动作。

用户对历史被拒源文件传输已给出具体新授权，仅重试一次。该次原维护调用获准执行但60秒超时、无解析回执：无法确认源码是否到达或Parser完成，**不是新的审批拒绝，也不是语法通过**。仅提交Parser.ParseInput命令，未执行hyperv-local.ps1内容；没有重复未知请求或换通道。同一维护通道的只读检查确认原解析进程仍在运行，随后按精确命令/账户/创建时间回收并查实缺席；没有重复传输源码。准确状态留本机任务交接。系统组件启用、重启和宿主设置仍未执行。
