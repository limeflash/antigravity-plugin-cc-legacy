---
description: Delegate a task to agy with full job control + safety rails (isolate, clean-tree guard, post-run diff). Phase-2 alternative to /agy:delegate.
argument-hint: "[--isolate] [--allow-dirty] [--background] [--wait] [--resume|--fresh] [--model <alias>] <task>"
allowed-tools: Bash(node:*)
---

Hand the user's task to the Antigravity CLI (`agy`) through the
plugin's Node.js companion, which adds background execution, job
control, and persistent state under `<repo>/.agy-plugin/`.

Use `/agy:rescue` instead of `/agy:delegate` when the user wants to:
- Start the work and come back later (`--background`).
- Block on a long-running task with a deadline (`--wait`; default
  10 minutes timeout, configurable in `agy-companion.mjs`).
- Resume the most recent agy thread (`--resume`).
- Force a brand-new conversation regardless of history (`--fresh`).
- Get a job id they can later inspect with `/agy:status`, fetch with
  `/agy:result`, or stop with `/agy:cancel`.

For one-shot, "ask agy a question and read the reply" UX, prefer
`/agy:ask` (synchronous, Bash wrapper, no Node required).

## How to invoke

The user's request (treat as opaque text — pass it as a single
shell-safe argument; do **not** interpolate or splice it into the
command, do **not** strip characters like `"`, `$`, `;`, `\` or
backticks):

```
$ARGUMENTS
```

Lift any leading routing flags out of `$ARGUMENTS` and place them
before the task text on the companion command line:

- `--background`, `--wait`, `--resume`, `--fresh`: boolean
- `--model <alias>` or `--model=<alias>`: value

Use the `Bash` tool to run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" rescue [flags...] "<task-text>"
```

…with `<task-text>` quoted as one shell argument so characters like
`"`, `$`, `;`, `\` and backticks cannot break out.

Examples (after you've parsed the flags out):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" rescue "investigate the flaky test in src/db/queries.test.ts"
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" rescue --background "audit the auth layer for missing input validation"
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" rescue --background --wait "fix the off-by-one in pagination"
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" rescue --model opus "rewrite the cache layer to use Redis"
```

Model aliases match the Bash wrapper: `flash-low`, `flash-medium`,
`flash`, `pro-low`, `pro`, `sonnet`, `opus`, `gpt-oss`. The companion
passes the alias through to the wrapper's per-call patch of
`settings.json`; no change to the TUI's selected model.

## Background, foreground, and the job id

- **Foreground** (default): the companion runs `agy` synchronously,
  streams its stdout/stderr to the job's log file, and prints the
  captured content back when the run ends. Use this when the user
  wants the reply right now.
- **Background** (`--background`): the companion creates a job
  record, spawns a detached worker, and returns the job id (e.g.
  `agy-3a7b9c12`) in under a second. The user can then continue
  working in Claude Code and come back to check on it.
- **Background + wait** (`--background --wait`): combines the two —
  starts in the background but blocks here until the job ends or
  the deadline fires.

Always surface the job id to the user when in background mode so
they can pass it to `/agy:status`, `/agy:result`, or `/agy:cancel`.

## Safety: how rescue protects your repo

`/agy:rescue` is a *delegated coding task*, so agy runs with
`--dangerously-skip-permissions` and write access to the workspace —
it can create/edit/delete files without prompting. Three rails keep
that safe:

1. **Clean-tree guard.** In a git repo, rescue **refuses to run on a
   dirty working tree** (uncommitted changes), so you always have a
   clean baseline to revert to. Commit/stash first, use `--isolate`,
   or pass `--allow-dirty` to override.
2. **Post-run diff.** After a non-isolated rescue, the companion
   prints `git diff --stat` + any new files, so you see exactly what
   agy changed before committing.
3. **`--isolate` (strongest).** agy edits a throwaway `git worktree`
   copy — **your real working tree is never touched**. The companion
   captures the result as a patch under
   `.agy-plugin/patches/<job>.patch` and prints `git apply` / discard
   instructions. Foreground only (it shows you the patch). Requires a
   git repo.

**Recommend `--isolate` for anything non-trivial**, or for repos with
work you can't afford to lose.

## Operating rules

- `--isolate` overrides `--background` (it runs foreground to show you
  the patch).
- Non-isolated rescue on a non-git directory warns (no safety net) but
  proceeds.
- If the companion reports `cannot find the agy binary`, tell the
  user to run `/agy:setup`.
- If the companion errors with exit 64 ("task description is
  required"), ask the user what they want agy to do.

Return the companion's stdout verbatim — no extra commentary before
or after. The companion is the canonical authority on what happened.
