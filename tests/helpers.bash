#!/usr/bin/env bash
# Shared helpers for the bats suite.
# Sources agy-run.sh in "library mode" — the script has a sourcing
# guard (`if [ "${BASH_SOURCE[0]:-}" = "${0:-}" ]; then main "$@"; fi`)
# so functions become callable without triggering main().

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGY_RUN="${REPO_ROOT}/plugins/agy/scripts/agy-run.sh"

# Source the wrapper into the current shell. Bats runs each @test in a
# subshell, so this is per-test scoped.
#
# The wrapper sets `set -euo pipefail` at the top. We turn errexit off
# after sourcing because bats tests intentionally trigger non-zero exit
# codes via `run` and assertions — we don't want a stray failing
# assertion to abort the whole @test body.
load_agy_run() {
  # shellcheck disable=SC1090
  source "$AGY_RUN"
  set +e
}

# Run a function from agy-run.sh and capture stdout + exit code into
# the standard bats globals ($status, $output).
run_agy_fn() {
  load_agy_run
  run "$@"
}
