# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Fork lineage.** Versions `0.5.0-dev` onward are maintained by
> [@limeflash](https://github.com/limeflash) in
> [limeflash/antigravity-plugin-cc](https://github.com/limeflash/antigravity-plugin-cc),
> forked from
> [simplybychris/antigravity-plugin-cc](https://github.com/simplybychris/antigravity-plugin-cc)
> at upstream commit `50d32ea` (tag `0.4.1`). Earlier entries below are
> the upstream history, preserved for traceability.

## [0.6.2] - 2026-05-31 (limeflash fork)

**Security fix — the read-only commands could still write to your repo.**
Caught by dogfooding `/agy:ask` on a real project. `agy --print` **executes
write tools even without `--dangerously-skip-permissions`** (a non-TTY
prompt is auto-proceeded), so the bash `/agy:ask` and the simple
`/agy:review` — which ran agy with `cwd` = the user's repo — let agy edit
files in that repo. The "no auto-approve ⇒ read-only" assumption was wrong;
running agy *outside* the repo is what actually enforces it.

(Scope: the **Node** `/agy:review --base` / `/agy:adversarial-review` paths
were never affected — they already run agy in a staging temp dir with the
repo unreachable. The bug was the bash `_agy_capture` path.)

### Fixed
- `_agy_capture` (powers `/agy:ask` + simple `/agy:review`) and the
  `node`-absent `_agy_capture_writefile` fallback now run agy **from the
  throwaway temp dir** (`cwd`), not the repo. The repo is never agy's cwd,
  in `--add-dir`, its path, or env — so it has no path to write there.
  Verified: explicitly asking `/agy:ask` to edit a repo file now leaves the
  working tree untouched (`git status` clean) and capture still works.
- `/agy:image` likewise runs agy from its temp dir (the generated image is
  written there, then copied to `--output` by the wrapper).

### Added
- `tests/read_only_cwd.bats`: stubs `agy` and asserts it runs from a temp
  dir, not the caller's cwd, for both capture paths.

### Docs
- SECURITY.md corrected: read-only is enforced by running agy **outside**
  the repo, not by the absence of `--dangerously-skip-permissions` (agy
  still executes write tools in `--print` mode).

## [0.6.1] - 2026-05-31 (limeflash fork)

Hardening pass after full cross-platform validation (Windows + WSL2 +
**macOS 26.5**, all green on real agy 1.0.3) and an adversarial security
review run by Claude Code on the Mac. Structural defenses held (symlink
exfiltration, path traversal, job-id validation, image allowlist,
secret-abort-before-network); the secret scanner had three real coverage
gaps — now closed.

### Fixed — secret scanner
- **GAP-1 (Node↔Bash parity).** The Bash scanner lacked the `github_pat_`
  (fine-grained GitHub PAT) pattern the Node scanner had — so the default
  `/agy:review` (Bash path) could ship one to Gemini. Added; the two
  pattern sets now match (the "parity" comment is finally true).
- **GAP-2 (full-file blind spot).** The scanner inspected only the diff's
  ADDED lines, but review ships the FULL current content of changed files
  as context — a secret on an UNCHANGED line of a file you're editing would
  leak while the guard reported "clean." Both paths now also scan the full
  staged/inlined content (`scanTextForSecrets` / `_scan_text_for_secrets`).
  Verified: a secret on an unchanged line now aborts the review (exit 65)
  before any agy/network call.
- **GAP-3 (modern key formats).** `sk-[alnum]{20,}` missed dash-bearing
  keys — `sk-ant-api03-…` (Anthropic), `sk-proj-…` (OpenAI project). Added
  explicit patterns for both, kept the legacy one, and fixed the misleading
  "Anthropic-style" label.

### Changed — defense in depth
- `runViaWriteFile` gates `--dangerously-skip-permissions` on the
  write-capable kind (rescue) explicitly, rather than adding it
  unconditionally and relying on review/adversarial short-circuiting first.
- `.agy-plugin/` (the per-workspace job-state dir) is auto-added to the
  workspace's local `.git/info/exclude`, so it doesn't clutter the user's
  `git status` — local-only, never touches their tracked `.gitignore`.

### Validated
- macOS 26.5 on real agy 1.0.3: `/agy:ask`, `/agy:review`,
  `/agy:adversarial-review` all pass from symlinked `/var/folders/…` paths;
  the 0.6.0 `isMainModule` fix confirmed on hardware. 218 unit tests + CI.

## [0.6.0] - 2026-05-31 (limeflash fork)

**Read-only commands no longer use `--dangerously-skip-permissions`.**
Found that `agy` persists its own conversation transcript to disk on every
`--print` run — with no tool permission and no auto-approve — so the
read-only commands read the answer back from there instead of the
`write_file` + auto-approve workaround. Validated live on agy 1.0.3, then
dogfooded by running the new `/agy:review` on this very change.

### Changed
- **`/agy:ask`, `/agy:review`, `/agy:adversarial-review` are now genuinely
  read-only.** They run `agy` with `--sandbox` and **without**
  `--dangerously-skip-permissions`, then recover the answer from agy's
  transcript (`~/.gemini/antigravity-cli/brain/<id>/…/transcript.jsonl`,
  located via the run's own `--log-file`). agy's read-only tools
  (`list_dir` / `view_file`) execute without approval; it is never granted
  write access or the repo. Removes both crutches (write_file injection +
  auto-approve) for these commands.
- `/agy:rescue` (edits files) and `/agy:image` (saves an image) keep the
  scoped `write_file` + `--dangerously-skip-permissions` path — they
  legitimately write. rescue's guards (clean-tree, post-run diff,
  `--isolate`) are unchanged.

### Added
- `lib/transcript.mjs`: conversation-id parsing, transcript extraction
  (PLANNER_RESPONSE content only), store-dir resolution, a workspace-map
  fallback, and a `node transcript.mjs <logfile> [cwd]` CLI used by the
  Bash wrapper. 18 new unit tests (206 total).
- Bash `_agy_capture` rewritten to the transcript path (node-primary);
  falls back to the legacy `_agy_capture_writefile` when `node` is absent,
  so `/agy:ask` still works everywhere.

### Fixed (from dogfooding the new path with `/agy:review` on itself)
- Pass the Windows-safe `--log-file` path (not the POSIX one) to
  `transcript.mjs`, and the repo `cwd` (not the temp dir) as the
  `last_conversations.json` fallback hint.
- Surface `transcript.mjs` stderr on failure instead of swallowing it.
- `cancelJob` now removes a canceled review's stage dir (a killed worker's
  `finally{}` never runs, so it would otherwise leak).

### Cross-platform
- **macOS / symlinked-path fix (critical).** `isMainModule()` (in
  `agy-companion.mjs` and `lib/transcript.mjs`) compared `process.argv[1]`
  to `import.meta.url` with `path.resolve`. On macOS `/var` and `/tmp` are
  symlinks to `/private/…`, so the two paths differed and the check
  returned false — silently skipping the **entire** CLI dispatch (empty
  output, exit 0). It now realpath-compares both sides. Without it, every
  companion command and the bash transcript capture were a silent no-op
  when run from a symlinked path on macOS. Surfaced by the real-Mac smoke;
  reproduced + fixed under a symlink in WSL.
- The store dir is **self-located** from agy's own log line
  (`CLI app data directory: <path>`) instead of assuming
  `<homedir>/.gemini/antigravity-cli`, so the transcript path is correct on
  Windows / macOS / Linux / WSL by construction.
- Added `.gitattributes` forcing `eol=lf` for shell scripts (and all text).
  A Windows checkout with `core.autocrlf=true` produced CRLF scripts that
  break under real bash (`$'\r': command not found`) — which would bite the
  WSL path we recommend for an OS-hard sandbox.
- Validated `/agy:ask` (bash) and `/agy:review` (Node) end-to-end on **WSL2
  (Ubuntu 24.04) with real agy 1.0.3**: read-only, `--sandbox`, no
  auto-approve; the review caught both planted bugs.

### Docs
- SECURITY.md + README rewritten: read-only commands need no auto-approve;
  honest per-platform guarantee levels updated.

## [0.5.9] - 2026-05-30 (limeflash fork)

Fifth dogfood round: an adversarial self-review of the 0.5.8 Design A+
code. Fixed the three legitimate findings.

### Fixed
- **Background review temp-dir leak.** A `--background` review's stage
  dir was never removed (the parent exited; the detached worker skipped
  cleanup because the parent "owned" it). The worker now always removes
  its work dir after reading the response, so background reviews no
  longer accumulate temp directories. Verified: a foreground review
  leaves zero `agy-review-*` dirs behind.
- **Cancel status race.** A worker dying just after `/agy:cancel` marked
  the record `canceled` could overwrite it back to `failed`.
  `runJobWorker` now re-reads the record before its final update and
  leaves a `canceled` status intact.
- **Stage-dir path traversal.** `stageReviewMaterials` now rejects an
  absolute or `..`-escaping changed-file path (would crash with EINVAL
  on Windows for `C:\...`, or write outside the stage dir) — it
  verifies the destination stays under the stage `files/` root.

### Considered and not changed
- Review stages only the *changed* files, so agy can't trace imports
  into *unchanged* files — accepted tradeoff (the worktree-for-read
  alternative reintroduces the `.git` absolute-path leak we rejected for
  the read-only guarantee). The prompt tells agy to mark cross-context
  concerns `[UNVERIFIED]`.
- Orphaned `agy` child + no-commits-repo edge: low-impact, noted.

188 vitest pass.

## [0.5.8] - 2026-05-30 (limeflash fork)

Design A+ : the companion review path now stages the diff + full files
to disk for agy to read, instead of cramming them into the argv prompt.
Removes the command-line size ceiling entirely (a real run on a
`+13,768 −1,725` diff was crashing/truncating before) and restores
full-file context for arbitrarily large files.

### Changed
- **`/agy:review` / `/agy:adversarial-review` (companion) stage to
  disk.** A throwaway temp dir gets `diff.patch` + `files/<relpath>`
  (full current content of changed files, ≤2 MB each, symlinks/binaries/
  out-of-repo paths skipped). The argv prompt only *points* at them, so
  it stays tiny — **no more `ENAMETOOLONG`, no truncation, full context
  on any size**. agy reads the staged copies; the real repo is never in
  `--add-dir`, and agy runs with `cwd` = the stage dir (so it has no
  handle to the repo). New `stageReviewMaterials` in `lib/git.mjs`;
  prompt builders rewritten to reference the staged paths.
- Verified live against real `agy` 1.0.3: a 305-line file with a change
  ~300 lines away from its `gateway_id` definition — agy read the full
  staged file, confirmed the definition, and reported no false positive
  (the exact context-blind FP from earlier rounds).

### Notes
- The Bash `/agy:review` (no-flag working-tree path) still embeds +
  byte-caps the prompt; for large reviews use the companion path
  (`--base`, or any flag), which stages to disk.
- Read-only posture (see SECURITY/README): on macOS/Linux/WSL the
  `--sandbox` confines writes; on native Windows the guarantee is
  practical (repo never exposed by path/env/cwd) — for OS-hard on
  Windows, run under WSL.

## [0.5.7] - 2026-05-30 (limeflash fork)

Fourth dogfood round converged on polish only (no new HIGH issues) —
fixed the two cheap robustness nits and stopped.

### Fixed
- Bash worktree-containment prefix match is now case-insensitive
  (Windows/macOS filesystems are case-insensitive; `realpath` casing
  could otherwise wrongly skip a legitimate in-repo file).
- Build the dynamic backtick fence with a pure-Bash loop instead of
  `seq` (absent in some minimal shells).

### Dogfood summary
Four rounds of the plugin reviewing its own code surfaced 7 → 4 → 4 →
2 issues (real bugs → parity gaps → deep security edges → polish),
all fixed or documented as accepted/refuted. The loop has converged.

## [0.5.6] - 2026-05-30 (limeflash fork)

Third dogfood round (an adversarial self-review of 0.5.5). Fixed the
legitimate findings; the rest were accepted tradeoffs or refuted.

### Fixed
- **Directory-symlink traversal.** The 0.5.5 symlink check only looked
  at the leaf, so `linked_dir/file.txt` (where `linked_dir` →
  `/etc`) still escaped. `gatherFileContext` now `realpath`-resolves
  and requires the result to stay inside the repo root; the Bash
  wrapper does the same with `realpath` + a prefix check.
- **Byte-accurate prompt cap in Bash.** The cap used `${#prompt}` /
  `${prompt:0:N}` (character counts), so multibyte UTF-8 (CJK, emoji)
  could still exceed the byte limit and crash. Now uses `wc -c` /
  `head -c` (byte-accurate in any locale). Env var renamed
  `AGY_PROMPT_MAX_CHARS` → `AGY_PROMPT_MAX_BYTES`.
- **Fine-grained GitHub PAT detection.** Added the
  `github_pat_…` (82-char) pattern the classic `ghp_…` regex missed.
- **Dynamic code fences.** Embedded file content is now fenced with
  one more backtick than the longest backtick run in the file (was a
  fixed 4), so a file containing ```` ```` ```` (this plugin's own
  prompts.mjs does) can't close the block early. Both companion and
  Bash wrapper.

### Considered and not changed
- Inline-credential regex flags some benign code
  (`const secret = getSecretFromVault()`) — accepted: best-effort
  guardrail, `AGY_REVIEW_ALLOW_SECRETS=1` is the escape hatch.
- "Pass the prompt via a file instead of argv" — not possible: `agy`
  1.0.3 `--print` requires the prompt as an argv value (verified; it
  rejects stdin/empty-arg). The cap is the only mitigation.

189 vitest pass.

## [0.5.5] - 2026-05-30 (limeflash fork)

Dogfooding pass: ran the plugin's own `/agy:review` on the plugin's
code and fixed every legitimate finding (two review rounds: 7 issues,
then 4 parity gaps the fixes introduced). Also fixes the bug that made
this possible to even find — large review prompts crashed.

### Fixed
- **`ENAMETOOLONG` on large reviews.** `agy --print` takes the whole
  prompt as one argv entry; with `-U25` + embedded files a real review
  exceeded the OS command-line limit (~32 KB) and crashed. Both the
  companion (`capPromptForArgv`) and the Bash wrapper now hard-cap the
  prompt, always preserving the write_file instruction, and the
  embedded-files budget dropped to 12 KB. agy `--print` confirmed to
  NOT read the prompt from stdin/a file, so capping is the only option.
- **Secret-scan parity in the companion.** `/agy:review` /
  `/agy:adversarial-review` (Node path) now scan the diff for secrets
  before sending to Gemini, like the Bash `/agy:review` already did.
  Patterns are case-insensitive (parity with `grep -i`); proceeding via
  `AGY_REVIEW_ALLOW_SECRETS=1` prints a warning instead of staying
  silent. New `lib/secrets.mjs` (+10 tests).
- **`gatherFileContext` hardening.** `lstat` + skip symlinks (a
  symlinked diff entry could otherwise pull `/etc/passwd` into the
  prompt); `stat`-before-read size check (a huge generated file is
  rejected without slurping it into memory).
- **Bash full-file budget bug.** `used` was incremented before the
  budget check, so one oversized file starved every later small file.
- **4-backtick fences** around embedded file content (a file
  containing ``` no longer breaks the prompt) — both wrapper and
  prompts builder.
- **Fallback file-list sync** in `workingTreeDiff` and the Bash
  wrapper: when falling back to the unstaged diff, the name-only file
  list now matches it (was always `HEAD`).
- **Aligned defaults** between Bash and companion (250 lines / 12 KB)
  and made the companion honor `AGY_REVIEW_FULLFILE_*` env vars.

186 vitest pass.

## [0.5.4] - 2026-05-30 (limeflash fork)

Cuts review false positives by giving agy real context. Motivated by a
live run where agy flagged 3 HIGH issues that were all false positives
("X not imported", "missing guard") — because it only saw 3-line diff
hunks and couldn't see the import/guard just outside the window.

### Changed
- **Review diffs now use `-U25`** (was git's default `-U3`) so agy sees
  imports, early returns, and neighbouring code around each hunk.
  Override with `AGY_REVIEW_CONTEXT`. Applies to `/agy:review`,
  `/agy:review --base`, and `/agy:adversarial-review` (both the Bash
  wrapper and the Node companion).
- **Full content of small changed files is now attached** to the
  review prompt (≤400 lines/file, ≤64 KB total; binaries and large
  files skipped with a note), so agy can verify whole-file structure
  instead of guessing from hunks. New `gatherFileContext` helper in
  `lib/git.mjs`; rendered by `lib/prompts.mjs`.

### Verified live
Reproduced the exact false-positive pattern (a change ~60 lines away
from its import + null-guard): with `-U25` + full file, agy correctly
reported "logger is imported on line 1", "null guard present on line
32", and **no issues** — where `-U3` would have flagged both as bugs.
171 vitest pass.

## [0.5.3] - 2026-05-30 (limeflash fork)

Adds safety rails to `/agy:rescue`, which runs agy with
`--dangerously-skip-permissions` and repo write access by design (it's
a delegated coding task). All three verified live against real agy
1.0.3 — a `rescue --isolate` that adds a function leaves the real tree
untouched and emits a reviewable patch.

### Added
- **`--isolate` (worktree isolation).** agy edits a throwaway
  `git worktree` copy at HEAD; your real working tree is never
  touched. The companion captures the result as a patch under
  `.agy-plugin/patches/<job>.patch` and prints `git apply` / discard
  instructions. Foreground-only; requires a git repo.
- **Clean-tree guard.** A non-isolated `rescue` now refuses to run on
  a dirty working tree (so you always have a clean revert point).
  Override with `--allow-dirty`, or use `--isolate`. Non-git
  directories warn instead (no safety net) and proceed.
- **Post-run diff.** After a non-isolated `rescue`, the companion
  prints `git diff --stat` + any new untracked files, so you review
  what agy changed before committing.
- New `lib/git.mjs` helpers: `isGitRepo`, `isWorkingTreeClean`,
  `changeSummary`, `addWorktree`, `removeWorktree`,
  `captureWorktreePatch` (+ 6 unit tests). Job records gain
  `meta.executionRoot` so agy can run in the worktree while job state
  stays in the real repo. 164 vitest pass.

## [0.5.2] - 2026-05-30 (limeflash fork)

Completes the live-agy validation pass: every `/agy:*` command now
verified working against a real `agy` 1.0.3 install, with two more
fixes the validation surfaced.

### Fixed
- **`/agy:image` was doubly broken** against real agy: it hung on the
  non-TTY stdin and relied on an `IMAGE_PATH:` stdout marker that #76
  swallowed. Rewritten to the write_file marker pattern — agy
  generates the image, then write_file's the saved image's absolute
  path to a temp marker the wrapper reads back (then validates against
  the artifacts-dir allowlist and copies to `--output`). Verified: a
  real 1024×1024 image is produced and copied.
- **Companion job success no longer keys on agy's exit code.** agy
  `--print` was observed exiting non-zero even after writing a
  complete answer (e.g. `/agy:review` reported the bug correctly but
  the job showed `failed`). `defaultAgyRunner` now treats a non-empty
  response file as success, so `/agy:status` / `/agy:result` report
  `completed` accurately.

### Validated live (agy 1.0.3, Google AI Pro)
`/agy:ask`, `/agy:ask --model`, `/agy:review`, `/agy:review --base`,
`/agy:adversarial-review`, `/agy:image`, `/agy:rescue` (fg),
`/agy:rescue --background` → `/agy:status` → `/agy:result`,
`/agy:cancel`, `/agy:setup` — all confirmed working end-to-end.

## [0.5.1] - 2026-05-30 (limeflash fork)

Hotfix: make the plugin actually return agy's output when driven by
Claude Code. Validated end-to-end against a real `agy` 1.0.3 install
(Google AI Pro, Gemini 3.5 Flash) — the 0.5.0 commands returned empty
because of two agy `--print` behaviors in non-TTY contexts.

### Fixed
- **agy issue #76 (empty stdout in non-TTY).** `agy --print` generates
  the response internally (`Drip stopped: length=N` in the log) but
  flushes zero bytes to a piped stdout — so the plugin, which always
  runs agy from a subprocess, captured nothing. Both the Bash wrapper
  (`/agy:ask`, `/agy:review`) and the Node companion (`/agy:rescue`,
  `/agy:review`, `/agy:adversarial-review`) now use the write_file
  pattern: agy is told to write its full answer to a throwaway temp
  file (auto-approved via `--dangerously-skip-permissions`, scoped by
  `--sandbox` + `--add-dir <tmp>`), which the plugin then reads back.
- **agy `--print` non-TTY stdin hang.** Without a closed stdin, agy
  blocks forever and ignores `--print-timeout`. The wrapper now runs
  agy with `</dev/null`; the companion uses `stdio: ignore` for stdin.
- **`--model` no longer hard-fails.** agy 1.0.x keeps no top-level
  `"model"` key in `settings.json` until you pick one in the TUI, so
  the patch-and-restore path had nothing to patch and aborted the
  whole command. It now warns once and uses the default model.
- **Removed the `#!/usr/bin/env node` shebang** from
  `agy-companion.mjs` (vite-node failed to parse it on import; the file
  is always invoked as `node agy-companion.mjs`).

### Notes
- Getting output from agy 1.0.3 headless requires
  `--dangerously-skip-permissions` (to auto-approve the write_file
  tool). Blast radius is scoped: read-only commands run `--sandbox`
  with write access limited to a temp dir; only `/agy:rescue` (a
  delegated coding task by design) is granted repo write access.
- This is an upstream agy limitation; if Google fixes #76 so
  `--print` flushes to a pipe, the plugin can drop the write_file
  dance and the auto-approve requirement.

## [0.5.0] - 2026-05-28 (limeflash fork)

First release of the limeflash fork. Brings the plugin to ~80%
codex-plugin-cc parity: full job control (rescue, status, result,
cancel), branch-base code review (`--base <ref>`), adversarial
review, plus security guardrails on top of the upstream wrapper.
Stop-gate review hook is roadmapped for 0.6.0 (safety review of
hook semantics still pending).

### Added — Phase 2 (codex-plugin-cc parity)
- **`/agy:rescue`** — Node.js companion alternative to `/agy:delegate`
  with background/foreground execution, optional `--wait`, `--resume`,
  `--fresh`, and per-call `--model`. Background runs are detached
  Node workers; foreground runs invoke agy synchronously and print
  the captured output.
- **`/agy:review --base <ref>`** — branch-vs-base code review.
  Computes the merge-base of HEAD and the base ref and diffs from
  there, so unrelated changes that landed on the base after you
  branched are excluded. Also supports `--background`, `--wait`,
  `--model <alias>`. Without flags, the existing Bash wrapper runs
  the working-tree review (back-compat preserved).
- **`/agy:adversarial-review`** — challenge-mode review. The prompt
  asks agy to question the design, propose at least one materially
  different alternative with tradeoffs, name failure modes the
  author didn't address, and conclude with ship / change / rethink.
  Same flags as `/agy:review` (Node companion path only).
- **`/agy:status [id|prefix]`** — list recent jobs in this workspace,
  or show the detail block for a single job. Liveness-aware: a record
  that claims `running` but whose PID is dead is rendered as `failed`.
- **`/agy:result [id|prefix]`** — print the captured stdout/stderr of
  a job (defaults to the latest).
- **`/agy:cancel [id|prefix]`** — `SIGTERM` the worker, `SIGKILL`
  after a 5-second grace, mark the record `canceled`. Idempotent.
- **Node.js companion** at `plugins/agy/scripts/agy-companion.mjs`
  with `lib/{args,fs,process,state,job-control,tracked-jobs,
  workspace,render,agy,git,prompts}.mjs`. Re-implementation of the
  codex-plugin-cc pattern; no source code copied from upstream.
  Apache 2.0 ported lib files would land with header attribution if
  added later (see CONTRIBUTING.md).
- **Job state directory**: per-repo at `<repo>/.agy-plugin/`. Records
  are atomic-JSON; logs land in `logs/<id>.log`; PID files in
  `runtime/<id>.pid`. `.gitignore`d by default.
- **CI**: vitest matrix on Node 18.18 / 20 / 22, plus bats on
  Ubuntu and macOS bash 3.2, plus shellcheck, plus shfmt.
- **158 new vitest cases** covering args, fs, process, state,
  job-control, tracked-jobs, workspace, render, agy, git, prompts,
  and the end-to-end command surface.

### Not yet shipped (roadmapped for 0.6.0)
- **Stop-gate review hook** — a Claude Code `Stop` hook that runs a
  review on Claude's last turn and blocks the stop if HIGH-severity
  issues are found. Deferred because the hook has session-blocking
  semantics that need a careful safety review before shipping.

### Added — Phase 1 (foundation)
- Fork attribution: `LICENSE` lists both copyright holders; new
  `NOTICE` documents fork lineage and the codex-plugin-cc roadmap
  reference.
- `cmd_image` guardrail: validate the resolved `IMAGE_PATH` lives
  under `~/.gemini/antigravity-cli/{brain,scratch,cache}/` before
  copying via `--output`. Closes a low-severity prompt-injection
  exfil vector. Exit code 66 when outside the allowlist.
- `cmd_review` guardrail: pre-flight scan of the diff for common
  secret patterns (AWS keys, GitHub PATs, Slack tokens,
  OpenAI/Anthropic-style keys, PEM private-key blocks, inline
  credential assignments). Aborts with exit 65 if any match. Opt-in
  escape hatch via `AGY_REVIEW_ALLOW_SECRETS=1`.
- Three new internal Bash helpers: `_canonicalize_path`,
  `_image_source_in_allowlist`, `_scan_diff_for_secrets`. All
  bash-3.2-compatible so macOS `/bin/bash` keeps working.
- CI: shellcheck + bats matrix (Ubuntu + macOS bash 3.2).
- Community files: `SECURITY.md`, `CONTRIBUTING.md`, issue templates,
  PR template, dependabot config.
- README roadmap section tracking parity with codex-plugin-cc.

### Changed
- Marketplace renamed `antigravity-cc` → `limeflash-antigravity`.
  Install command: `/plugin install agy@limeflash-antigravity`.
- `plugin.json` gains `homepage`, `repository`, and `license` fields
  pointing at the fork.

## [0.4.1] - 2026-05-27

### Fixed
- `/agy:ask` and `/agy:image`: stop silent fallback / silent exit when
  a flag value is missing. `--model` (no value) used to die with exit 1
  and no message; `--model=` (empty) used to silently fall back to the
  default model. Both now print `error: --model requires a non-empty
  value`, the alias table, and a tip showing the current default. Same
  fix applied to `cmd_image` for `--name` and `--output`, plus `=` form
  support (`--name=foo`, `--output=path`).
- `/agy:help`: prints the wrapper's stdout verbatim in the reply as a
  code block instead of leaving it as a collapsed tool result.

## [0.4.0] - 2026-05-26

### Added
- `/agy:help` — single discoverable index of every `/agy:*` command,
  supported `--model` aliases, and the canonical model names. The wrapper
  is the single source of truth; the slash command just prints its
  `help` subcommand verbatim.
- `--model <alias>` on `/agy:ask`, `/agy:delegate`, and `/agy:research`.
  Per-call model selection: the wrapper takes a lock on
  `~/.gemini/antigravity-cli/settings.json`, atomically swaps in the
  requested model, invokes `agy`, then restores the original on exit
  (including SIGINT / SIGTERM / SIGHUP).
- Alias table: `flash-low`, `flash-medium` (`flash-med`), `flash`
  (`flash-high`), `pro-low`, `pro` (`pro-high`), `sonnet` (`claude-sonnet`),
  `opus` (`claude-opus`), `gpt-oss` (`gpt-oss-120b`). Canonical TUI strings
  (e.g. `"Claude Opus 4.6 (Thinking)"`) are accepted verbatim.
- `agy-run.sh` gains `cmd_help`, `resolve_model_alias`,
  `validate_settings_file`, `with_settings_lock`, `with_model_override`,
  and `restore_orphaned_backup` (cleans up after a `SIGKILL`ed previous
  run on the next invocation).

### Fixed
- Removed stale references to `agy -m <model>` from `runner.md`,
  `commands/delegate.md`, `commands/research.md`, and
  `skills/antigravity-cli/SKILL.md`. `agy` v1.0.2 has no `-m` / `--model`
  CLI flag — model selection is now correctly handled by the wrapper.
  Users who tried `--model` in 0.3.x and earlier got failures; 0.4.0
  makes the documented behavior work.
- Removed references to `~/.config/antigravity/config.toml` from the
  root README and `commands/delegate.md`. `agy` does not read that path;
  its actual settings live in `~/.gemini/antigravity-cli/settings.json`.
- Dropped the `--output-format json` mention from `SKILL.md` — that flag
  does not exist either.

### Internal
- `_patch_model_field` writes via `python3 -c "json.dump(...)"` when
  available, falling back to a narrow `sed` regex that targets only
  single-line `"model"` entries. Atomic `mv` from a tmpfile is used in
  both paths.
- `mkdir`-based portable lockfile (no `flock(1)` dependency — macOS has
  none by default). Dead-holder detection via `kill -0` prevents
  deadlocks after `SIGKILL`.
- Wrapper now has a sourcing guard so individual functions can be unit
  tested without triggering the dispatch.

## [0.3.1] - 2026-05-24

### Fixed
- `/agy:image` now extracts the saved image path deterministically. The
  wrapper instructs `agy` to end its reply with an `IMAGE_PATH:` marker line
  and parses it; a regex scrape of absolute `*.png/.jpg/.jpeg/.webp` paths
  in the reply is kept as a fallback. Previously the path was only printed
  when `agy` happened to mention it in its natural-language reply.

## [0.3.0] - 2026-05-24

### Added
- `/agy:research` — delegate a deep-research investigation. Wraps the
  topic in a structured prompt (background, key findings, caveats,
  sources) and routes through the `agy:runner` subagent. Defaults toward
  background execution for long jobs.
- `/agy:image` — generate an image with `agy`'s built-in `generate_image`
  tool (Imagen under the hood). Optional `--name <slug>` for the saved
  filename and `--output <path>` to copy the generated PNG next to your
  project.
- `agy-run.sh` gains an `image` subcommand that builds the right prompt
  for `agy`'s native image tool and optionally copies the result.

## [0.2.0] - 2026-05-24

### Changed
- **Breaking:** plugin renamed `antigravity` → `agy`, so slash commands move
  from `/antigravity:*` to `/agy:*`. Install command is now
  `/plugin install agy@antigravity-cc`.
- Subagent renamed from `agy` to `runner`; full identifier is `agy:runner`
  (avoids the awkward `agy:agy` form).

## [0.1.0] - 2026-05-24

### Added
- Initial plugin scaffold and Claude Code marketplace manifest.
- `/agy:setup` — verify `agy` install and authentication; offer to install
  if missing.
- `/agy:ask` — run a one-shot `agy -p` prompt and return its output
  verbatim.
- `/agy:delegate` — hand a task to the `agy:runner` subagent; supports
  `--background` and `--model`.
- `/agy:review` — pipe the current `git diff` into `agy` for review.
- `agy:runner` subagent — thin forwarding wrapper around the Antigravity
  CLI.
- `antigravity-cli` internal skill — runtime contract for invoking `agy`
  from the subagent.
- `agy-run.sh` — bash wrapper that handles binary discovery, auth
  detection, and exit codes.
