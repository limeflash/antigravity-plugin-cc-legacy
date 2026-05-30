// secrets.mjs — best-effort secret detection for review diffs.
//
// Parity with the Bash wrapper's _scan_diff_for_secrets: the Node
// companion's /agy:review and /agy:adversarial-review paths must guard
// the diff just like the Bash /agy:review does, so credentials don't
// get shipped to Gemini through the stateful path. Best-effort, not a
// replacement for gitleaks/trufflehog — conservative patterns to keep
// false positives low.

// Case-insensitive (`/i`) for parity with the Bash wrapper, which runs
// `grep -aEi` on every pattern.
const PATTERNS = [
  [/AKIA[0-9A-Z]{16}/i, "AWS access key"],
  [/ASIA[0-9A-Z]{16}/i, "AWS STS token"],
  [/gh[pousr]_[A-Za-z0-9]{36,}/i, "GitHub personal access token"],
  [/github_pat_[A-Za-z0-9_]{40,}/i, "GitHub fine-grained PAT"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/i, "Slack token"],
  [/sk-[A-Za-z0-9]{20,}/i, "OpenAI/Anthropic-style API key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/i, "PEM private key block"],
  [
    /(api[_-]?key|secret|token|password|access[_-]?key)\s*[=:]\s*["']?[A-Za-z0-9_+/=\-]{16,}/i,
    "inline credential assignment",
  ],
];

/**
 * Scan only the ADDED lines of a unified diff (lines starting with a
 * single `+`, excluding the `+++` file header). Returns an array of
 * matched pattern labels (empty if clean).
 */
export function scanDiffForSecrets(diff) {
  if (!diff) return [];
  const added = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  if (added.length === 0) return [];
  const body = added.join("\n");
  const hits = [];
  for (const [re, label] of PATTERNS) {
    if (re.test(body)) hits.push(label);
  }
  return hits;
}
