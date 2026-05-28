import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HANDLERS, VERSION } from "../plugins/agy/scripts/agy-companion.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.resolve(__dirname, "..", "plugins", "agy", "scripts", "agy-companion.mjs");

function runCompanion(args) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: "utf8",
    timeout: 10000,
  });
}

describe("agy-companion entry", () => {
  it("exports a non-empty VERSION", () => {
    expect(VERSION).toMatch(/^\d+\.\d+/);
  });

  it("HANDLERS includes version/help aliases", () => {
    expect(typeof HANDLERS.version).toBe("function");
    expect(typeof HANDLERS.help).toBe("function");
    expect(typeof HANDLERS["--help"]).toBe("function");
  });

  it("`version` subcommand prints JSON with current version", () => {
    const r = runCompanion(["version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toContain('"version":');
    const obj = JSON.parse(r.stdout);
    expect(obj.version).toBe(VERSION);
  });

  it("`help` exits 0 and prints usage", () => {
    const r = runCompanion(["help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("agy-companion");
    expect(r.stdout).toContain("Usage:");
  });

  it("no subcommand exits 64 and prints to stderr", () => {
    const r = runCompanion([]);
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("Usage:");
  });

  it("unknown subcommand exits 64", () => {
    const r = runCompanion(["definitely-not-real"]);
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("unknown subcommand");
  });
});
