import { describe, expect, it } from "vitest";
import { aggregateEvaluationCase } from "./aggregate";
import type { EvaluationNodeRecord, EvaluationVerdict } from "./node";
import {
  scoreEvaluationCase,
  scoreEvaluationRun,
  type EvaluationScoringConfig,
} from "./scorer";

function judge(
  nodeId: string,
  status: EvaluationNodeRecord["status"],
  verdicts: Array<
    Pick<EvaluationVerdict, "verdictId" | "status" | "raw"> & { labels?: Record<string, string> }
  > = [],
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
            verdictId: item.verdictId,
            status: item.status,
            ...(item.raw !== undefined ? { raw: item.raw } : {}),
            evaluatorId: item.verdictId,
            labels: item.labels ?? {},
            sourceNodeId: nodeId,
            sourceNodeType: "llm_judge",
          })),
        }
      : {}),
  };
}

function agentRecord(status: EvaluationNodeRecord["status"]): EvaluationNodeRecord {
  return {
    nodeId: "agent",
    nodeType: "run_agent",
    nodeVersion: 1,
    role: "prepare",
    status,
    ...(status === "fail"
      ? { attribution: { type: "model_failure" as const, reason: "agent_refused" } }
      : {}),
    ...(status === "excused"
      ? { attribution: { type: "infra_failure" as const, reason: "runtime_missing" } }
      : {}),
  };
}

function scoreCase(
  records: EvaluationNodeRecord[],
  config: EvaluationScoringConfig = {},
  options: { cancelled?: boolean } = {},
) {
  return scoreEvaluationCase(aggregateEvaluationCase("case-1", records, options), config);
}

describe("dimension scoring", () => {
  it("reports a score per dimension alongside the overall score", () => {
    const score = scoreCase([
      judge("a", "pass", [{ verdictId: "correct", status: "met", raw: 0.9, labels: { dimension: "正确性" } }]),
      judge("b", "pass", [{ verdictId: "complete", status: "unmet", raw: 0.6, labels: { dimension: "完整性" } }]),
    ]);

    expect(score.dimensions).toEqual([
      { dimension: "正确性", score: 0.9, weight: 1, decided: 1, undecided: 0, met: 1, unmet: 0 },
      { dimension: "完整性", score: 0.6, weight: 1, decided: 1, undecided: 0, met: 0, unmet: 1 },
    ]);
    expect(score.score).toBeCloseTo(0.75);
  });

  it("averages inside a dimension before combining dimensions", () => {
    // Two checks on one dimension must not double that dimension's say. Flat
    // averaging would give (0.9 + 0.7 + 0.6) / 3 = 0.733 and let correctness
    // outvote completeness two to one.
    const score = scoreCase([
      judge("a", "pass", [{ verdictId: "c1", status: "met", raw: 0.9, labels: { dimension: "正确性" } }]),
      judge("b", "pass", [{ verdictId: "c2", status: "met", raw: 0.7, labels: { dimension: "正确性" } }]),
      judge("c", "pass", [{ verdictId: "k1", status: "met", raw: 0.6, labels: { dimension: "完整性" } }]),
    ]);

    expect(score.dimensions.find((item) => item.dimension === "正确性")!.score).toBeCloseTo(0.8);
    expect(score.score).toBeCloseTo(0.7);
  });

  it("weights dimensions by any label, including priority", () => {
    const config: EvaluationScoringConfig = {
      weightByLabels: { dimension: { 正确性: 4, 格式: 1 } },
    };

    const score = scoreCase([
      judge("a", "pass", [{ verdictId: "c", status: "met", raw: 1, labels: { dimension: "正确性" } }]),
      judge("b", "pass", [{ verdictId: "f", status: "unmet", raw: 0, labels: { dimension: "格式" } }]),
    ], config);

    // 4:1 in favour of correctness.
    expect(score.score).toBeCloseTo(0.8);
    expect(score.dimensions.find((item) => item.dimension === "正确性")!.weight).toBe(4);
  });

  it("drops a dimension whose weight is zero from the score but keeps it visible", () => {
    const score = scoreCase([
      judge("a", "pass", [{ verdictId: "c", status: "met", raw: 1, labels: { dimension: "正确性" } }]),
      judge("b", "pass", [{ verdictId: "n", status: "unmet", raw: 0, labels: { dimension: "备注", scoring: "annotation" } }]),
    ], { weightByLabels: { scoring: { annotation: 0 } } });

    expect(score.score).toBe(1);
    expect(score.dimensions.map((item) => item.dimension)).toContain("备注");
  });

  it("falls back to the evaluator id when a verdict carries no dimension", () => {
    const score = scoreCase([
      judge("a", "pass", [{ verdictId: "exact", status: "met", raw: 1 }]),
    ]);

    expect(score.dimensions[0]!.dimension).toBe("exact");
  });

  it("breaks the result down by every label, not only by dimension", () => {
    const score = scoreCase([
      judge("a", "pass", [{ verdictId: "c", status: "met", raw: 1, labels: { dimension: "正确性", priority: "must" } }]),
      judge("b", "pass", [{ verdictId: "k", status: "unmet", raw: 0.4, labels: { dimension: "完整性", priority: "should" } }]),
    ]);

    expect(score.byLabel).toEqual({
      dimension: { 正确性: 1, 完整性: 0.4 },
      priority: { must: 1, should: 0.4 },
    });
  });
});

describe("coverage and passing", () => {
  it("passes when the score clears the threshold", () => {
    const score = scoreCase([
      judge("a", "pass", [{ verdictId: "c", status: "met", raw: 0.7, labels: { dimension: "正确性" } }]),
    ], { resolvedThreshold: 0.6 });

    expect(score.passed).toBe(true);
    expect(score.coverage).toBe(1);
  });

  it("fails a score below the threshold even when every judge decided", () => {
    const score = scoreCase([
      judge("a", "pass", [{ verdictId: "c", status: "unmet", raw: 0.4, labels: { dimension: "正确性" } }]),
    ], { resolvedThreshold: 0.6 });

    expect(score.passed).toBe(false);
    expect(score.score).toBeCloseTo(0.4);
  });

  it("counts a judge that produced nothing against coverage", () => {
    // A judge that threw would otherwise leave coverage at 1 and let a
    // four-dimension rubric report a score computed from one dimension.
    const score = scoreCase([
      judge("a", "pass", [{ verdictId: "c", status: "met", raw: 1, labels: { dimension: "正确性" } }]),
      judge("b", "excused"),
    ]);

    expect(score.coverage).toBeCloseTo(0.5);
    expect(score.notDecided).toBe(1);
  });

  it("refuses to pass a result that did not cover enough of the rubric", () => {
    const score = scoreCase([
      judge("a", "pass", [{ verdictId: "c", status: "met", raw: 1, labels: { dimension: "正确性" } }]),
      judge("b", "excused"),
      judge("c", "excused"),
    ], { minCoverage: 0.6 });

    expect(score.score).toBe(1);
    // The score is good but only a third of the planned judging happened.
    expect(score.passed).toBe(false);
    expect(score.coverage).toBeCloseTo(1 / 3);
  });

  it("gives a case with nothing decided no score at all", () => {
    const score = scoreCase([judge("a", "excused", [{ verdictId: "c", status: "unmet", raw: 0 }])]);

    expect(score.score).toBeNull();
    expect(score.passed).toBe(false);
  });

  it("treats an undecided verdict as excluded by default and as zero on request", () => {
    const records = [
      judge("a", "pass", [{ verdictId: "c", status: "met", raw: 1, labels: { dimension: "正确性" } }]),
      judge("b", "pass", [{ verdictId: "u", status: "uncertain", labels: { dimension: "完整性" } }]),
    ];

    expect(scoreCase(records).score).toBe(1);
    expect(scoreCase(records, { uncertain: "zero" }).score).toBeCloseTo(0.5);
  });

  it("reads a met verdict with no number as full marks", () => {
    const score = scoreCase([
      judge("a", "pass", [{ verdictId: "c", status: "met", raw: 0.5, labels: { dimension: "a" } }]),
      judge("b", "pass", [{ verdictId: "d", status: "met", labels: { dimension: "b" } }]),
    ]);

    expect(score.score).toBeCloseTo(0.75);
  });
});

describe("gate failures", () => {
  it("scores the agent's own failure zero", () => {
    const score = scoreCase([agentRecord("fail")]);

    expect(score.score).toBe(0);
    expect(score.passed).toBe(false);
    expect(score.gatePassed).toBe(false);
    expect(score.unscorableReason).toBeUndefined();
  });

  it("leaves a case unscorable when only AgentRecall or a judge failed", () => {
    // Scoring this 0 would be indistinguishable downstream from an agent that
    // genuinely produced nothing.
    const score = scoreCase(
      [judge("a", "pass", [{ verdictId: "c", status: "met", raw: 1 }])],
      {},
      { cancelled: true },
    );

    expect(score.score).toBeNull();
    expect(score.gatePassed).toBe(false);
    expect(score.unscorableReason).toBe("case_cancelled");
  });

  it("keeps the zero when the agent is among the causes", () => {
    const score = scoreCase([agentRecord("fail")], {}, { cancelled: true });

    expect(score.score).toBe(0);
  });
});

describe("run scoring", () => {
  it("counts pass rate over scored cases and averages dimensions across them", () => {
    const first = scoreCase([
      judge("a", "pass", [{ verdictId: "c", status: "met", raw: 1, labels: { dimension: "正确性" } }]),
    ]);
    const second = scoreCase([
      judge("a", "pass", [{ verdictId: "c", status: "unmet", raw: 0.2, labels: { dimension: "正确性" } }]),
    ]);
    const third = scoreCase([judge("a", "excused")]);

    const run = scoreEvaluationRun([first, second, third]);

    expect(run.passRate).toBeCloseTo(0.5);
    expect(run.averageScore).toBeCloseTo(0.6);
    expect(run.minimumScore).toBeCloseTo(0.2);
    expect(run.scoredCaseCount).toBe(2);
    expect(run.unscoredCaseCount).toBe(1);
    expect(run.dimensions).toEqual([
      { dimension: "正确性", score: 0.6, weight: 1, scoredCaseCount: 2 },
    ]);
  });

  it("reports no run score when no case produced one", () => {
    const run = scoreEvaluationRun([scoreCase([judge("a", "excused")])]);

    expect(run).toMatchObject({
      averageScore: null,
      minimumScore: null,
      passRate: null,
      coverage: null,
      scoredCaseCount: 0,
      unscoredCaseCount: 1,
      passedCaseCount: 0,
    });
  });
});
