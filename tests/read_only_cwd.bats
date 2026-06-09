#!/usr/bin/env bats
# Regression guard for the read-only commands (/agy:ask, simple /agy:review).
#
# `agy --print` EXECUTES write tools even without --dangerously-skip-permissions
# (a non-TTY prompt is auto-proceeded), so "no auto-approve" alone does NOT
# make a command read-only. Read-only is enforced by running agy FROM a
# throwaway temp dir (not the user's repo) with the repo absent from
# --add-dir — so agy has no path to write into the repo. This test stubs
# `agy` to record its working directory and asserts it is NOT the caller's.

load helpers

@test "_agy_capture runs agy from a temp dir, not the caller's cwd (read-only guard)" {
  load_agy_run
  command -v node >/dev/null 2>&1 || skip "node required for the transcript capture path"

  local stub="$BATS_TEST_TMPDIR/agy-stub"
  cat > "$stub" <<'STUB'
#!/usr/bin/env bash
pwd -P > "$AGY_TEST_CWD_OUT"
exit 0
STUB
  chmod +x "$stub"

  export AGY_TEST_CWD_OUT="$BATS_TEST_TMPDIR/agy_cwd.txt"
  cd "$BATS_TEST_TMPDIR"
  local caller
  caller="$(pwd -P)"

  # transcript.mjs will find no conversation (stub wrote no log) and return
  # non-zero — that's fine; we only care where agy ran.
  _agy_capture "$stub" "" "5s" "hello there" >/dev/null 2>&1 || true

  [ -f "$AGY_TEST_CWD_OUT" ]
  local agy_cwd
  agy_cwd="$(cat "$AGY_TEST_CWD_OUT")"
  # agy must NOT have inherited the caller's cwd — it runs in a throwaway temp.
  [ "$agy_cwd" != "$caller" ]
}

@test "_agy_capture_writefile (node-absent fallback) also runs agy from a temp dir" {
  load_agy_run

  local stub="$BATS_TEST_TMPDIR/agy-stub2"
  cat > "$stub" <<'STUB'
#!/usr/bin/env bash
pwd -P > "$AGY_TEST_CWD_OUT2"
exit 0
STUB
  chmod +x "$stub"

  export AGY_TEST_CWD_OUT2="$BATS_TEST_TMPDIR/agy_cwd2.txt"
  cd "$BATS_TEST_TMPDIR"
  local caller
  caller="$(pwd -P)"

  _agy_capture_writefile "$stub" "" "5s" "hello there" >/dev/null 2>&1 || true

  [ -f "$AGY_TEST_CWD_OUT2" ]
  local agy_cwd
  agy_cwd="$(cat "$AGY_TEST_CWD_OUT2")"
  [ "$agy_cwd" != "$caller" ]
}
