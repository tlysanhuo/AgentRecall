# Codex Observability Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a V2-only「观测」workspace that launches dedicated multi-turn Codex app-server sessions and preserves their complete locally exposed RPC, rollout, context, tool, Skill, approval, and usage history.

**Architecture:** A main-process `CodexObservationService` owns exact Codex child processes and uses a raw observer added to `CodexRpcClient`. PostgreSQL stores small session/turn indexes, while an append-only journal and content-addressed blobs under Electron `userData` store high-volume records; a rollout capture pass enriches the RPC stream. Validated IPC exposes paged reads and live updates to a three-column renderer page.

**Tech Stack:** Electron 42, TypeScript, React 19, PostgreSQL/PGlite, Zod IPC contracts, Vitest, Codex app-server JSON-RPC, JSONL and SHA-256 blob storage.

---

## File map

- `apps/main-2.0/src/shared/codex-observation.ts`: renderer/main-safe domain types.
- `apps/main-2.0/src/core/postgres/codex-observation-repository.ts`: session and turn index persistence.
- `apps/main-2.0/src/main/services/codex-observation-journal.ts`: ordered JSONL, redaction, blobs, pagination, and manifests.
- `apps/main-2.0/src/main/services/codex-rollout-capture.ts`: locate a rollout by thread ID and copy complete new rows.
- `apps/main-2.0/src/main/services/codex-observation-service.ts`: session lifecycle, app-server ownership, approvals, normalization, and recovery.
- `apps/main-2.0/src/shared/ipc/codex-observation.ts`, `apps/main-2.0/src/main/ipc/codex-observation.ts`, `apps/main-2.0/src/preload/codex-observation.ts`: validated IPC boundary.
- `apps/main-2.0/src/renderer/src/features/codex-observation/codex-observation-page.tsx`: page state, session list, conversation, composer, and create/delete actions.
- `apps/main-2.0/src/renderer/src/features/codex-observation/codex-observation-inspector.tsx`: context, timeline, raw event list, and payload detail.
- `apps/main-2.0/src/renderer/src/styles/codex-observation.css`: three-column layout and compact event styling.

### Task 1: Persist observation session and turn indexes

**Files:**
- Create: `apps/main-2.0/src/shared/codex-observation.ts`
- Create: `apps/main-2.0/src/core/postgres/codex-observation-repository.ts`
- Create: `apps/main-2.0/src/core/postgres/codex-observation-repository.test.ts`
- Modify: `apps/main-2.0/src/core/postgres/schema.ts`
- Modify: `apps/main-2.0/src/core/postgres/schema.test.ts`

- [ ] **Step 1: Add the failing migration and repository tests**

Add migration assertions for `codex_observation_sessions` and `codex_observation_turns`, update the expected table count from 61 to 63, and add a PGlite repository test with this behavior:

```ts
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
  });

  await repository.markInterrupted("2026-08-05T00:02:00.000Z");

  expect(await repository.getSession(created.id)).toMatchObject({
    lifecycleState: "error",
    integrityState: "incomplete",
    threadId: "thread-1",
  });
  expect((await repository.listTurns(created.id))[0]).toMatchObject({
    status: "interrupted",
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
npm --prefix apps/main-2.0 exec vitest run src/core/postgres/schema.test.ts src/core/postgres/codex-observation-repository.test.ts
```

Expected: FAIL because migration 28, the shared observation types, and the repository do not exist.

- [ ] **Step 3: Define the shared domain types**

Create `shared/codex-observation.ts` with these stable contracts:

```ts
export type CodexObservationLifecycleState = "idle" | "running" | "awaiting_approval" | "stopped" | "error";
export type CodexObservationIntegrityState = "pending" | "complete" | "incomplete";
export type CodexObservationTurnStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
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
  pendingApproval: { requestId: string; content: string; metadata?: Record<string, unknown> } | null;
}

export interface CodexObservationLiveUpdate {
  sessionId: string;
  kind: "session" | "event" | "delta" | "approval";
  event?: CodexObservationEventSummary;
  turnId?: string;
  delta?: string;
}
```

- [ ] **Step 4: Add PostgreSQL migration 28**

Append this migration to `POSTGRES_MIGRATIONS`:

```ts
{
  version: 28,
  name: "persist Codex observation sessions",
  statements: [`
    CREATE TABLE agent_recall.codex_observation_sessions (
      id text PRIMARY KEY,
      title text NOT NULL,
      work_dir text NOT NULL,
      model_id text,
      reasoning_effort text,
      thread_id text,
      lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('idle','running','awaiting_approval','stopped','error')),
      integrity_state text NOT NULL CHECK (integrity_state IN ('pending','complete','incomplete')),
      last_error text,
      record_key text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE agent_recall.codex_observation_turns (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES agent_recall.codex_observation_sessions(id) ON DELETE CASCADE,
      turn_index integer NOT NULL,
      native_turn_id text,
      prompt text NOT NULL,
      assistant_text text NOT NULL DEFAULT '',
      status text NOT NULL CHECK (status IN ('running','completed','failed','cancelled','interrupted')),
      usage jsonb,
      error text,
      started_at timestamptz NOT NULL,
      ended_at timestamptz,
      UNIQUE (session_id, turn_index)
    );
    CREATE INDEX codex_observation_sessions_updated_idx
      ON agent_recall.codex_observation_sessions (updated_at DESC, id DESC);
    CREATE INDEX codex_observation_turns_session_idx
      ON agent_recall.codex_observation_turns (session_id, turn_index);
  `],
}
```

- [ ] **Step 5: Implement the repository**

Implement `PostgresCodexObservationRepository` with the exact public surface below. Map all timestamps to ISO strings and use parameterized SQL for every value.

```ts
export class PostgresCodexObservationRepository {
  constructor(private readonly database: PostgresDatabase) {}
  createSession(input: CreateCodexObservationSessionInput): Promise<CodexObservationSession>;
  listSessions(): Promise<CodexObservationSession[]>;
  getSession(id: string): Promise<CodexObservationSession | null>;
  updateSession(id: string, patch: UpdateCodexObservationSessionInput): Promise<CodexObservationSession>;
  createTurn(input: CreateCodexObservationTurnInput): Promise<CodexObservationTurn>;
  listTurns(sessionId: string): Promise<CodexObservationTurn[]>;
  updateTurn(id: string, patch: UpdateCodexObservationTurnInput): Promise<CodexObservationTurn>;
  deleteSession(id: string): Promise<boolean>;
  markInterrupted(now: string): Promise<void>;
}
```

`markInterrupted` must update running turns first and then transition only `running`/`awaiting_approval` sessions to `error`, preserving each session's integrity state.

- [ ] **Step 6: Run tests and commit**

Run the Task 1 focused test command. Expected: PASS.

```bash
git add apps/main-2.0/src/shared/codex-observation.ts apps/main-2.0/src/core/postgres/schema.ts apps/main-2.0/src/core/postgres/schema.test.ts apps/main-2.0/src/core/postgres/codex-observation-repository.ts apps/main-2.0/src/core/postgres/codex-observation-repository.test.ts
git commit -m "feat: persist Codex observation sessions"
```

### Task 2: Build the durable observation journal

**Files:**
- Create: `apps/main-2.0/src/main/services/codex-observation-journal.ts`
- Create: `apps/main-2.0/src/main/services/codex-observation-journal.test.ts`

- [ ] **Step 1: Write failing journal tests**

Use `mkdtemp(path.join(tmpdir(), "agent-recall-observation-"))`. Cover ordered sequence numbers, credential redaction, large-payload blobs, paged reads, and manifest integrity:

```ts
it("redacts credentials before writing and stores large payloads as blobs", async () => {
  const journal = await CodexObservationJournal.open({ rootDir, sessionId: "obs-1" });
  const first = journal.record({
    stream: "rpc",
    direction: "client_to_server",
    kind: "request",
    method: "turn/start",
    payload: { authorization: "Bearer secret", nested: { api_key: "key" }, text: "x".repeat(40_000) },
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
  expect(payload).not.toContain("\"key\"");
  expect(payload).toContain("[REDACTED]");
  expect(page.events[0]?.payloadRef).toMatch(/^[a-f0-9]{64}$/u);
});
```

Also inject a filesystem adapter whose append rejects and assert that `onWriteError` fires once and `flush()` rejects; do not touch real `userData`.

- [ ] **Step 2: Run the test and confirm failure**

```bash
npm --prefix apps/main-2.0 exec vitest run src/main/services/codex-observation-journal.test.ts
```

Expected: FAIL because `CodexObservationJournal` does not exist.

- [ ] **Step 3: Implement redaction and append-only storage**

Implement these exports in one meaningful storage boundary:

```ts
export interface ObservationRecordInput {
  stream: CodexObservationStream;
  direction: CodexObservationEventSummary["direction"];
  kind: string;
  method?: string;
  turnId?: string;
  payload: unknown;
}

export class CodexObservationJournal {
  static open(input: { rootDir: string; sessionId: string; onWriteError?: (error: Error) => void }): Promise<CodexObservationJournal>;
  record(input: ObservationRecordInput): CodexObservationEventSummary;
  flush(): Promise<void>;
  close(): Promise<void>;
  readEvents(input: { stream: CodexObservationStream; afterSeq: number; limit: number }): Promise<CodexObservationEventPage>;
  readPayload(event: CodexObservationEventSummary): Promise<string>;
  appendRolloutLines(lines: string[]): Promise<void>;
  rolloutPath(): string;
  sessionDirectory(): string;
  storageBytes(): Promise<number>;
  markIntegrity(state: CodexObservationIntegrityState, reason?: string): Promise<void>;
}
```

Use `/api[_-]?key|token|password|secret|authorization|cookie|set-cookie/i` for structured key redaction. Serialize the redacted payload once. Inline payloads up to 16 KiB in the stream record; write larger payloads atomically to `blobs/<sha256>` before enqueuing the record. Assign one session-global `seq` synchronously and route records by `stream`: RPC and lifecycle records go to `journal.jsonl`, derived events go to `timeline.jsonl`, and copied rollout rows go to `rollout.jsonl`. `appendRolloutLines` parses and redacts each complete JSON row, then records it with `stream: "rollout"`; it must not create a second duplicate copy. Serialize all writes through one promise chain and persist `manifest.json` through `manifest.json.tmp` plus rename.

Event previews must be deterministic: method, payload type, and at most 240 normalized whitespace characters. `readEvents` must cap `limit` to 200 and never accept a caller-provided path.

- [ ] **Step 4: Run tests and commit**

Run the Task 2 test. Expected: PASS.

```bash
git add apps/main-2.0/src/main/services/codex-observation-journal.ts apps/main-2.0/src/main/services/codex-observation-journal.test.ts
git commit -m "feat: record durable Codex observation events"
```

### Task 3: Expose pre-normalization Codex RPC and exact process cleanup

**Files:**
- Modify: `apps/main-2.0/src/automation/engine/main/agents/codex/codex-rpc.ts`
- Create: `apps/main-2.0/src/automation/engine/main/agents/codex/codex-rpc.test.ts`
- Modify: `apps/main-2.0/src/automation/engine/main/platform/cli-launcher.ts`
- Create: `apps/main-2.0/src/automation/engine/main/platform/cli-launcher.test.ts`

- [ ] **Step 1: Write failing raw-RPC and process-boundary tests**

Create a fake Node CLI with `writeNodeCliLauncher`. It must answer `initialize`, emit one invalid line, and answer `thread/start`. Assert both outbound and inbound exact lines are reported before normalized events:

```ts
const observed: CodexRpcObservation[] = [];
const client = new CodexRpcClient({
  executable: fakeCli,
  cwd: tempDir,
  onEvent: () => undefined,
  onRawMessage: (event) => observed.push(event),
});
await client.start();
await client.request("thread/start", {});
await client.shutdown();

expect(observed.some((event) => event.direction === "client_to_server" && event.message?.method === "initialize")).toBe(true);
expect(observed.some((event) => event.direction === "server_to_client" && event.parseError)).toBe(true);
expect(observed.some((event) => event.direction === "server_to_client" && event.message?.result)).toBe(true);
```

For the process helper, inject platform, `kill`, and `spawnKiller` dependencies. Assert POSIX targets `-pid` and Windows calls `taskkill /pid <pid> /T /F`; never kill a real process.

- [ ] **Step 2: Run tests and confirm failure**

```bash
npm --prefix apps/main-2.0 exec vitest run src/automation/engine/main/agents/codex/codex-rpc.test.ts src/automation/engine/main/platform/cli-launcher.test.ts
```

Expected: FAIL because `onRawMessage` and `terminateCliProcessTree` do not exist.

- [ ] **Step 3: Add the raw RPC observer**

Add this optional type and callback without changing callers that omit it:

```ts
export interface CodexRpcObservation {
  direction: "client_to_server" | "server_to_client";
  line: string;
  message?: Record<string, unknown>;
  parseError?: boolean;
}

export interface CodexRpcClientOptions {
  // existing options stay unchanged
  onRawMessage?: (event: CodexRpcObservation) => void;
}
```

In `write`, serialize once, call `onRawMessage` before `stdin.write`, and pass the same line to stdin. In `handleLine`, call the observer immediately after parsing, or call it with `{ line, parseError: true }` before returning on invalid JSON. Do this before pending-response resolution and `normalizeCodexNotification`.

- [ ] **Step 4: Add cross-platform owned-process termination**

Add a platform helper to `cli-launcher.ts`:

```ts
export function terminateCliProcessTree(
  pid: number | undefined,
  options: {
    platform?: NodeJS.Platform;
    kill?: typeof process.kill;
    spawnKiller?: (file: string, args: string[]) => void;
  } = {},
): void;
```

Spawn Codex app-server detached on non-Windows so its PID is a process-group ID. On shutdown use the helper: POSIX sends `SIGTERM` to `-pid` then falls back to `pid`; Windows spawns `taskkill` with `shell: false`, `windowsHide: true`, and ignored stdio. Only use the PID held by this `CodexRpcClient`.

- [ ] **Step 5: Run tests and commit**

Run the Task 3 test command. Expected: PASS.

```bash
git add apps/main-2.0/src/automation/engine/main/agents/codex/codex-rpc.ts apps/main-2.0/src/automation/engine/main/agents/codex/codex-rpc.test.ts apps/main-2.0/src/automation/engine/main/platform/cli-launcher.ts apps/main-2.0/src/automation/engine/main/platform/cli-launcher.test.ts
git commit -m "feat: expose raw Codex app-server traffic"
```

### Task 4: Capture rollout context, tools, and Skills

**Files:**
- Modify: `apps/main-2.0/src/core/session-context-components.ts`
- Modify: `apps/main-2.0/src/core/session-context-components.test.ts`
- Create: `apps/main-2.0/src/main/services/codex-rollout-capture.ts`
- Create: `apps/main-2.0/src/main/services/codex-rollout-capture.test.ts`

- [ ] **Step 1: Add failing full-context and incremental-copy tests**

Extend the core context test with a synthetic Codex rollout containing full base instructions, developer instructions, dynamic tools, an available skill catalog entry, and a tool call reading both POSIX and Windows `SKILL.md` paths. Assert:

```ts
expect(snapshot).toMatchObject({
  systemInstructions: "base system",
  developerInstructions: [expect.stringContaining("Available skills")],
  availableSkills: ["brainstorming"],
  usedSkills: ["brainstorming", "diagnose"],
});
expect(snapshot.tools).toEqual([{ name: "exec_command", description: "run" }]);
```

For rollout capture, create `CODEX_HOME/sessions/2026/08/05/rollout-...-thread-1.jsonl`, copy its complete rows, append an incomplete tail, and assert the cursor stops before the partial line. Complete that line, call capture again, and assert it is copied exactly once.

- [ ] **Step 2: Run tests and confirm failure**

```bash
npm --prefix apps/main-2.0 exec vitest run src/core/session-context-components.test.ts src/main/services/codex-rollout-capture.test.ts
```

Expected: FAIL because the full context snapshot and rollout capture do not exist.

- [ ] **Step 3: Refactor the Codex context parser around a full snapshot**

Export this reusable context boundary:

```ts
export interface CodexContextSnapshot {
  systemInstructions: string;
  developerInstructions: string[];
  tools: unknown[];
  toolNames: string[];
  availableSkills: string[];
  usedSkills: string[];
}

export async function extractCodexContextSnapshot(filePath: string): Promise<CodexContextSnapshot>;
```

Keep `extractCodexContextComponents` behavior and 48,000-character UI cap by deriving its existing components from the full snapshot. Extract available Skill names from lines in the `### Available skills` catalog and used Skill names from any serialized rollout value whose normalized path ends in `skills/<name>/SKILL.md`. Support both `/` and `\\`; sort and deduplicate names. Do not infer a Skill from ordinary prose.

- [ ] **Step 4: Implement incremental rollout capture**

Create:

```ts
export interface CodexRolloutCursor {
  sourcePath: string;
  offset: number;
}

export async function locateCodexRollout(codexHome: string, threadId: string): Promise<string | null>;
export async function captureCodexRollout(input: {
  codexHome: string;
  threadId: string;
  cursor: CodexRolloutCursor | null;
  appendLines(lines: string[]): Promise<void>;
}): Promise<{ cursor: CodexRolloutCursor | null; copied: number; sourceAvailable: boolean }>;
```

Search only `<CODEX_HOME>/sessions` and `<CODEX_HOME>/archived_sessions`, prefer a filename containing the thread ID, and verify the first complete `session_meta.payload.id`. The fallback recursive walk must reject symlinks and non-JSONL files. Copy only newline-terminated rows, retain the byte cursor, and return `sourceAvailable: false` rather than throwing when the rollout has not appeared yet.

- [ ] **Step 5: Run tests and commit**

Run the Task 4 test command. Expected: PASS, including all existing context component tests.

```bash
git add apps/main-2.0/src/core/session-context-components.ts apps/main-2.0/src/core/session-context-components.test.ts apps/main-2.0/src/main/services/codex-rollout-capture.ts apps/main-2.0/src/main/services/codex-rollout-capture.test.ts
git commit -m "feat: enrich Codex observations from rollout data"
```

### Task 5: Implement the observation lifecycle service

**Files:**
- Create: `apps/main-2.0/src/main/services/codex-observation-service.ts`
- Create: `apps/main-2.0/src/main/services/codex-observation-service.test.ts`

- [ ] **Step 1: Write failing service tests with a fake app-server client**

Define a fake client factory that records `thread/start`, `thread/resume`, `turn/start`, `turn/cancel`, `respond`, and `shutdown`, while exposing methods to emit raw messages and normalized `AgentEvent`s. Use PGlite plus temporary `HOME`, `userData`, and `CODEX_HOME`.

Cover these observable behaviors:

```ts
it("records a dedicated multi-turn thread and resumes it after stop", async () => {
  const session = await service.createSession({ workDir, modelId: null, reasoningEffort: null });
  const first = await service.sendMessage(session.id, "first prompt");
  fake.emit({ type: "delta", content: "first answer" });
  fake.emit({ type: "completed" });
  await service.stopSession(session.id);
  const second = await service.sendMessage(session.id, "second prompt");

  expect(first.turnIndex).toBe(1);
  expect(second.turnIndex).toBe(2);
  expect(fake.requests.map((request) => request.method)).toContain("thread/resume");
  expect((await service.getSession(session.id)).turns[0]).toMatchObject({
    assistantText: "first answer",
    status: "completed",
  });
});
```

Also cover one active turn per session, approval request/resolve, cancellation, app-server exit, journal write failure causing `integrityState: "incomplete"`, startup interruption recovery, rollout unavailable, delete stopping only the owned client, and delete leaving the synthetic original rollout in place.

- [ ] **Step 2: Run the service test and confirm failure**

```bash
npm --prefix apps/main-2.0 exec vitest run src/main/services/codex-observation-service.test.ts
```

Expected: FAIL because `CodexObservationService` does not exist.

- [ ] **Step 3: Implement the service public API and injected process boundary**

Use this public contract:

```ts
export interface CodexObservationServiceOptions {
  repository: PostgresCodexObservationRepository;
  userDataPath: string;
  homePath: string;
  codexHome?: string;
  codexExecutable?: string;
  createClient?: (options: CodexRpcClientOptions) => Pick<CodexRpcClient,
    "start" | "request" | "respond" | "respondError" | "interruptTurn" | "shutdown">;
  readCodexVersion?: () => Promise<string | null>;
  publish?: (update: CodexObservationLiveUpdate) => void;
  now?: () => Date;
  createId?: () => string;
}

export class CodexObservationService {
  initialize(): Promise<void>;
  listSessions(): Promise<CodexObservationSession[]>;
  getSession(id: string): Promise<CodexObservationSessionDetail>;
  createSession(input: { workDir: string; modelId: string | null; reasoningEffort: string | null }): Promise<CodexObservationSession>;
  renameSession(id: string, title: string): Promise<CodexObservationSession>;
  sendMessage(id: string, prompt: string): Promise<CodexObservationTurn>;
  cancelTurn(id: string): Promise<void>;
  stopSession(id: string): Promise<void>;
  resolveApproval(input: { sessionId: string; requestId: string; decision: "approved" | "rejected" }): Promise<void>;
  readEvents(id: string, stream: CodexObservationStream, afterSeq: number, limit: number): Promise<CodexObservationEventPage>;
  readPayload(id: string, stream: CodexObservationStream, seq: number): Promise<string>;
  deleteSession(id: string): Promise<boolean>;
  shutdown(): Promise<void>;
}
```

Resolve the executable with `resolveRuntimeExecutables().codex`. Resolve `codexHome` from the explicit option, then `process.env.CODEX_HOME`, then `<homePath>/.codex`. Validate `workDir` with `stat().isDirectory()` before inserting a session. Cache `codex --version` through `execCli` for the context summary; tests inject `readCodexVersion`, so they never execute the developer's Codex binary. Return `journal.storageBytes()` in `CodexObservationSessionDetail.recordBytes`.

- [ ] **Step 4: Implement attach, turn, approval, and completion flows**

For first attach call `thread/start`; for a stored thread call `thread/resume`. Use `model: session.modelId || null`, `baseInstructions: null`, `developerInstructions: null`, `approvalPolicy: "on-request"`, `experimentalRawEvents: true`, and `persistExtendedHistory: true`. Accept reasoning effort only from `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; pass it as `-c model_reasoning_effort="<value>"` only when present.

Feed `onRawMessage` to the journal before normalized handling. Feed normalized events to `timeline.jsonl`; append deltas to the active turn buffer; accumulate usage; route server requests through `respondToCodexRuntimeServerRequest` and a service-owned `RuntimeApprovalBroker` using owner ID `codex-observation:<sessionId>`.

On `completed` or `error`, update the turn once, flush the journal, run rollout capture, derive context from the copied rollout, update lifecycle/integrity, and publish a session update. A recording failure must cancel the active turn best-effort and permanently set that session's integrity to `incomplete`.

- [ ] **Step 5: Implement recovery, deletion, and shutdown**

`initialize` calls `repository.markInterrupted(now)` and attempts one rollout reconciliation for interrupted sessions with thread IDs. `stopSession` rejects pending approvals, cancels the active turn, shuts down the exact client, flushes, and preserves the thread ID. `deleteSession` resolves the session record first, calls stop, validates `recordKey === session.id`, removes only `<userData>/observability/codex/<recordKey>`, then removes the database row. Never remove the source rollout.

`shutdown` uses `Promise.allSettled` over every owned runtime and journal and clears the maps after all bounded cleanup attempts.

- [ ] **Step 6: Run tests and commit**

Run the Task 5 test command. Expected: PASS.

```bash
git add apps/main-2.0/src/main/services/codex-observation-service.ts apps/main-2.0/src/main/services/codex-observation-service.test.ts
git commit -m "feat: manage observed Codex conversations"
```

### Task 6: Add validated IPC, preload, and main-process wiring

**Files:**
- Create: `apps/main-2.0/src/shared/ipc/codex-observation.ts`
- Create: `apps/main-2.0/src/main/ipc/codex-observation.ts`
- Create: `apps/main-2.0/src/preload/codex-observation.ts`
- Create: `apps/main-2.0/src/main/codex-observation-ipc.test.ts`
- Modify: `apps/main-2.0/src/preload/index.ts`
- Modify: `apps/main-2.0/src/main/index.ts`

- [ ] **Step 1: Write failing IPC delegation and validation tests**

Follow `openviking-memory-ipc.test.ts`. Register every handler against an in-memory registrar, call each through preload, and assert exact channels. Reject IDs outside `/^[A-Za-z0-9_-]{1,128}$/`, prompts over 200,000 characters, page limits over 200, negative sequence numbers, reasoning effort outside `low|medium|high|xhigh|max|ultra`, and paths containing NUL.

- [ ] **Step 2: Run the IPC test and confirm failure**

```bash
npm --prefix apps/main-2.0 exec vitest run src/main/codex-observation-ipc.test.ts
```

Expected: FAIL because the observation IPC modules do not exist.

- [ ] **Step 3: Define and register the IPC contracts**

Create contracts for:

```ts
export const CODEX_OBSERVATION_IPC = {
  list: defineIpcRequest("codex-observation:list", z.tuple([])),
  get: defineIpcRequest("codex-observation:get", z.tuple([idSchema])),
  chooseDirectory: defineIpcRequest("codex-observation:choose-directory", z.tuple([])),
  create: defineIpcRequest("codex-observation:create", z.tuple([createSchema])),
  rename: defineIpcRequest("codex-observation:rename", z.tuple([idSchema, titleSchema])),
  send: defineIpcRequest("codex-observation:send", z.tuple([idSchema, promptSchema])),
  cancel: defineIpcRequest("codex-observation:cancel", z.tuple([idSchema])),
  stop: defineIpcRequest("codex-observation:stop", z.tuple([idSchema])),
  resolveApproval: defineIpcRequest("codex-observation:resolve-approval", z.tuple([approvalSchema])),
  events: defineIpcRequest("codex-observation:events", z.tuple([idSchema, streamSchema, sequenceSchema, limitSchema])),
  payload: defineIpcRequest("codex-observation:payload", z.tuple([idSchema, streamSchema, sequenceSchema])),
  delete: defineIpcRequest("codex-observation:delete", z.tuple([idSchema])),
} as const;

export const CODEX_OBSERVATION_EVENTS = { changed: "codex-observation:changed" } as const;
```

The main IPC module delegates to a `CodexObservationIpcService` interface and receives an injected directory picker. Preload exports promise methods plus `onCodexObservationUpdate`, whose disposer removes the exact listener instance.

- [ ] **Step 4: Wire service lifecycle in `main/index.ts`**

After PostgreSQL initialization, create `PostgresCodexObservationRepository` and `CodexObservationService`, await `initialize`, and register IPC with:

```ts
publish: (update) => mainWindow?.webContents.send(CODEX_OBSERVATION_EVENTS.changed, update)
```

Use a dedicated directory dialog titled `Choose Codex observation directory`, defaulting to `app.getPath("home")`, with `openDirectory` and `createDirectory`. Add the IPC disposer and service shutdown to the existing `before-quit` barrier before PostgreSQL closes.

- [ ] **Step 5: Run tests and commit**

Run the Task 6 test plus preload typecheck:

```bash
npm --prefix apps/main-2.0 exec vitest run src/main/codex-observation-ipc.test.ts
npm --prefix apps/main-2.0 run typecheck
```

Expected: PASS.

```bash
git add apps/main-2.0/src/shared/ipc/codex-observation.ts apps/main-2.0/src/main/ipc/codex-observation.ts apps/main-2.0/src/preload/codex-observation.ts apps/main-2.0/src/main/codex-observation-ipc.test.ts apps/main-2.0/src/preload/index.ts apps/main-2.0/src/main/index.ts
git commit -m "feat: expose Codex observations to the renderer"
```

### Task 7: Build the「观测」page

**Files:**
- Create: `apps/main-2.0/src/renderer/src/features/codex-observation/codex-observation-page.tsx`
- Create: `apps/main-2.0/src/renderer/src/features/codex-observation/codex-observation-inspector.tsx`
- Create: `apps/main-2.0/src/renderer/src/styles/codex-observation.css`
- Modify: `apps/main-2.0/src/renderer/src/components/app-navigation.tsx`
- Modify: `apps/main-2.0/src/renderer/src/App.tsx`
- Modify: `apps/main-2.0/src/renderer/src/main.tsx`

- [ ] **Step 1: Add the top-level navigation route and lazy page**

Add `"observe"` to `AppPage`, use the Lucide `Activity` icon, and render `{l("Observe", "观测")}` immediately after Workflow and before Eval. Lazy-load the page in `App.tsx` and render it when `activePage === "observe"`.

```tsx
const CodexObservationPage = lazy(() =>
  import("./features/codex-observation/codex-observation-page")
    .then((module) => ({ default: module.CodexObservationPage })));
```

- [ ] **Step 2: Implement the page's session and conversation state**

`CodexObservationPage` receives only `language`. On mount it lists sessions, selects the newest, loads its detail, and subscribes to `onCodexObservationUpdate`. On `session`/`approval` updates reload detail; on `delta` append only to the visible active turn; on `event` append to the active inspector page when its stream matches.

The left column includes a privacy notice, new-session button, status/integrity badges, project basename, model, updated time, record size, stop, and delete. New-session flow calls the directory picker, then opens a compact form containing the chosen path, an optional model text field, and a reasoning selector with `Follow Codex`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; submit passes `null` for either unset override. The delete action uses a confirmation mentioning that observation records are permanent local deletions but the original Codex rollout is retained.

The center column renders every turn with user prompt, assistant text, running/error state, usage, and expandable tool/timeline entries. The composer disables send for blank input or an active turn and provides Cancel while running.

- [ ] **Step 3: Implement the inspector with paged raw payloads**

The inspector has `context`, `timeline`, and `raw` tabs. Context renders full system/developer blocks, available/used Skill chips, tool JSON, thread/turn metadata, and an explicit unavailable state. Timeline calls `getCodexObservationEvents(id, "timeline", afterSeq, 100)`. Raw adds RPC/Rollout source filters, displays direction/method/preview, and calls `getCodexObservationPayload` only when the user selects an event.

Never use `dangerouslySetInnerHTML`. Render JSON inside `<pre>` and provide copy with `navigator.clipboard.writeText(payload)`. Show credential-redaction state and the warning that tool output can contain local source or command data.

- [ ] **Step 4: Add compact responsive styling**

Use a page-owned grid:

```css
.codex-observation-page {
  display: grid;
  grid-template-columns: 260px minmax(360px, 1fr) minmax(340px, .9fr);
  min-width: 0;
  height: 100%;
  background: var(--app-bg);
}

@media (max-width: 1180px) {
  .codex-observation-page { grid-template-columns: 230px minmax(0, 1fr); }
  .codex-observation-inspector { position: absolute; inset: 0 0 0 auto; width: min(520px, 72vw); }
}
```

Use existing theme tokens, 12–13px event typography, independent scroll areas, sticky composer, visible focus rings, and `white-space: pre-wrap` for prompts/results. Import the stylesheet from `renderer/src/main.tsx`.

- [ ] **Step 5: Typecheck and commit**

Do not add renderer regression tests. Run:

```bash
npm --prefix apps/main-2.0 run typecheck
```

Expected: PASS.

```bash
git add apps/main-2.0/src/renderer/src/features/codex-observation apps/main-2.0/src/renderer/src/styles/codex-observation.css apps/main-2.0/src/renderer/src/components/app-navigation.tsx apps/main-2.0/src/renderer/src/App.tsx apps/main-2.0/src/renderer/src/main.tsx
git commit -m "feat: add the Codex observation workspace"
```

### Task 8: Release note and end-to-end verification

**Files:**
- Create: `.release-notes/codex-observability.md`

- [ ] **Step 1: Add the single user-facing release note**

```markdown
# Codex 观测工作台

## 新增功能

- 新增独立「观测」页面，可从专用入口运行 Codex，并在本机查看系统提示词、Skills、工具调用、执行时间线与原始协议记录。
```

- [ ] **Step 2: Run focused backend tests**

```bash
npm --prefix apps/main-2.0 exec vitest run src/core/postgres/schema.test.ts src/core/postgres/codex-observation-repository.test.ts src/main/services/codex-observation-journal.test.ts src/automation/engine/main/agents/codex/codex-rpc.test.ts src/automation/engine/main/platform/cli-launcher.test.ts src/core/session-context-components.test.ts src/main/services/codex-rollout-capture.test.ts src/main/services/codex-observation-service.test.ts src/main/codex-observation-ipc.test.ts
```

Expected: PASS. Every filesystem test must print or assert that it used temporary roots; no test may inspect real `~/.codex`, Skills, Electron, or Session data.

- [ ] **Step 3: Run static checks, build, and release-note validation**

```bash
npm --prefix apps/main-2.0 run typecheck
npm --prefix apps/main-2.0 run build
npm run release-note:check
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 4: Perform real macOS smoke verification**

Start V2 once, then verify:

1. 「观测」appears between Workflow and Eval and remains usable at compact window widths.
2. Create a session in a disposable fixture repository and send two turns.
3. Confirm system/developer/user context, available and used Skills, tools/MCP, usage, thread/turn IDs, timeline, raw RPC, and copied rollout are visible.
4. Trigger one approval, approve it, then trigger another and reject it.
5. Navigate away during a turn and confirm recording continues.
6. Stop and continue the same thread; restart V2 and continue again.
7. Delete the observation and confirm only `<userData>/observability/codex/<id>` plus its DB index disappear; the Codex rollout remains.
8. Quit V2 and confirm no Electron, app-server, MCP, temporary PostgreSQL, or test child process from the smoke run remains.

- [ ] **Step 5: Commit the release note and verification-ready state**

```bash
git add .release-notes/codex-observability.md
git commit -m "docs: announce Codex observability"
git status --short --branch
```

Expected: only the user's pre-existing untracked `docs/architecture-diagrams.md` may remain; implementation files are committed on `feat/codex-observability`.
