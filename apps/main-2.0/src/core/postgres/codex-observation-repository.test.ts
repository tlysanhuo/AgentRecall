import { afterEach, describe, expect, it } from "vitest";
import { PostgresDatabase } from "./database";
import { POSTGRES_MIGRATIONS } from "./schema";
import { PGliteTestPool } from "./test-pglite";
import { PostgresCodexObservationRepository } from "./codex-observation-repository";

const databases: PostgresDatabase[] = [];

async function createRepository(): Promise<PostgresCodexObservationRepository> {
  const database = new PostgresDatabase(new PGliteTestPool(), {
    migrationLock: false,
    migrations: POSTGRES_MIGRATIONS,
  });
  databases.push(database);
  await database.initialize();
  return new PostgresCodexObservationRepository(database);
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("PostgresCodexObservationRepository", () => {
  it("persists lifecycle and integrity independently and interrupts stale turns", async () => {
    const repository = await createRepository();
    const created = await repository.createSession({
      id: "obs-1",
      title: "New observation",
      workDir: "/repo",
      modelId: null,
      reasoningEffort: null,
      recordKey: "obs-1",
      now: "2026-08-05T00:00:00.000Z",
    });
    await repository.createTurn({
      id: "turn-1",
      sessionId: created.id,
      turnIndex: 1,
      prompt: "inspect this",
      startedAt: "2026-08-05T00:01:00.000Z",
    });
    await repository.updateSession(created.id, {
      lifecycleState: "running",
      integrityState: "incomplete",
      threadId: "thread-1",
      updatedAt: "2026-08-05T00:01:00.000Z",
    });

    await repository.markInterrupted("2026-08-05T00:02:00.000Z");

    expect(await repository.getSession(created.id)).toMatchObject({
      lifecycleState: "error",
      integrityState: "incomplete",
      threadId: "thread-1",
      lastError: "AgentRecall stopped before this observation completed.",
    });
    expect((await repository.listTurns(created.id))[0]).toMatchObject({
      status: "interrupted",
      endedAt: "2026-08-05T00:02:00.000Z",
    });
  });

  it("lists newest sessions first and cascades their turns on delete", async () => {
    const repository = await createRepository();
    for (const [id, now] of [["obs-old", "2026-08-05T00:00:00.000Z"], ["obs-new", "2026-08-05T01:00:00.000Z"]] as const) {
      await repository.createSession({
        id,
        title: id,
        workDir: "/repo",
        modelId: "gpt-5",
        reasoningEffort: "high",
        recordKey: id,
        now,
      });
    }
    await repository.createTurn({
      id: "turn-new",
      sessionId: "obs-new",
      turnIndex: 1,
      prompt: "hello",
      startedAt: "2026-08-05T01:00:01.000Z",
    });
    await repository.updateTurn("turn-new", {
      nativeTurnId: "native-turn",
      assistantText: "done",
      status: "completed",
      usage: { inputTokens: 3, outputTokens: 2 },
      endedAt: "2026-08-05T01:00:02.000Z",
    });

    expect((await repository.listSessions()).map((session) => session.id)).toEqual(["obs-new", "obs-old"]);
    expect((await repository.listTurns("obs-new"))[0]).toMatchObject({
      nativeTurnId: "native-turn",
      assistantText: "done",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(await repository.deleteSession("obs-new")).toBe(true);
    expect(await repository.listTurns("obs-new")).toEqual([]);
    expect(await repository.deleteSession("obs-new")).toBe(false);
  });
});
