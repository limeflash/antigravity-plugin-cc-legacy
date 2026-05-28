import { describe, it, expect } from "vitest";
import { parseArgs, joinPositional, splitArgString } from "../plugins/agy/scripts/lib/args.mjs";

const SCHEMA = {
  boolean: ["background", "wait", "resume", "fresh"],
  value: ["model", "base", "name", "output"],
};

describe("parseArgs", () => {
  it("returns defaults for empty argv", () => {
    const r = parseArgs([], SCHEMA);
    expect(r.flags.background).toBe(false);
    expect(r.values.model).toBeNull();
    expect(r.positional).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("parses a boolean flag", () => {
    // argv arrives pre-tokenized by the shell; parseArgs does not
    // re-split tokens that already contain spaces.
    const r = parseArgs(["--background", "task", "text"], SCHEMA);
    expect(r.flags.background).toBe(true);
    expect(r.positional).toEqual(["task", "text"]);
  });

  it("parses --model X (space-separated)", () => {
    const r = parseArgs(["--model", "opus", "fix", "the", "bug"], SCHEMA);
    expect(r.values.model).toBe("opus");
    expect(r.positional).toEqual(["fix", "the", "bug"]);
  });

  it("parses --model=X (equals form)", () => {
    const r = parseArgs(["--model=opus", "fix", "bug"], SCHEMA);
    expect(r.values.model).toBe("opus");
    expect(r.positional).toEqual(["fix", "bug"]);
  });

  it("reports --model= with empty value", () => {
    const r = parseArgs(["--model="], SCHEMA);
    expect(r.values.model).toBeNull();
    expect(r.errors[0]).toContain("--model=");
  });

  it("reports --model with no value at end of argv", () => {
    const r = parseArgs(["--model"], SCHEMA);
    expect(r.errors[0]).toContain("--model");
  });

  it("rejects a value on a boolean flag", () => {
    const r = parseArgs(["--background=yes"], SCHEMA);
    expect(r.errors[0]).toContain("--background");
    expect(r.flags.background).toBe(false);
  });

  it("forwards unknown flags to extra", () => {
    const r = parseArgs(["--sandbox", "--print-timeout", "10m", "do", "the", "thing"], SCHEMA);
    expect(r.extra).toEqual(["--sandbox", "--print-timeout", "10m"]);
    expect(r.positional).toEqual(["do", "the", "thing"]);
  });

  it("`--` terminates flag parsing", () => {
    const r = parseArgs(["--model", "opus", "--", "--this-is-not-a-flag", "task"], SCHEMA);
    expect(r.values.model).toBe("opus");
    expect(r.positional).toEqual(["--this-is-not-a-flag", "task"]);
  });

  it("handles --base ref alongside positional", () => {
    const r = parseArgs(["--base", "main", "focus", "on", "race", "conditions"], SCHEMA);
    expect(r.values.base).toBe("main");
    expect(r.positional).toEqual(["focus", "on", "race", "conditions"]);
  });

  it("multiple boolean flags coexist", () => {
    const r = parseArgs(["--background", "--wait", "--resume", "go"], SCHEMA);
    expect(r.flags.background).toBe(true);
    expect(r.flags.wait).toBe(true);
    expect(r.flags.resume).toBe(true);
  });
});

describe("joinPositional", () => {
  it("joins positional with single spaces", () => {
    const r = parseArgs(["--background", "hello", "world"], SCHEMA);
    expect(joinPositional(r)).toBe("hello world");
  });
  it("trims edge whitespace", () => {
    const r = parseArgs(["  hi  "], SCHEMA);
    expect(joinPositional(r)).toBe("hi");
  });
});

describe("splitArgString", () => {
  it("splits bare tokens", () => {
    expect(splitArgString("a b c")).toEqual(["a", "b", "c"]);
  });
  it("respects single-quoted groups", () => {
    expect(splitArgString("a 'b c' d")).toEqual(["a", "b c", "d"]);
  });
  it("respects double-quoted groups", () => {
    expect(splitArgString('a "b c" d')).toEqual(["a", "b c", "d"]);
  });
  it("handles backslash escapes in double quotes", () => {
    expect(splitArgString('"a\\"b" c')).toEqual(['a"b', "c"]);
  });
  it("handles literal backslash outside quotes", () => {
    expect(splitArgString("a\\ b c")).toEqual(["a b", "c"]);
  });
  it("returns [] for empty input", () => {
    expect(splitArgString("")).toEqual([]);
    expect(splitArgString(undefined)).toEqual([]);
  });
});
