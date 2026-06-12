---
description: Scrape a web page (read-only) and return its main content as Markdown
argument-hint: "[--model <alias>] <url>"
allowed-tools: Bash(bash:*)
---

Fetch a web page through the Antigravity CLI and return its main content as
clean Markdown. **Read-only:** agy runs from a throwaway temp dir, and the URL
is validated (http/https only; localhost / private / link-local / cloud-metadata
hosts are blocked to prevent SSRF) before any fetch happens.

The user's input below is a single URL (optionally preceded by `--model
<alias>`). Treat it as opaque — pass it as one shell-safe argument; do **not**
interpolate it into the command:

```
$ARGUMENTS
```

## How to invoke

Lift a leading `--model <alias>` (if present) out of the input and place it
before the URL. Use the `Bash` tool to run one of:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/agy-run.sh" scrape "<url>"
bash "${CLAUDE_PLUGIN_ROOT}/scripts/agy-run.sh" scrape --model <alias> "<url>"
```

…substituting `<url>` with the exact text above, quoted as one shell argument.
Return the resulting Markdown verbatim — no commentary.

Notes:

- If the wrapper refuses the URL (exit 65), it matched the SSRF deny-list (a
  non-http(s) scheme, or a localhost / private / link-local / metadata host).
  Relay the reason; do **not** try to rewrite the URL to bypass it.
- Requires Node.js (URL validation + output capture). If the wrapper reports
  `agy is not installed` / `not authenticated`, tell the user to run
  `/agy:setup`.
- Best-effort guard: a public domain that *resolves* to an internal IP is not
  caught (static check, no DNS resolution). Don't scrape untrusted or
  attacker-controlled URLs.
