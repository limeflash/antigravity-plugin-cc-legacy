// agy-companion.mjs — Node.js entry point for the stateful slash
// commands that the Bash wrapper (`agy-run.sh`) can't easily express:
// background jobs, status/result/cancel, branch-base review,
// adversarial review, the optional stop-gate hook.
//
// The Bash wrapper still handles the synchronous, dependency-free
// commands (/agy:ask, /agy:image, /agy:review without --base, etc.).
// This split keeps Node.js OPTIONAL for users who only want quick
// prompts — they don't need to `npm install` anything.
//
// Inspired by openai/codex-plugin-cc; not a direct port (see NOTICE).

import process from "node:process";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseArgs, joinPositional } from "./lib/args.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  runJobWorker,
  startTrackedJob,
  cancelJob,
  waitForJob,
} from "./lib/tracked-jobs.mjs";
import {
  buildStatusSnapshot,
  resolveJob,
  resolveCancelable,
} from "./lib/job-control.mjs";
import { jobLogPath } from "./lib/state.mjs";
import {
  renderStatusList,
  renderJobDetail,
  renderResult,
  renderCancelReport,
} from "./lib/render.mjs";
import { findAgyBinary } from "./lib/agy.mjs";
import { workingTreeDiff, branchDiff } from "./lib/git.mjs";
import { buildReviewPrompt, buildAdversarialPrompt } from "./lib/prompts.mjs";

const VERSION = "0.5.0";

const RESCUE_SCHEMA = {
  boolean: ["background", "wait", "resume", "fresh"],
  value: ["model", "base"],
};

const REVIEW_SCHEMA = {
  boolean: ["background", "wait"],
  value: ["model", "base"],
};

function printUsage(stream = process.stdout) {
  stream.write(
    [
      `agy-companion ${VERSION}`,
      "",
      "Usage:",
      "  node agy-companion.mjs <subcommand> [args...]",
      "",
      "Subcommands:",
      "  rescue [--background] [--wait] [--resume|--fresh] [--model <alias>] <task>",
      "                       Delegate a task to agy. --background returns a job id;",
      "                       --wait blocks until the job ends (or 10 min default).",
      "  status [task-id]     Show a single job, or the recent 10 if id omitted.",
      "  result [task-id]     Print the captured output of a (usually completed) job.",
      "  cancel [task-id]     Send SIGTERM to a running job; SIGKILL after a grace.",
      "  review [--base <ref>] [--background] [--wait] [--model <a>] [focus]",
      "                       Code review of working-tree changes, or branch vs --base.",
      "  adversarial-review [--base <ref>] [--background] [--wait] [--model <a>] [focus]",
      "                       Challenge-mode review: question the design, not just the lines.",
      "  version              Print the companion version as JSON.",
      "  help, -h, --help     Show this message.",
      "",
      "See the README and CHANGELOG for the latest surface.",
      "",
    ].join("\n"),
  );
}

function cmdVersion() {
  process.stdout.write(`${JSON.stringify({ version: VERSION })}\n`);
}

/**
 * Internal: invoked by the detached worker that startTrackedJob
 * spawns. The user never types this. Hidden from `help` output.
 */
async function cmdRunJob(args) {
  const [jobId] = args;
  if (!jobId) {
    process.stderr.write("agy-companion _run-job: missing job id\n");
    process.exit(64);
  }
  const workspaceRoot = process.env.AGY_JOB_WORKSPACE
    ?? await resolveWorkspaceRoot();
  const finalStatus = await runJobWorker(workspaceRoot, jobId);
  process.exit(finalStatus === "completed" || finalStatus === "canceled" ? 0 : 1);
}

/**
 * /agy:rescue handler. Foreground by default; background when
 * `--background` is set. The slash command file calls us, we don't
 * call any subagent — Claude Code's subagent mechanism is for
 * /agy:delegate which is unchanged.
 */
async function cmdRescue(argv) {
  const parsed = parseArgs(argv, RESCUE_SCHEMA);
  if (parsed.errors.length > 0) {
    process.stderr.write(parsed.errors.map((e) => `error: ${e}`).join("\n") + "\n");
    process.exit(64);
  }
  const task = joinPositional(parsed);
  if (!task) {
    process.stderr.write("rescue: task description is required\n");
    process.exit(64);
  }
  const workspaceRoot = await resolveWorkspaceRoot();
  const agyBin = await findAgyBinary();
  if (!agyBin) {
    process.stderr.write(
      "rescue: cannot find the `agy` binary. Run /agy:setup first or install:\n" +
        "  curl -fsSL https://antigravity.google/cli/install.sh | bash\n",
    );
    process.exit(127);
  }

  const background = parsed.flags.background;
  const wait = parsed.flags.wait;
  // Forward unknown flags + values back as agy-native args (e.g.
  // --sandbox, --print-timeout 20m).
  const extra = [...parsed.extra];
  if (parsed.flags.resume) extra.push("--continue");

  const record = await startTrackedJob(workspaceRoot, {
    kind: "rescue",
    task,
    model: parsed.values.model ?? null,
    args: extra,
    background,
    prompt: task,
    agyBin,
  });

  if (!background) {
    // Foreground: run agy synchronously in-process. Pass teeLogFile so
    // the worker both shows output live AND persists it to the job log,
    // so a follow-up /agy:result <id> still works. (No reReadAndPrintLog
    // afterward — that would double-print what the tee already showed.)
    const finalStatus = await runJobWorker(workspaceRoot, record.id, {
      teeLogFile: jobLogPath(workspaceRoot, record.id),
    });
    process.exit(
      finalStatus === "completed" || finalStatus === "canceled" ? 0 : 1,
    );
  }

  // Background path: tell the user the job id (and optionally wait).
  if (wait) {
    process.stdout.write(
      `Started agy job ${record.id} in background. Waiting...\n`,
    );
    const final = await waitForJob(workspaceRoot, record.id, {
      timeoutMs: 600_000,
      pollMs: 750,
    });
    if (!final) {
      process.stderr.write(`Job ${record.id} disappeared while waiting.\n`);
      process.exit(1);
    }
    await reReadAndPrintLog(workspaceRoot, record.id);
    process.stdout.write(`\nJob ${record.id} ended with status: ${final.status}\n`);
    process.exit(final.status === "completed" ? 0 : 1);
  }

  process.stdout.write(
    [
      `Started agy job ${record.id} in background.`,
      `Check progress: /agy:status ${record.id}`,
      `Read output:    /agy:result ${record.id}`,
      `Cancel:         /agy:cancel ${record.id}`,
      "",
    ].join("\n"),
  );
}

/**
 * Shared body for /agy:review and /agy:adversarial-review. The two
 * differ only in (a) the prompt template they pass to agy and (b)
 * the `kind` stored on the job record.
 */
async function runReviewCommand(argv, { adversarial }) {
  const parsed = parseArgs(argv, REVIEW_SCHEMA);
  if (parsed.errors.length > 0) {
    process.stderr.write(parsed.errors.map((e) => `error: ${e}`).join("\n") + "\n");
    process.exit(64);
  }
  const workspaceRoot = await resolveWorkspaceRoot();
  const agyBin = await findAgyBinary();
  if (!agyBin) {
    process.stderr.write(
      `${adversarial ? "adversarial-review" : "review"}: ` +
        "cannot find the `agy` binary. Run /agy:setup first.\n",
    );
    process.exit(127);
  }

  let diffContext;
  try {
    diffContext = parsed.values.base
      ? await branchDiff(workspaceRoot, parsed.values.base)
      : await workingTreeDiff(workspaceRoot);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
  if (!diffContext.diff.trim()) {
    process.stderr.write(
      parsed.values.base
        ? `No diff between this branch and \`${parsed.values.base}\` (merge-base: ${diffContext.mergeBase ?? "?"}). Nothing to review.\n`
        : "No working-tree diff. Stage or make changes first.\n",
    );
    process.exit(1);
  }

  const focus = joinPositional(parsed);
  const prompt = adversarial
    ? buildAdversarialPrompt({ diffContext, focus })
    : buildReviewPrompt({ diffContext, focus });

  const background = parsed.flags.background;
  const wait = parsed.flags.wait;
  const taskSummary = adversarial
    ? `adversarial-review${parsed.values.base ? ` (--base ${parsed.values.base})` : ""}${focus ? `: ${focus}` : ""}`
    : `review${parsed.values.base ? ` (--base ${parsed.values.base})` : ""}${focus ? `: ${focus}` : ""}`;

  const record = await startTrackedJob(workspaceRoot, {
    kind: adversarial ? "adversarial-review" : "review",
    task: taskSummary,
    model: parsed.values.model ?? null,
    args: parsed.extra,
    background,
    prompt,
    agyBin,
  });

  if (!background) {
    const finalStatus = await runJobWorker(workspaceRoot, record.id, {
      teeLogFile: jobLogPath(workspaceRoot, record.id),
    });
    process.exit(finalStatus === "completed" ? 0 : 1);
  }

  if (wait) {
    process.stdout.write(`Started ${taskSummary} job ${record.id}. Waiting...\n`);
    const final = await waitForJob(workspaceRoot, record.id, {
      timeoutMs: 600_000,
      pollMs: 750,
    });
    if (!final) {
      process.stderr.write(`Job ${record.id} disappeared while waiting.\n`);
      process.exit(1);
    }
    await reReadAndPrintLog(workspaceRoot, record.id);
    process.stdout.write(`\nJob ${record.id} ended with status: ${final.status}\n`);
    process.exit(final.status === "completed" ? 0 : 1);
  }

  process.stdout.write(
    [
      `Started ${taskSummary} job ${record.id} in background.`,
      `Check progress: /agy:status ${record.id}`,
      `Read output:    /agy:result ${record.id}`,
      `Cancel:         /agy:cancel ${record.id}`,
      "",
    ].join("\n"),
  );
}

async function cmdReview(argv) {
  return runReviewCommand(argv, { adversarial: false });
}
async function cmdAdversarialReview(argv) {
  return runReviewCommand(argv, { adversarial: true });
}

async function cmdStatus(argv) {
  const workspaceRoot = await resolveWorkspaceRoot();
  const [maybeId] = argv;
  if (!maybeId) {
    const snapshot = await buildStatusSnapshot(workspaceRoot, { limit: 10 });
    process.stdout.write(renderStatusList(snapshot));
    return;
  }
  const r = await resolveJob(workspaceRoot, maybeId);
  if (!r.record) {
    handleResolveFailure(maybeId, r);
    return;
  }
  process.stdout.write(renderJobDetail(r.record));
}

async function cmdResult(argv) {
  const workspaceRoot = await resolveWorkspaceRoot();
  const [maybeId] = argv;
  const r = await resolveJob(workspaceRoot, maybeId ?? "latest");
  if (!r.record) {
    handleResolveFailure(maybeId ?? "(latest)", r);
    return;
  }
  let logContent = "";
  try {
    logContent = await fsp.readFile(
      jobLogPath(workspaceRoot, r.record.id),
      "utf8",
    );
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  process.stdout.write(renderResult(r.record, logContent));
}

async function cmdCancel(argv) {
  const workspaceRoot = await resolveWorkspaceRoot();
  const [maybeId] = argv;
  const r = await resolveCancelable(workspaceRoot, maybeId ?? "latest");
  if (!r.record) {
    handleResolveFailure(maybeId ?? "(latest)", r);
    return;
  }
  const outcome = await cancelJob(workspaceRoot, r.record.id);
  process.stdout.write(renderCancelReport(r.record.id, outcome));
  if (!outcome.canceled) process.exit(1);
}

function handleResolveFailure(id, result) {
  switch (result.reason) {
    case "not-found":
      process.stderr.write(`Job '${id}' not found in this workspace.\n`);
      process.exit(2);
    case "ambiguous":
      process.stderr.write(
        `Job id prefix '${id}' is ambiguous. Candidates:\n  - ` +
          (result.candidates ?? []).join("\n  - ") +
          "\n",
      );
      process.exit(2);
    case "bad-id":
      process.stderr.write(
        `'${id}' is not a job id. Expected the form 'agy-xxxxxxxx' or a prefix of one.\n`,
      );
      process.exit(64);
    case "not-cancelable":
      process.stderr.write(
        `Job '${id}' is already in terminal status (${result.existing?.status ?? "?"}).\n`,
      );
      process.exit(2);
    default:
      process.stderr.write(`Job '${id}': ${result.reason ?? "unknown error"}.\n`);
      process.exit(2);
  }
}

async function reReadAndPrintLog(workspaceRoot, jobId) {
  try {
    const content = await fsp.readFile(jobLogPath(workspaceRoot, jobId), "utf8");
    process.stdout.write(content);
    if (!content.endsWith("\n")) process.stdout.write("\n");
    return content;
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

const HANDLERS = {
  version: cmdVersion,
  help: () => printUsage(),
  "-h": () => printUsage(),
  "--help": () => printUsage(),
  rescue: cmdRescue,
  review: cmdReview,
  "adversarial-review": cmdAdversarialReview,
  status: cmdStatus,
  result: cmdResult,
  cancel: cmdCancel,
  // Hidden internal commands (underscore prefix).
  "_run-job": cmdRunJob,
};

async function main(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand) {
    printUsage(process.stderr);
    process.exit(64);
  }
  const handler = HANDLERS[subcommand];
  if (!handler) {
    process.stderr.write(`agy-companion: unknown subcommand '${subcommand}'\n\n`);
    printUsage(process.stderr);
    process.exit(64);
  }
  await handler(rest);
}

// Only dispatch when invoked directly. When imported (by tests),
// HANDLERS and helpers are reachable without firing main(). The check
// resolves both sides to a filesystem path so symlinks, relative
// `node script.mjs` invocations, and Windows-style paths all agree.
function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const here = fileURLToPath(import.meta.url);
    return path.resolve(argv1) === path.resolve(here);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`agy-companion: fatal: ${err?.stack ?? err}\n`);
    process.exit(70);
  });
}

export {
  main,
  cmdVersion,
  cmdRescue,
  cmdReview,
  cmdAdversarialReview,
  cmdStatus,
  cmdResult,
  cmdCancel,
  HANDLERS,
  VERSION,
  printUsage,
  isMainModule,
};
