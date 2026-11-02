# Architecture

[简体中文](ARCHITECTURE.md)

WeChat ↔ DSH-IM ↔ main Harness Agent ↔ Hub ↔ outbound WSS ↔ worker Harness plugin ↔ persistent Session → optional local sub agent, including Codex. Results are first queued durably. Once the main Session is idle, the main AI summarizes them and the plugin sends one consolidated WeChat report.

## Execution and recovery

Each device exposes one Harness endpoint with one persistent Session. Work is serial within that Session and concurrent across devices. A confirmed missing Session can be recreated and its reset reported. Temporary access, authentication and runtime errors do not create replacements.

The Hub rejects offline dispatch immediately. An accepted task is saved before transmission; the worker saves acceptance before acknowledging it. Task ID, attempt ID, binding generation, native Session and native turn correlate all execution and results. A local sub agent must be awaited and summarized by the parent Harness; its own completion cannot finish the parent task. Native turn completion and verified user-goal achievement remain separate concepts.

Both sides use SQLite transactions for tasks, messages and receipts. Explicit durable result acknowledgement stops retransmission and is retained for audit. A running worker may continue during disconnection and reconcile on reconnect. An unstarted task whose acceptance cannot be confirmed does not silently execute later. After a crash at a potentially submitted native turn, recovery first checks exact native evidence; unresolved cases become uncertain and are never blindly rerun.

## Results, consumption and delivery

A transaction commits the result, main-Agent mailbox entry, an awaiting_summary notification and worker-result receipt before acknowledging the worker. No worker excerpt is sent at this stage. An idle-only plugin-origin turn requests the main AI summary, correlated by task, revision, message and native turn. A second transaction saves the summary, consumption receipt and outgoing text before WeChat delivery.

WeChat delivery has its own durable receipt. A crash during sending or an ambiguous response leaves `unknown` status for investigation. An explicit failure may be retried within the configured bound. Changing a WeChat binding blocks old notices rather than redirecting them to a different target.

The plugin no longer enqueues a second result reminder. Failed or empty summaries stay visible as needs_attention without falling back to raw answers. Restart recovery reconciles the exact native summary turn before any retry. Delivery retries reuse a saved summary without another AI call. Already sent or ambiguous legacy notices remain unchanged; unsent raw notices migrate into the summary queue. A newer revision supersedes an unsent old summary. Manual read acknowledgements cannot bypass the summary stage.

## Permissions and privacy

Workers retain local permission policies. Approval and question requests are correlated to the exact task, request and expiry. Only actual human decisions or observed human replies are forwarded; the main Agent cannot approve on the user's behalf. The Hub does not manage standalone Codex processes, credentials or Threads.

Automatic results include only the task's final answer, execution status, verification summary, exit codes and device-local artifact references. Credentials, reasoning, full conversation histories and raw tool output are not automatically synchronized. Files are not uploaded. Users and local Agents still control what they include in prompts and final answers.

Protocol version fields and legacy routes support outstanding receipts and historical results. Retired Codex endpoints cannot receive new work, but their historical records remain available.

## Source boundaries

| Module | Responsibility |
| --- | --- |
| `plugin.js`, `controller.js` | Cordis lifecycle, role configuration and owned runtime teardown |
| `hub-runtime.js` | Hub startup, main-Agent tools and prompt registration |
| `hub.js`, `worker.js`, `store.js` | Protocol, task state, transactional persistence and receipts |
| `harness-host.js`, `harness-bridge.js` | Local native Session integration and worker transport |
| `report-queue.js`, `reports.js` | Durable unread results and revision acknowledgements |
| `master.js` | Independent WeChat delivery and real user interactions |
| `client.js`, `management.js` | Shared-module client entry and authenticated management surface |

The client uses Harness' shared modules rather than bundling another React instance. Runtime setup and teardown follow Cordis effects and declared service injection.
