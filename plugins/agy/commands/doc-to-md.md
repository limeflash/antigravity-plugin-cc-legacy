---
description: Convert a local document (PDF, DOCX, HTML, …) to Markdown, read-only
argument-hint: "[--model <alias>] <path>"
allowed-tools: Bash(bash:*)
---

Convert a local document to clean Markdown through the Antigravity CLI.
**Read-only and scoped:** the path is validated (allow-listed document
extensions only; a real regular file; size cap; **not** under a sensitive
directory like `~/.ssh`, `~/.aws`, or `~/.gemini`; symlinks resolved), then
staged into a throwaway temp dir so agy sees **only that one file** — it
cannot read the rest of your filesystem and cannot write to your repo.

The user's input below is a single file path (optionally preceded by `--model
<alias>`). Pass it as one shell-safe argument; do **not** interpolate it:

```
$ARGUMENTS
```

## How to invoke

Lift a leading `--model <alias>` (if present) out and place it before the path.
Use the `Bash` tool to run one of:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/agy-run.sh" doc-to-md "<path>"
bash "${CLAUDE_PLUGIN_ROOT}/scripts/agy-run.sh" doc-to-md --model <alias> "<path>"
```

Return the Markdown verbatim. Offer to save it to a file if the user wants.

Notes:

- Allowed types include: pdf, docx, doc, odt, rtf, html/htm, xml, md,
  txt, rst, csv, pptx, ppt, epub. Anything else (`.env`, `.pem`, `.key`, an
  extension-less secret, …) is refused (exit 65) **by design** — relay the
  reason, don't bypass it.
- Requires Node.js (path validation + output capture). If `agy` isn't set up,
  tell the user to run `/agy:setup`.
