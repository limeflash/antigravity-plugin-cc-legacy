import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  createJob,
  updateJob,
  jobLogPath,
} from "../plugins/agy/scripts/lib/state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.resolve(
  __dirname,
  "..",
  "plugins",
  "agy",
  "scripts",
  "agy-companion.mjs",
);

let workspaceRoot;

beforeEach(async () => {
  workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-cmd-"));
});
afterEach(async () => {
  await fsp.rm(workspaceRoot, { recursive: true, force: true });
});

function runCompanion(args, extraEnv = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: "utf8",
    timeout: 15000,
    cwd: workspaceRoot,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: workspaceRoot,
      // Sandbox HOME / LOCALAPPDATA so the agy discovery doesn't find
      // a real install on a developer's machine.
      HOME: path.join(workspaceRoot, "fake-home"),
      USERPROFILE: path.join(workspaceRoot, "fake-home"),
      LOCALAPPDATA: path.join(workspaceRoot, "fake-home", "AppData", "Local"),
      // Force PATH to a directory with no `agy`.
      PATH: workspaceRoot,
      AGY_BIN: "",
      ...extraEnv,
    },
  });
}

describe("rescue command (no agy installed)", () => {
  it("rejects empty task with exit 64", () => {
    const r = runCompanion(["rescue"]);
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/task description is required/);
  });

  it("rejects --model with no value", () => {
    const r = runCompanion(["rescue", "--model="]);
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/non-empty/);
  });

  it("fails with exit 127 when agy binary is absent", () => {
    const r = runCompanion(["rescue", "investigate", "the", "bug"]);
    expect(r.status).toBe(127);
    expect(r.stderr).toMatch(/cannot find the `agy` binary/);
  });
});

describe("status command", () => {
  it("on an empty workspace prints the no-jobs message", () => {
    const r = runCompanion(["status"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no agy jobs/i);
  });

  it("with planted jobs prints a table", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "planted task" });
    await updateJob(workspaceRoot, j.id, { status: "completed", exitCode: 0 });
    const r = runCompanion(["status"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(j.id);
    expect(r.stdout).toContain("[done]");
    expect(r.stdout).toContain("planted task");
  });

  it("with a job id shows the detail block", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "detail check" });
    const r = runCompanion(["status", j.id]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Job:");
    expect(r.stdout).toContain(j.id);
  });

  it("with a missing id exits 2 and complains to stderr", () => {
    const r = runCompanion(["status", "agy-deadbeef"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not found/);
  });

  it("with an ambiguous prefix exits 2 and lists candidates", async () => {
    const a = await createJob(workspaceRoot, {
      kind: "rescue", task: "a", id: "agy-aaaa0001",
    });
    const b = await createJob(workspaceRoot, {
      kind: "rescue", task: "b", id: "agy-aaaa0002",
    });
    const r = runCompanion(["status", "agy-aaaa"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ambiguous/);
    expect(r.stderr).toContain(a.id);
    expect(r.stderr).toContain(b.id);
  });
});

describe("result command", () => {
  it("with no id reads the latest job's log", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "log this" });
    await updateJob(workspaceRoot, j.id, { status: "completed" });
    await fsp.writeFile(jobLogPath(workspaceRoot, j.id), "captured output line\n");
    const r = runCompanion(["result"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("captured output line");
    expect(r.stdout).toContain(j.id);
  });

  it("reports gracefully when log file is missing", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "no log" });
    await updateJob(workspaceRoot, j.id, { status: "completed" });
    const r = runCompanion(["result", j.id]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/log file is empty/);
  });
});

describe("cancel command", () => {
  it("cancels a pending job (no PID) and marks canceled", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "pending" });
    const r = runCompanion(["cancel", j.id]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/canceled/);
  });

  it("refuses to cancel a completed job", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "done" });
    await updateJob(workspaceRoot, j.id, { status: "completed", exitCode: 0 });
    const r = runCompanion(["cancel", j.id]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/terminal status/);
  });

  it("kills a live PID and marks canceled", async () => {
    const j = await createJob(workspaceRoot, { kind: "rescue", task: "kill me" });
    // Spawn a sleep child we control.
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(()=>{}, 30000)"],
      { stdio: "ignore", detached: true },
    );
    child.unref();
    try {
      await updateJob(workspaceRoot, j.id, { status: "running", pid: child.pid });
      const r = runCompanion(["cancel", j.id]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/canceled/);
    } finally {
      try { process.kill(child.pid, "SIGKILL"); } catch {}
    }
  });
});

describe("help & version still work", () => {
  it("version prints JSON with the current version", () => {
    const r = runCompanion(["version"]);
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(typeof obj.version).toBe("string");
  });
  it("help lists rescue/status/result/cancel", () => {
    const r = runCompanion(["help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/rescue/);
    expect(r.stdout).toMatch(/status/);
    expect(r.stdout).toMatch(/result/);
    expect(r.stdout).toMatch(/cancel/);
  });
});
