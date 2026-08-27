import {
  isEvaluationRecordExcluded,
  type EvaluationFailureAttribution,
  type EvaluationNodeRecord,
  type EvaluationVerdict,
} from "./node";

/**
 * Neutral aggregation of one case: facts only, no policy.
 *
 * Scoring lives in `scorer.ts` and reads this. Keeping them apart is what lets
 * a report show everything that happened — including the judges that could not
 * decide — while the score counts only the decisions that were actually made.
 */

export interface EvaluationHardDefect {
  nodeId: string;
  reason: string;
  attribution: EvaluationFailureAttribution;
}

export interface EvaluationJudgedGroup {
  nodeId: string;
  nodeType: string;
  verdicts: EvaluationVerdict[];
}

export interface EvaluationCompleteness {
  total: number;
  met: number;
  unmet: number;
  uncertain: number;
  /** Decisions that were planned but never landed in the scorable set. */
  notDecided: number;
}

export interface EvaluationCaseAggregate {
  caseId: string;
  gate: {
    passed: boolean;
    hardDefects: EvaluationHardDefect[];
  };
  judged: EvaluationJudgedGroup[];
  completeness: EvaluationCompleteness;
  nodes: EvaluationNodeRecord[];
}

export function aggregateEvaluationCase(
  caseId: string,
  records: readonly EvaluationNodeRecord[],
  options: { cancelled?: boolean } = {},
): EvaluationCaseAggregate {
  const hardDefects: EvaluationHardDefect[] = [];
  for (const record of records) {
    if (record.status !== "fail" || !record.attribution) continue;
    hardDefects.push({
      nodeId: record.nodeId,
      reason: record.attribution.reason,
      attribution: record.attribution,
    });
  }
  if (options.cancelled) {
    // An aborted case leaves its unreached nodes as plain `pending`, which
    // carries no attribution and is not a defect. Without this the gate stays
    // open and the case publishes a score built from whatever landed before the
    // abort — a killed run reading as a clean pass. Infra, not the agent.
    hardDefects.push({
      nodeId: "aggregate",
      reason: "case_cancelled",
      attribution: {
        type: "infra_failure",
        reason: "case_cancelled",
        details: ["the case was aborted before every node completed"],
      },
    });
  }

  const judged = records
    .filter((record) => record.role === "judge" && (record.verdicts?.length ?? 0) > 0)
    .map((record) => ({
      nodeId: record.nodeId,
      nodeType: record.nodeType,
      verdicts: record.verdicts!,
    }));

  const scorable = scorableVerdictsFrom(records);
  // Three distinct ways a planned decision fails to reach the scorable set, and
  // coverage is wrong if any is missed:
  //   - a judge left `pending` never produced a verdict at all;
  //   - a judge that threw or was excused produced none either;
  //   - a judge that was excused but did return verdicts has them discarded.
  // Counting only `pending` would let a judge that throws vanish from both the
  // numerator and the denominator, so coverage would read complete for a run
  // that decided nothing. A verdictless judge counts as one slot because the
  // number of verdicts it would have produced is unknowable.
  const notDecided = records.reduce((total, record) => {
    if (record.role !== "judge") return total;
    const produced = record.verdicts?.length ?? 0;
    const excluded = isEvaluationRecordExcluded(record.status);
    if (record.status === "pending" || (excluded && produced === 0)) return total + 1;
    if (excluded) return total + produced;
    return total;
  }, 0);

  return {
    caseId,
    gate: { passed: hardDefects.length === 0, hardDefects },
    judged,
    completeness: {
      total: scorable.length,
      met: scorable.filter((verdict) => verdict.status === "met").length,
      unmet: scorable.filter((verdict) => verdict.status === "unmet").length,
      uncertain: scorable.filter((verdict) => verdict.status === "uncertain").length,
      notDecided,
    },
    nodes: [...records],
  };
}

/**
 * Verdicts eligible for scoring. Excused and errored judges stay in the
 * aggregate for evidence, but nothing they returned describes the agent.
 */
export function scorableVerdicts(aggregate: EvaluationCaseAggregate): EvaluationVerdict[] {
  return scorableVerdictsFrom(aggregate.nodes);
}

function scorableVerdictsFrom(records: readonly EvaluationNodeRecord[]): EvaluationVerdict[] {
  return records
    .filter((record) => record.role === "judge" && !isEvaluationRecordExcluded(record.status))
    .flatMap((record) => record.verdicts ?? []);
}
