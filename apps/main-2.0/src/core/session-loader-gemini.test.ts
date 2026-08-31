import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDefaultSessions } from "./session-loader";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

const roots: string[] = [];
const defaultHomeDir = os.homedir();
const originalGeminiDir = process.env.GEMINI_DIR;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
beforeEach(() => {
  delete process.env.GEMINI_DIR;
});
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (originalGeminiDir === undefined) delete process.env.GEMINI_DIR;
  else process.env.GEMINI_DIR = originalGeminiDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  vi.restoreAllMocks();
  vi.mocked(os.homedir).mockReset().mockReturnValue(defaultHomeDir);
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentrecall-gemini-v2-"));
  roots.push(root);
  return root;
}

function projectChats(root: string, slug: string, projectPath: string): string {
  const projectDir = path.join(root, ".gemini", "tmp", slug);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".project_root"), projectPath, "utf8");
  const chats = path.join(projectDir, "chats");
  fs.mkdirSync(chats, { recursive: true });
  return chats;
}

function writeChat(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");
}

function header(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionId, projectHash: "abc123", startTime: "2026-07-29T04:54:37.634Z", lastUpdated: "2026-07-29T05:00:00.000Z", ...extra };
}

describe("Gemini CLI sessions", () => {
  it("loads main sessions with messages, tokens, tool calls, and the project root", () => {
    const root = fixture();
    const chats = projectChats(root, "gemini-app", "/work/gemini-app");
    writeChat(path.join(chats, "session-2026-07-29T04-54-72d14847.jsonl"), [
      header("72d14847-09f0-4562-aa8e-f7b42bf11749"),
      { id: "m-user", timestamp: "2026-07-29T04:55:00.000Z", type: "user", content: [{ text: "Fix the login flow" }] },
      {
        id: "m-gemini",
        timestamp: "2026-07-29T04:56:00.000Z",
        type: "gemini",
        content: [{ text: "I will inspect auth.ts" }],
        thoughts: ["Consider the auth module"],
        tokens: { input: 100, output: 20, cached: 5, thoughts: 3, tool: 0, total: 125 },
        model: "gemini-2.5-pro",
        toolCalls: [{ id: "call-1", name: "read_file", displayName: "Read File", timestamp: "2026-07-29T04:56:01.000Z", args: { path: "auth.ts" }, status: "ok" }],
      },
    ]);

    const [loaded] = loadDefaultSessions({ homeDir: root, includeGeminiCli: true });

    expect(loaded.session).toMatchObject({
      sessionKey: "gemini:72d14847-09f0-4562-aa8e-f7b42bf11749",
      source: "gemini-cli",
      projectPath: "/work/gemini-app",
      isSubagent: false,
      parentSessionId: null,
    });
    expect(loaded.messages.map((message) => message.content)).toEqual(["Fix the login flow", "I will inspect auth.ts"]);
    // AgentRecall 统计口径:total = input+output+cached+reasoning(Gemini 自身的 total 字段不含 thoughts)
    expect(loaded.session.tokenUsage?.totalTokens).toBe(128);
    expect(loaded.traceEvents?.some((event) => event.kind === "tool_call" && event.callId === "call-1")).toBe(true);
    expect(loaded.traceEvents?.some((event) => event.eventType === "gemini.thought")).toBe(true);
  });

  it("rebuilds messages from checkpoints and applies rewinds", () => {
    const root = fixture();
    const chats = projectChats(root, "gemini-app", "/work/gemini-app");
    writeChat(path.join(chats, "session-2026-07-29T05-10-66fcaf99.jsonl"), [
      header("66fcaf99-1111-2222-3333-444444555555"),
      { id: "old-user", timestamp: "2026-07-29T05:10:00.000Z", type: "user", content: "stale request" },
      { id: "old-gemini", timestamp: "2026-07-29T05:11:00.000Z", type: "gemini", content: "stale answer", tokens: { input: 9, output: 9, cached: 0, thoughts: 0, tool: 0, total: 18 } },
      { $set: { messages: [
        { id: "new-user", timestamp: "2026-07-29T05:12:00.000Z", type: "user", content: "fresh request" },
        { id: "mid-gemini", timestamp: "2026-07-29T05:13:00.000Z", type: "gemini", content: "keep me", tokens: { input: 10, output: 4, cached: 0, thoughts: 0, tool: 0, total: 14 } },
        { id: "tail-gemini", timestamp: "2026-07-29T05:14:00.000Z", type: "gemini", content: "rewind past me", tokens: { input: 7, output: 7, cached: 0, thoughts: 0, tool: 0, total: 14 } },
      ] } },
      { $rewindTo: "tail-gemini" },
    ]);

    const [loaded] = loadDefaultSessions({ homeDir: root, includeGeminiCli: true });

    expect(loaded.messages.map((message) => message.content)).toEqual(["fresh request", "keep me"]);
    expect(loaded.session.tokenUsage?.totalTokens).toBe(14);
  });

  it("indexes nested subagent sessions with parent linkage", () => {
    const root = fixture();
    const chats = projectChats(root, "gemini-app", "/work/gemini-app");
    const parentId = "72d14847-09f0-4562-aa8e-f7b42bf11749";
    writeChat(path.join(chats, `session-2026-07-29T04-54-72d14847.jsonl`), [
      header(parentId),
      { id: "p-user", timestamp: "2026-07-29T04:55:00.000Z", type: "user", content: "Delegate the audit" },
    ]);
    writeChat(path.join(chats, parentId, "aaaabbbb-cccc-dddd-eeee-ffff00001111.jsonl"), [
      { sessionId: "aaaabbbb-cccc-dddd-eeee-ffff00001111", projectHash: "abc123", startTime: "2026-07-29T04:56:00.000Z", lastUpdated: "2026-07-29T04:57:00.000Z", kind: "subagent" },
      { id: "s-user", timestamp: "2026-07-29T04:56:30.000Z", type: "user", content: "Audit the middleware" },
    ]);

    const loaded = loadDefaultSessions({ homeDir: root, includeGeminiCli: true });
    const byKey = new Map(loaded.map((item) => [item.session.rawId, item.session]));

    expect(byKey.get(parentId)).toMatchObject({ isSubagent: false, parentSessionId: null });
    expect(byKey.get("aaaabbbb-cccc-dddd-eeee-ffff00001111")).toMatchObject({
      isSubagent: true,
      parentSessionId: parentId,
    });
  });

  it("uses summaries as titles and ignores temp or unreadable chat files", () => {
    const root = fixture();
    const chats = projectChats(root, "gemini-app", "/work/gemini-app");
    writeChat(path.join(chats, "session-2026-07-29T06-00-abcdef01.jsonl"), [
      header("abcdef01-0000-0000-0000-000000000001"),
      { id: "u", timestamp: "2026-07-29T06:00:30.000Z", type: "user", content: "Summarized session" },
      { $set: { summary: "Custom summary" } },
    ]);
    writeChat(path.join(chats, "session-2026-07-29T06-05-deadbeef.jsonl.tmp-123"), [header("tmp-session")]);
    writeChat(path.join(chats, "session-2026-07-29T06-06-badc0de.jsonl.unreadable-1785300000000"), [header("unreadable-session")]);

    const loaded = loadDefaultSessions({ homeDir: root, includeGeminiCli: true });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session.originalTitle).toBe("Custom summary");
  });

  it("stays out of the default index until the optional source is enabled", () => {
    const root = fixture();
    const chats = projectChats(root, "gemini-app", "/work/gemini-app");
    writeChat(path.join(chats, "session-2026-07-29T07-00-12345678.jsonl"), [
      header("12345678-0000-0000-0000-000000000002"),
      { id: "u", timestamp: "2026-07-29T07:00:30.000Z", type: "user", content: "Hidden until enabled" },
    ]);

    expect(loadDefaultSessions({ homeDir: root })).toHaveLength(0);
    expect(loadDefaultSessions({ homeDir: root, includeGeminiCli: true })).toHaveLength(1);
  });
});
