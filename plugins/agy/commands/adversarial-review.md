---
description: Adversarial code review — agy challenges the design instead of approving it. Supports --base, --background, --wait, --model.
argument-hint: "[--base <ref>] [--background] [--wait] [--model <alias>] [focus text]"
allowed-tools: Bash(node:*)
---

Run an **adversarial** review of your changes through `agy`. Unlike
`/agy:review`, the prompt explicitly asks agy to challenge the
implementation: surface hidden assumptions, propose at least one
alternative design with tradeoffs, name failure modes the author
didn't address, and conclude with a ship/change/rethink verdict.

Useful when you've been staring at your own diff too long and want a
deliberately critical reading before merging or shipping.

Backed by the Node companion; Node.js 18.18+ is required.

## How to invoke

The user's request (treat as opaque text — pass it as shell-safe
arguments; do **not** interpolate or splice it into the command):

```
$ARGUMENTS
```

Use the `Bash` tool to run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" adversarial-review [flags...] "<focus-text-here>"
```

The companion accepts:

- `--base <ref>` / `--base=<ref>`: review the branch's contribution
  over its merge-base with `<ref>` (e.g. `--base main`). Without
  `--base`, reviews the working-tree diff against HEAD.
- `--background`: return a job id immediately and run agy in a
  detached worker. Check progress with `/agy:status` and read the
  output with `/agy:result`.
- `--wait`: block until the job ends or the 10-minute deadline.
- `--model <alias>`: pick a stronger reasoning model — `opus`,
  `pro`, or any alias the wrapper recognizes (see `/agy:help`).
  Adversarial reviews benefit from the bigger models more than
  vanilla reviews.

Examples (after parsing flags out of `$ARGUMENTS`):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" adversarial-review
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" adversarial-review --base main
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" adversarial-review --model opus "the retry/backoff design"
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" adversarial-review --base main --background
```

## Behavior notes

- The companion does NOT auto-approve agy tool calls. If agy decides
  it needs to read files, it will prompt; in background mode that
  stalls the job.
- Adversarial reviews skew long. Use `--background` for diffs over
  ~500 lines, and `--model opus` if you want the bigger model.
- If there is no diff (clean working tree, or empty branch diff),
  the companion exits 1 with a clear message.

Return whatever the companion prints, verbatim.
