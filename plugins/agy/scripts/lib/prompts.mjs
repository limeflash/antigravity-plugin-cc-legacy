// prompts.mjs — prompt templates for review and adversarial-review.
//
// Pure string builders. Keep these in one file so the wording is
// reviewable in isolation; the rest of the code shouldn't have to
// know what the prompts say.

const PREAMBLE_REVIEW = `Review the following diff. Be specific and actionable. Skip nits unless they materially affect correctness or safety. Group findings by severity.`;

const PREAMBLE_ADVERSARIAL = `Pressure-test the diff below. Your job is to challenge the implementation, NOT to validate it. Question the chosen approach, surface hidden assumptions, name failure modes the author didn't address, and propose at least one alternative design with concrete tradeoffs vs the chosen one. If the diff is sound, say so explicitly — but make the reader work for that conclusion.`;

const REVIEW_RULES = [
  "Group findings under: ## Correctness, ## Security, ## Edge cases, ## Style. Omit empty sections.",
  "For each finding cite the file path and (ideally) the line number from the diff.",
  "Prefer concrete code examples for suggested fixes over prose.",
  "Be explicit about confidence: HIGH for clear bugs, MEDIUM for likely issues, LOW for guesses.",
  "Do NOT propose unrelated refactors; review the diff as it stands.",
];

const ADVERSARIAL_RULES = [
  "Frame at least 3 questions the diff fails to answer.",
  "Identify the assumption you think most likely to break, and why.",
  "Propose one materially different design (not just 'rename this'); compare tradeoffs in 3-5 bullets.",
  "Call out the failure modes that aren't covered by tests in the diff.",
  "Conclude with a one-paragraph verdict: ship / change / rethink.",
];

function joinRules(rules) {
  return rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
}

// Render the full-file-context block. Giving the reviewer whole files
// (not just diff hunks) is what kills false positives like "X is not
// imported" or "missing guard" — the import / guard is usually just
// outside the hunk. Returns "" when there are no included files.
function fullFilesBlock(diffContext) {
  const files = diffContext.fullFiles ?? [];
  if (files.length === 0) return "";
  const parts = [
    "",
    "Full current content of the changed files (for context — the diff below shows what changed within them; do NOT flag issues that are already handled elsewhere in these files):",
  ];
  for (const f of files) {
    const ext = (f.path.split(".").pop() || "").toLowerCase();
    // Use a 4-backtick fence so files that themselves contain triple
    // backticks (markdown, JS template strings) don't terminate the
    // block early and corrupt the prompt structure.
    parts.push(`\n### ${f.path}`);
    parts.push("````" + ext);
    parts.push(f.content.replace(/\n$/, ""));
    parts.push("````");
  }
  const omitted = diffContext.omittedFiles ?? [];
  const tooBig = omitted.filter((o) => /too large|budget/.test(o.reason));
  if (tooBig.length) {
    parts.push(
      `\n(Full content omitted for ${tooBig.length} larger file(s); rely on the expanded diff hunks for those: ${tooBig.map((o) => o.path).join(", ")}.)`,
    );
  }
  return parts.join("\n");
}

/**
 * Build the prompt for `/agy:review`. `diffContext` is the result of
 * lib/git.mjs:workingTreeDiff or branchDiff. `focus` is the
 * user-supplied steer (optional, may be empty).
 */
export function buildReviewPrompt({ diffContext, focus }) {
  const scopeBlurb =
    diffContext.scope === "branch"
      ? `Branch review: HEAD compared against merge-base of HEAD and \`${diffContext.base}\` (resolved sha: ${diffContext.mergeBase ?? "?"}).`
      : `Working-tree review: uncommitted changes against \`HEAD\`.`;
  const focusBlock = focus
    ? `\n\nUser focus / extra steer:\n${focus.trim()}\n`
    : "";
  const filesBlock =
    diffContext.files.length > 0
      ? `\n\nFiles touched (${diffContext.files.length}):\n${diffContext.files.map((f) => `- ${f}`).join("\n")}\n`
      : "";
  return [
    PREAMBLE_REVIEW,
    "",
    "Rules:",
    joinRules(REVIEW_RULES),
    "",
    scopeBlurb,
    filesBlock,
    focusBlock,
    fullFilesBlock(diffContext),
    "",
    "Diff (with expanded context):",
    "```diff",
    diffContext.diff,
    "```",
    "",
  ].join("\n");
}

/**
 * Build the prompt for `/agy:adversarial-review`. Same args as
 * buildReviewPrompt but with a different stance and ruleset.
 */
export function buildAdversarialPrompt({ diffContext, focus }) {
  const scopeBlurb =
    diffContext.scope === "branch"
      ? `Branch under challenge: HEAD vs merge-base of HEAD and \`${diffContext.base}\`.`
      : `Working-tree changes under challenge.`;
  const focusBlock = focus
    ? `\n\nWhere the user wants the most pressure:\n${focus.trim()}\n`
    : "";
  return [
    PREAMBLE_ADVERSARIAL,
    "",
    "Rules:",
    joinRules(ADVERSARIAL_RULES),
    "",
    scopeBlurb,
    focusBlock,
    fullFilesBlock(diffContext),
    "",
    "Diff (with expanded context):",
    "```diff",
    diffContext.diff,
    "```",
    "",
  ].join("\n");
}

// Exported for tests + introspection.
export const PROMPT_INTERNALS = {
  PREAMBLE_REVIEW,
  PREAMBLE_ADVERSARIAL,
  REVIEW_RULES,
  ADVERSARIAL_RULES,
};
