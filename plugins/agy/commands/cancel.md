---
description: Cancel a running /agy:rescue job (SIGTERM, then SIGKILL after a grace).
argument-hint: "[task-id|prefix]"
allowed-tools: Bash(node:*)
---

Stop an active background job started by `/agy:rescue --background`.
Defaults to the latest cancelable job in this workspace.

## How to invoke

```
$ARGUMENTS
```

If empty:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" cancel
```

If the user passed an id or prefix:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" cancel "<id-or-prefix>"
```

## Behavior notes

- The companion sends `SIGTERM` first, waits up to 5 seconds, then
  escalates to `SIGKILL` if the process hasn't exited. On Windows,
  this is whatever the OS provides for those signals.
- A job whose record claims `running` but whose PID is already dead
  is marked `canceled` without sending any signal.
- A completed/failed/already-canceled job exits 2 with a message
  saying nothing was done — there's nothing to cancel.

Return the companion's stdout verbatim.
