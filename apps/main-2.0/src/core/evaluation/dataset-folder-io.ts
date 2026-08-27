import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  compareCaseFileNames,
  datasetFolderFiles,
  DATASET_CASES_DIR,
  DATASET_MANIFEST_FILE,
  parseDatasetFolder,
  type DatasetFolderCase,
  type DatasetFolderParseResult,
} from "./dataset-folder";

/**
 * Filesystem side of the dataset folder format.
 *
 * The parser and serializer stay free of `node:fs` so they can be tested and
 * reused anywhere; only this module touches disk. Nothing here is reachable from
 * the renderer.
 */

const MAX_CASE_FILES = 1_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function readDatasetFolder(directory: string): DatasetFolderParseResult {
  const root = path.resolve(directory);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`不是一个文件夹：${root}`);
  }
  const manifestPath = path.join(root, DATASET_MANIFEST_FILE);
  const manifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : null;

  const casesDir = path.join(root, DATASET_CASES_DIR);
  const errors: string[] = [];
  const cases: Array<{ fileName: string; contents: string }> = [];
  if (fs.existsSync(casesDir) && fs.statSync(casesDir).isDirectory()) {
    const entries = fs.readdirSync(casesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => entry.name)
      .sort(compareCaseFileNames);
    for (const name of entries.slice(0, MAX_CASE_FILES)) {
      const fileName = `${DATASET_CASES_DIR}/${name}`;
      const filePath = path.join(casesDir, name);
      const size = fs.statSync(filePath).size;
      if (size > MAX_FILE_BYTES) {
        errors.push(`${fileName}: 文件超过 2 MiB，已跳过。`);
        continue;
      }
      cases.push({ fileName, contents: fs.readFileSync(filePath, "utf8") });
    }
    if (entries.length > MAX_CASE_FILES) {
      // Silently reading the first thousand would look like a complete import.
      errors.push(`用例文件超过 ${MAX_CASE_FILES} 个，仅读取了前 ${MAX_CASE_FILES} 个。`);
    }
  }

  const parsed = parseDatasetFolder({
    manifest,
    cases,
    folderName: path.basename(root),
  });
  return { ...parsed, errors: [...errors, ...parsed.errors] };
}

/**
 * Writes a dataset folder.
 *
 * Existing case files are removed first, so exporting a dataset that lost a case
 * does not leave the deleted one behind to be re-imported later. Only `*.json`
 * under `cases/` is touched; anything else a user keeps in the folder stays.
 */
export function writeDatasetFolder(
  directory: string,
  dataset: Parameters<typeof datasetFolderFiles>[0],
): { manifestPath: string; caseCount: number } {
  const root = path.resolve(directory);
  const files = datasetFolderFiles(dataset);
  fs.mkdirSync(path.join(root, DATASET_CASES_DIR), { recursive: true });

  const casesDir = path.join(root, DATASET_CASES_DIR);
  for (const entry of fs.readdirSync(casesDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
      fs.rmSync(path.join(casesDir, entry.name));
    }
  }

  const manifestPath = path.join(root, files.manifest.fileName);
  fs.writeFileSync(manifestPath, files.manifest.contents, "utf8");
  for (const file of files.cases) {
    fs.writeFileSync(path.join(root, file.fileName), file.contents, "utf8");
  }
  return { manifestPath, caseCount: files.cases.length };
}

/**
 * A dataset id that follows the folder rather than the moment of import.
 *
 * Re-importing after editing the files updates the same dataset instead of
 * leaving a pile of near-copies — the folder is the source of truth, and a
 * path-derived id keeps the app's copy tracking it. The path is resolved first so
 * a relative and an absolute reference are the same dataset.
 */
export function datasetFolderId(directory: string): string {
  const digest = createHash("sha256").update(path.resolve(directory)).digest("hex");
  return `dataset-folder-${digest.slice(0, 16)}`;
}

/**
 * The dataset rows a parsed folder becomes.
 *
 * Item ids are namespaced by the dataset because the store keys them globally:
 * exporting a dataset and importing the copy would otherwise collide with the
 * original. Deriving the id from the folder and the case's own id — rather than
 * minting a fresh one — is what lets a case keep its identity across re-imports,
 * so two runs of the same case stay comparable after the files are edited.
 */
export function datasetFolderItems(
  datasetId: string,
  cases: readonly DatasetFolderCase[],
): Array<{
  id: string;
  input: string;
  expectedOutput?: string;
  metadata: Record<string, unknown>;
  sequence: number;
}> {
  return cases.map((item, index) => ({
    id: `${datasetId}:${item.id}`,
    input: item.input,
    ...(item.expectedOutput !== undefined ? { expectedOutput: item.expectedOutput } : {}),
    // Judges read `context` from metadata, so that is where it has to land.
    metadata: item.context !== undefined
      ? { ...item.metadata, context: item.context }
      : item.metadata,
    sequence: index,
  }));
}

/**
 * The case id as it belongs in the file, undoing the namespacing done on import.
 *
 * Without this an exported case would carry the store's internal id, and
 * importing that copy would prefix it a second time — the file is meant to read
 * as the user's own label for the case.
 */
export function datasetFolderCaseId(datasetId: string, itemId: string): string {
  const prefix = `${datasetId}:`;
  return itemId.startsWith(prefix) ? itemId.slice(prefix.length) : itemId;
}
