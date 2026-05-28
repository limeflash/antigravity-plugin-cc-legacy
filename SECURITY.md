# Security Policy

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
