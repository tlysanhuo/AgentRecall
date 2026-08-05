import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { CodexRpcClient, type CodexRpcClientOptions, type CodexRpcObservation } from "../../automation/engine/main/agents/codex/codex-rpc";
import { resolveRuntimeExecutables, parseCliVersion } from "../../automation/engine/main/agents/runtime/detect";
import { RuntimeApprovalBroker } from "../../automation/engine/main/approvals/runtime-approval-broker";
import { respondToCodexRuntimeServerRequest } from "../../automation/engine/main/hub/runtime/executor/codex/codex-server-request";
import { execCli } from "../../automation/engine/main/platform/cli-launcher";
import type { AgentEvent, RuntimeUsage } from "../../automation/engine/shared/types";
import { extractCodexContextSnapshot } from "../../core/session-context-components";
import type { PostgresCodexObservationRepository } from "../../core/postgres/codex-observation-repository";
import { mergeRuntimeUsage } from "../../shared/runtime/usage";
import type {
  CodexObservationContext,
  CodexObservationEventPage,
  CodexObservationLiveUpdate,
  CodexObservationSession,
  CodexObservationSessionDetail,
  CodexObservationStream,
  CodexObservationTurn,
  CodexObservationTurnStatus,
} from "../../shared/codex-observation";
import { CodexObservationJournal } from "./codex-observation-journal";
import { captureCodexRollout, type CodexRolloutCursor } from "./codex-rollout-capture";

type ObservationClient = Pick<CodexRpcClient,
  "start" | "request" | "respond" | "respondError" | "interruptTurn" | "shutdown">;

interface ActiveObservationTurn {
  id: string;
  nativeTurnId: string | null;
  assistantText: string;
  usage: RuntimeUsage;
}

interface ObservationRuntime {
  sessionId: string;
  journal: CodexObservationJournal;
  client: ObservationClient | null;
  attachPromise: Promise<void> | null;
  active: ActiveObservationTurn | null;
  pendingApproval: CodexObservationSessionDetail["pendingApproval"];
  eventChain: Promise<void>;
  rolloutCursor: CodexRolloutCursor | null;
  sourceAvailable: boolean;
  expectedExit: boolean;
  recordingFailed: boolean;
}

export interface CodexObservationServiceOptions {
  repository: PostgresCodexObservationRepository;
  userDataPath: string;
  homePath: string;
  codexHome?: string;
  codexExecutable?: string;
  createClient?: (options: CodexRpcClientOptions) => ObservationClient;
  readCodexVersion?: () => Promise<string | null>;
  publish?: (update: CodexObservationLiveUpdate) => void;
  now?: () => Date;
  createId?: () => string;
  openJournal?: (input: {
    rootDir: string;
    sessionId: string;
    onWriteError?: (error: Error) => void;
  }) => Promise<CodexObservationJournal>;
}

const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const INTERRUPTED_MESSAGE = "AgentRecall stopped before this observation completed.";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numericUsage(usage: RuntimeUsage): Record<string, number> | null {
  const entries = Object.entries(usage)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function rawKind(observation: CodexRpcObservation): string {
  if (observation.parseError) return "parse_error";
  if (observation.message?.method && observation.message.id !== undefined) return "request";
  if (observation.message?.method) return "notification";
  if (observation.message?.error !== undefined) return "error_response";
  if (observation.message?.result !== undefined) return "response";
  return "message";
}

export class CodexObservationService {
  private readonly repository: PostgresCodexObservationRepository;
  private readonly rootDirectory: string;
  private readonly codexHome: string;
  private readonly codexExecutable: string;
  private readonly createClient: (options: CodexRpcClientOptions) => ObservationClient;
  private readonly readVersion: () => Promise<string | null>;
  private readonly publish: (update: CodexObservationLiveUpdate) => void;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly openJournal: NonNullable<CodexObservationServiceOptions["openJournal"]>;
  private readonly approvalBroker = new RuntimeApprovalBroker();
  private readonly runtimes = new Map<string, ObservationRuntime>();
  private versionPromise: Promise<string | null> | null = null;
  private shuttingDown = false;

  constructor(options: CodexObservationServiceOptions) {
    this.repository = options.repository;
    this.rootDirectory = path.join(options.userDataPath, "observability", "codex");
    this.codexHome = options.codexHome?.trim()
      || process.env.CODEX_HOME?.trim()
      || path.join(options.homePath, ".codex");
    this.codexExecutable = options.codexExecutable?.trim() || resolveRuntimeExecutables().codex;
    this.createClient = options.createClient ?? ((clientOptions) => new CodexRpcClient(clientOptions));
    this.readVersion = options.readCodexVersion ?? (async () => {
      try {
        const result = await execCli({
          executable: this.codexExecutable,
          args: ["--version"],
          timeout: 5_000,
          windowsHide: true,
          maxBuffer: 16 * 1024,
        });
        return parseCliVersion(result.stdout);
      } catch {
        return null;
      }
    });
    this.publish = options.publish ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.openJournal = options.openJournal ?? CodexObservationJournal.open;
  }

  async initialize(): Promise<void> {
    const before = await this.repository.listSessions();
    const interrupted = before.filter((session) => (
      session.lifecycleState === "running" || session.lifecycleState === "awaiting_approval"
    ));
    await this.repository.markInterrupted(this.now().toISOString());
    await Promise.allSettled(interrupted
      .filter((session) => Boolean(session.threadId))
      .map(async (session) => {
        const runtime = await this.runtimeFor(session);
        const integrityState = await this.finalizeRecording(session.id, runtime);
        if (!runtime.recordingFailed) {
          await this.repository.updateSession(session.id, { integrityState });
        }
      }));
  }

  listSessions(): Promise<CodexObservationSession[]> {
    return this.repository.listSessions();
  }

  async getSession(id: string): Promise<CodexObservationSessionDetail> {
    const session = await this.requireSession(id);
    const runtime = await this.runtimeFor(session);
    await runtime.eventChain;
    const turns = await this.repository.listTurns(id);
    const visibleTurns = turns.map((turn) => runtime.active?.id === turn.id
      ? {
          ...turn,
          nativeTurnId: runtime.active.nativeTurnId,
          assistantText: runtime.active.assistantText,
          usage: numericUsage(runtime.active.usage),
        }
      : turn);
    return {
      session: (await this.repository.getSession(id)) ?? session,
      turns: visibleTurns,
      context: await this.contextFor(session, runtime),
      recordBytes: await runtime.journal.storageBytes().catch(() => 0),
      pendingApproval: runtime.pendingApproval,
    };
  }

  async createSession(input: {
    workDir: string;
    modelId: string | null;
    reasoningEffort: string | null;
  }): Promise<CodexObservationSession> {
    if (this.shuttingDown) throw new Error("Codex observation service is shutting down.");
    const workDir = input.workDir.trim();
    if (!workDir || workDir.includes("\0")) throw new Error("Choose a valid working directory.");
    const workDirStat = await stat(workDir).catch(() => null);
    if (!workDirStat?.isDirectory()) throw new Error("Codex observation working directory does not exist.");
    const reasoningEffort = input.reasoningEffort?.trim() || null;
    if (reasoningEffort && !REASONING_EFFORTS.has(reasoningEffort)) {
      throw new Error(`Unsupported Codex reasoning effort: ${reasoningEffort}`);
    }
    const id = this.createId();
    const journal = await this.openJournal({
      rootDir: this.rootDirectory,
      sessionId: id,
      onWriteError: (error) => { void this.handleRecordingFailure(id, error); },
    });
    const now = this.now().toISOString();
    try {
      const session = await this.repository.createSession({
        id,
        title: path.basename(workDir) || "Codex observation",
        workDir,
        modelId: input.modelId?.trim() || null,
        reasoningEffort,
        recordKey: id,
        now,
      });
      this.runtimes.set(id, this.newRuntime(id, journal));
      this.publishSession(id);
      return session;
    } catch (error) {
      await journal.close().catch(() => undefined);
      throw error;
    }
  }

  async renameSession(id: string, title: string): Promise<CodexObservationSession> {
    await this.requireSession(id);
    const normalized = title.trim();
    if (!normalized) throw new Error("Observation title cannot be empty.");
    const session = await this.repository.updateSession(id, { title: normalized });
    this.publishSession(id);
    return session;
  }

  async sendMessage(id: string, prompt: string): Promise<CodexObservationTurn> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) throw new Error("Prompt cannot be empty.");
    const session = await this.requireSession(id);
    const runtime = await this.runtimeFor(session);
    if (runtime.active) throw new Error("A Codex turn is already running for this observation.");
    await this.ensureAttached(session, runtime);
    if (runtime.active) throw new Error("A Codex turn is already running for this observation.");

    const turns = await this.repository.listTurns(id);
    const turn = await this.repository.createTurn({
      id: this.createId(),
      sessionId: id,
      turnIndex: turns.reduce((highest, candidate) => Math.max(highest, candidate.turnIndex), 0) + 1,
      prompt: normalizedPrompt,
      startedAt: this.now().toISOString(),
    });
    runtime.active = {
      id: turn.id,
      nativeTurnId: null,
      assistantText: "",
      usage: {},
    };
    await runtime.journal.markIntegrity("pending");
    await this.repository.updateSession(id, {
      lifecycleState: "running",
      integrityState: "pending",
      lastError: null,
    });
    this.recordTimeline(runtime, {
      type: "system",
      content: "Codex turn started.",
      metadata: { prompt: normalizedPrompt },
    });

    try {
      const result = await runtime.client!.request("turn/start", {
        threadId: (await this.requireSession(id)).threadId,
        input: [{ type: "text", text: normalizedPrompt, text_elements: [] }],
      }) as { turn?: { id?: string } };
      const nativeTurnId = result.turn?.id ?? null;
      if (runtime.active?.id === turn.id) runtime.active.nativeTurnId = nativeTurnId;
      const updated = await this.repository.updateTurn(turn.id, { nativeTurnId });
      this.publishSession(id);
      return updated;
    } catch (error) {
      await this.finishTurnWithError(session, runtime, errorText(error));
      throw error;
    }
  }

  async cancelTurn(id: string): Promise<void> {
    const session = await this.requireSession(id);
    const runtime = await this.runtimeFor(session);
    await runtime.eventChain;
    const active = runtime.active;
    if (!active) return;
    runtime.active = null;
    this.approvalBroker.cancelOwner(this.ownerId(id));
    runtime.pendingApproval = null;
    await runtime.client?.interruptTurn(session.threadId!, active.nativeTurnId ?? undefined).catch(() => undefined);
    await this.repository.updateTurn(active.id, {
      nativeTurnId: active.nativeTurnId,
      assistantText: active.assistantText,
      status: "cancelled",
      usage: numericUsage(active.usage),
      endedAt: this.now().toISOString(),
    });
    this.recordTimeline(runtime, { type: "system", content: "Codex turn cancelled." });
    const integrityState = await this.finalizeRecording(id, runtime);
    if (runtime.recordingFailed) return;
    await this.repository.updateSession(id, { lifecycleState: "idle", integrityState });
    this.publishSession(id);
  }

  async stopSession(id: string): Promise<void> {
    const session = await this.requireSession(id);
    const runtime = await this.runtimeFor(session);
    this.approvalBroker.cancelOwner(this.ownerId(id));
    await runtime.eventChain;
    await this.cancelTurn(id);
    runtime.expectedExit = true;
    const client = runtime.client;
    runtime.client = null;
    runtime.attachPromise = null;
    await client?.shutdown().catch(() => undefined);
    await runtime.journal.flush().catch((error) => this.handleRecordingFailure(id, error));
    if (!runtime.recordingFailed) {
      await this.repository.updateSession(id, { lifecycleState: "stopped" });
    }
    this.publishSession(id);
  }

  async resolveApproval(input: {
    sessionId: string;
    requestId: string;
    decision: "approved" | "rejected";
  }): Promise<void> {
    const session = await this.requireSession(input.sessionId);
    const runtime = await this.runtimeFor(session);
    if (runtime.pendingApproval?.requestId !== input.requestId) {
      throw new Error("The Codex approval request is no longer pending.");
    }
    this.approvalBroker.resolveOrThrow({
      ownerId: this.ownerId(input.sessionId),
      requestId: input.requestId,
      decision: input.decision,
    });
    await runtime.eventChain;
  }

  async readEvents(
    id: string,
    stream: CodexObservationStream,
    afterSeq: number,
    limit: number,
  ): Promise<CodexObservationEventPage> {
    const session = await this.requireSession(id);
    const runtime = await this.runtimeFor(session);
    return runtime.journal.readEvents({ stream, afterSeq, limit });
  }

  async readPayload(
    id: string,
    stream: CodexObservationStream,
    seq: number,
  ): Promise<string> {
    const page = await this.readEvents(id, stream, Math.max(0, seq - 1), 1);
    const event = page.events.find((candidate) => candidate.seq === seq);
    if (!event) throw new Error(`Codex observation event not found: ${seq}`);
    return (await this.runtimeFor(await this.requireSession(id))).journal.readPayload(event);
  }

  async deleteSession(id: string): Promise<boolean> {
    const session = await this.repository.getSession(id);
    if (!session) return false;
    if (session.recordKey !== session.id) {
      throw new Error("Refusing to delete an invalid Codex observation record key.");
    }
    await this.stopSession(id);
    const runtime = this.runtimes.get(id);
    await runtime?.journal.close().catch(() => undefined);
    this.runtimes.delete(id);
    const target = path.join(this.rootDirectory, session.recordKey);
    if (path.dirname(target) !== this.rootDirectory) {
      throw new Error("Refusing to delete a Codex observation outside its storage root.");
    }
    await rm(target, { recursive: true, force: true });
    const deleted = await this.repository.deleteSession(id);
    if (deleted) this.publishSession(id);
    return deleted;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.approvalBroker.cancelAll();
    const ids = [...this.runtimes.keys()];
    await Promise.allSettled(ids.map(async (id) => {
      const runtime = this.runtimes.get(id);
      if (!runtime) return;
      const session = await this.repository.getSession(id);
      if (session) await this.stopSession(id);
      await runtime.journal.close();
    }));
    this.runtimes.clear();
  }

  private newRuntime(sessionId: string, journal: CodexObservationJournal): ObservationRuntime {
    return {
      sessionId,
      journal,
      client: null,
      attachPromise: null,
      active: null,
      pendingApproval: null,
      eventChain: Promise.resolve(),
      rolloutCursor: journal.rolloutCursor(),
      sourceAvailable: false,
      expectedExit: false,
      recordingFailed: false,
    };
  }

  private async runtimeFor(session: CodexObservationSession): Promise<ObservationRuntime> {
    const existing = this.runtimes.get(session.id);
    if (existing) return existing;
    const journal = await this.openJournal({
      rootDir: this.rootDirectory,
      sessionId: session.recordKey,
      onWriteError: (error) => { void this.handleRecordingFailure(session.id, error); },
    });
    const runtime = this.newRuntime(session.id, journal);
    runtime.recordingFailed = session.integrityState === "incomplete";
    this.runtimes.set(session.id, runtime);
    return runtime;
  }

  private async ensureAttached(session: CodexObservationSession, runtime: ObservationRuntime): Promise<void> {
    if (runtime.client) {
      await runtime.attachPromise;
      return;
    }
    if (runtime.attachPromise) return runtime.attachPromise;
    runtime.expectedExit = false;
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    environment.CODEX_HOME = this.codexHome;
    let client: ObservationClient;
    client = this.createClient({
      executable: this.codexExecutable,
      cwd: session.workDir,
      env: environment,
      extraArgs: session.reasoningEffort
        ? ["-c", `model_reasoning_effort=${JSON.stringify(session.reasoningEffort)}`]
        : [],
      onRawMessage: (observation) => this.recordRaw(runtime, observation),
      onEvent: (event) => this.queueAgentEvent(runtime, event),
      onRequest: (requestId, method, params) => {
        respondToCodexRuntimeServerRequest(
          client as CodexRpcClient,
          requestId,
          method,
          params,
          {
            ownerId: this.ownerId(session.id),
            emit: (event) => this.queueAgentEvent(runtime, event),
            request: this.approvalBroker.request,
            cwd: session.workDir,
          },
        );
      },
      onExit: (_code, _signal, stderr) => {
        if (!runtime.expectedExit && runtime.client === client) {
          runtime.eventChain = runtime.eventChain
            .then(() => this.handleUnexpectedExit(session.id, runtime, stderr))
            .catch(() => undefined);
        }
      },
    });
    runtime.client = client;
    const attach = (async () => {
      try {
        await client.start();
        const current = await this.requireSession(session.id);
        const response = current.threadId
          ? await client.request("thread/resume", {
              threadId: current.threadId,
              model: current.modelId || null,
              modelProvider: null,
              cwd: current.workDir,
              approvalPolicy: "on-request",
              config: null,
              baseInstructions: null,
              developerInstructions: null,
            })
          : await client.request("thread/start", {
              model: current.modelId || null,
              modelProvider: null,
              profile: null,
              cwd: current.workDir,
              approvalPolicy: "on-request",
              config: null,
              baseInstructions: null,
              developerInstructions: null,
              compactPrompt: null,
              includeApplyPatchTool: null,
              experimentalRawEvents: true,
              persistExtendedHistory: true,
            });
        const threadId = (response as { thread?: { id?: string } }).thread?.id;
        if (!threadId) throw new Error("Codex thread attach completed without a thread id.");
        await this.repository.updateSession(session.id, {
          threadId,
          lifecycleState: "idle",
          lastError: null,
        });
      } catch (error) {
        runtime.expectedExit = true;
        runtime.client = null;
        await client.shutdown().catch(() => undefined);
        await this.repository.updateSession(session.id, {
          lifecycleState: "error",
          lastError: errorText(error),
        });
        throw error;
      }
    })();
    runtime.attachPromise = attach;
    try {
      await attach;
    } finally {
      runtime.attachPromise = null;
    }
  }

  private recordRaw(runtime: ObservationRuntime, observation: CodexRpcObservation): void {
    const event = runtime.journal.record({
      stream: "rpc",
      direction: observation.direction,
      kind: rawKind(observation),
      method: typeof observation.message?.method === "string" ? observation.message.method : undefined,
      turnId: runtime.active?.id,
      payload: observation,
    });
    this.publish({ sessionId: runtime.sessionId, kind: "event", event });
  }

  private queueAgentEvent(runtime: ObservationRuntime, event: AgentEvent): void {
    runtime.eventChain = runtime.eventChain
      .then(() => this.handleAgentEvent(runtime, event))
      .catch((error) => this.handleRuntimeError(runtime.sessionId, error));
  }

  private async handleAgentEvent(runtime: ObservationRuntime, event: AgentEvent): Promise<void> {
    const summary = this.recordTimeline(runtime, event);
    this.publish({ sessionId: runtime.sessionId, kind: "event", event: summary });
    const active = runtime.active;
    if (event.type === "delta") {
      if (!active) return;
      active.assistantText += event.content;
      this.publish({
        sessionId: runtime.sessionId,
        kind: "delta",
        turnId: active.id,
        delta: event.content,
      });
      return;
    }
    if (event.type === "usage") {
      if (active) active.usage = mergeRuntimeUsage(active.usage, event.usage);
      return;
    }
    if (event.type === "approval_request") {
      runtime.pendingApproval = {
        requestId: event.requestId,
        content: event.content,
        ...(event.metadata ? { metadata: event.metadata } : {}),
      };
      await this.repository.updateSession(runtime.sessionId, { lifecycleState: "awaiting_approval" });
      this.publish({ sessionId: runtime.sessionId, kind: "approval" });
      return;
    }
    if (event.type === "approval_response") {
      if (runtime.pendingApproval?.requestId === event.requestId) runtime.pendingApproval = null;
      await this.repository.updateSession(runtime.sessionId, {
        lifecycleState: runtime.active ? "running" : "idle",
      });
      this.publish({ sessionId: runtime.sessionId, kind: "approval" });
      return;
    }
    if (event.type === "completed") {
      if (active && !active.assistantText && event.content) active.assistantText = event.content;
      await this.finishTurn(runtime.sessionId, runtime, "completed", null);
      return;
    }
    if (event.type === "error") {
      await this.finishTurn(runtime.sessionId, runtime, "failed", event.error);
    }
  }

  private recordTimeline(runtime: ObservationRuntime, event: AgentEvent) {
    return runtime.journal.record({
      stream: "timeline",
      direction: "internal",
      kind: event.type,
      turnId: runtime.active?.id,
      payload: event,
    });
  }

  private async finishTurn(
    sessionId: string,
    runtime: ObservationRuntime,
    status: Extract<CodexObservationTurnStatus, "completed" | "failed">,
    error: string | null,
  ): Promise<void> {
    const active = runtime.active;
    if (!active) return;
    runtime.active = null;
    runtime.pendingApproval = null;
    this.approvalBroker.cancelOwner(this.ownerId(sessionId));
    await this.repository.updateTurn(active.id, {
      nativeTurnId: active.nativeTurnId,
      assistantText: active.assistantText,
      status,
      usage: numericUsage(active.usage),
      error,
      endedAt: this.now().toISOString(),
    });
    const integrityState = await this.finalizeRecording(sessionId, runtime);
    if (runtime.recordingFailed) return;
    await this.repository.updateSession(sessionId, {
      lifecycleState: status === "completed" ? "idle" : "error",
      integrityState,
      lastError: error,
    });
    this.publishSession(sessionId);
  }

  private async finishTurnWithError(
    session: CodexObservationSession,
    runtime: ObservationRuntime,
    message: string,
  ): Promise<void> {
    await this.finishTurn(session.id, runtime, "failed", message);
  }

  private async captureRollout(
    session: CodexObservationSession,
    runtime: ObservationRuntime,
  ): Promise<{ sourceAvailable: boolean; copied: number }> {
    if (!session.threadId) return { sourceAvailable: false, copied: 0 };
    const result = await captureCodexRollout({
      codexHome: this.codexHome,
      threadId: session.threadId,
      cursor: runtime.rolloutCursor,
      appendLines: (lines) => runtime.journal.appendRolloutLines(lines),
    });
    runtime.rolloutCursor = result.cursor;
    if (result.cursor) await runtime.journal.saveRolloutCursor(result.cursor);
    runtime.sourceAvailable = result.sourceAvailable;
    return result;
  }

  private async contextFor(
    session: CodexObservationSession,
    runtime: ObservationRuntime,
  ): Promise<CodexObservationContext> {
    const codexVersion = await this.codexVersion();
    try {
      const rolloutStat = await stat(runtime.journal.rolloutPath());
      if (!rolloutStat.isFile() || rolloutStat.size === 0) throw new Error("empty rollout");
      const snapshot = await extractCodexContextSnapshot(runtime.journal.rolloutPath());
      return {
        status: "available",
        codexVersion,
        ...snapshot,
        sourcePathAvailable: runtime.sourceAvailable,
      };
    } catch {
      return {
        status: session.lifecycleState === "running" || session.lifecycleState === "awaiting_approval"
          ? "pending"
          : "unavailable",
        codexVersion,
        systemInstructions: "",
        developerInstructions: [],
        tools: [],
        availableSkills: [],
        usedSkills: [],
        sourcePathAvailable: runtime.sourceAvailable,
      };
    }
  }

  private async handleUnexpectedExit(
    sessionId: string,
    runtime: ObservationRuntime,
    stderr: string,
  ): Promise<void> {
    runtime.client = null;
    runtime.attachPromise = null;
    const message = stderr.trim() || "Codex app-server exited unexpectedly.";
    const active = runtime.active;
    runtime.active = null;
    runtime.pendingApproval = null;
    this.approvalBroker.cancelOwner(this.ownerId(sessionId));
    if (active) {
      await this.repository.updateTurn(active.id, {
        nativeTurnId: active.nativeTurnId,
        assistantText: active.assistantText,
        status: "failed",
        usage: numericUsage(active.usage),
        error: message,
        endedAt: this.now().toISOString(),
      });
    }
    const integrityState = await this.finalizeRecording(sessionId, runtime);
    if (runtime.recordingFailed) return;
    await this.repository.updateSession(sessionId, {
      lifecycleState: "error",
      integrityState,
      lastError: message,
    });
    this.publishSession(sessionId);
  }

  private async handleRecordingFailure(sessionId: string, error: unknown): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime || runtime.recordingFailed) return;
    runtime.recordingFailed = true;
    const message = `Observation recording failed: ${errorText(error)}`;
    const active = runtime.active;
    runtime.active = null;
    runtime.pendingApproval = null;
    this.approvalBroker.cancelOwner(this.ownerId(sessionId));
    if (active) {
      const session = await this.repository.getSession(sessionId);
      await runtime.client?.interruptTurn(session?.threadId ?? "", active.nativeTurnId ?? undefined).catch(() => undefined);
      await this.repository.updateTurn(active.id, {
        nativeTurnId: active.nativeTurnId,
        assistantText: active.assistantText,
        status: "failed",
        usage: numericUsage(active.usage),
        error: message,
        endedAt: this.now().toISOString(),
      }).catch(() => undefined);
    }
    runtime.expectedExit = true;
    const client = runtime.client;
    runtime.client = null;
    await client?.shutdown().catch(() => undefined);
    await this.repository.updateSession(sessionId, {
      lifecycleState: "error",
      integrityState: "incomplete",
      lastError: message,
    }).catch(() => undefined);
    this.publishSession(sessionId);
  }

  private async finalizeRecording(
    sessionId: string,
    runtime: ObservationRuntime,
  ): Promise<CodexObservationSession["integrityState"]> {
    let sourceAvailable = false;
    try {
      await runtime.journal.flush();
      const session = await this.requireSession(sessionId);
      const captured = await this.captureRollout(session, runtime);
      sourceAvailable = captured.sourceAvailable;
      const integrityState = sourceAvailable ? "complete" : "incomplete";
      await runtime.journal.markIntegrity(
        integrityState,
        sourceAvailable ? undefined : "Codex rollout source was unavailable.",
      );
      return integrityState;
    } catch (error) {
      await this.handleRecordingFailure(sessionId, error);
      return "incomplete";
    }
  }

  private async handleRuntimeError(sessionId: string, error: unknown): Promise<void> {
    await this.repository.updateSession(sessionId, {
      lifecycleState: "error",
      lastError: errorText(error),
    }).catch(() => undefined);
    this.publishSession(sessionId);
  }

  private codexVersion(): Promise<string | null> {
    this.versionPromise ??= this.readVersion();
    return this.versionPromise;
  }

  private async requireSession(id: string): Promise<CodexObservationSession> {
    const session = await this.repository.getSession(id);
    if (!session) throw new Error(`Codex observation session not found: ${id}`);
    return session;
  }

  private ownerId(sessionId: string): string {
    return `codex-observation:${sessionId}`;
  }

  private publishSession(sessionId: string): void {
    this.publish({ sessionId, kind: "session" });
  }
}
