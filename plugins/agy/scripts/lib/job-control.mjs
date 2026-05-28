// job-control.mjs — lookup and snapshot helpers built on top of
// state.mjs. Used by /agy:status, /agy:result, /agy:cancel resolvers.

import { listJobs, readJob, isValidJobId } from "./state.mjs";
import { processAlive } from "./process.mjs";

/**
 * Refresh a record's `status` based on the OS view of the PID. If a
 * record says "running" but the PID isn't actually alive, we
 * downgrade to "failed" with `exitCode: null` so /agy:status doesn't
 * lie. The on-disk record is NOT rewritten here — callers can choose
 * to persist via updateJob if they want.
 */
export function liveness(record) {
  if (!record) return record;
  if (record.status === "running" && record.pid && !processAlive(record.pid)) {
    return {
      ...record,
      status: "failed",
      livenessDowngrade: true,
    };
  }
  return record;
}

/**
 * Build a snapshot of recent jobs for `/agy:status` (no specific id).
 * Caller picks the limit; default 10 matches codex-plugin-cc's
 * behavior of showing the most useful recent set.
 */
export async function buildStatusSnapshot(workspaceRoot, { limit = 10, kind } = {}) {
  const jobs = await listJobs(workspaceRoot, { kind, limit });
  return jobs.map(liveness);
}

/**
 * Resolve a job id given user input.
 *   - `"latest"` (or undefined/empty) → most recent job, any kind.
 *   - A full id like `agy-3a7b9c12` → exact match.
 *   - A shorter prefix like `agy-3a7b` → match against any record's
 *     id that starts with the prefix. Ambiguous prefixes return null
 *     with `reason: "ambiguous"`.
 *
 * Returns `{ record, ambiguous: false }` on success, or
 * `{ record: null, reason: "not-found" | "ambiguous" | "bad-id" }`.
 */
export async function resolveJob(workspaceRoot, idOrLatest) {
  const raw = (idOrLatest ?? "").trim();
  if (raw === "" || raw === "latest") {
    const recent = await listJobs(workspaceRoot, { limit: 1 });
    if (recent.length === 0) return { record: null, reason: "not-found" };
    return { record: liveness(recent[0]) };
  }
  if (isValidJobId(raw)) {
    const exact = await readJob(workspaceRoot, raw);
    if (exact) return { record: liveness(exact) };
    return { record: null, reason: "not-found" };
  }
  // Prefix match: look at all jobs.
  if (!/^agy-[a-f0-9]{2,}$/.test(raw)) {
    return { record: null, reason: "bad-id" };
  }
  const all = await listJobs(workspaceRoot);
  const matches = all.filter((j) => j.id.startsWith(raw));
  if (matches.length === 0) return { record: null, reason: "not-found" };
  if (matches.length > 1) {
    return { record: null, reason: "ambiguous", candidates: matches.map((m) => m.id) };
  }
  return { record: liveness(matches[0]) };
}

/**
 * Convenience: resolve and require a cancelable (running) job.
 * Returns `{ record }` or `{ record: null, reason }` where reason is
 * one of the resolveJob reasons plus `"not-cancelable"` if the job
 * exists but isn't running.
 */
export async function resolveCancelable(workspaceRoot, idOrLatest) {
  const r = await resolveJob(workspaceRoot, idOrLatest);
  if (!r.record) return r;
  if (r.record.status !== "running" && r.record.status !== "pending") {
    return { record: null, reason: "not-cancelable", existing: r.record };
  }
  return r;
}
