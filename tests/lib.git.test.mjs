import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  gitRoot,
  currentBranch,
  resolveRef,
  mergeBase,
  workingTreeDiff,
  branchDiff,
  gatherFileContext,
  isGitRepo,
  isWorkingTreeClean,
  changeSummary,
  addWorktree,
  removeWorktree,
  captureWorktreePatch,
} from "../plugins/agy/scripts/lib/git.mjs";

let repo;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${r.status}):\n${r.stderr || r.stdout}`,
    );
  }
  return r.stdout;
}

beforeEach(async () => {
  repo = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-git-"));
  // Initialize a non-interactive repo with a stable identity so commit
  // shas are reproducible-ish.
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  await fsp.writeFile(path.join(repo, "README.md"), "v1\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
});
afterEach(async () => {
  if (repo) await fsp.rm(repo, { recursive: true, force: true });
});

describe("gitRoot", () => {
  it("returns the toplevel for a path inside the repo", async () => {
    const subdir = path.join(repo, "nested");
    await fsp.mkdir(subdir, { recursive: true });
    const found = await gitRoot(subdir);
    // git returns forward slashes on Windows; fsp.realpath returns
    // backslashes. Normalize via path.resolve before comparing.
    expect(path.resolve(found)).toBe(path.resolve(await fsp.realpath(repo)));
  });

  it("returns null when called outside a git repo", async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-not-git-"));
    try {
      expect(await gitRoot(outside)).toBeNull();
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("currentBranch / resolveRef / mergeBase", () => {
  it("currentBranch returns 'main' on a fresh repo", async () => {
    expect(await currentBranch(repo)).toBe("main");
  });

  it("resolveRef returns a 40-char sha for HEAD", async () => {
    const sha = await resolveRef(repo, "HEAD");
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
  });

  it("resolveRef returns null for a bogus ref", async () => {
    expect(await resolveRef(repo, "does-not-exist")).toBeNull();
  });

  it("mergeBase between HEAD and itself is HEAD", async () => {
    const head = await resolveRef(repo, "HEAD");
    expect(await mergeBase(repo, "HEAD", "HEAD")).toBe(head);
  });
});

describe("workingTreeDiff", () => {
  it("returns an empty diff for a clean tree", async () => {
    const ctx = await workingTreeDiff(repo);
    expect(ctx.scope).toBe("working-tree");
    expect(ctx.diff).toBe("");
    expect(ctx.files).toEqual([]);
  });

  it("captures uncommitted changes", async () => {
    await fsp.writeFile(path.join(repo, "README.md"), "v1\nadded line\n");
    const ctx = await workingTreeDiff(repo);
    expect(ctx.scope).toBe("working-tree");
    expect(ctx.diff).toContain("added line");
    expect(ctx.files).toContain("README.md");
  });

  it("throws when called outside a git repo", async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-no-git-"));
    try {
      await expect(workingTreeDiff(outside)).rejects.toThrow(/not in a git repo/);
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("branchDiff", () => {
  it("captures the changes introduced by a feature branch", async () => {
    git(repo, ["checkout", "-q", "-b", "feature"]);
    await fsp.writeFile(path.join(repo, "feature.txt"), "new file\n");
    git(repo, ["add", "feature.txt"]);
    git(repo, ["commit", "-q", "-m", "feat: add feature.txt"]);
    const ctx = await branchDiff(repo, "main");
    expect(ctx.scope).toBe("branch");
    expect(ctx.base).toBe("main");
    expect(ctx.diff).toContain("feature.txt");
    expect(ctx.files).toContain("feature.txt");
    expect(ctx.mergeBase).toMatch(/^[a-f0-9]{40}$/);
  });

  it("throws on a base ref that doesn't resolve", async () => {
    await expect(branchDiff(repo, "nope-branch")).rejects.toThrow(/cannot resolve/);
  });
});

describe("safety helpers (rescue guards + isolation)", () => {
  it("isGitRepo true inside repo, false outside", async () => {
    expect(await isGitRepo(repo)).toBe(true);
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-nogit-"));
    try {
      expect(await isGitRepo(outside)).toBe(false);
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it("isWorkingTreeClean: true on a fresh commit, false after an edit", async () => {
    expect(await isWorkingTreeClean(repo)).toBe(true);
    await fsp.writeFile(path.join(repo, "README.md"), "v1\ndirty\n");
    expect(await isWorkingTreeClean(repo)).toBe(false);
  });

  it("isWorkingTreeClean: false when there's an untracked file", async () => {
    await fsp.writeFile(path.join(repo, "new.txt"), "hi\n");
    expect(await isWorkingTreeClean(repo)).toBe(false);
  });

  it("changeSummary reports edited + untracked files", async () => {
    await fsp.writeFile(path.join(repo, "README.md"), "v1\nchanged\n");
    await fsp.writeFile(path.join(repo, "brand-new.txt"), "x\n");
    const s = await changeSummary(repo);
    expect(s).toContain("README.md");
    expect(s).toMatch(/brand-new\.txt/);
  });

  it("changeSummary on a clean tree says no changes", async () => {
    expect(await changeSummary(repo)).toMatch(/no changes/i);
  });

  it("worktree round-trip: add → edit isolated → capture patch → real tree untouched → remove", async () => {
    const wtParent = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-wt-"));
    const wtDir = path.join(wtParent, "wt");
    try {
      const added = await addWorktree(repo, wtDir);
      expect(added.ok).toBe(true);

      // Edit inside the worktree only.
      await fsp.writeFile(path.join(wtDir, "README.md"), "v1\nfrom-worktree\n");
      await fsp.writeFile(path.join(wtDir, "added-in-wt.txt"), "new\n");

      const { stat, patch } = await captureWorktreePatch(wtDir);
      expect(stat).toContain("README.md");
      expect(patch).toContain("from-worktree");
      expect(patch).toContain("added-in-wt.txt");

      // The REAL repo must be untouched by the worktree edits.
      expect(await fsp.readFile(path.join(repo, "README.md"), "utf8")).toBe("v1\n");
      await expect(fsp.access(path.join(repo, "added-in-wt.txt"))).rejects.toThrow();
    } finally {
      await removeWorktree(repo, wtDir);
      await fsp.rm(wtParent, { recursive: true, force: true });
    }
  });
});

describe("gatherFileContext", () => {
  it("includes small text files, skips large ones", async () => {
    await fsp.writeFile(path.join(repo, "small.js"), "export const a = 1;\n");
    const big = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    await fsp.writeFile(path.join(repo, "big.js"), big + "\n");
    const r = await gatherFileContext(repo, ["small.js", "big.js"], { maxLines: 10 });
    expect(r.included.map((f) => f.path)).toEqual(["small.js"]);
    expect(r.included[0].content).toContain("export const a = 1;");
    expect(r.omitted.find((o) => o.path === "big.js").reason).toMatch(/too large/);
  });

  it("marks missing files as omitted", async () => {
    const r = await gatherFileContext(repo, ["does-not-exist.js"]);
    expect(r.included).toEqual([]);
    expect(r.omitted[0].reason).toMatch(/missing/);
  });

  it("respects the total byte budget", async () => {
    await fsp.writeFile(path.join(repo, "a.txt"), "x".repeat(100) + "\n");
    await fsp.writeFile(path.join(repo, "b.txt"), "y".repeat(100) + "\n");
    const r = await gatherFileContext(repo, ["a.txt", "b.txt"], { budgetBytes: 120 });
    expect(r.included.length).toBe(1);
    // The second file no longer fits — it's rejected by the pre-read
    // size check ("too large (N bytes)") or the post-read budget check.
    const b = r.omitted.find((o) => o.path === "b.txt");
    expect(b).toBeTruthy();
    expect(b.reason).toMatch(/too large|budget/);
  });

  it("skips binary content (NUL byte)", async () => {
    await fsp.writeFile(path.join(repo, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
    const r = await gatherFileContext(repo, ["bin.dat"]);
    expect(r.included).toEqual([]);
    expect(r.omitted[0].reason).toBe("binary");
  });
});

describe("gatherFileContext — safety edges (symlink, pre-read size)", () => {
  it("skips a symlinked path instead of following it", async () => {
    const target = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-tgt-"));
    const secret = path.join(target, "secret.txt");
    await fsp.writeFile(secret, "SENSITIVE\n");
    const link = path.join(repo, "link.txt");
    try {
      await fsp.symlink(secret, link);
    } catch {
      return; // symlink not permitted (e.g. Windows w/o privilege) — skip
    }
    const r = await gatherFileContext(repo, ["link.txt"]);
    expect(r.included).toEqual([]);
    expect(r.omitted[0].reason).toMatch(/symlink/);
    await fsp.rm(target, { recursive: true, force: true });
  });

  it("rejects a too-large file via stat without reading it all", async () => {
    const big = path.join(repo, "big.bin");
    await fsp.writeFile(big, "z".repeat(5000));
    const r = await gatherFileContext(repo, ["big.bin"], { budgetBytes: 1000 });
    expect(r.included).toEqual([]);
    expect(r.omitted[0].reason).toMatch(/too large \(\d+ bytes\)/);
  });
});

describe("gatherFileContext — directory-symlink containment", () => {
  it("skips a file reached through a symlinked directory pointing outside the repo", async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-out-"));
    await fsp.writeFile(path.join(outside, "secret.txt"), "TOPSECRET\n");
    const linkdir = path.join(repo, "linkdir");
    try {
      await fsp.symlink(outside, linkdir, "dir");
    } catch {
      return; // no symlink privilege (Windows) — skip
    }
    const r = await gatherFileContext(repo, ["linkdir/secret.txt"]);
    expect(r.included).toEqual([]);
    expect(r.omitted[0].reason).toMatch(/outside the repo|symlink/);
    await fsp.rm(outside, { recursive: true, force: true });
  });
});

describe("stageReviewMaterials (Design A+)", () => {
  it("writes diff.patch and full file content under files/", async () => {
    const { stageReviewMaterials } = await import("../plugins/agy/scripts/lib/git.mjs");
    await fsp.writeFile(path.join(repo, "a.js"), "export const a = 1;\n");
    await fsp.mkdir(path.join(repo, "sub"), { recursive: true });
    await fsp.writeFile(path.join(repo, "sub", "b.js"), "export const b = 2;\n");
    const stage = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-stage-"));
    try {
      const r = await stageReviewMaterials(stage, repo, ["a.js", "sub/b.js"], "DIFFTEXT");
      expect(r.staged.sort()).toEqual(["a.js", "sub/b.js"]);
      expect(await fsp.readFile(path.join(stage, "diff.patch"), "utf8")).toBe("DIFFTEXT");
      expect(await fsp.readFile(path.join(stage, "files", "a.js"), "utf8")).toContain("const a = 1");
      expect(await fsp.readFile(path.join(stage, "files", "sub", "b.js"), "utf8")).toContain("const b = 2");
    } finally {
      await fsp.rm(stage, { recursive: true, force: true });
    }
  });

  it("skips symlinks, binaries, and missing files (omitted with reasons)", async () => {
    const { stageReviewMaterials } = await import("../plugins/agy/scripts/lib/git.mjs");
    await fsp.writeFile(path.join(repo, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
    const stage = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-stage-"));
    try {
      const r = await stageReviewMaterials(stage, repo, ["bin.dat", "ghost.js"], "d");
      expect(r.staged).toEqual([]);
      const reasons = Object.fromEntries(r.omitted.map((o) => [o.path, o.reason]));
      expect(reasons["bin.dat"]).toBe("binary");
      expect(reasons["ghost.js"]).toMatch(/missing/);
    } finally {
      await fsp.rm(stage, { recursive: true, force: true });
    }
  });

  it("does not follow a symlinked file out of the repo", async () => {
    const { stageReviewMaterials } = await import("../plugins/agy/scripts/lib/git.mjs");
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-out-"));
    await fsp.writeFile(path.join(outside, "secret.txt"), "SECRET\n");
    const link = path.join(repo, "link.txt");
    let madeLink = true;
    try { await fsp.symlink(path.join(outside, "secret.txt"), link); } catch { madeLink = false; }
    const stage = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-stage-"));
    try {
      if (madeLink) {
        const r = await stageReviewMaterials(stage, repo, ["link.txt"], "d");
        expect(r.staged).toEqual([]);
        await expect(fsp.access(path.join(stage, "files", "link.txt"))).rejects.toThrow();
      }
    } finally {
      await fsp.rm(stage, { recursive: true, force: true });
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("stageReviewMaterials — dest path traversal guards", () => {
  it("skips absolute and ..-escaping relpaths instead of writing/crashing", async () => {
    const { stageReviewMaterials } = await import("../plugins/agy/scripts/lib/git.mjs");
    const stage = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-stage-"));
    try {
      const abs = process.platform === "win32" ? "C:/Windows/system32/x.txt" : "/etc/passwd";
      const r = await stageReviewMaterials(stage, repo, [abs, "../../escape.txt"], "d");
      expect(r.staged).toEqual([]);
      const reasons = r.omitted.map((o) => o.reason).join("|");
      expect(reasons).toMatch(/absolute path|escapes stage/);
      // nothing leaked outside the stage dir
      await expect(fsp.access(path.join(stage, "..", "escape.txt"))).rejects.toThrow();
    } finally {
      await fsp.rm(stage, { recursive: true, force: true });
    }
  });
});
