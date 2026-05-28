# agy — Antigravity CLI plugin for Claude Code (limeflash fork)

> **Fork notice.** This is a fork of
> [`simplybychris/antigravity-plugin-cc`](https://github.com/simplybychris/antigravity-plugin-cc)
> maintained by [@limeflash](https://github.com/limeflash). The upstream
> is deliberately small ("just Bash and `agy`"); this fork extends it
> toward feature parity with
> [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc):
> background job control (`/agy:status`, `/agy:result`, `/agy:cancel`),
> branch-base code review (`--base <ref>`), adversarial review, optional
> stop-gate review hook, and a CI-tested wrapper. See [NOTICE](./NOTICE)
> and [CHANGELOG.md](./CHANGELOG.md) for what changed.

Use Google's [Antigravity CLI (`agy`)](https://antigravity.google/) from
inside Claude Code. Delegate tasks to the `agy:runner` subagent, run quick
prompts, or get a second-opinion code review — without leaving your editor.

This plugin is for Claude Code users who already use (or want to start using)
Antigravity and want a smooth way to call it from the workflow they already
have.

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
- **`/agy:review [focus]`** — ask Antigravity to review your current
  `git diff`. Aborts with a warning if the diff appears to contain
  secrets (override via `AGY_REVIEW_ALLOW_SECRETS=1`).
- **`/agy:help`** — show all commands, supported `--model` aliases, and
  canonical model names.
- **`agy:runner` subagent** — thin forwarding wrapper around the Antigravity
  CLI; available as `subagent_type: "agy:runner"` for programmatic
  delegation.

### Node.js companion (Phase 2 — Node 18.18+ required)

Stateful workflows with persistent job records under
`<repo>/.agy-plugin/`. Re-implementation of the codex-plugin-cc pattern
adapted for `agy`. Node.js is **only** needed if you use these
commands; the Bash wrapper above keeps working without it.

- **`/agy:rescue [--background] [--wait] [--resume|--fresh] [--model <alias>] <task>`**
  — like `/agy:delegate`, but with our own job control. Foreground by
  default; `--background` returns a job id you can check on later;
  `--background --wait` blocks here until the job ends.
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
- **Bash** and **git** in `PATH`. macOS, Linux, or WSL.

## Install

In Claude Code, run these three slash commands in order:

```text
/plugin marketplace add limeflash/antigravity-plugin-cc
/plugin install agy@limeflash-antigravity
/reload-plugins
```

> Prefer the upstream? Swap the first two lines for
> `/plugin marketplace add simplybychris/antigravity-plugin-cc` and
> `/plugin install agy@antigravity-cc`. The slash command surface
> (`/agy:*`) is identical; the fork adds capabilities, it doesn't rename
> existing ones.

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
Claude Code  →  /agy:*  →  agy:runner subagent  →  agy-run.sh  →  agy -p "..."
```

- The plugin does **not** ship its own Antigravity runtime — it uses your
  local `agy` binary, your local auth, and your local config.
- The wrapper script
  ([`plugins/agy/scripts/agy-run.sh`](./plugins/agy/scripts/agy-run.sh))
  handles binary discovery, auth detection, and exit codes.
- The `agy:runner` subagent is a *forwarder*: it invokes the wrapper exactly
  once per request and returns Antigravity's output verbatim. No
  reinterpretation.

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

## Roadmap (fork)

Tracking parity with `openai/codex-plugin-cc`. Phased plan:

- **Phase 1 — Foundation** ✅
  - [x] Fork attribution (`NOTICE`, updated `LICENSE`, marketplace renamed
        to `limeflash-antigravity`).
  - [x] Validate `IMAGE_PATH` stays inside the `agy` artifacts dir
        before `cp` — closes a low-severity exfil vector.
  - [x] Pre-flight secret scan on `git diff` before `/agy:review`.
  - [x] CI: shellcheck + bats unit tests on every PR.
  - [x] Community files: `SECURITY.md`, `CONTRIBUTING.md`, issue/PR
        templates, dependabot.
- **Phase 2 — codex-plugin-cc parity** (in progress)
  - [x] Node.js companion scaffold + state machine
        (`lib/state.mjs`, `lib/job-control.mjs`,
        `lib/tracked-jobs.mjs`, …).
  - [x] `/agy:rescue` with `--background`, `--wait`, `--resume`,
        `--fresh` and PID-file-based job control.
  - [x] `/agy:status`, `/agy:result`, `/agy:cancel`.
  - [x] CI: vitest matrix on Node 18.18 / 20 / 22.
  - [ ] `/agy:review --base <ref>` for branch review.
  - [ ] `/agy:adversarial-review` (steerable challenge-mode review).
  - [ ] Optional Stop-gate review hook.
- **Phase 3 — Antigravity-specific**
  - [ ] Safe `/agy:scrape`, `/agy:doc-to-md` (no auto-approve, deny-list
        on input paths/URLs).
  - [ ] Windows-native (PowerShell) port.

See [CHANGELOG.md](./CHANGELOG.md) for shipped changes.

## Inspiration

This fork extends
[`simplybychris/antigravity-plugin-cc`](https://github.com/simplybychris/antigravity-plugin-cc),
which is itself inspired by
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc).
The goal here is to keep simplybychris's security-conscious defaults (no
`--dangerously-skip-permissions`, no global `--add-dir <CWD>`) while
reaching the codex-plugin-cc feature surface.

## License

[MIT](./LICENSE). See [NOTICE](./NOTICE) for upstream attribution.
