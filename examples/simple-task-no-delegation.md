# Example: a simple task stays with Claude

```
> Rename `getUser` to `fetchUser` in src/api/users.ts and update its two callers.
```

Claude should not invoke the skill at all here: one obvious edit, three files,
no separable components. The `when_to_use` text says so.

If Claude does ask anyway:

```json
{ "userGoal": "Rename getUser to fetchUser and update the two callers", "task": { "title": "rename", "files": ["src/api/users.ts", "src/pages"] } }
```

```
$ jev-orchestrator decide strategy --state-file /tmp/state.json
claude_direct  [autonomous] 1.00
Policy decision: Task judged trivial; Claude should do it directly.
```

The `trivial` signal came back at 0.91, so code policy forced `claude_direct`
regardless of what the strategy question preferred. Claude does the rename
with its normal Edit tool and moves on. Total cost: one Jev call, a few hundred
milliseconds.
