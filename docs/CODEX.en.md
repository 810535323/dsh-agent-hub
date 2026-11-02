# Calling Codex through worker Harness

[简体中文](CODEX.md) | English

The target device's Harness calls Codex through local subagents/tools. There is no standalone Codex Worker. Routing is implemented on the Hub using the existing worker protocol, so bound workers need no reinstall or pairing change. Their local tools must support native Codex session discovery, live state checks and explicit-ID resume.

| Intent | Behavior |
| --- | --- |
| Ordinary Codex request | `single`: independent task in a new saved native conversation |
| Explicit new conversation | `new`: create and save, without `--ephemeral` |
| Find or list sessions | `search`: read-only; never starts a continuation |
| Continue previous or ongoing work | `continue`: search related Hub tasks, then ask worker Harness to discover native sessions |

The main Agent can use `agent_hub_tasks_search` with keywords, endpoint, project, task ID or native Session ID. `agent_hub_dispatch` accepts an optional `codex` object: `mode` (defaults to `auto`), `query`, `project_path`, `task_id`, `session_id`. The Agent should supply it explicitly when conversation context refers to Codex, even if the latest sentence omits its name. Explicit modes take precedence over automatic text classification.

An existing running task returns `wait`; pending approval/input returns `interaction_required`; uncertain execution returns `needs_reconciliation`. None starts a duplicate task or interrupts the original turn. A status-only question should query the existing task.

Discovery returns only native session ID, title, absolute project directory, update time, live state and match reason. A continuation is created atomically only for a unique, matching, verified-idle session. The worker must recheck before explicit-ID resume. It must not use `--last` or silently create another conversation after resume fails. Multiple candidates require user selection. Missing matches, unknown state, missing capabilities, changed bindings and offline devices stop continuation with an explanation. Completed task references supply saved identity and project context but still require fresh discovery.

`agent_hub_task` exposes `codex_resolution` and `followup_task`. Successful discovery is an internal step, not completion of the user request, and produces no separate WeChat report. The final execution result is summarized by the main AI and delivered once. Cancelling the original search ID cancels its follow-up; late results cannot restart a cancelled search.

Native session metadata is stored for later lookup when available. Full conversations, reasoning and raw command output are not synchronized. Missing recoverable IDs are marked `codex_tracking=unavailable`; they must not be reported as a saved binding. Automated end-to-end tests use a simulated Codex adapter. Actual native discovery/resume depends on each worker's local Harness tools; unsupported capabilities are reported rather than fabricated.
