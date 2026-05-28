// workspace.mjs — figure out where to put per-project state.
//
// The order of preference matches what feels least surprising:
//   1. `CLAUDE_PROJECT_DIR` env var (Claude Code sets this when a
//      slash command runs inside a project).
//   2. Walk up from CWD looking for a `.git/` entry — the repo root.
//   3. CWD as a last resort.
//
// All paths are returned absolute.

import { promises as fsp } from "node:fs";
import path from "node:path";
import process from "node:process";

export async function resolveWorkspaceRoot(opts = {}) {
  const startCwd = opts.cwd ?? process.cwd();
  const envHint = opts.env?.CLAUDE_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR;
  if (envHint) {
    try {
      const abs = path.resolve(envHint);
      const stat = await fsp.stat(abs);
      if (stat.isDirectory()) return abs;
    } catch {
      // Bad env var; fall through.
    }
  }
  const gitRoot = await findGitRoot(startCwd);
  if (gitRoot) return gitRoot;
  return path.resolve(startCwd);
}

async function findGitRoot(start) {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, ".git");
    try {
      await fsp.access(candidate);
      return current;
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
