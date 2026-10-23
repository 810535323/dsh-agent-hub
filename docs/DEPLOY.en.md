# Deployment and migration

[简体中文](DEPLOY.md)

The public `deployment.json` is empty. Configure the Hub's public URL, listener, port and TLS file paths in plugin settings. Store operational certificates and private keys outside the plugin directory. Direct IP certificates need the public IP in SAN; distribute only a private CA's public certificate to workers over a trusted channel. `deployment.example.json` uses a reserved documentation address.

Before upgrading, back up source, the desktop profile, plugin settings, TLS configuration and consistent SQLite snapshots. Use the same Harness installer for Hub and workers. It preserves role, WeChat targets, native Sessions, listener settings and existing ledgers, and restores the profile on installation failure. Existing data is adopted in place rather than copying device tokens into another installation.

Legacy mixed-runtime bindings migrate only after the process lease is acquired and unfinished retired Codex tasks have been ruled out. The previous runtime configuration is backed up locally; the device identity, Harness Session, credentials and receipts remain. Retired Codex Session records become read-only. Codex-only directories are never automatically taken over.

A running task may submit its result after a brief WSS reconnect. Do not cancel user tasks merely to upgrade. Compare the original task, attempt and Session before and after migration. Development checks should use isolated profiles without real WeChat test messages or tasks on user devices.

The plugin no longer creates standalone login launchers. It cleans up only legacy startup registrations for the Harness worker binding it successfully owns. Other directories and Codex startup settings are unchanged. If a standalone worker still owns the directory, stop that service normally before plugin takeover.

## Building local archives

On Windows, set `AGENT_HUB_PNPM` to the local `pnpm.cjs`, then run:

```sh
pnpm run check
pnpm run check:public
pnpm test
node scripts/package.js
```

The builder produces stable filenames, SHA-256 checksums, an index and installation text in `dist/`. Public packages contain no operator configuration, certificates, private keys, databases or user credentials. Building does not upload to a Hub download endpoint or create a GitHub Release.
