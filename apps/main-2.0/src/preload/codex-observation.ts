import type { IpcRenderer } from "electron";
import type {
  CodexObservationEventPage,
  CodexObservationLiveUpdate,
  CodexObservationSession,
  CodexObservationSessionDetail,
  CodexObservationStream,
  CodexObservationTurn,
} from "../shared/codex-observation";
import {
  CODEX_OBSERVATION_EVENTS,
  CODEX_OBSERVATION_IPC,
} from "../shared/ipc/codex-observation";

type CodexObservationIpcRenderer = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

export function createCodexObservationApi(ipc: CodexObservationIpcRenderer) {
  return {
    listCodexObservationSessions: (): Promise<CodexObservationSession[]> =>
      ipc.invoke(CODEX_OBSERVATION_IPC.list.channel),
    getCodexObservationSession: (id: string): Promise<CodexObservationSessionDetail> =>
      ipc.invoke(CODEX_OBSERVATION_IPC.get.channel, id),
    chooseCodexObservationDirectory: (): Promise<string | null> =>
      ipc.invoke(CODEX_OBSERVATION_IPC.chooseDirectory.channel),
    createCodexObservationSession: (input: {
      workDir: string;
      modelId: string | null;
      reasoningEffort: string | null;
    }): Promise<CodexObservationSession> =>
      ipc.invoke(CODEX_OBSERVATION_IPC.create.channel, input),
    renameCodexObservationSession: (id: string, title: string): Promise<CodexObservationSession> =>
      ipc.invoke(CODEX_OBSERVATION_IPC.rename.channel, id, title),
    sendCodexObservationMessage: (id: string, prompt: string): Promise<CodexObservationTurn> =>
      ipc.invoke(CODEX_OBSERVATION_IPC.send.channel, id, prompt),
    cancelCodexObservationTurn: (id: string): Promise<void> =>
      ipc.invoke(CODEX_OBSERVATION_IPC.cancel.channel, id),
    stopCodexObservationSession: (id: string): Promise<void> =>
      ipc.invoke(CODEX_OBSERVATION_IPC.stop.channel, id),
    resolveCodexObservationApproval: (input: {
      sessionId: string;
      requestId: string;
      decision: "approved" | "rejected";
    }): Promise<void> => ipc.invoke(CODEX_OBSERVATION_IPC.resolveApproval.channel, input),
    getCodexObservationEvents: (
      id: string,
      stream: CodexObservationStream,
      afterSeq: number,
      limit: number,
    ): Promise<CodexObservationEventPage> =>
      ipc.invoke(CODEX_OBSERVATION_IPC.events.channel, id, stream, afterSeq, limit),
    getCodexObservationPayload: (
      id: string,
      stream: CodexObservationStream,
      seq: number,
    ): Promise<string> => ipc.invoke(CODEX_OBSERVATION_IPC.payload.channel, id, stream, seq),
    deleteCodexObservationSession: (id: string): Promise<boolean> =>
      ipc.invoke(CODEX_OBSERVATION_IPC.delete.channel, id),
    onCodexObservationUpdate: (
      callback: (update: CodexObservationLiveUpdate) => void,
    ): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, update: CodexObservationLiveUpdate): void => {
        callback(update);
      };
      ipc.on(CODEX_OBSERVATION_EVENTS.changed, listener);
      return () => ipc.removeListener(CODEX_OBSERVATION_EVENTS.changed, listener);
    },
  };
}

export type CodexObservationApi = ReturnType<typeof createCodexObservationApi>;
