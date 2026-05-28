import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createJob,
  updateJob,
} from "../plugins/agy/scripts/lib/state.mjs";
import {
  liveness,
  buildStatusSnapshot,
  resolveJob,
  resolveCancelable,
} from "../plugins/agy/scripts/lib/job-control.mjs";

let workspaceRoot;

beforeEach(async () => {
  workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-jc-"));
});
afterEach(async () => {
  await fsp.rm(workspaceRoot, { recursive: true, force: true });
});

describe("liveness", () => {
  it("downgrades running+dead-PID to failed", () => {
    const dead = liveness({ status: "running", pid: 99999999 });
    expect(dead.status).toBe("failed");
    expect(dead.livenessDowngrade).toBe(true);
  });

  it("leaves running with a live PID alone (our own PID)", () => {
    const alive = liveness({ status: "running", pid: process.pid });
    expect(alive.status).toBe("running");
    expect(alive.livenessDowngrade).toBeUndefined();
  });

  it("leaves terminal statuses alone", () => {
    for (const s of ["completed", "failed", "canceled", "pending"]) {
      expect(liveness({ status: s, pid: 99999999 }).status).toBe(s);
    }
  });

  it("handles null/undefined records gracefully", () => {
    expect(liveness(null)).toBeNull();
    expect(liveness(undefined)).toBeUndefined();
  });
});

describe("buildStatusSnapshot", () => {
  it("returns recent jobs newest-first with liveness applied", async () => {
    const a = await createJob(workspaceRoot, { kind: "rescue", task: "a" });
    await new Promise((r) => setTimeout(r, 3));
    const b = await createJob(workspaceRoot, { kind: "rescue", task: "b" });
    await updateJob(workspaceRoot, b.id, { status: "running", pid: 99999999 });

    const snap = await buildStatusSnapshot(workspaceRoot, { limit: 5 });
    expect(snap[0].id).toBe(b.id);
    expect(snap[0].status).toBe("failed"); // liveness downgrade
    expect(snap[1].id).toBe(a.id);
    expect(snap[1].status).toBe("pending");
  });

  it("filters by kind", async () => {
    await createJob(workspaceRoot, { kind: "rescue", task: "r1" });
    const rev = await createJob(workspaceRoot, { kind: "review", task: "rv" });
    const snap = await buildStatusSnapshot(workspaceRoot, { kind: "review" });
    expect(snap.map((r) => r.id)).toEqual([rev.id]);
  });
});

describe("resolveJob", () => {
  it("empty input resolves to latest", async () => {
    await createJob(workspaceRoot, { kind: "rescue", task: "old" });
    await new Promise((r) => setTimeout(r, 3));
    const newer = await createJob(workspaceRoot, { kind: "rescue", task: "new" });
    const r = await resolveJob(workspaceRoot, "");
    expect(r.record?.id).toBe(newer.id);
  });

  it("'latest' literal also resolves to latest", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "x" });
    const r = await resolveJob(workspaceRoot, "latest");
    expect(r.record?.id).toBe(j.id);
  });

  it("returns not-found on empty workspace", async () => {
    const r = await resolveJob(workspaceRoot, "");
    expect(r.record).toBeNull();
    expect(r.reason).toBe("not-found");
  });

  it("full id returns exact match", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "x" });
    const r = await resolveJob(workspaceRoot, j.id);
    expect(r.record?.id).toBe(j.id);
  });

  it("returns not-found for valid id that doesn't exist", async () => {
    const r = await resolveJob(workspaceRoot, "agy-deadbeef");
    expect(r.record).toBeNull();
    expect(r.reason).toBe("not-found");
  });

  it("matches unique prefix", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "x" });
    const prefix = j.id.slice(0, 6); // "agy-XX"
    const r = await resolveJob(workspaceRoot, prefix);
    expect(r.record?.id).toBe(j.id);
  });

  it("reports ambiguous prefix", async () => {
    // Force two ids with the same prefix by writing them directly.
    const j1 = await createJob(workspaceRoot, { kind: "rescue", task: "1", id: "agy-aaaa0001" });
    const j2 = await createJob(workspaceRoot, { kind: "rescue", task: "2", id: "agy-aaaa0002" });
    const r = await resolveJob(workspaceRoot, "agy-aaaa");
    expect(r.record).toBeNull();
    expect(r.reason).toBe("ambiguous");
    expect(r.candidates).toEqual(expect.arrayContaining([j1.id, j2.id]));
  });

  it("returns bad-id for unrecognized format", async () => {
    const r = await resolveJob(workspaceRoot, "not-a-job");
    expect(r.record).toBeNull();
    expect(r.reason).toBe("bad-id");
  });
});

describe("resolveCancelable", () => {
  it("rejects completed jobs as not-cancelable", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "done" });
    await updateJob(workspaceRoot, j.id, { status: "completed" });
    const r = await resolveCancelable(workspaceRoot, j.id);
    expect(r.record).toBeNull();
    expect(r.reason).toBe("not-cancelable");
    expect(r.existing?.id).toBe(j.id);
  });

  it("accepts running jobs", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "live" });
    await updateJob(workspaceRoot, j.id, { status: "running", pid: process.pid });
    const r = await resolveCancelable(workspaceRoot, j.id);
    expect(r.record?.id).toBe(j.id);
  });

  it("accepts pending jobs", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "wait" });
    const r = await resolveCancelable(workspaceRoot, j.id);
    expect(r.record?.id).toBe(j.id);
  });
});
