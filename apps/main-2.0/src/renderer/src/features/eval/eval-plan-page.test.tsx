// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EvaluationEvaluator,
  EvaluationExperiment,
} from "../../../../automation/contracts";
import {
  TECHNICAL_WRITING_DIMENSIONS,
  TECHNICAL_WRITING_JUDGE_PROMPT,
} from "../../../../automation/engine/shared/evaluation/technical-writing-eval";
import { EvalPlanPage } from "./eval-plan-page";

const harness = vi.hoisted(() => ({
  listExperiments: vi.fn(),
  listDatasets: vi.fn(),
  listEvaluators: vi.fn(),
  listRuns: vi.fn(),
  getSnapshot: vi.fn(),
  listSkills: vi.fn(),
  saveExperiment: vi.fn(),
  deleteExperiment: vi.fn(),
  runExperiment: vi.fn(),
  importFolder: vi.fn(),
  saveEvaluator: vi.fn(),
  deleteEvaluator: vi.fn(),
  confirm: vi.fn(),
}));

function plan(overrides: Partial<EvaluationExperiment> = {}): EvaluationExperiment {
  return {
    id: "plan-1",
    name: "中文写作质量",
    datasetId: "dataset-1",
    agentId: "agent-1",
    evaluatorIds: ["rubric", "brief"],
    repetitions: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function check(overrides: Record<string, unknown>) {
  return {
    name: String(overrides.id),
    kind: "contains",
    threshold: 0.6,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** Two dimensions, one of them judged by two different methods. */
function checks() {
  return [
    check({ id: "rubric", name: "语言自然", kind: "llm_judge", dimension: "正确性" }),
    check({ id: "conclusion", name: "必须含结论", kind: "script", scriptMode: "inline_js", script: "return 1;", dimension: "正确性" }),
    check({ id: "brief", name: "简洁", kind: "script", scriptMode: "inline_js", script: "return 1;", dimension: "简洁性" }),
    check({ id: "tools", name: "工具失败", kind: "tool_failures", dimension: "效率" }),
  ];
}

function dataset(id = "dataset-1", name = "写作用例", cases = 3) {
  return {
    id,
    name,
    description: "",
    items: Array.from({ length: cases }, (_, index) => ({
      id: `case-${index}`,
      input: `case ${index}`,
      metadata: {},
      sequence: index,
    })),
    createdAt: 1,
    updatedAt: 1,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  harness.listExperiments.mockReset().mockResolvedValue([plan()]);
  harness.listDatasets.mockReset().mockResolvedValue([dataset()]);
  harness.listEvaluators.mockReset().mockResolvedValue(checks());
  harness.listRuns.mockReset().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 12 });
  harness.getSnapshot.mockReset().mockResolvedValue({
    configuredAgents: [{ id: "agent-1", name: "Claude Code" }, { id: "agent-2", name: "Codex" }],
    channels: [{ id: "channel-1", label: "Sonnet", agentId: "agent-1" }],
  });
  harness.listSkills.mockReset().mockResolvedValue({ skills: [{ name: "review" }] });
  harness.saveExperiment.mockReset()
    .mockImplementation(async (value: EvaluationExperiment) => value);
  harness.deleteExperiment.mockReset().mockResolvedValue(true);
  harness.runExperiment.mockReset().mockResolvedValue({ id: "run-1" });
  harness.importFolder.mockReset();
  harness.saveEvaluator.mockReset()
    .mockImplementation(async (value: EvaluationEvaluator) => value);
  harness.deleteEvaluator.mockReset().mockResolvedValue(true);
  harness.confirm.mockReset().mockReturnValue(true);
  Object.assign(window, {
    confirm: harness.confirm,
    sessionSearch: {
      listSkills: harness.listSkills,
      automation: {
        listEvaluationExperiments: harness.listExperiments,
        listEvaluationDatasets: harness.listDatasets,
        listEvaluationEvaluators: harness.listEvaluators,
        listEvaluationRuns: harness.listRuns,
        saveEvaluationExperiment: harness.saveExperiment,
        deleteEvaluationExperiment: harness.deleteExperiment,
        runEvaluationExperiment: harness.runExperiment,
        importEvaluationDatasetFolder: harness.importFolder,
        saveEvaluationEvaluator: harness.saveEvaluator,
        deleteEvaluationEvaluator: harness.deleteEvaluator,
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

async function render(onOpenRuns = vi.fn()): Promise<{ onOpenRuns: typeof onOpenRuns }> {
  await act(async () => {
    root.render(createElement(EvalPlanPage, { language: "zh", onOpenRuns }));
  });
  return { onOpenRuns };
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")]
    .find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

function dimensionRow(name: string): HTMLElement {
  const found = [...container.querySelectorAll(".eval-plan-dimensions > li")]
    .find((item) => item.querySelector(".eval-plan-dimension-name")?.textContent === name);
  if (!found) throw new Error(`dimension not found: ${name}`);
  return found as HTMLElement;
}

async function revealOthers(): Promise<void> {
  const toggle = [...container.querySelectorAll(".eval-plan-others-toggle")][0];
  if (!toggle) throw new Error("the other-dimensions toggle is not shown");
  await act(async () => {
    (toggle as HTMLButtonElement).click();
  });
}

function field(label: string): HTMLSelectElement | HTMLInputElement {
  const row = [...container.querySelectorAll(".eval-field")]
    .find((item) => item.querySelector(".eval-field-title")?.textContent?.includes(label));
  if (!row) throw new Error(`field not found: ${label}`);
  return row.querySelector("select, input") as HTMLSelectElement | HTMLInputElement;
}

async function setValue(control: Element, value: string): Promise<void> {
  const select = control instanceof window.HTMLSelectElement;
  const textarea = control instanceof window.HTMLTextAreaElement;
  await act(async () => {
    // Each element class declares its own `value`, so the setter has to come from
    // the control's own prototype rather than the input one.
    const prototype = select
      ? window.HTMLSelectElement.prototype
      : textarea
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
    control.dispatchEvent(new window.Event(select ? "change" : "input", { bubbles: true }));
  });
}

describe("EvalPlanPage", () => {
  it("lists what this plan judges by, and folds the rest of the library away", async () => {
    // Every plan judges different things, so a library grown from a dozen plans
    // would bury the handful this one uses.
    await render();

    expect([...container.querySelectorAll(".eval-plan-dimension-name")]
      .map((item) => item.textContent)).toEqual(["正确性", "简洁性"]);
    expect(container.querySelector(".eval-plan-others-toggle")?.textContent)
      .toContain("另有 1 个已定义的维度");

    await revealOthers();

    expect([...container.querySelectorAll(".eval-plan-dimension-name")]
      .map((item) => item.textContent)).toEqual(["正确性", "简洁性", "效率"]);
  });

  it("says how each dimension judges rather than listing its checks", async () => {
    await render();

    // Correctness is judged two ways, and the row says so.
    expect(dimensionRow("正确性").textContent).toContain("LLM 评判");
    expect(dimensionRow("正确性").textContent).toContain("脚本");
    await revealOthers();
    expect(dimensionRow("效率").textContent).toContain("轨迹");
  });

  it("shows a card per chosen dimension, and none for the others", async () => {
    await render();

    const cards = [...container.querySelectorAll(".eval-dimension-card-name")]
      .map((item) => item.textContent);
    // The plan takes in rubric and brief, so correctness and brevity are in play.
    expect(cards).toEqual(["正确性", "简洁性"]);
  });

  it("shows every declared output dimension of one multi-verdict judge", async () => {
    harness.listExperiments.mockResolvedValue([plan({ evaluatorIds: ["technical"] })]);
    harness.listEvaluators.mockResolvedValue([
      check({
        id: "technical",
        name: "技术教程十维评审",
        kind: "llm_judge",
        prompt: TECHNICAL_WRITING_JUDGE_PROMPT,
      }),
    ]);

    await render();

    expect([...container.querySelectorAll(".eval-dimension-card-name")]
      .map((item) => item.textContent))
      .toEqual(TECHNICAL_WRITING_DIMENSIONS.map((item) => item.name));
    expect(container.querySelectorAll(".eval-dimension-priority.is-must")).toHaveLength(14);
    expect(container.querySelectorAll(".eval-dimension-priority.is-should")).toHaveLength(6);
  });

  it("takes in every check of a dimension when it is chosen", async () => {
    // Scores inside a dimension are averaged, so half a dimension would change what
    // its score means.
    await render();
    await revealOthers();

    await act(async () => {
      (dimensionRow("效率").querySelector("input[type=checkbox]") as HTMLInputElement).click();
    });
    await act(async () => {
      button("保存").click();
    });

    expect(harness.saveExperiment.mock.calls[0]![0].evaluatorIds).toEqual(
      expect.arrayContaining(["rubric", "brief", "tools"]),
    );
  });

  it("drops every check of a dimension when it is unchosen", async () => {
    await render();

    await act(async () => {
      (dimensionRow("正确性").querySelector("input[type=checkbox]") as HTMLInputElement).click();
    });
    await act(async () => {
      button("保存").click();
    });

    expect(harness.saveExperiment.mock.calls[0]![0].evaluatorIds).toEqual(["brief"]);
  });

  it("saves a dimension's weight where the scorer reads it", async () => {
    await render();

    await setValue(dimensionRow("正确性").querySelector(".eval-plan-weight input")!, "4");
    await act(async () => {
      button("保存").click();
    });

    expect(harness.saveExperiment.mock.calls[0]![0].scoring)
      .toMatchObject({ weightByLabels: { dimension: { 正确性: 4 } } });
  });

  it("gives the scoring rules a home for the first time", async () => {
    // These were stored and used by the engine but had no way in.
    await render();

    await setValue(field("通过分数线"), "0.8");
    await setValue(field("最低覆盖率"), "0.5");
    await setValue(field("判不出来的"), "zero");
    await act(async () => {
      button("保存").click();
    });

    expect(harness.saveExperiment.mock.calls[0]![0].scoring).toMatchObject({
      resolvedThreshold: 0.8,
      minCoverage: 0.5,
      uncertain: "zero",
    });
  });

  it("opens a check for editing from the dimension it judges", async () => {
    // A threshold that looks wrong is noticed while reading the plan, so it is
    // changed there rather than through the Dimensions page.
    await render();

    await act(async () => {
      (dimensionRow("正确性").querySelector('[aria-label="查看检查"]') as HTMLButtonElement).click();
    });
    const rows = [...dimensionRow("正确性").querySelectorAll(".eval-plan-check-row")];
    expect(rows.map((row) => row.textContent).join(" ")).toContain("语言自然");
    expect(rows.map((row) => row.textContent).join(" ")).toContain("必须含结论");

    await act(async () => {
      (rows[0] as HTMLButtonElement).click();
    });
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("语言自然");

    // The prompt belongs to the LLM judge, so the dialog offers the same fields
    // the Dimensions page would.
    await setValue(dialog!.querySelector("textarea")!, "判断语言是否自然");
    await act(async () => {
      ([...dialog!.querySelectorAll("button")]
        .find((item) => item.textContent === "保存") as HTMLButtonElement).click();
    });

    expect(harness.saveEvaluator.mock.calls[0]![0]).toMatchObject({
      id: "rubric",
      prompt: "判断语言是否自然",
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows a script judge what it will be handed", async () => {
    // Without this the only way to learn that files carry a status is to run the
    // judge and read the error.
    await render();

    await act(async () => {
      (dimensionRow("简洁性").querySelector('[aria-label="查看检查"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (dimensionRow("简洁性").querySelector(".eval-plan-check-row") as HTMLButtonElement).click();
    });

    const shape = container.querySelector(".eval-subject-shape");
    expect(shape?.textContent).toContain("artifact.output");
    expect(shape?.textContent).toContain("artifact.files[]");
    expect(shape?.textContent).toContain("artifact.origin.kind");
  });

  it("keeps a built-in check readable but not saveable", async () => {
    harness.listEvaluators.mockResolvedValue([
      check({ id: "builtin-judge-format", name: "格式", kind: "json_valid", dimension: "格式" }),
    ]);
    harness.listExperiments.mockResolvedValue([plan({ evaluatorIds: ["builtin-judge-format"] })]);
    await render();

    await act(async () => {
      (dimensionRow("格式").querySelector('[aria-label="查看检查"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (dimensionRow("格式").querySelector(".eval-plan-check-row") as HTMLButtonElement).click();
    });

    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("由 AgentRecall 内置管理");
    expect(([...dialog.querySelectorAll("button")]
      .find((item) => item.textContent === "保存") as HTMLButtonElement).disabled).toBe(true);
  });

  it("adds a dimension from the plan and takes it in straight away", async () => {
    // Authoring belongs where you know what "good" means for this plan; being sent
    // to another page to define a check and back again to select it makes the
    // common case the long way round.
    await render();

    await act(async () => {
      button("新建维度").click();
    });

    expect(harness.saveEvaluator.mock.calls[0]![0]).toMatchObject({
      name: "未命名维度",
      dimension: "未命名维度",
      enabled: true,
    });
    // Straight into the editor: a placeholder check is not a judgement yet.
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("未命名维度");

    await act(async () => {
      button("取消").click();
    });
    // And the plan judges by it without a second step.
    await act(async () => {
      button("保存").click();
    });
    const created = harness.saveEvaluator.mock.calls[0]![0].id;
    expect(harness.saveExperiment.mock.calls[0]![0].evaluatorIds).toContain(created);
  });

  it("adds another check to a dimension it is already judging by", async () => {
    await render();

    await act(async () => {
      (dimensionRow("简洁性").querySelector('[aria-label="查看检查"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (dimensionRow("简洁性").querySelector(".eval-plan-check-add") as HTMLButtonElement).click();
    });

    // It joins that dimension rather than becoming one of its own, because scores
    // inside a dimension are averaged before dimensions combine.
    expect(harness.saveEvaluator.mock.calls[0]![0]).toMatchObject({
      name: "未命名检查",
      dimension: "简洁性",
    });
  });

  it("drops a check deleted from the dialog out of the plan too", async () => {
    await render();

    await act(async () => {
      (dimensionRow("简洁性").querySelector('[aria-label="查看检查"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (dimensionRow("简洁性").querySelector(".eval-plan-check-row") as HTMLButtonElement).click();
    });
    await act(async () => {
      ([...container.querySelectorAll('[role="dialog"] button')]
        .find((item) => item.textContent?.includes("删除")) as HTMLButtonElement).click();
    });

    expect(harness.deleteEvaluator).toHaveBeenCalledWith("brief");
    // The dimension goes with its only check, so the plan cannot keep judging by it.
    expect([...container.querySelectorAll(".eval-plan-dimension-name")]
      .map((item) => item.textContent)).toEqual(["正确性"]);
    await act(async () => {
      button("保存").click();
    });
    expect(harness.saveExperiment.mock.calls[0]![0].evaluatorIds).not.toContain("brief");
  });

  it("offers no deletion for a built-in check", async () => {
    harness.listEvaluators.mockResolvedValue([
      check({ id: "builtin-judge-format", name: "格式", kind: "json_valid", dimension: "格式" }),
    ]);
    harness.listExperiments.mockResolvedValue([plan({ evaluatorIds: ["builtin-judge-format"] })]);
    await render();

    await act(async () => {
      (dimensionRow("格式").querySelector('[aria-label="查看检查"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (dimensionRow("格式").querySelector(".eval-plan-check-row") as HTMLButtonElement).click();
    });

    expect([...container.querySelectorAll('[role="dialog"] button')]
      .some((item) => item.textContent?.includes("删除"))).toBe(false);
  });

  it("refuses to run before there is a Runtime and a case to run", async () => {
    harness.listExperiments.mockResolvedValue([plan({ agentId: "" })]);
    await render();

    expect(button("跑一次").disabled).toBe(true);
    expect(button("跑一次").title).toContain("需要先选好 Runtime");
  });

  it("saves before running, then hands over to the run history", async () => {
    const { onOpenRuns } = await render();

    await act(async () => {
      button("跑一次").click();
    });

    expect(harness.saveExperiment).toHaveBeenCalledTimes(1);
    expect(harness.runExperiment).toHaveBeenCalledWith("plan-1");
    expect(onOpenRuns).toHaveBeenCalled();
  });

  it("draws each dimension's trend from the runs it already has", async () => {
    harness.listRuns.mockResolvedValue({
      items: [
        {
          id: "run-2",
          experimentId: "plan-1",
          status: "completed",
          startedAt: 2,
          resultCount: 3,
          failedResultCount: 0,
          dimensions: [{ dimension: "正确性", score: 0.9, weight: 1, scoredCaseCount: 3 }],
        },
        {
          id: "run-1",
          experimentId: "plan-1",
          status: "completed",
          startedAt: 1,
          resultCount: 3,
          failedResultCount: 0,
          dimensions: [
            { dimension: "正确性", score: 0.5, weight: 1, scoredCaseCount: 3 },
            { dimension: "简洁性", score: 0.2, weight: 1, scoredCaseCount: 3 },
          ],
        },
      ],
      total: 2,
      offset: 0,
      limit: 12,
    });
    await render();

    // Newest last: the ring shows the latest run's score.
    const cards = [...container.querySelectorAll(".eval-dimension-card")];
    expect(cards[0]!.querySelector(".eval-dimension-ring-text")?.textContent).toBe(".90");
    // Brevity was judged in the older run only, so its latest is undecided.
    expect(cards[1]!.className).toContain("is-undecided");
    // And the run where it was not judged leaves a gap rather than being dropped.
    const slots = [...cards[1]!.querySelectorAll(".eval-dimension-trend li")];
    expect(slots.filter((slot) => !slot.className.includes("is-empty"))).toHaveLength(1);
  });

  it("says a plan judges nothing rather than showing an empty row of cards", async () => {
    harness.listExperiments.mockResolvedValue([plan({ evaluatorIds: [] })]);
    await render();

    expect(container.textContent).toContain("还没有选任何维度");
    expect(container.querySelector(".eval-dimension-card")).toBeNull();
  });

  it("says how many runs a deletion takes with it", async () => {
    harness.listRuns.mockResolvedValue({ items: [], total: 7, offset: 0, limit: 12 });
    await render();

    await act(async () => {
      (container.querySelector('[aria-label="删除方案"]') as HTMLButtonElement).click();
    });

    expect(harness.confirm.mock.calls[0]![0]).toContain("已记录的 7 次运行");
    expect(harness.deleteExperiment).toHaveBeenCalledWith("plan-1");
  });

  it("starts a new plan judging by nothing at all", async () => {
    // Every plan judges different things, so inheriting the whole library would
    // mean unpicking it before saying what this plan is actually about.
    await render();

    await act(async () => {
      (container.querySelector('[aria-label="新建方案"]') as HTMLButtonElement).click();
    });

    expect(harness.saveExperiment.mock.calls[0]![0].evaluatorIds).toEqual([]);
  });

  it("will not run a plan that judges by nothing", async () => {
    // It would run the agent and conclude nothing, which reads as a pass.
    harness.listExperiments.mockResolvedValue([plan({ evaluatorIds: [] })]);
    await render();

    expect(button("跑一次").disabled).toBe(true);
    expect(button("跑一次").title).toContain("至少一个判定维度");
  });

  it("reports a load failure instead of an empty page", async () => {
    harness.listExperiments.mockRejectedValue(new Error("database is not ready"));
    await render();

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain("database is not ready");
  });
});
