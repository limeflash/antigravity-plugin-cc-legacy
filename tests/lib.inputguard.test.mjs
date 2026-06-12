import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isBlockedHost,
  validateScrapeUrl,
  isSensitivePath,
  validateDocPath,
  isUncPath,
  stageFile,
} from "../plugins/agy/scripts/lib/inputguard.mjs";

describe("isBlockedHost (SSRF guard)", () => {
  it("allows ordinary public hosts", () => {
    for (const h of ["example.com", "sub.example.co.uk", "8.8.8.8", "1.1.1.1", "github.com"]) {
      expect(isBlockedHost(h)).toBe(false);
    }
  });
  it("blocks localhost and *.localhost / *.local / *.internal", () => {
    for (const h of ["localhost", "api.localhost", "foo.local", "svc.internal", "box.lan"]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });
  it("blocks loopback / private / link-local IPv4", () => {
    for (const h of [
      "127.0.0.1", "127.1.2.3", "0.0.0.0", "10.0.0.5", "192.168.1.10",
      "172.16.0.1", "172.31.255.255", "169.254.169.254", "100.64.0.1",
    ]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });
  it("allows public IPv4 just outside the private ranges", () => {
    for (const h of ["172.15.0.1", "172.32.0.1", "192.169.0.1", "11.0.0.1", "8.8.4.4"]) {
      expect(isBlockedHost(h)).toBe(false);
    }
  });
  it("blocks IPv6 loopback / link-local / ULA and v4-mapped private", () => {
    for (const h of ["::1", "[::1]", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1"]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });
  it("blocks IPv4-in-IPv6 hex/compat encodings (adversarial SSRF bypass)", () => {
    // 7f00:1 == 127.0.0.1, 0a00:1 == 10.0.0.1
    for (const h of ["::ffff:7f00:1", "::7f00:1", "::127.0.0.1", "::ffff:0a00:1"]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });
  it("allows a public v4-mapped IPv6 but blocks a private one", () => {
    expect(isBlockedHost("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedHost("::ffff:192.168.1.1")).toBe(true);
  });
  it("blocks hostnames embedding a private IPv4 as leading labels (nip.io trick)", () => {
    expect(isBlockedHost("127.0.0.1.nip.io")).toBe(true);
    expect(isBlockedHost("10.0.0.1.sslip.io")).toBe(true);
    expect(isBlockedHost("8.8.8.8.nip.io")).toBe(false); // public embedded → allowed
  });
  it("blocks integer / hex / octal encoded IPs", () => {
    expect(isBlockedHost("2130706433")).toBe(true); // 127.0.0.1
    expect(isBlockedHost("0x7f000001")).toBe(true);
    expect(isBlockedHost("0177.0.0.1")).toBe(true); // octal
  });
  it("blocks empty/garbage host", () => {
    expect(isBlockedHost("")).toBe(true);
  });
});

describe("validateScrapeUrl", () => {
  it("accepts public http/https URLs (normalized)", () => {
    expect(validateScrapeUrl("https://example.com/page?q=1")).toEqual({
      ok: true,
      url: "https://example.com/page?q=1",
    });
    expect(validateScrapeUrl("http://example.com").ok).toBe(true);
  });
  it("rejects non-http(s) schemes", () => {
    for (const u of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "data:text/html,<h1>x</h1>",
      "javascript:alert(1)",
      "gopher://example.com",
    ]) {
      expect(validateScrapeUrl(u).ok).toBe(false);
    }
  });
  it("rejects SSRF targets", () => {
    for (const u of [
      "http://localhost:8080/admin",
      "http://127.0.0.1/",
      "https://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/",
      "http://[::1]:9000/",
      "http://2130706433/",
    ]) {
      expect(validateScrapeUrl(u).ok).toBe(false);
    }
  });
  it("rejects empty / non-URL input", () => {
    expect(validateScrapeUrl("").ok).toBe(false);
    expect(validateScrapeUrl("not a url").ok).toBe(false);
    expect(validateScrapeUrl(undefined).ok).toBe(false);
  });
});

describe("isSensitivePath", () => {
  const home = path.join(path.sep, "home", "u");
  it("flags paths under credential dirs", () => {
    expect(isSensitivePath(path.join(home, ".ssh", "id_rsa"), home)).toBe(true);
    expect(isSensitivePath(path.join(home, ".gemini", "x.txt"), home)).toBe(true);
    expect(isSensitivePath(path.join(home, ".aws", "credentials"), home)).toBe(true);
  });
  it("does not flag ordinary project paths", () => {
    expect(isSensitivePath(path.join(home, "projects", "doc.pdf"), home)).toBe(false);
  });
});

describe("validateDocPath", () => {
  let dir;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-ig-"));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("accepts an allowed document type", async () => {
    const f = path.join(dir, "notes.md");
    await fsp.writeFile(f, "# hi\n");
    const r = await validateDocPath("notes.md", { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.ext).toBe(".md");
  });

  it("rejects a non-document extension (fail closed)", async () => {
    const f = path.join(dir, "secrets.env");
    await fsp.writeFile(f, "API_KEY=abc\n");
    const r = await validateDocPath("secrets.env", { cwd: dir });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not an allowed document type/);
  });

  it("rejects a missing file", async () => {
    expect((await validateDocPath("nope.pdf", { cwd: dir })).ok).toBe(false);
  });

  it("rejects a directory", async () => {
    await fsp.mkdir(path.join(dir, "sub.md"));
    expect((await validateDocPath("sub.md", { cwd: dir })).ok).toBe(false);
  });

  it("rejects a file under a sensitive dir even with an allowed extension", async () => {
    const fakeHome = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-home-"));
    const ssh = path.join(fakeHome, ".ssh");
    await fsp.mkdir(ssh, { recursive: true });
    const f = path.join(ssh, "notes.md");
    await fsp.writeFile(f, "secret");
    const r = await validateDocPath(f, { cwd: dir, homedir: fakeHome });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/sensitive/);
    await fsp.rm(fakeHome, { recursive: true, force: true });
  });
});

describe("isUncPath", () => {
  it("flags UNC and device paths", () => {
    expect(isUncPath("\\\\localhost\\c$\\Users\\u\\.ssh\\id_rsa")).toBe(true);
    expect(isUncPath("\\\\?\\C:\\x")).toBe(true);
    expect(isUncPath("//server/share/x")).toBe(true);
  });
  it("does not flag ordinary paths", () => {
    expect(isUncPath("C:\\Users\\u\\doc.pdf")).toBe(false);
    expect(isUncPath("/home/u/doc.pdf")).toBe(false);
    expect(isUncPath("doc.pdf")).toBe(false);
  });
});

describe("stageFile (TOCTOU-resistant staging)", () => {
  let dir;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-stage-"));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("copies a regular file to the destination", async () => {
    const src = path.join(dir, "src.md");
    await fsp.writeFile(src, "hello");
    const dest = path.join(dir, "document.md");
    const r = stageFile(src, dest);
    expect(r.ok).toBe(true);
    expect(await fsp.readFile(dest, "utf8")).toBe("hello");
  });

  it("rejects a missing source and missing args", () => {
    expect(stageFile(path.join(dir, "nope"), path.join(dir, "d")).ok).toBe(false);
    expect(stageFile("", "").ok).toBe(false);
  });

  it("rejects a symlink source (the TOCTOU swap vector)", async () => {
    const target = path.join(dir, "secret");
    await fsp.writeFile(target, "secret");
    const link = path.join(dir, "link.md");
    try {
      await fsp.symlink(target, link);
    } catch {
      return; // symlink not permitted on this host (e.g. Windows w/o privilege) — skip
    }
    const r = stageFile(link, path.join(dir, "out.md"));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/symlink/);
  });
});
