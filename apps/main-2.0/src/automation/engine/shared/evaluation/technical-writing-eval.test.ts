import { describe, expect, it } from "vitest";
import {
  TECHNICAL_WRITING_DIMENSIONS,
  TECHNICAL_WRITING_EVAL_CASES,
  TECHNICAL_WRITING_JUDGE_PROMPT,
} from "./technical-writing-eval";
import { DATASET_TEMPLATES, EVALUATOR_TEMPLATES } from "../evaluation-templates";

describe("technical-writing evaluation pack", () => {
  it("defines ten unique, independently reported dimensions", () => {
    expect(TECHNICAL_WRITING_DIMENSIONS).toHaveLength(10);
    expect(new Set(TECHNICAL_WRITING_DIMENSIONS.map((item) => item.name)).size).toBe(10);
    expect(TECHNICAL_WRITING_DIMENSIONS.filter((item) => item.priority === "must")).toHaveLength(7);
    expect(TECHNICAL_WRITING_JUDGE_PROMPT).toContain("<DimensionContract>");
    expect(TECHNICAL_WRITING_JUDGE_PROMPT).toContain('"verdicts"');
  });

  it("ships a varied synthetic dataset with source evidence and adversarial instructions", () => {
    expect(TECHNICAL_WRITING_EVAL_CASES).toHaveLength(10);
    expect(new Set(TECHNICAL_WRITING_EVAL_CASES.map((item) => item.id)).size).toBe(10);
    expect(TECHNICAL_WRITING_EVAL_CASES.every((item) => (
      item.input.trim() && item.context.trim() && item.expectedOutput.trim()
    ))).toBe(true);
    expect(TECHNICAL_WRITING_EVAL_CASES.some((item) => /IGNORE ALL PREVIOUS RULES/i.test(item.context))).toBe(true);
    expect(TECHNICAL_WRITING_EVAL_CASES.some((item) => item.id === "serial-is-not-parallel")).toBe(true);
    expect(TECHNICAL_WRITING_EVAL_CASES.some((item) => item.id === "observed-versus-expected")).toBe(true);
    expect(DATASET_TEMPLATES.find((item) => item.id === "technical-writing-skill")?.items).toHaveLength(10);
    expect(EVALUATOR_TEMPLATES.find((item) => item.id === "technical-writing-rubric")?.prompt)
      .toBe(TECHNICAL_WRITING_JUDGE_PROMPT);
  });
});
