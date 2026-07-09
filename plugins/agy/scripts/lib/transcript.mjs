// transcript.mjs — FALLBACK capture of an `agy --print` answer by reading
// agy's own on-disk conversation transcript, for older `agy` where non-TTY
// stdout is unusable.
//
// Why this exists
// ---------------
// Older `agy` (< 1.0.15) flushed ZERO bytes to a non-TTY stdout (issue #76):
// the response was generated but the "drip" typewriter only targeted a real
// terminal, so a subprocess capturing stdout got nothing. agy 1.0.15 FIXED
// that, so the plugin now reads stdout directly as the primary path (see the
// capture sites in agy-run.sh / tracked-jobs.mjs / agy-run.ps1) and only
// falls back to this transcript reader when stdout comes back empty.
//
// agy ALWAYS persists the conversation transcript to disk — on every --print
// run, regardless of TTY, with NO tool permission and NO auto-approve. So the
// fallback runs agy strictly read-only and reads the model's answer back from:
//
//   <store>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
//
// The conversation id is printed to the run's own --log-file as the line
// "Created conversation <uuid>", so we recover it race-free (no guessing,
// no newest-by-mtime race against other concurrent agy runs).
//
// Either way the read-only commands (ask / review / adversarial-review) need
// neither a write_file injection nor --dangerously-skip-permissions. Validated
// live on agy 1.1.0 (see SECURITY.md "Read-only capture").

import { promises as fsp, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const UUID_RE =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/**
 * Resolve agy's CLI store directory — the one that contains `brain/`,
 * `conversations/`, and `cache/`. Resolution order:
 *   1. AGY_STORE_DIR        (full path to the antigravity-cli store; tests)
 *   2. GEMINI_DIR           (agy's .gemini override) → <GEMINI_DIR>/antigravity-cli
 *   3. <homedir>/.gemini/antigravity-cli   (the default, all platforms)
 *
 * Uses os.homedir() rather than $HOME: under Git Bash $HOME is an MSYS
 * path (/c/Users/...) that Node's fs cannot resolve on Windows.
 */
export function agyStoreDir(env = process.env, homedir = os.homedir()) {
  if (env.AGY_STORE_DIR) return env.AGY_STORE_DIR;
  if (env.GEMINI_DIR) return path.join(env.GEMINI_DIR, "antigravity-cli");
  return path.join(homedir, ".gemini", "antigravity-cli");
}

/**
 * Recover agy's ACTUAL CLI data directory from its --log-file. On startup
 * agy logs `... CLI app data directory: <path>`, so we read the real
 * location instead of assuming `<homedir>/.gemini/antigravity-cli`. This
 * makes the transcript path correct on every OS (Windows / macOS / Linux /
 * WSL) by construction — wherever agy says it put its data, that's where we
 * look. Returns the last such path (trailing whitespace/CR trimmed), or
 * null if the log didn't reveal it.
 */
export function parseStoreDir(logText) {
  if (!logText) return null;
  const re = /CLI app data directory:\s*(.+)/g;
  let m;
  let last = null;
  while ((m = re.exec(logText)) !== null) last = m[1];
  return last ? last.replace(/[\r\n\s]+$/, "") : null;
}

/**
 * Return the last "Created conversation <uuid>" id from an agy --log-file's
 * text, or null. We take the LAST match: a single --print run logs exactly
 * one such line, but taking the last is safe if agy ever logs more.
 */
export function parseConversationId(logText) {
  if (!logText) return null;
  const re = new RegExp(`Created conversation (${UUID_RE})`, "g");
  let m;
  let last = null;
  while ((m = re.exec(logText)) !== null) last = m[1];
  return last;
}

/**
 * Extract the model's FINAL answer from a transcript.jsonl: concatenate the
 * `content` of MODEL / PLANNER_RESPONSE lines that carry NO tool call.
 *
 * agy narrates intermediate steps ("I will read the file…") as
 * PLANNER_RESPONSE lines that have BOTH `content` AND a `tool_calls` entry —
 * those are thinking-out-loud, not the answer, so we skip any line with a
 * tool call and keep only the terminal response(s). Also skips tool-result
 * lines (type LIST_DIRECTORY / VIEW_FILE / …). Returns "" if none found.
 */
export function extractAnswerFromTranscript(jsonlText) {
  if (!jsonlText) return "";
  const parts = [];
  for (const line of jsonlText.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      continue; // tolerate a partially-flushed trailing line
    }
    const hasToolCall = Array.isArray(o?.tool_calls) && o.tool_calls.length > 0;
    if (
      o &&
      o.source === "MODEL" &&
      o.type === "PLANNER_RESPONSE" &&
      !hasToolCall &&
      typeof o.content === "string" &&
      o.content.trim()
    ) {
      parts.push(o.content.trim());
    }
  }
  return parts.join("\n\n");
}

/** Absolute path to a conversation's transcript.jsonl within a store dir. */
export function transcriptPathFor(storeDir, conversationId) {
  return path.join(
    storeDir,
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
}

/**
 * Fallback id recovery: map a workspace directory → conversation id via
 * <store>/cache/last_conversations.json. Path keys are compared after
 * normalizing separators + case (Windows/macOS filesystems are
 * case-insensitive and agy stores backslash paths).
 */
export async function conversationIdForWorkspace(storeDir, workspaceDir) {
  if (!workspaceDir) return null;
  let obj;
  try {
    obj = JSON.parse(
      await fsp.readFile(
        path.join(storeDir, "cache", "last_conversations.json"),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
  const norm = (p) => String(p).replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  const want = norm(workspaceDir);
  for (const [k, v] of Object.entries(obj)) {
    if (norm(k) === want) return v;
  }
  return null;
}

/**
 * Read the model's answer for a conversation, retrying briefly: the store
 * manager may not have flushed the final transcript line by the instant
 * the agy process exits. Returns { answer, transcriptPath }.
 */
export async function readTranscriptAnswer(storeDir, conversationId, opts = {}) {
  const { retries = 12, delayMs = 125, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } =
    opts;
  if (!conversationId) return { answer: "", transcriptPath: null };
  const file = transcriptPathFor(storeDir, conversationId);
  let text = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      text = await fsp.readFile(file, "utf8");
      const answer = extractAnswerFromTranscript(text);
      if (answer) return { answer, transcriptPath: file };
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    if (attempt < retries) await sleep(delayMs);
  }
  return { answer: extractAnswerFromTranscript(text), transcriptPath: file };
}

/**
 * High-level capture: given the run's --log-file path (and optionally the
 * directory agy was launched from, for the fallback), return the captured
 * answer plus diagnostics. Never throws on a missing file.
 */
export async function captureAnswer({ logFile, cwd, env } = {}) {
  let logText = "";
  if (logFile) {
    try {
      logText = await fsp.readFile(logFile, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  // Prefer agy's OWN reported data dir (cross-platform correct); fall back
  // to the <homedir>/.gemini guess only if the log didn't reveal it.
  const storeDir = parseStoreDir(logText) ?? agyStoreDir(env ?? process.env);
  let conversationId = parseConversationId(logText);
  if (!conversationId && cwd) {
    conversationId = await conversationIdForWorkspace(storeDir, cwd);
  }
  if (!conversationId) {
    return { answer: "", conversationId: null, transcriptPath: null, storeDir };
  }
  const { answer, transcriptPath } = await readTranscriptAnswer(storeDir, conversationId);
  return { answer, conversationId, transcriptPath, storeDir };
}

// ---------------------------------------------------------------------------
// CLI: `node transcript.mjs <logFile> [cwd]`
//
// Used by the Bash wrapper (agy-run.sh) so the node-free synchronous
// commands (/agy:ask, simple /agy:review) can capture output without
// write_file. Prints the recovered answer to stdout and exits 0; exits 3
// (printing nothing) when no answer could be recovered.
// ---------------------------------------------------------------------------
function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const here = fileURLToPath(import.meta.url);
  // Realpath both sides: on macOS /var and /tmp symlink to /private/...,
  // so argv1 (as invoked) and import.meta.url (realpath-resolved by Node)
  // differ and a plain resolve() compare falsely returns false — silently
  // skipping the CLI dispatch (empty output, exit 0). Fall back per side.
  const norm = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return norm(argv1) === norm(here);
}

if (isMainModule()) {
  const [logFile, cwd] = process.argv.slice(2);
  captureAnswer({ logFile, cwd })
    .then(({ answer }) => {
      if (answer && answer.trim()) {
        process.stdout.write(answer.endsWith("\n") ? answer : answer + "\n");
        process.exit(0);
      }
      process.exit(3);
    })
    .catch((err) => {
      process.stderr.write(`transcript: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
