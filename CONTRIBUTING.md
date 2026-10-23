# Contributing / 开发指南

## Workflow / 工作方式

Use Node 24+ and pnpm 11.28.5. Run `pnpm install --frozen-lockfile`, `pnpm run check`, `pnpm run check:public` and `pnpm test`. TLS tests create temporary certificates with OpenSSL 1.1.1+; set `AGENT_HUB_OPENSSL` if it is not found. Tests use isolated SQLite databases and fake Agents/IM; never point them at a production data directory.

使用 Node 24+ 和 pnpm 11.28.5。按上述命令安装与检查。TLS 测试临时生成证书，不提交私钥。测试使用隔离数据库和模拟 Agent/IM，不应连接生产账本或发送真实微信测试消息。

Refactor in small behavior-preserving steps. Preserve task/attempt/binding correlation, durable receipt boundaries, Session reuse, real human approvals and independent result/delivery consumption. Add meaningful regression coverage when behavior changes. Keep Chinese and English documentation aligned.

按小步骤整理代码，保持任务/尝试/绑定关联、持久化回执边界、会话复用、真实用户审批，以及结果消费与投递的独立状态。行为变化时补充有意义的回归测试，同步中英文文档。

This cleanup used GitHub Awesome Copilot's MIT-licensed [refactor skill](https://github.com/github/awesome-copilot/blob/main/skills/refactor/SKILL.md) as a workflow reference; the skill is not a runtime dependency or vendored source.

本次整理参考上述开源 skill 的逐步重构流程；该 skill 不作为运行依赖，也未复制进插件包。

## DSH plugin conventions / 插件规范

- Declare Cordis services in `inject`; scope registrations with `ctx.inject`, `ctx.on` and `ctx.effect`. Dispose only resources owned by this plugin. See the official [Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md).
- Register tools through the public tools service and use native Session/approval interfaces. An inbox enqueue receipt does not identify one completed turn. See the [extension cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md).
- Keep `dsh.bundle.patch`, profile bundles, `exports["./client"]` and `dsh.client.platform` consistent. Use Harness' shared client modules and the public rebuild notification. See [client modules](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/modules/README.md) and [plugin management](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md).

依赖注入与生命周期必须可撤销；工具、会话和审批优先使用原生服务；客户端使用共享模块和声明式 bundle。`client-registration.js` 与 `controller.js` 的微信 Session 映射读取保留了 0.2.1-rc.2 的兼容边界，需在升级 Harness 时单独验证。它们不会读取微信凭据或历史消息。

## Native smoke checks / 原生验证

```powershell
$env:AGENT_HUB_DSH_EXE = 'C:\DSH\DeepSeek Harness.exe'
node scripts/live-harness-smoke.js
node scripts/live-ui-smoke.js
```

The browser check additionally requires Edge; override `AGENT_HUB_EDGE` if needed. Both checks create isolated profiles under ignored `.work/`, disable model-driven helpers and use fake IM. Inspect logs locally; do not attach auth URLs, tokens or personal Session data to public issues.

页面检查额外需要 Edge，可用 `AGENT_HUB_EDGE` 指定路径。两项检查在 `.work/` 的独立 profile 中运行，不进行模型推理或真实微信投递。公开 issue 只附脱敏诊断信息。

## Packaging / 打包

See [deployment](docs/DEPLOY.en.md). `check:public` audits the public source allowlist, metadata, local import graph and documentation links; pass `--tracked` to audit all Git-tracked files before publishing. A source tree may contain ignored operator data, but none may enter commits or release archives.

参见[部署说明](docs/DEPLOY.md)。公开检查覆盖源码白名单、插件元数据、本地依赖图和文档链接；发布前使用 `node scripts/check-public.js --tracked` 检查全部 Git 跟踪文件。运行数据与备份仅留本地。
