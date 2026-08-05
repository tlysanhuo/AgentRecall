import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexRpcClientOptions } from "../../automation/engine/main/agents/codex/codex-rpc";
import type { AgentEvent } from "../../automation/engine/shared/types";
import { PostgresCodexObservationRepository } from "../../core/postgres/codex-observation-repository";
import { PostgresDatabase } from "../../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../../core/postgres/schema";
import { PGliteTestPool } from "../../core/postgres/test-pglite";
import { CodexObservationJournal } from "./codex-observation-journal";
import { CodexObservationService } from "./codex-observation-service";

const temporaryDirectories: string[] = [];
const databases: PostgresDatabase[] = [];
const INTERRUPTED_MESSAGE = "AgentRecall stopped before this observation completed.";

class FakeCodexHost {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly responses: Array<{ id: number; result: Record<string, unknown> }> = [];
  shutdownCount = 0;
  private options: CodexRpcClientOptions | null = null;
  private turnIndex = 0;

  readonly createClient = (options: CodexRpcClientOptions) => {
    this.options = options;
    return {
      start: async () => undefined,
      request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        this.requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "thread/resume") return { thread: { id: params.threadId } };
        if (method === "turn/start") return { turn: { id: `native-turn-${++this.turnIndex}` } };
        return {};
      },
      respond: (id: number, result: Record<string, unknown>) => {
        this.responses.push({ id, result });
      },
      respondError: () => undefined,
      interruptTurn: async (threadId: string, turnId: string | undefined) => {
        this.requests.push({ method: "turn/cancel", params: { threadId, turnId } });
      },
      shutdown: async () => { this.shutdownCount += 1; },
    };
  };

  emit(event: AgentEvent): void {
    this.options?.onEvent(event);
  }

  request(id: number, method: string, params: Record<string, unknown>): void {
    this.options?.onRequest?.(id, method, params);
  }

  exit(stderr = "unexpected exit"): void {
    this.options?.onExit?.(1, null, stderr);
  }
}

async function createFixture(options: {
  openJournal?: typeof CodexObservationJournal.open;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-recall-observation-service-"));
  temporaryDirectories.push(root);
  const workDir = path.join(root, "repo");
  const userDataPath = path.join(root, "user-data");
  const homePath = path.join(root, "home");
  const codexHome = path.join(root, "codex-home");
  await Promise.all([workDir, userDataPath, homePath, codexHome].map((directory) => mkdir(directory, {
    recursive: true,
  })));
  const database = new PostgresDatabase(new PGliteTestPool(), {
    migrationLock: false,
    migrations: POSTGRES_MIGRATIONS,
  });
  databases.push(database);
  await database.initialize();
  const repository = new PostgresCodexObservationRepository(database);
  const fake = new FakeCodexHost();
  let nextId = 0;
  const service = new CodexObservationService({
    repository,
    userDataPath,
    homePath,
    codexHome,
    codexExecutable: "synthetic-codex",
    createClient: fake.createClient,
    readCodexVersion: async () => "codex-cli 1.2.3",
    createId: () => `id-${++nextId}`,
    ...(options.openJournal ? { openJournal: options.openJournal } : {}),
  });
  await service.initialize();
  return { root, workDir, userDataPath, codexHome, database, repository, fake, service };
}

async function writeRollout(codexHome: string): Promise<string> {
  const directory = path.join(codexHome, "sessions", "2026", "08", "05");
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "rollout-thread-1.jsonl");
  await writeFile(filePath, `${[
    { type: "session_meta", payload: { id: "thread-1", base_instructions: "system" } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ text: "developer" }] } },
  ].map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return filePath;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("CodexObservationService", () => {
  it("records a dedicated multi-turn thread and resumes it after stop", async () => {
    const { service, fake, workDir, codexHome } = await createFixture();
    await writeRollout(codexHome);
    const session = await service.createSession({ workDir, modelId: null, reasoningEffort: null });
    const first = await service.sendMessage(session.id, "first prompt");
    fake.emit({ type: "delta", content: "first answer" });
    fake.emit({ type: "completed" });
    await vi.waitFor(async () => {
      expect((await service.getSession(session.id)).turns[0]).toMatchObject({
        assistantText: "first answer",
        status: "completed",
      });
    });
    await service.stopSession(session.id);
    const second = await service.sendMessage(session.id, "second prompt");

    expect(first.turnIndex).toBe(1);
    expect(second.turnIndex).toBe(2);
    expect(fake.requests.map((request) => request.method)).toContain("thread/resume");
    expect((await service.getSession(session.id)).context).toMatchObject({
      status: "available",
      systemInstructions: "system",
      codexVersion: "codex-cli 1.2.3",
    });
  });

  it("enforces one active turn, resolves approvals, and cancels by native turn id", async () => {
    const { service, fake, workDir, codexHome } = await createFixture();
    await writeRollout(codexHome);
    const session = await service.createSession({ workDir, modelId: "gpt-5", reasoningEffort: "high" });
    await service.sendMessage(session.id, "run command");
    await expect(service.sendMessage(session.id, "too soon")).rejects.toThrow(/already running/i);

    fake.request(42, "item/commandExecution/requestApproval", { command: "npm test" });
    await vi.waitFor(async () => {
      expect((await service.getSession(session.id)).pendingApproval?.requestId).toMatch(/^runtime-approval:/u);
    });
    const requestId = (await service.getSession(session.id)).pendingApproval!.requestId;
    await service.resolveApproval({ sessionId: session.id, requestId, decision: "approved" });
    await vi.waitFor(() => expect(fake.responses).toContainEqual({ id: 42, result: { decision: "accept" } }));

    await service.cancelTurn(session.id);
    expect(fake.requests).toContainEqual({
      method: "turn/cancel",
      params: { threadId: "thread-1", turnId: "native-turn-1" },
    });
    const detail = await service.getSession(session.id);
    expect(detail.turns[0]?.status).toBe("cancelled");
    expect(detail.session.integrityState).toBe("complete");
    expect((await service.readEvents(session.id, "rollout", 0, 20)).events).toHaveLength(2);
  });

  it("marks unexpected app-server exits and journal failures as errors", async () => {
    const { service, fake, workDir } = await createFixture();
    const session = await service.createSession({ workDir, modelId: null, reasoningEffort: null });
    await service.sendMessage(session.id, "will exit");
    fake.exit("boom");
    await vi.waitFor(async () => {
      expect((await service.getSession(session.id)).session).toMatchObject({ lifecycleState: "error" });
      expect((await service.getSession(session.id)).turns[0]?.status).toBe("failed");
    });

    const appendError = new Error("disk full");
    const failed = await createFixture({
      openJournal: (input) => CodexObservationJournal.open({
        ...input,
        fileSystem: { appendFile: vi.fn().mockRejectedValue(appendError) },
      }),
    });
    const failedSession = await failed.service.createSession({
      workDir: failed.workDir,
      modelId: null,
      reasoningEffort: null,
    });
    await failed.service.sendMessage(failedSession.id, "cannot record");
    await vi.waitFor(async () => {
      expect((await failed.service.getSession(failedSession.id)).session).toMatchObject({
        lifecycleState: "error",
        integrityState: "incomplete",
      });
    });
    await failed.service.stopSession(failedSession.id);
    expect((await failed.service.getSession(failedSession.id)).session.lifecycleState).toBe("error");
  });

  it("recovers stale state and deletes only copied observation data", async () => {
    const fixture = await createFixture();
    const sourceRollout = await writeRollout(fixture.codexHome);
    const session = await fixture.service.createSession({
      workDir: fixture.workDir,
      modelId: null,
      reasoningEffort: null,
    });
    await fixture.service.sendMessage(session.id, "capture this");
    fixture.fake.emit({ type: "completed", content: "done" });
    await vi.waitFor(async () => expect((await fixture.service.getSession(session.id)).turns[0]?.status).toBe("completed"));

    expect(await fixture.service.deleteSession(session.id)).toBe(true);
    expect(fixture.fake.shutdownCount).toBeGreaterThan(0);
    await expect(stat(sourceRollout)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(path.join(
      fixture.userDataPath,
      "observability",
      "codex",
      session.id,
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("interrupts stale turns on startup and reconciles their rollout", async () => {
    const fixture = await createFixture();
    await writeRollout(fixture.codexHome);
    await fixture.repository.createSession({
      id: "stale-observation",
      title: "stale",
      workDir: fixture.workDir,
      modelId: null,
      reasoningEffort: null,
      recordKey: "stale-observation",
      now: "2026-08-05T00:00:00.000Z",
    });
    await fixture.repository.createTurn({
      id: "stale-turn",
      sessionId: "stale-observation",
      turnIndex: 1,
      prompt: "unfinished",
      startedAt: "2026-08-05T00:01:00.000Z",
    });
    await fixture.repository.updateSession("stale-observation", {
      threadId: "thread-1",
      lifecycleState: "running",
      updatedAt: "2026-08-05T00:01:00.000Z",
    });

    const restarted = new CodexObservationService({
      repository: fixture.repository,
      userDataPath: fixture.userDataPath,
      homePath: path.join(fixture.root, "home"),
      codexHome: fixture.codexHome,
      createClient: fixture.fake.createClient,
      readCodexVersion: async () => null,
    });
    await restarted.initialize();

    const detail = await restarted.getSession("stale-observation");
    expect(detail.session).toMatchObject({
      lifecycleState: "error",
      integrityState: "complete",
      lastError: INTERRUPTED_MESSAGE,
    });
    expect(detail.turns[0]).toMatchObject({ status: "interrupted" });
    expect(detail.context).toMatchObject({ status: "available", systemInstructions: "system" });
    expect((await restarted.readEvents("stale-observation", "rollout", 0, 20)).events).toHaveLength(2);
  });

  it("keeps an unavailable rollout explicit instead of fabricating context", async () => {
    const { service, fake, workDir } = await createFixture();
    const session = await service.createSession({ workDir, modelId: null, reasoningEffort: null });
    await service.sendMessage(session.id, "no rollout will appear");
    fake.emit({ type: "completed", content: "answer" });
    await vi.waitFor(async () => {
      const detail = await service.getSession(session.id);
      expect(detail.session.integrityState).toBe("incomplete");
      expect(detail.context).toMatchObject({
        status: "unavailable",
        sourcePathAvailable: false,
        systemInstructions: "",
      });
    });
  });
});
