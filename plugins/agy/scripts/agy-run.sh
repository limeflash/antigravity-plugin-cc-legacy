#!/usr/bin/env bash
# agy-run.sh — Claude Code wrapper around Google Antigravity CLI (`agy`).
# Subcommands: check | ask | review | image | help.
# `--model` (on ask) overrides the model for one call via locked
# settings.json patching, restored on exit.

set -euo pipefail

# Directory this script lives in, so we can locate sibling lib/ helpers
# (lib/transcript.mjs powers the read-only issue-#76 output capture).
AGY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGY_LIB_DIR="$AGY_SCRIPT_DIR/lib"

AGY_SETTINGS_FILE="${HOME}/.gemini/antigravity-cli/settings.json"
AGY_SETTINGS_LOCKDIR="${HOME}/.gemini/antigravity-cli/.agy-plugin.lock"
AGY_SETTINGS_BACKUP="${HOME}/.gemini/antigravity-cli/settings.json.agy-plugin.bak"
AGY_SETTINGS_SENTINEL="${HOME}/.gemini/antigravity-cli/.agy-plugin.patched"

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

auth_status() {
  if [ -n "${ANTIGRAVITY_API_KEY:-}" ]; then
    echo "api-key"
  elif [ -d "$HOME/.config/antigravity" ] || [ -d "$HOME/.gemini/antigravity-cli" ]; then
    echo "oauth"
  else
    echo "missing"
  fi
}

j_esc() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

# Resolve a path to absolute canonical form, falling back gracefully on
# platforms that lack `realpath` or GNU `readlink -f` (macOS /bin/bash,
# BusyBox). If no canonicalization tool is available, returns the input
# unchanged — callers must treat the result as untrusted in that case.
_canonicalize_path() {
  local p="$1"
  [ -n "$p" ] || return 1
  if command -v realpath >/dev/null 2>&1; then
    realpath "$p" 2>/dev/null && return 0
  fi
  if command -v readlink >/dev/null 2>&1; then
    readlink -f "$p" 2>/dev/null && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$p" 2>/dev/null && return 0
  fi
  printf '%s' "$p"
}

# Returns 0 iff $1 resolves to a path inside one of `agy`'s known
# artifacts directories. Used by cmd_image to refuse copying an
# attacker-controlled IMAGE_PATH (e.g. via prompt injection in the
# model's reply pointing at `/etc/passwd`).
_image_source_in_allowlist() {
  local src="$1"
  [ -n "$src" ] || return 1
  local canonical; canonical="$(_canonicalize_path "$src")" || return 1
  local prefix
  for prefix in \
      "$HOME/.gemini/antigravity-cli/brain/" \
      "$HOME/.gemini/antigravity-cli/scratch/" \
      "$HOME/.gemini/antigravity-cli/cache/"; do
    case "$canonical" in
      "$prefix"*) return 0 ;;
    esac
  done
  return 1
}

# Best-effort scan for common secret patterns in added lines of a git
# diff. Returns 0 (silent) if nothing found, 1 if any pattern matched
# (writes one matched pattern label per line to stdout). This is a
# guardrail, not a substitute for a real secret scanner like gitleaks —
# patterns are deliberately conservative to keep false positives low.
#
# Patterns and labels are kept in parallel arrays because some patterns
# legitimately contain `|` (alternation), so a single-string
# "pattern|label" format is ambiguous.
_scan_diff_for_secrets() {
  local diff_text="$1"
  local added
  # Only scan added lines (starting with single `+`, not the `+++` header).
  added="$(printf '%s\n' "$diff_text" | grep -E '^\+[^+]' || true)"
  [ -n "$added" ] || return 0
  local pats=(
    'AKIA[0-9A-Z]{16}'
    'ASIA[0-9A-Z]{16}'
    'gh[pousr]_[A-Za-z0-9]{36,}'
    'xox[baprs]-[A-Za-z0-9-]{10,}'
    'sk-[A-Za-z0-9]{20,}'
    '-----BEGIN [A-Z ]*PRIVATE KEY-----'
    '(api[_-]?key|secret|token|password|access[_-]?key)[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9_+/=\-]{16,}'
  )
  local labels=(
    'AWS access key'
    'AWS STS token'
    'GitHub personal access token'
    'Slack token'
    'OpenAI/Anthropic-style API key'
    'PEM private key block'
    'inline credential assignment'
  )
  local hits=()
  local i
  for i in "${!pats[@]}"; do
    # `-e <pattern>` is required because some patterns start with `-`
    # (e.g. PEM headers), which grep would otherwise treat as an option.
    if printf '%s\n' "$added" | grep -aEi -e "${pats[$i]}" >/dev/null 2>&1; then
      hits+=("${labels[$i]}")
    fi
  done
  [ "${#hits[@]}" -gt 0 ] || return 0
  printf '%s\n' "${hits[@]}"
  return 1
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

# fd arg lets cmd_help reuse the same table on stdout.
print_model_table() {
  local fd="${1:-2}"
  {
    echo "Aliases (case-insensitive):"
    echo "  flash-low                     -> Gemini 3.5 Flash (Low)"
    echo "  flash-medium, flash-med       -> Gemini 3.5 Flash (Medium)"
    echo "  flash, flash-high             -> Gemini 3.5 Flash (High)"
    echo "  pro-low                       -> Gemini 3.1 Pro (Low)"
    echo "  pro, pro-high                 -> Gemini 3.1 Pro (High)"
    echo "  sonnet, claude-sonnet         -> Claude Sonnet 4.6 (Thinking)"
    echo "  opus, claude-opus             -> Claude Opus 4.6 (Thinking)"
    echo "  gpt-oss, gpt-oss-120b         -> GPT-OSS 120B (Medium)"
    echo
    echo "Canonical strings (also accepted verbatim, case-sensitive):"
    echo "  Gemini 3.5 Flash (Low|Medium|High)"
    echo "  Gemini 3.1 Pro (Low|High)"
    echo "  Claude Sonnet 4.6 (Thinking)"
    echo "  Claude Opus 4.6 (Thinking)"
    echo "  GPT-OSS 120B (Medium)"
  } >&"$fd"
}

_current_default_model() {
  [ -f "$AGY_SETTINGS_FILE" ] || return 1
  grep -oE '"model"[[:space:]]*:[[:space:]]*"[^"]*"' "$AGY_SETTINGS_FILE" 2>/dev/null \
    | sed -E 's/.*"model"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' \
    | head -n1
}

resolve_model_alias() {
  local input="${1:-}"
  if [ -z "$input" ]; then
    echo "error: --model requires a non-empty value (e.g. --model pro)" >&2
    print_model_table 2
    local current; current="$(_current_default_model 2>/dev/null || true)"
    if [ -n "$current" ]; then
      echo >&2
      echo "Tip: omit --model to use your current default (\"$current\")." >&2
    fi
    exit 64
  fi
  case "$input" in
    "Gemini 3.5 Flash (Low)"|\
    "Gemini 3.5 Flash (Medium)"|\
    "Gemini 3.5 Flash (High)"|\
    "Gemini 3.1 Pro (Low)"|\
    "Gemini 3.1 Pro (High)"|\
    "Claude Sonnet 4.6 (Thinking)"|\
    "Claude Opus 4.6 (Thinking)"|\
    "GPT-OSS 120B (Medium)")
      printf '%s' "$input"
      return 0 ;;
  esac
  # bash 3.2 (macOS /bin/bash) lacks ${var,,}, hence tr.
  local lc; lc="$(printf '%s' "$input" | tr '[:upper:]' '[:lower:]')"
  case "$lc" in
    flash-low)                  printf '%s' "Gemini 3.5 Flash (Low)" ;;
    flash-medium|flash-med)     printf '%s' "Gemini 3.5 Flash (Medium)" ;;
    flash|flash-high)           printf '%s' "Gemini 3.5 Flash (High)" ;;
    pro-low)                    printf '%s' "Gemini 3.1 Pro (Low)" ;;
    pro|pro-high)               printf '%s' "Gemini 3.1 Pro (High)" ;;
    sonnet|claude-sonnet)       printf '%s' "Claude Sonnet 4.6 (Thinking)" ;;
    opus|claude-opus)           printf '%s' "Claude Opus 4.6 (Thinking)" ;;
    gpt-oss|gpt-oss-120b)       printf '%s' "GPT-OSS 120B (Medium)" ;;
    *)
      echo "error: unknown model alias '$input'" >&2
      print_model_table 2
      exit 64 ;;
  esac
}

validate_settings_file() {
  if [ ! -f "$AGY_SETTINGS_FILE" ]; then
    echo "error: $AGY_SETTINGS_FILE not found." >&2
    echo "       run \`agy\` once interactively to create it." >&2
    exit 1
  fi
  if [ ! -s "$AGY_SETTINGS_FILE" ]; then
    echo "error: $AGY_SETTINGS_FILE is empty." >&2
    exit 1
  fi
  if command -v python3 >/dev/null 2>&1; then
    if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$AGY_SETTINGS_FILE" 2>/dev/null; then
      echo "error: $AGY_SETTINGS_FILE is not valid JSON." >&2
      exit 1
    fi
  fi
  if ! grep -q '"model"' "$AGY_SETTINGS_FILE"; then
    echo "error: $AGY_SETTINGS_FILE has no \"model\" field." >&2
    echo "       open \`agy\` and pick a model with /model first." >&2
    exit 1
  fi
}

restore_orphaned_backup() {
  [ -f "$AGY_SETTINGS_SENTINEL" ] || {
    if [ -f "$AGY_SETTINGS_BACKUP" ]; then
      echo "[wrapper] note: stale backup with no sentinel; removing $AGY_SETTINGS_BACKUP" >&2
      rm -f "$AGY_SETTINGS_BACKUP"
    fi
    return 0
  }
  local pid; pid="$(head -n1 "$AGY_SETTINGS_SENTINEL" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  if [ -f "$AGY_SETTINGS_BACKUP" ]; then
    mv "$AGY_SETTINGS_BACKUP" "$AGY_SETTINGS_FILE"
    echo "[wrapper] recovered orphaned settings backup from PID ${pid:-unknown}" >&2
  fi
  rm -f "$AGY_SETTINGS_SENTINEL"
}

# mkdir-based lock; macOS has no flock(1). Dead-holder detection avoids
# SIGKILL deadlocks.
with_settings_lock() {
  local fn="$1"; shift
  local attempt=0
  local max_wait="${AGY_LOCK_WAIT_SECONDS:-600}"
  while ! mkdir "$AGY_SETTINGS_LOCKDIR" 2>/dev/null; do
    local holder_pid_file="${AGY_SETTINGS_LOCKDIR}/pid"
    if [ -f "$holder_pid_file" ]; then
      local holder_pid; holder_pid="$(cat "$holder_pid_file" 2>/dev/null || true)"
      if [ -n "$holder_pid" ] && ! kill -0 "$holder_pid" 2>/dev/null; then
        rm -rf "$AGY_SETTINGS_LOCKDIR"
        continue
      fi
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -gt "$max_wait" ]; then
      echo "error: could not acquire settings lock after ${max_wait}s" >&2
      exit 1
    fi
    sleep 1
  done
  echo "$$" > "${AGY_SETTINGS_LOCKDIR}/pid"
  local rc=0
  "$fn" "$@" || rc=$?
  rm -rf "$AGY_SETTINGS_LOCKDIR"
  return "$rc"
}

# python3 preferred for correctness; sed fallback only matches single-line
# "model": "..." (the format agy itself writes).
_patch_model_field() {
  local canonical="$1"
  local tmp; tmp="$(mktemp "${AGY_SETTINGS_FILE}.tmp.XXXXXX")"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$AGY_SETTINGS_FILE" "$canonical" "$tmp" <<'PY'
import json, sys
src, model, dst = sys.argv[1], sys.argv[2], sys.argv[3]
with open(src) as f:
    data = json.load(f)
data["model"] = model
with open(dst, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
  else
    local esc; esc="$(printf '%s' "$canonical" | sed -e 's/[\/&]/\\&/g')"
    sed -E "s/^([[:space:]]*\"model\"[[:space:]]*:[[:space:]]*\")[^\"]*(\".*)$/\1${esc}\2/" \
        "$AGY_SETTINGS_FILE" > "$tmp"
    echo "[wrapper] note: python3 missing, used sed fallback to patch settings.json" >&2
  fi
  mv "$tmp" "$AGY_SETTINGS_FILE"
}

_restore_settings() {
  if [ -f "$AGY_SETTINGS_BACKUP" ]; then
    mv "$AGY_SETTINGS_BACKUP" "$AGY_SETTINGS_FILE"
  fi
  rm -f "$AGY_SETTINGS_SENTINEL"
}

_do_patched_run() {
  local canonical="$1"; shift
  cp -p "$AGY_SETTINGS_FILE" "$AGY_SETTINGS_BACKUP"
  printf '%s\n%s\n' "$$" "$canonical" > "$AGY_SETTINGS_SENTINEL"
  trap '_restore_settings' EXIT INT TERM HUP
  _patch_model_field "$canonical"
  local rc=0
  "$@" || rc=$?
  _restore_settings
  trap - EXIT INT TERM HUP
  return "$rc"
}

# `--` separator guards against canonical names that start with `-`.
with_model_override() {
  local canonical="$1"; shift
  if [ "${1:-}" != "--" ]; then
    echo "internal: with_model_override expects '--' after canonical name" >&2
    exit 70
  fi
  shift
  validate_settings_file
  with_settings_lock _do_patched_run "$canonical" "$@"
}

# ---------------------------------------------------------------------------
# agy issue #76 output capture.
#
# `agy --print`, when stdout is NOT a TTY (any time the plugin runs it from
# a subprocess / agent Bash tool), generates the response internally but
# flushes ZERO bytes to stdout — the "drip" typewriter only targets a real
# terminal. Confirmed on agy 1.0.3: `Drip stopped: length=N` in the log
# while stdout stays empty. Separately, `agy --print` blocks forever on a
# non-TTY stdin that never reaches EOF, so we always close stdin
# (</dev/null).
#
# PRIMARY path (_agy_capture): agy persists its OWN conversation transcript
# to disk on every --print run — with NO tool permission and NO
# auto-approve. So we run agy strictly READ-ONLY (--sandbox, --add-dir only
# a throwaway temp dir, --log-file so we can recover the conversation id)
# and read the model's answer back from that transcript via
# lib/transcript.mjs. No write_file, no --dangerously-skip-permissions.
#
# FALLBACK path (_agy_capture_writefile): only when `node` is unavailable
# (the transcript is JSONL, parsed with node). Reverts to instructing agy
# to write_file its answer under --dangerously-skip-permissions, scoped to
# a throwaway temp dir. Kept so /agy:ask still works without node.
#
# Usage: _agy_capture <agy> <canonical-model-or-empty> <timeout> <prompt> [extra agy args...]
# Prints the response on success (rc 0); prints an error and rc 1 otherwise.
# ---------------------------------------------------------------------------
_agy_capture() {
  local agy="$1" canonical="$2" timeout="$3" prompt="$4"
  shift 4

  # The transcript is JSONL; we parse it with node. Without node, fall back
  # to the write_file capture so /agy:ask still works everywhere.
  if ! command -v node >/dev/null 2>&1; then
    _agy_capture_writefile "$agy" "$canonical" "$timeout" "$prompt" "$@"
    return $?
  fi

  local outdir
  outdir="$(mktemp -d 2>/dev/null)" || { echo "error: could not create temp dir for agy output" >&2; return 1; }
  local logfile="$outdir/agy-run.log"
  # agy may be a Windows .exe invoked from Git Bash, which needs native
  # Windows paths for --add-dir and --log-file.
  # cwd_arg is the directory agy actually runs in ($PWD — we never cd), so
  # it's the workspace key agy registers in last_conversations.json; pass it
  # as the transcript fallback hint.
  local target_dir logfile_arg cwd_arg
  if command -v cygpath >/dev/null 2>&1; then
    target_dir="$(cygpath -w "$outdir")"
    logfile_arg="$(cygpath -w "$logfile")"
    cwd_arg="$(cygpath -w "$PWD")"
  else
    target_dir="$outdir"
    logfile_arg="$logfile"
    cwd_arg="$PWD"
  fi

  # agy --print takes the whole prompt as ONE argv entry, so it must stay
  # under the OS command-line limit (~32 KB on Windows) or the process
  # fails with ENAMETOOLONG. Cap by BYTES (multibyte-safe via wc -c/head -c).
  # No write_file suffix now, so the whole budget is the prompt body.
  local max_body="${AGY_PROMPT_MAX_BYTES:-30000}"
  local prompt_bytes; prompt_bytes="$(printf '%s' "$prompt" | wc -c)"
  if [ "$prompt_bytes" -gt "$max_body" ]; then
    prompt="$(printf '%s' "$prompt" | head -c "$max_body" || true)"$'\n\n[...content truncated to fit the OS command-line length limit; some context was omitted...]'
  fi

  # Per-call model override decision (unchanged): agy 1.0.x has no top-level
  # "model" key until the user sets one in the TUI, so degrade gracefully
  # rather than hard-fail.
  local use_override=0
  if [ -n "$canonical" ]; then
    if [ -f "$AGY_SETTINGS_FILE" ] && grep -q '"model"' "$AGY_SETTINGS_FILE" 2>/dev/null; then
      use_override=1
    else
      echo "[wrapper] note: --model requested, but agy's settings.json has no \"model\" field to patch on this version; using the current default model instead. (Set a model once in the agy TUI to enable per-call overrides.)" >&2
    fi
  fi

  # READ-ONLY run: --sandbox + --add-dir <tmp> + --log-file; NO
  # --dangerously-skip-permissions, NO write_file. </dev/null dodges the
  # non-TTY stdin hang. stdout is empty under #76 — ignored.
  if [ "$use_override" -eq 1 ]; then
    with_model_override "$canonical" -- "$agy" --sandbox \
      --add-dir "$target_dir" --log-file "$logfile_arg" --print-timeout "$timeout" "$@" --print "$prompt" \
      </dev/null >/dev/null 2>&1 || true
  else
    "$agy" --sandbox \
      --add-dir "$target_dir" --log-file "$logfile_arg" --print-timeout "$timeout" "$@" --print "$prompt" \
      </dev/null >/dev/null 2>&1 || true
  fi

  # Recover the model's answer from agy's own transcript. Pass the
  # Windows-safe log path (logfile_arg) so a native Node on Windows can read
  # it even if MSYS argv conversion is disabled, and the repo cwd as the
  # fallback hint. transcript.mjs prints the answer + exits 0, or exits
  # non-zero (empty) if nothing was recovered. We capture its stderr and
  # surface it only on failure, so diagnostics aren't lost but the happy
  # path stays clean.
  local rc=0 answer="" node_err="$outdir/node.err"
  if answer="$(node "$AGY_LIB_DIR/transcript.mjs" "$logfile_arg" "$cwd_arg" 2>"$node_err")" && [ -n "$answer" ]; then
    printf '%s\n' "$answer"
  else
    rc=1
    {
      echo "error: agy returned no output."
      echo "       Could not recover an answer from agy's transcript (issue #76 capture)."
      echo "       Possible causes:"
      echo "       - the prompt timed out (raise the timeout), or"
      echo "       - agy was interrupted before it answered."
      if [ -s "$node_err" ]; then
        echo "       transcript.mjs stderr:"
        sed 's/^/         /' "$node_err"
      fi
      echo "       Run \`agy\` interactively to debug, or check ~/.gemini/antigravity-cli/log/."
    } >&2
  fi
  rm -rf "$outdir"
  return "$rc"
}

# ---------------------------------------------------------------------------
# Legacy fallback capture — used only when `node` is unavailable. Instructs
# agy to write_file its answer to a temp file under
# --dangerously-skip-permissions, scoped to a throwaway temp dir. See the
# _agy_capture header for why the transcript path is preferred.
# ---------------------------------------------------------------------------
_agy_capture_writefile() {
  local agy="$1" canonical="$2" timeout="$3" prompt="$4"
  shift 4
  local outdir
  outdir="$(mktemp -d 2>/dev/null)" || { echo "error: could not create temp dir for agy output" >&2; return 1; }
  local outfile="$outdir/agy-response.md"
  # agy may be a Windows .exe invoked from Git Bash, which needs a native
  # Windows path for both --add-dir and the write_file target.
  local prompt_path target_dir
  if command -v cygpath >/dev/null 2>&1; then
    prompt_path="$(cygpath -w "$outfile")"
    target_dir="$(cygpath -w "$outdir")"
  else
    prompt_path="$outfile"
    target_dir="$outdir"
  fi
  # agy --print takes the whole prompt as ONE argv entry, so it must
  # stay under the OS command-line limit (~32 KB on Windows) or the
  # process fails with "Argument list too long" / ENAMETOOLONG. Cap the
  # body (the write_file instruction is appended after, always intact).
  # Cap by BYTES, not characters: `${#prompt}` / `${prompt:0:N}` count
  # characters, so multibyte UTF-8 (CJK, emoji) could still blow past
  # the byte limit. `wc -c` / `head -c` are byte-accurate in any locale.
  local max_body="${AGY_PROMPT_MAX_BYTES:-26000}"
  local prompt_bytes; prompt_bytes="$(printf '%s' "$prompt" | wc -c)"
  if [ "$prompt_bytes" -gt "$max_body" ]; then
    prompt="$(printf '%s' "$prompt" | head -c "$max_body" || true)"$'\n\n[...content truncated to fit the OS command-line length limit; some diff/file context was omitted...]'
  fi
  local augmented
  augmented="$(printf '%s\n\n---\nOUTPUT INSTRUCTION (required): Use the write_file tool to write your COMPLETE response to this exact path:\n%s\nDo NOT print the answer to chat — that path is your only deliverable. After writing the file, stop.\n' "$prompt" "$prompt_path")"

  # Decide whether the per-call model override is actually usable. agy
  # 1.0.x does NOT keep a top-level "model" key in settings.json until
  # the user changes the model in the TUI, so the patch-and-restore path
  # has nothing to patch. Rather than hard-fail the whole command (the
  # old validate_settings_file did `exit 1`), degrade gracefully: warn
  # once and run with agy's current default model.
  local use_override=0
  if [ -n "$canonical" ]; then
    if [ -f "$AGY_SETTINGS_FILE" ] && grep -q '"model"' "$AGY_SETTINGS_FILE" 2>/dev/null; then
      use_override=1
    else
      echo "[wrapper] note: --model requested, but agy's settings.json has no \"model\" field to patch on this version; using the current default model instead. (Set a model once in the agy TUI to enable per-call overrides.)" >&2
    fi
  fi

  if [ "$use_override" -eq 1 ]; then
    with_model_override "$canonical" -- "$agy" --dangerously-skip-permissions --sandbox \
      --add-dir "$target_dir" --print-timeout "$timeout" "$@" --print "$augmented" \
      </dev/null >/dev/null 2>&1 || true
  else
    "$agy" --dangerously-skip-permissions --sandbox \
      --add-dir "$target_dir" --print-timeout "$timeout" "$@" --print "$augmented" \
      </dev/null >/dev/null 2>&1 || true
  fi

  local rc=0
  if [ -s "$outfile" ]; then
    cat "$outfile"
  else
    rc=1
    {
      echo "error: agy returned no output."
      echo "       This is agy issue #76 (empty stdout in non-TTY) combined with the"
      echo "       write_file workaround failing to produce a file. Possible causes:"
      echo "       - the prompt timed out (raise the timeout), or"
      echo "       - agy refused/limited the write_file tool."
      echo "       Run \`agy\` interactively to debug, or check ~/.gemini/antigravity-cli/log/."
    } >&2
  fi
  rm -rf "$outdir"
  return "$rc"
}

cmd_ask() {
  local model_alias=""
  local model_flag_seen=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --model)
        model_flag_seen=1
        # `shift 2` on a one-arg list would `set -e`-exit silently; handle
        # the empty case so resolve_model_alias prints the real error.
        if [ $# -ge 2 ]; then
          model_alias="$2"; shift 2
        else
          shift
        fi ;;
      --model=*)
        model_flag_seen=1
        model_alias="${1#--model=}"
        shift ;;
      --)        shift; break ;;
      *)         break ;;
    esac
  done
  # Resolve model before prompt check so empty --model gets the right error.
  local canonical=""
  if [ "$model_flag_seen" -eq 1 ]; then
    canonical="$(resolve_model_alias "$model_alias")"
  fi
  local prompt="${1:-}"
  shift || true
  if [ -z "$prompt" ]; then
    echo "error: ask requires a prompt argument" >&2
    exit 64
  fi
  local path
  path="$(require_ready)"
  # Route through the write_file workaround (agy issue #76). Default to an
  # 8-minute timeout; agy usually writes the file within seconds.
  _agy_capture "$path" "$canonical" "${AGY_ASK_TIMEOUT:-8m0s}" "$prompt" "$@"
}

cmd_review() {
  local focus="${1:-Please review the following diff for correctness, edge cases, security issues, and style.}"
  local path
  path="$(require_ready)"
  local repo_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
  # -U<N> gives agy more context around each hunk than git's default 3
  # lines, so it can see imports / early returns / nearby code and stop
  # flagging false positives for things just outside the window.
  local ctx="${AGY_REVIEW_CONTEXT:-25}"
  local diff
  local -a diff_range=("HEAD")
  diff="$(git -C "$repo_dir" diff "-U${ctx}" HEAD 2>/dev/null || true)"
  if [ -z "$diff" ]; then
    # Fall back to the unstaged diff — and sync the name-only file list
    # below to the same range (was always "HEAD", starving full-file
    # context of the fallback's files).
    diff_range=()
    diff="$(git -C "$repo_dir" diff "-U${ctx}" 2>/dev/null || true)"
  fi
  if [ -z "$diff" ]; then
    echo "error: no git diff found in $repo_dir. Stage or make changes first." >&2
    exit 1
  fi

  # Guardrail: refuse to ship a diff containing obvious secrets unless the
  # user opted in via AGY_REVIEW_ALLOW_SECRETS=1. Best-effort; false
  # negatives are possible.
  local secret_hits
  if ! secret_hits="$(_scan_diff_for_secrets "$diff")"; then
    {
      echo
      echo "[wrapper] WARNING: diff contains values matching common secret patterns:"
      printf '%s\n' "$secret_hits" | sed 's/^/  - /'
      echo
      echo "  Sending it through agy will forward those values to Google's Gemini API."
      if [ "${AGY_REVIEW_ALLOW_SECRETS:-0}" != "1" ]; then
        echo "  Aborting. Set AGY_REVIEW_ALLOW_SECRETS=1 to proceed anyway, or remove"
        echo "  the matching lines from your diff first."
        exit 65
      fi
      echo "  Proceeding because AGY_REVIEW_ALLOW_SECRETS=1."
    } >&2
  fi

  # Full content of small changed files, so agy sees whole-file
  # structure (imports, guards) not just hunks. Cap per-file lines and
  # total bytes so a big changeset can't blow up the prompt.
  # Defaults aligned with the Node companion (lib/git.mjs). Kept well
  # under AGY_PROMPT_MAX_BYTES so the files block + diff don't get
  # truncated mid-prompt.
  local max_lines="${AGY_REVIEW_FULLFILE_MAX_LINES:-250}"
  local budget="${AGY_REVIEW_FULLFILE_BUDGET_BYTES:-12288}"
  local files_block="" used=0
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    local abs="$repo_dir/$f"
    # Regular file only, and NOT a symlink (a symlinked path in the diff
    # could point at an arbitrary host file like /etc/passwd).
    [ -f "$abs" ] && [ ! -L "$abs" ] || continue
    # Directory-symlink defense: resolve the real path and require it to
    # stay inside the repo (catches `linked_dir/file` where linked_dir
    # points outside). Skip the file if it escapes.
    if command -v realpath >/dev/null 2>&1; then
      local rp rr
      rp="$(realpath "$abs" 2>/dev/null || echo)"
      rr="$(realpath "$repo_dir" 2>/dev/null || echo "$repo_dir")"
      # Case-insensitive prefix match: Windows/macOS filesystems are
      # case-insensitive, and realpath may return different casing than
      # $repo_dir, which would wrongly skip a legitimate in-repo file.
      local rp_l rr_l
      rp_l="$(printf '%s' "$rp" | tr '[:upper:]' '[:lower:]')"
      rr_l="$(printf '%s' "$rr" | tr '[:upper:]' '[:lower:]')"
      case "$rp_l" in "$rr_l"/*) : ;; *) continue ;; esac
    fi
    # skip binary (no NUL byte => text)
    if grep -qI . "$abs" 2>/dev/null; then :; else continue; fi
    local lc; lc="$(wc -l < "$abs" 2>/dev/null || echo 999999)"
    [ "$lc" -le "$max_lines" ] || continue
    local sz; sz="$(wc -c < "$abs" 2>/dev/null || echo 0)"
    # Only count toward the budget if it actually fits — otherwise a big
    # file would inflate `used` and starve every later (small) file.
    if [ "$((used + sz))" -le "$budget" ]; then
      used=$((used + sz))
    else
      continue
    fi
    local ext="${f##*.}"
    # Dynamic fence: one more backtick than the longest backtick run in
    # the file, so content containing ``` (or ````) can't close the
    # block early. min 3.
    local maxrun
    # `|| true`: grep exits 1 when the file contains no backticks; with
    # `set -o pipefail` that propagates and `set -e` would abort the whole
    # review on the first backtick-free file (e.g. package.json). awk still
    # prints the count (3 for no-backtick input), so swallow grep's status.
    maxrun="$(grep -oE '`+' "$abs" 2>/dev/null | awk '{ if (length>m) m=length } END { n=(m<2?2:m)+1; print n }' || true)"
    [ -n "$maxrun" ] || maxrun=3
    # Build the fence without `seq` (absent in some minimal shells).
    local fence="" _i
    for ((_i = 0; _i < maxrun; _i++)); do fence="${fence}\`"; done
    files_block="${files_block}"$'\n'"### ${f}"$'\n'"${fence}${ext}"$'\n'"$(cat "$abs")"$'\n'"${fence}"$'\n'
  done < <(git -C "$repo_dir" diff --name-only "${diff_range[@]}" 2>/dev/null)

  local full
  if [ -n "$files_block" ]; then
    full=$(printf '%s\n\nFull current content of the changed files (for context — do NOT flag issues already handled elsewhere in these files):\n%s\nDiff (with expanded context):\n```diff\n%s\n```\n' "$focus" "$files_block" "$diff")
  else
    full=$(printf '%s\n\nDiff (with expanded context):\n```diff\n%s\n```\n' "$focus" "$diff")
  fi
  # Route through the write_file workaround (agy issue #76). Reviews can
  # run long on big diffs; default to 10 minutes.
  _agy_capture "$path" "" "${AGY_REVIEW_TIMEOUT:-10m0s}" "$full"
}

cmd_image() {
  local description=""
  local name=""
  local output=""
  local positional=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --name)
        if [ $# -ge 2 ]; then
          name="$2"; shift 2
        else
          echo "error: --name requires a value (e.g. --name coffee_cup)" >&2
          exit 64
        fi ;;
      --name=*)
        name="${1#--name=}"
        if [ -z "$name" ]; then
          echo "error: --name= requires a non-empty value" >&2
          exit 64
        fi
        shift ;;
      --output)
        if [ $# -ge 2 ]; then
          output="$2"; shift 2
        else
          echo "error: --output requires a path (e.g. --output /tmp/out.png)" >&2
          exit 64
        fi ;;
      --output=*)
        output="${1#--output=}"
        if [ -z "$output" ]; then
          echo "error: --output= requires a non-empty path" >&2
          exit 64
        fi
        shift ;;
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

  # agy issue #76 workaround. The old design asked agy to end its reply
  # with an `IMAGE_PATH:` line, but agy --print flushes nothing to a
  # non-TTY stdout (so the marker never arrived) and hangs on a non-TTY
  # stdin. Instead: agy generates the image, then write_file's the
  # saved image's absolute path into a marker file we read back.
  local outdir
  outdir="$(mktemp -d 2>/dev/null)" || { echo "error: could not create temp dir" >&2; return 1; }
  local marker="$outdir/image-path.txt"
  local marker_path target_dir
  if command -v cygpath >/dev/null 2>&1; then
    marker_path="$(cygpath -w "$marker")"
    target_dir="$(cygpath -w "$outdir")"
  else
    marker_path="$marker"
    target_dir="$outdir"
  fi
  local name_clause=""
  if [ -n "$name" ]; then
    name_clause=" Save the image with the name \"${name}\"."
  fi
  local prompt
  prompt="$(printf 'Use your built-in generate_image tool to create this image: %s.%s\n\nAfter the image is saved, use the write_file tool to write ONLY the absolute filesystem path of the saved image (a single line, no quotes, nothing else) to this exact path:\n%s\nDo not print anything to chat. The marker file is your only textual deliverable.' "$description" "$name_clause" "$marker_path")"

  # stdin </dev/null avoids the hang; --sandbox + --add-dir <tmp> scope
  # the auto-approved write_file to the throwaway temp dir only.
  "$agy_path" --dangerously-skip-permissions --sandbox --add-dir "$target_dir" \
    --print-timeout "${AGY_IMAGE_TIMEOUT:-8m0s}" --print "$prompt" \
    </dev/null >/dev/null 2>&1 || true

  local src=""
  if [ -s "$marker" ]; then
    src="$(grep -m1 -v '^[[:space:]]*$' "$marker" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    # agy may report a native Windows path; translate so [ -f ] works.
    if command -v cygpath >/dev/null 2>&1 && printf '%s' "$src" | grep -q '^[A-Za-z]:[\\/]'; then
      src="$(cygpath -u "$src" 2>/dev/null || printf '%s' "$src")"
    fi
  fi
  rm -rf "$outdir"

  if [ -n "$src" ] && [ -f "$src" ]; then
    # Guardrail: refuse paths outside agy's artifacts dirs (prompt
    # injection could otherwise make us copy an arbitrary host file).
    if ! _image_source_in_allowlist "$src"; then
      {
        echo "[wrapper] error: refusing to use image source path outside agy's artifacts directory."
        echo "[wrapper]        path: $src"
        echo "[wrapper]        allowed prefixes: ~/.gemini/antigravity-cli/{brain,scratch,cache}/"
      } >&2
      return 66
    fi
    echo "[wrapper] generated: $src"
    if [ -n "$output" ]; then
      cp "$src" "$output"
      echo "[wrapper] copied to: $output"
    fi
    return 0
  fi

  {
    echo "[wrapper] error: agy did not produce a locatable image."
    echo "[wrapper]        The marker file was empty or the path it named does not exist."
    echo "[wrapper]        generate_image may have failed or write_file was declined; check"
    echo "[wrapper]        ~/.gemini/antigravity-cli/log/ or run \`agy\` interactively."
  } >&2
  return 1
}

cmd_help() {
  cat <<'HELP'
/agy:* commands (Claude Code plugin for the Antigravity CLI)

Slash commands
  /agy:setup                            Verify agy install + auth. Offers install if missing.
  /agy:ask [--model A] <prompt>         One-shot prompt; returns agy's response verbatim.
  /agy:delegate [--background] [--model A] <task>
                                        Hand a task to the agy:runner subagent.
  /agy:research [--background] [--model A] <topic>
                                        Deep-research investigation via agy:runner.
  /agy:review [focus]                   Send current `git diff` to agy for review.
  /agy:image [--name S] [--output P] <description>
                                        Generate an image via agy's built-in tool.
  /agy:help                             This help.

Model selection (--model)
HELP
  print_model_table 1
  cat <<'HELP'

How --model works
  The plugin manages the "model" field in ~/.gemini/antigravity-cli/settings.json
  for the duration of a single call: it takes a lock, swaps in your requested
  model, invokes agy, and restores the original on exit (including SIGINT /
  SIGTERM). If your TUI is open in parallel, its selected model will flip
  for the duration of the call and revert when the call finishes.

  Unknown aliases fail with exit 64 — typo safety beats forward-compat. If
  Google ships a new model, update the plugin.

Underlying CLI
  Run `agy --help` for agy's own flags: --add-dir, -c/--continue,
  --conversation, --dangerously-skip-permissions, -i/--prompt-interactive,
  --log-file, -p/--print, --print-timeout, --sandbox.

  Subcommands: changelog, help, install, plugin/plugins, update.
HELP
}

main() {
  restore_orphaned_backup 2>/dev/null || true

  case "${1:-}" in
    check)              cmd_check ;;
    ask)     shift;     cmd_ask "$@" ;;
    review)  shift;     cmd_review "$@" ;;
    image)   shift;     cmd_image "$@" ;;
    help|-h|--help|"")  cmd_help ;;
    *)                  echo "error: unknown subcommand '$1'" >&2; cmd_help >&2; exit 64 ;;
  esac
}

# Skip dispatch when sourced (lets unit tests call functions directly).
if [ "${BASH_SOURCE[0]:-}" = "${0:-}" ]; then
  main "$@"
fi
