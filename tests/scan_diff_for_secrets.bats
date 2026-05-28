#!/usr/bin/env bats
# Tests for _scan_diff_for_secrets. The helper must detect common
# secret patterns in added lines (^+) and stay silent on benign diffs.

load helpers

@test "empty diff: silent, exit 0" {
  load_agy_run
  run _scan_diff_for_secrets ""
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "benign diff: silent, exit 0" {
  load_agy_run
  local diff
  diff="$(printf '%s\n' \
    '--- a/foo.txt' \
    '+++ b/foo.txt' \
    '+hello world' \
    '+function add(a, b) { return a + b; }' \
    '-let x = 1;')"
  run _scan_diff_for_secrets "$diff"
  [ "$status" -eq 0 ]
}

@test "AWS access key in added line: exit 1, label printed" {
  load_agy_run
  local diff
  diff="$(printf '%s\n' \
    '+const key = "AKIAIOSFODNN7EXAMPLE";')"
  run _scan_diff_for_secrets "$diff"
  [ "$status" -eq 1 ]
  [[ "$output" == *"AWS access key"* ]]
}

@test "PEM private key block in added line: exit 1" {
  load_agy_run
  local diff
  diff="$(printf '%s\n' \
    '+-----BEGIN RSA PRIVATE KEY-----' \
    '+MIIEpAIBAAKCAQEAabc...')"
  run _scan_diff_for_secrets "$diff"
  [ "$status" -eq 1 ]
  [[ "$output" == *"PEM private key"* ]]
}

@test "GitHub PAT in added line: exit 1" {
  load_agy_run
  local diff
  diff="$(printf '%s\n' \
    '+token = "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"')"
  run _scan_diff_for_secrets "$diff"
  [ "$status" -eq 1 ]
  [[ "$output" == *"GitHub personal access token"* ]]
}

@test "inline credential assignment with long base64-ish value: exit 1" {
  load_agy_run
  local diff
  diff="$(printf '%s\n' \
    '+API_KEY = "abcdef0123456789ABCDEF0123456789"')"
  run _scan_diff_for_secrets "$diff"
  [ "$status" -eq 1 ]
}

@test "removed line containing a secret does NOT trigger" {
  load_agy_run
  # Removing a secret from the diff is the correct user action; do not
  # warn on those lines.
  local diff
  diff="$(printf '%s\n' \
    '-AWS_KEY = "AKIAIOSFODNN7EXAMPLE"')"
  run _scan_diff_for_secrets "$diff"
  [ "$status" -eq 0 ]
}

@test "diff header lines (+++) do NOT trigger" {
  load_agy_run
  local diff
  diff="$(printf '%s\n' \
    '+++ b/secrets/AKIAIOSFODNN7EXAMPLE.txt' \
    '+hello')"
  run _scan_diff_for_secrets "$diff"
  # The path in the +++ header looks like an AWS key, but the scanner
  # filters those lines out. Expect a clean run.
  [ "$status" -eq 0 ]
}

@test "code reference like 'password = formData.password' does NOT trigger" {
  load_agy_run
  # The pattern requires the value side to be base64-safe chars only;
  # the dot in `formData.password` should break the match.
  local diff
  diff="$(printf '%s\n' \
    '+const password = formData.password;')"
  run _scan_diff_for_secrets "$diff"
  [ "$status" -eq 0 ]
}
