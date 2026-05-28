---
description: Ask Antigravity to review your git diff. Add --base <ref> for branch review or --background to run later.
argument-hint: "[--base <ref>] [--background] [--wait] [--model <alias>] [focus text]"
allowed-tools: Bash(bash:*), Bash(node:*)
---

Run a code review of your changes through `agy`. Two backends:

- **Synchronous Bash wrapper** (default when no flags are present):
  reviews the working-tree diff against `HEAD` and returns agy's
  reply verbatim. No Node.js required.
- **Node companion**: kicks in when **any** of `--base <ref>`,
  `--background`, `--wait`, or `--model <alias>` is present. Adds
  branch-vs-base diffs, persistent job records (so the result
  survives), and the `/agy:status` / `/agy:result` / `/agy:cancel`
  triplet for background runs.

## How to invoke

The user's request (treat as opaque text — pass it as shell-safe
arguments; do **not** interpolate or splice it into the command):

```
$ARGUMENTS
```

**Routing rule**: scan `$ARGUMENTS` for any of `--base`, `--background`,
`--wait`, or `--model`. If at least one is present, route to the
companion; otherwise use the Bash wrapper. Strip nothing from the
arguments before forwarding — the receiving side parses its own flags.

### Bash path (no routing flags)

Use the `Bash` tool to run:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/agy-run.sh" review "<focus-text-here>"
```

…substituting `<focus-text-here>` with the user's focus text quoted as
one shell argument. If the user provided no focus, omit the argument:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/agy-run.sh" review
```

The wrapper aborts with exit 65 if it detects probable secrets in the
diff; set `AGY_REVIEW_ALLOW_SECRETS=1` to override.

### Node companion path (any of --base / --background / --wait / --model)

Use the `Bash` tool to run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review [flags...] "<focus-text-here>"
```

Examples (after parsing flags out of `$ARGUMENTS`):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review --base main
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review --base main "focus on the new SQL"
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review --background
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review --base main --background --wait
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review --model opus "focus on concurrency"
```

The companion handles `--base <ref>` (branch diff against merge-base
of HEAD and `<ref>`), `--background` (return a job id and let it run
async), `--wait` (block here until the job ends, with a 10-min
default deadline), and `--model <alias>` (per-call model selection).

## Behavior notes

- **Branch diff** is computed against the merge-base of HEAD and the
  base ref so unrelated changes that landed on the base since you
  branched are excluded. If there's no diff between branches, the
  companion exits 1 with a clear message.
- **Background** runs are detached Node workers; the companion does
  NOT auto-approve agy's tool calls. If agy needs to read/edit
  files, it will prompt and the background job will stall until
  canceled.
- Both backends quote the user's focus text as one shell-safe
  argument before forwarding.

Return whatever the chosen backend prints, verbatim. No commentary
before or after.
