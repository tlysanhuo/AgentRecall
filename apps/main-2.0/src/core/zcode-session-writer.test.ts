import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { deleteZcodeSession, deleteZcodeSessions } from "./zcode-session-writer";

const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync;
};

function databasePath(root: string): string {
  const dbDir = path.join(root, "cli", "db");
  fs.mkdirSync(dbDir, { recursive: true });
  return path.join(dbDir, "db.sqlite");
}

function createFixture(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT);
      CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE turn_usage (session_id TEXT NOT NULL, turn_id TEXT NOT NULL);
      CREATE TABLE tool_usage (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE input_history (id TEXT PRIMARY KEY, session_id TEXT, text TEXT NOT NULL);
      CREATE TABLE session_target (session_id TEXT PRIMARY KEY, target TEXT NOT NULL);
      CREATE TABLE todo (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL);
      CREATE TABLE session_task_link (id TEXT PRIMARY KEY, parent_session_id TEXT, child_session_id TEXT);
      CREATE TABLE workflow_run (id TEXT PRIMARY KEY, parent_session_id TEXT, name TEXT);
      CREATE TABLE workflow_activity (id TEXT PRIMARY KEY, run_id TEXT, child_session_id TEXT, label TEXT);
      CREATE TABLE workflow_event (id TEXT PRIMARY KEY, run_id TEXT, type TEXT);
    `);
    db.prepare("INSERT INTO session (id, parent_id, title) VALUES (?, ?, ?)").run("sess-delete", null, "Delete me");
    db.prepare("INSERT INTO session (id, parent_id, title) VALUES (?, ?, ?)").run("sess-keep", null, "Keep me");
    db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run("msg-delete", "sess-delete", "{}");
    db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run("msg-keep", "sess-keep", "{}");
    db.prepare("INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)").run("part-delete", "msg-delete", "sess-delete", "{}");
    db.prepare("INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)").run("part-keep", "msg-keep", "sess-keep", "{}");
    db.prepare("INSERT INTO model_usage (id, session_id) VALUES (?, ?)").run("usage-delete", "sess-delete");
    db.prepare("INSERT INTO turn_usage (session_id, turn_id) VALUES (?, ?)").run("sess-delete", "turn-delete");
    db.prepare("INSERT INTO tool_usage (id, session_id) VALUES (?, ?)").run("tool-delete", "sess-delete");
    db.prepare("INSERT INTO input_history (id, session_id, text) VALUES (?, ?, ?)").run("history-delete", "sess-delete", "Delete prompt");
    db.prepare("INSERT INTO input_history (id, session_id, text) VALUES (?, ?, ?)").run("history-keep", "sess-keep", "Keep prompt");
    db.prepare("INSERT INTO session_target (session_id, target) VALUES (?, ?), (?, ?)").run(
      "sess-delete", "delete-target", "sess-keep", "keep-target",
    );
    db.prepare("INSERT INTO todo (id, session_id, content) VALUES (?, ?, ?)").run("todo-delete", "sess-delete", "todo");
    db.prepare("INSERT INTO session_task_link (id, parent_session_id, child_session_id) VALUES (?, ?, ?)").run("link-delete", "sess-delete", "sess-orphanned");
    db.prepare("INSERT INTO workflow_run (id, parent_session_id, name) VALUES (?, ?, ?)").run("run-delete", "sess-delete", "run");
    db.prepare("INSERT INTO workflow_run (id, parent_session_id, name) VALUES (?, ?, ?)").run("run-keep", "sess-keep", "run");
    db.prepare("INSERT INTO workflow_activity (id, run_id, child_session_id, label) VALUES (?, ?, ?, ?)").run("activity-delete", "run-delete", null, "act");
    db.prepare("INSERT INTO workflow_event (id, run_id, type) VALUES (?, ?, ?)").run("event-delete", "run-delete", "started");
    db.prepare("INSERT INTO workflow_event (id, run_id, type) VALUES (?, ?, ?)").run("event-keep", "run-keep", "started");
  } finally {
    db.close();
  }
}

function createCascadeFixture(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT);
      CREATE TABLE session_task_link (id TEXT PRIMARY KEY, parent_session_id TEXT, child_session_id TEXT);
    `);
    db.prepare("INSERT INTO session (id, parent_id, title) VALUES (?, ?, ?)").run("root", null, "Root");
    db.prepare("INSERT INTO session (id, parent_id, title) VALUES (?, ?, ?)").run("child", "root", "Child via parent_id");
    db.prepare("INSERT INTO session (id, parent_id, title) VALUES (?, ?, ?)").run("grandchild", null, "Grandchild via task link");
    db.prepare("INSERT INTO session (id, parent_id, title) VALUES (?, ?, ?)").run("sess-keep", null, "Keep me");
    db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run("msg-child", "child", "{}");
    db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run("msg-grandchild", "grandchild", "{}");
    db.prepare("INSERT INTO session_task_link (id, parent_session_id, child_session_id) VALUES (?, ?, ?)").run("link-1", "child", "grandchild");
  } finally {
    db.close();
  }
}

function createTaskIndexFixture(
  root: string,
  options: { softDelete: boolean },
  taskIds: readonly string[] = ["sess-delete", "sess-keep"],
): string {
  const taskIndexDirectory = path.join(root, "v2");
  fs.mkdirSync(taskIndexDirectory, { recursive: true });
  const taskIndexPath = path.join(taskIndexDirectory, "tasks-index.sqlite");
  const db = new DatabaseSync(taskIndexPath);
  try {
    if (options.softDelete) {
      db.exec(`
        CREATE TABLE tasks (task_id TEXT PRIMARY KEY, title TEXT, deleted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE task_group_members (group_id TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY (group_id, task_id));
        CREATE TABLE task_group_view_node_orders (node_type TEXT NOT NULL, node_key TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (node_type, node_key));
      `);
      db.prepare(`INSERT INTO tasks (task_id, title) VALUES ${taskIds.map(() => "(?, '')").join(", ")}`).run(...taskIds);
      const groupId = "group-a";
      db.prepare(`INSERT INTO task_group_members (group_id, task_id) VALUES ${taskIds.map(() => "(?, ?)").join(", ")}`).run(
        ...taskIds.flatMap((taskId) => [groupId, taskId]),
      );
      db.prepare(
        `INSERT INTO task_group_view_node_orders (node_type, node_key, sort_order) VALUES ${taskIds.map(() => "('task', ?, ?)").join(", ")}`,
      ).run(...taskIds.flatMap((taskId, index) => [taskId, index]));
      db.prepare("INSERT INTO task_group_view_node_orders (node_type, node_key, sort_order) VALUES ('group', ?, 0)").run(groupId);
    } else {
      db.exec("CREATE TABLE tasks (task_id TEXT PRIMARY KEY, title TEXT)");
      db.prepare(`INSERT INTO tasks (task_id, title) VALUES ${taskIds.map(() => "(?, 'Task')").join(", ")}`).run(...taskIds);
    }
  } finally {
    db.close();
  }
  return taskIndexPath;
}

describe("ZCode session writer", () => {
  it("deletes one session and all supported related records without touching other sessions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-zcode-delete-"));
    const dbPath = databasePath(root);
    createFixture(dbPath);
    const taskIndexPath = createTaskIndexFixture(root, { softDelete: true });

    expect(deleteZcodeSession(dbPath, "sess-delete")).toBe(true);

    expect(fs.existsSync(`${dbPath}.bak`)).toBe(true);
    const backup = new DatabaseSync(`${dbPath}.bak`);
    try {
      expect(backup.prepare("SELECT COUNT(*) AS count FROM session").get()).toEqual({ count: 2 });
    } finally {
      backup.close();
    }

    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare("SELECT id FROM session ORDER BY id").all()).toEqual([{ id: "sess-keep" }]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get("sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM part WHERE session_id = ?").get("sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM model_usage WHERE session_id = ?").get("sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM turn_usage WHERE session_id = ?").get("sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM tool_usage WHERE session_id = ?").get("sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM input_history WHERE session_id = ?").get("sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM session_target WHERE session_id = ?").get("sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM todo WHERE session_id = ?").get("sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM session_task_link WHERE parent_session_id = ? OR child_session_id = ?").get("sess-delete", "sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM workflow_run WHERE parent_session_id = ?").get("sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM workflow_run").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM workflow_activity").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM workflow_event WHERE run_id = ?").get("run-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM workflow_event WHERE run_id = ?").get("run-keep")).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get("sess-keep")).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM input_history WHERE session_id = ?").get("sess-keep")).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM session_target WHERE session_id = ?").get("sess-keep")).toEqual({ count: 1 });
    } finally {
      db.close();
    }
    const taskIndex = new DatabaseSync(taskIndexPath);
    try {
      expect(taskIndex.prepare("SELECT task_id, deleted FROM tasks ORDER BY task_id").all()).toEqual([
        { task_id: "sess-delete", deleted: 1 },
        { task_id: "sess-keep", deleted: 0 },
      ]);
      const deletedTask = taskIndex.prepare("SELECT updated_at FROM tasks WHERE task_id = ?").get("sess-delete") as { updated_at: number };
      expect(deletedTask.updated_at).toBeGreaterThan(0);
      expect(taskIndex.prepare("SELECT task_id FROM task_group_members ORDER BY task_id").all()).toEqual([{ task_id: "sess-keep" }]);
      expect(taskIndex.prepare("SELECT node_type, node_key FROM task_group_view_node_orders ORDER BY node_key").all()).toEqual([
        { node_type: "group", node_key: "group-a" },
        { node_type: "task", node_key: "sess-keep" },
      ]);
    } finally {
      taskIndex.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns false for a missing session and refuses non-ZCode paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-zcode-delete-missing-"));
    const dbPath = databasePath(root);
    createFixture(dbPath);

    expect(deleteZcodeSession(dbPath, "does-not-exist")).toBe(false);
    expect(fs.existsSync(`${dbPath}.bak`)).toBe(false);
    expect(() => deleteZcodeSession(path.join(root, "other.sqlite"), "sess-delete")).toThrow(/non-ZCode database path/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("deletes multiple sessions from one shared database operation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-zcode-delete-many-"));
    const dbPath = databasePath(root);
    createFixture(dbPath);
    const taskIndexPath = createTaskIndexFixture(root, { softDelete: true });

    expect(deleteZcodeSessions(dbPath, ["sess-delete", "sess-keep", "sess-delete"])).toEqual(["sess-delete", "sess-keep"]);

    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare("SELECT id FROM session").all()).toEqual([]);
      expect(db.prepare("SELECT session_id FROM message").all()).toEqual([]);
      expect(db.prepare("SELECT session_id FROM part").all()).toEqual([]);
    } finally {
      db.close();
    }
    const taskIndex = new DatabaseSync(taskIndexPath);
    try {
      expect(taskIndex.prepare("SELECT deleted FROM tasks").all()).toEqual([{ deleted: 1 }, { deleted: 1 }]);
      expect(taskIndex.prepare("SELECT COUNT(*) AS count FROM task_group_members").get()).toEqual({ count: 0 });
      expect(taskIndex.prepare("SELECT node_type FROM task_group_view_node_orders").all()).toEqual([{ node_type: "group" }]);
    } finally {
      taskIndex.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes descendant sub-agent sessions linked through parent_id and session_task_link", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-zcode-delete-cascade-"));
    const dbPath = databasePath(root);
    createCascadeFixture(dbPath);
    const taskIndexPath = createTaskIndexFixture(root, { softDelete: true }, ["root", "child", "grandchild", "sess-keep"]);

    expect(deleteZcodeSessions(dbPath, ["root"])).toEqual(["root"]);

    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare("SELECT id FROM session ORDER BY id").all()).toEqual([{ id: "sess-keep" }]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get("grandchild")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get("child")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM session_task_link").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
    const taskIndex = new DatabaseSync(taskIndexPath);
    try {
      expect(taskIndex.prepare("SELECT task_id, deleted FROM tasks ORDER BY task_id").all()).toEqual([
        { task_id: "child", deleted: 1 },
        { task_id: "grandchild", deleted: 1 },
        { task_id: "root", deleted: 1 },
        { task_id: "sess-keep", deleted: 0 },
      ]);
    } finally {
      taskIndex.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not delete ancestor sessions when removing a single sub-agent session", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-zcode-delete-child-"));
    const dbPath = databasePath(root);
    createCascadeFixture(dbPath);

    expect(deleteZcodeSessions(dbPath, ["grandchild"])).toEqual(["grandchild"]);

    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare("SELECT id FROM session ORDER BY id").all()).toEqual([
        { id: "child" },
        { id: "root" },
        { id: "sess-keep" },
      ]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get("grandchild")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get("child")).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM session_task_link").get()).toEqual({ count: 0 });
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to hard task deletion when the task index has no deleted column", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-zcode-delete-legacy-"));
    const dbPath = databasePath(root);
    createFixture(dbPath);
    const taskIndexPath = createTaskIndexFixture(root, { softDelete: false });

    expect(deleteZcodeSession(dbPath, "sess-delete")).toBe(true);

    const taskIndex = new DatabaseSync(taskIndexPath);
    try {
      expect(taskIndex.prepare("SELECT task_id FROM tasks ORDER BY task_id").all()).toEqual([{ task_id: "sess-keep" }]);
    } finally {
      taskIndex.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back the main database when the task index deletion fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-zcode-delete-rollback-"));
    const dbPath = databasePath(root);
    createFixture(dbPath);
    const taskIndexPath = createTaskIndexFixture(root, { softDelete: true });
    const taskIndex = new DatabaseSync(taskIndexPath);
    try {
      taskIndex.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TRIGGER reject_task_soft_delete
        BEFORE UPDATE OF deleted ON tasks
        WHEN NEW.deleted = 1
        BEGIN
          SELECT RAISE(ABORT, 'task deletion rejected');
        END;
      `);
    } finally {
      taskIndex.close();
    }

    try {
      expect(() => deleteZcodeSession(dbPath, "sess-delete")).toThrow("task deletion rejected");
      expect(fs.existsSync(`${dbPath}.bak`)).toBe(true);
      const mainDatabase = new DatabaseSync(dbPath);
      try {
        expect(mainDatabase.prepare("SELECT id FROM session WHERE id = ?").get("sess-delete")).toEqual({ id: "sess-delete" });
      } finally {
        mainDatabase.close();
      }
      const remainingTaskIndex = new DatabaseSync(taskIndexPath);
      try {
        expect(remainingTaskIndex.prepare("SELECT deleted FROM tasks WHERE task_id = ?").get("sess-delete")).toEqual({ deleted: 0 });
      } finally {
        remainingTaskIndex.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
