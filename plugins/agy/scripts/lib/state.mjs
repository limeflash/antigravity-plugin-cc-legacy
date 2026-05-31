// state.mjs — on-disk job registry for the stateful slash commands
// (/agy:rescue --background, /agy:status, /agy:result, /agy:cancel).
//
// Layout (all paths relative to the workspace root):
//
//   .agy-plugin/
//   ├── jobs/<id>.json   one record per job; canonical state
//   ├── logs/<id>.log    captured stdout/stderr of the agy run
//   └── runtime/<id>.pid optional, written by the background worker
//
// Records are atomic-written via lib/fs.mjs:writeJson, so a torn
// read is not possible. Listing is best-effort: a job file that
// JSON-parses cleanly is included; one that fails parsing is skipped
// with a warning to stderr (not a fatal error — we don't want one
// corrupt record to break /agy:status).

import path from "node:path";
import { promises as fsp } from "node:fs";
import { randomBytes } from "node:crypto";

import { ensureDir, readJson, writeJson, pathExists, nowIso } from "./fs.mjs";

export const STATE_DIR_NAME = ".agy-plugin";

const VALID_STATUSES = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "canceled",
]);

const VALID_KINDS = new Set([
  "rescue",
  "research",
  "review",
  "adversarial-review",
]);

export function stateDir(workspaceRoot) {
  return path.join(workspaceRoot, STATE_DIR_NAME);
}

export function jobsDir(workspaceRoot) {
  return path.join(stateDir(workspaceRoot), "jobs");
}

export function logsDir(workspaceRoot) {
  return path.join(stateDir(workspaceRoot), "logs");
}

export function runtimeDir(workspaceRoot) {
  return path.join(stateDir(workspaceRoot), "runtime");
}

export function jobRecordPath(workspaceRoot, jobId) {
  return path.join(jobsDir(workspaceRoot), `${jobId}.json`);
}

export function jobLogPath(workspaceRoot, jobId) {
  return path.join(logsDir(workspaceRoot), `${jobId}.log`);
}

export function jobPidPath(workspaceRoot, jobId) {
  return path.join(runtimeDir(workspaceRoot), `${jobId}.pid`);
}

/**
 * Generate a short, human-friendly, randomized job ID.
 * Format: `agy-<8 hex>`. Collisions are vanishingly unlikely (~1 in
 * 4 billion) but we don't depend on uniqueness across machines.
 */
export function generateJobId() {
  return `agy-${randomBytes(4).toString("hex")}`;
}

/**
 * Strict job-id shape check: matches what `generateJobId` produces.
 * Shorter `agy-xxxx` strings are accepted as PREFIXES by resolveJob
 * but are not full ids — keep this strict so the resolver knows to
 * go down the prefix branch instead of doing a direct read.
 */
export function isValidJobId(s) {
  return typeof s === "string" && /^agy-[a-f0-9]{8}$/.test(s);
}

/**
 * Best-effort: add `.agy-plugin/` to the workspace's LOCAL Git exclude
 * (`.git/info/exclude`) so the plugin's job-state dir doesn't clutter the
 * user's `git status`. That file is the idiomatic place for repo-local,
 * uncommitted ignores — it never touches their tracked `.gitignore`. No-op
 * if the workspace isn't a plain git repo (e.g. a worktree whose `.git` is
 * a file), or on any error.
 */
export async function ensureGitExclude(workspaceRoot) {
  try {
    const gitDir = path.join(workspaceRoot, ".git");
    const st = await fsp.stat(gitDir).catch(() => null);
    if (!st || !st.isDirectory()) return;
    const infoDir = path.join(gitDir, "info");
    await ensureDir(infoDir);
    const excludeFile = path.join(infoDir, "exclude");
    let current = "";
    try {
      current = await fsp.readFile(excludeFile, "utf8");
    } catch {
      /* no exclude file yet — we'll create it */
    }
    if (/^\s*\.agy-plugin\/?\s*$/m.test(current)) return; // already excluded
    const sep = current && !current.endsWith("\n") ? "\n" : "";
    await fsp.appendFile(
      excludeFile,
      `${sep}# Added by the agy plugin — local job-state dir (not committed).\n.agy-plugin/\n`,
    );
  } catch {
    /* best-effort: never fail a job over gitignore hygiene */
  }
}

/**
 * Ensure all directories under .agy-plugin/ exist. Cheap to call
 * repeatedly; callers don't have to remember to invoke this first.
 */
export async function ensureStateDirs(workspaceRoot) {
  await ensureDir(jobsDir(workspaceRoot));
  await ensureDir(logsDir(workspaceRoot));
  await ensureDir(runtimeDir(workspaceRoot));
  await ensureGitExclude(workspaceRoot);
}

/**
 * Create a new job record on disk. Caller supplies `kind`, `task`,
 * and any optional metadata. Returns the full record including the
 * generated id, createdAt timestamp, default fields.
 */
export async function createJob(workspaceRoot, partial) {
  if (!VALID_KINDS.has(partial.kind)) {
    throw new Error(`createJob: invalid kind '${partial.kind}'`);
  }
  await ensureStateDirs(workspaceRoot);
  const id = partial.id ?? generateJobId();
  const record = {
    id,
    kind: partial.kind,
    task: partial.task ?? "",
    model: partial.model ?? null,
    workspaceRoot,
    createdAt: nowIso(),
    startedAt: null,
    completedAt: null,
    status: "pending",
    exitCode: null,
    pid: null,
    logFile: path.relative(workspaceRoot, jobLogPath(workspaceRoot, id)),
    args: partial.args ?? [],
    background: !!partial.background,
    meta: partial.meta ?? {},
  };
  await writeJson(jobRecordPath(workspaceRoot, id), record);
  return record;
}

/**
 * Read a job by id. Returns the record, or `null` if no such job.
 * Throws only on I/O errors other than ENOENT, and on parse errors.
 */
export async function readJob(workspaceRoot, jobId) {
  if (!isValidJobId(jobId)) return null;
  const file = jobRecordPath(workspaceRoot, jobId);
  return readJson(file, null);
}

/**
 * Merge-update an existing job. Refuses to write if the record is
 * missing. Returns the merged record.
 */
export async function updateJob(workspaceRoot, jobId, updates) {
  const current = await readJob(workspaceRoot, jobId);
  if (!current) {
    throw new Error(`updateJob: no such job '${jobId}'`);
  }
  if (updates.status && !VALID_STATUSES.has(updates.status)) {
    throw new Error(`updateJob: invalid status '${updates.status}'`);
  }
  const merged = {
    ...current,
    ...updates,
    // Preserve the original id even if the caller passes one.
    id: current.id,
    // Touch lastUpdatedAt every time; consumers can use it as a
    // freshness heuristic without a separate field on each call.
    lastUpdatedAt: nowIso(),
  };
  await writeJson(jobRecordPath(workspaceRoot, jobId), merged);
  return merged;
}

/**
 * List all job records, newest first by `createdAt`. Records that
 * fail to parse are skipped with a stderr warning (not thrown).
 *
 * Pass `{ kind: "rescue" }` to filter, or `{ limit: N }` to cap.
 */
export async function listJobs(workspaceRoot, { kind, limit } = {}) {
  const dir = jobsDir(workspaceRoot);
  if (!(await pathExists(dir))) return [];
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(dir, entry);
    try {
      const rec = await readJson(file, null);
      if (rec) records.push(rec);
    } catch (err) {
      process.stderr.write(`agy-companion: skipping corrupt job ${entry}: ${err.message}\n`);
    }
  }
  records.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const filtered = kind ? records.filter((r) => r.kind === kind) : records;
  return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}

/**
 * Delete a job record and its log. Returns true if anything was
 * removed, false if the job didn't exist. Used by future cleanup
 * commands; not exposed as a slash command yet.
 */
export async function deleteJob(workspaceRoot, jobId) {
  const recPath = jobRecordPath(workspaceRoot, jobId);
  if (!(await pathExists(recPath))) return false;
  try {
    await fsp.rm(recPath);
  } catch { /* ignore */ }
  try {
    await fsp.rm(jobLogPath(workspaceRoot, jobId));
  } catch { /* missing log is fine */ }
  try {
    await fsp.rm(jobPidPath(workspaceRoot, jobId));
  } catch { /* missing pid is fine */ }
  return true;
}
