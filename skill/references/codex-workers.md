# Codex workers

`jev codex run` wraps `codex exec --json` (non-interactive Codex CLI). The
prompt goes over stdin, the sandbox stays on, and approval-bypass flags are
never used.

## Commands

```bash
jev codex status                       # installed? version? logged in?
jev codex run --task "..." --cwd DIR   # inline task
jev codex run --task-file FILE --cwd DIR --id NAME [--context-file FILE] [--read-only] [--model M] [--reasoning low|medium|high|xhigh|max] [--timeout-min N] [--json]
jev workers list                       # models Jev can assign: Codex (from local cache) + Claude aliases
```

- Write workers run with `--sandbox workspace-write` scoped to `--cwd`.
- `--read-only` runs `--sandbox read-only`; safe against the main tree.
- Output (with `--json`) is a `WorkerResult`:

```json
{
  "id": "backend",
  "status": "completed",
  "summary": "Added AuthController.callback ... 12 tests pass.",
  "changedFiles": ["apps/api/src/auth/auth.controller.ts", "apps/api/test/auth.e2e-spec.ts"],
  "commandsRun": 6,
  "exitCode": 0,
  "durationMs": 184233
}
```

`status` is `completed`, `failed`, `cancelled` or `timed_out`. A `completed` status means the
process exited cleanly, not that the work is correct. Always run `decide review`
and read what matters.

## Writing worker prompts

Bad:

```
Build the feature.
```

Good:

```
Implement only the backend OAuth callback in apps/api/src/auth:
- GET /auth/google/callback exchanging the code for tokens via the existing HttpService
- persist the user with UsersService.upsertFromGoogle (already exists)
- unit tests in apps/api/src/auth/*.spec.ts

Do not modify apps/web or e2e/. Run `pnpm --filter api test`.
Return a concise summary of files changed and remaining concerns.
```

Rules of thumb:

1. One component per worker. Name the directories it may touch.
2. State what already exists so the worker does not reinvent it.
3. Give the verification command.
4. Forbid what it must not touch.
5. Ask for a summary with remaining concerns.

Put interfaces, type signatures or API contracts in `--context-file` rather than
inline, so the task line stays a task.

## Isolation

A write worker takes a per-directory lock under `.jev/locks/` for the duration of
its run; a second write worker on the same directory is refused with a hint to
create a worktree. Read-only workers never lock.


Two write workers must never share a working tree. Use worktrees:

```bash
jev worktree create backend    # prints path and branch jev/backend-xxxxxx
jev worktree list
jev worktree remove backend-xxxxxx [--force] [--delete-branch]
jev worktree cleanup [--all] [--force] [--delete-branches]
```

Worktrees live under `.jev/worktrees/` (config `worktrees.directory`) and are
excluded from `git status` via `.git/info/exclude`. Only worktrees recorded in
`.jev/worktrees.json` can be removed by these commands; user worktrees and
branches are never touched. Branches are kept unless you pass
`--delete-branches`, so unmerged Codex work is not lost by accident.

## Authentication

`jev codex status` reports one of:

- installed and logged in (ChatGPT or API key): ready;
- installed, not logged in: run `codex login` (browser) or
  `printenv OPENAI_API_KEY | codex login --with-api-key`;
- not installed: `npm install -g @openai/codex` or `brew install --cask codex`.

jev-orchestrator never reads or copies `~/.codex/auth.json`.

## Limits

- Codex workers cannot ask you questions mid-run; give them everything up front.
- A worker's "tests pass" claim is a claim. Re-run tests yourself after merging.
- Default worker timeout is 30 minutes (`codex.workerTimeoutMs`).
