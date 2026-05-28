<!--
Thanks for the PR! Quick checklist below to keep the review tight.
Drop sections that aren't relevant; don't pad.
-->

## Summary

<!-- 1-3 sentences: what changes and why. -->

## Type of change

<!-- Pick one or more. -->
- [ ] Bug fix (`fix:`)
- [ ] New feature (`feat:`)
- [ ] Refactor / no behavior change (`refactor:`)
- [ ] Docs / examples (`docs:`)
- [ ] CI / tooling (`ci:` / `chore:`)
- [ ] Security guardrail or fix

## How was this tested?

<!--
- Unit tests added/updated under `tests/`?
- End-to-end run inside Claude Code? (Paste the slash-command output if
  it's not too long.)
- Any platform you couldn't test on?
-->

## Compatibility

- [ ] Works on macOS `/bin/bash` 3.2 (or N/A — Node-only code).
- [ ] No new runtime dependencies (or the README + CHANGELOG explain
      why one was added).
- [ ] `agy` CLI behavior assumed: <!-- pin a version if relying on
      specific flags -->

## Checklist

- [ ] CI is green (shellcheck + bats + Node tests).
- [ ] `CHANGELOG.md` entry under the unreleased section.
- [ ] No `--dangerously-skip-permissions` added (or explicit
      justification in the description).
- [ ] No new secret-scan false negatives introduced.

## Related issues

<!-- e.g. closes #42 -->
