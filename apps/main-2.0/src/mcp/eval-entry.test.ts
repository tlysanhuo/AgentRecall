import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PostgresDatabase } from "../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../core/postgres/schema";
import { PGliteTestPool } from "../core/postgres/test-pglite";
import { EvaluationStore } from "../automation/engine/main/evaluation-store";
import {
  addEvalDatasetCases,
  getEvalDataset,
  getEvalRunReport,
  listEvalDatasets,
  listEvalGraphs,
  listEvalRuns,
  writeEvalDataset,
} from "./eval-entry";

describe("evaluation MCP tools", () => {
  let database: PostgresDatabase;
  let store: EvaluationStore;

  beforeEach(async () => {
    database = new PostgresDatabase(new PGliteTestPool(), {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await database.initialize();
    store = new EvaluationStore(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it("creates a dataset and reads it back with its cases", async () => {
    const created = await writeEvalDataset(store, {
      name: "Login regression",
      description: "cases about the login flow",
      cases: [
        { input: "why does login fail?", expectedOutput: "expired token", context: "auth module" },
        { input: "how do we refresh it?" },
      ],
    });

    expect(created.caseCount).toBe(2);
    expect(created.cases[0]).toMatchObject({
      input: "why does login fail?",
      expectedOutput: "expired token",
      context: "auth module",
    });
    expect(created.cases[1]!.context).toBeUndefined();
    await expect(listEvalDatasets(store)).resolves.toMatchObject([
      { name: "Login regression", caseCount: 2 },
    ]);
  });

  it("finds a dataset by name as well as by id", async () => {
    const created = await writeEvalDataset(store, {
      name: "Named dataset",
      cases: [{ input: "one" }],
    });

    await expect(getEvalDataset(store, "Named dataset")).resolves.toMatchObject({ id: created.id });
    await expect(getEvalDataset(store, created.id)).resolves.toMatchObject({ id: created.id });
    await expect(getEvalDataset(store, "missing")).resolves.toBeNull();
  });

  it("replaces every case when writing an existing dataset", async () => {
    // Replacement is total on purpose: a dataset is the specification a run is
    // measured against, so a silent merge would change what a score means.
    const created = await writeEvalDataset(store, {
      name: "Replaceable",
      cases: [{ input: "old one" }, { input: "old two" }],
    });

    const replaced = await writeEvalDataset(store, {
      datasetId: created.id,
      name: "Replaceable",
      cases: [{ input: "new only" }],
    });

    expect(replaced.id).toBe(created.id);
    expect(replaced.cases.map((item) => item.input)).toEqual(["new only"]);
  });

  it("appends cases without disturbing the existing ones", async () => {
    const created = await writeEvalDataset(store, {
      name: "Growing",
      cases: [{ input: "first" }],
    });

    const grown = await addEvalDatasetCases(store, {
      datasetId: created.id,
      cases: [{ input: "second" }],
    });

    expect(grown.cases.map((item) => item.input)).toEqual(["first", "second"]);
    expect(grown.cases[0]!.id).toBe(created.cases[0]!.id);
  });

  it("refuses a dataset with no cases or no name", async () => {
    await expect(writeEvalDataset(store, { name: "Empty", cases: [] }))
      .rejects.toThrow(/at least one case/i);
    await expect(writeEvalDataset(store, { name: "  ", cases: [{ input: "x" }] }))
      .rejects.toThrow(/name is required/i);
    await expect(writeEvalDataset(store, { name: "Blank case", cases: [{ input: "   " }] }))
      .rejects.toThrow(/needs an input/i);
  });

  it("reports which experiments run an authored graph", async () => {
    const dataset = await writeEvalDataset(store, { name: "For graphs", cases: [{ input: "x" }] });
    const now = Date.now();
    await store.saveExperiment({
      id: "experiment-derived",
      name: "Derived",
      datasetId: dataset.id,
      agentId: "agent-1",
      evaluatorIds: [],
      repetitions: 1,
      createdAt: now,
      updatedAt: now,
    });
    await store.saveExperiment({
      id: "experiment-authored",
      name: "Authored",
      datasetId: dataset.id,
      agentId: "agent-1",
      evaluatorIds: [],
      repetitions: 1,
      graph: {
        version: 1,
        spec: { name: "authored", version: 1, nodes: [{ id: "task", type: "task_source" }] },
        layout: {},
      },
      createdAt: now,
      updatedAt: now,
    });

    const graphs = await listEvalGraphs(store);

    expect(graphs.find((item) => item.experimentId === "experiment-derived")!.customGraph).toBe(false);
    expect(graphs.find((item) => item.experimentId === "experiment-authored")!.customGraph).toBe(true);
  });

  it("reports a run's steps and why a case produced nothing", async () => {
    const dataset = await writeEvalDataset(store, { name: "For runs", cases: [{ input: "x" }] });
    const now = Date.now();
    await store.saveExperiment({
      id: "experiment-1",
      name: "Runs",
      datasetId: dataset.id,
      agentId: "agent-1",
      evaluatorIds: [],
      repetitions: 1,
      createdAt: now,
      updatedAt: now,
    });
    await store.saveRun({
      id: "run-1",
      experimentId: "experiment-1",
      status: "failed",
      engine: "graph",
      startedAt: now,
      scoredCaseCount: 0,
      unscoredCaseCount: 1,
      results: [
        {
          id: "run-1:case-1:1",
          runId: "run-1",
          datasetItemId: "case-1",
          repetition: 1,
          input: "x",
          output: "",
          durationMs: 1,
          unscoredReason: "judge_runtime_not_configured",
          sessionKey: "claude:thread-1",
          scores: [],
          nodes: [
            {
              nodeId: "judge",
              nodeType: "llm_judge",
              nodeVersion: 1,
              role: "judge",
              status: "excused",
              attribution: { type: "infra_failure", reason: "judge_runtime_not_configured" },
            },
          ],
        },
      ],
    });

    await expect(listEvalRuns(store, { experimentId: "experiment-1" }))
      .resolves.toMatchObject([{ runId: "run-1", status: "failed", unscoredCaseCount: 1 }]);
    const report = await getEvalRunReport(store, "run-1");
    expect(report!.cases[0]).toMatchObject({
      passed: false,
      unscoredReason: "judge_runtime_not_configured",
      sessionKey: "claude:thread-1",
      steps: [{ node: "judge", status: "excused", reason: "judge_runtime_not_configured" }],
    });
    await expect(getEvalRunReport(store, "missing")).resolves.toBeNull();
  });
});
