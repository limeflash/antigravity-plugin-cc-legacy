import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "../plugins/agy/scripts/lib/workspace.mjs";

let tmpDir;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-ws-"));
});
afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("resolveWorkspaceRoot", () => {
  it("uses CLAUDE_PROJECT_DIR when set and pointing at a real dir", async () => {
    const r = await resolveWorkspaceRoot({
      cwd: os.homedir(),
      env: { CLAUDE_PROJECT_DIR: tmpDir },
    });
    expect(path.resolve(r)).toBe(path.resolve(tmpDir));
  });

  it("ignores CLAUDE_PROJECT_DIR if the directory doesn't exist", async () => {
    const r = await resolveWorkspaceRoot({
      cwd: tmpDir,
      env: { CLAUDE_PROJECT_DIR: path.join(tmpDir, "absent-xyz") },
    });
    // Falls back to git root (not present in tmpDir) → CWD.
    expect(path.resolve(r)).toBe(path.resolve(tmpDir));
  });

  it("walks up to find a .git/ root", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    const deep = path.join(repoRoot, "src", "deep", "deeper");
    await fsp.mkdir(deep, { recursive: true });
    await fsp.mkdir(path.join(repoRoot, ".git"), { recursive: true });

    const r = await resolveWorkspaceRoot({
      cwd: deep,
      env: { CLAUDE_PROJECT_DIR: "" },
    });
    expect(path.resolve(r)).toBe(path.resolve(repoRoot));
  });

  it("falls back to CWD if no git root and no env hint", async () => {
    const r = await resolveWorkspaceRoot({
      cwd: tmpDir,
      env: { CLAUDE_PROJECT_DIR: "" },
    });
    expect(path.resolve(r)).toBe(path.resolve(tmpDir));
  });
});
