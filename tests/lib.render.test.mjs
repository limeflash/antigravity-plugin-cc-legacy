import { describe, it, expect } from "vitest";
import {
  renderStatusList,
  renderJobDetail,
  renderResult,
  renderCancelReport,
} from "../plugins/agy/scripts/lib/render.mjs";

const SAMPLE = {
  id: "agy-3a7b9c12",
  kind: "rescue",
  task: "investigate the flaky integration test",
  model: "opus",
  status: "running",
  createdAt: "2026-05-28T15:00:00.000Z",
  startedAt: "2026-05-28T15:00:01.000Z",
  completedAt: null,
  exitCode: null,
  pid: 12345,
  logFile: ".agy-plugin/logs/agy-3a7b9c12.log",
  workspaceRoot: "/repo",
};

describe("renderStatusList", () => {
  it("returns empty-state message for []", () => {
    expect(renderStatusList([])).toMatch(/no agy jobs/i);
  });

  it("returns a header row plus one line per job", () => {
    const out = renderStatusList([SAMPLE, { ...SAMPLE, id: "agy-abcdef99", status: "completed" }]);
    const lines = out.trim().split("\n");
    expect(lines[0]).toMatch(/ID\s+STATUS\s+KIND/);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("agy-3a7b9c12");
    expect(lines[2]).toContain("agy-abcdef99");
  });

  it("renders status badges", () => {
    const out = renderStatusList([SAMPLE]);
    expect(out).toContain("[running]");
  });

  it("clips long task descriptions", () => {
    const long = { ...SAMPLE, task: "x".repeat(200) };
    const out = renderStatusList([long]);
    expect(out).toContain("…");
  });
});

describe("renderJobDetail", () => {
  it("returns 'not found' when record is null", () => {
    expect(renderJobDetail(null)).toMatch(/not found/i);
  });

  it("shows all the headline fields", () => {
    const out = renderJobDetail(SAMPLE);
    expect(out).toContain("agy-3a7b9c12");
    expect(out).toContain("[running]");
    expect(out).toContain("rescue");
    expect(out).toContain("opus");
    expect(out).toContain("investigate the flaky integration test");
    expect(out).toContain("12345");
    expect(out).toContain(".agy-plugin/logs/agy-3a7b9c12.log");
  });

  it("displays — for null fields", () => {
    const minimal = { ...SAMPLE, model: null, pid: null, completedAt: null, exitCode: null };
    const out = renderJobDetail(minimal);
    expect(out).toMatch(/Model:\s+\(default\)/);
    expect(out).toMatch(/Completed:\s+—/);
    expect(out).toMatch(/Exit code:\s+—/);
    expect(out).toMatch(/PID:\s+—/);
  });

  it("surfaces liveness downgrade note", () => {
    const out = renderJobDetail({ ...SAMPLE, livenessDowngrade: true });
    expect(out).toMatch(/PID is dead/i);
  });
});

describe("renderResult", () => {
  it("returns short message when record is null", () => {
    expect(renderResult(null, "anything")).toMatch(/No job/i);
  });

  it("includes detail header plus the log body", () => {
    const out = renderResult({ ...SAMPLE, status: "completed", exitCode: 0 }, "the agy reply\n");
    expect(out).toContain("agy-3a7b9c12");
    expect(out).toContain("--- output ---");
    expect(out).toContain("the agy reply");
  });

  it("handles empty log", () => {
    const out = renderResult({ ...SAMPLE, status: "completed" }, "");
    expect(out).toContain("(log file is empty");
  });

  it("ensures trailing newline", () => {
    const out = renderResult({ ...SAMPLE, status: "completed" }, "no trailing newline here");
    expect(out.endsWith("\n")).toBe(true);
  });
});

describe("renderCancelReport", () => {
  it("reports a successful cancel", () => {
    const r = renderCancelReport("agy-12345678", { canceled: true, reason: "killed" });
    expect(r).toMatch(/canceled/);
    expect(r).toContain("agy-12345678");
  });

  it("reports not-found", () => {
    const r = renderCancelReport("agy-deadbeef", { canceled: false, reason: "not-found" });
    expect(r).toMatch(/not found/i);
  });

  it("reports not-cancelable with status", () => {
    const r = renderCancelReport("agy-12345678", {
      canceled: false,
      reason: "not-cancelable",
      record: { status: "completed" },
    });
    expect(r).toMatch(/already finished/);
    expect(r).toMatch(/completed/);
  });
});
