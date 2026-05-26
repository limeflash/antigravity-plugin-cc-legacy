#!/usr/bin/env bash
# agy-run.sh — wrapper dla CLI Google Antigravity (`agy`) używany przez
# plugin Claude Code. Zachowuje cienką warstwę między slash commandami,
# subagentem `agy:runner` a samym `agy`.
#
# Subkomendy:
#   check                              Status instalacji + auth jako JSON.
#   ask [--model A] "<prompt>" [-- ..] Non-interaktywne `agy -p "<prompt>"`;
#                                      `--model` ustawia model dla tego wywołania.
#   review [focus text]                Wysyła aktualny `git diff` do `agy`.
#   image "<description>" [...]        Generuje obraz przez wbudowane narzędzie agy.
#   help                               Drukuje user-facing indeks /agy:*.
#
# Wybór modelu: plugin udostępnia flagę `--model` dla per-call wyboru modelu.
# Pod spodem zarządza polem "model" w ~/.gemini/antigravity-cli/settings.json
# (atomic write pod lockiem, restore po wywołaniu). Stale backupy po
# nieczystym wyjściu odzyskiwane są przy następnym uruchomieniu wrappera.
#
# Auth: `agy` używa OAuth przez system keyring lub zmiennej
# ANTIGRAVITY_API_KEY. Wrapper nigdy nie czyta ani nie loguje klucza —
# sprawdza tylko jego obecność.

set -euo pipefail

# Plik ustawień czytany przez CLI/TUI agy przy każdym starcie. Wrapper
# modyfikuje tutaj pole "model" gdy caller poda --model.
AGY_SETTINGS_FILE="${HOME}/.gemini/antigravity-cli/settings.json"
AGY_SETTINGS_LOCKDIR="${HOME}/.gemini/antigravity-cli/.agy-plugin.lock"
AGY_SETTINGS_BACKUP="${HOME}/.gemini/antigravity-cli/settings.json.agy-plugin.bak"
AGY_SETTINGS_SENTINEL="${HOME}/.gemini/antigravity-cli/.agy-plugin.patched"

# Lokalizacja binarki `agy`. Najpierw PATH, potem typowe ścieżki instalacyjne
# oficjalnego instalatora (`curl … install.sh | bash`).
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

# auth_status drukuje jedno z: api-key | oauth | missing
auth_status() {
  if [ -n "${ANTIGRAVITY_API_KEY:-}" ]; then
    echo "api-key"
  elif [ -d "$HOME/.config/antigravity" ] || [ -d "$HOME/.gemini/antigravity-cli" ]; then
    echo "oauth"
  else
    echo "missing"
  fi
}

# Minimalny JSON string escape — pure bash, działa zarówno na BSD sed
# (macOS) jak i GNU sed. Obsługuje znaki które realnie pojawiają się w
# ścieżkach i numerach wersji.
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

# Fail fast jeśli `agy` brakuje lub jest niezauthentykowany. Sukces =
# wypisanie ścieżki do binarki.
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

# -----------------------------------------------------------------------------
# Wybór modelu — aliasy + bezpieczna modyfikacja settings.json
# -----------------------------------------------------------------------------

# Drukuje tabelę aliasów na zadany deskryptor (domyślnie stderr). Używane
# zarówno przez błędną ścieżkę resolve_model_alias jak i przez cmd_help.
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

# resolve_model_alias <input> -> canonical na stdout lub exit 64 z tabelą
# aliasów na stderr.
resolve_model_alias() {
  local input="${1:-}"
  if [ -z "$input" ]; then
    echo "error: --model requires a non-empty value" >&2
    print_model_table 2
    exit 64
  fi
  # Najpierw exact-match canonical (case-sensitive) — pozwala wkleić string
  # z TUI verbatim, razem z paren-suffixem.
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
  # W przeciwnym razie traktuj jako alias: lowercase przez tr (bash 3.2
  # compat — macOS ma /bin/bash 3.2, więc bez ${var,,}).
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

# Bail z jasnym błędem gdy settings.json nie istnieje, jest pusty, ma
# zepsuty JSON albo brakuje w nim pola "model". Nigdy nie wymyślamy
# świeżego pliku — user powinien najpierw odpalić `agy` interaktywnie.
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

# restore_orphaned_backup — wołane raz przy starcie wrappera. Jeśli
# poprzedni run zginął na SIGKILL, zostawia backup + sentinel. Odzyskaj
# przywracając backup gdy PID z sentinel'a jest martwy.
restore_orphaned_backup() {
  [ -f "$AGY_SETTINGS_SENTINEL" ] || {
    # Brak sentinel'a ale backup jakimś cudem został: ostrzeż i usuń. Nie
    # potrafimy określić poprawnego stanu, więc nie auto-restore.
    if [ -f "$AGY_SETTINGS_BACKUP" ]; then
      echo "[wrapper] note: stale backup with no sentinel; removing $AGY_SETTINGS_BACKUP" >&2
      rm -f "$AGY_SETTINGS_BACKUP"
    fi
    return 0
  }
  local pid; pid="$(head -n1 "$AGY_SETTINGS_SENTINEL" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    # Holder dalej żyje — lock nas zserializuje. Nie ruszamy.
    return 0
  fi
  if [ -f "$AGY_SETTINGS_BACKUP" ]; then
    mv "$AGY_SETTINGS_BACKUP" "$AGY_SETTINGS_FILE"
    echo "[wrapper] recovered orphaned settings backup from PID ${pid:-unknown}" >&2
  fi
  rm -f "$AGY_SETTINGS_SENTINEL"
}

# with_settings_lock <fn> [args...] — przenośny lock oparty na mkdir. macOS
# nie ma flock(1), więc mkdir (atomic na każdym POSIX FS o który dbamy).
# Detekcja martwego holdera chroni przed deadlockiem po SIGKILL.
with_settings_lock() {
  local fn="$1"; shift
  local attempt=0
  local max_wait="${AGY_LOCK_WAIT_SECONDS:-600}"   # default 10min
  while ! mkdir "$AGY_SETTINGS_LOCKDIR" 2>/dev/null; do
    local holder_pid_file="${AGY_SETTINGS_LOCKDIR}/pid"
    if [ -f "$holder_pid_file" ]; then
      local holder_pid; holder_pid="$(cat "$holder_pid_file" 2>/dev/null || true)"
      if [ -n "$holder_pid" ] && ! kill -0 "$holder_pid" 2>/dev/null; then
        # Martwy holder — łamiemy lock i retry.
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

# Atomowy JSON write. Preferuje python3 (zawsze obecny na nowoczesnym
# macOS/Linux); fallback do wąskiego sed targetującego tylko single-line
# "model": "..." — taki format produkuje samo `agy`.
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
  mv "$tmp" "$AGY_SETTINGS_FILE"   # atomic na POSIX
}

_restore_settings() {
  if [ -f "$AGY_SETTINGS_BACKUP" ]; then
    mv "$AGY_SETTINGS_BACKUP" "$AGY_SETTINGS_FILE"
  fi
  rm -f "$AGY_SETTINGS_SENTINEL"
}

# Body właściwego patched-runu — wywoływane pod lockiem przez
# with_model_override.
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

# with_model_override <canonical> -- <agy_cmd...> — patchuje settings.json,
# wywołuje agy, restoruje. Separator `--` chroni przed dwuznacznością
# gdyby canonical name kiedykolwiek zaczynał się od `-`.
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

# -----------------------------------------------------------------------------
# Subkomendy
# -----------------------------------------------------------------------------

cmd_ask() {
  local model_alias=""
  # Parsuje tylko leading --model/--model=value. Wszystko inne (włącznie z
  # promptem) przerywa pętlę i zostaje w $@.
  while [ $# -gt 0 ]; do
    case "$1" in
      --model)   model_alias="${2:-}"; shift 2 ;;
      --model=*) model_alias="${1#--model=}"; shift ;;
      --)        shift; break ;;
      *)         break ;;
    esac
  done
  local prompt="${1:-}"
  shift || true
  if [ -z "$prompt" ]; then
    echo "error: ask requires a prompt argument" >&2
    exit 64
  fi
  local path
  path="$(require_ready)"
  if [ -n "$model_alias" ]; then
    local canonical; canonical="$(resolve_model_alias "$model_alias")"
    with_model_override "$canonical" -- "$path" -p "$prompt" "$@"
  else
    "$path" -p "$prompt" "$@"
  fi
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
  # Parsuje --name i --output gdziekolwiek w argumentach; reszta leci do
  # description (user może mieszać kolejność flagi i tekstu).
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

  # Buduje prompt który (a) mówi agy żeby użył wbudowanego generate_image
  # i (b) wymaga marker line, żeby wrapper deterministycznie znalazł
  # zapisaną ścieżkę — niezależnie od gadania modelu.
  local name_clause=""
  if [ -n "$name" ]; then
    name_clause=" Save the image with name \"${name}\"."
  fi
  local prompt
  prompt="Use your built-in generate_image tool to create the following image. Description: ${description}.${name_clause}

After the tool returns, you MUST end your reply with a single line in this exact format (no quotes, no markdown, nothing after it):
IMAGE_PATH: <absolute filesystem path to the saved image>

The IMAGE_PATH line is required — the calling wrapper parses it to locate the file."

  # Capture response — drukowane verbatim, żeby user widział naturalną
  # odpowiedź agy; potem wrapper dokleja własną linię z lokalizacją pliku.
  local response rc
  response="$("$agy_path" -p "$prompt" 2>&1)" || rc=$?
  rc="${rc:-0}"
  printf '%s\n' "$response"

  # 1) Preferuj deterministyczny marker o który prosiliśmy.
  local src
  src="$(printf '%s' "$response" \
    | sed -n 's/^[[:space:]]*IMAGE_PATH:[[:space:]]*//p' \
    | tail -n1)"

  # 2) Fallback: scrapuj jakiekolwiek absolutne /path/.../*.{png,jpg,jpeg,webp}
  #    z odpowiedzi (agy czasem wspomina ścieżkę bez markera).
  if [ -z "$src" ] || [ ! -f "$src" ]; then
    src="$(printf '%s' "$response" \
      | grep -oE '/[^[:space:]]+\.(png|jpg|jpeg|webp)' \
      | head -n1)"
  fi

  if [ -n "$src" ] && [ -f "$src" ]; then
    echo
    echo "[wrapper] generated: $src"
    if [ -n "$output" ]; then
      cp "$src" "$output"
      echo "[wrapper] copied to: $output"
    fi
  else
    echo
    echo "[wrapper] warning: agy did not include an IMAGE_PATH line and no image path was found in its reply." >&2
    echo "[wrapper]          if --output was requested, the copy was skipped." >&2
  fi
  return "$rc"
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

# -----------------------------------------------------------------------------
# Dispatch
# -----------------------------------------------------------------------------

main() {
  # Recovery po ewentualnym SIGKILLowanym poprzednim runie.
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

# Sourcing guard: gdy plik jest źródłowany (np. przez unit testy),
# dispatch jest pomijany, żeby można było wołać poszczególne funkcje
# bezpośrednio. Defensywne `${...:-}` chronią przed `set -u` w trakcie
# sourcing — niektóre shell-e nie inicjalizują BASH_SOURCE przy source.
if [ "${BASH_SOURCE[0]:-}" = "${0:-}" ]; then
  main "$@"
fi
