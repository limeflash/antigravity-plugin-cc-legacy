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
import { captureAnswer } from "./transcript.mjs";

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
    meta: {
      prompt: partial.prompt,
      agyBin: partial.agyBin ?? null,
      // When set (worktree isolation), agy runs in / writes to this
      // directory instead of the real workspaceRoot. Job state still
      // lives under workspaceRoot.
      executionRoot: partial.executionRoot ?? null,
      // When set (Design A+ review staging), agy runs in this dir, reads
      // the pre-staged diff/files from it, and writes its response there;
      // the repo is never added to --add-dir.
      stageDir: partial.stageDir ?? null,
    },
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

  // Don't clobber a `canceled` status: if /agy:cancel terminated us and
  // already marked the record canceled, our death throes here must not
  // overwrite it back to failed (status race fixed).
  const latest = await readJob(workspaceRoot, jobId);
  if (latest && latest.status === "canceled") {
    sink(`[agy-job ${jobId}] (job was canceled; leaving status=canceled)\n`);
    if (teeStream) await new Promise((resolve) => teeStream.end(resolve));
    return "canceled";
  }

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
 * The default agy invocation strategy. Dispatches by job kind:
 *
 *   - review / adversarial-review (read-only) → runReviewViaTranscript:
 *     run agy under --sandbox with the staged materials in --add-dir, with
 *     NO write_file injection and NO --dangerously-skip-permissions, then
 *     read the answer back from agy's own on-disk transcript
 *     (lib/transcript.mjs). Genuinely read-only — agy's read-only tools
 *     run without approval, and it never gets repo or write access.
 *
 *   - rescue (write-capable) → the write_file path below: agy edits files
 *     for real, so it needs auto-approval (--dangerously-skip-permissions)
 *     and writes its answer to a temp file we read back. Safety comes from
 *     cmdRescue's guards (clean-tree refusal / --isolate worktree), not
 *     from sandboxing.
 *
 * Both paths work around agy issue #76: `agy --print` flushes ZERO bytes
 * to a non-TTY stdout (the response is generated but the "drip" writer
 * only targets a real terminal), and stdin is ignored (=/dev/null) so agy
 * can't hang on a non-TTY stdin. Returns the agy exit code (0 = a usable
 * answer was captured).
 */
// Max bytes for the prompt argv entry. Windows' CreateProcess caps the
// whole command line at 32767 chars; leave generous margin for the exe
// path and the other flags.
const MAX_PROMPT_BYTES = 28000;

/**
 * Assemble body + suffix so the result stays under MAX_PROMPT_BYTES.
 * The suffix (the write_file instruction) is always kept intact; only
 * the body is trimmed, with a visible marker so the model knows context
 * was cut. Exported for unit testing.
 */
export function capPromptForArgv(body, suffix, max = MAX_PROMPT_BYTES) {
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const marker =
    "\n\n[...content truncated to fit the OS command-line length limit; " +
    "some diff/file context was omitted — read files directly if needed...]";
  const budget = max - suffixBytes - Buffer.byteLength(marker, "utf8");
  if (Buffer.byteLength(body, "utf8") <= budget) {
    return body + suffix;
  }
  // Trim by bytes (slice by chars is fine for our mostly-ASCII prompts;
  // re-check and shave if a multibyte char pushed us over).
  let trimmed = body.slice(0, Math.max(0, budget));
  while (Buffer.byteLength(trimmed, "utf8") > budget && trimmed.length > 0) {
    trimmed = trimmed.slice(0, -64);
  }
  return trimmed + marker + suffix;
}

// Repo-location env hints stripped from agy's environment for READ-ONLY runs
// (defense in depth: the repo is never in --add-dir, but don't hand agy a
// pointer to it either). rescue KEEPS them — it legitimately operates on the
// repo. Mirrors agy-run.sh's `env -u …`.
const REPO_ENV_HINTS = ["CLAUDE_PROJECT_DIR", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"];
function readOnlyEnv() {
  const e = { ...process.env };
  for (const k of REPO_ENV_HINTS) delete e[k];
  return e;
}

async function defaultAgyRunner(record, { sink } = {}) {
  const emit = sink ?? ((t) => process.stdout.write(t));
  const { meta } = record;
  const prompt = meta?.prompt;
  if (!prompt) {
    throw new Error("defaultAgyRunner: record has no meta.prompt");
  }
  const agyBin = meta?.agyBin ?? "agy";

  // Read-only review commands capture output from agy's OWN on-disk
  // transcript — no write_file injection, no --dangerously-skip-permissions
  // (see lib/transcript.mjs + runReviewViaTranscript below). agy's read-only
  // tools (list_dir/view_file) run without approval, so it reads the staged
  // materials under --sandbox while never being able to write to the repo.
  // rescue falls through to the write-capable path: it legitimately edits
  // files, so it keeps write_file + --dangerously-skip-permissions, gated by
  // cmdRescue's clean-tree / --isolate guards.
  if (record.kind === "review" || record.kind === "adversarial-review") {
    return runReviewViaTranscript(record, { emit });
  }

  // Design A+ : review commands stage the diff + full files into a
  // stageDir they own and pass it via meta.stageDir. We run agy IN that
  // dir (read diff/files from disk, write response there), --add-dir it,
  // and never touch the repo. For rescue/ask, stageDir is unset and we
  // create our own throwaway outDir for the response.
  const stageDir = meta?.stageDir ?? null;
  const outDir = stageDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), "agy-job-")));
  const outFile = path.join(outDir, "response.md");
  const suffix =
    `\n\n---\n` +
    `OUTPUT INSTRUCTION (required): Use the write_file tool to write your ` +
    `COMPLETE response to this exact path:\n${outFile}\n` +
    `Do NOT print the answer to chat — that path is your only deliverable. ` +
    `After writing the file, stop.`;
  // agy --print takes the whole prompt as a single argv entry, so the
  // total must stay under the OS command-line limit (~32 KB on Windows)
  // or spawn fails with ENAMETOOLONG. Truncate the body if needed while
  // always preserving the write_file suffix (otherwise agy wouldn't know
  // where to put the answer).
  const augmented = capPromptForArgv(prompt, suffix);

  // Where agy actually runs / is allowed to write. Defaults to the
  // workspace; worktree isolation points it at a throwaway copy so the
  // user's real tree is never touched.
  const execRoot = record.meta?.executionRoot ?? record.workspaceRoot;
  const writeCapable = record.kind === "rescue";
  // agy runs in the stage dir (review) or the execRoot (rescue/ask).
  const cwd = stageDir ?? execRoot;
  // Auto-approve ONLY for write-capable kinds (rescue). review/adversarial
  // short-circuit to the transcript path before reaching here, but gate the
  // flag explicitly so a future non-write kind can never silently
  // auto-approve through this path (defense in depth).
  const args = [];
  if (writeCapable) args.push("--dangerously-skip-permissions");
  if (!writeCapable) args.push("--sandbox");
  args.push("--add-dir", outDir);
  // rescue gets repo write access; review/ask never do (the repo is not
  // in --add-dir at all — for review everything it needs is in stageDir).
  if (writeCapable) args.push("--add-dir", execRoot);
  args.push(...(record.args ?? []));
  args.push("--print", augmented);

  const code = await new Promise((resolve) => {
    const child = spawn(agyBin, args, {
      // stdin ignored (=/dev/null) to dodge the non-TTY hang; stdout ignored
      // because this path takes agy's answer from the write_file response, not
      // stdout; stderr piped so real agy errors still surface in the log.
      stdio: ["ignore", "ignore", "pipe"],
      cwd,
      // Read-only kinds (ask) run with repo-location hints stripped; rescue
      // legitimately edits the repo, so it keeps the full environment.
      env: writeCapable ? process.env : readOnlyEnv(),
    });
    child.stderr.on("data", (chunk) => emit(chunk.toString()));
    child.on("error", (err) => {
      emit(`[agy-job ${record.id}] spawn error: ${err.message}\n`);
      resolve(127);
    });
    child.on("close", (c) => resolve(c ?? 0));
  });

  // Read agy's written response and emit it so it lands in the job log.
  // The presence of a non-empty response file is the real success
  // signal — agy's own exit code is unreliable in --print mode (it has
  // been observed to exit non-zero even after writing a complete
  // answer). So we key success on the file, not on `code`.
  let produced = false;
  try {
    const content = await fsp.readFile(outFile, "utf8");
    if (content.length > 0) {
      emit(content.endsWith("\n") ? content : content + "\n");
      produced = true;
    } else {
      emit(`[agy-job ${record.id}] agy wrote an empty response file (issue #76 workaround produced nothing).\n`);
    }
  } catch {
    emit(`[agy-job ${record.id}] agy produced no response file — it may have timed out or declined write_file.\n`);
  } finally {
    // Always clean up the work dir — it's the response temp (rescue/ask)
    // or the review stage dir (meta.stageDir). The worker is the last
    // reader of response.md, so cleaning here also closes the
    // background-review temp leak (the detached worker, not the
    // already-exited parent, removes it). runReviewCommand's own
    // cleanup is then just an idempotent belt-and-suspenders.
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
  // 0 when we got a usable response; otherwise surface agy's code (or 1).
  if (produced) return 0;
  return code === 0 ? 1 : code;
}

/**
 * Read-only capture path for review / adversarial-review.
 *
 * Runs `agy --print` under --sandbox with ONLY the staged materials in
 * --add-dir and NO --dangerously-skip-permissions, then recovers the
 * model's answer from agy's own conversation transcript on disk (see
 * lib/transcript.mjs). This removes both crutches for the read-only
 * commands: no write_file in the prompt, no auto-approve. agy's read-only
 * tools (list_dir/view_file) execute without approval, so it can read the
 * staged diff/files; it cannot write anywhere the repo lives.
 *
 * Returns 0 when a non-empty answer was captured; otherwise agy's exit
 * code (or 1). The captured answer is the success signal, not the exit
 * code (agy's --print code is unreliable — see issue #76).
 */
async function runReviewViaTranscript(record, { emit }) {
  const meta = record.meta ?? {};
  const agyBin = meta.agyBin ?? "agy";
  const prompt = meta.prompt;

  // review always stages to meta.stageDir; tolerate a missing one by
  // making a throwaway dir so the function is still usable standalone.
  const stageDir =
    meta.stageDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), "agy-job-")));
  const logFile = path.join(stageDir, "agy-run.log");

  // --sandbox restricts terminal/shell tools where the OS supports it;
  // --add-dir grants read access to the staged diff/files only (the repo
  // is never added); --log-file lets us recover the conversation id and
  // thus the transcript, race-free.
  const args = ["--sandbox", "--add-dir", stageDir, "--log-file", logFile];
  args.push(...(record.args ?? []));
  args.push("--print", prompt);

  let stdoutBuf = "";
  const code = await new Promise((resolve) => {
    const child = spawn(agyBin, args, {
      // stdin ignored to dodge the non-TTY hang. stdout is captured: agy
      // >= 1.0.15 fixed the #76 bug that swallowed non-TTY stdout, so it's
      // now the fast path (the transcript is the fallback). stderr piped so
      // real agy errors still surface in the log.
      stdio: ["ignore", "pipe", "pipe"],
      cwd: stageDir,
      // Read-only review: strip repo-location hints (defense in depth).
      env: readOnlyEnv(),
    });
    // setEncoding drives the stream's StringDecoder, which buffers a partial
    // multibyte UTF-8 sequence split across chunk boundaries. `chunk.toString()`
    // per-chunk would corrupt such a char (→ U+FFFD) for non-ASCII answers that
    // span more than one read.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdoutBuf += chunk; });
    child.stderr.on("data", (chunk) => emit(chunk.toString()));
    child.on("error", (err) => {
      emit(`[agy-job ${record.id}] spawn error: ${err.message}\n`);
      resolve(127);
    });
    child.on("close", (c) => resolve(c ?? 0));
  });

  let produced = false;
  try {
    // Prefer agy's direct stdout (the #76 fix); fall back to reading agy's
    // own transcript for older agy where non-TTY stdout is still empty.
    let answer = stdoutBuf.trim();
    let conversationId = null;
    if (!answer) {
      ({ answer, conversationId } = await captureAnswer({ logFile, cwd: stageDir }));
    }
    if (answer && answer.trim()) {
      emit(answer.endsWith("\n") ? answer : answer + "\n");
      produced = true;
    } else {
      emit(
        `[agy-job ${record.id}] no answer captured from agy's stdout or transcript ` +
          `(conversationId=${conversationId ?? "?"}). agy may have timed out ` +
          `or been interrupted; see the run log at ${logFile}.\n`,
      );
    }
  } finally {
    // The worker is the last reader of the stage dir, so clean it here —
    // this also closes the background-review temp leak (the detached
    // worker, not the already-returned parent, owns teardown).
    // runReviewCommand's own cleanup is then an idempotent no-op.
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
  if (produced) return 0;
  return code === 0 ? 1 : code;
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
  // A killed worker's finally{} never runs, so the review stage dir would
  // leak. Clean it up best-effort here (it lives under the OS temp dir).
  if (record.meta?.stageDir) {
    await fsp.rm(record.meta.stageDir, { recursive: true, force: true }).catch(() => {});
  }
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
