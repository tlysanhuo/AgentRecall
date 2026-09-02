import { describe, expect, it } from "vitest";
import { parseEvaluationDimensionContract } from "../../../../core/evaluation/dimension-contract";
import {
  ONE_BITE_TEACHING_DIMENSIONS,
  ONE_BITE_TEACHING_JUDGE_PROMPT,
  STRUCTURED_OUTPUT_DIMENSIONS,
  STRUCTURED_OUTPUT_JUDGE_PROMPT,
  TECHNICAL_DESIGN_DIMENSIONS,
  TECHNICAL_DESIGN_JUDGE_PROMPT,
} from "./starter-plan-rubrics";
import { EVALUATOR_TEMPLATES } from "../evaluation-templates";

describe("starter plan rubrics", () => {
  it.each([
    ["technical design", TECHNICAL_DESIGN_DIMENSIONS, TECHNICAL_DESIGN_JUDGE_PROMPT, 9],
    ["one bite teaching", ONE_BITE_TEACHING_DIMENSIONS, ONE_BITE_TEACHING_JUDGE_PROMPT, 7],
    ["structured output", STRUCTURED_OUTPUT_DIMENSIONS, STRUCTURED_OUTPUT_JUDGE_PROMPT, 4],
  ] as const)("declares every %s dimension in the runtime contract", (_name, dimensions, prompt, count) => {
    expect(parseEvaluationDimensionContract(prompt)).toEqual(
      dimensions.map(({ name, priority }) => ({ name, priority })),
    );
    expect(dimensions).toHaveLength(count);
    expect(new Set(dimensions.map((dimension) => dimension.name)).size).toBe(count);
    expect(prompt).toContain("<Input>{{input}}</Input>");
    expect(prompt).toContain("<GroundTruth>{{ground_truth}}</GroundTruth>");
    expect(prompt).toContain("<Answer>{{output}}</Answer>");
  });

  it("makes the technical design rubric relative to the authored stage", () => {
    expect(TECHNICAL_DESIGN_JUDGE_PROMPT).toContain("discovery");
    expect(TECHNICAL_DESIGN_JUDGE_PROMPT).toContain("approaches");
    expect(TECHNICAL_DESIGN_JUDGE_PROMPT).toContain("approved_design");
    expect(TECHNICAL_DESIGN_JUDGE_PROMPT).toContain("不得因 discovery 或 approaches");
  });

  it("offers every task-specific rubric as a reusable evaluator template", () => {
    expect(EVALUATOR_TEMPLATES.find((item) => item.id === "technical-design-multidimension")?.prompt)
      .toBe(TECHNICAL_DESIGN_JUDGE_PROMPT);
    expect(EVALUATOR_TEMPLATES.find((item) => item.id === "one-bite-teaching-multidimension")?.prompt)
      .toBe(ONE_BITE_TEACHING_JUDGE_PROMPT);
    expect(EVALUATOR_TEMPLATES.find((item) => item.id === "structured-output-multidimension")?.prompt)
      .toBe(STRUCTURED_OUTPUT_JUDGE_PROMPT);
  });
});
