import type {
  CodexObservationIntegrityState,
  CodexObservationLifecycleState,
  CodexObservationSession,
  CodexObservationTurn,
  CodexObservationTurnStatus,
} from "../../shared/codex-observation";
import type { PostgresDatabase } from "./database";

export interface CreateCodexObservationSessionInput {
  id: string;
  title: string;
  workDir: string;
  modelId: string | null;
  reasoningEffort: string | null;
  recordKey: string;
  now: string;
}

export interface UpdateCodexObservationSessionInput {
  title?: string;
  modelId?: string | null;
  reasoningEffort?: string | null;
  threadId?: string | null;
  lifecycleState?: CodexObservationLifecycleState;
  integrityState?: CodexObservationIntegrityState;
  lastError?: string | null;
  updatedAt?: string;
}

export interface CreateCodexObservationTurnInput {
  id: string;
  sessionId: string;
  turnIndex: number;
  prompt: string;
  startedAt: string;
}

export interface UpdateCodexObservationTurnInput {
  nativeTurnId?: string | null;
  assistantText?: string;
  status?: CodexObservationTurnStatus;
  usage?: Record<string, number> | null;
  error?: string | null;
  endedAt?: string | null;
}

interface ObservationSessionRow extends Record<string, unknown> {
  id: string;
  title: string;
  work_dir: string;
  model_id: string | null;
  reasoning_effort: string | null;
  thread_id: string | null;
  lifecycle_state: CodexObservationLifecycleState;
  integrity_state: CodexObservationIntegrityState;
  last_error: string | null;
  record_key: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ObservationTurnRow extends Record<string, unknown> {
  id: string;
  session_id: string;
  turn_index: number | string;
  native_turn_id: string | null;
  prompt: string;
  assistant_text: string;
  status: CodexObservationTurnStatus;
  usage: Record<string, number> | string | null;
  error: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
}

const SESSION_COLUMNS = `
  id, title, work_dir, model_id, reasoning_effort, thread_id, lifecycle_state,
  integrity_state, last_error, record_key, created_at, updated_at
`;

const TURN_COLUMNS = `
  id, session_id, turn_index, native_turn_id, prompt, assistant_text, status,
  usage, error, started_at, ended_at
`;

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function hydrateSession(row: ObservationSessionRow): CodexObservationSession {
  return {
    id: row.id,
    title: row.title,
    workDir: row.work_dir,
    modelId: row.model_id,
    reasoningEffort: row.reasoning_effort,
    threadId: row.thread_id,
    lifecycleState: row.lifecycle_state,
    integrityState: row.integrity_state,
    lastError: row.last_error,
    recordKey: row.record_key,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function hydrateTurn(row: ObservationTurnRow): CodexObservationTurn {
  const usage = typeof row.usage === "string"
    ? JSON.parse(row.usage) as Record<string, number>
    : row.usage;
  return {
    id: row.id,
    sessionId: row.session_id,
    turnIndex: Number(row.turn_index),
    nativeTurnId: row.native_turn_id,
    prompt: row.prompt,
    assistantText: row.assistant_text,
    status: row.status,
    usage,
    error: row.error,
    startedAt: isoTimestamp(row.started_at),
    endedAt: row.ended_at === null ? null : isoTimestamp(row.ended_at),
  };
}

export class PostgresCodexObservationRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async createSession(input: CreateCodexObservationSessionInput): Promise<CodexObservationSession> {
    const result = await this.database.query<ObservationSessionRow>(
      `
        insert into agent_recall.codex_observation_sessions (
          id, title, work_dir, model_id, reasoning_effort, thread_id, lifecycle_state,
          integrity_state, last_error, record_key, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, null, 'idle', 'pending', null, $6, $7, $7)
        returning ${SESSION_COLUMNS}
      `,
      [input.id, input.title, input.workDir, input.modelId, input.reasoningEffort, input.recordKey, input.now],
    );
    return hydrateSession(result.rows[0]!);
  }

  async listSessions(): Promise<CodexObservationSession[]> {
    const result = await this.database.query<ObservationSessionRow>(
      `select ${SESSION_COLUMNS} from agent_recall.codex_observation_sessions order by updated_at desc, id desc`,
    );
    return result.rows.map(hydrateSession);
  }

  async getSession(id: string): Promise<CodexObservationSession | null> {
    const result = await this.database.query<ObservationSessionRow>(
      `select ${SESSION_COLUMNS} from agent_recall.codex_observation_sessions where id = $1`,
      [id],
    );
    return result.rows[0] ? hydrateSession(result.rows[0]) : null;
  }

  async updateSession(
    id: string,
    patch: UpdateCodexObservationSessionInput,
  ): Promise<CodexObservationSession> {
    const columns: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown): void => {
      values.push(value);
      columns.push(`${column} = $${values.length}`);
    };
    if (Object.hasOwn(patch, "title")) add("title", patch.title);
    if (Object.hasOwn(patch, "modelId")) add("model_id", patch.modelId);
    if (Object.hasOwn(patch, "reasoningEffort")) add("reasoning_effort", patch.reasoningEffort);
    if (Object.hasOwn(patch, "threadId")) add("thread_id", patch.threadId);
    if (Object.hasOwn(patch, "lifecycleState")) add("lifecycle_state", patch.lifecycleState);
    if (Object.hasOwn(patch, "integrityState")) add("integrity_state", patch.integrityState);
    if (Object.hasOwn(patch, "lastError")) add("last_error", patch.lastError);
    add("updated_at", patch.updatedAt ?? new Date().toISOString());
    values.push(id);
    const result = await this.database.query<ObservationSessionRow>(
      `
        update agent_recall.codex_observation_sessions
        set ${columns.join(", ")}
        where id = $${values.length}
        returning ${SESSION_COLUMNS}
      `,
      values,
    );
    if (!result.rows[0]) throw new Error(`Codex observation session not found: ${id}`);
    return hydrateSession(result.rows[0]);
  }

  async createTurn(input: CreateCodexObservationTurnInput): Promise<CodexObservationTurn> {
    const result = await this.database.query<ObservationTurnRow>(
      `
        insert into agent_recall.codex_observation_turns (
          id, session_id, turn_index, native_turn_id, prompt, assistant_text,
          status, usage, error, started_at, ended_at
        )
        values ($1, $2, $3, null, $4, '', 'running', null, null, $5, null)
        returning ${TURN_COLUMNS}
      `,
      [input.id, input.sessionId, input.turnIndex, input.prompt, input.startedAt],
    );
    return hydrateTurn(result.rows[0]!);
  }

  async listTurns(sessionId: string): Promise<CodexObservationTurn[]> {
    const result = await this.database.query<ObservationTurnRow>(
      `
        select ${TURN_COLUMNS}
        from agent_recall.codex_observation_turns
        where session_id = $1
        order by turn_index, id
      `,
      [sessionId],
    );
    return result.rows.map(hydrateTurn);
  }

  async updateTurn(id: string, patch: UpdateCodexObservationTurnInput): Promise<CodexObservationTurn> {
    const columns: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown): void => {
      values.push(value);
      columns.push(`${column} = $${values.length}`);
    };
    if (Object.hasOwn(patch, "nativeTurnId")) add("native_turn_id", patch.nativeTurnId);
    if (Object.hasOwn(patch, "assistantText")) add("assistant_text", patch.assistantText);
    if (Object.hasOwn(patch, "status")) add("status", patch.status);
    if (Object.hasOwn(patch, "usage")) add("usage", patch.usage === null ? null : JSON.stringify(patch.usage));
    if (Object.hasOwn(patch, "error")) add("error", patch.error);
    if (Object.hasOwn(patch, "endedAt")) add("ended_at", patch.endedAt);
    if (columns.length === 0) {
      const existing = await this.getTurn(id);
      if (!existing) throw new Error(`Codex observation turn not found: ${id}`);
      return existing;
    }
    values.push(id);
    const result = await this.database.query<ObservationTurnRow>(
      `
        update agent_recall.codex_observation_turns
        set ${columns.join(", ")}
        where id = $${values.length}
        returning ${TURN_COLUMNS}
      `,
      values,
    );
    if (!result.rows[0]) throw new Error(`Codex observation turn not found: ${id}`);
    return hydrateTurn(result.rows[0]);
  }

  async deleteSession(id: string): Promise<boolean> {
    const result = await this.database.query(
      "delete from agent_recall.codex_observation_sessions where id = $1",
      [id],
    );
    return result.rowCount > 0;
  }

  async markInterrupted(now: string): Promise<void> {
    const message = "AgentRecall stopped before this observation completed.";
    await this.database.transaction(async (client) => {
      await client.query(
        `
          update agent_recall.codex_observation_turns
          set status = 'interrupted', error = $1, ended_at = $2
          where status = 'running'
        `,
        [message, now],
      );
      await client.query(
        `
          update agent_recall.codex_observation_sessions
          set lifecycle_state = 'error', last_error = $1, updated_at = $2
          where lifecycle_state in ('running', 'awaiting_approval')
        `,
        [message, now],
      );
    });
  }

  private async getTurn(id: string): Promise<CodexObservationTurn | null> {
    const result = await this.database.query<ObservationTurnRow>(
      `select ${TURN_COLUMNS} from agent_recall.codex_observation_turns where id = $1`,
      [id],
    );
    return result.rows[0] ? hydrateTurn(result.rows[0]) : null;
  }
}
