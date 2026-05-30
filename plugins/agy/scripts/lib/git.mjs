// git.mjs — git plumbing for code-review flows.
//
// We deliberately shell out to `git` rather than pull in a JS lib —
// `git` is already a hard dependency of the plugin (the wrapper uses
// it too) and we want to inherit its config/auth/sparse-checkout
// behavior for free.

import path from "node:path";
import { promises as fsp } from "node:fs";
import { runCaptured, binaryAvailable } from "./process.mjs";

// How many context lines to give agy around each diff hunk. The git
// default is 3, which is far too little for review — agy can't see
// imports, early returns, or nearby code and ends up flagging false
// positives ("X not imported", "missing guard") for things that are
// just outside the 3-line window. 25 covers the common cases; override
// with AGY_REVIEW_CONTEXT.
function reviewContextLines() {
  const n = parseInt(process.env.AGY_REVIEW_CONTEXT ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 25;
}

// Full-file-context limits: include the complete current content of a
// changed file when it's small enough that agy benefits from seeing
// the whole structure, capped so a big changeset can't blow up the
// prompt.
const FULL_FILE_MAX_LINES = 400;
const FULL_FILE_TOTAL_BUDGET_BYTES = 64 * 1024;

/** Throws if `git` isn't on PATH. */
export async function ensureGitAvailable() {
  if (!(await binaryAvailable("git"))) {
    throw new Error("git not found on PATH. /agy:review requires git.");
  }
}

/**
 * Resolve the working-tree root of the repo containing `cwd`. Returns
 * null when `cwd` isn't inside a git repo.
 */
export async function gitRoot(cwd) {
  const r = await runCaptured("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { cwd });
  if (r.exitCode !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * Read the current branch name. Returns the literal "HEAD" when
 * detached; callers can decide how to render that.
 */
export async function currentBranch(cwd) {
  const r = await runCaptured("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  if (r.exitCode !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * Resolve a ref (branch, tag, sha, or `HEAD~N`) to a full commit
 * sha. Returns null on lookup failure.
 */
export async function resolveRef(cwd, ref) {
  const r = await runCaptured("git", ["-C", cwd, "rev-parse", "--verify", ref], { cwd });
  if (r.exitCode !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * Find the merge-base between two refs. Used by the branch-review
 * flow so the diff is "what this branch added" not "all the unrelated
 * changes on main since I branched".
 */
export async function mergeBase(cwd, a, b) {
  const r = await runCaptured("git", ["-C", cwd, "merge-base", a, b], { cwd });
  if (r.exitCode !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * Capture the diff for working-tree review:
 *   - staged + unstaged changes (`git diff HEAD`)
 *   - if that's empty (clean working tree), fall back to `git diff`
 *     against the index alone — useful right after `git add` but
 *     before any uncommitted edits.
 *
 * Returns an object with `{ scope, base, head, diff, files }`.
 */
export async function workingTreeDiff(cwd) {
  await ensureGitAvailable();
  const root = await gitRoot(cwd);
  if (!root) throw new Error(`not in a git repo: ${cwd}`);
  const U = `-U${reviewContextLines()}`;
  let diff = (await runCaptured("git", ["-C", root, "diff", U, "HEAD"], { cwd: root })).stdout;
  if (!diff.trim()) {
    diff = (await runCaptured("git", ["-C", root, "diff", U], { cwd: root })).stdout;
  }
  const files = await diffFiles(root, ["HEAD"]);
  return {
    scope: "working-tree",
    base: "HEAD",
    head: "(uncommitted)",
    diff,
    files,
    root,
  };
}

/**
 * Branch-vs-base diff: the changes this branch introduced on top of
 * `baseRef`. Computed against the merge-base of HEAD and baseRef so
 * we don't include unrelated changes that happened on baseRef in
 * the meantime.
 */
export async function branchDiff(cwd, baseRef) {
  await ensureGitAvailable();
  const root = await gitRoot(cwd);
  if (!root) throw new Error(`not in a git repo: ${cwd}`);
  const baseSha = await resolveRef(root, baseRef);
  if (!baseSha) {
    throw new Error(`cannot resolve --base ref '${baseRef}' to a commit`);
  }
  const headSha = await resolveRef(root, "HEAD");
  if (!headSha) throw new Error("HEAD is missing or detached and unresolvable");
  const mb = await mergeBase(root, baseSha, headSha);
  const compareBase = mb ?? baseSha;
  const U = `-U${reviewContextLines()}`;
  const diff = (await runCaptured("git", ["-C", root, "diff", U, `${compareBase}...HEAD`], { cwd: root })).stdout;
  const files = await diffFiles(root, [`${compareBase}...HEAD`]);
  return {
    scope: "branch",
    base: baseRef,
    baseSha,
    head: headSha,
    mergeBase: compareBase,
    diff,
    files,
    root,
  };
}

/**
 * Read the full current content of changed files so agy sees whole
 * structure (imports, early returns, neighbouring code) rather than
 * just diff hunks — the #1 source of review false positives.
 *
 * Skips files that are missing/deleted, larger than
 * FULL_FILE_MAX_LINES, or that would push the cumulative size past
 * FULL_FILE_TOTAL_BUDGET_BYTES. Binary-ish content is skipped (NUL
 * byte heuristic). Returns { included: [{path, content}], omitted:
 * [{path, reason}] }.
 */
export async function gatherFileContext(root, files, opts = {}) {
  const maxLines = opts.maxLines ?? FULL_FILE_MAX_LINES;
  const budget = opts.budgetBytes ?? FULL_FILE_TOTAL_BUDGET_BYTES;
  const included = [];
  const omitted = [];
  let used = 0;
  for (const rel of files ?? []) {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    let content;
    try {
      content = await fsp.readFile(abs, "utf8");
    } catch {
      omitted.push({ path: rel, reason: "missing/deleted" });
      continue;
    }
    if (content.includes("\0")) {
      omitted.push({ path: rel, reason: "binary" });
      continue;
    }
    const lineCount = content.split("\n").length;
    if (lineCount > maxLines) {
      omitted.push({ path: rel, reason: `too large (${lineCount} lines)` });
      continue;
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (used + bytes > budget) {
      omitted.push({ path: rel, reason: "budget exceeded" });
      continue;
    }
    used += bytes;
    included.push({ path: rel, content });
  }
  return { included, omitted };
}

/**
 * List the file paths touched by a diff range. Internal helper for
 * the review prompt builder.
 */
async function diffFiles(root, rangeArgs) {
  const r = await runCaptured(
    "git",
    ["-C", root, "diff", "--name-only", ...rangeArgs],
    { cwd: root },
  );
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// --------------------------------------------------------------------------
// Safety helpers for /agy:rescue (clean-tree guard + worktree isolation).
// --------------------------------------------------------------------------

/** True if `cwd` is inside a git repo. */
export async function isGitRepo(cwd) {
  return (await gitRoot(cwd)) !== null;
}

/**
 * True if the working tree has no uncommitted changes (staged,
 * unstaged, or untracked). Used to guarantee a clean revert point
 * before a non-isolated rescue edits files in place.
 */
export async function isWorkingTreeClean(cwd) {
  const r = await runCaptured("git", ["-C", cwd, "status", "--porcelain"], { cwd });
  if (r.exitCode !== 0) return false;
  return r.stdout.trim() === "";
}

/**
 * `git diff --stat HEAD` + untracked file list, for the post-rescue
 * "here's what agy changed" summary. Returns a printable string.
 */
export async function changeSummary(cwd) {
  const stat = await runCaptured("git", ["-C", cwd, "diff", "--stat", "HEAD"], { cwd });
  const untracked = await runCaptured(
    "git",
    ["-C", cwd, "ls-files", "--others", "--exclude-standard"],
    { cwd },
  );
  const lines = [];
  const statText = (stat.stdout || "").trim();
  if (statText) lines.push(statText);
  const newFiles = (untracked.stdout || "")
    .split("\n").map((s) => s.trim()).filter(Boolean);
  if (newFiles.length) {
    lines.push("new (untracked) files:");
    lines.push(...newFiles.map((f) => `  + ${f}`));
  }
  return lines.length ? lines.join("\n") : "(no changes detected)";
}

/**
 * Create a detached worktree of `repoRoot` at HEAD under `dir`.
 * Returns true on success. The worktree shares .git but has its own
 * working directory, so an agent can edit it freely without touching
 * the user's real working tree.
 */
export async function addWorktree(repoRoot, dir) {
  const r = await runCaptured(
    "git",
    ["-C", repoRoot, "worktree", "add", "--detach", dir, "HEAD"],
    { cwd: repoRoot },
  );
  return r.exitCode === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() || r.stdout.trim() };
}

/** Remove a worktree created by addWorktree. Best-effort. */
export async function removeWorktree(repoRoot, dir) {
  await runCaptured("git", ["-C", repoRoot, "worktree", "remove", "--force", dir], { cwd: repoRoot });
}

/**
 * After an isolated rescue, capture everything the agent changed in
 * the worktree as a single patch (tracked edits + new files), plus a
 * --stat summary. Stages all changes first so untracked files are
 * included in the diff. Returns { stat, patch } (both strings).
 */
export async function captureWorktreePatch(worktreeDir) {
  await runCaptured("git", ["-C", worktreeDir, "add", "-A"], { cwd: worktreeDir });
  const stat = await runCaptured(
    "git", ["-C", worktreeDir, "diff", "--cached", "--stat", "HEAD"], { cwd: worktreeDir },
  );
  const patch = await runCaptured(
    "git", ["-C", worktreeDir, "diff", "--cached", "HEAD"], { cwd: worktreeDir },
  );
  return { stat: (stat.stdout || "").trim(), patch: patch.stdout || "" };
}
