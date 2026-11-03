# Studio 既有 Docker 安装：检查、复用与恢复

本入口复用已经存在的专属 Colima、账本、身份和三个管理容器；不会初始化新安装、创建密钥/token、安装 LaunchAgent、改变默认 Docker context 或开放家庭网络。Tart 两份临时验收栈不由此脚本启动。

## 先检查，不重启

在已交付的候选包根目录执行（参数仍兼容原脚本）。新候选需同时包含`scripts/studio-acceptance-resume.mjs`与`studio-acceptance-status.mjs`；旧冻结包不会自动得到新入口，不单独热换其中一个文件：

```sh
export HITCHLET_STUDIO_STATE_DIR=/absolute/path/to/retained-private-state
node scripts/studio-acceptance-resume.mjs --check
```

`--check` 只读 Colima/profile、Engine ID、loopback HTTP/HTTPS健康、原CA校验的管理员安装身份，以及既有测试消费者的授权 catalog。输出JSON只含公开状态、catalog和token/CA文件引用，不含凭据值。ready=false时退出非0；授权catalog不可用另列catalogStatus，不把它当作需要重建平台。

状态和制品版本分开：同一 installation + Engine 是“这是原安装”的证据，不能从运行脚本的checkout SHA推断在线服务版本。在线兼容包仍为0039abee + d0128a8，具体文件摘要见原交接；本脚本修改没有暗中升级该在线服务。

缺失profile、Engine或安装身份改变、TLS失败、超时和只有一侧监听都不会触发新建/覆盖或强停。Colima显示Broken时仍可由实际Engine及认证安装读回证明在线，不仅凭标签阻断正常使用。这些检查只针对避免误连/重复启动真实安装，不要求额外网络隔离资格或新的认证层。

## 离线才恢复，在线直接复用

```sh
node scripts/studio-acceptance-resume.mjs --resume
```

无参数仍等同--resume。原安装已在线时返回action=reused、started=false，**在任何Colima start或docker start之前返回**；不会停止或替换已有进程。只检查要用--check。

两侧监听确实不存在时，恢复原profile（不改全局context），核原Engine和三个管理容器的acceptance标签，再启动原Portainer、registry、Runtime以及此候选包的native Controller/Host/proxy。候选包必须是本次有意采用的制品；此离线路径不替操作者选择版本。当前源码不等于原0039兼容包，不在消费者接入时顺手替换整套API。

原容器/账本/身份保留；进程以前台监督运行。Ctrl-C只停止本次supervisor启动的native子进程与proxy；退出复用命令不会停止原服务。专属Colima和管理容器是否停止由owner在查实所有票归还后处理，脚本不自动清理未知资源。

## 消费者接力

1. 从check的当前consumer.origin、caFile、tokenFile及catalog选择已发布版本和授权profile。tokenFile只是现有安全引用，调用时进程内读取；不要复制值进spec、聊天或结果。
2. 匹配该部署的SDK/contracts；0039兼容服务不接受新增guestOs字段。新接口按kind/guestOs/architecture/资源匹配，宿主或provider不是消费者必填项。
3. 先正常preview，保留稳定idempotency和原Ticket，claim/access严格核API指纹。业务运行、工具环境和结果由消费者负责；保存并校验小结果后release并查实终态。
4. 票据归还后补查native缺席、Claim0和持久结果。不要因为等待超时、丢回执或更新示例就再开一票。

此入口的真实验证只做了check和“已在线复用”：当前catalog3个版本，supervisor PID前后一致，started=false，没有重启服务、开票或重复Docker/Tart验收。10项受控测试覆盖在线/离线、身份不匹配、部分监听、TLS/超时、消费者授权与Colima元数据标签；没有声称新离线恢复路径再次实机通过。原离线启动核心沿既有流程，仅把全体容器标签检查放在启动动作前。

```sh
node --test scripts/studio-acceptance-status.test.mjs
```

需要常驻时再明确安装用户LaunchAgent的具体目录/制品、仅loopback监听与复用身份范围。此处不生成长期凭据，不自动安装自启，也不把手工foreground称为生产可用性保证。
