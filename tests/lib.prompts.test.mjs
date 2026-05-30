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

describe("buildReviewPrompt", () => {
  it("includes the preamble and rules", () => {
    const p = buildReviewPrompt({ diffContext: WORKING_TREE });
    expect(p).toContain(PROMPT_INTERNALS.PREAMBLE_REVIEW.slice(0, 30));
    for (const rule of PROMPT_INTERNALS.REVIEW_RULES) {
      expect(p).toContain(rule);
    }
  });

  it("renders the working-tree scope blurb", () => {
    const p = buildReviewPrompt({ diffContext: WORKING_TREE });
    expect(p).toMatch(/Working-tree review/);
    expect(p).not.toMatch(/Branch review/);
  });

  it("renders the branch scope blurb with the base ref", () => {
    const p = buildReviewPrompt({ diffContext: BRANCH });
    expect(p).toMatch(/Branch review/);
    expect(p).toContain("`main`");
    expect(p).toContain(BRANCH.mergeBase);
  });

  it("lists touched files when present", () => {
    const p = buildReviewPrompt({ diffContext: BRANCH });
    expect(p).toContain("Files touched (2):");
    expect(p).toContain("- bar.ts");
    expect(p).toContain("- bar.test.ts");
  });

  it("inserts the focus block when focus is non-empty", () => {
    const p = buildReviewPrompt({
      diffContext: WORKING_TREE,
      focus: "focus on error handling",
    });
    expect(p).toContain("User focus");
    expect(p).toContain("focus on error handling");
  });

  it("omits the focus block when focus is empty / missing", () => {
    const p = buildReviewPrompt({ diffContext: WORKING_TREE, focus: "" });
    expect(p).not.toContain("User focus");
  });

  it("embeds the diff inside a ```diff fence", () => {
    const p = buildReviewPrompt({ diffContext: WORKING_TREE });
    expect(p).toContain("```diff\n");
    expect(p).toContain("+const x = 1;");
    expect(p).toContain("```\n");
  });
});

describe("buildAdversarialPrompt", () => {
  it("uses the adversarial preamble (NOT the review one)", () => {
    const p = buildAdversarialPrompt({ diffContext: WORKING_TREE });
    expect(p).toContain(PROMPT_INTERNALS.PREAMBLE_ADVERSARIAL.slice(0, 30));
    expect(p).not.toContain(PROMPT_INTERNALS.PREAMBLE_REVIEW.slice(0, 30));
  });

  it("includes the adversarial rules (not the review ones)", () => {
    const p = buildAdversarialPrompt({ diffContext: WORKING_TREE });
    for (const rule of PROMPT_INTERNALS.ADVERSARIAL_RULES) {
      expect(p).toContain(rule);
    }
    // The review-specific 'group findings under Correctness…' rule
    // is review-only.
    expect(p).not.toContain(PROMPT_INTERNALS.REVIEW_RULES[0]);
  });

  it("frames the user-focus block as 'where to apply pressure'", () => {
    const p = buildAdversarialPrompt({
      diffContext: BRANCH,
      focus: "the retry/backoff design",
    });
    expect(p).toMatch(/pressure/i);
    expect(p).toContain("the retry/backoff design");
  });
});

describe("full-file context block", () => {
  const ctxWithFiles = {
    ...WORKING_TREE,
    fullFiles: [{ path: "foo.js", content: "import x from 'x';\nconst y = 1;\n" }],
    omittedFiles: [{ path: "huge.js", reason: "too large (900 lines)" }],
  };

  it("review prompt includes full file content when present", () => {
    const p = buildReviewPrompt({ diffContext: ctxWithFiles });
    expect(p).toContain("Full current content of the changed files");
    expect(p).toContain("### foo.js");
    expect(p).toContain("import x from 'x';");
    expect(p).toContain("huge.js"); // omitted note
  });

  it("review prompt has no full-file section when fullFiles empty", () => {
    const p = buildReviewPrompt({ diffContext: { ...WORKING_TREE, fullFiles: [] } });
    expect(p).not.toContain("Full current content of the changed files");
  });

  it("adversarial prompt also includes full file content", () => {
    const p = buildAdversarialPrompt({ diffContext: ctxWithFiles });
    expect(p).toContain("### foo.js");
  });
});

describe("dynamic backtick fence", () => {
  it("uses a fence longer than any backtick run inside the file", () => {
    const ctx = {
      ...WORKING_TREE,
      fullFiles: [{ path: "doc.md", content: "before\n````\ncode\n````\nafter\n" }],
    };
    const p = buildReviewPrompt({ diffContext: ctx });
    // file has a 4-backtick run, so the fence must be >=5 backticks
    expect(p).toContain("`````md");
  });
});
