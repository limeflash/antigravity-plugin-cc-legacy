// tracked-jobs.mjs — start, supervise, and tear down background
// agy jobs. The split-of-concerns vs state.mjs is intentional:
// state.mjs is pure I/O on the record; this module owns the process
// lifecycle that produces those records.

import { promises as fsp, createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

import {
  createJob,
  readJob,
  updateJob,
  jobLogPath,
  jobPidPath,
} from "./state.mjs";
import { ensureDir, writeAtomic, nowIso } from "./fs.mjs";
import { processAlive, terminate } from "./process.mjs";

const COMPANION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "agy-companion.mjs",
);

/**
 * Create a job record and (if `background: true`) launch a detached
 * worker that runs `agy --print` and streams its output to the log.
 * Returns the created record (with `pid` populated for background
 * jobs, or `null` for foreground — callers run foreground inline).
 *
 * Required `partial` fields:
 *   - kind, task, prompt (the wrapped prompt to send to agy)
 *
 * Optional:
 *   - model, args (forwarded to agy), background (default true),
 *     agyBin (override the detected agy path).
 */
export async function startTrackedJob(workspaceRoot, partial) {
  const record = await createJob(workspaceRoot, {
    kind: partial.kind,
    task: partial.task,
    model: partial.model,
    args: partial.args ?? [],
    background: partial.background ?? true,
    meta: { prompt: partial.prompt, agyBin: partial.agyBin ?? null },
  });

  if (!partial.background) {
    // Caller wants to run inline; we just return the record and they
    // can invoke runForegroundJob().
    return record;
  }

  const logFile = jobLogPath(workspaceRoot, record.id);
  await ensureDir(path.dirname(logFile));
  // O_APPEND so concurrent stderr/stdout writes from the detached
  // worker stay ordered relative to each other.
  const logFh = await fsp.open(logFile, "a", 0o600);
  try {
    const child = spawn(
      process.execPath,
      [COMPANION_PATH, "_run-job", record.id],
      {
        cwd: workspaceRoot,
        detached: true,
        stdio: ["ignore", logFh.fd, logFh.fd],
        env: { ...process.env, AGY_JOB_WORKSPACE: workspaceRoot },
      },
    );
    child.unref();
    await writeAtomic(jobPidPath(workspaceRoot, record.id), `${child.pid}\n`);
    return await updateJob(workspaceRoot, record.id, {
      status: "running",
      startedAt: nowIso(),
      pid: child.pid,
    });
  } finally {
    await logFh.close();
  }
}

/**
 * Worker entry point. Invoked as `node agy-companion.mjs _run-job <id>`
 * by the detached child started in `startTrackedJob`. Reads the job
 * record, executes the command, updates the record on completion.
 *
 * This function is exported so it can be unit-tested without
 * actually invoking agy — the test passes `runner` to inject a fake.
 */
export async function runJobWorker(workspaceRoot, jobId, opts = {}) {
  const record = await readJob(workspaceRoot, jobId);
  if (!record) {
    throw new Error(`runJobWorker: no such job '${jobId}'`);
  }

  // Output routing. Two contexts call this:
  //   - The detached background worker: its stdout fd is already
  //     redirected to the job log, so writing to process.stdout IS
  //     writing to the log. opts.teeLogFile is unset.
  //   - The foreground caller (cmdRescue without --background): runs
  //     in-process with stdout = the user's terminal. To persist the
  //     output for a later /agy:result, we ALSO open the log file and
  //     tee every write to it. opts.teeLogFile = the log path.
  //
  // Either way, `sink(text)` is the single choke point all output
  // flows through, so the captured log and the live view never drift.
  let teeStream = null;
  if (opts.teeLogFile) {
    await ensureDir(path.dirname(opts.teeLogFile));
    teeStream = createWriteStream(opts.teeLogFile, { flags: "a", mode: 0o600 });
  }
  const sink = (text) => {
    process.stdout.write(text);
    if (teeStream) teeStream.write(text);
  };

  // Mark running + stamp startedAt (foreground records were left
  // pending before this fix; background already set these in
  // startTrackedJob but re-stamping is harmless and merge-safe).
  await updateJob(workspaceRoot, jobId, {
    status: "running",
    startedAt: record.startedAt ?? nowIso(),
  });

  sink(`[agy-job ${jobId}] starting at ${nowIso()}\n`);
  sink(`[agy-job ${jobId}] task: ${record.task}\n`);
  if (record.model) {
    sink(`[agy-job ${jobId}] model: ${record.model}\n`);
  }
  sink(`[agy-job ${jobId}] ---\n`);

  const runner = opts.runner ?? defaultAgyRunner;
  let exitCode = null;
  let failed = false;
  try {
    // Pass the sink so the runner forwards agy's stdout/stderr through
    // the same choke point (tests inject their own runner and may
    // ignore the second arg).
    exitCode = await runner(record, { sink });
  } catch (err) {
    sink(`[agy-job ${jobId}] worker error: ${err?.stack ?? err}\n`);
    failed = true;
  }

  const finalStatus = failed
    ? "failed"
    : exitCode === 0
      ? "completed"
      : "failed";

  await updateJob(workspaceRoot, jobId, {
    status: finalStatus,
    exitCode: exitCode,
    completedAt: nowIso(),
  });
  // Best-effort PID file cleanup so /agy:status doesn't dangle.
  try { await fsp.rm(jobPidPath(workspaceRoot, jobId)); } catch { /* ok */ }
  sink(`[agy-job ${jobId}] ---\n`);
  sink(`[agy-job ${jobId}] done: status=${finalStatus} exitCode=${exitCode}\n`);

  // Flush + close the tee stream before returning so a follow-up
  // /agy:result reads a complete log.
  if (teeStream) {
    await new Promise((resolve) => teeStream.end(resolve));
  }
  return finalStatus;
}

/**
 * The default agy invocation strategy.
 *
 * Works around agy issue #76: `agy --print` flushes ZERO bytes to a
 * non-TTY stdout (the response is generated but the "drip" writer only
 * targets a real terminal). Since the companion always runs agy from a
 * subprocess, capturing stdout returns nothing. Instead we instruct agy
 * in the prompt to write its full answer to a temp file via write_file,
 * then read that file and emit it through `sink` (so it lands in the job
 * log / terminal).
 *
 * write_file needs auto-approval → --dangerously-skip-permissions. Blast
 * radius is scoped:
 *   - stdin is ignored (=/dev/null) so agy can't hang on a non-TTY stdin
 *     (the other half of #76).
 *   - read-only kinds (review / adversarial-review) get --sandbox and
 *     --add-dir ONLY the temp dir — agy can't touch the repo.
 *   - rescue is write-capable by design (it's a delegated coding task),
 *     so it also gets --add-dir <workspaceRoot>. It is NOT sandboxed,
 *     matching the "hand the task to another agent" intent.
 *
 * Returns the agy exit code.
 */
async function defaultAgyRunner(record, { sink } = {}) {
  const emit = sink ?? ((t) => process.stdout.write(t));
  const { meta } = record;
  const prompt = meta?.prompt;
  if (!prompt) {
    throw new Error("defaultAgyRunner: record has no meta.prompt");
  }
  const agyBin = meta?.agyBin ?? "agy";

  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-job-"));
  const outFile = path.join(outDir, "response.md");
  const augmented =
    `${prompt}\n\n---\n` +
    `OUTPUT INSTRUCTION (required): Use the write_file tool to write your ` +
    `COMPLETE response to this exact path:\n${outFile}\n` +
    `Do NOT print the answer to chat — that path is your only deliverable. ` +
    `After writing the file, stop.`;

  const writeCapable = record.kind === "rescue";
  const args = ["--dangerously-skip-permissions"];
  if (!writeCapable) args.push("--sandbox");
  args.push("--add-dir", outDir);
  if (writeCapable) args.push("--add-dir", record.workspaceRoot);
  args.push(...(record.args ?? []));
  args.push("--print", augmented);

  const code = await new Promise((resolve) => {
    const child = spawn(agyBin, args, {
      // stdin ignored (=/dev/null) to dodge the non-TTY hang; stdout
      // ignored because #76 leaves it empty; stderr piped so real agy
      // errors still surface in the log.
      stdio: ["ignore", "ignore", "pipe"],
      cwd: record.workspaceRoot,
    });
    child.stderr.on("data", (chunk) => emit(chunk.toString()));
    child.on("error", (err) => {
      emit(`[agy-job ${record.id}] spawn error: ${err.message}\n`);
      resolve(127);
    });
    child.on("close", (c) => resolve(c ?? 0));
  });

  // Read agy's written response and emit it so it lands in the job log.
  try {
    const content = await fsp.readFile(outFile, "utf8");
    if (content.length > 0) {
      emit(content.endsWith("\n") ? content : content + "\n");
    } else {
      emit(`[agy-job ${record.id}] agy wrote an empty response file (issue #76 workaround produced nothing).\n`);
    }
  } catch {
    emit(`[agy-job ${record.id}] agy produced no response file — it may have timed out or declined write_file.\n`);
  } finally {
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
  return code;
}

/**
 * Cancel a job. Idempotent: returns immediately if the job is already
 * finished. Updates the record to `canceled` on success.
 */
export async function cancelJob(workspaceRoot, jobId, { graceMs = 5000 } = {}) {
  const record = await readJob(workspaceRoot, jobId);
  if (!record) return { canceled: false, reason: "not-found" };
  if (record.status !== "running" && record.status !== "pending") {
    return { canceled: false, reason: "not-cancelable", record };
  }
  if (!record.pid) {
    await updateJob(workspaceRoot, jobId, {
      status: "canceled",
      completedAt: nowIso(),
    });
    return { canceled: true, reason: "no-pid-marking-canceled" };
  }
  const wasAlive = processAlive(record.pid);
  if (wasAlive) {
    await terminate(record.pid, { graceMs });
  }
  await updateJob(workspaceRoot, jobId, {
    status: "canceled",
    completedAt: nowIso(),
    exitCode: null,
  });
  try { await fsp.rm(jobPidPath(workspaceRoot, jobId)); } catch { /* ok */ }
  return { canceled: true, reason: wasAlive ? "killed" : "already-dead" };
}

/**
 * Block until a job reaches a terminal status, or the timeout fires.
 * Returns the final record (with refreshed liveness if applicable).
 * Polls — no fs.watch, since the file rename via writeAtomic doesn't
 * always emit `change` events on every platform.
 */
export async function waitForJob(workspaceRoot, jobId, opts = {}) {
  const { timeoutMs = 600_000, pollMs = 500 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const rec = await readJob(workspaceRoot, jobId);
    if (!rec) return null;
    if (rec.status !== "running" && rec.status !== "pending") {
      return rec;
    }
    // If the record claims running but the PID is dead, give the
    // worker one more poll cycle and then forcibly mark it.
    if (rec.status === "running" && rec.pid && !processAlive(rec.pid)) {
      await new Promise((r) => setTimeout(r, pollMs));
      const rec2 = await readJob(workspaceRoot, jobId);
      if (rec2 && (rec2.status === "running" || rec2.status === "pending")) {
        const updated = await updateJob(workspaceRoot, jobId, {
          status: "failed",
          completedAt: nowIso(),
          meta: { ...rec2.meta, livenessDowngradedBy: "waitForJob" },
        });
        return updated;
      }
      return rec2;
    }
    if (Date.now() >= deadline) {
      return rec; // caller decides what to do with a still-running job.
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
