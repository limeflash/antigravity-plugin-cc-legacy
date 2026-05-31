# Security Policy

## Read-only capture, and the `--dangerously-skip-permissions` tradeoff

`agy` 1.0.3 returns nothing from `--print` in a non-TTY context (issue
#76). The plugin handles this two different ways, depending on whether the
command needs to write.

**Read-only commands (`/agy:ask`, `/agy:review`, `/agy:adversarial-review`)
— NO auto-approve.** `agy` persists its own conversation transcript to
disk on every `--print` run, with no tool permission and no auto-approve.
So the plugin runs `agy` strictly read-only and reads the answer back from
that transcript (`~/.gemini/antigravity-cli/brain/<id>/…/transcript.jsonl`,
located via the run's own `--log-file`). These commands run with
`--sandbox` and **without** `--dangerously-skip-permissions`: `agy`'s
read-only tools (`list_dir` / `view_file`) execute without approval, but it
is never granted write access, and the repo is never handed to it. (When
`node` is unavailable, `/agy:ask` falls back to the scoped write_file path
below, confined to a throwaway temp dir.)

**Write-capable commands (`/agy:rescue`, `/agy:image`) — auto-approve, but
scoped.** `rescue` legitimately edits files and `image` saves a generated
image, so they use `--dangerously-skip-permissions`. Safety comes from
scope + guards, not from removing the flag:

| Command | `agy` write access | Auto-approve? | Real repo exposure |
|---|---|---|---|
| `/agy:ask` | none (read-only) | no | none |
| `/agy:review`, `/agy:adversarial-review` | reads staged copies in a temp **stage** dir (`cwd` = stage dir) | no | **none** — repo is never in `--add-dir`, path, env, or cwd |
| `/agy:image` | temp dir only | yes (write_file) | none |
| `/agy:rescue` | the repo (by design — it's a delegated coding task) | yes | mitigated by clean-tree guard, post-run diff, and `--isolate` worktree mode |

**Honest guarantee levels:**

- **macOS / Linux / WSL:** OS-enforced. `agy --sandbox` uses
  seatbelt/bubblewrap to confine writes to the workspace, and the
  read-only commands also never receive write tools at all.
- **Native Windows (git-bash):** the read-only commands are read-only *by
  construction* — no write tools, no auto-approve, and the repo is never
  handed to `agy`. `--sandbox`'s OS enforcement is *very strong practical*,
  **not** OS-hard: there is no lightweight, no-admin, dependency-free OS
  sandbox on Windows (`icacls`/`attrib` are reversible by the same user and
  were deliberately **not** used — they'd be security theater and risk
  leaving your repo locked on a crash). This mostly matters for the
  write-capable commands (`rescue`/`image`): a deliberately hostile prompt
  injection that runs a shell command with a hardcoded absolute path is not
  OS-blocked there. **For an OS-hard guarantee on Windows, run under WSL.**

This analysis was itself pressure-tested by asking `agy` (see the project
history); `icacls`/`attrib`/Job-Objects were rejected as non-enforcing,
AppContainer/Low-Integrity as impractical for a CLI, and WSL identified as
the only robust no-admin path on Windows. The read-only transcript-capture
path that removed auto-approve from `ask`/`review` was validated live on
agy 1.0.3.

## Reporting a vulnerability

If you find a security issue in this plugin (the plugin source — **not** in
`agy` itself, Claude Code, or Google's services), report it privately:

- Open a [private security advisory](https://github.com/limeflash/antigravity-plugin-cc/security/advisories/new)
  on GitHub, **or**
- Email the maintainer via GitHub: <https://github.com/limeflash>.

Please do **not** open a public issue for security reports. I'll acknowledge
within 7 days and aim to ship a fix or mitigation within 30 days, depending
on severity.

## Scope

**In scope:**

- Shell-injection vectors through slash-command arguments
  (`/agy:ask`, `/agy:rescue`, `/agy:review`, `/agy:image`, etc.) that
  bypass the wrapper's quoting and reach the underlying shell.
- Prompt-injection vectors specific to how the wrapper constructs `agy`
  invocations or parses `agy`'s replies (e.g., the `IMAGE_PATH` parser,
  the `_scan_diff_for_secrets` guardrail).
- Path-traversal / arbitrary-overwrite issues in any file the plugin
  writes to (`docs/agy/**`, `~/.gemini/antigravity-cli/settings.json`
  patch, image `--output` copy).
- Race conditions in the `settings.json` patch + restore flow.
- Job-state persistence (Phase 2 onward): symlink attacks, predictable
  IDs, missing fsync, etc.

**Out of scope:**

- Vulnerabilities in `agy` itself → report to Google.
- Vulnerabilities in Claude Code → report to Anthropic.
- Issues that require the attacker to already have shell access to the
  user's machine.
- The Google OAuth flow or the install script
  (`curl … | bash`) — those are operated by Google.
- Best-practice complaints that aren't a concrete exploit (e.g., "you
  should use jq instead of grep"). Open a regular issue instead.

## Supported versions

Only the latest commit on `main` is supported. Pin to a tagged release
if you need stability guarantees (see [CHANGELOG.md](./CHANGELOG.md)).

## Coordinated disclosure

If you'd like to coordinate disclosure with a public write-up, mention
that in your initial report. I'll work with you on a timeline and CVE
request if applicable.

## Hall of fame

Researchers who report valid issues will be credited in
[CHANGELOG.md](./CHANGELOG.md) under the fix entry (unless they prefer
to stay anonymous).
