# Docker created 与 running 的网络事实

本地从 9295f865 复现：普通 bridge 的 create 回执已进入原 journal，容器仍为 created、Running=false，endpoint 的 NetworkID 为空，Provider 在 POST start 之前错误拒绝，并留下 provision/unclassified_error。原假 Engine 在 create 时就填满 NetworkID，因而未暴露这个阶段错误。新增夹具在 start 才填入实际 ID/IP，且网络成员表只列已运行的容器。

[Moby 固定 create 配置实现](https://github.com/moby/moby/blob/e4a1cf166e421bb6e05ff64b674681dfcf527bb0/daemon/container_operations.go#L363-L437)保留用户配置；[固定 start 实现](https://github.com/moby/moby/blob/e4a1cf166e421bb6e05ff64b674681dfcf527bb0/daemon/start.go#L136-L143)随后初始化网络。这里用于核对生命周期差别，不表示该源码就是现场 Engine 的版本，也不证明某次已结束现场失败的首因。缺失的原 attachment/HTTP 记录不能事后补造。

| 判断位置/阶段                     | 已有权威事实与独立作用                                                                                       | 最小处理/对照                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| create 后、start 前               | Engine/owner/name、冻结网络和唯一配置 endpoint 已读回；未启动字段不证明运行 attachment 错误                  | 只在已知 created + Running=false 下允许 NetworkID 空/未填；用已验证网络的准确名称或完整 ID 判断配置。显式外部 ID、错配置网络、额外网络、宿主发布端口和 privileged 仍拒绝 |
| 第二次 prestart container inspect | 同一对象的 ID/owner/name 已验，中间只有文件注入与本地 journal，没有容器配置/网络修改；重复读不能原子化 start | 复用已有 readback，单容器 create 到 start 只读一次 container inspect，不加 connect 调用；原租约有效性仍在 start 前查验                                                   |
| running/ready 与观察              | 实际 NetworkID/IP/成员是运行事实，不能用创建请求或 IPAM 意图替代                                             | 原桥 ID、真实子网 IPv4、唯一附件和准确运行成员保持；空/外部 ID、越界 IP 仍不 ready。名称与完整稳定 ID 只在对应同一已验证网络时等价，不接受任意前缀或其它网络             |
| 失败、重入与归还                  | HTTP/断言错误不等于没有创建；原 create journal 和实际对象回执为准                                            | 保留 observed/unknown、原对象重入、两种网络模式的 lost-create 恢复、容量占用及1.0/1.1清理证明；持久引用不销毁                                                            |

原 firstExecutionFailure 现在可带 Portainer 固定 reasonCode，受共享 schema 的有限枚举约束。请求阶段补 container_inspect/network_inspect；配置/运行断言分别保留 container_create/container_start 阶段和 configuration_mismatch 类别。没有远端 HTTP 错误时不编造状态码。既有授权 operation/timeline 和 validation 查询、GUI 均可读；不输出 URL、请求/响应正文、主机路径或凭据。未知异常仍保留原 unclassified_error，不猜原因。

本轮仅合成 Engine transport、实际临时 SQLite、正式 SDK 和 React DOM/jsdom。夹具中的 Engine version 字符串不是实测版本；没有操作 Docker、Runtime、防火墙、真实票或现场服务。Runtime 产品源码及 acquire、网络 profile、租约/claim、proof 字段不变；新增诊断需使用本候选配对的 contracts/SDK。
