// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationDataset, EvaluationExperiment } from "../../../../automation/contracts";
import { EvalDatasetsPage } from "./eval-datasets-page";

const harness = vi.hoisted(() => ({
  listDatasets: vi.fn(),
  saveDataset: vi.fn(),
  deleteDataset: vi.fn(),
  listExperiments: vi.fn(),
  confirm: vi.fn(),
}));

function dataset(overrides: Partial<EvaluationDataset> = {}): EvaluationDataset {
  return {
    id: "dataset-1",
    name: "Login regression",
    description: "cases about login",
    items: [
      { id: "case-1", input: "why does login fail?", expectedOutput: "expired token", metadata: {}, sequence: 0 },
    ],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function experiment(datasetId: string): EvaluationExperiment {
  return {
    id: "experiment-1",
    name: "Uses it",
    datasetId,
    agentId: "agent-1",
    evaluatorIds: [],
    repetitions: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  harness.listDatasets.mockReset().mockResolvedValue([dataset()]);
  harness.saveDataset.mockReset().mockImplementation(async (value: EvaluationDataset) => value);
  harness.deleteDataset.mockReset().mockResolvedValue(true);
  harness.listExperiments.mockReset().mockResolvedValue([]);
  harness.confirm.mockReset().mockReturnValue(true);
  Object.assign(window, {
    confirm: harness.confirm,
    sessionSearch: {
      automation: {
        listEvaluationDatasets: harness.listDatasets,
        saveEvaluationDataset: harness.saveDataset,
        deleteEvaluationDataset: harness.deleteDataset,
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

async function render(onDirtyChange = vi.fn()): Promise<{ onDirtyChange: typeof onDirtyChange }> {
  await act(async () => {
    root.render(createElement(EvalDatasetsPage, { language: "zh", onDirtyChange }));
  });
  return { onDirtyChange };
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")]
    .find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

function fieldByLabel(label: string): HTMLTextAreaElement {
  const field = [...container.querySelectorAll("label")]
    .find((item) => item.querySelector("span")?.textContent?.includes(label));
  const control = field?.querySelector("textarea");
  if (!control) throw new Error(`field not found: ${label}`);
  return control as HTMLTextAreaElement;
}

async function type(element: HTMLTextAreaElement | HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("EvalDatasetsPage", () => {
  it("shows the selected dataset's cases with a context field", async () => {
    await render();

    expect(container.textContent).toContain("Login regression");
    expect(fieldByLabel("输入").value).toBe("why does login fail?");
    expect(fieldByLabel("期望输出").value).toBe("expired token");
    // The previous workspace had no way to set the context judges read.
    expect(fieldByLabel("评判上下文").value).toBe("");
  });

  it("saves an edited context into the case metadata", async () => {
    const { onDirtyChange } = await render();

    await type(fieldByLabel("评判上下文"), "auth module");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      button("保存").click();
    });

    expect(harness.saveDataset).toHaveBeenCalledTimes(1);
    const saved = harness.saveDataset.mock.calls[0]![0] as EvaluationDataset;
    expect(saved.items[0]!.metadata).toEqual({ context: "auth module" });
  });

  it("imports pasted cases and names the rows it could not read", async () => {
    await render();

    await act(async () => {
      button("批量粘贴").click();
    });
    const textarea = container.querySelector(".eval-dataset-import textarea") as HTMLTextAreaElement;
    await type(textarea, JSON.stringify([
      { input: "pasted one", expectedOutput: "1" },
      { expectedOutput: "no input" },
    ]));

    expect(container.textContent).toContain("识别到 1 条用例");
    expect(container.textContent).toContain("缺少 input");

    await act(async () => {
      button("追加").click();
    });

    // Appending keeps the case that was already there.
    const inputs = [...container.querySelectorAll("label")]
      .filter((item) => item.querySelector("span")?.textContent?.includes("输入"))
      .map((item) => (item.querySelector("textarea") as HTMLTextAreaElement).value);
    expect(inputs).toEqual(["why does login fail?", "pasted one"]);
  });

  it("warns that experiments depend on a dataset before deleting it", async () => {
    harness.listExperiments.mockResolvedValue([experiment("dataset-1")]);
    await render();

    await act(async () => {
      button("删除").click();
    });

    expect(harness.confirm).toHaveBeenCalledWith(expect.stringContaining("1 个实验正在使用"));
    expect(harness.deleteDataset).toHaveBeenCalledWith("dataset-1");
  });

  it("keeps a dataset when the delete is declined", async () => {
    harness.confirm.mockReturnValue(false);
    await render();

    await act(async () => {
      button("删除").click();
    });

    expect(harness.deleteDataset).not.toHaveBeenCalled();
  });

  it("creates a dataset from a built-in template", async () => {
    await render();
    const select = [...container.querySelectorAll("select")]
      .find((item) => item.textContent?.includes("从模板创建")) as HTMLSelectElement;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, "code-review");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(harness.saveDataset).toHaveBeenCalledTimes(1);
    const created = harness.saveDataset.mock.calls[0]![0] as EvaluationDataset;
    expect(created.name).toBe("代码审查基础集");
    expect(created.items.length).toBeGreaterThan(0);
    expect(created.items.every((item, index) => item.sequence === index)).toBe(true);
  });
});
