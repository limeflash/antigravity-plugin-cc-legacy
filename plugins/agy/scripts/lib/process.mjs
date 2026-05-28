// process.mjs — child-process helpers.
//
// `binaryAvailable` and `runCaptured` are synchronous-feel wrappers
// over node:child_process that we use throughout the companion. We
// avoid sync versions so the event loop stays responsive even on
// machines where a probe takes 100ms+.

import { spawn } from "node:child_process";

/**
 * Resolve a binary name (or absolute path) on PATH. Returns a boolean.
 * Uses `which` on POSIX and `where` on Windows. Falls back to a direct
 * file-exists check when the path already looks absolute.
 */
export async function binaryAvailable(nameOrPath) {
  if (!nameOrPath) return false;
  // Already absolute? Just stat it.
  if (nameOrPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(nameOrPath)) {
    try {
      const { promises: fsp } = await import("node:fs");
      await fsp.access(nameOrPath);
      return true;
    } catch {
      return false;
    }
  }
  const lookup = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    const child = spawn(lookup, [nameOrPath], { stdio: "ignore" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/**
 * Run a command and capture stdout/stderr. Returns
 * `{ stdout, stderr, exitCode, signal }`. Never throws on a non-zero
 * exit — callers check `exitCode`.
 *
 * Options:
 *   - cwd: working directory (default: process.cwd())
 *   - env: env overrides (merged with process.env)
 *   - input: string to pipe into stdin
 *   - timeoutMs: kill after this long (returns exitCode null + signal)
 */
export function runCaptured(cmd, args, opts = {}) {
  const { cwd, env, input, timeoutMs } = opts;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let timer = null;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
        // Escalate to SIGKILL if the process ignores SIGTERM.
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }, 2000).unref();
      }, timeoutMs);
      timer.unref?.();
    }
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + `\n[runCaptured spawn error: ${err.message}]\n`,
        exitCode: null,
        signal: null,
        spawnError: true,
        killed,
      });
    });
    child.on("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, signal, killed, spawnError: false });
    });
  });
}

/**
 * Spawn a child completely detached from us — used for background
 * jobs. We redirect stdio to provided file handles so the child can
 * keep running after our process exits.
 *
 * Returns the child's PID. The caller is responsible for unreferring
 * the child if they want to exit immediately.
 */
export function spawnDetached(cmd, args, { cwd, env, stdoutFd, stderrFd, stdinIgnore = true } = {}) {
  const child = spawn(cmd, args, {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    detached: true,
    stdio: [
      stdinIgnore ? "ignore" : "inherit",
      stdoutFd ?? "ignore",
      stderrFd ?? "ignore",
    ],
  });
  child.unref();
  return child.pid;
}

/**
 * Is `pid` still alive? `kill -0`-style probe.
 */
export function processAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = it exists but we can't signal
    // it — still alive from our point of view.
    return err.code === "EPERM";
  }
}

/**
 * Best-effort terminate. Sends SIGTERM, then SIGKILL after `graceMs`.
 * Returns true if the process is gone afterwards.
 */
export async function terminate(pid, { graceMs = 5000 } = {}) {
  if (!processAlive(pid)) return true;
  try { process.kill(pid, "SIGTERM"); } catch { /* race */ }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* race */ }
  await new Promise((r) => setTimeout(r, 200));
  return !processAlive(pid);
}
