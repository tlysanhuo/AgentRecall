import type {
  CodexObservationEventPage,
  CodexObservationSession,
  CodexObservationSessionDetail,
  CodexObservationStream,
  CodexObservationTurn,
} from "../../shared/codex-observation";
import { CODEX_OBSERVATION_IPC } from "../../shared/ipc/codex-observation";
import {
  combineIpcDisposers,
  registerIpcHandler,
  type IpcMainRegistrar,
} from "./register-ipc-handler";

export interface CodexObservationIpcService {
  listSessions(): Promise<CodexObservationSession[]>;
  getSession(id: string): Promise<CodexObservationSessionDetail>;
  createSession(input: {
    workDir: string;
    modelId: string | null;
    reasoningEffort: string | null;
  }): Promise<CodexObservationSession>;
  renameSession(id: string, title: string): Promise<CodexObservationSession>;
  sendMessage(id: string, prompt: string): Promise<CodexObservationTurn>;
  cancelTurn(id: string): Promise<void>;
  stopSession(id: string): Promise<void>;
  resolveApproval(input: {
    sessionId: string;
    requestId: string;
    decision: "approved" | "rejected";
  }): Promise<void>;
  readEvents(
    id: string,
    stream: CodexObservationStream,
    afterSeq: number,
    limit: number,
  ): Promise<CodexObservationEventPage>;
  readPayload(id: string, stream: CodexObservationStream, seq: number): Promise<string>;
  deleteSession(id: string): Promise<boolean>;
}

export function registerCodexObservationIpc(
  ipc: IpcMainRegistrar,
  service: CodexObservationIpcService,
  chooseDirectory: () => Promise<string | null>,
): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, CODEX_OBSERVATION_IPC.list, () => service.listSessions()),
    registerIpcHandler(ipc, CODEX_OBSERVATION_IPC.get, (_event, id) => service.getSession(id)),
    registerIpcHandler(ipc, CODEX_OBSERVATION_IPC.chooseDirectory, () => chooseDirectory()),
    registerIpcHandler(ipc, CODEX_OBSERVATION_IPC.create, (_event, input) =>
      service.createSession(input)),
    registerIpcHandler(ipc, CODEX_OBSERVATION_IPC.rename, (_event, id, title) =>
      service.renameSession(id, title)),
    registerIpcHandler(ipc, CODEX_OBSERVATION_IPC.send, (_event, id, prompt) =>
      service.sendMessage(id, prompt)),
    registerIpcHandler(ipc, CODEX_OBSERVATION_IPC.cancel, (_event, id) =>
      service.cancelTurn(id)),
    registerIpcHandler(ipc, CODEX_OBSERVATION_IPC.stop, (_event, id) =>
      service.stopSession(id)),
    registerIpcHandler(ipc, CODEX_OBSERVATION_IPC.resolveApproval, (_event, input) =>
      service.resolveApproval(input)),
    registerIpcHandler(ipc, CODEX_OBSERVATION_IPC.events, (_event, id, stream, afterSeq, limit) =>
      service.readEvents(id, stream, afterSeq, limit)),
    registerIpcHandler(ipc, CODEX_OBSERVATION_IPC.payload, (_event, id, stream, seq) =>
      service.readPayload(id, stream, seq)),
    registerIpcHandler(ipc, CODEX_OBSERVATION_IPC.delete, (_event, id) =>
      service.deleteSession(id)),
  ]);
}
