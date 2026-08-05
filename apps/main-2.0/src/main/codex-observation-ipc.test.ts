import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createCodexObservationApi } from "../preload/codex-observation";
import type { CodexObservationSession } from "../shared/codex-observation";
import {
  CODEX_OBSERVATION_EVENTS,
  CODEX_OBSERVATION_IPC,
} from "../shared/ipc/codex-observation";
import { IpcInputError } from "../shared/ipc/contract";
import {
  registerCodexObservationIpc,
  type CodexObservationIpcService,
} from "./ipc/codex-observation";
import type { IpcMainRegistrar } from "./ipc/register-ipc-handler";

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function registrar() {
  const handlers = new Map<string, RegisteredHandler>();
  const ipc = {
    handle(channel: string, listener: RegisteredHandler) {
      handlers.set(channel, listener);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
  } as unknown as IpcMainRegistrar;
  return { handlers, ipc };
}

const session: CodexObservationSession = {
  id: "obs-1",
  title: "repo",
  workDir: "/repo",
  modelId: null,
  reasoningEffort: null,
  threadId: null,
  lifecycleState: "idle",
  integrityState: "pending",
  lastError: null,
  recordKey: "obs-1",
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
};

function createService() {
  return {
    listSessions: vi.fn(async () => [session]),
    getSession: vi.fn(async () => ({
      session,
      turns: [],
      context: {
        status: "pending" as const,
        codexVersion: null,
        systemInstructions: "",
        developerInstructions: [],
        tools: [],
        availableSkills: [],
        usedSkills: [],
        sourcePathAvailable: false,
      },
      recordBytes: 0,
      pendingApproval: null,
    })),
    createSession: vi.fn(async () => session),
    renameSession: vi.fn(async () => session),
    sendMessage: vi.fn(async () => ({
      id: "turn-1",
      sessionId: session.id,
      turnIndex: 1,
      nativeTurnId: null,
      prompt: "hello",
      assistantText: "",
      status: "running" as const,
      usage: null,
      error: null,
      startedAt: session.createdAt,
      endedAt: null,
    })),
    cancelTurn: vi.fn(async () => undefined),
    stopSession: vi.fn(async () => undefined),
    resolveApproval: vi.fn(async () => undefined),
    readEvents: vi.fn(async () => ({ events: [], nextAfterSeq: null })),
    readPayload: vi.fn(async () => "{}"),
    deleteSession: vi.fn(async () => true),
  } satisfies CodexObservationIpcService;
}

describe("Codex observation IPC", () => {
  it("registers every validated operation and delegates normalized values", async () => {
    const { handlers, ipc } = registrar();
    const service = createService();
    const chooseDirectory = vi.fn(async () => "/repo");
    registerCodexObservationIpc(ipc, service, chooseDirectory);
    const event = {} as IpcMainInvokeEvent;

    await handlers.get(CODEX_OBSERVATION_IPC.list.channel)?.(event);
    await handlers.get(CODEX_OBSERVATION_IPC.get.channel)?.(event, "obs-1");
    await handlers.get(CODEX_OBSERVATION_IPC.chooseDirectory.channel)?.(event);
    await handlers.get(CODEX_OBSERVATION_IPC.create.channel)?.(event, {
      workDir: " /repo ",
      modelId: " gpt-5 ",
      reasoningEffort: "high",
    });
    await handlers.get(CODEX_OBSERVATION_IPC.rename.channel)?.(event, "obs-1", " Renamed ");
    await handlers.get(CODEX_OBSERVATION_IPC.send.channel)?.(event, "obs-1", "hello");
    await handlers.get(CODEX_OBSERVATION_IPC.cancel.channel)?.(event, "obs-1");
    await handlers.get(CODEX_OBSERVATION_IPC.stop.channel)?.(event, "obs-1");
    await handlers.get(CODEX_OBSERVATION_IPC.resolveApproval.channel)?.(event, {
      sessionId: "obs-1",
      requestId: "runtime-approval:1",
      decision: "approved",
    });
    await handlers.get(CODEX_OBSERVATION_IPC.events.channel)?.(event, "obs-1", "rpc", 0, 200);
    await handlers.get(CODEX_OBSERVATION_IPC.payload.channel)?.(event, "obs-1", "rpc", 1);
    await handlers.get(CODEX_OBSERVATION_IPC.delete.channel)?.(event, "obs-1");

    expect(service.createSession).toHaveBeenCalledWith({
      workDir: "/repo",
      modelId: "gpt-5",
      reasoningEffort: "high",
    });
    expect(service.renameSession).toHaveBeenCalledWith("obs-1", "Renamed");
    expect(service.readEvents).toHaveBeenCalledWith("obs-1", "rpc", 0, 200);
    expect(chooseDirectory).toHaveBeenCalledOnce();
    for (const operation of Object.values(service)) expect(operation).toHaveBeenCalledOnce();
  });

  it("rejects unsafe identifiers, inputs, streams, and pagination", () => {
    const { handlers, ipc } = registrar();
    const service = createService();
    registerCodexObservationIpc(ipc, service, async () => null);
    const event = {} as IpcMainInvokeEvent;

    const invalidCalls: Array<() => unknown> = [
      () => handlers.get(CODEX_OBSERVATION_IPC.get.channel)?.(event, "../obs"),
      () => handlers.get(CODEX_OBSERVATION_IPC.create.channel)?.(event, {
        workDir: "/repo\0secret",
        modelId: null,
        reasoningEffort: null,
      }),
      () => handlers.get(CODEX_OBSERVATION_IPC.create.channel)?.(event, {
        workDir: "/repo",
        modelId: null,
        reasoningEffort: "extreme",
      }),
      () => handlers.get(CODEX_OBSERVATION_IPC.send.channel)?.(event, "obs-1", "x".repeat(200_001)),
      () => handlers.get(CODEX_OBSERVATION_IPC.events.channel)?.(event, "obs-1", "secret", 0, 20),
      () => handlers.get(CODEX_OBSERVATION_IPC.events.channel)?.(event, "obs-1", "rpc", -1, 20),
      () => handlers.get(CODEX_OBSERVATION_IPC.events.channel)?.(event, "obs-1", "rpc", 0, 201),
    ];
    for (const invalidCall of invalidCalls) expect(invalidCall).toThrow(IpcInputError);
    expect(service.getSession).not.toHaveBeenCalled();
    expect(service.createSession).not.toHaveBeenCalled();
    expect(service.sendMessage).not.toHaveBeenCalled();
    expect(service.readEvents).not.toHaveBeenCalled();
  });

  it("uses the exact contracts and removes the exact update listener from preload", async () => {
    const invoke = vi.fn(async (..._args: unknown[]) => undefined);
    const on = vi.fn();
    const removeListener = vi.fn();
    const api = createCodexObservationApi({ invoke, on, removeListener });

    await api.listCodexObservationSessions();
    await api.getCodexObservationSession("obs-1");
    await api.chooseCodexObservationDirectory();
    await api.createCodexObservationSession({ workDir: "/repo", modelId: null, reasoningEffort: null });
    await api.renameCodexObservationSession("obs-1", "renamed");
    await api.sendCodexObservationMessage("obs-1", "hello");
    await api.cancelCodexObservationTurn("obs-1");
    await api.stopCodexObservationSession("obs-1");
    await api.resolveCodexObservationApproval({
      sessionId: "obs-1",
      requestId: "approval-1",
      decision: "rejected",
    });
    await api.getCodexObservationEvents("obs-1", "timeline", 0, 100);
    await api.getCodexObservationPayload("obs-1", "timeline", 1);
    await api.deleteCodexObservationSession("obs-1");

    expect(invoke.mock.calls.map((call) => call[0])).toEqual(
      Object.values(CODEX_OBSERVATION_IPC).map((contract) => contract.channel),
    );
    const callback = vi.fn();
    const dispose = api.onCodexObservationUpdate(callback);
    expect(on).toHaveBeenCalledWith(CODEX_OBSERVATION_EVENTS.changed, expect.any(Function));
    const listener = on.mock.calls[0]![1];
    listener({}, { sessionId: "obs-1", kind: "session" });
    expect(callback).toHaveBeenCalledWith({ sessionId: "obs-1", kind: "session" });
    dispose();
    expect(removeListener).toHaveBeenCalledWith(CODEX_OBSERVATION_EVENTS.changed, listener);
  });
});
