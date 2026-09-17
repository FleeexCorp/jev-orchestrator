# Changelog

Published as `@fleeex/jev-orchestrator`.

## 0.1.0

- Session log: every `decide` and `codex run` appends to `.jev/sessions/<session>.jsonl`; `report` summarizes decisions, tiers, policy overrides, tokens, estimated cost and worker runs.
- `decide worker`: Jev answers what capability each subtask needs and whether it needs judgment; code resolves that to a Codex model or a Claude subagent. `workers list`; `codex run --reasoning`.
- Claude Code skill (global or project scope) with automatic and manual invocation.
- `decide` command: strategy, parallel, retry, review, completion, stuck.
- TypeSafe Jev client on the official SDK with typed answers and confidence tiers.
- Codex worker adapter over `codex exec --json`, sandboxed, prompt via stdin.
- Git worktree isolation with manifest-tracked cleanup.
- `setup`, `doctor`, `install`, `uninstall`, `demo` commands.
