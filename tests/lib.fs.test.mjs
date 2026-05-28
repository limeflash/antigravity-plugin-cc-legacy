import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureDir,
  writeAtomic,
  readJson,
  writeJson,
  appendLogLine,
  pathExists,
  nowIso,
} from "../plugins/agy/scripts/lib/fs.mjs";

let tmpDir;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-fs-test-"));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("ensureDir", () => {
  it("creates nested directories", async () => {
    const target = path.join(tmpDir, "a", "b", "c");
    await ensureDir(target);
    const stat = await fsp.stat(target);
    expect(stat.isDirectory()).toBe(true);
  });
  it("is idempotent", async () => {
    const target = path.join(tmpDir, "x");
    await ensureDir(target);
    await ensureDir(target);
    expect(await pathExists(target)).toBe(true);
  });
});

describe("writeAtomic + readJson", () => {
  it("round-trips a JSON object", async () => {
    const f = path.join(tmpDir, "state.json");
    await writeJson(f, { hello: "world", count: 7 });
    const back = await readJson(f);
    expect(back).toEqual({ hello: "world", count: 7 });
  });

  it("leaves no .tmp- artifact after successful write", async () => {
    const f = path.join(tmpDir, "state.json");
    await writeJson(f, { a: 1 });
    const entries = await fsp.readdir(tmpDir);
    expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
  });

  it("readJson returns fallback when file missing", async () => {
    const r = await readJson(path.join(tmpDir, "absent.json"), { default: true });
    expect(r).toEqual({ default: true });
  });

  it("readJson throws when file missing and no fallback", async () => {
    await expect(readJson(path.join(tmpDir, "absent.json"))).rejects.toThrow();
  });

  it("readJson throws on invalid JSON", async () => {
    const f = path.join(tmpDir, "bad.json");
    await fsp.writeFile(f, "{not json");
    await expect(readJson(f, {})).rejects.toThrow();
  });

  it("writeAtomic accepts a string body", async () => {
    const f = path.join(tmpDir, "raw.txt");
    await writeAtomic(f, "hello\n");
    expect(await fsp.readFile(f, "utf8")).toBe("hello\n");
  });
});

describe("appendLogLine", () => {
  it("creates the file and adds a trailing newline", async () => {
    const f = path.join(tmpDir, "logs", "x.log");
    await appendLogLine(f, "first");
    await appendLogLine(f, "second\n");
    expect(await fsp.readFile(f, "utf8")).toBe("first\nsecond\n");
  });
});

describe("pathExists", () => {
  it("returns true for existing files", async () => {
    const f = path.join(tmpDir, "x");
    await fsp.writeFile(f, "");
    expect(await pathExists(f)).toBe(true);
  });
  it("returns false for missing paths", async () => {
    expect(await pathExists(path.join(tmpDir, "nope"))).toBe(false);
  });
});

describe("nowIso", () => {
  it("returns parseable UTC ISO-8601 with ms", () => {
    const s = nowIso();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isFinite(Date.parse(s))).toBe(true);
  });
});
