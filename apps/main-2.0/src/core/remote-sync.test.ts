import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createInMemoryStore } from "./postgres/test-session-store";
import { syncRemoteEnvironment } from "./remote-sync";

function decodeCollectorScript(command: string): string {
  const encoded = command.match(/b64decode\("([^"]+)"\)/)?.[1] ?? "";
  return inflateRawSync(Buffer.from(encoded, "base64")).toString("utf8");
}

describe("remote sync", () => {
  it("keeps Codex parent and child sessions distinct when a child rollout contains inherited parent metadata", async () => {
    const store = createInMemoryStore();
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-remote-codex-"));
    const parentId = "parent-session";
    const childId = "child-session";
    const parentPath = path.join(tempHome, ".codex", "sessions", "2026", "08", "20", "parent.jsonl");
    const childPath = path.join(tempHome, ".codex", "sessions", "2026", "08", "20", "child.jsonl");
    const sessionIdOnlyPath = path.join(tempHome, ".codex", "sessions", "2026", "08", "20", "session-id-only.jsonl");
    const writeJsonl = (filePath: string, rows: unknown[]) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");
    };

    try {
      writeJsonl(parentPath, [
        {
          type: "session_meta",
          timestamp: "2026-08-20T06:31:06.970Z",
          payload: { id: parentId, cwd: "/workspace/parent", source: "user" },
        },
        {
          type: "response_item",
          timestamp: "2026-08-20T06:32:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "parent question" }],
          },
        },
      ]);
      writeJsonl(childPath, [
        {
          type: "session_meta",
          timestamp: "2026-08-20T06:33:00.000Z",
          payload: {
            id: childId,
            session_id: parentId,
            forked_from_id: parentId,
            cwd: "<local-workspace>",
            thread_source: "subagent",
            parent_thread_id: parentId,
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: parentId,
                  depth: 1,
                },
              },
            },
          },
        },
        {
          type: "session_meta",
          timestamp: "2026-08-20T06:33:30.000Z",
          payload: {
            id: childId,
            session_id: parentId,
            cwd: "/workspace/child",
          },
        },
        {
          type: "session_meta",
          timestamp: "2026-08-20T06:31:06.970Z",
          payload: {
            id: parentId,
            session_id: parentId,
            cwd: "/workspace/parent",
            thread_source: "user",
            source: "user",
          },
        },
        {
          type: "response_item",
          timestamp: "2026-08-20T06:34:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "child task" }],
          },
        },
      ]);
      writeJsonl(sessionIdOnlyPath, [
        {
          type: "session_meta",
          timestamp: "2026-08-20T06:35:00.000Z",
          payload: {
            session_id: "semantic-session-id",
            cwd: "/workspace/legacy",
          },
        },
        {
          type: "response_item",
          timestamp: "2026-08-20T06:36:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "legacy identity question" }],
          },
        },
      ]);
      fs.utimesSync(parentPath, new Date(2_000), new Date(2_000));
      fs.utimesSync(childPath, new Date(1_000), new Date(1_000));

      const environment = await store.upsertEnvironment({
        id: "ssh-devbox",
        kind: "ssh",
        label: "devbox",
        hostAlias: "devbox",
        host: "devbox.example.com",
        authMode: "none",
        enabled: true,
      });
      await syncRemoteEnvironment(store, environment, {
        runSsh: async (_environment, command) => execFileSync(
          process.platform === "win32" ? "python" : "python3",
          ["-c", decodeCollectorScript(command)],
          {
            encoding: "utf8",
            env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
          },
        ),
      });

      await expect(store.getSession(`ssh:${environment.id}:codex-cli:${parentId}`)).resolves.toMatchObject({
        rawId: parentId,
        projectPath: "/workspace/parent",
        isSubagent: false,
        parentSessionId: null,
      });
      await expect(store.getSession(`ssh:${environment.id}:codex-cli:${childId}`)).resolves.toMatchObject({
        rawId: childId,
        projectPath: "/workspace/child",
        isSubagent: true,
        parentSessionId: parentId,
        timestamp: Date.parse("2026-08-20T06:33:00.000Z"),
      });
      await expect(store.getSession(`ssh:${environment.id}:codex-cli:session-id-only`)).resolves.toMatchObject({
        rawId: "session-id-only",
        projectPath: "/workspace/legacy",
      });
      await expect(store.getSession(`ssh:${environment.id}:codex-cli:semantic-session-id`)).resolves.toBeNull();
      const rootSessions = await store.searchSessions({
        environmentId: environment.id,
        excludeSubagents: true,
      });
      expect(rootSessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ rawId: parentId }),
        expect.objectContaining({ rawId: "session-id-only" }),
      ]));
      expect(rootSessions).toHaveLength(2);
    } finally {
      await store.close();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps CodeWiz subagent sessions linked to their parent during remote collection", async () => {
    const store = createInMemoryStore();
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-remote-codewiz-"));
    const codewizDir = path.join(tempHome, ".local", "share", "codewiz");
    fs.mkdirSync(codewizDir, { recursive: true });
    const codewizDbPath = path.join(codewizDir, "opencode.db");
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      [
        "-c",
        String.raw`
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript('''
CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER, parent_id TEXT);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
''')
db.execute("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)", ("codewiz-parent", "/repo/codewiz", "CodeWiz parent", 1780560000000, 1780560600000))
db.execute("INSERT INTO session (id, directory, title, time_created, time_updated, parent_id) VALUES (?, ?, ?, ?, ?, ?)", ("codewiz-child", "/repo/codewiz", "CodeWiz child", 1780560000000, 1780560600000, "codewiz-parent"))
db.execute("INSERT INTO message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)", ("cw-user", "codewiz-parent", "user", 1780560060000, json.dumps({"role": "user"})))
db.execute("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)", ("cw-user-part", "cw-user", "codewiz-parent", 1780560060000, json.dumps({"type": "text", "text": "codewiz parent question"})))
db.execute("INSERT INTO message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)", ("cw-child-user", "codewiz-child", "user", 1780560060000, json.dumps({"role": "user"})))
db.execute("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)", ("cw-child-user-part", "cw-child-user", "codewiz-child", 1780560060000, json.dumps({"type": "text", "text": "codewiz child question"})))
db.commit()
db.close()
`,
        codewizDbPath,
      ],
      { encoding: "utf8" },
    );

    try {
      const environment = await store.upsertEnvironment({
        id: "ssh-devbox",
        kind: "ssh",
        label: "devbox",
        hostAlias: "devbox",
        host: "devbox.example.com",
        authMode: "none",
        enabled: true,
      });
      await syncRemoteEnvironment(store, environment, {
        runSsh: async (_environment, command) => execFileSync(
          process.platform === "win32" ? "python" : "python3",
          ["-c", decodeCollectorScript(command)],
          {
            encoding: "utf8",
            env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
          },
        ),
      });

      await expect(store.getSession(`ssh:${environment.id}:codewiz:codewiz-parent`)).resolves.toMatchObject({
        rawId: "codewiz-parent",
        isSubagent: false,
        parentSessionId: null,
      });
      await expect(store.getSession(`ssh:${environment.id}:codewiz:codewiz-child`)).resolves.toMatchObject({
        rawId: "codewiz-child",
        isSubagent: true,
        parentSessionId: "codewiz-parent",
      });
      const rootSessions = await store.searchSessions({
        environmentId: environment.id,
        excludeSubagents: true,
      });
      expect(rootSessions).toHaveLength(1);
      expect(rootSessions[0]?.rawId).toBe("codewiz-parent");
    } finally {
      await store.close();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 20_000);
});
