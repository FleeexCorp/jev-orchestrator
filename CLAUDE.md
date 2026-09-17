# jev-orchestrator

Claude Code skill + TypeScript CLI: TypeSafe Jev answers bounded orchestration
questions, OpenAI Codex acts as an optional worker, Claude stays lead.

## Commands

```bash
pnpm install
pnpm build          # tsup -> dist/ (ESM, Node 20+)
pnpm test           # vitest; builds first via globalSetup; no real credentials
pnpm check          # typecheck + biome + test
node dist/cli/index.js --help
```

## Layout

- `src/jev/`: `DecisionEngine` interface, TypeSafe SDK client, mock engine.
- `src/orchestration/`: one file per bounded decision; code policy overrides live next to the Jev question.
- `src/codex/`: detection, auth status, `codex exec --json` parser and worker adapter.
- `src/git/worktrees.ts`: only manifest-tracked worktrees may be removed.
- `src/skill/installer.ts` + `skill/`: what gets copied into `~/.claude/skills` or `.claude/skills`.
- `tests/fixtures/fake-codex.sh`: scripted Codex stand-in driven by `FAKE_CODEX_MODE`.

## Rules

- Jev is never asked to plan, code or explain. Small typed questions only.
- No `Bash(*)`, no permission bypass flags, no Codex `--dangerously-*`.
- Secrets: env var or `~/.config/jev-orchestrator/secrets.json` (0600). Never in `.jev/` or `.claude/`.
- `spawn()` with argument arrays; prompts over stdin.
- Verify against live docs before changing API shapes: https://docs.typesafe.ai/api.md, `codex exec --help`, https://code.claude.com/docs/en/skills.md
