import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  CodexObservationEventPage,
  CodexObservationEventSummary,
  CodexObservationIntegrityState,
  CodexObservationStream,
} from "../../shared/codex-observation";

const INLINE_PAYLOAD_BYTES = 16 * 1024;
const MAX_PAGE_SIZE = 200;
const SENSITIVE_KEY = /api[_-]?key|token|password|secret|authorization|cookie|set-cookie/iu;

export interface ObservationRecordInput {
  stream: CodexObservationStream;
  direction: CodexObservationEventSummary["direction"];
  kind: string;
  method?: string;
  turnId?: string;
  payload: unknown;
}

export interface ObservationJournalFileSystem {
  mkdir(directory: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, contents: string): Promise<void>;
  appendFile(filePath: string, contents: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  readdir(directory: string): Promise<Dirent[]>;
  stat(filePath: string): Promise<Stats>;
}

interface ObservationManifest {
  version: 1;
  sessionId: string;
  nextSeq: number;
  integrityState: CodexObservationIntegrityState;
  integrityReason?: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredObservationEvent extends CodexObservationEventSummary {
  payload?: unknown;
}

const defaultFileSystem: ObservationJournalFileSystem = {
  async mkdir(directory) {
    await mkdir(directory, { recursive: true });
  },
  readFile(filePath) {
    return readFile(filePath, "utf8");
  },
  async writeFile(filePath, contents) {
    await writeFile(filePath, contents, "utf8");
  },
  async appendFile(filePath, contents) {
    await appendFile(filePath, contents, "utf8");
  },
  async rename(source, destination) {
    await rename(source, destination);
  },
  async unlink(filePath) {
    await unlink(filePath);
  },
  readdir(directory) {
    return readdir(directory, { withFileTypes: true });
  },
  stat(filePath) {
    return stat(filePath);
  },
};

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isExistingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function normalizePayload(
  value: unknown,
  seen: WeakSet<object>,
  state: { redacted: boolean },
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizePayload(item, seen, state));
    seen.delete(value);
    return normalized;
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      normalized[key] = "[REDACTED]";
      state.redacted = true;
    } else {
      normalized[key] = normalizePayload(child, seen, state);
    }
  }
  seen.delete(value);
  return normalized;
}

function redactPayload(payload: unknown): { json: string; value: unknown; redacted: boolean } {
  const state = { redacted: false };
  const value = normalizePayload(payload, new WeakSet(), state);
  return {
    json: JSON.stringify(value),
    value,
    redacted: state.redacted,
  };
}

function payloadType(payload: unknown): string {
  if (payload === null) return "null";
  if (Array.isArray(payload)) return "array";
  return typeof payload;
}

function previewFor(input: ObservationRecordInput, redactedPayload: unknown): string {
  const normalized = JSON.stringify(redactedPayload).replace(/\s+/gu, " ").trim();
  const prefix = `${input.method ?? input.kind} · ${payloadType(redactedPayload)}`;
  const preview = normalized ? `${prefix} · ${normalized}` : prefix;
  return preview.length <= 240 ? preview : `${preview.slice(0, 239)}…`;
}

function streamFileName(stream: CodexObservationStream): string {
  if (stream === "timeline") return "timeline.jsonl";
  if (stream === "rollout") return "rollout.jsonl";
  return "journal.jsonl";
}

function eventLine(event: CodexObservationEventSummary, payloadJson: string | null): string {
  const summary = JSON.stringify(event);
  if (payloadJson === null) return `${summary}\n`;
  return `${summary.slice(0, -1)},"payload":${payloadJson}}\n`;
}

function storedEventSummary(row: StoredObservationEvent): CodexObservationEventSummary {
  return {
    seq: Number(row.seq),
    occurredAt: row.occurredAt,
    stream: row.stream,
    direction: row.direction,
    kind: row.kind,
    method: row.method ?? null,
    turnId: row.turnId ?? null,
    preview: row.preview,
    payloadRef: row.payloadRef ?? null,
    redacted: Boolean(row.redacted),
  };
}

export class CodexObservationJournal {
  private writeChain: Promise<void> = Promise.resolve();
  private firstWriteError: Error | null = null;
  private writeErrorReported = false;
  private closed = false;

  private constructor(
    private readonly directory: string,
    private readonly fileSystem: ObservationJournalFileSystem,
    private readonly onWriteError: ((error: Error) => void) | undefined,
    private manifest: ObservationManifest,
  ) {}

  static async open(input: {
    rootDir: string;
    sessionId: string;
    onWriteError?: (error: Error) => void;
    fileSystem?: Partial<ObservationJournalFileSystem>;
  }): Promise<CodexObservationJournal> {
    if (!/^(?!\.{1,2}$)[a-zA-Z0-9._-]+$/u.test(input.sessionId)) {
      throw new Error("Invalid Codex observation session id.");
    }
    const fileSystem = { ...defaultFileSystem, ...input.fileSystem };
    const directory = path.join(input.rootDir, input.sessionId);
    await fileSystem.mkdir(path.join(directory, "blobs"));
    const manifestPath = path.join(directory, "manifest.json");
    let manifest: ObservationManifest;
    try {
      const stored = JSON.parse(await fileSystem.readFile(manifestPath)) as ObservationManifest;
      if (stored.sessionId !== input.sessionId || stored.version !== 1) {
        throw new Error("Codex observation manifest does not match the requested session.");
      }
      manifest = stored;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const now = new Date().toISOString();
      manifest = {
        version: 1,
        sessionId: input.sessionId,
        nextSeq: 1,
        integrityState: "pending",
        createdAt: now,
        updatedAt: now,
      };
      await CodexObservationJournal.writeAtomic(fileSystem, manifestPath, JSON.stringify(manifest, null, 2));
    }
    return new CodexObservationJournal(directory, fileSystem, input.onWriteError, manifest);
  }

  record(input: ObservationRecordInput): CodexObservationEventSummary {
    if (this.closed) throw new Error("Codex observation journal is closed.");
    const redacted = redactPayload(input.payload);
    const payloadBytes = Buffer.byteLength(redacted.json);
    const payloadRef = payloadBytes > INLINE_PAYLOAD_BYTES
      ? createHash("sha256").update(redacted.json).digest("hex")
      : null;
    const event: CodexObservationEventSummary = {
      seq: this.manifest.nextSeq,
      occurredAt: new Date().toISOString(),
      stream: input.stream,
      direction: input.direction,
      kind: input.kind,
      method: input.method ?? null,
      turnId: input.turnId ?? null,
      preview: previewFor(input, redacted.value),
      payloadRef,
      redacted: redacted.redacted,
    };
    this.manifest = {
      ...this.manifest,
      nextSeq: event.seq + 1,
      updatedAt: event.occurredAt,
    };
    const manifestSnapshot = { ...this.manifest };
    this.enqueue(async () => {
      if (payloadRef) await this.writeBlob(payloadRef, redacted.json);
      await this.fileSystem.appendFile(
        path.join(this.directory, streamFileName(event.stream)),
        eventLine(event, payloadRef ? null : redacted.json),
      );
      await this.writeManifest(manifestSnapshot);
    });
    return event;
  }

  async flush(): Promise<void> {
    await this.writeChain;
    if (this.firstWriteError) throw this.firstWriteError;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
  }

  async readEvents(input: {
    stream: CodexObservationStream;
    afterSeq: number;
    limit: number;
  }): Promise<CodexObservationEventPage> {
    await this.flush();
    const rows = (await this.readStoredEvents(input.stream))
      .filter((event) => Number(event.seq) > Math.max(0, input.afterSeq))
      .sort((left, right) => Number(left.seq) - Number(right.seq));
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(input.limit) || 1));
    const selected = rows.slice(0, limit);
    return {
      events: selected.map(storedEventSummary),
      nextAfterSeq: rows.length > selected.length && selected.length > 0
        ? Number(selected[selected.length - 1]!.seq)
        : null,
    };
  }

  async readPayload(event: CodexObservationEventSummary): Promise<string> {
    await this.flush();
    const stored = (await this.readStoredEvents(event.stream))
      .find((candidate) => Number(candidate.seq) === event.seq);
    if (!stored) throw new Error(`Codex observation event not found: ${event.seq}`);
    if (stored.payloadRef) {
      if (!/^[a-f0-9]{64}$/u.test(stored.payloadRef)) {
        throw new Error("Invalid Codex observation payload reference.");
      }
      return this.fileSystem.readFile(path.join(this.directory, "blobs", stored.payloadRef));
    }
    return JSON.stringify(stored.payload ?? null, null, 2);
  }

  async appendRolloutLines(lines: string[]): Promise<void> {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(trimmed);
      } catch (error) {
        throw new Error("Codex rollout contained an invalid complete JSON row.", { cause: error });
      }
      const object = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
      const nested = object?.payload && typeof object.payload === "object" && !Array.isArray(object.payload)
        ? object.payload as Record<string, unknown>
        : null;
      this.record({
        stream: "rollout",
        direction: "internal",
        kind: typeof object?.type === "string" ? object.type : "rollout",
        method: typeof nested?.type === "string" ? nested.type : undefined,
        payload,
      });
    }
    await this.flush();
  }

  rolloutPath(): string {
    return path.join(this.directory, "rollout.jsonl");
  }

  sessionDirectory(): string {
    return this.directory;
  }

  async storageBytes(): Promise<number> {
    await this.flush();
    const visit = async (target: string): Promise<number> => {
      const entries = await this.fileSystem.readdir(target);
      let total = 0;
      for (const entry of entries) {
        const entryPath = path.join(target, entry.name);
        if (entry.isDirectory()) total += await visit(entryPath);
        else total += (await this.fileSystem.stat(entryPath)).size;
      }
      return total;
    };
    return visit(this.directory);
  }

  async markIntegrity(state: CodexObservationIntegrityState, reason?: string): Promise<void> {
    if (this.closed) throw new Error("Codex observation journal is closed.");
    this.manifest = {
      ...this.manifest,
      integrityState: state,
      ...(reason ? { integrityReason: reason } : { integrityReason: undefined }),
      updatedAt: new Date().toISOString(),
    };
    const snapshot = { ...this.manifest };
    await this.enqueue(() => this.writeManifest(snapshot));
    if (this.firstWriteError) throw this.firstWriteError;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.writeChain.then(operation);
    this.writeChain = pending.catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.firstWriteError ??= normalized;
      if (!this.writeErrorReported) {
        this.writeErrorReported = true;
        this.onWriteError?.(normalized);
      }
    });
    return pending;
  }

  private async readStoredEvents(stream: CodexObservationStream): Promise<StoredObservationEvent[]> {
    let contents: string;
    try {
      contents = await this.fileSystem.readFile(path.join(this.directory, streamFileName(stream)));
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    return contents
      .split(/\r?\n/gu)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredObservationEvent)
      .filter((event) => event.stream === stream);
  }

  private async writeBlob(hash: string, contents: string): Promise<void> {
    const destination = path.join(this.directory, "blobs", hash);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await this.fileSystem.writeFile(temporary, contents);
    try {
      await this.fileSystem.rename(temporary, destination);
    } catch (error) {
      if (!isExistingFile(error)) throw error;
      await this.fileSystem.unlink(temporary).catch(() => undefined);
    }
  }

  private writeManifest(manifest: ObservationManifest): Promise<void> {
    return CodexObservationJournal.writeAtomic(
      this.fileSystem,
      path.join(this.directory, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
  }

  private static async writeAtomic(
    fileSystem: ObservationJournalFileSystem,
    destination: string,
    contents: string,
  ): Promise<void> {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await fileSystem.writeFile(temporary, contents);
    try {
      await fileSystem.rename(temporary, destination);
    } catch (error) {
      await fileSystem.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
