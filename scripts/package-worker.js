import { readFileSync, writeFileSync, copyFileSync, cpSync, mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
export async function packageHarness(root, out) {
  const stage = mkdtempSync(join(root, '.work/harness-release-'))
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const file of [...manifest.files, 'package.json']) cpSync(join(root, file), join(stage, file), { recursive: true })
  mkdirSync(join(stage, 'scripts')); copyFileSync(join(root, 'scripts/install-harness.ps1'), join(stage, 'scripts/install-harness.ps1'))
  mkdirSync(join(stage, 'node_modules')); cpSync(realpathSync(join(root, 'node_modules/ws')), join(stage, 'node_modules/ws'), { recursive: true })
  copyFileSync(join(out, 'dsh-agent-hub.tgz'), join(stage, 'dsh-agent-hub.tgz'))
  const name = 'agent-hub-harness.zip', zip = join(out, name)
  const packaged = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -Path (Join-Path $env:AGENT_HUB_STAGE "*") -DestinationPath $env:AGENT_HUB_ZIP -Force'], { env: { ...process.env, AGENT_HUB_STAGE: stage, AGENT_HUB_ZIP: zip }, windowsHide: true, encoding: 'utf8' })
  if (packaged.status !== 0) throw Error('Harness ZIP packaging failed: ' + packaged.stderr)
  const hash = body => createHash('sha256').update(body).digest('hex'), checksum = hash(readFileSync(zip))
  writeFileSync(zip + '.sha256', checksum + '  ' + name + '\n')
  const text = `请在当前机器安装或升级 Agent Hub 最新版本，只安装 DeepSeek Harness 插件。

安装包：${name}
SHA-256：${checksum}
公开安装包不预置运营主机。主机地址、一次性配对码和私有 CA 的公开证书由主机所有者提供。

1. 验证 ZIP 摘要，解压到固定目录。未收到文件时向我索取，不要猜测下载地址。
2. 打开本机 DeepSeek Harness 一次。运行 powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\install-harness.ps1 -HarnessPath 本机Harness.exe路径。安装器保留主机角色、微信绑定、设备凭据和 Session。
3. 从机打开“设置 → Agent Hub 设备”，填写主机地址、配对码、设备名称和项目目录，点击“绑定并自动连接”。私有 CA 需填写其公开证书的本机路径并向主机所有者核对指纹。只升级时不要重新配对。
4. 检查通信和固定 Harness Session 就绪。后续任务和重启复用该会话。随 Harness 开启自动连接，退出 Harness 后停止。
5. 需要 Codex 时由本机 Harness 通过本地 sub agent 调用。缺少调用能力时明确报告，不要伪称已调用。
6. 保留模型、会话、工具、凭据和旧执行账本。安装后报告角色、连接和 Session 状态。解绑在同一页面操作。

English guide: README.en.md and docs/INSTALL.en.md.
`
  writeFileSync(join(out, 'INSTALL-HARNESS.txt'), text)
  writeFileSync(join(out, 'release-index.json'), JSON.stringify({ channel: 'latest', version: 'latest', files: [name, name + '.sha256', 'dsh-agent-hub.tgz', 'dsh-agent-hub.tgz.sha256', 'INSTALL-HARNESS.txt'].map(name => ({ name, size: readFileSync(join(out, name)).length, sha256: hash(readFileSync(join(out, name))) })) }, null, 2))
  console.log(JSON.stringify({ channel: 'latest', zip, sha256: checksum }))
}
