# Orchestration workflow

This document expands the eight steps in `SKILL.md`. The helper CLI is
`${CLAUDE_SKILL_DIR}/scripts/jev-orchestrator`; every example below abbreviates
it as `jev`.

## 0. When not to orchestrate

Skip the skill entirely when:

- the user asked a question, not for a change;
- one small edit is obvious;
- the task is mostly design or reasoning;
- writing worker prompts would take longer than the implementation;
- the decision is irreversible or safety-critical;
- you cannot describe the state well enough for a meaningful answer.

## 1. State file

Write the minimum state to a temp file. All fields are optional except
`userGoal`. Keep repository summaries short; never paste file contents.

```json
{
  "userGoal": "Add Google OAuth login across backend and frontend with tests",
  "currentPlan": ["backend callback + token exchange", "frontend login button + session", "e2e tests"],
  "repositorySummary": "NestJS API in apps/api, React SPA in apps/web, Playwright in e2e/",
  "subtasks": [
    { "id": "backend", "title": "OAuth callback endpoint", "files": ["apps/api/src/auth"] },
    { "id": "frontend", "title": "Login button and session store", "files": ["apps/web/src/auth"] },
    { "id": "tests", "title": "Playwright login flow", "files": ["e2e/auth"], "dependsOn": ["backend", "frontend"] }
  ],
  "codexAvailable": true,
  "worktreesAvailable": true
}
```

Then: `jev decide strategy --state-file /tmp/state.json`

## 2. Plan

You own decomposition. Good subtasks:

- touch disjoint files or directories (declare them in `files`);
- have a verifiable outcome (tests, build, a concrete artifact);
- fit in one worker prompt without needing product decisions.

Declare `dependsOn` when order matters. The parallel decision refuses to run
overlapping subtasks concurrently. Mark a subtask `"irreversible": true` when it
deletes data, deploys, force-pushes or has external side effects: it then stays
with you and is always reviewed, whatever Jev says.

## 3. Parallelization

`jev decide parallel --state-file /tmp/state.json --max-workers 3`

Output includes, per subtask, `codexSuitable` and `needsClaude` signals plus a
`suggestedWorker`. Keep `claude` subtasks for yourself or a native subagent.

## 4. Dispatch

Write workers in parallel each need their own worktree:

```bash
jev worktree create backend        # -> .jev/worktrees/backend-a1b2c3 on branch jev/backend-a1b2c3
jev worktree create frontend
jev codex run --id backend  --cwd .jev/worktrees/backend-a1b2c3  --task-file /tmp/backend.md --json
jev codex run --id frontend --cwd .jev/worktrees/frontend-d4e5f6 --task-file /tmp/frontend.md --json
```

Run them from separate Bash calls (or in the background) so they overlap.
Read-only analysis workers can share the main tree with `--read-only`.

You may dispatch to anything else too: your own edits, `Agent` subagents,
MCP tools. The skill never forces Codex.

## 5. Observe

For each worktree: `git -C <worktree> diff --stat`, run its tests, read the
worker summary. Put that into the state as `workerResult`, `changedFiles`,
`testResults`.

## 6. Follow-up decisions

| Situation | Command | Options returned |
|---|---|---|
| Which worker per subtask | `jev decide worker` | capability plus adapter, resolved to a model, with its dispatch line |
| Worker finished | `jev decide review` | accept, review_with_claude, retry, reject |
| Worker failed | `jev decide retry` | continue, review, retry_same_worker, spawn_debug_worker, replan, finish |
| No progress | `jev decide stuck` | continue, spawn_debug_worker, replan, finish |
| All done? | `jev decide completion` | continue, review, finish, replan |

Code-level policy always wins over Jev: failing tests block `accept` and
`finish`; sensitive files force `review_with_claude`; a repeated failure blocks a
blind `retry_same_worker`.

## 7. Review

Read the diff yourself whenever the recommendation is `review_with_claude`, the
tier is `advisory` or `fallback`, the worker touched files outside its scope,
or the summary lists concerns. Semantic review is your job, not Jev's.

## 8. Integrate and finish

Every `decide` and `codex run` appends to `.jev/sessions/<session>.jsonl`:
questions asked, raw answers, the recommendation after policy, tokens, latency,
worker outcomes. `jev report <session>` summarizes it (`--timeline` for the
sequence, `--json` for machines, `--raw` for the records). Tell the user what
Jev cost: it is the only honest way to know whether orchestration helped.


```bash
git merge --no-ff jev/backend-a1b2c3      # or cherry-pick / rebase, your call
git merge --no-ff jev/frontend-d4e5f6
pnpm test
jev worktree cleanup --all --delete-branches
```

Never let confidence numbers stand in for a test run.
