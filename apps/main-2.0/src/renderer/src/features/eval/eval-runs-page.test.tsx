// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EvaluationExperiment,
  EvaluationRun,
  EvaluationRunSummary,
} from "../../../../automation/contracts";
import { EvalRunsPage } from "./eval-runs-page";

const harness = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  listExperiments: vi.fn(),
}));

function summary(overrides: Partial<EvaluationRunSummary> = {}): EvaluationRunSummary {
  return {
    id: "run-1",
    experimentId: "experiment-1",
    status: "completed",
    startedAt: 1,
    engine: "graph",
    resultCount: 1,
    failedResultCount: 0,
    ...overrides,
  };
}

function experiment(): EvaluationExperiment {
  return {
    id: "experiment-1",
    name: "Login regression",
    datasetId: "dataset-1",
    agentId: "agent-1",
    evaluatorIds: [],
    repetitions: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function graphRun(): EvaluationRun {
  return {
    id: "run-1",
    experimentId: "experiment-1",
    status: "completed",
    engine: "graph",
    startedAt: 1,
    finishedAt: 2,
    passRate: 0,
    scoredCaseCount: 0,
    unscoredCaseCount: 1,
    results: [
      {
        id: "run-1:item-1:1",
        runId: "run-1",
        datasetItemId: "item-1",
        repetition: 1,
        input: "explain the failure",
        output: "",
        durationMs: 12,
        gatePassed: true,
        unscoredReason: "judge_runtime_not_configured",
        scores: [],
        nodes: [
          {
            nodeId: "agent",
            nodeType: "run_agent",
            nodeVersion: 1,
            role: "prepare",
            status: "pass",
            durationMs: 10,
          },
          {
            nodeId: "judge-broken",
            nodeType: "llm_judge",
            nodeVersion: 1,
            role: "judge",
            status: "excused",
            attribution: { type: "infra_failure", reason: "judge_runtime_not_configured" },
          },
          {
            nodeId: "skill-use",
            nodeType: "skill_use_observe",
            nodeVersion: 1,
            role: "prepare",
            status: "pass",
            facts: { injected: true, skillName: "review", skillHash: "h1", observable: false, used: null },
          },
        ],
      },
    ],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  harness.listRuns.mockReset();
  harness.getRun.mockReset();
  harness.listExperiments.mockReset();
  harness.listExperiments.mockResolvedValue([experiment()]);
  Object.assign(window, {
    sessionSearch: {
      automation: {
        listEvaluationRuns: harness.listRuns,
        getEvaluationRun: harness.getRun,
        listEvaluationExperiments: harness.listExperiments,
      },
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(EvalRunsPage, { language: "zh", onOpenSession: () => undefined }));
  });
}

describe("EvalRunsPage", () => {
  it("shows each step of the selected run with the reason it produced nothing", async () => {
    harness.listRuns.mockResolvedValue({ items: [summary()], total: 1, offset: 0, limit: 50 });
    harness.getRun.mockResolvedValue(graphRun());

    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("Login regression");
    expect(text).toContain("跑模型");
    expect(text).toContain("模型评判");
    // The judge could not decide, and the copy must say so rather than showing a zero.
    expect(text).toContain("无法判定");
    expect(text).toContain("评判器未配置 Runtime 通道");
    expect(text).toContain("未评分");
    // Skill use is unobservable here, which must not read as "went unused".
    expect(text).toContain("无法观测是否使用");
    expect(text).not.toContain("未使用该 Skill");
  });

  it("explains that a run recorded before the graph engine has no steps", async () => {
    harness.listRuns.mockResolvedValue({
      items: [summary({ engine: undefined })],
      total: 1,
      offset: 0,
      limit: 50,
    });
    harness.getRun.mockResolvedValue({
      id: "run-1",
      experimentId: "experiment-1",
      status: "completed",
      startedAt: 1,
      passRate: 1,
      results: [],
    } satisfies EvaluationRun);

    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("这次运行早于执行图");
    expect(text).toContain("旧格式");
  });

  it("reports a load failure instead of rendering an empty page", async () => {
    harness.listRuns.mockRejectedValue(new Error("database is not ready"));

    await render();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("database is not ready");
  });
  it("shows the score broken down by dimension, not one opaque number", async () => {
    harness.listRuns.mockResolvedValue({ items: [summary()], total: 1, offset: 0, limit: 50 });
    harness.getRun.mockResolvedValue({
      ...graphRun(),
      coverage: 0.75,
      dimensions: [
        { dimension: "正确性", score: 0.9, weight: 4, scoredCaseCount: 2 },
        { dimension: "简洁性", score: 0.4, weight: 1, scoredCaseCount: 2 },
      ],
      results: [{
        ...graphRun().results[0]!,
        unscoredReason: undefined,
        score: 0.8,
        passed: true,
        coverage: 0.5,
        dimensions: [
          { dimension: "正确性", score: 0.9, weight: 4, decided: 1, undecided: 0, met: 1, unmet: 0 },
          { dimension: "简洁性", score: 0.4, weight: 1, decided: 1, undecided: 1, met: 0, unmet: 1 },
        ],
        byLabel: { dimension: { 正确性: 0.9, 简洁性: 0.4 } },
        skippedEvaluatorIds: ["tool-failures"],
      }],
    } satisfies EvaluationRun);

    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("正确性");
    expect(text).toContain("简洁性");
    expect(text).toContain("覆盖率");
    expect(text).toContain("0.80");
    // A judge this source could not run has to stay visible rather than looking
    // like a check that passed.
    expect(text).toContain("不适用于该产物来源");
    expect(text).toContain("tool-failures");
  });

  it("calls a case passed on its weighted score, not on every check passing", async () => {
    // A case can clear its threshold with one check unmet; reading "all checks
    // passed" would contradict the score printed beside it.
    harness.listRuns.mockResolvedValue({ items: [summary()], total: 1, offset: 0, limit: 50 });
    harness.getRun.mockResolvedValue({
      ...graphRun(),
      results: [{
        ...graphRun().results[0]!,
        unscoredReason: undefined,
        score: 0.8,
        passed: true,
        scores: [
          { evaluatorId: "correct", score: 1, passed: true, durationMs: 1 },
          { evaluatorId: "brief", score: 0, passed: false, durationMs: 1 },
        ],
      }],
    } satisfies EvaluationRun);

    await render();

    expect(container.querySelector(".eval-graph-case header .eval-badge")?.textContent)
      .toBe("通过");
  });
});
