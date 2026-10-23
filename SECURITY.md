# Security / 安全报告

Please do not include credentials, device tokens, private keys, full conversations, raw command output or personal Session identifiers in public issues. Report a reproducible vulnerability privately through [GitHub private vulnerability reporting](https://github.com/810535323/dsh-agent-hub/security/advisories/new) when available. If the form is unavailable, open an issue containing only a request for a private contact channel.

请勿在公开 issue 中提供凭据、设备 token、私钥、完整对话、原始命令输出或个人会话编号。可复现漏洞请优先使用上述 GitHub 私密漏洞报告；若入口不可用，仅发起请求私密联系渠道的 issue，不公开漏洞细节。

The Hub can dispatch tasks with the worker's locally granted permissions. Pair only devices and operators you trust. Use HTTPS/WSS with a matching certificate, keep keys and ledgers outside the plugin directory, and preserve worker-local approval policies. The protocol limits automatic result fields; it cannot redact secrets intentionally included in prompts or final answers.

主机可在从机本地授权范围内派发任务。仅绑定可信设备与主机，使用证书匹配的 HTTPS/WSS，将密钥与账本放在插件目录之外，并保留从机本地审批策略。协议限制自动回传字段，但无法保证任务提示或最终答复中主动包含的秘密得到隐藏。
