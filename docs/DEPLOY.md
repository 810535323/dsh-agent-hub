# 部署与迁移

[English](DEPLOY.en.md)

公开仓库的 `deployment.json` 为空对象，不内置运营地址或证书。主机在插件设置中配置公网 URL、监听端口与 TLS 文件路径；证书与私钥保存在插件目录之外。IP 直连时证书 SAN 包含公网 IP，私有 CA 的公开证书通过可信渠道提供给从机。参考 `deployment.example.json` 的文档保留地址，勿将其作为实际服务使用。

先备份源码、desktop profile、插件设置、TLS 配置和 SQLite 一致性快照。使用同一个 Harness 安装器升级主机与从机，不发布另一种运行时安装包。

新插件和固定安装目录均为 `dsh-agent-hub`。安装器只移除旧 Agent Hub 包的依赖与 bundle 条目，迁移它的配置 ID，保留其他插件及角色、微信目标、监听端口和 TLS 文件。原数据目录有账本或设置时继续原地使用，避免复制设备凭据或丢失主会话绑定。安装失败恢复 profile；旧插件源码与配置备份保留供回滚。

旧混合 Worker 在取得本地进程租约后，先检查账本。若旧 Codex 任务未结束则阻止迁移，明确要求核查，不新建替代 Worker 或重跑。无未结束旧任务时，将原配置备份到同目录的 `legacy-runtime-config.json`，只启用 Harness；保留设备标识、token、Harness Session、任务和回执，旧 Codex Session 记录只读保留并禁用入口。旧 Codex-only 目录不会自动接管。

主机可在短暂 WSS 重连后继续接收已开始任务结果；不得为升级主动取消用户任务。升级前后核对原 task/attempt/Session，不派发测试任务到真实用户设备，不发送真实微信测试消息。

旧独立启动器不再生成。对当前 Harness Worker 绑定存在的旧 Agent Hub 启动登记，在插件取得租约后清理，避免与插件重复争抢。其他目录和 Codex 自身启动设置不改动。旧独立 Worker 仍运行时页面会显示外部 Worker，需要正常停止原服务后再由插件托管。

Windows 构建时设置 `AGENT_HUB_PNPM` 指向本机 `pnpm.cjs` 后运行 `node scripts/package.js`。输出固定文件名、SHA-256、索引及安装文案。先运行 `pnpm run check:public`，构建包不含本机配置、数据库、证书、私钥或用户凭据。构建只写入本地 `dist/`，不会自动上传到主机下载服务或创建 GitHub Release。
