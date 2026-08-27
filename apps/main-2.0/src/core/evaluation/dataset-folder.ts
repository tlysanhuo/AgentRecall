/**
 * The on-disk evaluation dataset format.
 *
 * A dataset is a folder: `dataset.md` carries the overview a person or an agent
 * reads, and `cases/*.json` carries one case per file. The split is deliberate —
 * prose belongs in Markdown where it needs no escaping, while a case is
 * structured data whose fields must parse the same way every time.
 *
 * The folder is the source of truth. Importing copies it into the app; the
 * Markdown body stays in the file as documentation and is not stored, which is
 * why the loader never rewrites it.
 */

export interface DatasetFolderCase {
  id: string;
  input: string;
  expectedOutput?: string;
  context?: string;
  metadata: Record<string, unknown>;
  /** File the case came from, for reporting and for round-tripping. */
  fileName: string;
}

export interface DatasetFolderManifest {
  name: string;
  description: string;
  tags: string[];
}

export interface DatasetFolderInput {
  /** Contents of `dataset.md`, or null when the folder has none. */
  manifest: string | null;
  /** Contents of `cases/*.json`, in the order they should be read. */
  cases: Array<{ fileName: string; contents: string }>;
  /** Used as the dataset name when the manifest does not give one. */
  folderName?: string;
}

export interface DatasetFolderParseResult {
  manifest: DatasetFolderManifest;
  cases: DatasetFolderCase[];
  /** One message per unusable file; a bad case never silently disappears. */
  errors: string[];
}

export const DATASET_MANIFEST_FILE = "dataset.md";
export const DATASET_CASES_DIR = "cases";

/** Case files are read in filename order, which is why they are numbered. */
export function compareCaseFileNames(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

export function parseDatasetFolder(input: DatasetFolderInput): DatasetFolderParseResult {
  const errors: string[] = [];
  const manifest = parseManifest(input.manifest, input.folderName, errors);
  const cases: DatasetFolderCase[] = [];
  const seenIds = new Set<string>();

  for (const file of input.cases) {
    let value: unknown;
    try {
      value = JSON.parse(file.contents);
    } catch (cause) {
      errors.push(`${file.fileName}: JSON 解析失败（${cause instanceof Error ? cause.message : String(cause)}）。`);
      continue;
    }
    if (!isRecord(value)) {
      errors.push(`${file.fileName}: 顶层必须是一个 JSON 对象。`);
      continue;
    }
    const input_ = readString(value.input);
    if (!input_) {
      errors.push(`${file.fileName}: 缺少 input。`);
      continue;
    }
    const id = readString(value.id) ?? caseIdFromFileName(file.fileName);
    if (seenIds.has(id)) {
      // Two cases with one id would make a run's per-case records ambiguous, so
      // this is refused rather than resolved by picking a winner.
      errors.push(`${file.fileName}: 用例 id「${id}」重复。`);
      continue;
    }
    seenIds.add(id);
    const { id: _id, input: _input, expectedOutput, context, metadata, ...rest } = value;
    cases.push({
      id,
      input: input_,
      ...(readString(expectedOutput) !== undefined ? { expectedOutput: readString(expectedOutput)! } : {}),
      ...(readString(context) !== undefined ? { context: readString(context)! } : {}),
      // Unknown keys are kept rather than dropped: a folder may carry fields
      // this version does not know about yet.
      metadata: { ...(isRecord(metadata) ? metadata : {}), ...rest },
      fileName: file.fileName,
    });
  }

  if (cases.length === 0 && errors.length === 0) {
    errors.push(`没有找到用例。请在 ${DATASET_CASES_DIR}/ 下放入 *.json。`);
  }
  return { manifest, cases, errors };
}

/**
 * Serializes a dataset back into folder files.
 *
 * Round-tripping is what makes the folder usable as a working copy: an agent can
 * export, edit the files, and import again without the app being the only thing
 * that can write the format.
 */
export function datasetFolderFiles(input: {
  name: string;
  description: string;
  tags?: readonly string[];
  cases: ReadonlyArray<{
    id: string;
    input: string;
    expectedOutput?: string;
    context?: string;
    metadata?: Record<string, unknown>;
  }>;
}): { manifest: { fileName: string; contents: string }; cases: Array<{ fileName: string; contents: string }> } {
  const frontmatter = [
    "---",
    `name: ${yamlScalar(input.name)}`,
    `description: ${yamlScalar(input.description)}`,
    ...(input.tags && input.tags.length > 0
      ? [`tags: [${input.tags.map((tag) => yamlScalar(tag)).join(", ")}]`]
      : []),
    "---",
    "",
    `# ${input.name}`,
    "",
    input.description || "（暂无说明）",
    "",
    `本数据集共 ${input.cases.length} 条用例，位于 ${DATASET_CASES_DIR}/，按文件名顺序读取。`,
    "",
  ].join("\n");

  const width = String(input.cases.length).length;
  return {
    manifest: { fileName: DATASET_MANIFEST_FILE, contents: frontmatter },
    cases: input.cases.map((item, index) => ({
      fileName: `${DATASET_CASES_DIR}/${String(index + 1).padStart(Math.max(3, width), "0")}-${slug(item.id)}.json`,
      contents: `${JSON.stringify({
        id: item.id,
        input: item.input,
        ...(item.expectedOutput !== undefined ? { expectedOutput: item.expectedOutput } : {}),
        ...(item.context !== undefined ? { context: item.context } : {}),
        ...(item.metadata && Object.keys(item.metadata).length > 0 ? { metadata: item.metadata } : {}),
      }, null, 2)}\n`,
    })),
  };
}

function parseManifest(
  contents: string | null,
  folderName: string | undefined,
  errors: string[],
): DatasetFolderManifest {
  const fallback: DatasetFolderManifest = {
    name: folderName?.trim() || "未命名数据集",
    description: "",
    tags: [],
  };
  if (contents === null) {
    errors.push(`缺少 ${DATASET_MANIFEST_FILE}，已使用文件夹名作为数据集名称。`);
    return fallback;
  }
  const frontmatter = readFrontmatter(contents);
  if (!frontmatter) {
    errors.push(`${DATASET_MANIFEST_FILE} 缺少 frontmatter，已使用文件夹名作为数据集名称。`);
    return fallback;
  }
  return {
    name: frontmatter.name?.trim() || fallback.name,
    description: frontmatter.description?.trim() ?? "",
    tags: frontmatter.tags ?? [],
  };
}

/**
 * Reads the small subset of YAML the manifest uses: `key: value` and an inline
 * `[a, b]` list. Enough for this format, and it never fails on a body that
 * happens to contain `---`.
 */
function readFrontmatter(
  contents: string,
): { name?: string; description?: string; tags?: string[] } | null {
  const normalized = contents.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const end = normalized.indexOf("\n---", 3);
  if (end < 0) return null;
  const block = normalized.slice(4, end);
  const result: { name?: string; description?: string; tags?: string[] } = {};
  for (const line of block.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = unquote(rawValue!.trim());
    if (key === "name") result.name = value;
    else if (key === "description") result.description = value;
    else if (key === "tags") {
      result.tags = value.replace(/^\[|\]$/g, "")
        .split(",")
        .map((tag) => unquote(tag.trim()))
        .filter(Boolean);
    }
  }
  return result;
}

function unquote(value: string): string {
  const match = /^"(.*)"$|^'(.*)'$/.exec(value);
  return match ? (match[1] ?? match[2] ?? "") : value;
}

function yamlScalar(value: string): string {
  return /^[\w一-鿿][\w一-鿿 ()（）·、,，.。:：/-]*$/.test(value)
    ? value
    : JSON.stringify(value);
}

export function caseIdFromFileName(fileName: string): string {
  const base = fileName.split("/").pop() ?? fileName;
  return base.replace(/\.json$/i, "").replace(/^\d+[-_]/, "") || base;
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^\w一-鿿-]+/g, "-").replace(/^-+|-+$/g, "")
    || "case";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
