import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { EvaluationRun } from "../../automation/contracts";
import { materializeEvaluationArtifactFile } from "./evaluation-artifact-file";

function run(output = "# Technical report\n\nVerified result."): EvaluationRun {
  return {
    id: "run/../../one",
    experimentId: "experiment-1",
    status: "completed",
    startedAt: 1,
    results: [{
      id: "case/../../one",
      runId: "run/../../one",
      datasetItemId: "item-1",
      repetition: 1,
      input: "Write a report",
      output,
      durationMs: 1,
      scores: [],
    }],
  };
}

describe("materializeEvaluationArtifactFile", () => {
  it("writes the exact judged answer beneath the app-owned artifact directory", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "agent-recall-eval-artifact-"));

    const filePath = await materializeEvaluationArtifactFile({
      userDataPath,
      run: run(),
      experimentName: "技术写作 / 回归",
      resultId: "case/../../one",
    });

    expect(path.relative(userDataPath, filePath)).toMatch(/^evaluation-artifacts[\\/]/u);
    expect(path.relative(userDataPath, filePath)).not.toContain("..");
    await expect(readFile(filePath, "utf8")).resolves.toBe("# Technical report\n\nVerified result.");
  });

  it("refuses to invent a file when the case produced no answer", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "agent-recall-eval-artifact-"));

    await expect(materializeEvaluationArtifactFile({
      userDataPath,
      run: run("   "),
      experimentName: "Regression",
      resultId: "case/../../one",
    })).rejects.toThrow(/did not produce answer text/i);
  });
});
