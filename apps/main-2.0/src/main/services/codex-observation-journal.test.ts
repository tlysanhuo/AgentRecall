import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexObservationJournal,
  type ObservationJournalFileSystem,
} from "./codex-observation-journal";

const temporaryDirectories: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-recall-observation-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("CodexObservationJournal", () => {
  it("redacts credentials before writing and stores large payloads as blobs", async () => {
    const rootDir = await createRoot();
    const journal = await CodexObservationJournal.open({ rootDir, sessionId: "obs-1" });
    const first = journal.record({
      stream: "rpc",
      direction: "client_to_server",
      kind: "request",
      method: "turn/start",
      payload: {
        line: JSON.stringify({ authorization: "Bearer line-secret" }),
        authorization: "Bearer secret",
        nested: { api_key: "key" },
        text: "x".repeat(40_000),
      },
    });
    const second = journal.record({
      stream: "timeline",
      direction: "internal",
      kind: "turn.started",
      payload: { turnId: "turn-1" },
    });
    await journal.flush();

    expect([first.seq, second.seq]).toEqual([1, 2]);
    const page = await journal.readEvents({ stream: "rpc", afterSeq: 0, limit: 20 });
    const payload = await journal.readPayload(page.events[0]!);
    expect(payload).not.toContain("Bearer secret");
    expect(payload).not.toContain("line-secret");
    expect(payload).not.toContain("\"key\"");
    expect(payload).toContain("[REDACTED]");
    expect(page.events[0]?.payloadRef).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readdir(path.join(journal.sessionDirectory(), "blobs"))).toHaveLength(1);
  });

  it("pages each stream by the session-global sequence and preserves integrity", async () => {
    const rootDir = await createRoot();
    const journal = await CodexObservationJournal.open({ rootDir, sessionId: "obs-2" });
    journal.record({
      stream: "rpc",
      direction: "server_to_client",
      kind: "response",
      payload: { id: 1 },
    });
    journal.record({
      stream: "timeline",
      direction: "internal",
      kind: "turn.started",
      payload: { turnId: "turn-1" },
    });
    journal.record({
      stream: "rpc",
      direction: "server_to_client",
      kind: "notification",
      method: "item/completed",
      payload: { id: 2 },
    });
    await journal.appendRolloutLines([
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ]);
    await journal.markIntegrity("complete");
    await journal.flush();

    const firstPage = await journal.readEvents({ stream: "rpc", afterSeq: 0, limit: 1 });
    expect(firstPage.events.map((event) => event.seq)).toEqual([1]);
    expect(firstPage.nextAfterSeq).toBe(1);
    const secondPage = await journal.readEvents({
      stream: "rpc",
      afterSeq: firstPage.nextAfterSeq!,
      limit: 2000,
    });
    expect(secondPage.events.map((event) => event.seq)).toEqual([3]);
    expect(secondPage.nextAfterSeq).toBeNull();

    const rollout = await journal.readEvents({ stream: "rollout", afterSeq: 0, limit: 20 });
    expect(rollout.events.map((event) => event.seq)).toEqual([4, 5]);
    expect((await readFile(journal.rolloutPath(), "utf8")).trim().split("\n")).toHaveLength(2);
    const manifest = JSON.parse(await readFile(
      path.join(journal.sessionDirectory(), "manifest.json"),
      "utf8",
    )) as { nextSeq: number; integrityState: string };
    expect(manifest).toMatchObject({ nextSeq: 6, integrityState: "complete" });
    expect(await journal.storageBytes()).toBeGreaterThan(0);
  });

  it("reports the first append failure once and rejects flush", async () => {
    const rootDir = await createRoot();
    const onWriteError = vi.fn();
    const appendError = new Error("disk full");
    const fileSystem: Partial<ObservationJournalFileSystem> = {
      appendFile: vi.fn().mockRejectedValue(appendError),
    };
    const journal = await CodexObservationJournal.open({
      rootDir,
      sessionId: "obs-3",
      onWriteError,
      fileSystem,
    });
    journal.record({
      stream: "rpc",
      direction: "client_to_server",
      kind: "request",
      payload: { id: 1 },
    });
    journal.record({
      stream: "rpc",
      direction: "client_to_server",
      kind: "request",
      payload: { id: 2 },
    });

    await expect(journal.flush()).rejects.toThrow("disk full");
    expect(onWriteError).toHaveBeenCalledTimes(1);
  });
});
