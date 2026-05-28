---
description: Print the captured output of a /agy:rescue job (latest by default).
argument-hint: "[task-id|prefix]"
allowed-tools: Bash(node:*)
---

Fetch the captured stdout/stderr of an agy job. Defaults to the
most recent job in this workspace.

## How to invoke

```
$ARGUMENTS
```

If empty:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" result
```

If the user passed an id or prefix:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" result "<id-or-prefix>"
```

## Behavior notes

- The companion prints the job's detail header first, then a
  `--- output ---` separator, then the contents of the log file at
  `<repo>/.agy-plugin/logs/<id>.log`.
- For a job that's still running, the log is whatever the worker
  has flushed so far. There's no guarantee it ends on a clean line.
- For a job that exited, the trailing line shows the final status
  and exit code so the user can see at a glance whether agy
  succeeded.

Return the companion's stdout verbatim.
