// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationExperiment } from "../../../../automation/contracts";
import { EvalGraphEditor } from "./eval-graph-editor";

const harness = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  listEvaluators: vi.fn(),
  listSkills: vi.fn(),
  saveExperiment: vi.fn(),
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
  harness.getSnapshot.mockReset();
  harness.listEvaluators.mockReset();
  harness.listSkills.mockReset();
  harness.saveExperiment.mockReset();
  harness.getSnapshot.mockResolvedValue({
    configuredAgents: [{ id: "agent-1", name: "Target" }],
  });
  harness.listEvaluators.mockResolvedValue([
    { id: "judge-1", name: "Judge", kind: "llm_judge", threshold: 0.6, enabled: true, createdAt: 1, updatedAt: 1 },
  ]);
  harness.listSkills.mockResolvedValue({ skills: [{ name: "review" }] });
  harness.saveExperiment.mockImplementation(async (value: EvaluationExperiment) => value);
  Object.assign(window, {
    sessionSearch: {
      listSkills: harness.listSkills,
      automation: {
        getSnapshot: harness.getSnapshot,
        listEvaluationEvaluators: harness.listEvaluators,
        saveEvaluationExperiment: harness.saveExperiment,
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

async function render(value: EvaluationExperiment, onSaved = vi.fn()): Promise<{ onSaved: typeof onSaved }> {
  await act(async () => {
    root.render(createElement(EvalGraphEditor, {
      language: "zh",
      experiment: value,
      onSaved,
      onClose: () => undefined,
    }));
  });
  return { onSaved };
}

/** Node labels on the canvas, excluding the palette which always lists them all. */
function canvasNodeLabels(): string[] {
  return [...container.querySelectorAll(".eval-editor-node > header > span")]
    .map((element) => element.textContent ?? "");
}

function saveButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")]
    .find((item) => item.textContent?.includes("保存图"));
  if (!button) throw new Error("save button was not rendered");
  return button as HTMLButtonElement;
}

describe("EvalGraphEditor", () => {
  it("seeds a first edit from the shape the runner derives", async () => {
    await render(experiment());

    // Starting from an empty canvas would make the first save a downgrade of a
    // graph that already worked.
    expect(canvasNodeLabels()).toEqual([
      "任务",
      "Skill 注入",
      "跑模型",
      "会话关联",
      "Skill 使用",
    ]);
    expect(container.textContent ?? "").toContain("校验通过");
    expect(saveButton().disabled).toBe(false);
  });

  it("reopens a saved graph instead of re-deriving it", async () => {
    await render(experiment({
      graph: {
        version: 1,
        spec: {
          name: "authored",
          version: 1,
          nodes: [
            { id: "task", type: "task_source", config: {} },
            { id: "skill", type: "skill_provision", config: {} },
            {
              id: "agent",
              type: "run_agent",
              config: { agentId: "agent-1" },
              in: { task: "task.task", instructions: "skill.instructions" },
            },
          ],
        },
        layout: { task: { x: 10, y: 10 }, skill: { x: 10, y: 140 }, agent: { x: 240, y: 60 } },
      },
    }));

    // The derived shape includes session linkage; the saved one does not.
    expect(canvasNodeLabels()).toEqual(["任务", "Skill 注入", "跑模型"]);
    expect(saveButton().disabled).toBe(false);
  });

  it("refuses to save a graph the builder rejects and says why", async () => {
    await render(experiment({
      graph: {
        version: 1,
        spec: {
          name: "broken",
          version: 1,
          nodes: [
            { id: "task", type: "task_source", config: {} },
            {
              id: "judge",
              type: "llm_judge",
              config: { evaluatorId: "judge-1" },
              // A judge fed the task where it expects the artifact.
              in: { task: "task.task", artifact: "task.task" },
            },
          ],
        },
        layout: {},
      },
    }));

    expect(container.textContent ?? "").toContain("类型不匹配");
    expect(saveButton().disabled).toBe(true);
    expect(harness.saveExperiment).not.toHaveBeenCalled();
  });

  it("saves the spec together with the node layout", async () => {
    const { onSaved } = await render(experiment());

    await act(async () => {
      saveButton().click();
    });

    expect(harness.saveExperiment).toHaveBeenCalledTimes(1);
    const saved = harness.saveExperiment.mock.calls[0]![0] as EvaluationExperiment;
    expect(saved.graph?.spec.nodes.map((node) => node.id)).toContain("agent");
    // Layout covers every node, so reopening the editor restores the same canvas.
    expect(Object.keys(saved.graph?.layout ?? {}).sort())
      .toEqual(saved.graph!.spec.nodes.map((node) => node.id).sort());
    expect(onSaved).toHaveBeenCalledWith(saved);
  });
  it("saves the evaluators the canvas judges with, and the source it reads", async () => {
    // The experiment's evaluator list is what the runner filters judges by, so a
    // judge added on the canvas has to end up in it or it would be disabled at
    // run time for not being in a list the editor never showed.
    await render(experiment({
      graph: {
        version: 1,
        spec: {
          name: "authored",
          version: 1,
          nodes: [
            { id: "task", type: "task_source", config: {} },
            { id: "source", type: "session_artifact", in: { task: "task.task" } },
            {
              id: "judge",
              type: "llm_judge",
              config: { evaluatorId: "judge-1", threshold: 0.6, prompt: "", runtimeId: "claude" },
              in: { task: "task.task", artifact: "source.artifact" },
            },
          ],
        },
        layout: {},
      },
    }));

    await act(async () => {
      saveButton().click();
    });

    expect(harness.saveExperiment).toHaveBeenCalledWith(expect.objectContaining({
      evaluatorIds: ["judge-1"],
      source: "session",
    }));
  });
});
