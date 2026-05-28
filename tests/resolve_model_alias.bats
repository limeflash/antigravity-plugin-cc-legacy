#!/usr/bin/env bats
# Tests for the model-alias resolver. Lifted aliases must map to their
# canonical TUI string; unknown / empty input must exit 64.

load helpers

@test "alias 'flash' maps to Gemini 3.5 Flash (High)" {
  run_agy_fn resolve_model_alias "flash"
  [ "$status" -eq 0 ]
  [ "$output" = "Gemini 3.5 Flash (High)" ]
}

@test "alias 'flash-low' maps to Gemini 3.5 Flash (Low)" {
  run_agy_fn resolve_model_alias "flash-low"
  [ "$status" -eq 0 ]
  [ "$output" = "Gemini 3.5 Flash (Low)" ]
}

@test "alias 'opus' maps to Claude Opus 4.6 (Thinking)" {
  run_agy_fn resolve_model_alias "opus"
  [ "$status" -eq 0 ]
  [ "$output" = "Claude Opus 4.6 (Thinking)" ]
}

@test "alias is case-insensitive" {
  run_agy_fn resolve_model_alias "OPUS"
  [ "$status" -eq 0 ]
  [ "$output" = "Claude Opus 4.6 (Thinking)" ]
}

@test "canonical TUI string passes through verbatim" {
  run_agy_fn resolve_model_alias "Claude Opus 4.6 (Thinking)"
  [ "$status" -eq 0 ]
  [ "$output" = "Claude Opus 4.6 (Thinking)" ]
}

@test "unknown alias exits 64" {
  run_agy_fn resolve_model_alias "definitely-not-a-real-model"
  [ "$status" -eq 64 ]
}

@test "empty alias exits 64" {
  run_agy_fn resolve_model_alias ""
  [ "$status" -eq 64 ]
}
