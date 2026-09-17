# Example: a worker keeps failing

A Codex worker was asked to make `pnpm --filter api test` pass after a schema
change. It has failed twice with the same error.

State Claude sends:

```json
{
  "userGoal": "Make the API test suite pass after the Prisma schema change",
  "workerResult": {
    "id": "fix-tests",
    "task": "Update repositories and fixtures for the new schema",
    "status": "failed",
    "summary": "Updated 3 repositories; 4 tests still fail with 'Unknown column tenant_id'",
    "attempts": 2
  },
  "recentFailures": [
    { "workerId": "fix-tests", "summary": "Unknown column tenant_id in users.spec.ts", "count": 2 }
  ],
  "attempts": 2,
  "maxAttempts": 2,
  "testResults": { "passed": 41, "failed": 4 }
}
```

```
$ jev-orchestrator decide retry --state-file /tmp/retry.json --verbose
JEV  retry
     spawn_debug_worker        0.71
     replan                    0.19
     review                    0.07
     continue                  0.02
     finish                    0.01
     failure_repetitive        yes 0.93
     likely_transient          no  0.04

spawn_debug_worker  [advisory] 0.71
Confidence is moderate; treat this as advice and review it before acting.
! Attempt cap reached (2/2); retrying the same worker was not offered.
```

The tier is `advisory`, so Claude reads the failing test output itself. It
sees the fixtures still seed the old column, which the worker never touched
because its scope said "repositories". Claude either:

- writes a new, narrowly scoped debug worker prompt ("only fix
  `apps/api/test/fixtures/*.ts` so every fixture sets `tenant_id`"), or
- fixes the fixtures directly, since it is now a one-file change.

Later, if the loop continues:

```
$ jev-orchestrator decide stuck --state-file /tmp/stuck.json
spawn_debug_worker  [autonomous] 1.00
Policy decision: A failure repeated 3+ times; continuing unchanged is not allowed.
```

Policy overrides carry confidence `1.0` and say so in `policyNotes`; they are
code rules, not Jev opinions.
