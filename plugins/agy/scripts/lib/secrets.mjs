// secrets.mjs — best-effort secret detection for review material.
//
// The Node companion's /agy:review and /agy:adversarial-review guard the
// material sent to Gemini so credentials don't get shipped to a third
// party. Best-effort, NOT a replacement for gitleaks/trufflehog —
// conservative patterns to keep false positives low.
//
// Two entry points:
//   - scanDiffForSecrets(diff): scans the ADDED lines of a unified diff.
//   - scanTextForSecrets(text): scans raw text (e.g. the FULL content of a
//     changed file that gets shipped as context — a secret on an unchanged
//     line would never appear in the diff's `+` lines, so the full content
//     must be scanned too).
//
// The Bash wrapper (_scan_text_for_secrets / _scan_diff_for_secrets in
// agy-run.sh) keeps the same pattern set; both are exercised by tests so
// they don't drift.

// Case-insensitive (`/i`) to match the Bash wrapper, which runs `grep -aEi`.
const PATTERNS = [
  [/AKIA[0-9A-Z]{16}/i, "AWS access key"],
  [/ASIA[0-9A-Z]{16}/i, "AWS STS token"],
  [/gh[pousr]_[A-Za-z0-9]{36,}/i, "GitHub personal access token"],
  [/github_pat_[A-Za-z0-9_]{40,}/i, "GitHub fine-grained PAT"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/i, "Slack token"],
  // Modern API keys carry dashes after a specific prefix, so they need
  // their own patterns — the generic legacy `sk-<alnum>` below stops at the
  // first dash and would miss them.
  [/sk-ant-[A-Za-z0-9_-]{20,}/i, "Anthropic API key"],
  [/sk-proj-[A-Za-z0-9_-]{20,}/i, "OpenAI project key"],
  [/sk-[A-Za-z0-9]{20,}/i, "OpenAI legacy API key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/i, "PEM private key block"],
  [
    /(api[_-]?key|secret|token|password|access[_-]?key)\s*[=:]\s*["']?[A-Za-z0-9_+/=\-]{16,}/i,
    "inline credential assignment",
  ],
];

/**
 * Scan raw text against the secret patterns. Returns an array of matched
 * pattern labels (empty if clean). Order of labels follows PATTERNS.
 */
export function scanTextForSecrets(text) {
  if (!text) return [];
  const hits = [];
  for (const [re, label] of PATTERNS) {
    if (re.test(text)) hits.push(label);
  }
  return hits;
}

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
  return scanTextForSecrets(added.join("\n"));
}
