import { describe, expect, it } from "vitest";
import { aggregateEvaluationCase } from "./aggregate";
import type { EvaluationNodeRecord, EvaluationVerdict } from "./node";
import { scoreEvaluationCase, scoreEvaluationRun } from "./scorer";

function judge(
  nodeId: string,
  status: EvaluationNodeRecord["status"],
  verdicts: Array<Pick<EvaluationVerdict, "verdictId" | "status" | "raw">> = [],
): EvaluationNodeRecord {
  return {
    nodeId,
    nodeType: "llm_judge",
    nodeVersion: 1,
    role: "judge",
    status,
    ...(verdicts.length > 0
      ? {
          verdicts: verdicts.map((item) => ({
            ...item,
            labels: {},
            sourceNodeId: nodeId,
            sourceNodeType: "llm_judge",
          })),
        }
      : {}),
  };
}

function scoreCase(
  caseId: string,
  records: EvaluationNodeRecord[],
  options: { cancelled?: boolean } = {},
) {
  return scoreEvaluationCase(aggregateEvaluationCase(caseId, records, options));
}

describe("evaluation scorer", () => {
  it("averages the scorable verdicts of a case", () => {
    const score = scoreCase("case-1", [
      judge("a", "pass", [{ verdictId: "v1", status: "met", raw: 1 }]),
      judge("b", "pass", [{ verdictId: "v2", status: "met", raw: 0.6 }]),
    ]);

    expect(score.score).toBeCloseTo(0.8);
    expect(score.passed).toBe(true);
    expect(score.decided).toBe(2);
  });

  it("fails the case unless every decision came back met", () => {
    // The previous runner averaged verdicts into a pass rate, so one evaluator
    // out of two passing contributed half a pass. A case is one unit of work.
    const score = scoreCase("case-1", [
      judge("a", "pass", [{ verdictId: "v1", status: "met", raw: 1 }]),
      judge("b", "pass", [{ verdictId: "v2", status: "unmet", raw: 0 }]),
    ]);

    expect(score.passed).toBe(false);
    expect(score.score).toBeCloseTo(0.5);
  });

  it("gives a case with nothing decided no score at all", () => {
    // Not zero: an evaluation that could not run has learned nothing about the
    // agent, and a zero is indistinguishable from a deliberate rejection.
    const score = scoreCase("case-1", [judge("a", "excused", [
      { verdictId: "v1", status: "unmet", raw: 0 },
    ])]);

    expect(score.score).toBeNull();
    expect(score.passed).toBe(false);
    expect(score.decided).toBe(0);
  });

  it("cannot pass a case whose gate is closed", () => {
    const score = scoreCase(
      "case-1",
      [judge("a", "pass", [{ verdictId: "v1", status: "met", raw: 1 }])],
      { cancelled: true },
    );

    expect(score.gatePassed).toBe(false);
    expect(score.passed).toBe(false);
    // The verdict still happened, so the number stays readable; the gate is what
    // stops it from being reported as a pass.
    expect(score.score).toBe(1);
  });

  it("counts pass rate over scored cases only", () => {
    const run = scoreEvaluationRun([
      scoreCase("case-1", [judge("a", "pass", [{ verdictId: "v1", status: "met", raw: 1 }])]),
      scoreCase("case-2", [judge("a", "pass", [{ verdictId: "v2", status: "unmet", raw: 0 }])]),
      scoreCase("case-3", [judge("a", "excused")]),
    ]);

    expect(run.passRate).toBeCloseTo(0.5);
    expect(run.averageScore).toBeCloseTo(0.5);
    expect(run.minimumScore).toBe(0);
    expect(run.scoredCaseCount).toBe(2);
    expect(run.unscoredCaseCount).toBe(1);
    expect(run.passedCaseCount).toBe(1);
  });

  it("reports no run score when no case produced one", () => {
    const run = scoreEvaluationRun([scoreCase("case-1", [judge("a", "excused")])]);

    expect(run).toEqual({
      averageScore: null,
      minimumScore: null,
      passRate: null,
      scoredCaseCount: 0,
      unscoredCaseCount: 1,
      passedCaseCount: 0,
    });
  });

  it("ignores a verdict that carries no number when averaging", () => {
    const score = scoreCase("case-1", [
      judge("a", "pass", [{ verdictId: "v1", status: "met", raw: 0.5 }]),
      judge("b", "pass", [{ verdictId: "v2", status: "met" }]),
    ]);

    expect(score.score).toBeCloseTo(0.5);
    expect(score.passed).toBe(true);
    expect(score.decided).toBe(2);
  });
});
