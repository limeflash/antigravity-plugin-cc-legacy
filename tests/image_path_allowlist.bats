#!/usr/bin/env bats
# Tests for _image_source_in_allowlist. The helper must accept paths
# inside agy's artifacts directories and reject everything else —
# including the canonicalized form of symlinks pointing outside.

load helpers

setup() {
  load_agy_run
  # Sandbox HOME so we don't pollute the user's real ~/.gemini.
  # _image_source_in_allowlist reads $HOME inline, so this override
  # takes effect immediately without re-sourcing the script.
  TEST_HOME="$(mktemp -d 2>/dev/null || mktemp -d -t agy-bats)"
  HOME="$TEST_HOME"
  TEST_BRAIN="${HOME}/.gemini/antigravity-cli/brain"
  mkdir -p "$TEST_BRAIN"
  TEST_OK_FILE="${TEST_BRAIN}/ok.png"
  touch "$TEST_OK_FILE"
  TEST_BAD_FILE="${TMPDIR:-/tmp}/agy-bats-bad-$$.png"
  touch "$TEST_BAD_FILE"
}

teardown() {
  rm -rf "$TEST_HOME" 2>/dev/null || true
  rm -f "$TEST_BAD_FILE" 2>/dev/null || true
}

@test "accepts a path inside ~/.gemini/antigravity-cli/brain/" {
  load_agy_run
  _image_source_in_allowlist "$TEST_OK_FILE"
}

@test "rejects a path in /tmp" {
  load_agy_run
  run _image_source_in_allowlist "$TEST_BAD_FILE"
  [ "$status" -ne 0 ]
}

@test "rejects /etc/passwd" {
  load_agy_run
  run _image_source_in_allowlist "/etc/passwd"
  [ "$status" -ne 0 ]
}

@test "rejects empty input" {
  load_agy_run
  run _image_source_in_allowlist ""
  [ "$status" -ne 0 ]
}

@test "rejects a symlink whose target is outside the allowlist" {
  load_agy_run
  local symlink="${TEST_BRAIN}/agy-test-symlink.png"
  ln -sf "$TEST_BAD_FILE" "$symlink"
  run _image_source_in_allowlist "$symlink"
  # _canonicalize_path resolves the symlink, so the check should reject.
  # Fallback (no realpath / readlink -f / python3) would keep the literal
  # path and accept it — we tolerate that on environments without any
  # canonicalization tool, since CI has all three.
  if command -v realpath >/dev/null 2>&1 || \
     command -v readlink >/dev/null 2>&1 || \
     command -v python3 >/dev/null 2>&1; then
    [ "$status" -ne 0 ]
  fi
  rm -f "$symlink"
}
