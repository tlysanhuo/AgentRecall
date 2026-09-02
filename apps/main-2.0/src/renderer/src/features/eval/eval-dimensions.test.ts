import { describe, expect, it } from "vitest";

import type { EvaluationEvaluator } from "../../../../automation/contracts";
import { TECHNICAL_WRITING_DIMENSIONS, TECHNICAL_WRITING_JUDGE_PROMPT } from "../../../../automation/engine/shared/evaluation/technical-writing-eval";
import { dimensionsOf } from "./eval-dimensions";

function evaluator(overrides: Partial<EvaluationEvaluator> = {}): EvaluationEvaluator {
  return {
    id: "judge",
    name: "Technical Writing Judge",
    kind: "llm_judge",
    threshold: 0.75,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("dimensionsOf", () => {
  it("expands one multi-verdict judge into every declared dimension", () => {
    const dimensions = dimensionsOf([
      evaluator({ prompt: TECHNICAL_WRITING_JUDGE_PROMPT }),
    ]);

    expect(dimensions).toHaveLength(TECHNICAL_WRITING_DIMENSIONS.length);
    expect(dimensions.map((item) => ({ name: item.name, priority: item.priority })))
      .toEqual(TECHNICAL_WRITING_DIMENSIONS.map(({ name, priority }) => ({ name, priority })));
    expect(dimensions.every((item) => item.checks[0]?.id === "judge")).toBe(true);
  });

  it("keeps a normal single-verdict evaluator as one dimension", () => {
    expect(dimensionsOf([evaluator({ dimension: "正确性" })])).toEqual([
      { name: "正确性", checks: [expect.objectContaining({ id: "judge" })] },
    ]);
  });
});
