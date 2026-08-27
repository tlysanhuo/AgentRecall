/**
 * Parses pasted text into dataset cases.
 *
 * Cases usually already exist somewhere — a spreadsheet column, a JSON export, a
 * list in a spec — and retyping them one field at a time is where dataset
 * authoring stalls. Both shapes people actually have on the clipboard are
 * accepted, and a row that cannot be read is reported with its line number
 * rather than dropped, so an import never silently loses half the cases.
 */

export interface ParsedDatasetCase {
  input: string;
  expectedOutput?: string;
  context?: string;
}

export interface DatasetCaseParseResult {
  cases: ParsedDatasetCase[];
  /** One message per unusable row, with the line or index it came from. */
  errors: string[];
  format: "json" | "delimited" | "empty";
}

const MAX_CASES = 500;

export function parseDatasetCases(text: string): DatasetCaseParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { cases: [], errors: [], format: "empty" };
  return trimmed.startsWith("[") || trimmed.startsWith("{")
    ? parseJsonCases(trimmed)
    : parseDelimitedCases(trimmed);
}

function parseJsonCases(text: string): DatasetCaseParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    return {
      cases: [],
      errors: [`JSON 解析失败：${cause instanceof Error ? cause.message : String(cause)}`],
      format: "json",
    };
  }
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.cases)
      ? value.cases
      : Array.isArray((value as { items?: unknown }).items)
        ? (value as { items: unknown[] }).items
        : null;
  if (!rows) {
    return {
      cases: [],
      errors: ["需要一个数组，或含有 cases / items 数组的对象。"],
      format: "json",
    };
  }

  const cases: ParsedDatasetCase[] = [];
  const errors: string[] = [];
  for (const [index, row] of rows.entries()) {
    const label = `第 ${index + 1} 条`;
    if (typeof row === "string") {
      const input = row.trim();
      if (input) cases.push({ input });
      else errors.push(`${label}：内容为空。`);
      continue;
    }
    if (!isRecord(row)) {
      errors.push(`${label}：既不是字符串也不是对象。`);
      continue;
    }
    const input = firstString(row, ["input", "prompt", "question"]);
    if (!input) {
      errors.push(`${label}：缺少 input。`);
      continue;
    }
    const expectedOutput = firstString(row, ["expectedOutput", "expected", "answer", "output"]);
    const context = firstString(row, ["context"])
      ?? (isRecord(row.metadata) ? firstString(row.metadata, ["context"]) : undefined);
    cases.push({
      input,
      ...(expectedOutput !== undefined ? { expectedOutput } : {}),
      ...(context !== undefined ? { context } : {}),
    });
  }
  return capped(cases, errors, "json");
}

/**
 * Tab-separated rows, which is what a spreadsheet copy produces: input, then an
 * optional expected output, then an optional context.
 */
function parseDelimitedCases(text: string): DatasetCaseParseResult {
  const cases: ParsedDatasetCase[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const columns = line.split("\t").map((column) => column.trim());
    const input = columns[0] ?? "";
    if (!input) {
      errors.push(`第 ${index + 1} 行：第一列为空。`);
      continue;
    }
    const expectedOutput = columns[1];
    const context = columns[2];
    cases.push({
      input,
      ...(expectedOutput ? { expectedOutput } : {}),
      ...(context ? { context } : {}),
    });
  }
  return capped(cases, errors, "delimited");
}

function capped(
  cases: ParsedDatasetCase[],
  errors: string[],
  format: "json" | "delimited",
): DatasetCaseParseResult {
  if (cases.length <= MAX_CASES) return { cases, errors, format };
  // Truncating without saying so would look like a successful import of
  // everything that was pasted.
  return {
    cases: cases.slice(0, MAX_CASES),
    errors: [...errors, `一次最多导入 ${MAX_CASES} 条，已保留前 ${MAX_CASES} 条，其余 ${cases.length - MAX_CASES} 条被忽略。`],
    format,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}
