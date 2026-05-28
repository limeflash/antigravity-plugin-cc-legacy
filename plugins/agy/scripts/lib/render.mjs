// render.mjs — pure formatting helpers for the companion's stdout.
// Kept pure (no I/O, no globals) so they're trivial to unit-test.

const STATUS_BADGE = {
  pending: "[pending]",
  running: "[running]",
  completed: "[done]",
  failed: "[failed]",
  canceled: "[cancel]",
};

function badge(status) {
  return STATUS_BADGE[status] ?? `[${status}]`;
}

function shortTime(iso) {
  if (!iso) return "—";
  // Drop the date if it's today (UTC); keep H:M:S.
  const d = new Date(iso);
  const now = new Date();
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay =
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate();
  const hms = d.toISOString().slice(11, 19);
  return sameDay ? hms : d.toISOString().slice(0, 19).replace("T", " ");
}

function clip(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * Multi-job table for /agy:status.
 * Returns a string; caller decides where to write it.
 */
export function renderStatusList(records) {
  if (!records || records.length === 0) {
    return "No agy jobs recorded in this workspace yet.\n";
  }
  const lines = [
    "ID            STATUS    KIND               STARTED   TASK",
  ];
  for (const r of records) {
    lines.push(
      [
        r.id.padEnd(13),
        badge(r.status).padEnd(9),
        clip(r.kind ?? "", 17).padEnd(18),
        shortTime(r.startedAt ?? r.createdAt).padEnd(9),
        clip(r.task ?? "", 48),
      ].join(" "),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Single-job detail block for /agy:status <id>.
 */
export function renderJobDetail(record) {
  if (!record) return "Job not found.\n";
  const exit =
    record.exitCode === null || record.exitCode === undefined
      ? "—"
      : String(record.exitCode);
  const lines = [
    `Job:          ${record.id}`,
    `Status:       ${badge(record.status)}`,
    `Kind:         ${record.kind ?? "—"}`,
    `Model:        ${record.model ?? "(default)"}`,
    `Task:         ${clip(record.task ?? "", 200)}`,
    `Created:      ${shortTime(record.createdAt)}`,
    `Started:      ${shortTime(record.startedAt)}`,
    `Completed:    ${shortTime(record.completedAt)}`,
    `Exit code:    ${exit}`,
    `PID:          ${record.pid ?? "—"}`,
    `Log file:     ${record.logFile ?? "—"}`,
    `Workspace:    ${record.workspaceRoot ?? "—"}`,
  ];
  if (record.livenessDowngrade) {
    lines.push("Note:         PID is dead but the record claimed running; treated as failed.");
  }
  return lines.join("\n") + "\n";
}

/**
 * /agy:result output: a header followed by the captured log.
 * Caller passes the log contents (we deliberately don't do I/O here).
 */
export function renderResult(record, logContent) {
  if (!record) return "No job to report on.\n";
  const head = renderJobDetail(record);
  const body =
    typeof logContent === "string" && logContent.length > 0
      ? logContent
      : "(log file is empty or missing)";
  return `${head}\n--- output ---\n${body}${body.endsWith("\n") ? "" : "\n"}`;
}

/**
 * /agy:cancel report — what happened, in one paragraph the user can
 * paste into a ticket.
 */
export function renderCancelReport(jobId, outcome) {
  if (outcome.canceled) {
    const detail = outcome.reason ?? "killed";
    return `Job ${jobId}: canceled (${detail}).\n`;
  }
  switch (outcome.reason) {
    case "not-found":
      return `Job ${jobId}: not found in this workspace.\n`;
    case "not-cancelable":
      return `Job ${jobId}: already finished (status: ${outcome.record?.status ?? "unknown"}); nothing to cancel.\n`;
    default:
      return `Job ${jobId}: not canceled (${outcome.reason ?? "unknown reason"}).\n`;
  }
}
