# 独立 Runtime 候选包

2026-11-04。用于把已构建Runtime带到目标执行机；**打包不是部署或Windows资格**。本批没有传文件到Windows、安装Node、启用Hyper-V、生成认证或启动服务。

## 生成

已有项目依赖和正常contracts构建可用时，在仓库根执行：

```sh
node scripts/package-runtime.mjs /absolute/path/to/NEW_RUNTIME_CANDIDATE
```

目录必须是新的，不覆盖或合并已有内容。脚本校验现有contracts来源清单，正常构建Runtime并复制固定assets；不联网、不执行包安装/lifecycle/hooks、不创建运行配置。构建中源码改变会报告未完成候选，避免混用两份输入。

目录包含Runtime dist、配对contracts dist/导出与原Zod4.1.12分发（含其许可），以及bundle-manifest.json。没有开发工具或工作区符号链接；包内依赖版本改为实际配对版本，无需npm/pnpm install。只选这些明确目录，个人配置、namespace/账本、证书/私钥/token、媒体或业务输出不参与复制。

manifest记录源码Git revision、工作树是否dirty、构建Node版本、源码输入摘要和每个payload文件的bytes/SHA。它不把dirty源码伪装成已提交版本，也不宣称重现了Windows编译/执行；Windows/NTFS/原生脚本资格仍是独立证据。失败留下的无完整manifest目录不能作为已完成候选。

## 使用边界

目标需另有Node24；本包不包含Node二进制，也不安装全局PATH或系统服务。Hyper-V入口是 `node dist/hyperv-main.js`，配置由实际部署的 `HITCHLET_HYPERV_RUNTIME_CONFIG` 提供；显式 `--init` 的目录/身份语义见[Runtime入口](HYPERV-RUNTIME-ENTRY.md)。没有模板/原生guest引导渠道仍不能ready，不以独立包导入成功冒称Windows可租。

本包未上传或部署；后续文件传输、已有/临时认证和监听范围必须按具体执行范围处理。当前只读Windows事实是维护PATH未发现node.exe，不能据此断言整机无便携Node；没有为凑齐环境擅自安装。Hyper-V组件仍Disabled，未启用或重启。

## 本地验证

两项针对性检查通过：从/tmp生成独立包，清空NODE_PATH后以原生Node ESM加载Hyper-V入口（无启动/原生动作）；核必要native assets及合同/依赖文件hash；目标已有哨兵文件时拒绝覆盖且原文件不变。测试临时目录已清理。归档ZIP和其实际SHA留在本机任务交接，不加入Git或公开上传。
