# Example: backend + frontend + tests in parallel

User request in Claude Code:

```
Implement Google OAuth: NestJS callback endpoint, React login button, Playwright e2e test.
```

## 1. Claude decides the task is separable and invokes the skill

Claude writes `/tmp/state.json`:

```json
{
  "userGoal": "Google OAuth login: backend callback, frontend button, e2e test",
  "currentPlan": ["backend callback + token exchange", "frontend button + session", "e2e login flow"],
  "repositorySummary": "pnpm monorepo: apps/api (NestJS), apps/web (React), e2e (Playwright)",
  "subtasks": [
    { "id": "backend", "title": "GET /auth/google/callback", "files": ["apps/api/src/auth"] },
    { "id": "frontend", "title": "Login button + session store", "files": ["apps/web/src/auth"] },
    { "id": "e2e", "title": "Playwright login flow", "files": ["e2e/auth"], "dependsOn": ["backend", "frontend"] }
  ],
  "codexAvailable": true,
  "worktreesAvailable": true
}
```

```
$ jev-orchestrator decide strategy --state-file /tmp/state.json --verbose
JEV  strategy
     parallel_codex            0.87
     mixed                     0.08
     single_codex              0.03
     claude_direct             0.01
     claude_subagents          0.01
     trivial                   no  0.02
     needs_claude_reasoning    no  0.14

parallel_codex  [autonomous] 0.87
```

## 2. Parallelization

```
$ jev-orchestrator decide parallel --state-file /tmp/state.json
parallel  [autonomous] 0.88  workers: 2
  codex  backend          codex 0.91 claude 0.12
  codex  frontend         codex 0.86 claude 0.18
  claude e2e              codex 0.48 claude 0.71
Run 2 Codex worker(s) in isolated worktrees; keep Claude-flagged subtasks with Claude.
! Some subtasks declare dependencies; run dependents after their prerequisites.
```

## 3. Dispatch

```
$ jev-orchestrator worktree create backend
✓ backend-3f9a1c
· path    /repo/.jev/worktrees/backend-3f9a1c
· branch  jev/backend-3f9a1c
$ jev-orchestrator worktree create frontend
✓ frontend-b07e22
```

Two Bash calls, run concurrently:

```
$ jev-orchestrator codex run --id backend  --cwd .jev/worktrees/backend-3f9a1c  --task-file /tmp/backend.md  --json
$ jev-orchestrator codex run --id frontend --cwd .jev/worktrees/frontend-b07e22 --task-file /tmp/frontend.md --json
```

`/tmp/backend.md`:

```
Implement only GET /auth/google/callback in apps/api/src/auth:
- exchange the code with GoogleOAuthService (exists) and upsert the user via UsersService.upsertFromGoogle
- return a signed session JWT using the existing JwtService
- unit tests in apps/api/src/auth/auth.controller.spec.ts

Do not touch apps/web or e2e. Run `pnpm --filter api test`.
Return a concise summary of files changed and remaining concerns.
```

## 4. Review decisions

Claude collects each worker's JSON result, `git -C <wt> diff --stat` and test output, then:

```
$ jev-orchestrator decide review --state-file /tmp/review-frontend.json
review_with_claude  [autonomous] 0.90
! Files outside declared scope changed (apps/web/src/config.ts); accept is not allowed blind.
```

Claude reads `apps/web/src/config.ts`, finds a hardcoded API URL, fixes it.

## 5. Integration

Claude writes the e2e test itself (Jev flagged it `claude`), merges both
branches, runs the full suite, and cleans up:

```
$ git merge --no-ff jev/backend-3f9a1c && git merge --no-ff jev/frontend-b07e22
$ pnpm test
$ jev-orchestrator worktree cleanup --all --delete-branches
```
