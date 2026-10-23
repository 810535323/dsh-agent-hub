# Installation and device management

[简体中文](INSTALL.md)

Public packages contain no operator address or certificate. Workers initiate outbound WSS connections and need no inbound port. The Hub owner supplies an HTTPS URL, a one-time pairing code and, for private CAs, the public CA certificate.

## Native plugin installation

With the `dsh` CLI available:

```sh
dsh plugin --profile desktop add github:810535323/dsh-agent-hub
```

For source development:

```sh
git clone https://github.com/810535323/dsh-agent-hub.git
cd dsh-agent-hub
pnpm install --frozen-lockfile
dsh plugin --profile desktop add link:/ABSOLUTE/PATH/dsh-agent-hub
```

JavaScript and the client entry are ready to run; no build is required. Reopen Harness and choose a role in **设置 → Agent Hub 设备**. If `dsh` is not on PATH, use the CLI distributed with Harness or the Windows installer below.

## Windows desktop installer

Extract `agent-hub-harness.zip` into a stable directory. When installing from source instead of a built archive, install dependencies first. Open Harness once, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-harness.ps1 -HarnessPath 'C:\DSH\DeepSeek Harness.exe'
```

The installer uses Harness' bundled Node and native plugin manager, requires Node 24+, and preserves an existing Hub role. A new installer-based installation defaults to worker mode. Explicitly choose `-Role hub` or `-Role harness` to change roles. The fixed installation directory is `HarnessHome/plugins/dsh-agent-hub`; upgrades replace the same plugin. The settings page reports incompatible native APIs as startup errors.

## Pairing and Sessions

On the Hub settings page, select the synchronized WeChat target and its actual main Session. Configure the public HTTPS URL, listener and local certificate/key paths, then generate a five-minute one-time pairing code. Direct IP TLS requires an IP SAN in the certificate.

On the worker page, enter the Hub URL, code, device name and project directory, then select **绑定并自动连接**. For a private CA, enter the public CA certificate's local path and verify its fingerprint with the Hub owner. Check communication and Session readiness. The plugin creates a dedicated Session when none is bound; you can instead bind an existing Session. The same Session is reused across tasks and restarts. Model, credential and runtime failures do not cause silent Session replacement.

The plugin connects when Harness opens and stops when Harness exits. No separate login script or background service is needed. Harness must be running to accept tasks.

## Results and optional Codex work

The Hub's pending-results panel shows unread task results and independent WeChat delivery status. Completion notices do not wait for the current main-Agent turn. The main Agent reads `agent_hub_pending_reports` and explicitly acknowledges revisions with `agent_hub_ack_reports`. Ambiguous delivery is retained for investigation and is not automatically retried.

For Codex work, ask the remote Harness to invoke its locally configured Codex sub agent, wait for it and summarize verified evidence. This plugin does not install Codex, manage its Threads or approve its operations. Missing local sub-agent support must be reported honestly.

## Unpairing and CLI assistance

Unpair from either device's settings page. The worker removes its local binding only after receiving the Hub's durable revocation receipt; native Sessions, task history and receipts remain. Active or uncertain tasks block unsafe replacement and unpairing.

With Node 24+, `node bin/agent-hub.js doctor`, `check`, `status` and `unpair` help diagnose an installation. Pairing is also available as:

```sh
node bin/agent-hub.js pair --hub https://YOUR_PUBLIC_IP:9443 --code CODE --cwd PROJECT
```

Add `--ca-file PATH` for a private CA. Replacing a binding requires `--replace`; the owning plugin safely closes and restores its worker. Standalone `start` and new login-autostart registrations are intentionally unavailable. Retired Codex-only worker directories are never adopted as Harness credentials.
