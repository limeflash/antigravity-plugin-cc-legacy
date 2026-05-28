import { describe, it, expect } from "vitest";
import process from "node:process";
import {
  binaryAvailable,
  runCaptured,
  processAlive,
  terminate,
  spawnDetached,
} from "../plugins/agy/scripts/lib/process.mjs";

const isWindows = process.platform === "win32";

// Use `node -e <code>` everywhere so the tests are uniform across
// macOS, Linux, and Windows — sh vs cmd semantics keep biting us
// otherwise.
function nodeEval(code) {
  return [process.execPath, ["-e", code]];
}

describe("binaryAvailable", () => {
  it("finds a known binary on PATH", async () => {
    // `node` is guaranteed since this test runs under node.
    expect(await binaryAvailable("node")).toBe(true);
  });

  it("returns false for a definitely-missing binary", async () => {
    expect(await binaryAvailable("definitely-not-a-real-binary-zzz-xxx")).toBe(false);
  });

  it("returns false for empty input", async () => {
    expect(await binaryAvailable("")).toBe(false);
    expect(await binaryAvailable(null)).toBe(false);
  });
});

describe("runCaptured", () => {
  it("captures stdout", async () => {
    const [cmd, args] = nodeEval("process.stdout.write('hello\\n')");
    const r = await runCaptured(cmd, args);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hello\n");
  });

  it("captures stderr separately from stdout", async () => {
    const [cmd, args] = nodeEval(
      "process.stdout.write('out\\n'); process.stderr.write('err\\n')",
    );
    const r = await runCaptured(cmd, args);
    expect(r.stdout).toContain("out");
    expect(r.stderr).toContain("err");
  });

  it("returns non-zero exit code without throwing", async () => {
    const [cmd, args] = nodeEval("process.exit(7)");
    const r = await runCaptured(cmd, args);
    expect(r.exitCode).toBe(7);
  });

  it("pipes stdin via `input`", async () => {
    const [cmd, args] = nodeEval(
      "process.stdin.on('data', c => process.stdout.write(c))",
    );
    const r = await runCaptured(cmd, args, { input: "ping\npong\n" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("ping\npong\n");
  });

  it("honors timeoutMs (kills a long-running child)", async () => {
    const start = Date.now();
    // 30-second sleep that we expect to be killed at 500ms.
    const [cmd, args] = nodeEval("setTimeout(() => {}, 30000)");
    const r = await runCaptured(cmd, args, { timeoutMs: 500 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(4000);
    expect(r.killed).toBe(true);
  }, 8000);

  it("reports spawnError when the binary doesn't exist", async () => {
    const r = await runCaptured("definitely-not-a-real-binary-zzz", []);
    expect(r.spawnError).toBe(true);
    expect(r.exitCode).toBeNull();
  });
});

describe("processAlive / terminate / spawnDetached", () => {
  it("processAlive is true for self, false for tiny invalid PIDs", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(0)).toBe(false);
    expect(processAlive(-1)).toBe(false);
  });

  it("spawnDetached returns a PID and the child is alive briefly", async () => {
    if (isWindows) return; // detached semantics differ on Windows
    const pid = spawnDetached(process.execPath, ["-e", "setTimeout(()=>{}, 5000)"], {
      stdinIgnore: true,
    });
    expect(typeof pid).toBe("number");
    expect(pid).toBeGreaterThan(0);
    // Give the OS a moment to actually start the process.
    await new Promise((r) => setTimeout(r, 200));
    expect(processAlive(pid)).toBe(true);
    const gone = await terminate(pid, { graceMs: 1000 });
    expect(gone).toBe(true);
  });

  it("terminate returns true for an already-dead pid", async () => {
    expect(await terminate(99999999)).toBe(true);
  });
});
