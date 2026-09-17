# Decision reference

Every `jev decide <kind>` call sends a small projection of your state to Jev
with two to a dozen independent questions and returns one JSON object.

## Common output

```json
{
  "kind": "strategy",
  "recommendation": "parallel_codex",
  "confidence": 0.89,
  "tier": "autonomous",
  "probabilities": { "parallel_codex": 0.89, "single_codex": 0.07, "claude_direct": 0.04, "claude_subagents": 0.0, "mixed": 0.0 },
  "signals": {
    "trivial": { "probability": 0.03, "yes": false, "tier": "autonomous" },
    "needs_claude_reasoning": { "probability": 0.12, "yes": false, "tier": "advisory" }
  },
  "policyNotes": [],
  "guidance": "Confidence is high; you may follow this recommendation.",
  "model": "jev-1.13.0",
  "latencyMs": 412
}
```

`tier` comes from `confidence` and the configured thresholds
(`decisions.autonomousThreshold`, `decisions.fallbackThreshold`). For yes/no
signals the certainty is `|p - 0.5| * 2`, so 0.5 is "unsure", not "medium".

## Kinds

### strategy

Question: which execution strategy fits, is the task trivial, does it still need
Claude-level reasoning.

| Option | Meaning |
|---|---|
| `claude_direct` | Do it yourself. |
| `single_codex` | One scoped Codex worker, you review. |
| `parallel_codex` | Several Codex workers in worktrees. |
| `claude_subagents` | Native subagents for reasoning-heavy parts. |
| `mixed` | You keep the hard part, Codex takes scoped chunks. |

Policy: a firm `trivial` yes (probability above the fallback band) or
`needs_claude_reasoning >= 0.75` forces `claude_direct`. `task.irreversible: true`
always forces `claude_direct`. `codexAvailable: false` removes Codex options.

State used: `userGoal`, `currentPlan`, `repositorySummary`, `task`, `subtasks`
(ids, titles, files), `codexAvailable`.

### parallel

Needs `subtasks` (two or more). Asks: independent? worthwhile? and, per
subtask, Codex-suitable? needs Claude?

Returns `runInParallel`, `recommendedWorkers` (capped by `--max-workers` and
config), and `subtasks[].suggestedWorker`.

Policy: declared overlapping `files` disable parallel writes; `worktreesAvailable:
false` disables multi-worker.

### worker

Needs `task` or `subtasks`. For each one, a Choice over the worker catalog
(Codex models discovered in `$CODEX_HOME/models_cache.json`, Claude subagent
aliases `haiku` / `sonnet` / `opus`, plus `workers.catalog` entries from config)
and a Score of difficulty (mechanical, routine, tricky, reasoning-heavy).

Returns `assignments[]` with `candidateId`, `candidate.adapter` (`codex` or
`claude_subagent`), `candidate.model`, `difficulty`, and a ready-to-use
`dispatch` line (`codex run --model ... --reasoning ...` or "Agent tool with
model").

Policy: `irreversible` subtasks are only offered Claude candidates; a task scored
tricky or harder never goes to a fast-tier model (upgraded, noted); Codex
candidates disappear when Codex is unavailable. `jev-orchestrator workers list`
shows exactly what Jev can choose from.

### retry

Needs `workerResult` and ideally `recentFailures`, `attempts`, `maxAttempts`.

| Option | Meaning |
|---|---|
| `continue` | Move on. |
| `review` | You read the output first. |
| `retry_same_worker` | Same scope, one more try. |
| `spawn_debug_worker` | New worker whose only job is the failure. |
| `replan` | The cut was wrong; revise the plan. |
| `finish` | Stop orchestrating. |

Policy: attempts at cap removes `retry_same_worker`; `failure_repetitive >=
0.75` turns a retry into `spawn_debug_worker` (or `replan` at cap).

### review

Needs `workerResult`, `changedFiles`, `testResults`; `task.files` enables the
scope audit.

| Option | Meaning |
|---|---|
| `accept` | Integrate with a skim. |
| `review_with_claude` | Read the diff. |
| `retry` | Re-run with a tighter prompt. |
| `reject` | Discard and replan. |

Policy: `task.irreversible: true` or sensitive paths (`.env`, `.github/`, lockfiles,
Dockerfiles, migrations, `.claude/`, `.jev/`, infra, secrets) force
`review_with_claude`; out-of-scope files, failing tests or build, or missing
`testResults`/`buildResults` block `accept`.

### completion

Needs `activeWorkers`, `completedWorkers`, `testResults`. Options: `continue`,
`review`, `finish`, `replan`. Running workers block `finish`; failing tests or
build turn `finish` into `review`.

### stuck

Needs `recentFailures` (with `count`), `attempts`, `elapsedMinutes`. Options:
`continue`, `spawn_debug_worker`, `replan`, `finish`. A failure with `count >=
3` blocks `continue`.

## What Jev is never asked

Architecture, plans, code, root causes, ambiguous requirements, irreversible
actions. If you find yourself wanting to ask Jev "how should I build this", stop:
that is your question to answer.
