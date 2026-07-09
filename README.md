# agy — the Antigravity CLI plugin for Claude Code

[![CI](https://github.com/limeflash/antigravity-plugin-cc/actions/workflows/ci.yml/badge.svg)](https://github.com/limeflash/antigravity-plugin-cc/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/limeflash/antigravity-plugin-cc?sort=semver&color=blue)](https://github.com/limeflash/antigravity-plugin-cc/releases)
[![Tests](https://img.shields.io/badge/tests-245%20passing-brightgreen)](#tested--dogfooded)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20·%20macOS%20·%20Linux%20·%20WSL-informational)](#requirements)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.18-339933)](#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**Call Google's [Antigravity CLI (`agy`)](https://antigravity.google/) from inside Claude Code** — ask
questions, review your diff, delegate coding tasks, scrape the web, convert
documents to Markdown — all without leaving your editor.

What sets it apart: the read-only commands come with a **real read-only
guarantee** — `agy` runs from a throwaway temp directory and *cannot touch
your repository* — and everything that leaves your machine is guarded
(credential scan before anything reaches Gemini, SSRF deny-list on URLs,
sensitive-path deny-list on files). Cross-platform, **245 unit tests**, CI
green.

> **Latest — v0.8.1.** Now on **agy 1.1.0** with **direct stdout capture** (the
> #76 workaround is now just a fallback). 13 slash commands · read-only
> guarantee · secret / SSRF / path guards · background job control · native
> Windows PowerShell entry.
> Validated end-to-end against a real `agy` 1.1.0 install on **Windows
> (git-bash)**, **WSL2 Ubuntu**, and **macOS 26.5**. Hardened by dogfooding the
> plugin's own `/agy:review` and `/agy:adversarial-review` on its own code —
> a self-run adversarial pass found and fixed real SSRF / path / TOCTOU bugs
> (see the [CHANGELOG](./CHANGELOG.md)).

## Why this plugin

- 🔒 **Read-only means read-only.** `/agy:ask`, `/agy:review`, `/agy:scrape`,
  `/agy:doc-to-md` run `agy` from a temp dir with **no**
  `--dangerously-skip-permissions` and your repo unreachable — even though
  `agy` executes tools, it has no path to write into your project.
  ([how it works](#how-output-is-captured-agy-issue-76) · [SECURITY.md](./SECURITY.md))
- 🛡️ **Guards what leaves your machine.** Diffs *and full changed-file
  content* are scanned for credentials before being sent to Gemini; scrape
  URLs are SSRF-filtered (localhost / private / link-local / cloud-metadata /
  IPv6-mapped / `nip.io`); document paths are extension-allow-listed and
  blocked under `~/.ssh` / `~/.aws` / `~/.gemini` / `/etc`.
- 🧰 **13 commands, one plugin.** ask · delegate · research · review ·
  adversarial-review · rescue · scrape · doc-to-md · image · status · result ·
  cancel · setup.
- ⚙️ **Background job control.** Long tasks run detached with real job records
  (`/agy:status`, `/agy:result`, `/agy:cancel`); `rescue --isolate` edits a
  throwaway `git worktree` and hands you a reviewable patch — your real tree is
  never touched.
- 💻 **Cross-platform.** A Bash wrapper (macOS / Linux / WSL / Windows
  git-bash) + a Node companion + a native **PowerShell** entry for Windows
  without bash.
- ✅ **Tested & dogfooded.** 245 unit tests, a shellcheck + bats + vitest CI
  matrix (Node 18 / 20 / 22), and the plugin reviews *itself* — that's how the
  hardest bugs were found.

This plugin is for Claude Code users who already use (or want to start using)
Antigravity and want a smooth, safe way to call it from the workflow they
already have.

## What you get

### Synchronous Bash wrapper (no Node.js required)

- **`/agy:setup`** — verify `agy` is installed and authenticated; can install
  it for you if it is missing.
- **`/agy:ask [--model <alias>] <prompt>`** — one-shot prompt through `agy -p`;
  returns the raw response.
- **`/agy:delegate [--background] [--model <alias>] <task>`** — hand a task
  to the `agy:runner` subagent. `--background` for long jobs (uses Claude
  Code's subagent mechanism).
- **`/agy:research [--background] [--model <alias>] <topic>`** — delegate a
  deep-research investigation; wraps the topic in a structured prompt and
  routes through `agy:runner`.
- **`/agy:image <description>`** — generate an image with `agy`'s built-in
  `generate_image` tool (Imagen under the hood). Optional `--name` and
  `--output`.
- **`/agy:scrape [--model <alias>] <url>`** — fetch a web page (read-only)
  and return its main content as Markdown. The URL is SSRF-guarded
  (http/https only; localhost / private / link-local / cloud-metadata hosts
  refused) before `agy` fetches it.
- **`/agy:doc-to-md [--model <alias>] <path>`** — convert a local document
  (PDF, DOCX, HTML, …) to Markdown, read-only. The path is validated
  (allow-listed document types only; not under `~/.ssh` / `~/.aws` /
  `~/.gemini` / `/etc`; symlinks resolved) and staged into a temp dir so
  `agy` sees only that one file.
- **`/agy:review [focus]`** — ask Antigravity to review your current
  `git diff`. Sends an expanded diff (`-U25`) plus the full content of
  small changed files so `agy` sees imports/guards and doesn't raise
  context-blind false positives. Aborts if the diff appears to contain
  secrets (override via `AGY_REVIEW_ALLOW_SECRETS=1`).
- **`/agy:help`** — show all commands, supported `--model` aliases, and
  canonical model names.
- **`agy:runner` subagent** — thin forwarding wrapper around the Antigravity
  CLI; available as `subagent_type: "agy:runner"` for programmatic
  delegation.

### Node.js companion (Phase 2 — Node 18.18+ required)

Stateful workflows with persistent job records under
`<repo>/.agy-plugin/` — background jobs, branch-base review, adversarial
review, and a job lifecycle you can inspect and cancel. Node.js is **only**
needed if you use these commands; the Bash wrapper above keeps working without
it.

- **`/agy:rescue [--isolate] [--allow-dirty] [--background] [--wait] [--resume|--fresh] [--model <alias>] <task>`**
  — like `/agy:delegate`, but with our own job control **and safety
  rails**. agy can edit files (it runs with auto-approval by design),
  so: a non-isolated rescue **refuses to run on a dirty git tree**
  (override with `--allow-dirty`) and **prints a `git diff --stat`
  afterward**; **`--isolate`** runs agy in a throwaway `git worktree`
  so your real tree is never touched and you get a reviewable patch
  under `.agy-plugin/patches/`. Foreground by default; `--background`
  returns a job id; `--background --wait` blocks until done.
- **`/agy:review --base <ref> [--background] [--wait] [--model <alias>] [focus]`**
  — branch-vs-base code review. Computes the merge-base of HEAD and
  the base ref so unrelated changes on the base branch are excluded.
  Without flags, falls back to the synchronous Bash wrapper (above).
- **`/agy:adversarial-review [--base <ref>] [--background] [--wait] [--model <alias>] [focus]`**
  — challenge-mode review. The prompt asks `agy` to question the
  design, propose alternatives, and end with a ship/change/rethink
  verdict. Pairs well with `--model opus`.
- **`/agy:status [task-id]`** — list recent jobs in this workspace, or
  show the detail block for one. Detects orphaned `running` records
  whose worker process has died.
- **`/agy:result [task-id]`** — print the captured output of a job
  (defaults to the latest). Useful right after `--background` returns
  or after `--wait` runs out.
- **`/agy:cancel [task-id]`** — `SIGTERM` the job's worker, escalate
  to `SIGKILL` after a 5-second grace, and mark the record canceled.

## Requirements

- **Claude Code** with plugin-marketplace support
  (`/plugin marketplace add …`).
- **Antigravity CLI (`agy`)** installed locally. `/agy:setup` can install it
  on first run.
- **Auth** for `agy`: either OAuth cached in the system keyring (after one
  interactive run of `agy`) or `ANTIGRAVITY_API_KEY` exported in your shell.
- **Bash** + **git** in `PATH` (macOS / Linux / WSL / Windows git-bash) for
  the full command set. On **native Windows without bash**, the read-only
  commands (`/agy:ask`, `/agy:scrape`, `/agy:doc-to-md`) also run via the
  PowerShell entry — `powershell -ExecutionPolicy Bypass -File
  "<plugin>/scripts/agy-run.ps1" <cmd> <args>` (needs **Node.js**).

## Install

In Claude Code, run these three slash commands in order:

```text
/plugin marketplace add limeflash/antigravity-plugin-cc
/plugin install agy@limeflash-antigravity
/reload-plugins
```

Then verify everything is wired up:

```text
/agy:setup
```

If `agy` is missing, `/agy:setup` offers to install it via the official
installer:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

If `agy` is installed but not logged in, run `agy` once interactively in your
terminal to complete OAuth — or export `ANTIGRAVITY_API_KEY`.

## Usage

### Ask a quick question

```text
/agy:ask explain the difference between Go channels and Rust async in one paragraph
```

Returns Antigravity's response verbatim.

### Delegate a task to the `agy:runner` subagent

```text
/agy:delegate refactor the SQL queries in src/db/queries.go to use prepared statements
```

For long tasks, run in the background and let Claude Code notify you when it
finishes:

```text
/agy:delegate --background investigate why integration tests are flaky in CI
```

You can also delegate by talking to Claude:

```text
Ask agy to look at this file and suggest a simpler design.
```

The plugin's selection rules route through the `agy:runner` subagent
automatically.

### Review the current diff

Stage or make some changes, then:

```text
/agy:review
/agy:review focus on error handling and concurrency safety
```

### Pick a specific model

```text
/agy:delegate --model sonnet fix the off-by-one in pagination
/agy:delegate --model pro write a high-coverage test for the cache layer
/agy:ask --model opus "explain Go's escape analysis"
```

Supported aliases: `flash-low`, `flash-medium`, `flash`, `pro-low`, `pro`,
`sonnet`, `opus`, `gpt-oss`. The canonical TUI strings (e.g.
`"Claude Opus 4.6 (Thinking)"`) are also accepted. Run `/agy:help` for the
full table.

If no `--model` is given, the wrapper uses whatever the TUI is currently set
to — stored in `~/.gemini/antigravity-cli/settings.json`. Project-local
`AGENTS.md` and `GEMINI.md` files are read directly by `agy` and unaffected
by this plugin.

### Delegate a deep research investigation

```text
/agy:research what's the current state of WebGPU support across browsers in 2026?
/agy:research --background --model opus survey post-quantum signature schemes used in TLS
```

The command wraps your topic in a research-oriented preamble (background,
key findings, caveats, sources) and delegates to `agy:runner`. Long
investigations work well in `--background`.

### Generate an image

```text
/agy:image a minimalist dark-mode login mockup, blue accent color
/agy:image --name hero --output ./assets/hero.png isometric illustration of a developer at a desk
```

Triggers `agy`'s built-in `generate_image` tool. The image is written to
the Antigravity artifacts dir (e.g.
`~/.gemini/antigravity-cli/brain/<uuid>/<name>.png`). Pass `--output` if
you want the wrapper to copy it next to your project.

## How it works

Under the hood, the plugin is a thin wrapper around your local `agy` install:

```
Claude Code  →  /agy:*  →  agy-run.sh (Bash)        →  agy --print "<prompt>"
                        ↘  agy-companion.mjs (Node)  →  agy --print "<prompt>"
```

- The plugin does **not** ship its own Antigravity runtime — it uses your
  local `agy` binary, your local auth, and your local config.
- The Bash wrapper
  ([`plugins/agy/scripts/agy-run.sh`](./plugins/agy/scripts/agy-run.sh))
  handles the synchronous commands; the Node companion
  ([`agy-companion.mjs`](./plugins/agy/scripts/agy-companion.mjs))
  handles the stateful ones (background jobs, branch review).

### How output is captured (agy issue #76)

The plugin reads the answer from `agy`'s **stdout**. On older `agy`
(< 1.0.15) a bug (#76) swallowed non-TTY stdout — `agy --print` generated the
response but flushed nothing to a pipe — so the plugin recovered the answer
from `agy`'s own on-disk transcript instead. **agy 1.0.15 fixed that** (the
plugin is validated on **1.1.0**), so stdout is now the fast path and the
transcript remains only as a fallback for older `agy`. (`agy --print` also
*hangs* on a non-TTY stdin that never EOFs, so the plugin always closes
stdin.)

What makes the read-only commands read-only is **not** the capture method — it
is that **`agy` is launched from a throwaway temp dir (not your repo)** with
only that dir in `--add-dir`, so even though `agy --print` still executes
write tools, it has no path to write into your repo. No
`--dangerously-skip-permissions`; `--sandbox` is layered on where the OS
enforces it.

- **`/agy:ask`, `/agy:review`, `/agy:adversarial-review`** run `agy` read-only
  from a temp dir and return its answer (stdout, with the transcript as
  fallback) — no auto-approval.
- **`/agy:rescue`** edits files by design, and **`/agy:image`** saves a
  generated image, so they use `--dangerously-skip-permissions`, scoped to a
  throwaway temp dir. `rescue`'s repo writes are guarded by the clean-tree
  check, the post-run diff, and `--isolate` worktree mode.

See [SECURITY.md](./SECURITY.md) for the full posture and the honest
per-platform guarantee levels.

## Configuration

`agy` stores its preferences (selected model, theme, telemetry, trusted
workspaces) in `~/.gemini/antigravity-cli/settings.json`. Project-local
`AGENTS.md` / `GEMINI.md` files are read directly by `agy`. This plugin
doesn't override or shadow any of that — drop config files where `agy`
expects them and they'll be picked up.

The `--model <alias>` flag on `/agy:ask`, `/agy:delegate`, and `/agy:research`
swaps in your requested model for the duration of a single call (under a
lockfile, with automatic restore on exit) and leaves the TUI's selected
model intact for subsequent runs.

## FAQ

### Do I need an Antigravity subscription?

You need whatever account `agy` accepts: Google AI Pro, Ultra, Code Assist
Standard/Enterprise, or an enterprise GCP project. See the
[Antigravity docs](https://antigravity.google/docs/cli-overview) for details.

### Does this plugin send data anywhere other than what `agy` sends?

No. The plugin runs `agy` locally over a Bash wrapper. The wrapper only reads
filesystem paths and your shell environment. Your prompts go directly to
Google through `agy`'s normal channels.

### Can I keep using Antigravity outside this plugin?

Yes — the plugin uses your local install. Running `agy` directly in a
terminal keeps working exactly as before.

### Why a subagent instead of just a slash command?

Subagents in Claude Code can run in the background and report back when
finished. That is the workflow you want when you "hand this off to another
model and keep working" — which is the whole point of delegating to `agy`.

## Roadmap

Built in phases; everything through Phase 3 has shipped and is validated
against real `agy` 1.1.0.

- **Phase 1 — Foundation** ✅
  - [x] Attribution + marketplace setup (`NOTICE`, `LICENSE`, marketplace
        `limeflash-antigravity`).
  - [x] Validate `IMAGE_PATH` stays inside the `agy` artifacts dir
        before `cp` — closes a low-severity exfil vector.
  - [x] Pre-flight secret scan on `git diff` before `/agy:review`.
  - [x] CI: shellcheck + bats unit tests on every PR.
  - [x] Community files: `SECURITY.md`, `CONTRIBUTING.md`, issue/PR
        templates, dependabot.
- **Phase 2 — Stateful workflows & safety rails** ✅ (0.5.x)
  - [x] Node.js companion scaffold + state machine
        (`lib/state.mjs`, `lib/job-control.mjs`,
        `lib/tracked-jobs.mjs`, …).
  - [x] `/agy:rescue` with `--background`, `--wait`, `--resume`,
        `--fresh` and job control.
  - [x] `/agy:status`, `/agy:result`, `/agy:cancel`.
  - [x] `/agy:review --base <ref>` for branch review (merge-base
        resolution + expanded `-U25` + full-file context).
  - [x] `/agy:adversarial-review` (challenge-mode review).
  - [x] `agy` #76 capture: read-only **transcript capture** (no
        auto-approve) for ask/review/adversarial + `write_file` fallback +
        non-TTY stdin-hang fix — validated against real `agy` 1.1.0.
  - [x] `/agy:rescue` safety rails: clean-tree guard, post-run diff,
        `--isolate` worktree mode.
  - [x] Secret-scan guardrails (Bash + companion parity).
  - [x] CI: shellcheck + bats + vitest matrix (Node 18.18 / 20 / 22).
  - [ ] Optional Stop-gate review hook (deferred — the hook can block
        Claude responses; wants a careful safety review first).
- **Phase 3 — Antigravity-specific** (shipped in 0.7.x)
  - [x] Safe `/agy:scrape`, `/agy:doc-to-md` (read-only, deny-list on input
        URLs/paths) — v0.7.0.
  - [x] Windows-native PowerShell entry for the read-only commands
        (`agy-run.ps1`: ask / scrape / doc-to-md) — v0.7.1.

See [CHANGELOG.md](./CHANGELOG.md) for shipped changes.

## Tested & dogfooded

- **245 unit tests** (`vitest`) plus Bash `bats` tests and `shellcheck`, run
  in CI on **Node 18 / 20 / 22** across Ubuntu and macOS on every push.
- **Validated end-to-end** against a real `agy` 1.1.0 install on **Windows
  (git-bash)**, **WSL2 Ubuntu**, and **macOS 26.5** — `ask`, `review`,
  `scrape`, `doc-to-md`, and the read-only guarantee all confirmed on hardware.
- **The plugin reviews itself.** Running `/agy:review` and
  `/agy:adversarial-review` on the plugin's own diffs is part of the workflow
  — that's how the read-only-cwd hole, the secret-scanner coverage gaps, a
  macOS symlink bug, and five SSRF / path / TOCTOU issues were caught and
  fixed.

## Credits

Originally seeded from [@simplybychris](https://github.com/simplybychris)'s
[`antigravity-plugin-cc`](https://github.com/simplybychris/antigravity-plugin-cc)
(MIT) — thank you for the starting point. Job-control and state-persistence
patterns are inspired by
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) (Apache-2.0).

This project has since been substantially rewritten and extended: the
read-only guarantee, the `agy` #76 transcript-capture, the Node job-control
companion, `/agy:scrape` + `/agy:doc-to-md` with the SSRF / path guards, the
native PowerShell entry, the cross-platform validation, and the 245-test
suite are all original to it. See [NOTICE](./NOTICE) for attribution details.

## License

[MIT](./LICENSE). See [NOTICE](./NOTICE) for upstream attribution.
