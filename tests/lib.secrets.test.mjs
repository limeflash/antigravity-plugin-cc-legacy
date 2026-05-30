import { describe, it, expect } from "vitest";
import { scanDiffForSecrets } from "../plugins/agy/scripts/lib/secrets.mjs";

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
