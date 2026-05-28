import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createJob,
  readJob,
  updateJob,
} from "../plugins/agy/scripts/lib/state.mjs";
import {
  startTrackedJob,
  runJobWorker,
  cancelJob,
  waitForJob,
} from "../plugins/agy/scripts/lib/tracked-jobs.mjs";

let workspaceRoot;

beforeEach(async () => {
  workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-tj-"));
});
afterEach(async () => {
  await fsp.rm(workspaceRoot, { recursive: true, force: true });
});

describe("startTrackedJob (foreground)", () => {
  it("creates a pending record and does not spawn anything", async () => {
    const rec = await startTrackedJob(workspaceRoot, {
      kind: "rescue",
      task: "investigate",
      prompt: "investigate the bug",
      background: false,
    });
    expect(rec.status).toBe("pending");
    expect(rec.pid).toBeNull();
    expect(rec.background).toBe(false);
  });
});

describe("runJobWorker with injected runner", () => {
  it("updates record to completed on exit 0", async () => {
    const rec = await createJob(workspaceRoot, {
      kind: "rescue",
      task: "t",
      meta: { prompt: "do thing" },
    });
    const status = await runJobWorker(workspaceRoot, rec.id, {
      runner: async () => 0,
    });
    expect(status).toBe("completed");
    const after = await readJob(workspaceRoot, rec.id);
    expect(after.status).toBe("completed");
    expect(after.exitCode).toBe(0);
    expect(after.completedAt).toBeTruthy();
  });

  it("updates record to failed on non-zero exit", async () => {
    const rec = await createJob(workspaceRoot, {
      kind: "rescue",
      task: "t",
      meta: { prompt: "do thing" },
    });
    const status = await runJobWorker(workspaceRoot, rec.id, {
      runner: async () => 7,
    });
    expect(status).toBe("failed");
    const after = await readJob(workspaceRoot, rec.id);
    expect(after.exitCode).toBe(7);
  });

  it("updates record to failed when runner throws", async () => {
    const rec = await createJob(workspaceRoot, {
      kind: "rescue",
      task: "t",
      meta: { prompt: "do thing" },
    });
    const status = await runJobWorker(workspaceRoot, rec.id, {
      runner: async () => { throw new Error("boom"); },
    });
    expect(status).toBe("failed");
  });

  it("throws on missing job id", async () => {
    await expect(
      runJobWorker(workspaceRoot, "agy-deadbeef", { runner: async () => 0 }),
    ).rejects.toThrow(/no such job/);
  });
});

describe("cancelJob", () => {
  it("returns not-found for missing job", async () => {
    const r = await cancelJob(workspaceRoot, "agy-deadbeef");
    expect(r.canceled).toBe(false);
    expect(r.reason).toBe("not-found");
  });

  it("returns not-cancelable for a completed job", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "done" });
    await updateJob(workspaceRoot, j.id, { status: "completed" });
    const r = await cancelJob(workspaceRoot, j.id);
    expect(r.canceled).toBe(false);
    expect(r.reason).toBe("not-cancelable");
  });

  it("marks pending job as canceled even with no PID", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "x" });
    const r = await cancelJob(workspaceRoot, j.id);
    expect(r.canceled).toBe(true);
    const after = await readJob(workspaceRoot, j.id);
    expect(after.status).toBe("canceled");
  });

  it("kills a live child and marks canceled", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "live" });
    // Spawn a real long-running child we can kill.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    await updateJob(workspaceRoot, j.id, { status: "running", pid: child.pid });
    const r = await cancelJob(workspaceRoot, j.id, { graceMs: 1000 });
    expect(r.canceled).toBe(true);
    const after = await readJob(workspaceRoot, j.id);
    expect(after.status).toBe("canceled");
  });
});

describe("waitForJob", () => {
  it("returns the record once it reaches a terminal status", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "x" });
    setTimeout(() => {
      updateJob(workspaceRoot, j.id, {
        status: "completed",
        exitCode: 0,
        completedAt: new Date().toISOString(),
      }).catch(() => {});
    }, 200);
    const final = await waitForJob(workspaceRoot, j.id, {
      timeoutMs: 2000,
      pollMs: 50,
    });
    expect(final?.status).toBe("completed");
  });

  it("returns null for missing job", async () => {
    expect(
      await waitForJob(workspaceRoot, "agy-deadbeef", { timeoutMs: 200, pollMs: 50 }),
    ).toBeNull();
  });

  it("returns the still-running record after timeout", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "x" });
    await updateJob(workspaceRoot, j.id, { status: "running", pid: process.pid });
    const r = await waitForJob(workspaceRoot, j.id, { timeoutMs: 300, pollMs: 50 });
    expect(r?.status).toBe("running");
  });
});
