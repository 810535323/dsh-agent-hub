# 安装与设备管理

[English](INSTALL.en.md)

公开包不预置主机地址或证书。从机主动建立 WSS，无需开放入站端口。主机所有者提供 HTTPS 地址、一次性配对码，以及使用私有 CA 时的公开 CA 证书。

已安装 `dsh` CLI 时可使用原生插件管理器，重新打开 Harness 后在页面选择角色：

```sh
dsh plugin --profile desktop add github:810535323/dsh-agent-hub
```

或者克隆仓库，安装依赖后通过 `link:` 注册到开发目录：

```sh
git clone https://github.com/810535323/dsh-agent-hub.git
cd dsh-agent-hub
pnpm install --frozen-lockfile
dsh plugin --profile desktop add link:/ABSOLUTE/PATH/dsh-agent-hub
```

源码中的 JavaScript 和客户端入口可直接运行，无需构建。桌面软件未将 `dsh` 放入 PATH 时，可使用安装目录下的原生 CLI；Windows 用户也可使用下述安装器。

Windows ZIP `agent-hub-harness.zip` 包含安装器、插件和运行依赖。从源码运行安装器前必须先安装依赖。在 Windows 上解压后运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-harness.ps1 -HarnessPath 'C:\DSH\DeepSeek Harness.exe'
```

安装器使用 Harness 自带的 Node 和原生插件管理器，要求 Node 24+。已有主机会保留主机角色。新安装默认从机；确实要改角色时可显式指定 `-Role hub` 或 `-Role harness`。插件的本机会话接口不兼容时，页面明确报告启动错误。

打开“设置 → Agent Hub 设备”，或插件详情“打开设备控制台”。主机先选择微信同步目标与对应主 Session，再生成五分钟一次性配对码。从机填写主机地址、配对码、设备名和工作目录，点击“绑定并自动连接”，检查通信及固定 Session 就绪。也可以选已有 Session 绑定。主机可查看设备状态并解绑；从机可解绑主机。收到主机撤销回执后才移除本地绑定，旧 Session、任务和回执保留。

插件随 Harness 开启自动启动并恢复连接，随 Harness 退出停止。无需独立后台服务或登录启动脚本。首次开启软件后才能接收任务。

主机页面的“待处理任务结果”显示主 Agent 尚未确认的结果及微信投递状态。执行结束通知由插件独立发送，主会话忙碌不会阻塞。主 Agent 可使用 `agent_hub_pending_reports` 补查，阅读后用 `agent_hub_ack_reports` 确认；发送结果待核查的通知不会盲目重发。

需要 Codex 时，在任务中明确要求从机 Harness 使用本机 Codex sub agent，等待其结束、核查结果并汇总。调用能力、模型、认证和权限由对应机器的 Harness 本地配置负责；插件不安装 Codex、不维护 Codex Thread、不代替用户批准。若本机尚无 Codex sub agent 或调用工具，应先配置本地能力；插件不会把纯 Harness 执行误报为 Codex 执行。

界面优先。需要命令行协助时，可用 Node 24+ 运行 `node bin/agent-hub.js doctor|check|status|unpair`。配对命令为 `node bin/agent-hub.js pair --hub https://IP:9443 --code CODE --cwd PROJECT`；更换绑定需要 `--replace`，通过当前插件安全停止并恢复。未结束或待核查任务会阻止替换。没有独立 `start` 或新增登录启动功能。

所有新安装使用稳定名称和目录；旧安装原地复用账本与凭据。仅有 Codex 的旧 Worker 目录不会被 Harness 接管，不要复制其 token。该机器应在 Harness 页面完成新的配对，再通过旧绑定的正常解绑流程清理旧设备。
