// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvalDimensionCard, dimensionState } from "./eval-dimension-card";

/**
 * Colour is how a dimension card says what happened, so the three readings are a
 * contract: met, unmet, and nothing decided. The third is the one that matters —
 * a dimension whose judge could not decide has no score, and painting that as a
 * failure would blame the model for the evaluation's own gap.
 */
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(data: Parameters<typeof EvalDimensionCard>[0]["data"]): Promise<void> {
  await act(async () => {
    root.render(createElement(EvalDimensionCard, { language: "zh", data }));
  });
}

function card(): HTMLElement {
  const found = container.querySelector(".eval-dimension-card");
  if (!found) throw new Error("the card was not rendered");
  return found as HTMLElement;
}

describe("dimensionState", () => {
  it("reads a score against the threshold", () => {
    expect(dimensionState({ dimension: "d", score: 0.9, weight: 1, threshold: 0.6 })).toBe("met");
    expect(dimensionState({ dimension: "d", score: 0.4, weight: 1, threshold: 0.6 })).toBe("unmet");
  });

  it("calls nothing decided undecided, not failed", () => {
    expect(dimensionState({ dimension: "d", score: null, weight: 1 })).toBe("undecided");
  });

  it("defaults to the engine's own threshold when none is given", () => {
    expect(dimensionState({ dimension: "d", score: 0.6, weight: 1 })).toBe("met");
    expect(dimensionState({ dimension: "d", score: 0.59, weight: 1 })).toBe("unmet");
  });
});

describe("EvalDimensionCard", () => {
  it("shows the score, the weight and how the dimension is judged", async () => {
    await render({
      dimension: "正确性",
      score: 0.9,
      weight: 4,
      threshold: 0.6,
      method: "LLM 评判",
    });

    expect(card().className).toContain("is-met");
    expect(card().textContent).toContain("正确性");
    expect(card().textContent).toContain("权重 4");
    expect(container.querySelector(".eval-dimension-card-weight")?.getAttribute("title"))
      .toContain("4 倍");
    expect(card().textContent).toContain("LLM 评判");
    // Leading zero dropped: ".90" reads as a score, "0.90" reads as a measurement.
    expect(container.querySelector(".eval-dimension-ring-text")?.textContent).toBe(".90");
  });

  it("leaves the weight off when it is the default", async () => {
    await render({ dimension: "格式", score: 1, weight: 1 });

    expect(card().textContent).not.toContain("×1");
  });

  it("draws no arc at all when nothing was decided", async () => {
    // A zero-length arc would read as a score of zero, which is the one thing an
    // undecided dimension is not.
    await render({ dimension: "效率", score: null, weight: 1, method: "脚本" });

    expect(card().className).toContain("is-undecided");
    expect(container.querySelector(".eval-dimension-ring-value")).toBeNull();
    expect(container.querySelector(".eval-dimension-ring-text")?.textContent).toBe("—");
    // And it says so rather than naming a method that never ran.
    expect(card().textContent).toContain("未判定");
  });

  it("keeps an empty slot for a run in which the dimension decided nothing", async () => {
    // Dropping it would slide an older score into its place and read as "it scored
    // low then", when in fact it was never judged.
    await render({
      dimension: "正确性",
      score: 0.8,
      weight: 1,
      trend: [
        { score: 0.9, startedAt: 1 },
        { score: null, startedAt: 2 },
        { score: 0.8, startedAt: 3 },
      ],
    });

    const slots = [...container.querySelectorAll(".eval-dimension-trend li")];
    expect(slots).toHaveLength(6);
    expect(container.textContent).toContain("最近 6 次运行");
    // Padded on the left, so the newest is on the right; the gap is in the middle.
    expect(slots.map((slot) => slot.className.includes("is-empty")))
      .toEqual([true, true, true, false, true, false]);
  });

  it("colours every historical run from its own result", async () => {
    await render({
      dimension: "正确性",
      score: 0.9,
      weight: 1,
      threshold: 0.6,
      trend: [{ score: 0.2 }, { score: 0.9 }],
    });

    const slots = [...container.querySelectorAll(".eval-dimension-trend li")];
    expect(slots.at(-2)?.className).toContain("is-unmet");
    expect(slots.at(-2)?.getAttribute("title")).toContain("未达标");
    expect(slots.at(-1)?.className).toContain("is-met");
    expect(slots.at(-1)?.getAttribute("title")).toContain("达标");
  });

  it("does not draw meaningless empty history slots when no trend was supplied", async () => {
    await render({ dimension: "格式", score: 1, weight: 1 });

    expect(container.querySelector(".eval-dimension-trend")).toBeNull();
  });

  it("clamps a score that came back out of range", async () => {
    await render({ dimension: "d", score: 1.4, weight: 1, trend: [{ score: 1.4 }] });

    const arc = container.querySelector(".eval-dimension-ring-value");
    const [drawn, whole] = (arc?.getAttribute("stroke-dasharray") ?? "").split(" ").map(Number);
    expect(drawn).toBeCloseTo(whole!, 5);
  });
});
