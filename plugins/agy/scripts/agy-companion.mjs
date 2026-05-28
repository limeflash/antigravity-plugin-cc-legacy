#!/usr/bin/env node
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
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { runJobWorker } from "./lib/tracked-jobs.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VERSION = "0.5.0-dev";

function printUsage(stream = process.stdout) {
  stream.write(
    [
      `agy-companion ${VERSION}`,
      "",
      "Usage:",
      "  node agy-companion.mjs <subcommand> [args...]",
      "",
      "Subcommands (Phase 2 scaffold — most are stubs):",
      "  version              Print the companion version as JSON.",
      "  help, -h, --help     Show this message.",
      "",
      "Planned (not yet implemented):",
      "  rescue [--background] [--wait] [--resume|--fresh] [--model <alias>] <task>",
      "  status [task-id]",
      "  result [task-id]",
      "  cancel [task-id]",
      "  review --base <ref> [--background] [--wait] [focus]",
      "  adversarial-review [--base <ref>] [--background] [--wait] [focus]",
      "",
      "See the README and CHANGELOG for which commands are live.",
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
  // Exit 0 for completed/canceled, non-zero for failed so the parent
  // (if any) can observe success/failure via the OS, separate from
  // the on-disk record.
  process.exit(finalStatus === "completed" || finalStatus === "canceled" ? 0 : 1);
}

const HANDLERS = {
  version: cmdVersion,
  help: () => printUsage(),
  "-h": () => printUsage(),
  "--help": () => printUsage(),
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

export { main, cmdVersion, HANDLERS, VERSION, printUsage, isMainModule };
