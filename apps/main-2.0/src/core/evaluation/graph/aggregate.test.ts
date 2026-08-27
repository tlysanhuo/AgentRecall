import { describe, expect, it } from "vitest";
import { aggregateEvaluationCase, scorableVerdicts } from "./aggregate";
import type {
  EvaluationNodeRecord,
  EvaluationRecordStatus,
  EvaluationVerdict,
} from "./node";

function verdict(id: string, status: EvaluationVerdict["status"], raw = 1): EvaluationVerdict {
  return {
    verdictId: id,
    labels: {},
    status,
    raw,
    sourceNodeId: `node-${id}`,
    sourceNodeType: "llm_judge",
  };
}

function judgeRecord(
  nodeId: string,
  status: EvaluationRecordStatus,
  verdicts: EvaluationVerdict[] = [],
): EvaluationNodeRecord {
  return {
    nodeId,
    nodeType: "llm_judge",
    nodeVersion: 1,
    role: "judge",
    status,
    ...(verdicts.length > 0 ? { verdicts } : {}),
    ...(status === "excused"
      ? { attribution: { type: "judge_failure" as const, reason: "judge_output_unparseable" } }
      : {}),
    ...(status === "pending" ? { pendingReason: "upstream_not_pass" as const } : {}),
  };
}

function prepareRecord(
  nodeId: string,
  status: EvaluationRecordStatus,
): EvaluationNodeRecord {
  return {
    nodeId,
    nodeType: "agent_execute",
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

describe("evaluation case aggregate", () => {
  it("opens the gate when nothing failed", () => {
    const aggregate = aggregateEvaluationCase("case-1", [
      prepareRecord("agent", "pass"),
      judgeRecord("judge", "pass", [verdict("v1", "met")]),
    ]);

    expect(aggregate.gate).toEqual({ passed: true, hardDefects: [] });
    expect(aggregate.completeness).toEqual({
      total: 1,
      met: 1,
      unmet: 0,
      uncertain: 0,
      notDecided: 0,
    });
  });

  it("closes the gate on a model failure and names the attribution", () => {
    const aggregate = aggregateEvaluationCase("case-1", [prepareRecord("agent", "fail")]);

    expect(aggregate.gate.passed).toBe(false);
    expect(aggregate.gate.hardDefects).toEqual([
      {
        nodeId: "agent",
        reason: "agent_refused",
        attribution: { type: "model_failure", reason: "agent_refused" },
      },
    ]);
  });

  it("does not treat an excused step as a defect", () => {
    // A missing runtime says nothing about the agent, so the gate stays open and
    // the absence shows up as coverage instead.
    const aggregate = aggregateEvaluationCase("case-1", [
      prepareRecord("agent", "excused"),
      judgeRecord("judge", "pending"),
    ]);

    expect(aggregate.gate.passed).toBe(true);
    expect(aggregate.completeness.notDecided).toBe(1);
  });

  it("closes the gate for a cancelled case so it cannot publish a clean result", () => {
    const aggregate = aggregateEvaluationCase(
      "case-1",
      [judgeRecord("judge", "pass", [verdict("v1", "met")])],
      { cancelled: true },
    );

    expect(aggregate.gate.passed).toBe(false);
    expect(aggregate.gate.hardDefects[0]).toMatchObject({
      nodeId: "aggregate",
      reason: "case_cancelled",
      attribution: { type: "infra_failure" },
    });
  });

  it("keeps an excused judge's verdicts visible but out of the scorable set", () => {
    const aggregate = aggregateEvaluationCase("case-1", [
      judgeRecord("deciding", "pass", [verdict("v1", "met")]),
      judgeRecord("broken", "excused", [verdict("v2", "unmet", 0)]),
    ]);

    expect(aggregate.judged.map((group) => group.nodeId)).toEqual(["deciding", "broken"]);
    expect(scorableVerdicts(aggregate).map((item) => item.verdictId)).toEqual(["v1"]);
  });

  it("counts every way a planned decision failed to land", () => {
    const aggregate = aggregateEvaluationCase("case-1", [
      // decided normally
      judgeRecord("decided", "pass", [verdict("v1", "met")]),
      // never ran
      judgeRecord("blocked", "pending"),
      // threw without producing anything
      judgeRecord("threw", "error"),
      // ran, was excused, and its two verdicts are discarded
      judgeRecord("excused", "excused", [verdict("v2", "met"), verdict("v3", "unmet", 0)]),
    ]);

    // Counting only `pending` would let the throwing judge vanish from both the
    // numerator and the denominator, so coverage would read complete.
    expect(aggregate.completeness).toEqual({
      total: 1,
      met: 1,
      unmet: 0,
      uncertain: 0,
      notDecided: 4,
    });
  });

  it("ignores prepare nodes when counting decisions", () => {
    const aggregate = aggregateEvaluationCase("case-1", [
      prepareRecord("agent", "pass"),
      prepareRecord("session", "excused"),
    ]);

    expect(aggregate.completeness).toEqual({
      total: 0,
      met: 0,
      unmet: 0,
      uncertain: 0,
      notDecided: 0,
    });
  });
});
