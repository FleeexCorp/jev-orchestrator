---
name: jev-orchestrator
description: >
  Fast orchestration layer for complex coding tasks. Use proactively when a task
  may benefit from delegation, several coding workers, parallel work, retry or
  review decisions, or deciding whether more agent work is needed. Asks TypeSafe
  Jev bounded questions (delegate? parallel? which worker? retry? review? stop?)
  and can launch OpenAI Codex workers in isolated git worktrees. Claude stays
  lead architect, integrator and final reviewer, and keeps every normal tool.
when_to_use: >
  Multi-file or multi-component implementations; separable backend, frontend
  and test work; debugging that a worker could take; parallelizable coding;
  deciding whether a worker result needs review or a retry; workflows where
  picking the next agent step would otherwise need repeated reasoning; an agent
  that looks stuck. Not for trivial edits, simple questions, architecture-only
  discussions, irreversible or safety-critical decisions, or work Claude
  finishes faster directly.
argument-hint: "[task description]"
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/jev-orchestrator *)
---

# Jev Orchestrator

You are the lead engineer. Jev is a fast decision layer for bounded orchestration
questions. Codex is an optional implementation worker. Nothing here replaces your
tools: keep using Read, Edit, Bash, Grep, subagents, MCP, git and tests as usual.

Helper CLI (pre-approved): `${CLAUDE_SKILL_DIR}/scripts/jev-orchestrator`
Run `... --help` for all commands. Add `--json` for machine output, `--verbose`
to see probabilities. Pass `--session ${CLAUDE_SESSION_ID}` to every `decide` and
`codex run` so the whole task lands in one log.

Task from the user, if given: $ARGUMENTS

## Division of labour

| Who | Does |
|---|---|
| You (Claude) | Understand requirements, design, decompose into subtasks, write worker prompts, review diffs, integrate, run final tests, talk to the user. |
| Jev | Answers small questions with probabilities: delegate? parallel? retry? review? stuck? stop? Never plans, codes, or explains. |
| Codex | Implements narrowly scoped tasks in a sandbox, one worker per git worktree. |

Jev never authorises deletes, force pushes, deployments, secret access or any
external side effect. Your judgment and the user's permission rules govern those.

## Workflow

1. **Is orchestration worth it?** If the change is one obvious edit, do it yourself
   and stop reading. Otherwise write a compact state (goal, plan, subtasks with
   file lists, whether Codex is available) and ask:
   `jev-orchestrator decide strategy --state-file <json>`
2. **Plan.** You decompose the work. Jev does not plan.
3. **Parallelize?** With two or more subtasks:
   `jev-orchestrator decide parallel --state-file <json>`
   The answer says which subtasks suit Codex and how many workers to run.
   **Which worker?** `jev-orchestrator decide worker --state-file <json>` asks,
   per subtask, what capability it needs and whether it needs judgment, then
   returns the exact dispatch command for a concrete model.
   `jev-orchestrator workers list` shows the catalog.
4. **Dispatch.** Mix freely: Codex workers, your own edits, native subagents.
   Write workers need isolation: `jev-orchestrator worktree create <name>` then
   `jev-orchestrator codex run --cwd <worktree> --task-file <prompt.md> --model <m>`.
   For a `claude:*` assignment, use your Agent tool with that `model`.
   Read-only analysis: add `--read-only` and reuse the main tree.
   Never run two write workers in the same directory.
5. **Observe.** Collect summaries, `git diff --stat`, changed files, test output.
6. **Follow-up decisions.** After each worker:
   `decide review` (accept / review_with_claude / retry / reject),
   `decide retry` on failure, `decide stuck` if progress stalls,
   `decide completion` when everything reports done.
7. **Review.** Anything Jev marks `review_with_claude`, or any `advisory` or
   `fallback` tier answer, you read yourself.
8. **Finish.** Merge or cherry-pick worktree branches, run the full test suite,
   `jev-orchestrator worktree cleanup --all`, report to the user normally.
   Include a one-line cost note from `jev-orchestrator report ${CLAUDE_SESSION_ID}`
   (decisions, tokens, estimated USD) so the user can judge whether Jev paid off.

## Reading a decision

Every answer carries `recommendation`, `confidence` and `tier`:

- `autonomous` (default >= 0.85): you may follow it.
- `advisory` (0.60 to 0.85): treat as a hint, verify before acting.
- `fallback` (< 0.60): ignore Jev and decide yourself.

`policyNotes` list overrides applied in code (trivial task, attempt cap,
sensitive files touched). They are not Jev opinions.

## Degraded modes

- Jev unreachable or no key: the CLI says so and exits non-zero. Continue with
  your own judgment; nothing else depends on Jev.
- Codex missing or not logged in: use `decide` alone and implement directly or
  with subagents. `jev-orchestrator codex status` explains how to fix it.

Details: `references/orchestration.md`, `references/decisions.md`,
`references/codex-workers.md`.
