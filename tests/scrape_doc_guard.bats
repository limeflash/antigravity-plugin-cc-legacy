#!/usr/bin/env bats
# /agy:scrape + /agy:doc-to-md input deny-lists. Validation runs BEFORE any
# agy invocation, so the refusal paths are testable without a live agy.

load helpers

@test "scrape refuses file:// (scheme guard), exit 65" {
  load_agy_run
  command -v node >/dev/null 2>&1 || skip "node required"
  run cmd_scrape "file:///etc/passwd"
  [ "$status" -eq 65 ]
  [[ "$output" == *"refusing to scrape"* ]]
}

@test "scrape refuses a cloud-metadata IP (SSRF), exit 65" {
  load_agy_run
  command -v node >/dev/null 2>&1 || skip "node required"
  run cmd_scrape "http://169.254.169.254/latest/meta-data/"
  [ "$status" -eq 65 ]
}

@test "scrape with no URL is a usage error, exit 64" {
  load_agy_run
  run cmd_scrape
  [ "$status" -eq 64 ]
}

@test "doc-to-md refuses a non-document extension (.env), exit 65" {
  load_agy_run
  command -v node >/dev/null 2>&1 || skip "node required"
  printf 'API_KEY=x\n' > "$BATS_TEST_TMPDIR/secrets.env"
  run cmd_doc_to_md "$BATS_TEST_TMPDIR/secrets.env"
  [ "$status" -eq 65 ]
  [[ "$output" == *"refusing to convert"* ]]
}

@test "doc-to-md refuses a missing file, exit 65" {
  load_agy_run
  command -v node >/dev/null 2>&1 || skip "node required"
  run cmd_doc_to_md "$BATS_TEST_TMPDIR/nope.pdf"
  [ "$status" -eq 65 ]
}

@test "doc-to-md with no path is a usage error, exit 64" {
  load_agy_run
  run cmd_doc_to_md
  [ "$status" -eq 64 ]
}
