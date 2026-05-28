// fs.mjs — filesystem helpers. Atomic write, mkdir -p semantics,
// JSON read with safe defaults.
//
// All paths are assumed absolute; callers should resolve relative
// paths against a known root (typically the workspace root from
// workspace.mjs) before passing them in.

import { promises as fsp } from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * Like `mkdir -p`. Returns the same path the caller passed in so it
 * can be chained: `const dir = await ensureDir(path.join(root, "x"))`.
 */
export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Atomic write: write to a tmp file then rename. Avoids the
 * "half-written JSON" race that bites us when two slash commands fight
 * over the same state file.
 *
 * `fsync: true` is the safe default for state.json-style writes; pass
 * `fsync: false` for high-frequency log appends.
 */
export async function writeAtomic(file, data, { fsync = true } = {}) {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`,
  );
  let handle;
  try {
    handle = await fsp.open(tmp, "w", 0o600);
    await handle.writeFile(typeof data === "string" ? data : Buffer.from(data));
    if (fsync) {
      await handle.sync();
    }
  } finally {
    if (handle) await handle.close();
  }
  await fsp.rename(tmp, file);
}

/**
 * Read JSON from `file`. Returns `fallback` if the file doesn't
 * exist; throws on parse error or other I/O errors.
 */
export async function readJson(file, fallback) {
  let raw;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT" && fallback !== undefined) return fallback;
    throw err;
  }
  if (raw.trim() === "" && fallback !== undefined) return fallback;
  return JSON.parse(raw);
}

/**
 * Atomic JSON write with a stable 2-space indent and a trailing
 * newline. Convenient default for human-inspected state files.
 */
export async function writeJson(file, value, opts) {
  const text = JSON.stringify(value, null, 2) + "\n";
  await writeAtomic(file, text, opts);
}

/**
 * Append a line to a log file. Creates the directory and the file as
 * needed. Does NOT fsync per write — logs are best-effort, and we
 * batch instead via the OS page cache.
 */
export async function appendLogLine(file, line) {
  await ensureDir(path.dirname(file));
  const stamped = line.endsWith("\n") ? line : line + "\n";
  await fsp.appendFile(file, stamped);
}

/**
 * Does this path exist on disk? Symlinks resolved.
 */
export async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get an ISO-8601 timestamp suitable for state records. Always UTC,
 * always millisecond precision — comparisons stay lexical-order safe.
 */
export function nowIso() {
  return new Date().toISOString();
}
