// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationExperiment } from "../../../../automation/contracts";
import { EvalGraphPage } from "./eval-graph-page";

const harness = vi.hoisted(() => ({
  listExperiments: vi.fn(),
  listDatasets: vi.fn(),
  getSnapshot: vi.fn(),
  saveExperiment: vi.fn(),
  listEvaluators: vi.fn(),
  listSkills: vi.fn(),
}));

function experiment(overrides: Partial<EvaluationExperiment> = {}): EvaluationExperiment {
  return {
    id: "experiment-1",
    name: "Login regression",
    datasetId: "dataset-1",
    agentId: "agent-1",
    evaluatorIds: [],
    repetitions: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  harness.listExperiments.mockReset().mockResolvedValue([experiment()]);
  harness.listDatasets.mockReset().mockResolvedValue([
    { id: "dataset-1", name: "Cases", description: "", items: [], createdAt: 1, updatedAt: 1 },
  ]);
  harness.getSnapshot.mockReset().mockResolvedValue({
    configuredAgents: [{ id: "agent-1", name: "Target" }],
    channels: [],
  });
  harness.saveExperiment.mockReset().mockImplementation(async (value: EvaluationExperiment) => value);
  harness.listEvaluators.mockReset().mockResolvedValue([]);
  harness.listSkills.mockReset().mockResolvedValue({ skills: [] });
  Object.assign(window, {
    sessionSearch: {
      listSkills: harness.listSkills,
      automation: {
        listEvaluationExperiments: harness.listExperiments,
        listEvaluationDatasets: harness.listDatasets,
        listEvaluationEvaluators: harness.listEvaluators,
        saveEvaluationExperiment: harness.saveExperiment,
        getSnapshot: harness.getSnapshot,
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
    root.render(createElement(EvalGraphPage, { language: "zh" }));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

describe("EvalGraphPage", () => {
  it("marks which experiments run a graph of their own", async () => {
    harness.listExperiments.mockResolvedValue([
      experiment(),
      experiment({
        id: "experiment-2",
        name: "Authored",
        graph: {
          version: 1,
          spec: { name: "authored", version: 1, nodes: [{ id: "task", type: "task_source" }] },
          layout: {},
        },
      }),
    ]);
    await render();

    const rows = [...container.querySelectorAll(".eval-graph-experiment-list li")]
      .map((item) => item.textContent ?? "");
    expect(rows[0]).toContain("默认形状");
    expect(rows[1]).toContain("自定义图");
  });

  it("opens the editor for an experiment", async () => {
    await render();

    await act(async () => {
      button("编辑图").click();
    });

    expect(container.textContent).toContain("图编辑器");
    expect(container.querySelector(".eval-editor-canvas")).not.toBeNull();
  });

  it("says a graph needs a dataset when there is none", async () => {
    harness.listDatasets.mockResolvedValue([]);
    await render();

    await act(async () => {
      button("新建图").click();
    });

    expect(container.textContent).toContain("请先在");
    expect(button("创建并编辑").disabled).toBe(true);
  });

  it("creates an experiment and goes straight into its editor", async () => {
    await render();

    await act(async () => {
      button("新建图").click();
    });
    await act(async () => {
      button("创建并编辑").click();
    });

    expect(harness.saveExperiment).toHaveBeenCalledTimes(1);
    expect(harness.saveExperiment.mock.calls[0]![0]).toMatchObject({
      datasetId: "dataset-1",
      agentId: "agent-1",
    });
    expect(container.textContent).toContain("图编辑器");
  });

  it("reports a load failure instead of an empty page", async () => {
    harness.listExperiments.mockRejectedValue(new Error("database is not ready"));
    await render();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("database is not ready");
  });
});
