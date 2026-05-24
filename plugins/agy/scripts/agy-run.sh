#!/usr/bin/env bash
# agy-run.sh — wrapper for the Google Antigravity CLI (`agy`) used by the
# Claude Code plugin. Keeps the slash commands and the `agy` subagent thin.
#
# Subcommands:
#   check                    Report install + auth status as JSON.
#   ask "<prompt>" [-- ...]  Run `agy -p "<prompt>" [agy-flags...]` non-interactively.
#   review [focus text]      Pipe the current `git diff` into `agy` for review.
#
# Auth: `agy` itself uses OAuth via the system keyring or an
# `ANTIGRAVITY_API_KEY` env var. We never read or echo the key — we only
# check for its presence.

set -euo pipefail

# Resolve the `agy` binary. PATH first, then common install locations used by
# the official installer (`curl … install.sh | bash`).
find_agy() {
  if command -v agy >/dev/null 2>&1; then
    command -v agy
    return 0
  fi
  for candidate in \
      "$HOME/.local/bin/agy" \
      "/opt/antigravity/bin/agy" \
      "/usr/local/bin/agy"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# auth_status prints one of: api-key | oauth | missing
auth_status() {
  if [ -n "${ANTIGRAVITY_API_KEY:-}" ]; then
    echo "api-key"
  elif [ -d "$HOME/.config/antigravity" ] || [ -d "$HOME/.gemini/antigravity-cli" ]; then
    echo "oauth"
  else
    echo "missing"
  fi
}

# Minimal JSON string escape — pure bash so it works on both BSD (macOS) and
# GNU sed. Handles the chars likely to appear in paths/version strings.
j_esc() {
  local s="$1"
  s="${s//\\/\\\\}"     # backslash  -> \
  s="${s//\"/\\\"}"        # "          -> \"
  s="${s//$'\n'/\\n}"       # newline    -> \n
  s="${s//$'\r'/\\r}"       # CR         -> \r
  s="${s//$'\t'/\\t}"       # tab        -> \t
  printf '%s' "$s"
}

cmd_check() {
  if ! path="$(find_agy | head -n1)"; then
    cat <<JSON
{ "installed": false, "path": "", "version": "", "auth": "unknown",
  "error": "agy binary not found; install with: curl -fsSL https://antigravity.google/cli/install.sh | bash" }
JSON
    return 0
  fi
  version="$("$path" --version 2>/dev/null | head -n1 || echo unknown)"
  auth="$(auth_status)"
  printf '{ "installed": true, "path": "%s", "version": "%s", "auth": "%s", "error": "" }\n' \
    "$(j_esc "$path")" "$(j_esc "$version")" "$(j_esc "$auth")"
}

# Fail fast if `agy` is missing or unauthenticated. Prints the binary path on
# success.
require_ready() {
  if ! path="$(find_agy)"; then
    echo "error: agy is not installed." >&2
    echo "       install: curl -fsSL https://antigravity.google/cli/install.sh | bash" >&2
    exit 127
  fi
  if [ "$(auth_status)" = "missing" ]; then
    echo "error: agy is not authenticated." >&2
    echo "       run \`agy\` once interactively, or export ANTIGRAVITY_API_KEY" >&2
    exit 1
  fi
  echo "$path"
}

cmd_ask() {
  local prompt="${1:-}"
  shift || true
  if [ -z "$prompt" ]; then
    echo "error: ask requires a prompt argument" >&2
    exit 64
  fi
  local path
  path="$(require_ready)"
  "$path" -p "$prompt" "$@"
}

cmd_review() {
  local focus="${1:-Please review the following diff for correctness, edge cases, security issues, and style.}"
  local path
  path="$(require_ready)"
  local repo_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
  local diff
  diff="$(git -C "$repo_dir" diff HEAD 2>/dev/null || true)"
  if [ -z "$diff" ]; then
    diff="$(git -C "$repo_dir" diff 2>/dev/null || true)"
  fi
  if [ -z "$diff" ]; then
    echo "error: no git diff found in $repo_dir. Stage or make changes first." >&2
    exit 1
  fi
  local full
  full=$(printf '%s\n\nDiff:\n```diff\n%s\n```\n' "$focus" "$diff")
  "$path" -p "$full"
}

cmd_image() {
  local description=""
  local name=""
  local output=""
  # Parse --name and --output anywhere in the args; anything else accumulates
  # into the description (so users can pass either flag-first or text-first).
  local positional=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --name)    name="${2:-}";   shift 2 ;;
      --output)  output="${2:-}"; shift 2 ;;
      --)        shift; positional+=("$@"); break ;;
      *)         positional+=("$1"); shift ;;
    esac
  done
  description="${positional[*]}"
  if [ -z "$description" ]; then
    echo "error: image requires a description" >&2
    exit 64
  fi
  local agy_path
  agy_path="$(require_ready)"
  local prompt
  if [ -n "$name" ]; then
    prompt="Please generate an image: ${description}. Save the image with name \"${name}\"."
  else
    prompt="Please generate an image: ${description}."
  fi
  # Capture response — agy will print the path of the generated PNG.
  local response
  if ! response="$("$agy_path" -p "$prompt" 2>&1)"; then
    printf '%s\n' "$response"
    return 1
  fi
  printf '%s\n' "$response"
  # Optional copy: scan the response for an artifact path and copy it to
  # --output. We accept any absolute path ending in .png/.jpg/.jpeg/.webp.
  if [ -n "$output" ]; then
    local src
    src="$(printf '%s' "$response" \
      | grep -oE '/[^[:space:]]+\.(png|jpg|jpeg|webp)' \
      | head -n1)"
    if [ -n "$src" ] && [ -f "$src" ]; then
      cp "$src" "$output"
      echo
      echo "[wrapper] copied $src -> $output"
    else
      echo
      echo "[wrapper] warning: could not locate a generated image path in agy's response" >&2
    fi
  fi
}

usage() {
  cat >&2 <<'USAGE'
agy-run.sh — wrapper for the Google Antigravity CLI inside the Claude Code plugin.

Subcommands:
  check                       Print install/auth status as JSON.
  ask "<prompt>" [-- flags]   Run `agy -p "<prompt>"` non-interactively.
  review [focus text]         Pipe current `git diff` into `agy` for review.
  image "<description>"       Ask agy to generate an image (Imagen under the hood).
          [--name <slug>] [--output <path>]
USAGE
}

case "${1:-}" in
  check)              cmd_check ;;
  ask)     shift;     cmd_ask "$@" ;;
  review)  shift;     cmd_review "$@" ;;
  image)   shift;     cmd_image "$@" ;;
  -h|--help|"")       usage; exit 64 ;;
  *)                  echo "error: unknown subcommand '$1'" >&2; usage; exit 64 ;;
esac
