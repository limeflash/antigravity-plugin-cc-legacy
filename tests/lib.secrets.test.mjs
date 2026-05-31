import { describe, it, expect } from "vitest";
import { scanDiffForSecrets, scanTextForSecrets } from "../plugins/agy/scripts/lib/secrets.mjs";

const d = (...lines) => lines.join("\n");

describe("scanDiffForSecrets", () => {
  it("clean diff returns no hits", () => {
    expect(scanDiffForSecrets(d("+const x = 1;", "-let y = 2;"))).toEqual([]);
  });

  it("empty / undefined input", () => {
    expect(scanDiffForSecrets("")).toEqual([]);
    expect(scanDiffForSecrets(undefined)).toEqual([]);
  });

  it("detects an AWS access key in an added line", () => {
    expect(scanDiffForSecrets(d('+key = "AKIAIOSFODNN7EXAMPLE"'))).toContain("AWS access key");
  });

  it("detects a GitHub PAT", () => {
    expect(
      scanDiffForSecrets(d('+t = "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"')),
    ).toContain("GitHub personal access token");
  });

  it("detects a PEM private key block", () => {
    expect(scanDiffForSecrets(d("+-----BEGIN RSA PRIVATE KEY-----"))).toContain(
      "PEM private key block",
    );
  });

  it("detects an inline credential assignment", () => {
    expect(
      scanDiffForSecrets(d('+API_KEY = "abcdef0123456789ABCDEF0123456789"')),
    ).toContain("inline credential assignment");
  });

  it("ignores secrets on REMOVED lines", () => {
    expect(scanDiffForSecrets(d('-AWS = "AKIAIOSFODNN7EXAMPLE"'))).toEqual([]);
  });

  it("ignores the +++ file header even if it looks like a key", () => {
    expect(scanDiffForSecrets(d("+++ b/AKIAIOSFODNN7EXAMPLE.txt", "+hello"))).toEqual([]);
  });

  it("does not flag a benign code reference (value side has a dot)", () => {
    expect(scanDiffForSecrets(d("+const password = formData.password;"))).toEqual([]);
  });
});

describe("scanDiffForSecrets — case-insensitivity (parity with grep -i)", () => {
  it("catches a lowercased AWS-key form", () => {
    expect(scanDiffForSecrets('+x = "akiaiosfodnn7example"')).toContain("AWS access key");
  });
  it("catches an uppercased GitHub PAT prefix", () => {
    expect(
      scanDiffForSecrets('+x = "GHP_ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJ"'),
    ).toContain("GitHub personal access token");
  });
});

describe("scanDiffForSecrets — fine-grained GitHub PAT", () => {
  it("detects github_pat_ tokens", () => {
    const tok = "github_pat_" + "A".repeat(82);
    expect(scanDiffForSecrets(`+token = "${tok}"`)).toContain("GitHub fine-grained PAT");
  });
});

describe("scanTextForSecrets (raw content — powers the GAP-2 full-file scan)", () => {
  it("scans raw text with no `+` prefix required", () => {
    expect(scanTextForSecrets('const k = "AKIAIOSFODNN7EXAMPLE";')).toContain("AWS access key");
  });
  it("empty / undefined → no hits", () => {
    expect(scanTextForSecrets("")).toEqual([]);
    expect(scanTextForSecrets(undefined)).toEqual([]);
  });
});

describe("modern API key formats (GAP-3)", () => {
  const ant = "sk-ant-api03-" + "A".repeat(30);
  const proj = "sk-proj-" + "B".repeat(30);
  const legacy = "sk-" + "c".repeat(40);

  it("detects an Anthropic sk-ant- key (raw + diff)", () => {
    expect(scanTextForSecrets(ant)).toContain("Anthropic API key");
    expect(scanDiffForSecrets(`+key = "${ant}"`)).toContain("Anthropic API key");
  });
  it("detects an OpenAI sk-proj- key", () => {
    expect(scanTextForSecrets(proj)).toContain("OpenAI project key");
  });
  it("still detects a legacy sk- key", () => {
    expect(scanTextForSecrets(legacy)).toContain("OpenAI legacy API key");
  });
  it("does not flag a dashed identifier that merely contains 'sk-'", () => {
    // The legacy pattern needs 20 ALNUM after sk- (no dashes), and the
    // modern patterns need the sk-ant-/sk-proj- prefix — so a kebab-case
    // word like disk-management-... must not match.
    expect(scanTextForSecrets("disk-management-system-controller-v2")).toEqual([]);
  });
});
