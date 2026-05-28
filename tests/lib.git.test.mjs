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
