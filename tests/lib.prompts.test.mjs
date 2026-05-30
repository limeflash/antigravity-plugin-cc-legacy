import { describe, it, expect } from "vitest";
import {
  buildReviewPrompt,
  buildAdversarialPrompt,
  PROMPT_INTERNALS,
} from "../plugins/agy/scripts/lib/prompts.mjs";

const WORKING_TREE = {
  scope: "working-tree",
  base: "HEAD",
  head: "(uncommitted)",
  diff: "--- a/foo.js\n+++ b/foo.js\n+const x = 1;\n",
  files: ["foo.js"],
  root: "/tmp/repo",
};

const BRANCH = {
  scope: "branch",
  base: "main",
  baseSha: "abc1234",
  head: "def5678",
  mergeBase: "fff0000",
  diff: "--- a/bar.ts\n+++ b/bar.ts\n+function add(a, b) { return a + b; }\n",
  files: ["bar.ts", "bar.test.ts"],
  root: "/tmp/repo",
};

const STAGE = "/tmp/agy-review-xyz";
const STAGED = ["bar.ts", "bar.test.ts"];

describe("buildReviewPrompt (Design A+ staged)", () => {
  it("includes the preamble and rules", () => {
    const p = buildReviewPrompt({ diffContext: WORKING_TREE, stageDir: STAGE, staged: ["foo.js"] });
    expect(p).toContain(PROMPT_INTERNALS.PREAMBLE_REVIEW.slice(0, 30));
    for (const rule of PROMPT_INTERNALS.REVIEW_RULES) expect(p).toContain(rule);
  });

  it("renders the working-tree vs branch scope blurb", () => {
    expect(buildReviewPrompt({ diffContext: WORKING_TREE, stageDir: STAGE, staged: [] }))
      .toMatch(/Working-tree review/);
    const b = buildReviewPrompt({ diffContext: BRANCH, stageDir: STAGE, staged: STAGED });
    expect(b).toMatch(/Branch review/);
    expect(b).toContain("`main`");
    expect(b).toContain(BRANCH.mergeBase);
  });

  it("points at the staged diff and files instead of embedding them", () => {
    const p = buildReviewPrompt({ diffContext: BRANCH, stageDir: STAGE, staged: STAGED });
    expect(p).toContain(`${STAGE}/diff.patch`);
    expect(p).toContain(`${STAGE}/files`);
    expect(p).toContain("- bar.ts");
    expect(p).toContain("- bar.test.ts");
    // The diff CONTENT must NOT be embedded (that was the ENAMETOOLONG source).
    expect(p).not.toContain("function add(a, b)");
    expect(p).not.toContain("```diff");
  });

  it("notes omitted files and tells agy to mark cross-context concerns UNVERIFIED", () => {
    const p = buildReviewPrompt({
      diffContext: BRANCH,
      stageDir: STAGE,
      staged: ["bar.ts"],
      omitted: [{ path: "huge.bin", reason: "binary" }],
    });
    expect(p).toContain("huge.bin");
    expect(p).toMatch(/UNVERIFIED/);
  });

  it("focus block present only when focus is non-empty", () => {
    expect(buildReviewPrompt({ diffContext: WORKING_TREE, stageDir: STAGE, staged: [], focus: "error handling" }))
      .toContain("error handling");
    expect(buildReviewPrompt({ diffContext: WORKING_TREE, stageDir: STAGE, staged: [], focus: "" }))
      .not.toContain("User focus");
  });
});

describe("buildAdversarialPrompt (Design A+ staged)", () => {
  it("uses the adversarial preamble + rules, not the review ones", () => {
    const p = buildAdversarialPrompt({ diffContext: WORKING_TREE, stageDir: STAGE, staged: [] });
    expect(p).toContain(PROMPT_INTERNALS.PREAMBLE_ADVERSARIAL.slice(0, 30));
    expect(p).not.toContain(PROMPT_INTERNALS.PREAMBLE_REVIEW.slice(0, 30));
    for (const rule of PROMPT_INTERNALS.ADVERSARIAL_RULES) expect(p).toContain(rule);
    expect(p).not.toContain(PROMPT_INTERNALS.REVIEW_RULES[0]);
  });

  it("also points at staged materials and frames focus as pressure", () => {
    const p = buildAdversarialPrompt({
      diffContext: BRANCH,
      stageDir: STAGE,
      staged: STAGED,
      focus: "the retry/backoff design",
    });
    expect(p).toContain(`${STAGE}/diff.patch`);
    expect(p).toMatch(/pressure/i);
    expect(p).toContain("the retry/backoff design");
  });

  it("uses Windows-style separators when stageDir is a Windows path", () => {
    const p = buildReviewPrompt({
      diffContext: WORKING_TREE,
      stageDir: "C:\\Temp\\agy-review-xyz",
      staged: ["foo.js"],
    });
    expect(p).toContain("C:\\Temp\\agy-review-xyz\\diff.patch");
  });
});
