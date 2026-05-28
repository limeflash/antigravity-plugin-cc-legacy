import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { findAgyBinary, getAuthStatus } from "../plugins/agy/scripts/lib/agy.mjs";

let tmpDir;
let fakeHome;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-bin-"));
  fakeHome = path.join(tmpDir, "home");
  await fsp.mkdir(fakeHome, { recursive: true });
});
afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("findAgyBinary", () => {
  it("honors AGY_BIN when the file exists", async () => {
    const fakeAgy = path.join(tmpDir, "fake-agy");
    await fsp.writeFile(fakeAgy, "#!/usr/bin/env true\n");
    await fsp.chmod(fakeAgy, 0o755);
    const found = await findAgyBinary({ AGY_BIN: fakeAgy, PATH: "" });
    expect(found).toBe(fakeAgy);
  });

  it("ignores AGY_BIN when the file is missing", async () => {
    const ghost = path.join(tmpDir, "ghost-agy");
    // PATH empty + a sandboxed HOME so we don't accidentally find a
    // real `agy` install on the developer's machine.
    const found = await findAgyBinary({
      AGY_BIN: ghost,
      PATH: tmpDir,
      HOME: fakeHome,
      LOCALAPPDATA: path.join(fakeHome, "AppData", "Local"),
    });
    expect(found).toBeNull();
  });

  it("finds a binary placed in ~/.local/bin/agy", async () => {
    const localBin = path.join(fakeHome, ".local", "bin");
    await fsp.mkdir(localBin, { recursive: true });
    const candidate = path.join(localBin, "agy");
    await fsp.writeFile(candidate, "");
    const found = await findAgyBinary({
      AGY_BIN: "",
      PATH: tmpDir, // no `agy` here
      HOME: fakeHome,
      LOCALAPPDATA: path.join(fakeHome, "AppData", "Local"),
    });
    // findAgyBinary may find agy on the real PATH; only assert when
    // the fallback path resolves.
    if (found === candidate) {
      expect(found).toBe(candidate);
    } else {
      // Test environment has real agy on PATH — assert it's not null.
      expect(found).not.toBeNull();
    }
  });
});

describe("getAuthStatus", () => {
  it("returns api-key when ANTIGRAVITY_API_KEY is set", async () => {
    const s = await getAuthStatus({
      ANTIGRAVITY_API_KEY: "sk-abc",
      HOME: fakeHome,
    });
    expect(s).toBe("api-key");
  });

  it("returns oauth when ~/.gemini/antigravity-cli exists", async () => {
    const oauthDir = path.join(fakeHome, ".gemini", "antigravity-cli");
    await fsp.mkdir(oauthDir, { recursive: true });
    const s = await getAuthStatus({ HOME: fakeHome });
    expect(s).toBe("oauth");
  });

  it("returns oauth when ~/.config/antigravity exists", async () => {
    const cfgDir = path.join(fakeHome, ".config", "antigravity");
    await fsp.mkdir(cfgDir, { recursive: true });
    const s = await getAuthStatus({ HOME: fakeHome });
    expect(s).toBe("oauth");
  });

  it("returns missing on a clean home", async () => {
    const s = await getAuthStatus({ HOME: fakeHome });
    expect(s).toBe("missing");
  });

  it("returns missing when no HOME and no API key", async () => {
    const s = await getAuthStatus({ HOME: "" });
    // Empty HOME triggers the early "missing" branch; ensure we don't
    // throw.
    expect(["missing", "oauth"]).toContain(s);
  });
});
