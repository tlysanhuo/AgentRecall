import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadOpenCodeSessions } from "./session-loader";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync };

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentrecall-opencode-v2-${name}-`));
}

describe("OpenCode session loading", () => {
  it("marks subagent sessions via session.parent_id", () => {
    const root = tmpDir("subagent");
    const shareDir = path.join(root, ".local", "share", "opencode");
    fs.mkdirSync(shareDir, { recursive: true });
    const dbPath = path.join(shareDir, "opencode.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    const insertSession = db.prepare("INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)");
    insertSession.run("opencode-root", null, "/work/opencode-app", "Root session", 1_000, 2_000);
    insertSession.run("opencode-child", "opencode-root", "/work/opencode-app", "Subagent session", 1_100, 1_900);
    const insertMessage = db.prepare("INSERT INTO message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)");
    const insertPart = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)");
    insertMessage.run("msg-root-user", "opencode-root", "user", 1_100, JSON.stringify({ role: "user" }));
    insertPart.run("part-root-user", "msg-root-user", "opencode-root", 1_100, JSON.stringify({ type: "text", text: "Audit the auth flow" }));
    insertMessage.run("msg-child-user", "opencode-child", "user", 1_200, JSON.stringify({ role: "user" }));
    insertPart.run("part-child-user", "msg-child-user", "opencode-child", 1_200, JSON.stringify({ type: "text", text: "Inspect middleware" }));
    db.close();

    const loaded = loadOpenCodeSessions(root);

    expect(loaded).toHaveLength(2);
    const byKey = new Map(loaded.map((item) => [item.session.sessionKey, item.session]));
    expect(byKey.get("opencode:opencode-root")).toMatchObject({ isSubagent: false, parentSessionId: null });
    expect(byKey.get("opencode:opencode-child")).toMatchObject({
      sessionKey: "opencode:opencode-child",
      isSubagent: true,
      parentSessionId: "opencode-root",
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("treats sessions as top-level when the schema has no parent_id column", () => {
    const root = tmpDir("legacy-schema");
    const shareDir = path.join(root, ".local", "share", "opencode");
    fs.mkdirSync(shareDir, { recursive: true });
    const dbPath = path.join(shareDir, "opencode.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)").run(
      "opencode-legacy",
      "/work/opencode-app",
      "Legacy schema session",
      1_000,
      2_000,
    );
    db.prepare("INSERT INTO message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
      "msg-legacy-user",
      "opencode-legacy",
      "user",
      1_100,
      JSON.stringify({ role: "user" }),
    );
    db.close();

    const loaded = loadOpenCodeSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "opencode:opencode-legacy",
      isSubagent: false,
      parentSessionId: null,
    });

    fs.rmSync(root, { recursive: true, force: true });
  });
});
