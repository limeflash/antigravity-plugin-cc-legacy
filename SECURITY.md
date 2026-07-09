# Security Policy

## Read-only capture, and the `--dangerously-skip-permissions` tradeoff

The plugin reads the answer from `agy`'s stdout. (Older `agy` < 1.0.15 had a
bug, #76, that swallowed non-TTY stdout; the plugin then recovered the answer
from `agy`'s on-disk transcript. agy 1.0.15 fixed it — the plugin is validated
on 1.1.0 — so stdout is the primary path and the transcript remains a
fallback.)

**Read-only commands (`/agy:ask`, `/agy:review`, `/agy:adversarial-review`)
— agy runs OUTSIDE your repo.** These run `agy` read-only from a throwaway
temp dir and capture its answer — no write_file workaround, no
`--dangerously-skip-permissions`.

**Important / the thing that actually enforces read-only:** `agy --print`
**still executes write tools** even without `--dangerously-skip-permissions`
(a non-TTY prompt is auto-proceeded). So "no auto-approve" alone does **not**
make a command read-only — that was a real bug (fixed in 0.6.2). What makes
these commands read-only is that **agy is launched from a throwaway temp dir
as its `cwd`, with only that temp dir in `--add-dir`, and your repo is never
its cwd, in `--add-dir`, its path, or its env** — so agy has no path to
write into the repo. (review/adversarial additionally read only pre-staged
copies of the diff + changed files in that temp dir.) `--sandbox` is layered
on top where the OS enforces it. When `node` is unavailable, `/agy:ask`
falls back to the write_file path below — also run from (and confined to) a
throwaway temp dir.

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

- **macOS / Linux / WSL:** OS-enforced on top. `agy --sandbox` uses
  seatbelt/bubblewrap to confine writes to the workspace (the throwaway
  temp dir), and the repo is never that workspace.
- **Native Windows (git-bash):** the read-only commands are read-only *by
  construction* — agy runs from a throwaway temp dir and the repo is never
  its cwd, in `--add-dir`, its path, or env, so it has no path to write
  there (this holds even though agy still executes write tools).
  `--sandbox`'s OS enforcement is *very strong practical*,
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
agy 1.1.0.

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
