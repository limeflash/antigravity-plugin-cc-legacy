---
description: Show the recent /agy:rescue jobs in this workspace, or a single job's details.
argument-hint: "[task-id|prefix]"
allowed-tools: Bash(node:*)
---

List recent agy jobs (no argument) or show the detail block for a
single job (when an id or prefix is provided).

## How to invoke

The user's request:

```
$ARGUMENTS
```

If `$ARGUMENTS` is empty, run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" status
```

If `$ARGUMENTS` contains a job id (full `agy-xxxxxxxx`) or a unique
prefix (`agy-3a7b`), pass it through as the first positional
argument:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" status "<id-or-prefix>"
```

## Behavior notes

- Jobs are stored per repository under `<repo>/.agy-plugin/jobs/`.
  Running `/agy:status` from outside the repo where you started a
  job will not show it — that's intentional.
- The companion treats `running` records whose PID is dead as
  `failed` in the rendered output (without rewriting the record).
  If you see a downgrade note in the detail block, the worker
  process is gone but the on-disk record didn't get the update.
- Ambiguous prefixes exit 2 and list candidates so the user can
  pick a longer prefix.

Return the companion's stdout verbatim.
