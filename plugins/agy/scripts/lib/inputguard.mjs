// inputguard.mjs — input validation (deny-lists) for the read-only Phase-3
// commands /agy:scrape (a URL) and /agy:doc-to-md (a file path).
//
// These commands hand their input to agy, which fetches/reads it and ships
// the content to Gemini — so the input is an attack surface:
//   - scrape: SSRF (file://, localhost, cloud metadata, private ranges).
//   - doc-to-md: local-file exfiltration (~/.ssh/id_rsa, .env, /etc/passwd).
//
// Fail CLOSED: anything not clearly allowed is rejected. Best-effort — a
// determined attacker with DNS control can still rebind a public name to an
// internal IP; this guard blocks the obvious literal targets and bad schemes.

import path from "node:path";
import { promises as fsp, realpathSync } from "node:fs";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// /agy:scrape — URL validation
// ---------------------------------------------------------------------------

const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Block localhost / private / link-local / metadata hosts (SSRF guard).
 * Operates on the URL hostname (already lower-cased by WHATWG URL).
 */
export function isBlockedHost(hostname) {
  let h = String(hostname || "").toLowerCase().replace(/\.+$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (
    h.endsWith(".local") || h.endsWith(".internal") ||
    h.endsWith(".lan") || h.endsWith(".home") || h.endsWith(".corp")
  ) return true;

  // IPv6 literal (strip optional brackets).
  let host = h;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;        // loopback / unspecified
    if (host.startsWith("fe80:")) return true;               // link-local
    if (/^f[cd][0-9a-f]*:/.test(host)) return true;          // ULA fc00::/7
    if (host.startsWith("::ffff:")) return isBlockedHost(host.slice("::ffff:".length)); // v4-mapped
    return false;                                            // other public IPv6
  }

  // Bare integer (http://2130706433/ == 127.0.0.1) or hex IP — block.
  if (/^\d+$/.test(host)) return true;
  if (/^0x[0-9a-f]+$/.test(host)) return true;
  // Dotted form with an octal (leading-zero) octet — ambiguous, block.
  if (/\./.test(host) && host.split(".").some((p) => /^0\d/.test(p))) return true;

  // Dotted IPv4.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((x) => x > 255)) return true; // malformed → block
    const [a, b] = o;
    if (a === 127 || a === 0) return true;                 // loopback / 0.0.0.0/8
    if (a === 10) return true;                             // private
    if (a === 169 && b === 254) return true;               // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;      // private
    if (a === 192 && b === 168) return true;               // private
    if (a === 100 && b >= 64 && b <= 127) return true;     // CGNAT 100.64/10
  }
  return false;
}

/** Validate a /agy:scrape URL. Returns { ok, url } or { ok:false, reason }. */
export function validateScrapeUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, reason: "empty URL" };
  }
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "not a valid absolute URL (include http:// or https://)" };
  }
  if (!ALLOWED_URL_PROTOCOLS.has(u.protocol)) {
    return { ok: false, reason: `protocol '${u.protocol}' is not allowed (only http/https)` };
  }
  if (isBlockedHost(u.hostname)) {
    return {
      ok: false,
      reason: `host '${u.hostname}' is blocked (localhost / private / link-local — SSRF guard)`,
    };
  }
  return { ok: true, url: u.href };
}

// ---------------------------------------------------------------------------
// /agy:doc-to-md — file path validation
// ---------------------------------------------------------------------------

// Allow-list of document extensions we will convert. Anything else (.pem,
// .key, .env, id_rsa, ...) is rejected — fail closed.
const ALLOWED_DOC_EXT = new Set([
  ".pdf", ".docx", ".doc", ".odt", ".rtf",
  ".html", ".htm", ".xhtml", ".xml",
  ".md", ".markdown", ".txt", ".text", ".rst", ".org", ".adoc",
  ".csv", ".tsv",
  ".pptx", ".ppt", ".epub",
]);

const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB

/** True if a resolved real path sits under a credentials / system directory. */
export function isSensitivePath(realPath, homedir = os.homedir()) {
  const win = process.platform === "win32";
  const norm = (p) => (win ? p.toLowerCase() : p);
  const p = norm(realPath);
  const home = homedir;
  const under = (base) => {
    const b = norm(base);
    return p === b || p.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  };
  const sensitive = [
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    path.join(home, ".config", "gcloud"),
    path.join(home, ".gemini"),   // agy's own credentials / conversation store
    path.join(home, ".kube"),
    path.join(home, ".docker"),
  ];
  if (!win) sensitive.push("/etc", "/root", "/proc", "/sys", "/dev", "/var/run");
  return sensitive.some(under);
}

/**
 * Validate a /agy:doc-to-md path. Resolves symlinks first (so a symlinked
 * .pdf pointing at ~/.ssh/id_rsa is caught), then enforces: regular file,
 * size cap, allowed document extension, not under a sensitive dir.
 * Returns { ok, path, ext } or { ok:false, reason }.
 */
export async function validateDocPath(raw, opts = {}) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, reason: "empty path" };
  }
  const cwd = opts.cwd || process.cwd();
  const abs = path.resolve(cwd, raw.trim());
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    return { ok: false, reason: "file does not exist" };
  }
  let st;
  try {
    st = await fsp.stat(real);
  } catch {
    return { ok: false, reason: "cannot stat file" };
  }
  if (!st.isFile()) return { ok: false, reason: "not a regular file" };
  if (st.size > MAX_DOC_BYTES) {
    return { ok: false, reason: `file too large (${st.size} bytes > ${MAX_DOC_BYTES} limit)` };
  }
  const ext = path.extname(real).toLowerCase();
  if (!ALLOWED_DOC_EXT.has(ext)) {
    return { ok: false, reason: `extension '${ext || "(none)"}' is not an allowed document type` };
  }
  if (isSensitivePath(real, opts.homedir)) {
    return { ok: false, reason: "path resolves under a sensitive directory" };
  }
  return { ok: true, path: real, ext };
}

// ---------------------------------------------------------------------------
// CLI: `node inputguard.mjs scrape <url>` | `node inputguard.mjs doc <path> [cwd]`
// On success prints the normalized URL / resolved path and exits 0.
// On rejection prints the reason to stderr and exits 1.
// ---------------------------------------------------------------------------
function isMainModule() {
  const a1 = process.argv[1];
  if (!a1) return false;
  const here = fileURLToPath(import.meta.url);
  const norm = (p) => {
    try { return realpathSync(p); } catch { return path.resolve(p); }
  };
  return norm(a1) === norm(here);
}

if (isMainModule()) {
  const [kind, input, cwd] = process.argv.slice(2);
  (async () => {
    let res;
    if (kind === "scrape") res = validateScrapeUrl(input);
    else if (kind === "doc") res = await validateDocPath(input, { cwd });
    else {
      process.stderr.write(`inputguard: unknown kind '${kind}' (expected scrape|doc)\n`);
      process.exit(2);
    }
    if (res.ok) {
      process.stdout.write(`${res.url || res.path}\n`);
      process.exit(0);
    }
    process.stderr.write(`${res.reason}\n`);
    process.exit(1);
  })();
}

export { ALLOWED_DOC_EXT, MAX_DOC_BYTES };
