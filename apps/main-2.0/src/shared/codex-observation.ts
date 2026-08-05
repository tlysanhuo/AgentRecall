export type CodexObservationLifecycleState =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "stopped"
  | "error";

export type CodexObservationIntegrityState = "pending" | "complete" | "incomplete";

export type CodexObservationTurnStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type CodexObservationStream = "timeline" | "rpc" | "rollout";

export interface CodexObservationSession {
  id: string;
  title: string;
  workDir: string;
  modelId: string | null;
  reasoningEffort: string | null;
  threadId: string | null;
  lifecycleState: CodexObservationLifecycleState;
  integrityState: CodexObservationIntegrityState;
  lastError: string | null;
  recordKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexObservationTurn {
  id: string;
  sessionId: string;
  turnIndex: number;
  nativeTurnId: string | null;
  prompt: string;
  assistantText: string;
  status: CodexObservationTurnStatus;
  usage: Record<string, number> | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface CodexObservationEventSummary {
  seq: number;
  occurredAt: string;
  stream: CodexObservationStream;
  direction: "client_to_server" | "server_to_client" | "internal";
  kind: string;
  method: string | null;
  turnId: string | null;
  preview: string;
  payloadRef: string | null;
  redacted: boolean;
}

export interface CodexObservationEventPage {
  events: CodexObservationEventSummary[];
  nextAfterSeq: number | null;
}

export interface CodexObservationContext {
  status: "pending" | "available" | "unavailable";
  codexVersion: string | null;
  systemInstructions: string;
  developerInstructions: string[];
  tools: unknown[];
  availableSkills: string[];
  usedSkills: string[];
  sourcePathAvailable: boolean;
}

export interface CodexObservationSessionDetail {
  session: CodexObservationSession;
  turns: CodexObservationTurn[];
  context: CodexObservationContext;
  recordBytes: number;
  pendingApproval: {
    requestId: string;
    content: string;
    metadata?: Record<string, unknown>;
  } | null;
}

export interface CodexObservationLiveUpdate {
  sessionId: string;
  kind: "session" | "event" | "delta" | "approval";
  event?: CodexObservationEventSummary;
  turnId?: string;
  delta?: string;
}
