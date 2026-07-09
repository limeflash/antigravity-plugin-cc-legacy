# agy (Claude Code plugin payload)

This directory is the actual Claude Code plugin. For install instructions and
full usage, see the [repo-level README](../../README.md).

## Layout

- `commands/` — slash commands: `/agy:setup`, `/agy:ask`, `/agy:delegate`,
  `/agy:research`, `/agy:review`, `/agy:adversarial-review`, `/agy:rescue`,
  `/agy:scrape`, `/agy:doc-to-md`, `/agy:image`, `/agy:status`, `/agy:result`,
  `/agy:cancel`, `/agy:help`.
- `agents/runner.md` — the `agy:runner` subagent (thin forwarder around the
  Antigravity CLI).
- `skills/antigravity-cli/` — internal runtime skill, used only inside the
  `agy:runner` subagent.
- `scripts/agy-run.sh` — Bash wrapper for the synchronous commands.
- `scripts/agy-run.ps1` — native Windows PowerShell entry (`ask` / `scrape` /
  `doc-to-md`) for hosts without bash.
- `scripts/agy-companion.mjs` + `scripts/lib/` — Node.js companion for the
  stateful commands (background jobs, branch/adversarial review) and the
  shared helpers (transcript capture, secret scan, input deny-lists).

## Design

Bash and PowerShell handle the synchronous commands with **no dependencies**;
the Node companion (optional, Node ≥ 18.18) adds background job control and
stateful review. The read-only commands run `agy` from a throwaway temp dir so
it can never touch your repo, and every input is guarded — a credential scan
before anything reaches Gemini, an SSRF URL deny-list, and a sensitive-path
deny-list. See the [repo README](../../README.md) and
[SECURITY.md](../../SECURITY.md) for the full posture.
