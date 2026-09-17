# jev-orchestrator

Give Claude Code a fast System One control plane.

Claude reasons.
Jev decides.
Codex executes.

```
                   User
                     │
                     ▼
                  Claude            lead, architect, reviewer
                     │
              bounded question?     "delegate? parallel? retry? review? stop?"
                     │
          ┌──────────▼──────────┐
          │        JEV          │   TypeSafe System One model: typed answers
          │   decision layer    │   with probabilities, ~hundreds of ms
          └──────────┬──────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
      Codex        Codex        Codex      workers, one git worktree each
        │            │            │
        └────────────┼────────────┘
                     ▼
                  Claude            review, integration, final tests
```

## What this is

You use Claude Code as usual. When a task is big enough to split (backend,
frontend, tests), Claude can hand the small orchestration decisions to
[Jev](https://docs.typesafe.ai), TypeSafe's fast decision model, and hand the
well-specified coding chunks to [OpenAI Codex](https://developers.openai.com/codex/cli)
workers running in isolated git worktrees. Claude keeps the thinking: design,
splitting the work, reviewing diffs, integrating, talking to you.

`jev-orchestrator` is the [Claude Code skill](https://code.claude.com/docs/en/skills)
that teaches Claude this workflow, plus the small CLI the skill calls. Claude
invokes it on its own when a task looks like it would benefit from delegation;
you can also type `/jev-orchestrator`.

You need a TypeSafe API key. Codex is optional: without it, Claude still gets
Jev's decisions and does the work itself.

## Why

Orchestrating coding agents produces a stream of small decisions: is this worth
delegating, can these two things run at once, did that worker finish, should it
retry, is the loop stuck. Spending a frontier model's reasoning on each of them
is slow and expensive. [Jev](https://docs.typesafe.ai) answers exactly this kind
of bounded question quickly, with a calibrated probability, so Claude can keep
its attention on design, review and integration.

## What Jev does

- Picks one option from a set you define (`parallel_codex` vs `single_codex` vs
  `claude_direct`) and returns the full distribution plus a confidence.
- Answers yes/no with a probability (is this task trivial? is this failure
  repetitive? did the worker stay in scope?).
- Says what capability each subtask needs (fast, balanced, strong) and whether it
  needs judgment rather than execution. Code maps that to a concrete worker:
  every Codex model your account exposes (read from the Codex CLI's local model
  cache), the Claude subagent aliases `haiku` / `sonnet` / `opus`, and anything
  you add in config.
- Does it in one HTTP round trip per decision, with several independent
  questions per call.

## What Jev does not do

- Design architecture or write plans.
- Write code or diagnose root causes.
- Interpret ambiguous requirements.
- Authorise anything irreversible. Deletes, force pushes, deployments, secret
  access and external side effects always go through Claude and your existing
  Claude Code permission rules, whatever the confidence.

Jev is not a chat model and this project never uses it as one.

## Install

Requirements: Node.js 20+, git, Claude Code. Codex CLI is optional.

```bash
npx jev-orchestrator setup
```

```
Where should Jev Orchestrator be installed?

❯ Global   available in every Claude Code project   (~/.claude/skills/jev-orchestrator)
  Project  only in the current repository           (./.claude/skills/jev-orchestrator)
```

Setup then validates your TypeSafe key, checks Codex, installs the skill and
writes `~/.config/jev-orchestrator/config.json`. Non-interactive variants:

```bash
jev-orchestrator install --scope global
jev-orchestrator install --scope project
jev-orchestrator setup --yes --skip-codex
jev-orchestrator uninstall --scope global
```

Project installs contain no secrets. Commit `.claude/skills/jev-orchestrator`
so teammates get the skill; they still need their own `TYPESAFE_API_KEY`.

Check everything with:

```bash
jev-orchestrator doctor
```

## TypeSafe key

`TYPESAFE_API_KEY` is the canonical variable. Setup checks it first, otherwise
asks for a key, validates it against `GET /v1/models`, and offers:

- **Store securely for jev-orchestrator**: `~/.config/jev-orchestrator/secrets.json`, mode `0600`.
- **Use environment variable only**: nothing written.

Get a key at <https://typesafe.ai>. The key is only ever sent to `api.typesafe.ai`.

## Codex

Codex is optional. Without it, Claude still gets Jev decisions and does the
work itself or with native subagents.

```bash
npm install -g @openai/codex     # or: brew install --cask codex
codex login                      # ChatGPT sign-in, or:
printenv OPENAI_API_KEY | codex login --with-api-key
jev-orchestrator codex status
```

jev-orchestrator reuses the Codex CLI's own session and never reads or copies
`~/.codex/auth.json`.

## Using it

### Automatic invocation

Just work normally:

```
> Implement Google OAuth: backend callback, frontend button, e2e tests.
```

Claude reads the skill description, decides the task is separable, and invokes
`jev-orchestrator`. It writes a plan, asks Jev whether to parallelize, launches
Codex workers in isolated worktrees, asks Jev whether each result needs review,
then reviews and integrates.

### Manual invocation

```
/jev-orchestrator
/jev-orchestrator implement OAuth across backend and frontend
```

### Example session

```
You:
Implement the billing settings page and backend endpoints.

Claude:
I'll split the implementation into independent backend and frontend work.

[Jev: execution_strategy parallel_codex 0.89, autonomous]
[Jev: independent 0.94, parallel_worthwhile 0.90]

Codex worker A → backend   (.jev/worktrees/backend-a81c, branch jev/backend-a81c)
Codex worker B → frontend  (.jev/worktrees/frontend-c21f, branch jev/frontend-c21f)

[Jev: backend review accept 0.91]
[Jev: frontend review review_with_claude 0.88; scope_respected 0.40]

Claude reviews worker B, fixes a hardcoded API URL, merges both branches,
runs the test suite and reports.
```

### Demo

```bash
jev-orchestrator demo          # uses Jev if a key exists, else a clearly labelled mock
jev-orchestrator demo --mock
```

## The CLI Claude uses

```
jev-orchestrator decide <strategy|parallel|worker|retry|review|completion|stuck> --state-file s.json [--json] [--verbose]
jev-orchestrator workers list
jev-orchestrator report [session] [--list] [--timeline] [--json]
jev-orchestrator codex run --task-file t.md --cwd DIR [--id NAME] [--model M] [--reasoning high] [--read-only] [--json]
jev-orchestrator worktree create|list|remove|cleanup
```

`decide` output:

```json
{
  "kind": "review",
  "recommendation": "review_with_claude",
  "confidence": 0.88,
  "tier": "autonomous",
  "probabilities": { "review_with_claude": 0.88, "accept": 0.09, "retry": 0.02, "reject": 0.01 },
  "signals": { "likely_complete": { "probability": 0.86, "yes": true, "tier": "advisory" } },
  "policyNotes": ["Files outside declared scope changed (apps/web/src/config.ts); accept is not allowed blind."],
  "guidance": "Confidence is high; you may follow this recommendation."
}
```

`--verbose` shows every option:

```
JEV  strategy
     parallel_codex            0.89
     single_codex              0.07
     claude_direct             0.04

CODEX backend
      started                  workspace-write  .jev/worktrees/backend-a81c
```

## Measuring what Jev did

Every `decide` call and every `codex run` appends one JSON line to
`.jev/sessions/<session>.jsonl` (or `~/.config/jev-orchestrator/sessions/`
outside a repo): the questions asked, the raw probabilities, the recommendation
after policy, tokens, latency, worker status and duration. Group a task under one
session with `--session <id>`; the skill passes Claude's session id.

```bash
jev-orchestrator report --list
jev-orchestrator report <session>              # summary: decisions, tiers, overrides, tokens, cost
jev-orchestrator report <session> --timeline   # every decision and worker run, in order
jev-orchestrator report <session> --json       # machine-readable; --raw dumps the records
```

```
Session 2026-09-17
Jev
decisions                   7
by kind                     review 3, strategy 1, parallel 1, worker 1, completion 1
by tier                     autonomous 5, advisory 2
policy overrides            2
API calls                   7
input tokens                18420
estimated cost              $0.0008
latency                     2910 ms total, 415 ms mean
Workers
runs                        2
by status                   completed 2
```

Cost uses `sessions.inputPricePerMtok` (default 0.042 USD, TypeSafe list price;
output tokens are free). Mock engine calls are logged but excluded from cost.
Set `sessions.recordState: true` to also keep the state projection Jev saw.

## Confidence policy

| Confidence | Tier | Behaviour |
|---|---|---|
| >= 0.85 | `autonomous` | orchestration may follow the recommendation |
| 0.60 to 0.85 | `advisory` | Claude reviews before acting |
| < 0.60 | `fallback` | Claude reasons on its own |

Thresholds are configurable. On top of Jev's answer, code-level policy applies
hard rules that no confidence can override: trivial tasks stay with Claude,
failing tests block `accept` and `finish`, sensitive files force Claude review,
repeated failures block blind retries, overlapping subtasks never run in parallel.

## Configuration

User: `~/.config/jev-orchestrator/config.json`. Project: `.jev/config.json`
(overrides field by field, never holds secrets). Validated with Zod.

```json
{
  "version": 1,
  "jev": { "model": "jev-latest", "timeoutMs": 5000 },
  "decisions": { "autonomousThreshold": 0.85, "fallbackThreshold": 0.60 },
  "codex": { "enabled": true, "maxParallelWorkers": 3, "workerTimeoutMs": 1800000 },
  "worktrees": { "enabled": true, "directory": ".jev/worktrees" },
  "sessions": { "enabled": true, "directory": ".jev/sessions", "recordState": false, "inputPricePerMtok": 0.042 },
  "workers": {
    "includeCodexModels": true,
    "includeClaudeModels": true,
    "catalog": [
      { "id": "codex:gpt-5.6-sol", "adapter": "codex", "model": "gpt-5.6-sol", "tier": "strong", "reasoningEffort": "high" },
      { "id": "claude:haiku", "adapter": "claude_subagent", "model": "haiku", "enabled": false }
    ]
  }
}

`workers.catalog` entries add candidates or override discovered ones (same `id`);
`enabled: false` hides one. `jev-orchestrator workers list` prints the result.
```

## Security model

- Claude Code's permission system stays authoritative. The skill pre-approves
  exactly one command, its own helper script, and nothing else. No `Bash(*)`,
  no `--dangerously-skip-permissions`, no `context: fork`, no `disallowed-tools`.
  The helper never downloads code: if the CLI it points to is gone, it exits
  with a reinstall hint instead of running `npx`.
- Jev advises orchestration; it cannot trigger destructive actions.
- Codex runs with its sandbox on (`read-only` or `workspace-write`, scoped to
  the worktree). Approval-bypass flags are never passed.
- Two write workers never share a working tree: `codex run` takes a per-directory
  lock. Only worktrees recorded in `.jev/worktrees.json` can be removed; branches
  are kept unless you ask.
- Child processes are started with `spawn()` and argument arrays. Task text
  goes to Codex over stdin, never through a shell.
- Secrets: env var first, else a `0600` file in the user config dir. Never
  logged, never written into a repository, never copied from Codex. The TypeSafe
  key is stripped from every Codex worker's environment and redacted from its output.
- Tasks marked `irreversible` (deletes, deploys, force pushes, external side
  effects) are never delegated and always reviewed, whatever Jev's confidence.

## Architecture

```
src/
├── cli/            commander entry, setup, doctor, install, decide, codex, worktree, demo
├── config/         paths, Zod schema, user + project loader
├── jev/            DecisionEngine interface, TypeSafe client (official SDK), mock engine
├── orchestration/  bounded decisions: strategy, parallel, retry, review, completion, stuck
├── codex/          detect, auth, JSONL parser, CodexWorkerAdapter
├── workers/        WorkerAdapter interface (Codex first; others can plug in)
├── git/            repo helpers, WorktreeManager
├── security/       SecretStore interface, FileSecretStore
└── skill/          installer for ~/.claude/skills and .claude/skills
skill/              SKILL.md + references shipped in the npm package
```

`DecisionEngine` and `WorkerAdapter` are the two extension points: other
decision models or other coding agents (Claude subagents, Gemini CLI, OpenCode,
local models) can be added without touching orchestration code.

## Development

```bash
pnpm install
pnpm build
pnpm test        # Vitest; no real Jev or Codex credentials needed
pnpm check       # typecheck + lint + test
```

## Limitations

- No benchmark yet. This project does not claim Jev makes orchestration better;
  it makes a class of decisions cheaper and observable. Measure on your tasks.
- Jev sees only the state Claude gives it. Thin state produces low confidence,
  which the tiers surface, but garbage in still means garbage out.
- Codex workers run to completion without mid-run questions.
- Secret storage is a file, not the OS keychain (the interface allows adding one).
- Claude Code auto-invocation depends on the skill description; it is a
  suggestion to the model, not a guarantee.
- Windows is untested; the helper ships a `.cmd` shim but paths and worktrees
  have only been exercised on macOS and Linux.

## License

MIT
