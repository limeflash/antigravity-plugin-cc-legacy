import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  agyStoreDir,
  parseStoreDir,
  parseConversationId,
  extractAnswerFromTranscript,
  transcriptPathFor,
  conversationIdForWorkspace,
  readTranscriptAnswer,
  captureAnswer,
} from "../plugins/agy/scripts/lib/transcript.mjs";

const CID = "3e6627ad-6b64-48d3-a918-7eff8d87309b";

// A realistic transcript: user input, history, two tool-call/result pairs,
// then the final answer — matching what agy 1.0.3 writes for a review.
function transcriptFixture(answer = "FINAL ANSWER") {
  return [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>review</USER_REQUEST>" },
    { step_index: 1, source: "SYSTEM", type: "CONVERSATION_HISTORY" },
    { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", tool_calls: [{ name: "list_dir" }] },
    { step_index: 3, source: "MODEL", type: "LIST_DIRECTORY", content: "tool result noise — must be skipped" },
    { step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", tool_calls: [{ name: "view_file" }] },
    { step_index: 6, source: "MODEL", type: "VIEW_FILE", content: "file contents — must be skipped" },
    { step_index: 7, source: "MODEL", type: "PLANNER_RESPONSE", content: answer },
  ]
    .map((o) => JSON.stringify(o))
    .join("\n");
}

describe("agyStoreDir", () => {
  it("honors AGY_STORE_DIR above everything", () => {
    expect(agyStoreDir({ AGY_STORE_DIR: "/custom/store", GEMINI_DIR: "/x" })).toBe("/custom/store");
  });
  it("derives from GEMINI_DIR when set", () => {
    expect(agyStoreDir({ GEMINI_DIR: path.join("/home", "u", ".gemini") })).toBe(
      path.join("/home", "u", ".gemini", "antigravity-cli"),
    );
  });
  it("defaults to <homedir>/.gemini/antigravity-cli", () => {
    expect(agyStoreDir({}, "/home/u")).toBe(path.join("/home", "u", ".gemini", "antigravity-cli"));
  });
});

describe("parseConversationId", () => {
  it("extracts the uuid from a real 'Created conversation' log line", () => {
    const log = `I0531 03:59:20.696954 5280 server.go:755] Created conversation ${CID}\nmore`;
    expect(parseConversationId(log)).toBe(CID);
  });
  it("returns the LAST id when several are present", () => {
    const other = "11111111-2222-3333-4444-555555555555";
    expect(parseConversationId(`Created conversation ${other}\nCreated conversation ${CID}`)).toBe(CID);
  });
  it("returns null when no id is present", () => {
    expect(parseConversationId("no conversation here")).toBeNull();
    expect(parseConversationId("")).toBeNull();
    expect(parseConversationId(null)).toBeNull();
  });
  it("does not match a non-uuid token", () => {
    expect(parseConversationId("Created conversation not-a-uuid")).toBeNull();
  });
});

describe("parseStoreDir", () => {
  it("reads agy's reported data dir from the log (Windows path)", () => {
    const log = "I0531 03:59:18 common.go:203] CLI app data directory: C:\\Users\\ennan\\.gemini\\antigravity-cli\r\n";
    expect(parseStoreDir(log)).toBe("C:\\Users\\ennan\\.gemini\\antigravity-cli");
  });
  it("reads a POSIX data dir (macOS / Linux / WSL)", () => {
    expect(parseStoreDir("CLI app data directory: /home/u/.gemini/antigravity-cli\n")).toBe(
      "/home/u/.gemini/antigravity-cli",
    );
  });
  it("returns the last match and null when absent", () => {
    expect(parseStoreDir("CLI app data directory: /a\nCLI app data directory: /b\n")).toBe("/b");
    expect(parseStoreDir("nothing here")).toBeNull();
    expect(parseStoreDir("")).toBeNull();
  });
});

describe("extractAnswerFromTranscript", () => {
  it("returns only the model's PLANNER_RESPONSE text, skipping tool calls + results", () => {
    expect(extractAnswerFromTranscript(transcriptFixture("hello world"))).toBe("hello world");
  });
  it("joins multiple PLANNER_RESPONSE content blocks with a blank line", () => {
    const jsonl = [
      { source: "MODEL", type: "PLANNER_RESPONSE", content: "part one" },
      { source: "MODEL", type: "VIEW_FILE", content: "noise" },
      { source: "MODEL", type: "PLANNER_RESPONSE", content: "part two" },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n");
    expect(extractAnswerFromTranscript(jsonl)).toBe("part one\n\npart two");
  });
  it("tolerates blank and malformed lines", () => {
    const jsonl = `\n{ not json }\n${JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: "ok" })}\n\n`;
    expect(extractAnswerFromTranscript(jsonl)).toBe("ok");
  });
  it("returns empty string when there is no model text", () => {
    expect(extractAnswerFromTranscript("")).toBe("");
    expect(
      extractAnswerFromTranscript(JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", tool_calls: [{ name: "x" }] })),
    ).toBe("");
  });
});

describe("transcriptPathFor", () => {
  it("builds the brain/<id>/.system_generated/logs path", () => {
    expect(transcriptPathFor("/store", CID)).toBe(
      path.join("/store", "brain", CID, ".system_generated", "logs", "transcript.jsonl"),
    );
  });
});

describe("store-backed helpers", () => {
  let store;
  beforeEach(async () => {
    store = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-store-"));
    const logsDir = path.join(store, "brain", CID, ".system_generated", "logs");
    await fsp.mkdir(logsDir, { recursive: true });
    await fsp.writeFile(path.join(logsDir, "transcript.jsonl"), transcriptFixture("captured!"));
    await fsp.mkdir(path.join(store, "cache"), { recursive: true });
    await fsp.writeFile(
      path.join(store, "cache", "last_conversations.json"),
      JSON.stringify({ "C:\\Users\\me\\proj": CID }),
    );
  });
  afterEach(async () => {
    await fsp.rm(store, { recursive: true, force: true });
  });

  it("readTranscriptAnswer reads the model answer", async () => {
    const { answer, transcriptPath } = await readTranscriptAnswer(store, CID, { retries: 0 });
    expect(answer).toBe("captured!");
    expect(transcriptPath).toContain(CID);
  });

  it("readTranscriptAnswer returns empty for an unknown conversation (no retry wait)", async () => {
    const { answer } = await readTranscriptAnswer(store, "00000000-0000-0000-0000-000000000000", {
      retries: 1,
      delayMs: 1,
    });
    expect(answer).toBe("");
  });

  it("conversationIdForWorkspace matches case- and separator-insensitively", async () => {
    expect(await conversationIdForWorkspace(store, "c:/users/me/proj")).toBe(CID);
    expect(await conversationIdForWorkspace(store, "C:\\Users\\me\\proj\\")).toBe(CID);
    expect(await conversationIdForWorkspace(store, "C:\\Users\\me\\other")).toBeNull();
  });

  it("captureAnswer recovers the answer via the log-file conversation id", async () => {
    const logFile = path.join(store, "run.log");
    await fsp.writeFile(logFile, `server.go:755] Created conversation ${CID}\n`);
    const { answer, conversationId } = await captureAnswer({ logFile, env: { AGY_STORE_DIR: store } });
    expect(conversationId).toBe(CID);
    expect(answer).toBe("captured!");
  });

  it("captureAnswer falls back to the workspace map when the log has no id", async () => {
    const logFile = path.join(store, "run.log");
    await fsp.writeFile(logFile, "no id in this log\n");
    const { answer, conversationId } = await captureAnswer({
      logFile,
      cwd: "C:\\Users\\me\\proj",
      env: { AGY_STORE_DIR: store },
    });
    expect(conversationId).toBe(CID);
    expect(answer).toBe("captured!");
  });

  it("captureAnswer returns empty (no throw) when nothing matches", async () => {
    const { answer, conversationId } = await captureAnswer({
      logFile: path.join(store, "missing.log"),
      env: { AGY_STORE_DIR: store },
    });
    expect(conversationId).toBeNull();
    expect(answer).toBe("");
  });

  it("captureAnswer self-locates the store from the log's app-data-dir line (no env)", async () => {
    const logFile = path.join(store, "run.log");
    await fsp.writeFile(
      logFile,
      `common.go:203] CLI app data directory: ${store}\nserver.go:755] Created conversation ${CID}\n`,
    );
    const { answer, conversationId, storeDir } = await captureAnswer({ logFile, env: {} });
    expect(storeDir).toBe(store);
    expect(conversationId).toBe(CID);
    expect(answer).toBe("captured!");
  });
});
