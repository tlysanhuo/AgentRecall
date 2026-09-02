import { describe, expect, it } from "vitest";

import { parseEvaluationDimensionContract } from "./dimension-contract";

describe("parseEvaluationDimensionContract", () => {
  it("reads named dimensions and their hard-priority contract", () => {
    expect(parseEvaluationDimensionContract(
      '<DimensionContract> [{"name":"事实准确","priority":"must"},{"name":"表达清晰","priority":"should"}] </DimensionContract>',
    )).toEqual([
      { name: "事实准确", priority: "must" },
      { name: "表达清晰", priority: "should" },
    ]);
  });

  it("rejects malformed and duplicate contracts instead of hiding dimensions", () => {
    expect(parseEvaluationDimensionContract("no contract")).toEqual([]);
    expect(parseEvaluationDimensionContract(
      '<DimensionContract>[{"name":"重复"},{"name":"重复"}]</DimensionContract>',
    )).toEqual([]);
  });
});
