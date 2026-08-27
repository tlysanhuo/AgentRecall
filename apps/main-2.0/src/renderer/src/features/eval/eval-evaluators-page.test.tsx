// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationEvaluator } from "../../../../automation/contracts";
import { EvalEvaluatorsPage } from "./eval-evaluators-page";

const harness = vi.hoisted(() => ({
  listEvaluators: vi.fn(),
  saveEvaluator: vi.fn(),
  deleteEvaluator: vi.fn(),
  listExperiments: vi.fn(),
  getSnapshot: vi.fn(),
  confirm: vi.fn(),
}));

function evaluator(overrides: Partial<EvaluationEvaluator> = {}): EvaluationEvaluator {
  return {
    id: "evaluator-1",
    name: "Contains the answer",
    kind: "contains",
    threshold: 0.6,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  harness.listEvaluators.mockReset().mockResolvedValue([evaluator()]);
  harness.saveEvaluator.mockReset().mockImplementation(async (value: EvaluationEvaluator) => value);
  harness.deleteEvaluator.mockReset().mockResolvedValue(true);
  harness.listExperiments.mockReset().mockResolvedValue([]);
  harness.getSnapshot.mockReset().mockResolvedValue({
    channels: [{ id: "claude-main", label: "Claude", agentId: "claude" }],
  });
  harness.confirm.mockReset().mockReturnValue(true);
  Object.assign(window, {
    confirm: harness.confirm,
    sessionSearch: {
      automation: {
        listEvaluationEvaluators: harness.listEvaluators,
        saveEvaluationEvaluator: harness.saveEvaluator,
        deleteEvaluationEvaluator: harness.deleteEvaluator,
        listEvaluationExperiments: harness.listExperiments,
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

async function render(onDirtyChange = vi.fn()): Promise<{ onDirtyChange: typeof onDirtyChange }> {
  await act(async () => {
    root.render(createElement(EvalEvaluatorsPage, { language: "zh", onDirtyChange }));
  });
  return { onDirtyChange };
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

describe("EvalEvaluatorsPage", () => {
  it("explains what each kind needs where the kind is chosen", async () => {
    await render();

    // A judge with no Runtime channel leaves cases unscored; a form that does not
    // say so invites reading those cases as failures.
    expect(container.textContent).toContain("没有通道时该用例记为未评分");
    expect(container.textContent).toContain("需要期望输出");
  });

  it("saves an edited threshold", async () => {
    const { onDirtyChange } = await render();
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(slider, "0.8");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      button("保存").click();
    });

    expect(harness.saveEvaluator.mock.calls[0]![0]).toMatchObject({ threshold: 0.8 });
  });

  it("offers a Runtime channel and a rubric only for an LLM judge", async () => {
    harness.listEvaluators.mockResolvedValue([
      evaluator({ id: "judge-1", name: "Judge", kind: "llm_judge", prompt: "rubric" }),
    ]);
    await render();

    const options = [...container.querySelectorAll("select option")].map((item) => item.textContent);
    expect(options.join(" ")).toContain("Claude · claude");
    expect(container.querySelector("textarea")?.value).toBe("rubric");
  });

  it("keeps a managed built-in judge read-only and says why", async () => {
    harness.listEvaluators.mockResolvedValue([
      evaluator({ id: "builtin-judge-claude", name: "Built-in Judge", kind: "llm_judge" }),
    ]);
    await render();

    expect(container.textContent).toContain("每次运行前都会按代码定义同步");
    expect(button("保存").disabled).toBe(true);
    expect(button("删除").disabled).toBe(true);
    expect((container.querySelector('input[type="range"]') as HTMLInputElement).disabled).toBe(true);
  });

  it("warns that experiments depend on an evaluator before deleting it", async () => {
    harness.listExperiments.mockResolvedValue([{
      id: "experiment-1",
      name: "Uses it",
      datasetId: "dataset-1",
      agentId: "agent-1",
      evaluatorIds: ["evaluator-1"],
      repetitions: 1,
      createdAt: 1,
      updatedAt: 1,
    }]);
    await render();

    await act(async () => {
      button("删除").click();
    });

    expect(harness.confirm).toHaveBeenCalledWith(expect.stringContaining("1 个实验正在使用"));
    expect(harness.deleteEvaluator).toHaveBeenCalledWith("evaluator-1");
  });

  it("creates an evaluator from a built-in template", async () => {
    await render();
    const select = [...container.querySelectorAll("select")]
      .find((item) => item.textContent?.includes("从模板创建")) as HTMLSelectElement;
    const templateId = [...select.querySelectorAll("option")]
      .map((item) => (item as HTMLOptionElement).value)
      .find((value) => value !== "")!;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, templateId);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(harness.saveEvaluator).toHaveBeenCalledTimes(1);
    expect(harness.saveEvaluator.mock.calls[0]![0]).toMatchObject({ enabled: true });
  });
  it("offers judge code and a subject only for a script evaluator", async () => {
    harness.listEvaluators.mockResolvedValue([
      evaluator({
        id: "script-1",
        name: "Answer length",
        kind: "script",
        scriptMode: "inline_js",
        script: "return { score: 1 };",
        subject: "artifact",
      }),
    ]);
    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("评判代码");
    // The sandbox boundary is the reason a script judge is safe to paste in, so
    // the form has to state it.
    expect(text).toContain("没有文件系统、网络和模块");
    expect((container.querySelector(".eval-code-input") as HTMLTextAreaElement).value)
      .toBe("return { score: 1 };");
  });

  it("says a command judge needs the setting turned on", async () => {
    harness.listEvaluators.mockResolvedValue([
      evaluator({ id: "script-1", name: "External", kind: "script", scriptMode: "command", command: "./judge.sh" }),
    ]);
    await render();

    expect(container.textContent).toContain("只有在设置里允许外部脚本评判时命令才会执行");
    expect(container.querySelector(".eval-code-input")).toBeNull();
  });

  it("saves the dimension a verdict belongs to", async () => {
    // Two checks sharing a dimension must not double that dimension's say, which
    // is only possible if the dimension is authored here.
    await render();
    const field = [...container.querySelectorAll("label")]
      .find((item) => item.textContent?.includes("维度"))!
      .querySelector("input") as HTMLInputElement;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, "正确性");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      button("保存").click();
    });

    expect(harness.saveEvaluator.mock.calls[0]![0]).toMatchObject({ dimension: "正确性" });
  });
});
