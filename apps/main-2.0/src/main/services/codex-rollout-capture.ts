import { lstat, open, readdir, stat } from "node:fs/promises";
import path from "node:path";

const FIRST_LINE_LIMIT_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export interface CodexRolloutCursor {
  sourcePath: string;
  offset: number;
}

interface RolloutCandidate {
  filePath: string;
  preferred: boolean;
  mtimeMs: number;
}

async function listRolloutCandidates(
  root: string,
  threadId: string,
): Promise<RolloutCandidate[]> {
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
  } catch {
    return [];
  }

  const candidates: RolloutCandidate[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLocaleLowerCase().endsWith(".jsonl")) continue;
      try {
        const fileStat = await stat(entryPath);
        candidates.push({
          filePath: entryPath,
          preferred: entry.name.includes(threadId),
          mtimeMs: fileStat.mtimeMs,
        });
      } catch {
        // The file changed while walking; a later capture pass can retry it.
      }
    }
  };
  await walk(root);
  return candidates;
}

async function firstCompleteLine(filePath: string): Promise<string | null> {
  const handle = await open(filePath, "r");
  try {
    let collected = Buffer.alloc(0);
    let position = 0;
    while (collected.length < FIRST_LINE_LIMIT_BYTES) {
      const remaining = FIRST_LINE_LIMIT_BYTES - collected.length;
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) return null;
      position += bytesRead;
      collected = Buffer.concat([collected, chunk.subarray(0, bytesRead)]);
      const newline = collected.indexOf(0x0a);
      if (newline >= 0) return collected.subarray(0, newline).toString("utf8").replace(/\r$/u, "");
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function hasMatchingThread(filePath: string, threadId: string): Promise<boolean> {
  try {
    const line = await firstCompleteLine(filePath);
    if (!line) return false;
    const row = JSON.parse(line) as {
      type?: unknown;
      payload?: { id?: unknown };
    };
    return row.type === "session_meta" && row.payload?.id === threadId;
  } catch {
    return false;
  }
}

export async function locateCodexRollout(codexHome: string, threadId: string): Promise<string | null> {
  if (!threadId) return null;
  const candidates = [
    ...await listRolloutCandidates(path.join(codexHome, "sessions"), threadId),
    ...await listRolloutCandidates(path.join(codexHome, "archived_sessions"), threadId),
  ].sort((left, right) => (
    Number(right.preferred) - Number(left.preferred)
    || right.mtimeMs - left.mtimeMs
    || left.filePath.localeCompare(right.filePath)
  ));
  for (const candidate of candidates) {
    if (await hasMatchingThread(candidate.filePath, threadId)) return candidate.filePath;
  }
  return null;
}

export async function captureCodexRollout(input: {
  codexHome: string;
  threadId: string;
  cursor: CodexRolloutCursor | null;
  appendLines(lines: string[]): Promise<void>;
}): Promise<{ cursor: CodexRolloutCursor | null; copied: number; sourceAvailable: boolean }> {
  const sourcePath = await locateCodexRollout(input.codexHome, input.threadId);
  if (!sourcePath) {
    return { cursor: input.cursor, copied: 0, sourceAvailable: false };
  }

  const fileStat = await stat(sourcePath);
  let offset = input.cursor?.sourcePath === sourcePath ? input.cursor.offset : 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > fileStat.size) offset = 0;
  const handle = await open(sourcePath, "r");
  const lines: string[] = [];
  let remainder = Buffer.alloc(0);
  let position = offset;
  try {
    while (position < fileStat.size) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, fileStat.size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const combined = remainder.length > 0
        ? Buffer.concat([remainder, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      let lineStart = 0;
      for (;;) {
        const newline = combined.indexOf(0x0a, lineStart);
        if (newline < 0) break;
        let lineEnd = newline;
        if (lineEnd > lineStart && combined[lineEnd - 1] === 0x0d) lineEnd -= 1;
        lines.push(combined.subarray(lineStart, lineEnd).toString("utf8"));
        lineStart = newline + 1;
      }
      remainder = Buffer.from(combined.subarray(lineStart));
    }
  } finally {
    await handle.close();
  }

  if (lines.length > 0) await input.appendLines(lines);
  const nextOffset = position - remainder.length;
  return {
    cursor: { sourcePath, offset: nextOffset },
    copied: lines.length,
    sourceAvailable: true,
  };
}
