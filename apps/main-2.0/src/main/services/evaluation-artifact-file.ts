import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { EvaluationRun } from "../../automation/contracts";

/**
 * Materializes the exact answer a judge read as a Markdown file owned by the app.
 *
 * Run and result ids are durable external data, so neither is used as a path
 * segment without both sanitizing it and adding a digest. The digest prevents two
 * ids that sanitize to the same text from silently overwriting one another.
 */
export async function materializeEvaluationArtifactFile(input: {
  userDataPath: string;
  run: EvaluationRun;
  experimentName: string;
  resultId: string;
}): Promise<string> {
  const result = input.run.results.find((item) => item.id === input.resultId);
  if (!result) throw new Error(`Evaluation case result was not found: ${input.resultId}`);
  if (!result.output.trim()) throw new Error("This evaluation case did not produce answer text.");

  const runDirectory = `${safeStem(input.run.id, "run")}-${shortDigest(input.run.id)}`;
  const caseNumber = input.run.results.indexOf(result) + 1;
  const fileStem = safeStem(input.experimentName, "evaluation");
  const resultDigest = shortDigest(result.id);
  const directory = path.join(input.userDataPath, "evaluation-artifacts", runDirectory);
  const filePath = path.join(directory, `${fileStem}-case-${caseNumber}-${resultDigest}.md`);

  await mkdir(directory, { recursive: true });
  // Keep the file byte-for-byte equivalent to the stored answer. Adding report
  // furniture here would make the portable artifact differ from what was judged.
  await writeFile(filePath, result.output, "utf8");
  return filePath;
}

function safeStem(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/\.+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "")
    .slice(0, 80);
  return normalized || fallback;
}

function shortDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}
