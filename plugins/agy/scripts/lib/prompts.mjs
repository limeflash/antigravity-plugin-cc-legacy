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

// Design A+ : the diff and full file content live on disk in a staging
// dir that agy can read; the prompt only POINTS at them. This keeps the
// argv prompt tiny (no ENAMETOOLONG, no truncation) and gives agy the
// whole file for context (kills "X not imported" / "missing guard"
// false positives). `stageDir` is an absolute path agy can read
// (passed via --add-dir); `staged` is the list of staged relpaths.
function stagedMaterialsBlock(stageDir, staged, omitted) {
  const sep = stageDir.includes("\\") ? "\\" : "/";
  const diffPath = `${stageDir}${sep}diff.patch`;
  const filesDir = `${stageDir}${sep}files`;
  const parts = [
    "",
    "## Material to review (read these files with your tools — they are on disk, not inline)",
    `- The unified diff (with expanded context) is at:\n  ${diffPath}`,
  ];
  if (staged && staged.length) {
    parts.push(
      `- The FULL current content of the changed files is under:\n  ${filesDir}${sep}<same relative path>`,
      `  Read the ones you need for context. Do NOT flag an issue (missing import, undefined name, missing guard) as a bug unless you've checked the full file and confirmed it — the definition is often outside the diff hunk.`,
      "  Changed files staged for you:",
      ...staged.map((f) => `    - ${f}`),
    );
  }
  const big = (omitted ?? []).filter((o) => /too large|binary|symlink|outside/.test(o.reason));
  if (big.length) {
    parts.push(
      `  (Not staged: ${big.map((o) => `${o.path} [${o.reason}]`).join(", ")} — judge those from the diff alone, and mark cross-context concerns as [UNVERIFIED].)`,
    );
  }
  return parts.join("\n");
}

/**
 * Build the prompt for `/agy:review`. Tiny argv prompt that points at
 * the staged diff + files (see Design A+). `staged`/`omitted` come from
 * lib/git.mjs:stageReviewMaterials; `stageDir` is its absolute path.
 */
export function buildReviewPrompt({ diffContext, focus, stageDir, staged, omitted }) {
  const scopeBlurb =
    diffContext.scope === "branch"
      ? `Branch review: HEAD compared against merge-base of HEAD and \`${diffContext.base}\` (resolved sha: ${diffContext.mergeBase ?? "?"}).`
      : `Working-tree review: uncommitted changes against \`HEAD\`.`;
  const focusBlock = focus ? `\n\nUser focus / extra steer:\n${focus.trim()}` : "";
  return [
    PREAMBLE_REVIEW,
    "",
    "Rules:",
    joinRules(REVIEW_RULES),
    "",
    scopeBlurb,
    focusBlock,
    stagedMaterialsBlock(stageDir, staged, omitted),
    "",
  ].join("\n");
}

/**
 * Build the prompt for `/agy:adversarial-review` (Design A+). Same
 * staged-materials approach, different stance/ruleset.
 */
export function buildAdversarialPrompt({ diffContext, focus, stageDir, staged, omitted }) {
  const scopeBlurb =
    diffContext.scope === "branch"
      ? `Branch under challenge: HEAD vs merge-base of HEAD and \`${diffContext.base}\`.`
      : `Working-tree changes under challenge.`;
  const focusBlock = focus ? `\n\nWhere the user wants the most pressure:\n${focus.trim()}` : "";
  return [
    PREAMBLE_ADVERSARIAL,
    "",
    "Rules:",
    joinRules(ADVERSARIAL_RULES),
    "",
    scopeBlurb,
    focusBlock,
    stagedMaterialsBlock(stageDir, staged, omitted),
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
