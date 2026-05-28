// agy.mjs — Antigravity CLI integration primitives.
//
// What lives here:
//   - findAgyBinary(): locate the `agy` executable on the user's
//     machine, matching the resolution order documented in
//     agy-run.sh (PATH first, then a small set of platform-specific
//     fallback paths).
//   - getAuthStatus(): coarse-grained "are we authed?" probe that
//     does NOT call out to `agy` (so it's cheap to call from
//     /agy:setup).
//
// Kept deliberately small. The companion does not re-implement
// settings.json patching or model resolution — that stays in the
// Bash wrapper for the synchronous commands. For background jobs we
// honor whatever the user has configured globally.

import os from "node:os";
import path from "node:path";
import process from "node:process";
import { binaryAvailable } from "./process.mjs";
import { pathExists } from "./fs.mjs";

/**
 * Return the resolved path to the `agy` binary, or null if it cannot
 * be found. Resolution order:
 *   1. AGY_BIN env var (if it exists on disk)
 *   2. `agy` on PATH (which/where)
 *   3. ${HOME}/.local/bin/agy           (macOS / Linux user install)
 *   4. /opt/antigravity/bin/agy         (Linux system install)
 *   5. /usr/local/bin/agy               (macOS Homebrew install)
 *   6. ${LOCALAPPDATA}/agy/bin/agy.exe  (Windows installer location)
 */
export async function findAgyBinary(envOverride) {
  const env = envOverride ?? process.env;
  if (env.AGY_BIN && await pathExists(env.AGY_BIN)) {
    return env.AGY_BIN;
  }
  if (await binaryAvailable("agy")) {
    return "agy"; // PATH lookup will resolve at spawn time
  }
  const home = env.HOME ?? os.homedir();
  const localAppData = env.LOCALAPPDATA ?? (home ? path.join(home, "AppData", "Local") : null);
  const candidates = [
    home && path.join(home, ".local", "bin", "agy"),
    "/opt/antigravity/bin/agy",
    "/usr/local/bin/agy",
    localAppData && path.join(localAppData, "agy", "bin", "agy.exe"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

/**
 * Coarse auth probe. Mirrors the bash wrapper's auth_status() —
 * if ANTIGRAVITY_API_KEY is set, we assume api-key auth; otherwise
 * we look for the OAuth state dir on disk. Returns one of:
 *   "api-key" | "oauth" | "missing"
 *
 * This is intentionally cheap (no subprocess). It cannot detect a
 * stale / expired token — only that *some* credential material is
 * in place. /agy:setup's real ping confirms it actually works.
 */
export async function getAuthStatus(envOverride) {
  const env = envOverride ?? process.env;
  if (env.ANTIGRAVITY_API_KEY && env.ANTIGRAVITY_API_KEY.length > 0) {
    return "api-key";
  }
  const home = env.HOME ?? os.homedir();
  if (!home) return "missing";
  const oauthDirs = [
    path.join(home, ".config", "antigravity"),
    path.join(home, ".gemini", "antigravity-cli"),
  ];
  for (const dir of oauthDirs) {
    if (await pathExists(dir)) return "oauth";
  }
  return "missing";
}
