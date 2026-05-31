import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  generateJobId,
  isValidJobId,
  ensureStateDirs,
  ensureGitExclude,
  createJob,
  readJob,
  updateJob,
  listJobs,
  deleteJob,
  jobLogPath,
  jobPidPath,
  jobRecordPath,
} from "../plugins/agy/scripts/lib/state.mjs";

let workspaceRoot;

beforeEach(async () => {
  workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-state-"));
});
afterEach(async () => {
  await fsp.rm(workspaceRoot, { recursive: true, force: true });
});

describe("ensureGitExclude", () => {
  it("is a no-op (no throw) when the workspace is not a git repo", async () => {
    await ensureGitExclude(workspaceRoot);
    expect(await fsp.readdir(workspaceRoot)).not.toContain(".git");
  });

  it("adds .agy-plugin/ to .git/info/exclude, idempotently", async () => {
    await fsp.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
    await ensureGitExclude(workspaceRoot);
    const exclude = path.join(workspaceRoot, ".git", "info", "exclude");
    const first = await fsp.readFile(exclude, "utf8");
    expect(first).toMatch(/^\.agy-plugin\/$/m);
    await ensureGitExclude(workspaceRoot);
    const second = await fsp.readFile(exclude, "utf8");
    expect((second.match(/^\.agy-plugin\/$/gm) || []).length).toBe(1);
  });
});

describe("generateJobId / isValidJobId", () => {
  it("generates ids matching the expected shape", () => {
    const id = generateJobId();
    expect(id).toMatch(/^agy-[a-f0-9]{8}$/);
    expect(isValidJobId(id)).toBe(true);
  });

  it("rejects non-string and malformed ids", () => {
    expect(isValidJobId(null)).toBe(false);
    expect(isValidJobId(undefined)).toBe(false);
    expect(isValidJobId(123)).toBe(false);
    expect(isValidJobId("")).toBe(false);
    expect(isValidJobId("nope")).toBe(false);
    expect(isValidJobId("agy-")).toBe(false);
    expect(isValidJobId("agy-XYZ12345")).toBe(false);
  });
});

describe("ensureStateDirs", () => {
  it("creates jobs/, logs/, runtime/", async () => {
    await ensureStateDirs(workspaceRoot);
    const dirs = ["jobs", "logs", "runtime"].map((d) =>
      path.join(workspaceRoot, ".agy-plugin", d),
    );
    for (const d of dirs) {
      const s = await fsp.stat(d);
      expect(s.isDirectory()).toBe(true);
    }
  });
});

describe("createJob / readJob / updateJob", () => {
  it("creates a record with sane defaults", async () => {
    const rec = await createJob(workspaceRoot, {
      kind: "rescue",
      task: "investigate the bug",
      model: "opus",
      args: ["--sandbox"],
    });
    expect(rec.id).toMatch(/^agy-/);
    expect(rec.status).toBe("pending");
    expect(rec.kind).toBe("rescue");
    expect(rec.task).toBe("investigate the bug");
    expect(rec.model).toBe("opus");
    expect(rec.args).toEqual(["--sandbox"]);
    expect(rec.exitCode).toBeNull();
    expect(rec.pid).toBeNull();
    expect(rec.workspaceRoot).toBe(workspaceRoot);
  });

  it("rejects invalid kind", async () => {
    await expect(
      createJob(workspaceRoot, { kind: "unknown-kind", task: "x" }),
    ).rejects.toThrow(/invalid kind/);
  });

  it("readJob returns null for missing id", async () => {
    expect(await readJob(workspaceRoot, "agy-deadbeef")).toBeNull();
  });

  it("readJob returns null for invalid id (no I/O)", async () => {
    expect(await readJob(workspaceRoot, "not-an-id")).toBeNull();
  });

  it("updateJob merges fields and touches lastUpdatedAt", async () => {
    const rec = await createJob(workspaceRoot, { kind: "rescue", task: "t" });
    const before = rec.createdAt;
    await new Promise((r) => setTimeout(r, 5));
    const updated = await updateJob(workspaceRoot, rec.id, {
      status: "running",
      pid: 1234,
    });
    expect(updated.status).toBe("running");
    expect(updated.pid).toBe(1234);
    expect(updated.kind).toBe("rescue");
    expect(updated.createdAt).toBe(before);
    expect(updated.lastUpdatedAt).not.toBe(before);
  });

  it("updateJob throws for missing job", async () => {
    await expect(
      updateJob(workspaceRoot, "agy-00000000", { status: "running" }),
    ).rejects.toThrow(/no such job/);
  });

  it("updateJob rejects invalid status", async () => {
    const rec = await createJob(workspaceRoot, { kind: "rescue", task: "t" });
    await expect(
      updateJob(workspaceRoot, rec.id, { status: "weird" }),
    ).rejects.toThrow(/invalid status/);
  });
});

describe("listJobs", () => {
  it("returns [] for a fresh workspace", async () => {
    expect(await listJobs(workspaceRoot)).toEqual([]);
  });

  it("returns newest first", async () => {
    const a = await createJob(workspaceRoot, { kind: "rescue", task: "a" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await createJob(workspaceRoot, { kind: "rescue", task: "b" });
    await new Promise((r) => setTimeout(r, 5));
    const c = await createJob(workspaceRoot, { kind: "research", task: "c" });
    const list = await listJobs(workspaceRoot);
    expect(list.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
  });

  it("filters by kind", async () => {
    await createJob(workspaceRoot, { kind: "rescue", task: "1" });
    const rev = await createJob(workspaceRoot, { kind: "review", task: "2" });
    const list = await listJobs(workspaceRoot, { kind: "review" });
    expect(list.map((r) => r.id)).toEqual([rev.id]);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await createJob(workspaceRoot, { kind: "rescue", task: `t${i}` });
      await new Promise((r) => setTimeout(r, 2));
    }
    const list = await listJobs(workspaceRoot, { limit: 2 });
    expect(list).toHaveLength(2);
  });

  it("skips corrupt records without throwing", async () => {
    const rec = await createJob(workspaceRoot, { kind: "rescue", task: "good" });
    const badPath = path.join(workspaceRoot, ".agy-plugin", "jobs", "agy-broken.json");
    await fsp.writeFile(badPath, "{not json");
    // Should not throw, and should still surface the good record.
    const list = await listJobs(workspaceRoot);
    expect(list.map((r) => r.id)).toContain(rec.id);
    expect(list.find((r) => r.id === "agy-broken")).toBeUndefined();
  });
});

describe("deleteJob", () => {
  it("removes record + log + pid; returns true; idempotent", async () => {
    const rec = await createJob(workspaceRoot, { kind: "rescue", task: "kill me" });
    // Plant a fake log and pid file so we know they're cleaned.
    await fsp.writeFile(jobLogPath(workspaceRoot, rec.id), "log\n");
    await fsp.writeFile(jobPidPath(workspaceRoot, rec.id), "12345\n");

    expect(await deleteJob(workspaceRoot, rec.id)).toBe(true);
    expect(await readJob(workspaceRoot, rec.id)).toBeNull();
    await expect(fsp.access(jobLogPath(workspaceRoot, rec.id))).rejects.toThrow();
    await expect(fsp.access(jobPidPath(workspaceRoot, rec.id))).rejects.toThrow();

    // Second delete is a no-op.
    expect(await deleteJob(workspaceRoot, rec.id)).toBe(false);
  });
});

describe("paths", () => {
  it("are constructed under .agy-plugin/", () => {
    const r = jobRecordPath(workspaceRoot, "agy-abc12345");
    expect(r).toContain(".agy-plugin");
    expect(r.endsWith(".json")).toBe(true);
  });
});
