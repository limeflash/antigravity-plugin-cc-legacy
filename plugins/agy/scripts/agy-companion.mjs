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
import os from "node:os";
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
import {
  workingTreeDiff,
  branchDiff,
  stageReviewMaterials,
  isGitRepo,
  isWorkingTreeClean,
  changeSummary,
  addWorktree,
  removeWorktree,
  captureWorktreePatch,
} from "./lib/git.mjs";
import { buildReviewPrompt, buildAdversarialPrompt } from "./lib/prompts.mjs";
import { scanDiffForSecrets } from "./lib/secrets.mjs";

const VERSION = "0.6.0";

const RESCUE_SCHEMA = {
  boolean: ["background", "wait", "resume", "fresh", "isolate", "allow-dirty"],
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
      "  rescue [--isolate] [--allow-dirty] [--background] [--wait] [--resume|--fresh] [--model <a>] <task>",
      "                       Delegate a task to agy (it can edit files). --isolate edits a",
      "                       throwaway git worktree and shows a patch (your tree untouched);",
      "                       otherwise it refuses on a dirty tree and prints a diff after.",
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
  const isolate = parsed.flags.isolate;
  const allowDirty = parsed.flags["allow-dirty"];
  // Forward unknown flags + values back as agy-native args (e.g.
  // --sandbox, --print-timeout 20m).
  const extra = [...parsed.extra];
  if (parsed.flags.resume) extra.push("--continue");

  // -------------------------------------------------------------------
  // Worktree isolation: agy edits a throwaway copy of the repo, never
  // the user's real working tree. We then show the diff as a patch the
  // user can apply or discard. Strongest safety mode.
  // -------------------------------------------------------------------
  if (isolate) {
    if (!(await isGitRepo(workspaceRoot))) {
      process.stderr.write(
        "rescue --isolate: requires a git repo (worktree isolation needs git).\n",
      );
      process.exit(1);
    }
    if (background) {
      process.stdout.write(
        "[note] --isolate runs in the foreground so it can show you the patch; ignoring --background.\n",
      );
    }
    const wtParent = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-isolate-"));
    const wtDir = path.join(wtParent, "wt");
    const added = await addWorktree(workspaceRoot, wtDir);
    if (!added.ok) {
      process.stderr.write(`rescue --isolate: could not create worktree: ${added.error}\n`);
      await fsp.rm(wtParent, { recursive: true, force: true }).catch(() => {});
      process.exit(1);
    }
    let finalStatus = "failed";
    try {
      const record = await startTrackedJob(workspaceRoot, {
        kind: "rescue",
        task,
        model: parsed.values.model ?? null,
        args: extra,
        background: false,
        prompt: task,
        agyBin,
        executionRoot: wtDir, // agy runs in / writes to the worktree
      });
      finalStatus = await runJobWorker(workspaceRoot, record.id, {
        teeLogFile: jobLogPath(workspaceRoot, record.id),
      });
      const { stat, patch } = await captureWorktreePatch(wtDir);
      process.stdout.write(
        "\n=== isolated changes (your working tree was NOT touched) ===\n",
      );
      if (stat && patch.trim()) {
        process.stdout.write(stat + "\n");
        const patchDir = path.join(workspaceRoot, ".agy-plugin", "patches");
        await fsp.mkdir(patchDir, { recursive: true });
        const patchFile = path.join(patchDir, `${record.id}.patch`);
        await fsp.writeFile(patchFile, patch);
        const rel = path.relative(workspaceRoot, patchFile) || patchFile;
        process.stdout.write(
          [
            "",
            `Review the patch:  ${rel}`,
            `Apply it:          git apply "${rel}"`,
            `Discard it:        rm "${rel}"   (your tree is already untouched)`,
            "",
          ].join("\n"),
        );
      } else {
        process.stdout.write("(agy made no file changes.)\n");
      }
    } finally {
      await removeWorktree(workspaceRoot, wtDir);
      await fsp.rm(wtParent, { recursive: true, force: true }).catch(() => {});
    }
    process.exit(finalStatus === "completed" ? 0 : 1);
  }

  // -------------------------------------------------------------------
  // Non-isolated: agy edits the real working tree in place. Guard with
  // a clean-tree check so there's always a revertable baseline.
  // -------------------------------------------------------------------
  const inGitRepo = await isGitRepo(workspaceRoot);
  if (inGitRepo) {
    if (!(await isWorkingTreeClean(workspaceRoot)) && !allowDirty) {
      process.stderr.write(
        [
          "rescue: refusing to run on a dirty working tree.",
          "        agy edits files in place with auto-approval, so a clean git",
          "        baseline is your only easy undo. Choose one:",
          "          - commit or stash your changes first, or",
          "          - run with --isolate (agy edits a throwaway worktree, you get a patch), or",
          "          - pass --allow-dirty to override (you accept the risk).",
          "",
        ].join("\n"),
      );
      process.exit(1);
    }
  } else {
    process.stderr.write(
      "[warn] not a git repo — no clean-tree safety net; agy will edit files in place with auto-approval.\n",
    );
  }

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
    // so a follow-up /agy:result <id> still works.
    const finalStatus = await runJobWorker(workspaceRoot, record.id, {
      teeLogFile: jobLogPath(workspaceRoot, record.id),
    });
    if (inGitRepo) {
      process.stdout.write("\n=== changes agy made (review before committing) ===\n");
      process.stdout.write((await changeSummary(workspaceRoot)) + "\n");
    }
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
    if (inGitRepo) {
      process.stdout.write("\n=== changes agy made (review before committing) ===\n");
      process.stdout.write((await changeSummary(workspaceRoot)) + "\n");
    }
    process.stdout.write(`\nJob ${record.id} ended with status: ${final.status}\n`);
    process.exit(final.status === "completed" ? 0 : 1);
  }

  process.stdout.write(
    [
      `Started agy job ${record.id} in background.`,
      `Check progress: /agy:status ${record.id}`,
      `Read output:    /agy:result ${record.id}`,
      `Cancel:         /agy:cancel ${record.id}`,
      `When it finishes, run \`git diff\` to review what agy changed.`,
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

  // Secret-scan guard (parity with the Bash /agy:review): don't ship a
  // diff full of credentials to Gemini. Opt out with
  // AGY_REVIEW_ALLOW_SECRETS=1.
  const secretHits = scanDiffForSecrets(diffContext.diff);
  if (secretHits.length > 0) {
    if (process.env.AGY_REVIEW_ALLOW_SECRETS !== "1") {
      process.stderr.write(
        [
          "error: the diff contains values matching common secret patterns:",
          ...secretHits.map((h) => `  - ${h}`),
          "",
          "Reviewing it would forward those values to Google's Gemini API.",
          "Remove them from the diff, or set AGY_REVIEW_ALLOW_SECRETS=1 to proceed.",
          "",
        ].join("\n"),
      );
      process.exit(65);
    }
    // Override set: proceed, but still warn (parity with the Bash
    // wrapper) so a globally-set env var can't leak credentials silently.
    process.stderr.write(
      [
        "WARNING: diff contains values matching common secret patterns:",
        ...secretHits.map((h) => `  - ${h}`),
        "Proceeding because AGY_REVIEW_ALLOW_SECRETS=1 — those values will be sent to Gemini.",
        "",
      ].join("\n"),
    );
  }

  // Design A+ : stage the full diff + full changed files to a temp dir
  // agy reads from disk. Keeps the argv prompt tiny (no ENAMETOOLONG, no
  // truncation), gives agy whole-file context, and never puts the repo
  // in --add-dir.
  const stageDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-review-"));
  let staged = [];
  let omitted = [];
  try {
    const r = await stageReviewMaterials(
      stageDir,
      diffContext.root ?? workspaceRoot,
      diffContext.files,
      diffContext.diff,
    );
    staged = r.staged;
    omitted = r.omitted;
  } catch (err) {
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    process.stderr.write(`error: could not stage review materials: ${err.message}\n`);
    process.exit(1);
  }

  const focus = joinPositional(parsed);
  const prompt = adversarial
    ? buildAdversarialPrompt({ diffContext, focus, stageDir, staged, omitted })
    : buildReviewPrompt({ diffContext, focus, stageDir, staged, omitted });

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
    stageDir, // agy reads/writes here; repo is never --add-dir'd
  });

  const cleanupStage = async () => {
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  };

  if (!background) {
    const finalStatus = await runJobWorker(workspaceRoot, record.id, {
      teeLogFile: jobLogPath(workspaceRoot, record.id),
    });
    await cleanupStage();
    process.exit(finalStatus === "completed" ? 0 : 1);
  }

  if (wait) {
    process.stdout.write(`Started ${taskSummary} job ${record.id}. Waiting...\n`);
    const final = await waitForJob(workspaceRoot, record.id, {
      timeoutMs: 600_000,
      pollMs: 750,
    });
    if (!final) {
      await cleanupStage();
      process.stderr.write(`Job ${record.id} disappeared while waiting.\n`);
      process.exit(1);
    }
    await reReadAndPrintLog(workspaceRoot, record.id);
    await cleanupStage();
    process.stdout.write(`\nJob ${record.id} ended with status: ${final.status}\n`);
    process.exit(final.status === "completed" ? 0 : 1);
  }

  // Pure --background: the detached worker still needs the stage dir, so
  // we leave it (it lives under the OS temp dir and is cleaned by the OS).
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
