import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureCodexRollout,
  locateCodexRollout,
  type CodexRolloutCursor,
} from "./codex-rollout-capture";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("Codex rollout capture", () => {
  it("locates the matching thread and copies only newly completed rows", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "agent-recall-codex-home-"));
    temporaryDirectories.push(codexHome);
    const sessionsDirectory = path.join(codexHome, "sessions", "2026", "08", "05");
    await mkdir(sessionsDirectory, { recursive: true });
    const rolloutPath = path.join(sessionsDirectory, "rollout-2026-08-05T00-00-00-thread-1.jsonl");
    const first = JSON.stringify({ type: "session_meta", payload: { id: "thread-1" } });
    const second = JSON.stringify({ type: "event_msg", payload: { type: "task_started" } });
    const partial = JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } });
    await writeFile(rolloutPath, `${first}\n${second}\n${partial.slice(0, 20)}`, "utf8");

    expect(await locateCodexRollout(codexHome, "thread-1")).toBe(rolloutPath);
    const copied: string[] = [];
    const capture = (cursor: CodexRolloutCursor | null) => captureCodexRollout({
      codexHome,
      threadId: "thread-1",
      cursor,
      appendLines: async (lines) => { copied.push(...lines); },
    });
    const firstCapture = await capture(null);
    expect(firstCapture).toMatchObject({ copied: 2, sourceAvailable: true });
    expect(copied).toEqual([first, second]);

    await appendFile(rolloutPath, `${partial.slice(20)}\n`, "utf8");
    const secondCapture = await capture(firstCapture.cursor);
    expect(secondCapture.copied).toBe(1);
    expect(copied).toEqual([first, second, partial]);

    const thirdCapture = await capture(secondCapture.cursor);
    expect(thirdCapture.copied).toBe(0);
    expect(copied).toEqual([first, second, partial]);
  });

  it("falls back to verified archived rollouts and ignores symlinks", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "agent-recall-codex-home-"));
    temporaryDirectories.push(codexHome);
    const archived = path.join(codexHome, "archived_sessions");
    await mkdir(archived, { recursive: true });
    const rolloutPath = path.join(archived, "renamed.jsonl");
    await writeFile(
      rolloutPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: "thread-archived" } })}\n`,
      "utf8",
    );

    expect(await locateCodexRollout(codexHome, "thread-archived")).toBe(rolloutPath);
    expect(await locateCodexRollout(codexHome, "missing-thread")).toBeNull();
  });
});
