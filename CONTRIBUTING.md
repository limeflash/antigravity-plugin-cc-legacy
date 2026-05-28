# Contributing

Thanks for considering a contribution! This plugin's design goals (in
priority order):

1. **Safe by default** — no `--dangerously-skip-permissions`, no global
   `--add-dir <CWD>`, no auto-approve of `agy` tool calls.
2. **No runtime dependency creep** — Bash + git are required; Node.js
   18+ is required only for the job-control commands (Phase 2).
3. **Cross-platform** — macOS, Linux, WSL today; Windows-native
   PowerShell port is roadmapped.
4. **Useful to the typical Claude Code user calling `agy`.**

## Quick start for development

1. Fork and clone:
   ```bash
   git clone git@github.com:<your-handle>/antigravity-plugin-cc.git
   cd antigravity-plugin-cc
   git remote add upstream https://github.com/limeflash/antigravity-plugin-cc.git
   ```
2. Edit files under `plugins/agy/`.
3. Test locally:
   - Bash: `bats tests/` (install `bats-core` via `apt`/`brew`/`npm`).
   - Node (Phase 2+): `npm install && npm test`.
   - End-to-end: point your Claude Code marketplace at your clone, or
     symlink `plugins/agy/` into
     `~/.claude/plugins/marketplaces/local/plugins/`.
4. Run `/agy:setup` to confirm nothing broke.
5. Open a PR. CI must be green; new behavior should land with a test.

## What this fork wants help with

- **Phase 2 (in progress)**: ported job-control primitives from
  `codex-plugin-cc`'s pattern (state.mjs, job-control.mjs,
  tracked-jobs.mjs) — re-implemented, not copied verbatim. PRs with
  tests welcome.
- **`/agy:adversarial-review`** prompt template that genuinely
  challenges the implementation choice, not just nitpicks code.
- **Windows-native PowerShell wrapper** (`agy-run.ps1`) parity with
  `agy-run.sh`, including the lockfile + `settings.json` patch
  semantics.
- **Better secret patterns** for `_scan_diff_for_secrets` (more true
  positives, no new false positives — bring sample diffs in the PR).
- **`shfmt -d -i 2 -ci` clean format pass** on `agy-run.sh`. Currently
  informational in CI; making it blocking is the goal.

## What this fork will say no to

- A Node.js runtime for the slash commands that don't need state
  (`/agy:ask`, `/agy:image`, `/agy:review`, `/agy:setup`, `/agy:help`).
  Those stay in Bash.
- Removing the secret-scan guardrail by default. The opt-in via
  `AGY_REVIEW_ALLOW_SECRETS=1` exists precisely so default behavior
  stays safe.
- Adding `--dangerously-skip-permissions` to any command. If a use case
  needs it, propose it in an issue first — the answer will almost
  certainly be "use `agy` directly".
- Hard dependencies on Windows-only or Unix-only tooling.

## Filing issues

Use the issue templates. For bugs, include:
- output of `/agy:setup`
- the exact command you ran
- `agy --version` and `bash --version`
- OS and shell

For security issues, **do not file a public issue** —
see [SECURITY.md](./SECURITY.md).

## Commit style

- Conventional commits encouraged (`feat:`, `fix:`, `chore:`, `ci:`,
  `docs:`, `test:`).
- Squash-merge is the default. Long PRs are fine if the per-commit
  history is clean; you'll be asked to rebase if not.

## License

By contributing, you agree your contributions are licensed under the
[MIT License](LICENSE), matching the rest of the repository. If your
contribution ports code from `openai/codex-plugin-cc` (Apache 2.0),
include the upstream copyright header in the touched file and link the
specific commit you took it from.
